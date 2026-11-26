// The search page's web results: each provider asked on its own (the library host's web_search),
// merged as they arrive, checked against the library, and added to it on request.
// Nothing here touches the network unless the Web pill is on.
import { matchLibrary } from "./library-match";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FilterToken, WebFilterKey, WebFilters } from "../shared/web-filters";
import type { WebHit, WebPage, WebProviderInfo, WebResult } from "../shared/web-search";
import { bridge, type Invoke } from "./library-api";

/** Every web link the search page opens goes through here (an in-app browser can take them over). */
export function openWebLink(url: string) {
  void bridge().tabAction("open-url", { url });
}

const PAGE = 20;
const DEBOUNCE = 400;

export interface ProviderState {
  info: WebProviderInfo;
  status: "idle" | "loading" | "done" | "error";
  /** Every page so far, in the provider's order. */
  results: WebResult[];
  cursor?: string;
  /** A further page is on its way. */
  more: boolean;
  error?: string;
  /** Filters it cannot apply, so it was not asked. */
  skipped?: WebFilterKey[];
}

/** IPC errors arrive as "Error invoking remote method 'key:invoke': Error: …". */
export const errorText = (error: unknown) => String((error as Error)?.message ?? error).replace(/^.*?Error: /, "");

let counter = 0;

/** Why a token does nothing for the web, or undefined when some provider applies it. */
export function webTokenNote(token: FilterToken, web: { applicable: Set<WebFilterKey>; keyOf: (token: FilterToken) => WebFilterKey | null | undefined }) {
  const key = web.keyOf(token);
  if (key && web.applicable.has(key)) return undefined;
  if (token.field === "collection") return "Not available for web search. Works you add go into this collection.";
  return "Not available for web search";
}

