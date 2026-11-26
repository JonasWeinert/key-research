// Web search for the search page: the renderer asks one provider at a time (so a slow or
// failing one never holds up another) through `web_*` commands on key:invoke.
//
// Providers run here in the main process rather than in the Rust library host: they are
// not tied to a workspace, a search the user has moved on from is cancelled with an
// AbortSignal, and Node's fetch does what they need. The polite `mailto` and the API keys
// come from the app settings the Rust OpenAlex worker also uses. Nothing here runs unless
// the user chose the Web pill.
import { bareDoi, titleKey, type WebPage, type WebProviderInfo, type WebResult } from "../../shared/web-search";
import type { AppSettings } from "../app-settings";
import { ProviderError, TtlCache, isAbort, withRetry, type Fetch } from "./http";
import type { SearchRequest, WebProvider } from "./provider";
import { PROVIDERS } from "./registry";
import { withKeyFallback, type ServiceKeys } from "../services/fallback";

const DEFAULT_MAILTO = "key-app@users.noreply.github.com";
type Invoke = (command: string, args: Record<string, unknown>, workspaceId: string) => Promise<any>;
type StoredSource = { id: string; title?: string; year?: number; doi?: string; arxivId?: string; openalexId?: string };

const ITEM_TYPES: Record<string, string> = {
  article: "article",
  "journal-article": "article",
  review: "article",
  letter: "article",
  editorial: "article",
  preprint: "preprint",
  "posted-content": "preprint",
  book: "book",
  monograph: "book",
  "book-chapter": "chapter",
  "proceedings-article": "conference-paper",
  dissertation: "thesis",
  report: "report",
  dataset: "dataset",
};

/** "Ashish Vaswani" → given Ashish, family Vaswani; a single word stays as written. */
export function creatorOf(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { literal: name.trim(), role: "author" };
  return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1], role: "author" };
}

