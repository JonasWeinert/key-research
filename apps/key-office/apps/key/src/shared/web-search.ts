// Web search across scholarly catalogues (OpenAlex, Semantic Scholar …): the shapes the
// library host answers with (crates/key-desktop-host/src/web_search, which also searches,
// filters and merges), and how a result is shown.
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
