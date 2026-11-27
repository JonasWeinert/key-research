// Database search: the shapes and calls between the UI and the library host's database
// engine (connectors/COMMANDS.md: list connectors, translate and estimate a neutral query per
// connector, run a search, add results, saved searches, the run report). The UI only edits a
// query and shows what the host answers; translating, searching, de-duplicating and reporting
// are the host's.
//
// `dbSearchApi(invoke, workspaceId)` answers the host's implementation, or the sample one in
// db-search-mock.ts when the build's host has no database engine yet or KEY_DB_SEARCH_MOCK=1
// (smokes). `isMock` tells the page to say it shows sample data.
import type { Invoke } from "./library-api";
import { inboxCollection } from "./item-links";

// ── The neutral query ────────────────────────────────────────────────────────────────

/** Where a term is looked for. Connectors list the scopes they can search. */
export type TermField = "all" | "title" | "title_abstract" | "abstract" | "keywords" | "subject" | "fulltext" | "author" | "journal" | "affiliation" | "identifier" | "year" | "type" | "language";
export const TERM_FIELDS: TermField[] = ["title_abstract", "title", "abstract", "keywords", "subject", "fulltext", "all", "author", "journal", "affiliation", "identifier", "year", "type", "language"];
export const FIELD_LABEL: Record<TermField, string> = {
  all: "Anywhere",
  title: "Title",
  title_abstract: "Title & abstract",
  abstract: "Abstract",
  keywords: "Keywords",
  subject: "Subject headings",
  fulltext: "Full text",
  author: "Author",
  journal: "Journal",
  affiliation: "Affiliation",
  identifier: "Identifier",
  year: "Year",
  type: "Document type",
  language: "Language",
};

export interface QueryTerm {
  id: string;
  text: string;
  /** phrase: the words in this order ("social capital"); words: all of them, anywhere in the field. */
  mode: "phrase" | "words";
  /** Any ending: "child*" finds child, children, childhood. */
  truncate: boolean;
  field: TermField;
  /** A phrase's words within this many words of each other (where supported). */
  proximity?: number | null;
}

/** One idea of the question, with its synonyms: any of the terms (OR). */
export interface Concept {
  id: string;
  label?: string;
  terms: QueryTerm[];
}

export interface QueryFilters {
  yearFrom?: number;
  yearTo?: number;
  /** article, review, preprint, working-paper, report, book, chapter, thesis, trial, dataset */
  types?: string[];
  /** ISO 639-1: en, de, fr … */
  languages?: string[];
  openAccess?: boolean | null;
}

/** A term in the Boolean tree; `not` leaves out what it finds. */
export interface QTerm extends QueryTerm {
  type: "term";
  not?: boolean;
}
/** A group: its items combined with AND or OR; `not` negates the whole group. */
export interface QGroup {
  type: "group";
  id: string;
  op: "and" | "or";
  items: QNode[];
  not?: boolean;
  /** A name for the idea it stands for ("Population"). */
  label?: string;
}
export type QNode = QTerm | QGroup;

/** The search: a Boolean tree (crates/key-connectors boolean.rs) and limits. `concepts` and
 *  `exclude` are the older form (an AND of OR groups), still read from saved searches. */
export interface DbQuery {
  expr: QGroup;
  filters: QueryFilters;
  concepts?: Concept[];
  exclude?: QueryTerm[];
}

/** A problem in the text mode, at characters start..end. */
export interface TextProblem {
  message: string;
  start: number;
  end: number;
}
export type ParsedText = { ok: true; tree: QGroup; text: string; notes: TextProblem[] } | { ok: false; error: TextProblem };

export const DOC_TYPES: [string, string][] = [
  ["article", "Journal article"],
  ["review", "Review"],
  ["preprint", "Preprint"],
  ["working-paper", "Working paper"],
  ["report", "Report"],
  ["book", "Book"],
  ["chapter", "Book chapter"],
  ["thesis", "Thesis"],
  ["trial", "Trial registration"],
  ["dataset", "Dataset"],
];
export const LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["de", "German"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["zh", "Chinese"],
  ["ja", "Japanese"],
];

