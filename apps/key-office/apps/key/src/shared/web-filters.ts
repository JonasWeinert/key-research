// The search field's filter tokens as web search understands them. Each token the web can
// apply becomes part of `WebFilters`; each provider says which of them it applies in its
// request (see main/web-search/provider.ts), and the rest that a result shows (an author's
// name, the journal …) are checked on the results it returns. Tokens no provider can apply
// (a tag, a collection, notes …) stay in the query for the library and are shown as not
// applied while only the web is searched.
import type { WebResult } from "./web-search";

/** The kinds of filter web search knows. */
export type WebFilterKey = "year" | "author" | "title" | "venue" | "doi" | "arxiv" | "pmid" | "pmcid" | "openAccess" | "type" | "citations" | "abstract" | "language" | "retracted";

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

/** Which web filter a token is, if any. */
export function webFilterKey(token: FilterToken): WebFilterKey | undefined {
  switch (token.field) {
    case "year":
      return /^\d{4}$/.test(token.value) ? "year" : undefined;
    case "creator":
    case "person":
      return "author";
    case "title":
      return "title";
    case "container":
    case "venue":
      return "venue";
    case "doi":
    case "arxiv":
    case "pmid":
    case "pmcid":
      return token.field;
    case "oaStatus":
      return "openAccess";
    case "itemType":
    case "workType":
      return webWorkType(token.value) ? "type" : undefined;
    case "citations":
      return /^\d+$/.test(token.value) ? "citations" : undefined;
    case "abstract":
      return "abstract";
    case "language":
      return /^[a-z]{2}$/i.test(token.value) ? "language" : undefined;
    case "retracted":
      return "retracted";
    default:
      return undefined;
  }
}

/** The web filters a list of tokens asks for. Tokens of the same kind narrow together. */
export function toWebFilters(tokens: FilterToken[]): WebFilters {
  const out: WebFilters = {};
  for (const token of tokens) {
    const key = webFilterKey(token);
    if (!key) continue;
    // People and venues are entity tokens: their value is an id, their label the name.
    const text = token.field === "person" || token.field === "venue" ? token.label : token.value;
    const op = token.op ?? "is";
    switch (key) {
      case "year": {
        const year = Number(token.value);
        const from = op === "gt" ? year + 1 : op === "gte" ? year : op === "is" || op === "contains" ? year : undefined;
        const to = op === "lt" ? year - 1 : op === "lte" ? year : op === "is" || op === "contains" ? year : undefined;
        if (from !== undefined) out.yearFrom = Math.max(out.yearFrom ?? from, from);
        if (to !== undefined) out.yearTo = Math.min(out.yearTo ?? to, to);
        break;
      }
      case "author":
        out.authors = [...(out.authors ?? []), text.trim()].filter(Boolean);
        break;
      case "title":
        out.title = [out.title, text.trim()].filter(Boolean).join(" ");
        break;
      case "venue":
        out.venue = text.trim();
        break;
      case "doi":
        out.doi = text.trim().toLowerCase();
        break;
      case "arxiv":
        out.arxiv = text.trim().toLowerCase();
        break;
      case "pmid":
        out.pmid = text.trim();
        break;
      case "pmcid":
        out.pmcid = text.trim().toUpperCase();
        break;
      case "openAccess": {
        const status = text.trim().toLowerCase();
        if (status === "closed") out.openAccess = false;
        else {
          out.openAccess = true;
          if (status && status !== "true" && status !== "open") out.oaStatus = status;
        }
        break;
      }
      case "type":
        out.type = webWorkType(token.value);
        break;
      case "citations": {
        const n = Number(token.value);
        if (op === "gt") out.minCitations = n + 1;
        else if (op === "gte" || op === "is") out.minCitations = n;
        else if (op === "lt") out.maxCitations = Math.max(0, n - 1);
        else if (op === "lte") out.maxCitations = n;
        break;
      }
      case "abstract":
        out.abstract = text.trim();
        break;
      case "language":
        out.language = text.trim().toLowerCase();
        break;
      case "retracted":
        out.retracted = token.value !== "false";
        break;
    }
  }
  return out;
}

