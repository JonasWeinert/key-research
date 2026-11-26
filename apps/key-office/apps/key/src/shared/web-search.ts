// Web search across scholarly catalogues (OpenAlex, Semantic Scholar …): the shapes the
// main process answers with, and how the search page merges what each provider found.
// The providers themselves live in src/main/web-search (they reach the network there).
import type { WebFilterKey } from "./web-filters";

/** What the Settings page and the search page know about a provider. */
export interface WebProviderInfo {
  id: string;
  label: string;
  /** An icon name from the renderer's icon set. */
  icon: string;
  /** Takes an API key (optional unless `keyRequired`). */
  apiKey: boolean;
  keyRequired?: boolean;
  /** A line for Settings: what the key is for, where to get one. */
  keyHelp?: string;
  enabled: boolean;
  /** Supports lookups by id (DOI …) as well as search. */
  lookup: boolean;
  /** The search filters it can apply (shared/web-filters.ts). */
  filters?: WebFilterKey[];
}

/** One work as any provider describes it. */
export interface WebResult {
  /** The provider that found it, and its id there. */
  provider: string;
  /** Found by this (keyed) provider in the place of the one asked, which failed. */
  fallbackFor?: string;
  providerId: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  /** A few sentences of the abstract, plain text. */
  abstract?: string;
  /** Bare and lower-case: 10.1234/abc. */
  doi?: string;
  ids: { openalex?: string; s2?: string; arxiv?: string; pmid?: string; pmcid?: string; mag?: string };
  citedBy?: number;
  /** Free to read somewhere, with the best PDF link known. */
  openAccess?: boolean;
  oaStatus?: string;
  pdfUrl?: string;
  landingUrl?: string;
  /** journal-article, preprint, book-chapter … as the provider names it. */
  type?: string;
}

export interface WebPage {
  results: WebResult[];
  /** Filters the provider cannot apply, so it was not asked. */
  skipped?: WebFilterKey[];
  /** Pass back to get the next page; absent at the end. */
  cursor?: string;
  total?: number;
}

/** A merged result: one work, found by one or more providers. */
export interface WebHit extends WebResult {
  key: string;
  /** Every provider that found it, in the order they rank it. */
  foundBy: string[];
  /** Best rank among the providers (0 first). */
  rank: number;
}

export const bareDoi = (doi?: string | null) =>
  (doi ?? "")
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase() || undefined;

/** Titles compared without case, accents, punctuation or spacing. */
export const titleKey = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The same work: one DOI, or (without DOIs on both sides) the same title within a year. */
export function sameWork(a: Pick<WebResult, "doi" | "title" | "year">, b: Pick<WebResult, "doi" | "title" | "year">) {
  if (a.doi && b.doi) return a.doi === b.doi;
  return titleKey(a.title) === titleKey(b.title) && (!a.year || !b.year || Math.abs(a.year - b.year) <= 1);
}

const fill = <T extends object>(into: T, from: T) => {
  for (const [k, v] of Object.entries(from)) if ((into as Record<string, unknown>)[k] == null && v != null && v !== "") (into as Record<string, unknown>)[k] = v;
};

/** Provider pages merged into one list: duplicates (by DOI, then title and year) become one
 *  hit that names every provider and keeps the richest details; ranked by each work's best
 *  rank with any provider, works more providers agree on first among equals, then by the
 *  provider order, so the lists interleave. */
export function mergeWeb(lists: { provider: string; results: WebResult[] }[]): WebHit[] {
  const hits: WebHit[] = [];
  const byDoi = new Map<string, WebHit>();
  const byArxiv = new Map<string, WebHit>();
  const byTitle = new Map<string, WebHit[]>();
  const order = lists.map((l) => l.provider);
  lists.forEach(({ provider: asked, results }) => {
    results.forEach((result, rank) => {
      // A fallback provider can answer in the place of the one asked (Google Scholar).
      const provider = result.fallbackFor ? result.provider : asked;
      const title = titleKey(result.title);
      const arxiv = result.ids.arxiv?.toLowerCase();
      let hit = result.doi ? byDoi.get(result.doi) : undefined;
      hit ??= arxiv ? byArxiv.get(arxiv) : undefined;
      // A title match only joins works whose DOIs do not disagree.
      hit ??= byTitle.get(title)?.find((h) => !(h.doi && result.doi && h.doi !== result.doi) && sameWork({ ...h, doi: undefined }, { ...result, doi: undefined }));
      if (!hit) {
        hit = { ...result, ids: { ...result.ids }, key: result.doi ? `doi:${result.doi}` : `${provider}:${result.providerId}`, foundBy: [provider], rank };
        hits.push(hit);
        byTitle.set(title, [...(byTitle.get(title) ?? []), hit]);
      } else {
        if (!hit.foundBy.includes(provider)) hit.foundBy.push(provider);
        hit.rank = Math.min(hit.rank, rank);
        fill(hit.ids, result.ids);
        const { ids: _ids, provider: _p, providerId: _pid, ...rest } = result;
        fill(hit as unknown as WebResult, rest as WebResult);
        if (!hit.authors.length) hit.authors = result.authors;
        if ((result.abstract?.length ?? 0) > (hit.abstract?.length ?? 0)) hit.abstract = result.abstract;
        if ((result.citedBy ?? -1) > (hit.citedBy ?? -1)) hit.citedBy = result.citedBy;
        if (result.openAccess) hit.openAccess = true;
        if (hit.doi && !hit.key.startsWith("doi:")) hit.key = `doi:${hit.doi}`;
      }
      if (hit.doi) byDoi.set(hit.doi, hit);
      if (hit.ids.arxiv) byArxiv.set(hit.ids.arxiv.toLowerCase(), hit);
    });
  });
  const first = (h: WebHit) => order.indexOf(h.foundBy[0]);
  return hits.sort((a, b) => a.rank - b.rank || b.foundBy.length - a.foundBy.length || first(a) - first(b));
}

/** A short abstract: whole sentences up to about `max` characters. */
export function snippetOf(text: string | undefined, max = 280) {
  const plain = (text ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  if (plain.length <= max) return plain || undefined;
  const cut = plain.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "));
  return end > max * 0.5 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
}

/** "Vaswani, Shazeer et al." */
export function shortAuthors(authors: string[]) {
  const family = (name: string) => name.trim().split(/\s+/).pop() ?? name;
  if (!authors.length) return "";
  if (authors.length === 1) return family(authors[0]);
  if (authors.length === 2) return `${family(authors[0])} & ${family(authors[1])}`;
  return `${family(authors[0])} et al.`;
}
