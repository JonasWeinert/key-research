# Database search host commands

The per-workspace Rust host (`key-desktop-host`, module `connectors/`) answers these. All take and
return JSON (camelCase). The engine is `crates/key-connectors`; specs are described in `SPEC.md`.

Priority classes (`crates/key-desktop-host/src/priority.rs`): `db_search_start`, `db_search_more`,
`db_estimate`, `db_connectors_check`, `db_saved_run` are slow (network). `db_search_cancel` and
`db_estimate_cancel` are answered at once. Reads (`db_results`, `db_connectors`, `db_translate`,
`db_saved_list`, `db_record`) are quick. A run started by the user is foreground; a saved-search
re-run passed `"background": true` (a schedule) runs in the background class and yields to the user.

## Shapes

`Query` (the neutral query, from the builder):

```ts
type Field = "all" | "title" | "title_abstract" | "abstract" | "keywords" | "subject" | "fulltext"
  | "author" | "journal" | "affiliation" | "identifier";
type Term = { id?: string; text: string; mode?: "phrase" | "words"; truncate?: boolean;
              field?: Field; proximity?: number | null };
type Query = { concepts: { id?: string; label?: string; terms: Term[] }[];  // AND of ORs
               exclude?: Term[];                                             // NOT
               filters?: { yearFrom?: number; yearTo?: number; types?: string[];
                           languages?: string[]; openAccess?: boolean | null } };
```

`DbRecord` is the web search `WebResult` shape (so `inbox_save` and `web_add_to_library` accept
it unchanged) plus database fields:

```ts
type DbRecord = {
  key: string;                 // stable within a run: the merged work's key
  provider: string;            // first connector that found it
  providerId: string;          // its id there (PMID, DOI, OAI identifier, ...)
  title: string; authors: string[]; year?: number; venue?: string; abstract?: string;
  doi?: string; ids: { pmid?: string; pmcid?: string; arxiv?: string; openalex?: string };
  landingUrl?: string; pdfUrl?: string; type?: string;
  // database search only
  date?: string; series?: string; number?: string; publisher?: string; language?: string;
  keywords?: string[]; handle?: string; isbn?: string; issn?: string;
  extras?: Record<string, string>;
  foundBy: string[];           // every connector that returned it
  provenance: { connector: string; version: string; sourceId: string; query: string;
                at: number /* ms */; rank: number }[];
  duplicates: number;          // records merged into this one
  inLibrary?: string;          // the library source id, when the work is already there
  isNew?: boolean;             // saved-search re-run: not in the previous run
};
```

`ConnectorInfo`:

```ts
type ConnectorInfo = {
  id: string; name: string; description: string; category: string; coverage: string;
  terms: string; homepage: string; version: string; kind: "api" | "harvest" | "manual";
  credentials: { id: string; label: string; required: boolean; secret: string; help?: string;
                 url?: string; present: boolean }[];
  needsKey: boolean;           // a required credential is missing
  hasKey: boolean;             // every credential it can use is present
  manual: boolean;             // kind === "manual" (see `manualInfo`)
  manualInfo?: { url: string; steps: string[]; exportFormats: string[] };
  options: { id: string; label: string; default: string; choices: { value: string; label: string }[] }[];
  supports: { fields: Field[]; phrase: boolean; truncation: boolean; proximity: boolean;
              dates: "none" | "year" | "day"; filters: string[]; maxResults: number; sort: string[] };
  health: { state: "ok" | "unknown" | "failing" | "outdated"; failures: number;
            lastError?: string; lastOkAt?: number; lastFailAt?: number };
  updatedAt?: number;          // when this connector version was activated (ms)
  origin: "baseline" | "update";
};
```

## Commands