// ── Connectors ───────────────────────────────────────────────────────────────────────

export interface ConnectorSupport {
  fields: TermField[];
  phrase: boolean;
  truncation: boolean;
  proximity: boolean;
  dates: "none" | "year" | "day";
  /** The filters it applies: types, languages, openAccess. */
  filters: string[];
  maxResults: number;
  sort: string[];
}
export interface ConnectorCredential {
  id: string;
  label: string;
  required: boolean;
  secret: string;
  help?: string;
  url?: string;
  present: boolean;
}
export interface DbConnector {
  id: string;
  name: string;
  description: string;
  /** health, multidisciplinary, preprints, economics, grey, trials … */
  category: string;
  /** One line on what it covers. */
  coverage: string;
  terms?: string;
  homepage: string;
  version: string;
  kind: "api" | "harvest" | "manual";
  credentials: ConnectorCredential[];
  /** A required credential is missing. */
  needsKey: boolean;
  hasKey: boolean;
  /** No API: Key translates the query and opens the database's own search in the browser. */
  manual: boolean;
  manualInfo?: { url: string; steps: string[]; exportFormats: string[] };
  options: { id: string; label: string; default: string; choices: { value: string; label: string }[] }[];
  supports: ConnectorSupport;
  health: { state: "ok" | "unknown" | "failing" | "outdated"; failures: number; lastError?: string; lastOkAt?: number; lastFailAt?: number };
  /** When this connector version was activated (ms). */
  updatedAt?: number;
  origin?: "baseline" | "update";
}

export const CATEGORY_LABEL: Record<string, string> = {
  biomedical: "Health & life sciences",
  health: "Health & life sciences",
  "social-science": "Social sciences",
  "grey-literature": "Grey literature",
  registries: "Trials & registries",
  multidisciplinary: "Multidisciplinary",
  preprints: "Preprints",
  economics: "Economics & policy",
  grey: "Grey literature",
  trials: "Trials & registries",
  other: "Other",
};
export const CATEGORY_ORDER = ["biomedical", "health", "multidisciplinary", "preprints", "economics", "social-science", "grey-literature", "grey", "registries", "trials", "other"];

// ── Translation, counts, runs ────────────────────────────────────────────────────────

export interface Translation {
  connector: string;
  /** What the database is sent (an override replaces it verbatim). */
  native: string;
  /** Split where the database limits a query's length. */
  chunks: string[];
  mode: "native" | "terms" | "harvest";
  /** What it could not express ("Web of Science ignores proximity here"). */
  warnings: string[];
  length: number;
  maxLength?: number;
  /** Manual connectors: their own search page with the query filled in. */
  manualUrl?: string;
  strategy?: Strategy;
}

/** How a search is run on one database (crates/key-connectors plan.rs). */
export interface Strategy {
  original: string;
  /** single: one query; split: one per AND-combination; terms: one term at a time; harvest. */
  kind: "single" | "split" | "terms" | "harvest" | "typed" | "";
  subqueries: { native: string; neutral: string; verified: string[]; exact: boolean }[];
  /** Key checks the full search on the records returned. */
  postFilter: boolean;
  keepUnknown?: boolean;
  steps: string[];
  approximate: string[];
  decision?: { kind: "tooMany" | "tooBroad" | "nothing"; message: string; queries: number };
}

export interface Estimate {
  connector: string;
  total?: number | null;
  /** Each concept alone, in order (to spot the one that loses most). */
  perConcept?: (number | null)[];
  exact: boolean;
  error?: string;
}

