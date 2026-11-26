// OpenAlex (api.openalex.org/works?search=…): free, no key needed; requests carry the
// polite pool's `mailto`, and an API key from Settings when there is one.
import type { WebFilterKey, WebFilters, WebWorkType } from "../../shared/web-filters";
import { bareDoi, snippetOf, type WebPage, type WebResult } from "../../shared/web-search";
import { getJson } from "./http";
import type { WebProvider } from "./provider";

const FIELDS = "id,doi,display_name,publication_year,type,authorships,primary_location,best_oa_location,open_access,ids,cited_by_count,abstract_inverted_index";
const base = () => (process.env.KEY_WEB_OPENALEX_URL || "https://api.openalex.org").replace(/\/$/, "");

type Location = { landing_page_url?: string | null; pdf_url?: string | null; source?: { display_name?: string | null } | null } | null;
export interface OpenAlexWork {
  id: string;
  doi?: string | null;
  display_name?: string | null;
  title?: string | null;
  publication_year?: number | null;
  type?: string | null;
  authorships?: { author?: { display_name?: string | null } }[];
  primary_location?: Location;
  best_oa_location?: Location;
  open_access?: { is_oa?: boolean; oa_status?: string | null; oa_url?: string | null } | null;
  ids?: Record<string, string | undefined>;
  cited_by_count?: number | null;
  abstract_inverted_index?: Record<string, number[]> | null;
}

/** OpenAlex keeps abstracts as word → positions. */
export function abstractText(index?: Record<string, number[]> | null) {
  if (!index) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const at of positions) words[at] = word;
  return words.filter(Boolean).join(" ") || undefined;
}

const short = (id?: string | null) => id?.replace(/^https?:\/\/[^/]+\//, "") || undefined;
const arxivFrom = (...urls: (string | null | undefined)[]) => {
  for (const url of urls) {
    const match = url?.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:v\d+)?(?:\.pdf)?$/i) ?? url?.match(/^10\.48550\/arxiv\.(.+)$/i);
    if (match) return match[1];
  }
  return undefined;
};

