// Google Scholar through SerpApi's `google_scholar` engine (serpapi.com/search.json). Google
// Scholar itself has no API and must not be scraped; SerpApi is a paid third party that runs
// the search with the user's own key (Settings → Services & API keys). Off unless the user
// turns it on, or used as the fallback when the other catalogues fail or find nothing.
// Another Scholar API (ScraperAPI, Serper …) would be one more file like this one.
import { snippetOf, type WebPage, type WebResult } from "../../shared/web-search";
import { serpapiBase } from "../services/registry";
import { ProviderError, getJson } from "./http";
import type { WebProvider } from "./provider";

export interface SerpScholarResult {
  position?: number;
  title?: string | null;
  result_id?: string | null;
  link?: string | null;
  snippet?: string | null;
  type?: string | null;
  publication_info?: { summary?: string | null; authors?: { name?: string | null }[] } | null;
  resources?: { title?: string | null; file_format?: string | null; link?: string | null }[] | null;
  inline_links?: { cited_by?: { total?: number | null } | null } | null;
}
export interface SerpScholarPage {
  error?: string;
  search_information?: { total_results?: number | null };
  serpapi_pagination?: { next?: string | null } | null;
  organic_results?: SerpScholarResult[];
}

/** "A Vaswani, N Shazeer… - Advances in neural …, 2017 - proceedings.neurips.cc". */
export function parseSummary(summary?: string | null) {
  const parts = (summary ?? "").split(" - ").map((p) => p.trim());
  const authors = (parts[0] ?? "")
    .split(",")
    .map((a) => a.replace(/…|\.\.\./g, "").trim())
    .filter((a) => a && !/^\d{4}$/.test(a));
  const middle = parts.length > 2 ? parts[1] : parts[1] && !/\.[a-z]{2,}$/i.test(parts[1]) ? parts[1] : "";
  const year = Number(middle.match(/\b(1[5-9]\d{2}|20\d{2})\b/)?.[1]) || undefined;
  const venue = middle.replace(/,?\s*\b(1[5-9]\d{2}|20\d{2})\b\s*$/, "").replace(/…$/, "").trim() || undefined;
  return { authors, year, venue };
}

export function parseScholarResult(item: SerpScholarResult): WebResult | undefined {
  const title = item.title?.trim();
  if (!title) return undefined;
  const summary = parseSummary(item.publication_info?.summary);
  const named = (item.publication_info?.authors ?? []).map((a) => a.name?.trim() ?? "").filter(Boolean);
  const pdf = item.resources?.find((r) => r.file_format?.toUpperCase() === "PDF")?.link ?? undefined;
  const doi = item.link?.match(/\b(10\.\d{4,9}\/[^\s?#]+)/)?.[1]?.toLowerCase();
  return {
    provider: "scholar",
    providerId: item.result_id ?? title,
    title,
    authors: named.length >= summary.authors.length ? named : summary.authors,
    year: summary.year,
    venue: summary.venue,
    abstract: snippetOf(item.snippet ?? undefined, 600),
    doi,
    ids: {},
    citedBy: item.inline_links?.cited_by?.total ?? undefined,
    openAccess: pdf ? true : undefined,
    pdfUrl: pdf,
    landingUrl: item.link ?? undefined,
    type: item.type === "Book" ? "book" : undefined,
  };
}

export function parseScholarPage(body: SerpScholarPage, start: number): WebPage {
  const results = (body.organic_results ?? []).map(parseScholarResult).filter((r): r is WebResult => !!r);
  const total = body.search_information?.total_results ?? undefined;
  return { results, cursor: body.serpapi_pagination?.next && results.length ? String(start + results.length) : undefined, total };
}

export const scholarSerpApi: WebProvider = {
  id: "scholar",
  label: "Google Scholar",
  icon: "search",
  capabilities: {
    apiKey: true,
    keyRequired: true,
    keyHelp: "Through SerpApi, with your SerpApi key (Services & API keys).",
    enabledByDefault: false,
    service: "scholar-serpapi",
  },
  async search(query, { limit, cursor, signal, filters }, { apiKey, fetch }) {
    if (!apiKey) throw new ProviderError("Google Scholar needs a SerpApi key", 401);
    const start = Number(cursor) || 0;
    const params = new URLSearchParams({ engine: "google_scholar", q: query, num: String(Math.min(20, limit)), start: String(start), api_key: apiKey });
    if (filters?.yearFrom) params.set("as_ylo", String(filters.yearFrom));
    if (filters?.yearTo) params.set("as_yhi", String(filters.yearTo));
    const body = await getJson<SerpScholarPage>(`${serpapiBase()}/search.json?${params}`, { signal, fetch, label: "SerpApi" });
    // SerpApi answers 200 with an error for some failures (quota, bad key).
    if (body.error && /any results/i.test(body.error)) return { results: [] };
    if (body.error) throw new ProviderError(/run out|limit/i.test(body.error) ? "SerpApi: this key has no searches left" : /invalid api key/i.test(body.error) ? "SerpApi refused the API key" : "SerpApi could not run the search", /invalid api key/i.test(body.error) ? 401 : /run out|limit/i.test(body.error) ? 429 : undefined);
    return parseScholarPage(body, start);
  },
};