export function useWebSearch(invoke: Invoke, workspaceId: string, query: string, active: boolean, tokens: FilterToken[] = []) {
  const [providers, setProviders] = useState<ProviderState[]>([]);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [inLibrary, setInLibrary] = useState<Record<string, string>>({});
  /** Works whose title (only) matches a library source: "Possibly in library". */
  const [possible, setPossible] = useState<Record<string, string>>({});
  const generation = useRef(0);
  const requests = useRef(new Set<string>());
  const q = query.trim();

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const cancelAll = useCallback(() => {
    for (const requestId of requests.current) void invoke("web_search_cancel", { requestId }).catch(() => {});
    requests.current.clear();
  }, [invoke]);

  /** One page from one provider; stale answers (an older query) are dropped. */
  const fetchPage = useCallback(
    async (info: WebProviderInfo, text: string, filters: WebFilters, gen: number, cursor?: string) => {
      const requestId = `web-${++counter}`;
      requests.current.add(requestId);
      const apply = (change: (p: ProviderState) => ProviderState) => {
        if (gen !== generation.current) return;
        setProviders((list) => list.map((p) => (p.info.id === info.id ? change(p) : p)));
      };
      try {
        const page = await invoke<WebPage>("web_search", { provider: info.id, query: text, limit: PAGE, cursor, requestId, filters });
        apply((p) => ({ ...p, status: "done", more: false, error: undefined, skipped: page.skipped, results: cursor ? [...p.results, ...page.results] : page.results, cursor: page.cursor }));
      } catch (error) {
        const message = errorText(error);
        if (message === "Cancelled") return;
        apply((p) => ({ ...p, status: cursor ? p.status : "error", more: false, error: message }));
      } finally {
        requests.current.delete(requestId);
      }
    },
    [invoke],
  );

  // Which providers are on, read again whenever the pill is turned on (Settings may have changed).
  const [infos, setInfos] = useState<WebProviderInfo[]>();
  useEffect(() => {
    if (!active) return;
    void invoke<WebProviderInfo[]>("web_providers", {})
      .then(setInfos)
      .catch(() => setInfos([]));
  }, [active, invoke]);
  const enabled = useMemo(() => (infos ?? []).filter((p) => p.enabled), [infos]);
  const enabledKey = enabled.map((p) => p.id).join();
  // The tokens some provider that is on can apply, as the library host reads them (web_filters);
  // the others are left to the library.
  const applicable = useMemo(() => new Set(enabled.flatMap((p) => p.filters ?? [])), [enabled]);
  const signature = (t: FilterToken) => JSON.stringify([t.field, t.op, t.value, t.label]);
  const tokensKey = JSON.stringify(tokens.map(signature));
  const askedKey = `${enabledKey}|${tokensKey}`;
  const [answer, setAnswer] = useState<{ asked: string; filters: WebFilters; keys: Record<string, WebFilterKey | null> }>();
  useEffect(() => {
    if (!active || !infos) return;
    if (!tokens.length) return setAnswer({ asked: askedKey, filters: {}, keys: {} });
    let live = true;
    void invoke<{ filters: WebFilters; keys: (WebFilterKey | null)[] }>("web_filters", { tokens })
      .then((r) => live && setAnswer({ asked: askedKey, filters: r.filters, keys: Object.fromEntries(tokens.map((t, i) => [signature(t), r.keys[i] ?? null])) }))
      .catch(() => live && setAnswer({ asked: askedKey, filters: {}, keys: {} }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, !!infos, askedKey, invoke]);
  const filters = answer?.asked === askedKey ? answer.filters : undefined;
  const keyOf = useCallback((t: FilterToken) => answer?.keys[signature(t)], [answer]);
  const filtersKey = JSON.stringify(filters ?? null);
  const filtered = !!filters && Object.keys(filters).length > 0;

  const run = useCallback(
    (only?: string) => {
      if (!only) {
        cancelAll();
        generation.current++;
      }
      const gen = generation.current;
      const asked = enabled.filter((p) => !only || p.id === only);
      setProviders((list) =>
        only
          ? list.map((p) => (p.info.id === only ? { ...p, status: "loading", results: [], cursor: undefined, error: undefined } : p))
          : enabled.map((info) => ({ info, status: "loading", results: [], more: false })),
      );
      for (const info of asked) void fetchPage(info, q, filters ?? {}, gen);
    },
    [enabled, fetchPage, cancelAll, q, filters],
  );

  useEffect(() => {
    if (!active || !infos || !filters) return;
    if ((q.length < 2 && !filtered) || !online) {
      cancelAll();
      generation.current++;
      setProviders(enabled.map((info) => ({ info, status: "idle", results: [], more: false })));
      return;
    }
    // Skeletons at once; the request after a pause in typing.
    setProviders(enabled.map((info) => ({ info, status: "loading", results: [], more: false })));
    const timer = setTimeout(() => run(), DEBOUNCE);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, q, online, enabledKey, !!infos, filtersKey]);

  // Leaving the pill cancels whatever is still running.
  useEffect(() => {
    if (active) return;
    cancelAll();
    generation.current++;
    setProviders([]);
  }, [active, cancelAll]);

  const latest = useRef(providers);
  latest.current = providers;
  const loadMore = useCallback(() => {
    const gen = generation.current;
    const next = latest.current.filter((p) => p.status === "done" && p.cursor && !p.more);
    if (!next.length) return;
    setProviders((list) => list.map((p) => (next.some((n) => n.info.id === p.info.id) ? { ...p, more: true } : p)));
    for (const p of next) void fetchPage(p.info, q, filters ?? {}, gen, p.cursor);
  }, [fetchPage, q, filters]);

  // One list from every provider's pages, merged by the library host (web_merge); the last
  // merge stays until the next arrives.
  const [hits, setHits] = useState<WebHit[]>([]);
  const resultsKey = providers.map((p) => `${p.info.id}:${p.results.length}:${p.results[0]?.providerId ?? ""}`).join();
  useEffect(() => {
    const lists = providers.filter((p) => p.results.length).map((p) => ({ provider: p.info.id, results: p.results }));
    if (!lists.length) return setHits([]);
    let live = true;
    void invoke<WebHit[]>("web_merge", { lists })
      .then((merged) => live && setHits(merged))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultsKey, invoke]);

  // Works already in the library, checked as they arrive and all again when the library changes.
  const checked = useRef(new Set<string>());
  const [libraryTick, setLibraryTick] = useState(0);
  const seenTick = useRef(0);
  useEffect(() => bridge().on("library-changed", () => setLibraryTick((n) => n + 1)), []);
  useEffect(() => {
    if (!active || !workspaceId) return;
    const all = seenTick.current !== libraryTick;
    seenTick.current = libraryTick;
    const asked = all ? hits : hits.filter((h) => !checked.current.has(h.key));
    if (!asked.length) return;
    asked.forEach((h) => checked.current.add(h.key));
    const works = asked.map((h) => ({ key: h.key, doi: h.doi, url: h.landingUrl, title: h.title, year: h.year, firstAuthor: h.authors[0], arxiv: h.ids.arxiv, pmid: h.ids.pmid, pmcid: h.ids.pmcid, openalex: h.ids.openalex }));
    void matchLibrary(invoke, workspaceId, works)
      .then((found) => {
        const update = (certain: boolean) => (m: Record<string, string>) => {
          const next = { ...m };
          for (const h of asked) {
            const hit = found[h.key];
            if (hit && hit.certain === certain) next[h.key] = hit.sourceId;
            // A source trashed since: the work can be added again.
            else if (all || hit) delete next[h.key];
          }
          return next;
        };
        setInLibrary(update(true));
        setPossible(update(false));
      })
      .catch(() => {});
  }, [hits, active, workspaceId, invoke, libraryTick]);
  useEffect(() => {
    checked.current.clear();
    setInLibrary({});
    setPossible({});
  }, [workspaceId]);

  const noted = useCallback((key: string, sourceId: string) => {
    setInLibrary((m) => ({ ...m, [key]: sourceId }));
    setPossible(({ [key]: _, ...rest }) => rest);
  }, []);

  return {
    providers,
    hits,
    /** Filter kinds some provider applies. */
    applicable,
    /** The web filter a token is (as the library host reads it), once known. */
    keyOf,
    /** Web filters are set (a search can run without words). */
    filtered,
    /** What is asked: the words and the web filters (an alert saves both). */
    asked: { query: q, filters: filters ?? {} },
    /** Which providers are on is known. */
    ready: !!infos && !!filters,
    online,
    inLibrary,
    possible,
    noted,
    loadMore,
    retry: (id: string) => run(id),
    /** Every provider, on or not: a fallback (Google Scholar) may answer in another's place. */
    infos: infos ?? [],
    /** No provider is on (all turned off in Settings). */
    none: !!infos && !enabled.length,
    canLoadMore: providers.some((p) => p.status === "done" && p.cursor),
    loadingMore: providers.some((p) => p.more),
  };
}

export type WebSearchState = ReturnType<typeof useWebSearch>;
export type { WebHit };