/** A web result as a library source: a reference with every detail the provider gave. */
export function sourceInput(work: WebResult, collectionId?: string | null) {
  const fields: Record<string, unknown> = {
    kind: "reference",
    itemType: ITEM_TYPES[work.type ?? ""] ?? "article",
    title: work.title,
    creators: work.authors.slice(0, 100).map(creatorOf),
    year: work.year,
    containerTitle: work.venue,
    doi: work.doi,
    url: work.landingUrl,
    abstract: work.abstract,
    pmid: work.ids.pmid,
    pmcid: work.ids.pmcid,
    arxivId: work.ids.arxiv,
    openalexId: work.ids.openalex,
    oaUrl: work.pdfUrl,
    oaStatus: work.oaStatus,
    citedByCount: work.citedBy,
    collections: collectionId ? [collectionId] : [],
    indexStatus: "skipped",
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

/** The library source that is this work: same DOI, arXiv or OpenAlex id, else the same title within a year. */
export function matchSource(work: Pick<WebResult, "doi" | "title" | "year"> & { ids?: WebResult["ids"] }, sources: StoredSource[]) {
  const doi = bareDoi(work.doi);
  const byId = sources.find(
    (s) => (doi && bareDoi(s.doi) === doi) || (work.ids?.arxiv && s.arxivId?.toLowerCase() === work.ids.arxiv.toLowerCase()) || (work.ids?.openalex && s.openalexId === work.ids.openalex),
  );
  if (byId) return byId;
  const title = titleKey(work.title);
  return sources.find((s) => !(doi && s.doi && bareDoi(s.doi) !== doi) && s.title && titleKey(s.title) === title && (!work.year || !s.year || Math.abs(work.year - s.year) <= 1));
}

export class WebSearch {
  private cache = new TtlCache<WebPage>();
  private running = new Map<string, AbortController>();

  constructor(
    private readonly deps: {
      settings: () => AppSettings;
      invoke: Invoke;
      emit: (event: string, value?: unknown) => void;
      providers?: WebProvider[];
      fetch?: Fetch;
      /** User-supplied API keys (Settings → Services & API keys), used as a fallback. */
      keys?: ServiceKeys;
    },
  ) {}
  private fallbacks = new Map<string, Promise<WebPage | undefined>>();

  private get providers() {
    return this.deps.providers ?? PROVIDERS;
  }
  private entry(provider: WebProvider) {
    return this.deps.settings().webProviders?.[provider.id] ?? {};
  }
  private enabled(provider: WebProvider) {
    const service = provider.capabilities.service;
    if (provider.capabilities.keyRequired && !this.keyOf(provider)) return false;
    return this.entry(provider).enabled ?? (!!(service && provider.capabilities.keyRequired && this.deps.keys?.mode(service) === "always") || provider.capabilities.enabledByDefault);
  }
  /** The provider's key: from the secret store, else (older settings, tests) the settings file. */
  private keyOf(provider: WebProvider) {
    const service = provider.capabilities.service;
    if (this.deps.keys && service) return this.deps.keys.key(service);
    const settings = this.deps.settings();
    return this.entry(provider).apiKey || (provider.id === "openalex" ? settings.openalexApiKey : "") || undefined;
  }
  private context(provider: WebProvider, apiKey?: string) {
    const settings = this.deps.settings();
    return { apiKey, mailto: settings.openalexMailto || DEFAULT_MAILTO, fetch: this.deps.fetch };
  }
  /** Keyless first; with the key only when that fails in a way a key helps (or always, if chosen). */
  private keyed<T>(provider: WebProvider, signal: AbortSignal | undefined, task: (context: ReturnType<WebSearch["context"]>) => Promise<T>) {
    const service = provider.capabilities.service;
    const key = this.keyOf(provider);
    const keys = this.deps.keys;
    if (!keys || !service) return task(this.context(provider, key));
    return withKeyFallback({
      key,
      mode: provider.capabilities.keyRequired ? "always" : keys.mode(service),
      signal,
      run: (k) => task(this.context(provider, k)),
      record: (outcome) => keys.record(service, outcome),
    });
  }

  handles(command: string) {
    return command.startsWith("web_");
  }

  async handle(command: string, args: any, workspaceId: string): Promise<unknown> {
    switch (command) {
      case "web_providers":
        return this.providers.map(
          (p): WebProviderInfo => ({
            id: p.id,
            label: p.label,
            icon: p.icon,
            // Keys are set under Services & API keys when the provider has a service there.
            apiKey: p.capabilities.apiKey && p.id !== "openalex" && !(this.deps.keys && p.capabilities.service),
            keyRequired: p.capabilities.keyRequired,
            keyHelp: p.capabilities.keyHelp,
            enabled: this.enabled(p),
            lookup: !!p.lookup,
          }),
        );
      case "web_search":
        return this.search(String(args.provider), String(args.query ?? ""), { limit: Math.max(1, Math.min(50, Number(args.limit) || 20)), cursor: args.cursor ?? undefined, filters: args.filters }, args.requestId);
      case "web_search_cancel":
        this.running.get(String(args.requestId))?.abort();
        return true;
      case "web_lookup": {
        const provider = this.provider(String(args.provider));
        if (!provider.lookup) throw Error(`${provider.label} cannot look works up`);
        const lookup = provider.lookup.bind(provider);
        return this.keyed(provider, undefined, (context) => withRetry(() => lookup(String(args.id), context), { attempts: 2, maxWaitMs: 5000 }));
      }
      case "web_library_match":
        return this.match(workspaceId, (args.works ?? []).slice(0, 100));
      case "web_add_to_library":
        return this.add(workspaceId, args.work, args.collectionId);
      default:
        throw Error(`Unknown command ${command}`);
    }
  }

  private provider(id: string) {
    const provider = this.providers.find((p) => p.id === id);
    if (!provider) throw Error(`No web search provider ${id}`);
    return provider;
  }

  async search(id: string, query: string, request: Omit<SearchRequest, "signal">, requestId?: string): Promise<WebPage> {
    const provider = this.provider(id);
    if (!this.enabled(provider)) throw Error(`${provider.label} is turned off in Settings`);
    const q = query.trim().slice(0, 300);
    if (q.length < 2) return { results: [] };
    const key = JSON.stringify([id, q.toLowerCase(), request.limit, request.cursor ?? "", request.filters ?? null]);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const controller = new AbortController();
    if (requestId) this.running.set(requestId, controller);
    try {
      const ask = (p: WebProvider) =>
        this.keyed(p, controller.signal, (context) => withRetry(() => p.search(q, { ...request, signal: controller.signal }, context), { signal: controller.signal, maxWaitMs: Number(process.env.KEY_WEB_MAX_RETRY_WAIT_MS) || 10_000 }));
      let page: WebPage;
      try {
        page = await ask(provider);
      } catch (error) {
        const fallback = controller.signal.aborted ? undefined : await this.fallback(provider, q, request, ask);
        if (!fallback) throw error;
        page = fallback;
      }
      // Nothing found: a keyed Scholar search may know the work.
      if (!page.results.length) page = (await this.fallback(provider, q, request, ask)) ?? page;
      this.cache.set(key, page);
      return page;
    } catch (error) {
      if (controller.signal.aborted || (isAbort(error) && !(error instanceof Error && error.name === "TimeoutError"))) throw Error("Cancelled");
      if (error instanceof ProviderError) throw Error(error.message);
      throw error;
    } finally {
      if (requestId) this.running.delete(requestId);
    }
  }

  /** A first page from the keyed provider kept for when others fail (Google Scholar via SerpApi):
   *  only when it has a key and the user has not turned it on as a provider of its own. Two
   *  providers failing on the same query share one request. */
  private async fallback(failed: WebProvider, q: string, request: Omit<SearchRequest, "signal">, ask: (p: WebProvider) => Promise<WebPage>) {
    if (request.cursor || !this.deps.keys) return undefined;
    const spare = this.providers.find((p) => p.id !== failed.id && p.capabilities.keyRequired && p.capabilities.service && this.keyOf(p) && !this.enabled(p));
    if (!spare) return undefined;
    const key = JSON.stringify([spare.id, q.toLowerCase(), request.limit, request.filters ?? null]);
    const cached = this.cache.get(key);
    if (cached) return cached;
    let running = this.fallbacks.get(key);
    if (!running) {
      running = ask(spare)
        .then((page) => {
          this.cache.set(key, page);
          return page;
        })
        .catch(() => undefined)
        .finally(() => this.fallbacks.delete(key));
      this.fallbacks.set(key, running);
    }
    const page = await running;
    return page?.results.length ? { ...page, cursor: undefined } : undefined;
  }

  /** Which of these works the library already has: key → source id. */
  async match(workspaceId: string, works: (Pick<WebResult, "doi" | "title" | "year" | "ids"> & { key: string })[]) {
    const out: Record<string, string> = {};
    const find = (text: string) =>
      this.deps
        .invoke("store_sources", { text, limit: 8, scope: "all", sort: "added", descending: true }, workspaceId)
        .then((r: { items: StoredSource[] }) => r.items ?? [])
        .catch(() => [] as StoredSource[]);
    // A handful at a time: each is one indexed lookup in the library.
    for (let i = 0; i < works.length; i += 6) {
      await Promise.all(
        works.slice(i, i + 6).map(async (work) => {
          const doi = bareDoi(work.doi);
          let found = doi ? matchSource(work, await find(doi)) : undefined;
          if (!found && work.ids?.arxiv) found = matchSource(work, await find(work.ids.arxiv));
          if (!found && work.title) found = matchSource(work, await find(work.title.slice(0, 200)));
          if (found) out[work.key] = found.id;
        }),
      );
    }
    return out;
  }

  /** Adds the work as a reference (or answers the source it already is). */
  async add(workspaceId: string, work: WebResult, collectionId?: string | null) {
    if (!workspaceId) throw Error("Choose a workspace");
    if (!work?.title) throw Error("Nothing to add");
    const existing = await this.match(workspaceId, [{ ...work, key: "work" }]);
    if (existing.work) return { source: await this.deps.invoke("store_source", { id: existing.work }, workspaceId), existed: true };
    const source = await this.deps.invoke("store_create", { source: sourceInput(work, collectionId) }, workspaceId);
    this.deps.emit("library-changed");
    return { source, existed: false };
  }
}