| command | args | answer |
| --- | --- | --- |
| `db_options` | `{ keys?: { [secret]: string \| null }, mailto?: string, updateUrl?: string, connectorsDir?: string, autoCheck?: boolean }` | `true`. Electron main pushes secrets here (same pattern as `web_options`); the host never reads the keychain. `connectorsDir` is the app-wide folder for downloaded bundles (default `<workspace>/.key/connectors`). |
| `db_connectors` | `{}` | `ConnectorInfo[]` |
| `db_connectors_status` | `{}` | `{ sequence: number, created: string, origin: "baseline" \| "update", activatedAt?: number, lastCheckAt?: number, lastResult?: string, lastError?: string, updatesConfigured: boolean, updateUrl: string }` |
| `db_connectors_check` | `{ force?: boolean }` | `{ state: "updated" \| "current" \| "skipped" \| "failed" \| "unconfigured", sequence: number, changed: string[], error?: string }`. Without `force` at most once a day. Verifies signature, hashes, schema and engine version before switching atomically; keeps the previous bundle for rollback. |
| `db_translate` | `{ query: Query, connectors: string[], overrides?: { [connector]: string }, options?: { [connector]: { [opt]: string } } }` | `{ connector, native: string, chunks: string[], mode: "native" \| "terms" \| "harvest", warnings: string[], length: number, maxLength?: number }[]`. `native` is what the service is sent (an override replaces it verbatim). |
| `db_estimate` | `{ query, connectors, overrides?, options?, perConcept?: boolean, requestId?: string }` | `{ connector, total?: number, perConcept?: (number \| null)[], exact: boolean, error?: string }[]`. Harvest connectors answer `total` = records in scope, `exact: false`. |
| `db_estimate_cancel` | `{ requestId }` | `true` (immediate) |
| `db_search_start` | `{ query, connectors, overrides?, options?, limit?: number /* per connector, default 500, max 10000 */, label?: string, savedId?: string, background?: boolean }` | `{ runId: string }`. The run continues in the host; poll `db_results`. |
| `db_results` | `{ runId, dedupe?: boolean /* default true */, offset?: number, limit?: number /* default 100 */, connector?: string }` | `{ runId, state: "running" \| "done" \| "cancelled" \| "failed", progress: Progress[], records: DbRecord[], total: number /* records after dedupe */, fetched: number /* before */, duplicatesRemoved: number, startedAt: number, finishedAt?: number }` |
| `db_search_cancel` | `{ runId }` | `true` (immediate) |
| `db_search_more` | `{ runId, connector?: string, limit?: number }` | `{ runId }`: continues fetching (next pages) for connectors that have more |
| `db_record` | `{ runId, key }` | `DbRecord` with every source's own version: `{ record, versions: DbRecord[] }` |
| `db_add_to_library` | `{ runId, keys: string[], collectionId?: string, lookup?: boolean }` | `{ added: number, existed: number, results: { key, sourceId?, existed, error? }[] }` (uses the web search add path) |
| `db_saved_list` | `{}` | `{ id, name, query, connectors, overrides, options, createdAt, lastRunAt?, lastRunId?, lastCount?, newCount? }[]` |
| `db_saved_save` | `{ id?, name, query, connectors, overrides?, options? }` | the saved search |
| `db_saved_delete` | `{ id }` | `true` |
| `db_saved_run` | `{ id, background?: boolean }` | `{ runId }`; records not in the previous run of this search have `isNew: true` |
| `db_report` | `{ runId, format: "json" \| "csv" }` | `{ filename: string, content: string, mime: string }`: the run log (PRISMA-style: query per connector, native strings, timestamps, counts per source, duplicates removed, records with provenance) |
| `db_runs` | `{ limit? }` | recent runs `{ runId, label, startedAt, finishedAt, state, total, perConnector: { [id]: number } }[]` (kept on disk per workspace) |
| `db_report_problem` | `{ connector, error?: string }` | `{ url }`: a GitHub "new issue" URL prefilled with the connector id, version, engine version and the error text; nothing is sent. The app opens it in the browser only when the user clicks. |
| `db_parse` | `{ text, dialect: "pubmed" \| "scopus" \| "wos" \| "auto" }` | `{ query: Query, warnings: string[] }` or `{ raw: string, error: string }` when it cannot be read as blocks |

`Progress`:

```ts
type Progress = { connector: string; state: "queued" | "running" | "waiting" | "done" | "failed"
  | "cancelled" | "skipped"; fetched: number; total?: number; waitMs?: number; error?: string;
  native: string; chunks: number; hasMore: boolean; requests: number };
```

Errors are plain-language strings (the command fails) for bad arguments; per-connector failures
are reported in `progress[].error` and never fail the whole run.

Inbox: use `inbox_save { work: DbRecord, origin: { kind: "database", label, query, sourceId, url } }`
and `inbox_state { works }` (owned by the Inbox module); `DbRecord` is a valid `work`.

## Also available

- `db_report` also takes `format: "markdown"` (a table of sources, queries as sent and counts).
- `db_add_to_library` also takes `tag` (added to every added or existing source) and `lookup`.
- `db_results` with `limit: 0` answers progress and counts only (cheap to poll); `total` is the
  de-duplicated count, `listed` the count for the current `dedupe`/`connector` view.