export type ConnectorRunState = "queued" | "running" | "waiting" | "done" | "failed" | "cancelled" | "skipped";
export interface Progress {
  connector: string;
  state: ConnectorRunState;
  fetched: number;
  total?: number | null;
  /** Waiting for the database's rate limit, this long (ms). */
  waitMs?: number;
  error?: string;
  native: string;
  chunks: number;
  hasMore: boolean;
  requests: number;
  warnings?: string[];
  /** Ruled out by Key's check of the full search; kept though not fully checkable; found again by a later query. */
  rejected?: number;
  unverified?: number;
  repeats?: number;
  strategy?: Strategy;
}

/** One work found, in the web-search result shape (inbox_save takes it as is). */
export interface DbRecord {
  key: string;
  provider: string;
  providerId: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  abstract?: string;
  doi?: string;
  ids: { openalex?: string; pmid?: string; pmcid?: string; arxiv?: string };
  landingUrl?: string;
  pdfUrl?: string;
  /** The web-search kind (article, preprint, report …). */
  type?: string;
  /** The database's own kind (working-paper, trial …). */
  recordType?: string;
  date?: string;
  series?: string;
  number?: string;
  publisher?: string;
  language?: string;
  keywords?: string[];
  /** Every database that returned it. */
  foundBy: string[];
  provenance: { connector: string; version: string; sourceId: string; query: string; at: number; rank: number }[];
  /** Records merged into this one. */
  duplicates: number;
  /** The library source id, when the work is in the library already. */
  inLibrary?: string;
  /** A saved search's re-run: not found by the run before. */
  isNew?: boolean;
}

export interface RunPage {
  runId: string;
  state: "running" | "done" | "cancelled" | "failed";
  progress: Progress[];
  records: DbRecord[];
  /** Records after de-duplication, and fetched before it. */
  total: number;
  fetched: number;
  duplicatesRemoved: number;
  startedAt: number;
  finishedAt?: number;
}

export interface AddResult {
  added: number;
  existed: number;
  results: { key: string; sourceId?: string; existed: boolean; error?: string }[];
}

export interface SavedSearch {
  id: string;
  name: string;
  query: DbQuery;
  connectors: string[];
  overrides: Record<string, string>;
  options?: Record<string, Record<string, string>>;
  createdAt: number;
  lastRunAt?: number;
  lastRunId?: string;
  lastCount?: number;
  /** Works found by the last run that the one before did not find. */
  newCount?: number;
}

export interface RunSummary {
  runId: string;
  label: string;
  startedAt: number;
  finishedAt?: number;
  state: string;
  total: number;
  perConnector: Record<string, number>;
}

export interface ReportFile {
  filename: string;
  content: string;
  mime: string;
}

export interface ParsedQuery {
  query?: DbQuery;
  warnings?: string[];
  /** Could not be read into blocks: kept as the connector's own query. */
  raw?: string;
  error?: string;
}

export interface TermSuggestion {
  text: string;
  /** library: your tags and topics; mesh: PubMed's subject headings. */
  from: "library" | "mesh";
  field?: TermField;
  count?: number;
}

