// The search page's web results: each provider asked on its own (see main/web-search),
// merged as they arrive, checked against the library, and added to it on request.
// Nothing here touches the network unless the Web pill is on.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeWebFilters, pickWebFilters, toWebFilters, webFilterKey, type FilterToken, type WebFilterKey, type WebFilters } from "../shared/web-filters";
import { mergeWeb, type WebHit, type WebPage, type WebProviderInfo, type WebResult } from "../shared/web-search";
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
export function webTokenNote(token: FilterToken, applicable: Set<WebFilterKey>) {
  const key = webFilterKey(token);
  if (key && applicable.has(key)) return undefined;
  if (token.field === "collection") return "Not available for web search. Works you add go into this collection.";
  return "Not available for web search";
}

export function useWebSearch(invoke: Invoke, workspaceId: string, query: string, active: boolean, tokens: FilterToken[] = []) {
  const [providers, setProviders] = useState<ProviderState[]>([]);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [inLibrary, setInLibrary] = useState<Record<string, string>>({});
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
  // The tokens some provider can apply; the others are left to the library.
  const applicable = useMemo(() => new Set(enabled.flatMap((p) => p.filters ?? [])), [enabled]);
  const tokensKey = JSON.stringify(tokens.map(({ field, op, value, label }) => [field, op, value, label]));
  const filters = useMemo(() => {
    const all = toWebFilters(tokens);
    return pickWebFilters(all, activeWebFilters(all).filter((k) => applicable.has(k)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokensKey, applicable]);
  const filtersKey = JSON.stringify(filters);
  const filtered = activeWebFilters(filters).length > 0;

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
      for (const info of asked) void fetchPage(info, q, filters, gen);
    },
    [enabled, fetchPage, cancelAll, q, filters],
  );

  useEffect(() => {
    if (!active || !infos) return;
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
    for (const p of next) void fetchPage(p.info, q, filters, gen, p.cursor);
  }, [fetchPage, q, filters]);

  const hits = useMemo(() => mergeWeb(providers.filter((p) => p.results.length).map((p) => ({ provider: p.info.id, results: p.results }))), [providers]);

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
    void invoke<Record<string, string>>("web_library_match", { works: asked.map(({ key, doi, title, year, ids }) => ({ key, doi, title, year, ids })) }, workspaceId)
      .then((found) =>
        setInLibrary((m) => {
          const next = { ...m };
          for (const h of asked) if (found[h.key]) next[h.key] = found[h.key];
          // A source trashed since: the work can be added again.
          else if (all) delete next[h.key];
          return next;
        }),
      )
      .catch(() => {});
  }, [hits, active, workspaceId, invoke, libraryTick]);
  useEffect(() => {
    checked.current.clear();
    setInLibrary({});
  }, [workspaceId]);

  const noted = useCallback((key: string, sourceId: string) => setInLibrary((m) => ({ ...m, [key]: sourceId })), []);

  return {
    providers,
    hits,
    /** Filter kinds some provider applies. */
    applicable,
    /** Web filters are set (a search can run without words). */
    filtered,
    /** Which providers are on is known. */
    ready: !!infos,
    online,
    inLibrary,
    noted,
    loadMore,
    retry: (id: string) => run(id),
    /** No provider is on (all turned off in Settings). */
    none: !!infos && !enabled.length,
    canLoadMore: providers.some((p) => p.status === "done" && p.cursor),
    loadingMore: providers.some((p) => p.more),
  };
}

export type WebSearchState = ReturnType<typeof useWebSearch>;
export type { WebHit };