- `db_recall { runId, seeds: [{ doi?, title? }] }` -> `{ seeds: [{ found, foundBy, matchedKey }],
  found, of, perConnector }`: does the search find these known papers?
- `db_connectors_rollback {}`: back to the previous downloaded bundle.
- `db_translate` entries of manual connectors carry `manualUrl` (the source's search page with
  the query filled in). `ConnectorInfo` carries `guide`, `options` (`free`, `pattern`) and
  `supports.mode`.
- Records: `authors` are display names ("Ann Lee"); `type` is web search's kind (report,
  article, preprint …), `recordType` the connector's (working-paper, trial …).
- `Progress` also carries `raw` (items before Key's own filter), `quotaRemaining`, `undated`,
  `warnings` (for example why nothing was found), `errorKind`, `startedAt`, `finishedAt`.
- Secrets pushed with `db_options.keys` by service id: `ncbi`, `elsevier`, `elsevier-insttoken`,
  `clarivate-wos`, `clarivate-wos-expanded`, `openalex`.
- `db_suggest_terms` answers `[]` for now.

## Boolean search, plans and the search strategy

- `Query.expr` is the Boolean tree (`key_connectors::boolean::Node`): `{ type: "group", op: "and" |
  "or", items: Node[], not?: true, label? }` or `{ type: "term", text, mode: "words" | "phrase",
  truncate, field, proximity?, not?: true }`. When present it is the search; `concepts`/`exclude`
  are the older form (still read). Fields: `all`, `title`, `abstract`, `title_abstract`,
  `keywords`, `subject`, `author`, `journal`, `affiliation`, `fulltext`, `identifier`, `year`
  (text `2015-2024`), `type`, `language`.
- `db_query_parse { text }` -> `{ ok: true, tree, text /* canonical */, notes: {message, start,
  end}[] }` or `{ ok: false, error: { message, start, end } }` (character offsets of the problem).
  Syntax: `(health OR doctor) AND ((AI OR ML) NOT regression)`, `"exact phrase"`, `word*`,
  `"hand washing"~3`, field tags `title:`, `abstract:`, `tiab:`, `keywords:`, `mesh:`, `author:`,
  `journal:`, `year:`, `type:`, `lang:` (or a suffix `word[ti]`); AND binds before OR.
- `db_query_format { tree }` -> `{ text }`.
- `db_translate` entries carry `strategy`: `{ original, kind: "single" | "split" | "terms" |
  "harvest", subqueries: { native, neutral, verified, exact }[], postFilter, keepUnknown, steps:
  string[], approximate: string[], decision?: { kind: "tooMany" | "nothing", message, queries } }`.
  `Progress` carries the same `strategy` plus `rejected`, `unverified`, `repeats`.
- `db_search_start` takes `allow: string[]`: connectors whose `decision` the user accepted (others
  with a decision are skipped with its message).
- `db_strategy { runId } | { query, connectors, options?, overrides?, label? }, format: "markdown" |
  "text" | "json" | "csv"` -> `{ filename, content, mime }`: per database the exact strings sent,
  when, reported/read/kept per query, the reconstruction steps, approximate notes, de-duplication
  counts. The JSON (`format: "key-search-strategy"`) has `rerun: { query, connectors, options,
  overrides }` to run it again.
- `db_run { runId }` -> the whole `RunReport` (live or from disk): `sources[]` with `strategy`,
  `chunkTotals`, `chunkRaw`, `chunkKept`, `rejected`, `repeats`, `unverified`; `fetched`,
  `duplicatesRemoved`, `unique`, `records[]` with provenance; `rerun` (with `savedId`). `db_runs`
  lists runs (`savedId`, `fetched`, `duplicatesRemoved` too).

Environment (tests and smokes only): `KEY_CONNECTORS_MOCK` (a loopback base URL every request
goes to, as `/<host>/<path>`), `KEY_CONNECTORS_DEV_TRUST=1` (trust the public dev key),
`KEY_CONNECTORS_UPDATE_URL`, `KEY_CONNECTORS_DIR`, `KEY_CONNECTORS_NO_AUTO_CHECK`.

## Health and updates

A connector whose runs fail 3 times in a row (network failures excluded when every connector
fails at once) shows `health.state = "failing"`; when the failures are parse/HTTP 4xx errors it is
`"outdated"` ("may be out of date"). The UI offers "Check for updates" (`db_connectors_check
{force: true}`) and "Report problem" (`db_report_problem`, opens the browser only on click).
