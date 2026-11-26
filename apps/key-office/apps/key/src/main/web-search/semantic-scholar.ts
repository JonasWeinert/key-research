// Semantic Scholar's Graph API (/graph/v1/paper/search): works without a key at a low,
// shared rate limit; a key from Settings is sent as x-api-key.
import { filterWords, type WebFilterKey, type WebFilters, type WebWorkType } from "../../shared/web-filters";
import { bareDoi, snippetOf, type WebPage, type WebResult } from "../../shared/web-search";
import { ProviderError, getJson } from "./http";
import type { WebProvider } from "./provider";

const FIELDS = "title,authors,year,venue,journal,abstract,externalIds,citationCount,isOpenAccess,openAccessPdf,url,publicationTypes";
const base = () => (process.env.KEY_WEB_S2_URL || "https://api.semanticscholar.org").replace(/\/$/, "");

export interface S2Paper {
  paperId: string;
  title?: string | null;
  authors?: { authorId?: string | null; name?: string | null }[];
  year?: number | null;
  venue?: string | null;
  journal?: { name?: string | null } | null;
  abstract?: string | null;
  externalIds?: Record<string, string | number | null | undefined> | null;
  citationCount?: number | null;
  isOpenAccess?: boolean | null;
  openAccessPdf?: { url?: string | null; status?: string | null } | null;
  url?: string | null;
  publicationTypes?: string[] | null;
}

const TYPES: Record<string, string> = { JournalArticle: "article", Conference: "proceedings-article", Review: "review", Book: "book", BookSection: "book-chapter", Dataset: "dataset" };

export function parseS2Paper(paper: S2Paper): WebResult | undefined {
  const title = paper.title?.trim();
  if (!title) return undefined;
  const ext = paper.externalIds ?? {};
  const id = (key: string) => (ext[key] != null && ext[key] !== "" ? String(ext[key]) : undefined);
  const doi = bareDoi(id("DOI"));
  const arxiv = id("ArXiv");
  const types = paper.publicationTypes ?? [];
  return {
    provider: "s2",
    providerId: paper.paperId,
    title,
    authors: (paper.authors ?? []).map((a) => a.name?.trim() ?? "").filter(Boolean),
    year: paper.year ?? undefined,
    venue: paper.journal?.name || paper.venue || undefined,
    abstract: snippetOf(paper.abstract ?? undefined, 4000),
    doi,
    ids: { s2: paper.paperId, arxiv, pmid: id("PubMed"), pmcid: id("PubMedCentral"), mag: id("MAG") },
    citedBy: paper.citationCount ?? undefined,
    openAccess: paper.isOpenAccess ?? undefined,
    oaStatus: paper.openAccessPdf?.status?.toLowerCase() || undefined,
    pdfUrl: paper.openAccessPdf?.url || (arxiv ? `https://arxiv.org/pdf/${arxiv}` : undefined),
    landingUrl: doi ? `https://doi.org/${doi}` : (paper.url ?? undefined),
    // Conference papers are often also tagged JournalArticle; the more specific wins.
    type: ["Conference", "BookSection", "Book", "Review", "Dataset", "JournalArticle"].filter((t) => types.includes(t)).map((t) => TYPES[t])[0] ?? (arxiv && !doi ? "preprint" : undefined),
  };
}

export function parseS2Page(body: { total?: number; offset?: number; next?: number | null; data?: S2Paper[] }): WebPage {
  return {
    results: (body.data ?? []).map(parseS2Paper).filter((r): r is WebResult => !!r),
    cursor: body.next != null ? String(body.next) : undefined,
    total: body.total,
  };
}

// Semantic Scholar applies years itself and finds a work by its identifier; journals, types,
// open access and citation counts it narrows by but not exactly, so they are also checked
// on its results, as are authors, titles and abstracts. Language and retractions it cannot tell.
const FILTERS: WebFilterKey[] = ["year", "doi", "arxiv", "pmid", "pmcid"];
const S2_TYPES: Partial<Record<WebWorkType, string>> = { article: "JournalArticle", review: "Review", book: "Book", chapter: "BookSection", "conference-paper": "Conference", dataset: "Dataset" };

/** The paper to look up instead of searching, for an identifier filter. */
export function s2PaperId(filters: WebFilters = {}) {
  if (filters.doi) return `DOI:${filters.doi}`;
  if (filters.arxiv) return `ARXIV:${filters.arxiv}`;
  if (filters.pmid) return `PMID:${filters.pmid}`;
  if (filters.pmcid) return `PMCID:${filters.pmcid.replace(/^PMC/i, "")}`;
  return undefined;
}

/** Search parameters for these filters. */
export function s2Params(filters: WebFilters = {}): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.yearFrom !== undefined || filters.yearTo !== undefined) out.year = filters.yearFrom === filters.yearTo ? String(filters.yearFrom) : `${filters.yearFrom ?? ""}-${filters.yearTo ?? ""}`;
  if (filters.venue) out.venue = filters.venue.replace(/,/g, " ");
  if (filters.openAccess) out.openAccessPdf = "";
  if (filters.type && S2_TYPES[filters.type]) out.publicationTypes = S2_TYPES[filters.type]!;
  if (filters.minCitations !== undefined) out.minCitationCount = String(filters.minCitations);
  return out;
}

export const semanticScholar: WebProvider = {
  id: "s2",
  label: "Semantic Scholar",
  icon: "sparkle",
  capabilities: {
    apiKey: true,
    keyHelp: "Optional. Without one, Semantic Scholar answers slowly when many people search at once.",
    enabledByDefault: true,
    filters: FILTERS,
  },
  async search(query, { limit, cursor, signal, filters }, { apiKey, fetch }) {
    const id = s2PaperId(filters);
    if (id) {
      if (cursor) return { results: [] };
      const paper = await semanticScholar.lookup!(id, { apiKey, fetch, signal, mailto: "" }).catch((error) => {
        if (error instanceof ProviderError && error.status === 404) return undefined;
        throw error;
      });
      return { results: paper ? [paper] : [], total: paper ? 1 : 0 };
    }
    const words = query || filterWords(filters ?? {});
    if (!words) return { results: [] };
    const params = new URLSearchParams({ query: words, offset: cursor ?? "0", limit: String(limit), fields: FIELDS, ...s2Params(filters) });
    const headers: Record<string, string> = apiKey ? { "x-api-key": apiKey } : {};
    return parseS2Page(await getJson(`${base()}/graph/v1/paper/search?${params}`, { signal, fetch, headers, label: "Semantic Scholar" }));
  },
  async lookup(id, { apiKey, fetch, signal }) {
    const doi = bareDoi(id);
    const key = doi?.startsWith("10.") ? `DOI:${doi}` : id;
    const headers: Record<string, string> = apiKey ? { "x-api-key": apiKey } : {};
    return parseS2Paper(await getJson(`${base()}/graph/v1/paper/${encodeURI(key)}?fields=${FIELDS}`, { signal, fetch, headers, label: "Semantic Scholar" }));
  },
};
