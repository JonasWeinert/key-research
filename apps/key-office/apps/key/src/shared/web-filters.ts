// Web search filters as the library host reads them from search tokens (web_filters in
// crates/key-desktop-host/src/web_search/filters.rs, which also maps and checks them). Tokens
// no provider can apply (a tag, a collection, notes …) stay in the query for the library and
// are shown as not applied while only the web is searched.

/** The kinds of filter web search knows. */
export type WebFilterKey = "year" | "author" | "title" | "venue" | "doi" | "arxiv" | "pmid" | "pmcid" | "openAccess" | "type" | "citations" | "abstract" | "language" | "retracted" | "site";

/** A work type, as the library names item types. */
export type WebWorkType = "article" | "review" | "preprint" | "book" | "chapter" | "conference-paper" | "thesis" | "report" | "dataset";

export interface WebFilters {
  yearFrom?: number;
  yearTo?: number;
  /** Each must be among the authors. */
  authors?: string[];
  /** Words in the title (a phrase). */
  title?: string;
  /** The journal, proceedings or other venue. */
  venue?: string;
  /** Bare and lower-case. */
  doi?: string;
  arxiv?: string;
  pmid?: string;
  pmcid?: string;
  /** Free to read (true) or not (false). */
  openAccess?: boolean;
  /** gold, green, hybrid, bronze, diamond (OpenAlex's names). */
  oaStatus?: string;
  type?: WebWorkType;
  /** Cited at least this often. */
  minCitations?: number;
  maxCitations?: number;
  abstract?: string;
  /** ISO 639-1. */
  language?: string;
  retracted?: boolean;
  /** Only pages of this site (a host name), for web search engines. */
  site?: string;
}

/** A search field token (search-suggest's SearchFilter). */
export interface FilterToken {
  field: string;
  op?: string;
  value: string;
  key?: string;
  label: string;
}

const TYPE_OF: Record<string, WebWorkType> = {
  article: "article",
  "journal-article": "article",
  "magazine-article": "article",
  review: "review",
  preprint: "preprint",
  "posted-content": "preprint",
  book: "book",
  monograph: "book",
  chapter: "chapter",
  "book-chapter": "chapter",
  "conference-paper": "conference-paper",
  "proceedings-article": "conference-paper",
  thesis: "thesis",
  dissertation: "thesis",
  report: "report",
  dataset: "dataset",
};
export const webWorkType = (value?: string) => (value ? TYPE_OF[value.toLowerCase()] : undefined);

