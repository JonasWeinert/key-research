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
  /** A general web search engine (Settings → Web search engines). */
  engine?: boolean;
  /** The provider's pricing page (prices are never written into Key). */
  pricingUrl?: string;
  /** Testing the key runs one search, so it uses some of the allowance. */
  checkUsesQuota?: boolean;
}

export const secretName = (id: string) => `service:${id}`;

const openalexBase = () => (process.env.KEY_WEB_OPENALEX_URL || "https://api.openalex.org").replace(/\/$/, "");
const s2Base = () => (process.env.KEY_WEB_S2_URL || "https://api.semanticscholar.org").replace(/\/$/, "");
export const serpapiBase = () => (process.env.KEY_WEB_SERPAPI_URL || "https://serpapi.com").replace(/\/$/, "");
const ncbiBase = () => (process.env.KEY_DB_NCBI_URL || "https://eutils.ncbi.nlm.nih.gov").replace(/\/$/, "");
const elsevierBase =() => (process.env.KEY_DB_ELSEVIER_URL || "https://api.elsevier.com").replace(/\/$/, "");
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
    id: "ncbi",
    name: "PubMed",
    via: "NCBI E-utilities",
    summary: "Optional. Raises the PubMed rate limit from 3 to 10 requests a second, so large searches finish sooner.",
    usedFor: "Database search (PubMed connector)",
    keyUrl: "https://account.ncbi.nlm.nih.gov/settings/",
    keyUrlLabel: "ncbi.nlm.nih.gov",
    keyRequired: true,
    async validate(key, context) {
      const params = new URLSearchParams({ db: "pubmed", retmode: "json", tool: "key", api_key: key });
      const response = await probe(`${ncbiBase()}/entrez/eutils/einfo.fcgi?${params}`, context);
      if (!response) return { ok: false, message: "Couldn't reach NCBI" };
      if (response.status === 400 || refused(response.status)) return { ok: false, message: "NCBI refused this key" };
      if (response.status === 429) return { ok: false, message: "NCBI is limiting requests right now; try again in a moment" };
      if (!response.ok) return { ok: false, message: `NCBI returned HTTP ${response.status}` };
      return { ok: true, message: "NCBI accepted the key" };
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
  ...webEngineServices(),
];

export const serviceFor =(id: string) => SERVICES.find((s) => s.id === id);
export const serviceForProvider = (providerId: string) => SERVICES.find((s) => s.webProvider === providerId);

// ── Web search engines (crates/key-desktop-host/src/web_search: tavily.rs, firecrawl.rs …) ──
// Each check costs as little as the service allows: an account or usage endpoint where there is
// one (no search is run), else the smallest search (`checkUsesQuota`, which Settings says).
const engineBase = (variable: string, fallback: string) => () => (process.env[variable] || fallback).replace(/\/$/, "");
export const tavilyBase = engineBase("KEY_WEB_TAVILY_URL", "https://api.tavily.com");
export const firecrawlBase = engineBase("KEY_WEB_FIRECRAWL_URL", "https://api.firecrawl.dev");
export const exaBase = engineBase("KEY_WEB_EXA_URL", "https://api.exa.ai");
export const braveBase = engineBase("KEY_WEB_BRAVE_URL", "https://api.search.brave.com");
export const perplexityBase = engineBase("KEY_WEB_PERPLEXITY_URL", "https://api.perplexity.ai");
export const youBase = engineBase("KEY_WEB_YOU_URL", "https://ydc-index.io");
export const jinaBase = engineBase("KEY_WEB_JINA_URL", "https://s.jina.ai");