export interface DbSearchApi {
  readonly isMock: boolean;
  connectors(): Promise<DbConnector[]>;
  translate(query: DbQuery, connectors: string[], overrides?: Record<string, string>): Promise<Translation[]>;
  /** Cancelled with `cancelEstimate(requestId)` when the query changes. */
  estimate(query: DbQuery, connectors: string[], requestId: string): Promise<Estimate[]>;
  cancelEstimate(requestId: string): Promise<void>;
  /** `allow`: databases whose plan asked for an OK (many queries) that the user gave. */
  start(request: { query: DbQuery; connectors: string[]; overrides: Record<string, string>; label?: string; savedId?: string; allow?: string[] }): Promise<{ runId: string }>;
  results(runId: string, options: { dedupe: boolean; offset: number; limit: number; connector?: string }): Promise<RunPage>;
  cancel(runId: string): Promise<void>;
  /** Fetches further pages for the databases that have more (also carries on a cancelled run). */
  more(runId: string): Promise<void>;
  record(runId: string, key: string): Promise<{ record: DbRecord; versions: DbRecord[] }>;
  addToLibrary(runId: string, keys: string[], options: { collectionId?: string; tag?: string }): Promise<AddResult>;
  parse(text: string, dialect: "auto" | "pubmed" | "scopus" | "wos"): Promise<ParsedQuery>;
  /** The text mode: Key's Boolean syntax into a tree, or the problem and where it is. */
  parseText(text: string): Promise<ParsedText>;
  formatTree(tree: QGroup): Promise<string>;
  /** The search strategy of a run, or of a search not run yet (the plan only). */
  strategy(from: { runId: string } | { query: DbQuery; connectors: string[]; overrides?: Record<string, string>; label?: string }, format: "markdown" | "text" | "json" | "csv"): Promise<ReportFile>;
  /** MeSH headings, where the host offers them; empty otherwise. */
  suggest(text: string, connectors: string[]): Promise<TermSuggestion[]>;
  saved(): Promise<SavedSearch[]>;
  save(search: { id?: string; name: string; query: DbQuery; connectors: string[]; overrides?: Record<string, string> }): Promise<SavedSearch>;
  removeSaved(id: string): Promise<void>;
  runSaved(id: string): Promise<{ runId: string }>;
  runs(limit?: number): Promise<RunSummary[]>;
  report(runId: string, format: "json" | "csv" | "markdown"): Promise<ReportFile>;
  reportProblem(connector: string, error?: string): Promise<{ url: string }>;
  checkUpdates(): Promise<{ state: string; changed: string[]; error?: string }>;
}

// ── The host's implementation ────────────────────────────────────────────────────────

function hostApi(invoke: Invoke, workspaceId: string): DbSearchApi {
  const call = <T>(command: string, args: Record<string, unknown> = {}) => invoke<T>(command, args, workspaceId);
  return {
    isMock: false,
    connectors: () => call("db_connectors"),
    translate: (query, connectors, overrides) => call("db_translate", { query, connectors, overrides }),
    estimate: (query, connectors, requestId) => call("db_estimate", { query, connectors, perConcept: true, requestId }),
    cancelEstimate: (requestId) => call<void>("db_estimate_cancel", { requestId }).catch(() => {}),
    start: ({ label, ...request }) => call("db_search_start", { ...request, label }),
    results: (runId, options) => call("db_results", { runId, ...options }),
    cancel: (runId) => call("db_search_cancel", { runId }),
    more: (runId) => call("db_search_more", { runId }),
    record: (runId, key) => call("db_record", { runId, key }),
    addToLibrary: (runId, keys, { collectionId, tag }) => call("db_add_to_library", { runId, keys, collectionId, tag }),
    parse: (text, dialect) => call("db_parse", { text, dialect }),
    // Untagged words are the builder's usual field, title and abstract.
    parseText: (text) => call("db_query_parse", { text, defaultField: "title_abstract" }),
    formatTree: (tree) => call<{ text: string }>("db_query_format", { tree, defaultField: "title_abstract" }).then((r) => r.text),
    strategy: (from, format) => call("db_strategy", { ...from, format }),
    suggest: (text, connectors) => call<TermSuggestion[]>("db_suggest_terms", { text, connectors }).catch(() => []),
    saved: () => call("db_saved_list"),
    save: (search) => call("db_saved_save", search),
    removeSaved: (id) => call("db_saved_delete", { id }),
    runSaved: (id) => call("db_saved_run", { id }),
    runs: (limit) => call("db_runs", { limit }),
    report: (runId, format) => call("db_report", { runId, format }),
    reportProblem: (connector, error) => call("db_report_problem", { connector, error }),
    checkUpdates: () => call("db_connectors_check", { force: true }),
  };
}

