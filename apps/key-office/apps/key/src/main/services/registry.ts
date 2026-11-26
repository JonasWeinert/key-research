// Services the user can give an API key to (Settings → Services & API keys).
//
// To add one: an entry here (where to get a key, how to check it, what it is used for) and,
// when it searches, a web provider whose `capabilities.service` names this id. The key is
// stored by SecretStore under `service:<id>`; the library host uses it as a fallback (web_search/http.rs).
// Base URLs follow the web providers' environment overrides so smokes can use mock servers.
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface Validation {
  ok: boolean;
  message: string;
  remaining?: { value: number; label: string };
}
export interface KeyedService {
  id: string;
  name: string;
  /** "via SerpApi": who actually answers. */
  via?: string;
  /** One line: what the key gives. */
  summary: string;
  /** Where the app uses it. */
  usedFor: string;
  keyUrl: string;
  keyUrlLabel: string;
  /** The web search provider this key belongs to, if any. */
  webProvider?: string;
  /** Without a key the service is not asked at all. */
  keyRequired?: boolean;
  validate(key: string, context: { fetch?: Fetch; mailto: string; signal?: AbortSignal }): Promise<Validation>;
}

export const secretName = (id: string) => `service:${id}`;

const openalexBase = () => (process.env.KEY_WEB_OPENALEX_URL || "https://api.openalex.org").replace(/\/$/, "");
const s2Base = () => (process.env.KEY_WEB_S2_URL || "https://api.semanticscholar.org").replace(/\/$/, "");
export const serpapiBase = () => (process.env.KEY_WEB_SERPAPI_URL || "https://serpapi.com").replace(/\/$/, "");
const elsevierBase = () => (process.env.KEY_DB_ELSEVIER_URL || "https://api.elsevier.com").replace(/\/$/, "");
const clarivateBase = () => (process.env.KEY_DB_CLARIVATE_URL || "https://api.clarivate.com").replace(/\/$/, "");
const clarivateExpandedBase = () => (process.env.KEY_DB_WOS_EXPANDED_URL || "https://wos-api.clarivate.com").replace(/\/$/, "");

async function probe(url: string, context: { fetch?: Fetch; signal?: AbortSignal }, headers: Record<string, string> = {}) {
  const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000);
  try {
    return await (context.fetch ?? fetch)(url, { headers: { Accept: "application/json", ...headers }, signal });
  } catch {
    return undefined;
  }
}