async function post(url: string, body: unknown, context: { fetch?: Fetch; signal?: AbortSignal }, headers: Record<string, string>) {
  const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  try {
    return await (context.fetch ?? fetch)(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch {
    return undefined;
  }
}

/** The usual answers, in words: refused, spent, limited, other. */
function engineAnswer(name: string, response: Response | undefined): Validation | undefined {
  if (!response) return { ok: false, message: `Couldn't reach ${name}` };
  if (refused(response.status)) return { ok: false, message: `${name} refused this key` };
  if (response.status === 402 || response.status === 432 || response.status === 433) return { ok: false, message: `${name} accepted the key, but it has no credits left` };
  if (response.status === 429) return { ok: true, message: `Key accepted; ${name} is limiting requests right now` };
  if (!response.ok) return { ok: false, message: `${name} returned HTTP ${response.status}` };
  return undefined;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function webEngineServices(): KeyedService[] {
  return [
    {
      id: "tavily",
      name: "Tavily",
      summary: "A web search engine made for research tools. Searches the whole web for pages, reports and articles.",
      usedFor: "Web search engines, when Tavily is turned on there",
      keyUrl: "https://app.tavily.com/home",
      keyUrlLabel: "tavily.com",
      webProvider: "tavily",
      keyRequired: true,
      engine: true,
      pricingUrl: "https://www.tavily.com/pricing",
      async validate(key, context) {
        // The usage endpoint answers what the key has used; it runs no search.
        const response = await probe(`${tavilyBase()}/usage`, context, { Authorization: `Bearer ${key}` });
        const failed = engineAnswer("Tavily", response);
        if (failed) return failed;
        const body = (await response!.json().catch(() => ({}))) as { key?: { usage?: number; limit?: number | null }; account?: { plan_usage?: number; plan_limit?: number } };
        const used = num(body.key?.usage) ?? num(body.account?.plan_usage);
        const limit = num(body.key?.limit) ?? num(body.account?.plan_limit);
        const left = used !== undefined && limit !== undefined ? Math.max(0, limit - used) : undefined;
        return { ok: true, message: "Tavily accepted the key", remaining: left === undefined ? undefined : { value: left, label: "credits left this month" } };
      },
    },
    {
      id: "firecrawl",
      name: "Firecrawl",
      summary: "Searches the web and can read a page as clean text, to save pages Key cannot open itself.",
      usedFor: "Web search engines and saving web pages, when Firecrawl is turned on there",
      keyUrl: "https://www.firecrawl.dev/app/api-keys",
      keyUrlLabel: "firecrawl.dev",
      webProvider: "firecrawl",
      keyRequired: true,
      engine: true,
      pricingUrl: "https://www.firecrawl.dev/pricing",
      async validate(key, context) {
        // The credit usage endpoint runs no search or scrape.
        const response = await probe(`${firecrawlBase()}/v2/team/credit-usage`, context, { Authorization: `Bearer ${key}` });
        const failed = engineAnswer("Firecrawl", response);
        if (failed) return failed;
        const body = (await response!.json().catch(() => ({}))) as { success?: boolean; data?: { remainingCredits?: number } };
        if (body.success === false) return { ok: false, message: "Firecrawl refused this key" };
        const left = num(body.data?.remainingCredits);
        return { ok: true, message: "Firecrawl accepted the key", remaining: left === undefined ? undefined : { value: left, label: "credits left" } };
      },
    },
    {
      id: "exa",
      name: "Exa",
      summary: "A search engine that finds pages by meaning, with a mode for scholarly publications.",
      usedFor: "Web search engines, when Exa is turned on there",
      keyUrl: "https://dashboard.exa.ai/api-keys",
      keyUrlLabel: "exa.ai",
      webProvider: "exa",
      keyRequired: true,
      engine: true,
      pricingUrl: "https://exa.ai/pricing",
      checkUsesQuota: true,
      async validate(key, context) {
        // Exa has no free account endpoint: the smallest search, one result without contents.
        const response = await post(`${exaBase()}/search`, { query: "test", numResults: 1, type: "auto" }, context, { "x-api-key": key });
        return engineAnswer("Exa", response) ?? { ok: true, message: "Exa accepted the key (the check used one search)" };
      },
    },
    {
      id: "brave",
      name: "Brave Search",
      summary: "Brave’s own independent web index, through the Brave Search API.",
      usedFor: "Web search engines, when Brave Search is turned on there",
      keyUrl: "https://api-dashboard.search.brave.com/app/keys",
      keyUrlLabel: "brave.com",
      webProvider: "brave",
      keyRequired: true,
      engine: true,
      pricingUrl: "https://brave.com/search/api/",
      checkUsesQuota: true,
      async validate(key, context) {
        const params = new URLSearchParams({ q: "test", count: "1" });
        const response = await probe(`${braveBase()}/res/v1/web/search?${params}`, context, { "X-Subscription-Token": key });
        const failed = engineAnswer("Brave Search", response);
        if (failed) return failed;
        // When Brave sends "per second, per month" pairs, the last is this month's.
        const left = Number(response!.headers.get("x-ratelimit-remaining")?.split(",").pop()?.trim() ?? NaN);
        return { ok: true, message: "Brave Search accepted the key (the check used one search)", remaining: Number.isFinite(left) ? { value: left, label: "searches left this month" } : undefined };
      },
    },
    {
      id: "perplexity",
      name: "Perplexity Search",
      summary: "Ranked web results from Perplexity’s search index (its Search API, not its chat answers).",
      usedFor: "Web search engines, when Perplexity is turned on there",
      keyUrl: "https://www.perplexity.ai/account/api/keys",
      keyUrlLabel: "perplexity.ai",
      webProvider: "perplexity",
      keyRequired: true,
      engine: true,
      pricingUrl: "https://docs.perplexity.ai/getting-started/pricing",
      checkUsesQuota: true,
      async validate(key, context) {
        const response = await post(`${perplexityBase()}/search`, { query: "test", max_results: 1 }, context, { Authorization: `Bearer ${key}` });
        return engineAnswer("Perplexity", response) ?? { ok: true, message: "Perplexity accepted the key (the check used one search)" };
      },
    },
    {
      id: "you",
      name: "You.com",
      summary: "Web results from You.com’s search index, through its Search API.",
      usedFor: "Web search engines, when You.com is turned on there",
      keyUrl: "https://you.com/platform",
      keyUrlLabel: "you.com",
      webProvider: "you",
      keyRequired: true,
      engine: true,
      pricingUrl: "https://you.com/docs/administration/billing",
      checkUsesQuota: true,
      async validate(key, context) {
        const response = await post(`${youBase()}/v1/search`, { query: "test", count: 1 }, context, { "X-API-Key": key });
        return engineAnswer("You.com", response) ?? { ok: true, message: "You.com accepted the key (the check used one search)" };
      },
    },
    {
      id: "jina",
      name: "Jina",
      summary: "Jina Search finds pages on the web; Jina Reader turns a page into clean text, to save pages Key cannot open itself.",
      usedFor: "Web search engines and saving web pages, when Jina is turned on there",
      keyUrl: "https://jina.ai/api-dashboard/key-manager",
      keyUrlLabel: "jina.ai",
      webProvider: "jina",
      keyRequired: true,
      engine: true,
      pricingUrl: "https://jina.ai/reader/#pricing",
      checkUsesQuota: true,
      async validate(key, context) {
        // Reading a tiny page costs a few tokens, far less than a search.
        const response = await probe(`${jinaReaderBase()}/https://example.com`, context, { Authorization: `Bearer ${key}` });
        return engineAnswer("Jina", response) ?? { ok: true, message: "Jina accepted the key (the check read one small page, a few tokens)" };
      },
    },
  ];
}
export const jinaReaderBase = engineBase("KEY_WEB_JINA_READER_URL", "https://r.jina.ai");
