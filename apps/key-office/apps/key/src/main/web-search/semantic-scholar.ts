// Semantic Scholar's Graph API (/graph/v1/paper/search): works without a key at a low,
// shared rate limit; a key from Settings is sent as x-api-key.
import { bareDoi, snippetOf, type WebPage, type WebResult } from "../../shared/web-search";
import { getJson } from "./http";
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

export const semanticScholar: WebProvider = {
  id: "s2",
  label: "Semantic Scholar",
  icon: "sparkle",
  capabilities: {
    apiKey: true,
    keyHelp: "Optional. Without one, Semantic Scholar answers slowly when many people search at once.",
    enabledByDefault: true,
    service: "semantic-scholar",
  },
  async search(query, { limit, cursor, signal, filters }, { apiKey, fetch }) {
    const params = new URLSearchParams({ query, offset: cursor ?? "0", limit: String(limit), fields: FIELDS });
    if (filters?.yearFrom || filters?.yearTo) params.set("year", `${filters.yearFrom ?? ""}-${filters.yearTo ?? ""}`);
    if (filters?.openAccess) params.set("openAccessPdf", "");
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