/** A rate-limit header, when the service sends one. */
export function remainingFrom(headers: Headers | undefined) {
  const value = headers?.get("x-ratelimit-remaining") ?? headers?.get("x-ratelimit-remaining-day");
  const n = value == null ? NaN : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const refused = (status: number) => status === 401 || status === 403;

export const SERVICES: KeyedService[] = [
  {
    id: "openalex",
    name: "OpenAlex",
    summary: "A key of your own gives a daily budget that does not share the anonymous limit.",
    usedFor: "Source lookups, citation counts, title matches and OpenAlex web search",
    keyUrl: "https://openalex.org/settings/api",
    keyUrlLabel: "openalex.org",
    webProvider: "openalex",
    async validate(key, context) {
      const params = new URLSearchParams({ "per-page": "1", select: "id", mailto: context.mailto, api_key: key });
      const response = await probe(`${openalexBase()}/works?${params}`, context);
      if (!response) return { ok: false, message: "Couldn't reach OpenAlex" };
      if (refused(response.status)) return { ok: false, message: "OpenAlex refused this key" };
      if (response.status === 429) return { ok: false, message: "OpenAlex says this key is over its limit" };
      if (!response.ok) return { ok: false, message: `OpenAlex returned HTTP ${response.status}` };
      const remaining = remainingFrom(response.headers);
      return { ok: true, message: "OpenAlex accepted the key", remaining: remaining === undefined ? undefined : { value: remaining, label: "requests left today" } };
    },
  },
  {
    id: "scholar-serpapi",
    name: "Google Scholar",
    via: "SerpApi",
    summary: "Google Scholar has no public API. SerpApi, a paid third party, runs the searches with your SerpApi key.",
    usedFor: "Web search, when the other catalogues fail or find nothing, or when turned on under Web search",
    keyUrl: "https://serpapi.com/manage-api-key",
    keyUrlLabel: "serpapi.com",
    webProvider: "scholar",
    keyRequired: true,
    async validate(key, context) {
      // The account endpoint is free: checking a key does not use a search.
      const response = await probe(`${serpapiBase()}/account.json?${new URLSearchParams({ api_key: key })}`, context);
      if (!response) return { ok: false, message: "Couldn't reach SerpApi" };
      if (refused(response.status)) return { ok: false, message: "SerpApi refused this key" };
      if (!response.ok) return { ok: false, message: `SerpApi returned HTTP ${response.status}` };
      const account = (await response.json().catch(() => ({}))) as { plan_searches_left?: number; total_searches_left?: number; error?: string };
      if (account.error) return { ok: false, message: "SerpApi refused this key" };
      const left = account.total_searches_left ?? account.plan_searches_left;
      return { ok: true, message: "SerpApi accepted the key", remaining: typeof left === "number" ? { value: left, label: "searches left this month" } : undefined };
    },
  },
  {
    id: "semantic-scholar",
    name: "Semantic Scholar",
    summary: "A key raises the shared, low rate limit of anonymous requests.",
    usedFor: "Semantic Scholar web search",
    keyUrl: "https://www.semanticscholar.org/product/api#api-key-form",
    keyUrlLabel: "semanticscholar.org",
    webProvider: "s2",
    async validate(key, context) {
      const params = new URLSearchParams({ query: "attention", limit: "1", fields: "title" });
      const response = await probe(`${s2Base()}/graph/v1/paper/search?${params}`, context, { "x-api-key": key });
      if (!response) return { ok: false, message: "Couldn't reach Semantic Scholar" };
      if (refused(response.status)) return { ok: false, message: "Semantic Scholar refused this key" };
      if (!response.ok && response.status !== 429) return { ok: false, message: `Semantic Scholar returned HTTP ${response.status}` };
      return { ok: true, message: response.status === 429 ? "Key accepted; Semantic Scholar is busy right now" : "Semantic Scholar accepted the key" };
    },
  },
  {
    id: "elsevier",
    name: "Scopus",
    via: "Elsevier API",
    summary: "Searches Scopus from Key. Needs your institution's Scopus subscription: on its network, or anywhere with an institutional token.",
    usedFor: "Database search (Scopus connector), 20,000 requests a week",
    keyUrl: "https://dev.elsevier.com/apikey/manage",
    keyUrlLabel: "dev.elsevier.com",
    keyRequired: true,
    async validate(key, context) {
      // One search of one record; it counts against the weekly quota like any search.
      const params = new URLSearchParams({ query: "TITLE(test)", count: "1", field: "dc:identifier" });
      const response = await probe(`${elsevierBase()}/content/search/scopus?${params}`, context, { "X-ELS-APIKey": key });
      if (!response) return { ok: false, message: "Couldn't reach Elsevier" };
      const status = response.headers.get("x-els-status") ?? "";
      if (/QUOTA_EXCEEDED/i.test(status) || response.status === 429) return { ok: false, message: "Elsevier says this key is over its weekly quota" };
      // Elsevier answers 401 for both; the status header says whether the key or the access failed.
      if (/AUTHORIZATION/i.test(status) || (response.status === 403 && !/AUTHENTICATION/i.test(status))) {
        return { ok: true, message: "Elsevier accepted the key, but Scopus needs your institution's network or an institutional token" };
      }
      if (/AUTHENTICATION/i.test(status) || response.status === 401) return { ok: false, message: "Elsevier refused this key" };
      if (!response.ok) return { ok: false, message: `Elsevier returned HTTP ${response.status}` };
      const remaining = remainingFrom(response.headers);
      return { ok: true, message: "Scopus accepted the key", remaining: remaining === undefined ? undefined : { value: remaining, label: "requests left this week" } };
    },
  },
  {
    id: "elsevier-insttoken",
    name: "Scopus institutional token",
    via: "Elsevier API",
    summary: "Optional. Lets your Scopus key work off campus. Your library requests it from Elsevier; keep it private.",
    usedFor: "Database search (Scopus connector), together with the Scopus key",
    keyUrl: "https://dev.elsevier.com/support.html",
    keyUrlLabel: "dev.elsevier.com",
    keyRequired: true,
    async validate(key) {
      // A token is only meaningful with an API key, so it is checked on the next Scopus search.
      if (!/^[A-Za-z0-9-]{16,}$/.test(key.trim())) return { ok: false, message: "This doesn't look like an institutional token" };
      return { ok: true, message: "Saved; Scopus checks it with your key on the next search" };
    },
  },
  {
    id: "clarivate-wos",
    name: "Web of Science",
    via: "Web of Science Starter API",
    summary: "Searches the Web of Science Core Collection (no abstracts). The free trial allows 50 requests a day; the institutional plan 5,000.",
    usedFor: "Database search (Web of Science connector)",
    keyUrl: "https://developer.clarivate.com/apis/wos-starter",
    keyUrlLabel: "developer.clarivate.com",
    keyRequired: true,
    async validate(key, context) {
      // One request of one record; it counts against the daily allowance.
      const params = new URLSearchParams({ db: "WOS", q: "TI=(test)", limit: "1", page: "1" });
      const response = await probe(`${clarivateBase()}/apis/wos-starter/v1/documents?${params}`, context, { "X-ApiKey": key });
      if (!response) return { ok: false, message: "Couldn't reach Clarivate" };
      if (refused(response.status)) return { ok: false, message: "Clarivate refused this key" };
      if (response.status === 429) return { ok: false, message: "Clarivate says this key is over its limit for today" };
      if (!response.ok) return { ok: false, message: `Clarivate returned HTTP ${response.status}` };
      const remaining = remainingFrom(response.headers);
      return { ok: true, message: "Web of Science accepted the key", remaining: remaining === undefined ? undefined : { value: remaining, label: "requests left today" } };
    },
  },
  {
    id: "clarivate-wos-expanded",
    name: "Web of Science Expanded",
    via: "Web of Science Expanded API",
    summary: "Full Web of Science records with abstracts. Clarivate issues this key to institutions with an Expanded API licence.",
    usedFor: "Database search (Web of Science Expanded connector)",
    keyUrl: "https://developer.clarivate.com/apis/wos",
    keyUrlLabel: "developer.clarivate.com",
    keyRequired: true,
    async validate(key, context) {
      const params = new URLSearchParams({ databaseId: "WOS", usrQuery: "TI=(test)", count: "1", firstRecord: "1", optionView: "SR" });
      const response = await probe(`${clarivateExpandedBase()}/api/wos?${params}`, context, { "X-ApiKey": key });
      if (!response) return { ok: false, message: "Couldn't reach Clarivate" };
      if (refused(response.status)) return { ok: false, message: "Clarivate refused this key" };
      if (response.status === 429) return { ok: false, message: "Clarivate says this key is over its limit" };
      if (!response.ok) return { ok: false, message: `Clarivate returned HTTP ${response.status}` };
      return { ok: true, message: "Web of Science Expanded accepted the key" };
    },
  },
];

export const serviceFor = (id: string) => SERVICES.find((s) => s.id === id);
export const serviceForProvider = (providerId: string) => SERVICES.find((s) => s.webProvider === providerId);