export function parseOpenAlexWork(work: OpenAlexWork): WebResult | undefined {
  const title = (work.display_name ?? work.title ?? "").trim();
  if (!title) return undefined;
  const doi = bareDoi(work.doi);
  const primary = work.primary_location;
  const best = work.best_oa_location;
  const pmid = short(work.ids?.pmid);
  const arxiv = arxivFrom(primary?.landing_page_url, best?.landing_page_url, doi);
  return {
    provider: "openalex",
    providerId: short(work.id) ?? work.id,
    title,
    authors: (work.authorships ?? []).map((a) => a.author?.display_name?.trim() ?? "").filter(Boolean),
    year: work.publication_year ?? undefined,
    venue: primary?.source?.display_name ?? undefined,
    abstract: snippetOf(abstractText(work.abstract_inverted_index), 4000),
    doi,
    ids: {
      openalex: short(work.id),
      pmid: pmid?.replace(/\D/g, "") || undefined,
      pmcid: short(work.ids?.pmcid)?.replace(/^.*\//, "") || undefined,
      mag: work.ids?.mag ? String(work.ids.mag) : undefined,
      arxiv,
    },
    citedBy: work.cited_by_count ?? undefined,
    openAccess: work.open_access?.is_oa ?? undefined,
    oaStatus: work.open_access?.oa_status ?? undefined,
    // An arXiv preprint's PDF is always free, even when OpenAlex points elsewhere.
    pdfUrl: best?.pdf_url ?? (arxiv ? `https://arxiv.org/pdf/${arxiv}` : undefined),
    landingUrl: doi ? `https://doi.org/${doi}` : (primary?.landing_page_url ?? undefined),
    type: work.type ?? undefined,
  };
}

export function parseOpenAlexPage(body: { meta?: { count?: number; next_cursor?: string | null }; results?: OpenAlexWork[] }): WebPage {
  return {
    results: (body.results ?? []).map(parseOpenAlexWork).filter((r): r is WebResult => !!r),
    cursor: body.meta?.next_cursor ?? undefined,
    total: body.meta?.count,
  };
}

// Filters OpenAlex applies itself (api.openalex.org/works?filter=…). Venues have no search
// filter there, so they are checked on the results.
const FILTERS: WebFilterKey[] = ["year", "author", "title", "doi", "arxiv", "pmid", "pmcid", "openAccess", "type", "citations", "abstract", "language", "retracted"];
const OA_TYPES: Record<WebWorkType, string> = {
  article: "article",
  review: "review",
  preprint: "preprint",
  book: "book",
  chapter: "book-chapter",
  "conference-paper": "article",
  thesis: "dissertation",
  report: "report",
  dataset: "dataset",
};
// Commas and pipes separate filters and values in the filter parameter.
const plain = (text: string) => text.replace(/[,|:]+/g, " ").replace(/\s+/g, " ").trim();

/** The `filter` parameter for these filters (each part ANDed). */
export function openAlexFilter(filters: WebFilters = {}): string[] {
  const out: string[] = [];
  if (filters.yearFrom !== undefined || filters.yearTo !== undefined) {
    out.push(filters.yearFrom === filters.yearTo ? `publication_year:${filters.yearFrom}` : `publication_year:${filters.yearFrom ?? ""}-${filters.yearTo ?? ""}`);
  }
  for (const name of filters.authors ?? []) out.push(`raw_author_name.search:${plain(name)}`);
  if (filters.title) out.push(`title.search:${plain(filters.title)}`);
  if (filters.abstract) out.push(`abstract.search:${plain(filters.abstract)}`);
  if (filters.doi) out.push(`doi:https://doi.org/${filters.doi}`);
  // arXiv preprints carry DataCite DOIs in OpenAlex.
  if (filters.arxiv) out.push(`doi:https://doi.org/10.48550/arxiv.${filters.arxiv}`);
  if (filters.pmid) out.push(`pmid:${filters.pmid}`);
  if (filters.pmcid) out.push(`pmcid:${filters.pmcid.replace(/^PMC/i, "")}`);
  if (filters.openAccess === false) out.push("is_oa:false");
  else if (filters.oaStatus) out.push(`oa_status:${plain(filters.oaStatus)}`);
  else if (filters.openAccess) out.push("is_oa:true");
  // Conference papers are articles in a conference's proceedings there.
  if (filters.type === "conference-paper") out.push("primary_location.source.type:conference");
  else if (filters.type) out.push(`type:${OA_TYPES[filters.type]}`);
  if (filters.minCitations !== undefined) out.push(`cited_by_count:>${filters.minCitations - 1}`);
  if (filters.maxCitations !== undefined) out.push(`cited_by_count:<${filters.maxCitations + 1}`);
  if (filters.language) out.push(`language:${filters.language}`);
  if (filters.retracted !== undefined) out.push(`is_retracted:${filters.retracted}`);
  return out;
}

const auth = (mailto: string, apiKey?: string) => ({ mailto, ...(apiKey ? { api_key: apiKey } : {}) });

export const openalex: WebProvider = {
  id: "openalex",
  label: "OpenAlex",
  icon: "globe",
  capabilities: { apiKey: true, keyHelp: "Optional. Uses the key from OpenAlex above.", enabledByDefault: true, filters: FILTERS, service: "openalex" },
  async search(query, { limit, cursor, signal, filters }, { mailto, apiKey, fetch }) {
    const filter = openAlexFilter(filters);
    const params = new URLSearchParams({ search: query, "per-page": String(limit), cursor: cursor ?? "*", select: FIELDS, ...auth(mailto, apiKey) });
    // Filters alone (an author, a DOI …) need no words.
    if (!query) params.delete("search");
    if (filter.length) params.set("filter", filter.join(","));
    return parseOpenAlexPage(await getJson(`${base()}/works?${params}`, { signal, fetch, label: "OpenAlex" }));
  },
  async lookup(id, { mailto, apiKey, fetch, signal }) {
    const doi = bareDoi(id);
    const key = doi?.startsWith("10.") ? `doi:${doi}` : id;
    const params = new URLSearchParams({ select: FIELDS, ...auth(mailto, apiKey) });
    return parseOpenAlexWork(await getJson(`${base()}/works/${encodeURI(key)}?${params}`, { signal, fetch, label: "OpenAlex" }));
  },
};