const mockWanted = () => !!(window as unknown as { key?: { dbSearchMock?: boolean } }).key?.dbSearchMock;
const apis = new Map<string, Promise<DbSearchApi>>();

/** The workspace's database search: the host's, or sample data where the host has none. */
export function dbSearchApi(invoke: Invoke, workspaceId: string): Promise<DbSearchApi> {
  let api = apis.get(workspaceId);
  if (!api) {
    api = (mockWanted() ? Promise.resolve(false) : invoke("db_connectors", {}, workspaceId).then(() => true, () => false)).then(async (has) =>
      has ? hostApi(invoke, workspaceId) : (await import("./db-search-mock")).mockDbSearchApi(invoke, workspaceId),
    );
    apis.set(workspaceId, api);
  }
  return api;
}

// ── Library side: Inbox and tags (owned by other modules' host commands) ─────────────

export type LibraryState = { state: "none" | "inbox" | "library"; itemId?: string; sourceId?: string };

/** inbox_state for records; unknown where the Inbox module is missing. */
export function inboxStates(invoke: Invoke, workspaceId: string, records: DbRecord[]): Promise<LibraryState[]> {
  if (!records.length) return Promise.resolve([]);
  return invoke<LibraryState[]>("inbox_state", { works: records }, workspaceId).catch(() => records.map((r) => ({ state: r.inLibrary ? "library" : "none", sourceId: r.inLibrary }) as LibraryState));
}

/** Saves records to the Inbox (inbox_save), each with where it came from. */
export async function saveToInbox(invoke: Invoke, workspaceId: string, records: DbRecord[], label: string, query?: string) {
  let saved = 0;
  let existed = 0;
  const states: LibraryState[] = [];
  let viaCollection: string | undefined;
  for (const work of records) {
    type Saved = { state: "inbox" | "library"; itemId?: string; sourceId?: string; existed: boolean };
    const out: Saved = viaCollection
      ? await toInboxCollection(invoke, workspaceId, work, viaCollection)
      : await invoke<{ state: "inbox" | "library"; itemId?: string; sourceId?: string; existed: boolean }>("inbox_save", { work, origin: { kind: "database", label, query, url: work.landingUrl } }, workspaceId).catch(async (error) => {
          // A library without the Inbox module (older host): the Inbox collection instead.
          if (!/inbox_save|unknown|not found|unsupported/i.test(String(error))) throw error;
          viaCollection = await inboxCollection(invoke, workspaceId);
          return toInboxCollection(invoke, workspaceId, work, viaCollection);
        });
    states.push({ state: out.state, itemId: out.itemId, sourceId: out.sourceId });
    if (out.existed) existed++;
    else saved++;
  }
  return { saved, existed, states };
}

async function toInboxCollection(invoke: Invoke, workspaceId: string, work: DbRecord, collectionId: string): Promise<{ state: "inbox" | "library"; sourceId?: string; existed: boolean }> {
  const known = await invoke<{ sourceId: string; certain: boolean }[]>("store_match_identifiers", { works: [{ key: work.key, doi: work.doi, title: work.title, year: work.year }] }, workspaceId).catch(() => []);
  const existing = known.find((m) => m.certain);
  if (existing) return { state: "library" as const, sourceId: existing.sourceId, existed: true };
  const source = await invoke<{ id: string }>(
    "store_create",
    {
      source: {
        kind: "reference",
        itemType: "article",
        title: work.title,
        ...(work.doi ? { doi: work.doi } : {}),
        ...(work.year ? { year: work.year } : {}),
        ...(work.venue ? { containerTitle: work.venue } : {}),
        ...(work.landingUrl ? { url: work.landingUrl } : {}),
        creators: work.authors.map((name) => ({ literal: name, role: "author" })),
        collections: [collectionId],
        indexStatus: "skipped",
      },
    },
    workspaceId,
  );
  return { state: "inbox" as const, sourceId: source.id, existed: false };
}
