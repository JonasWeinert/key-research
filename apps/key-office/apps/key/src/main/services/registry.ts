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
  // Database search (crates/key-connectors): keys reach the host as db_options secrets (setup.ts).
  {
    id: "ncbi",
    name: "PubMed (NCBI)",
    summary: "A free NCBI key lets database search ask PubMed ten times a second instead of three.",
    usedFor: "PubMed in database search",
    keyUrl: "https://www.ncbi.nlm.nih.gov/account/settings/",
    keyUrlLabel: "ncbi.nlm.nih.gov",
    async validate(key, context) {
      const base = (process.env.KEY_DB_NCBI_URL || "https://eutils.ncbi.nlm.nih.gov").replace(/\/$/, "");
      const response = await probe(`${base}/entrez/eutils/einfo.fcgi?${new URLSearchParams({ db: "pubmed", retmode: "json", api_key: key })}`, context);
      if (!response) return { ok: false, message: "Couldn't reach NCBI" };
      if (response.status === 400 || refused(response.status)) return { ok: false, message: "NCBI refused this key" };
      if (!response.ok) return { ok: false, message: `NCBI returned HTTP ${response.status}` };
      return { ok: true, message: "NCBI accepted the key" };
    },
  },
  {
    id: "elsevier",
    name: "Scopus",
    via: "Elsevier",
    summary: "Scopus is searched only with a key from Elsevier's developer portal; most need their institution's subscription.",
    usedFor: "Scopus in database search",
    keyUrl: "https://dev.elsevier.com/apikey/manage",
    keyUrlLabel: "dev.elsevier.com",
    keyRequired: true,
    async validate(key, context) {
      const base = (process.env.KEY_DB_ELSEVIER_URL || "https://api.elsevier.com").replace(/\/$/, "");
      const response = await probe(`${base}/content/search/scopus?${new URLSearchParams({ query: "TITLE(heart)", count: "1" })}`, context, { "X-ELS-APIKey": key });
      if (!response) return { ok: false, message: "Couldn't reach Elsevier" };
      if (refused(response.status)) return { ok: false, message: "Elsevier refused this key, or it needs your institution's network" };
      if (!response.ok) return { ok: false, message: `Elsevier returned HTTP ${response.status}` };
      const remaining = remainingFrom(response.headers);
      return { ok: true, message: "Scopus accepted the key", remaining: remaining === undefined ? undefined : { value: remaining, label: "requests left this week" } };
    },
  },
  {
    id: "clarivate-wos",
    name: "Web of Science",
    via: "Clarivate",
    summary: "Web of Science is searched only with a key from Clarivate's developer portal (the Starter API).",
    usedFor: "Web of Science in database search",
    keyUrl: "https://developer.clarivate.com/apis/wos-starter",
    keyUrlLabel: "developer.clarivate.com",
    keyRequired: true,
    async validate(key, context) {
      const base = (process.env.KEY_DB_WOS_URL || "https://api.clarivate.com").replace(/\/$/, "");
      const response = await probe(`${base}/apis/wos-starter/v1/documents?${new URLSearchParams({ q: "TS=(heart)", limit: "1" })}`, context, { "X-ApiKey": key });
      if (!response) return { ok: false, message: "Couldn't reach Clarivate" };
      if (refused(response.status)) return { ok: false, message: "Clarivate refused this key" };
      if (!response.ok) return { ok: false, message: `Clarivate returned HTTP ${response.status}` };
      return { ok: true, message: "Web of Science accepted the key" };
    },
  },
];

export const serviceFor =(id: string) => SERVICES.find((s) => s.id === id);
export const serviceForProvider = (providerId: string) => SERVICES.find((s) => s.webProvider === providerId);
