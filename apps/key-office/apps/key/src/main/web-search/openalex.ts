// OpenAlex (api.openalex.org/works?search=…): free, no key needed; requests carry the
// polite pool's `mailto`, and an API key from Settings when there is one.
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
      arxiv: arxivFrom(primary?.landing_page_url, best?.landing_page_url, doi),
    },
    citedBy: work.cited_by_count ?? undefined,
    openAccess: work.open_access?.is_oa ?? undefined,
    oaStatus: work.open_access?.oa_status ?? undefined,
    pdfUrl: best?.pdf_url ?? undefined,
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

const auth = (mailto: string, apiKey?: string) => ({ mailto, ...(apiKey ? { api_key: apiKey } : {}) });

export const openalex: WebProvider = {
  id: "openalex",
  label: "OpenAlex",
  icon: "globe",
  capabilities: { apiKey: true, keyHelp: "Optional. Uses the key from OpenAlex above.", enabledByDefault: true },
  async search(query, { limit, cursor, signal, filters }, { mailto, apiKey, fetch }) {
    const filter = [
      filters?.yearFrom || filters?.yearTo ? `publication_year:${filters.yearFrom ?? ""}-${filters.yearTo ?? ""}` : "",
      filters?.openAccess ? "is_oa:true" : "",
    ].filter(Boolean);
    const params = new URLSearchParams({ search: query, "per-page": String(limit), cursor: cursor ?? "*", select: FIELDS, ...auth(mailto, apiKey) });
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