/** The kinds of filter set in `filters`. */
export function activeWebFilters(filters: WebFilters | undefined): WebFilterKey[] {
  if (!filters) return [];
  const keys: WebFilterKey[] = [];
  if (filters.yearFrom !== undefined || filters.yearTo !== undefined) keys.push("year");
  if (filters.authors?.length) keys.push("author");
  if (filters.title) keys.push("title");
  if (filters.venue) keys.push("venue");
  if (filters.doi) keys.push("doi");
  if (filters.arxiv) keys.push("arxiv");
  if (filters.pmid) keys.push("pmid");
  if (filters.pmcid) keys.push("pmcid");
  if (filters.openAccess !== undefined) keys.push("openAccess");
  if (filters.type) keys.push("type");
  if (filters.minCitations !== undefined || filters.maxCitations !== undefined) keys.push("citations");
  if (filters.abstract) keys.push("abstract");
  if (filters.language) keys.push("language");
  if (filters.retracted !== undefined) keys.push("retracted");
  return keys;
}

/** Only the filters of these kinds. */
export function pickWebFilters(filters: WebFilters, keys: WebFilterKey[]): WebFilters {
  const out: WebFilters = {};
  const has = (k: WebFilterKey) => keys.includes(k);
  if (has("year")) Object.assign(out, { yearFrom: filters.yearFrom, yearTo: filters.yearTo });
  if (has("author")) out.authors = filters.authors;
  if (has("title")) out.title = filters.title;
  if (has("venue")) out.venue = filters.venue;
  if (has("doi")) out.doi = filters.doi;
  if (has("arxiv")) out.arxiv = filters.arxiv;
  if (has("pmid")) out.pmid = filters.pmid;
  if (has("pmcid")) out.pmcid = filters.pmcid;
  if (has("openAccess")) Object.assign(out, { openAccess: filters.openAccess, oaStatus: filters.oaStatus });
  if (has("type")) out.type = filters.type;
  if (has("citations")) Object.assign(out, { minCitations: filters.minCitations, maxCitations: filters.maxCitations });
  if (has("abstract")) out.abstract = filters.abstract;
  if (has("language")) out.language = filters.language;
  if (has("retracted")) out.retracted = filters.retracted;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as WebFilters;
}

const fold = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const contains = (haystack: string | undefined, needle: string) => !!haystack && ` ${fold(haystack)} `.includes(` ${fold(needle)}`);

/** Filters that can be checked on a result itself, whatever the provider. */
export const LOCAL_WEB_FILTERS: WebFilterKey[] = ["year", "author", "title", "venue", "doi", "arxiv", "pmid", "pmcid", "openAccess", "type", "citations", "abstract"];

/** Whether a result meets the filters of these kinds (those a provider could not ask for). */
export function meetsWebFilters(result: WebResult, filters: WebFilters, keys: WebFilterKey[]): boolean {
  return keys.every((key) => {
    switch (key) {
      case "year":
        return result.year !== undefined && (filters.yearFrom === undefined || result.year >= filters.yearFrom) && (filters.yearTo === undefined || result.year <= filters.yearTo);
      case "author":
        // "Smith" matches "John Smith"; "J Smith" its words in order.
        return (filters.authors ?? []).every((name) => result.authors.some((a) => contains(a, name)));
      case "title":
        return contains(result.title, filters.title ?? "");
      case "venue":
        return contains(result.venue, filters.venue ?? "");
      case "doi":
        return result.doi === filters.doi;
      case "arxiv":
        return result.ids.arxiv?.toLowerCase() === filters.arxiv || result.doi === `10.48550/arxiv.${filters.arxiv}`;
      case "pmid":
        return result.ids.pmid === filters.pmid;
      case "pmcid":
        return result.ids.pmcid?.toUpperCase().replace(/^(?!PMC)/, "PMC") === filters.pmcid;
      case "openAccess":
        if (filters.openAccess === false) return result.openAccess === false;
        if (!result.openAccess && !result.pdfUrl) return false;
        return !filters.oaStatus || result.oaStatus === filters.oaStatus;
      case "type":
        return webWorkType(result.type) === filters.type || (filters.type === "article" && webWorkType(result.type) === "review");
      case "citations":
        return result.citedBy !== undefined && (filters.minCitations === undefined || result.citedBy >= filters.minCitations) && (filters.maxCitations === undefined || result.citedBy <= filters.maxCitations);
      case "abstract":
        return contains(result.abstract, filters.abstract ?? "");
      default:
        return false;
    }
  });
}

/** Words that stand in for the query when only filters were given (some providers need words). */
export function filterWords(filters: WebFilters) {
  return [filters.title, ...(filters.authors ?? []), filters.venue, filters.abstract].filter(Boolean).join(" ").trim();
}
