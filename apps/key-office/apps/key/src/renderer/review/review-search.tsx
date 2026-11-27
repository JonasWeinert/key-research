// Sources › Searches: database searches run from inside the review. The query is built with
// Database search's own components (blocks or text, the database picker, how each database runs
// it and how much each would find: db-query-builder, db-picker, db-translations) and its host
// commands; it starts from the review question's parts. Running it imports the results straight
// into the review as a batch with its strategy and per-database counts (registers counted as
// registers), de-duplicated against what is there. Searches belong to the review: "Update
// search" runs one again and imports only records not already in the review, as a dated batch.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addConcept, addTerms, cleanQuery, describeQuery, emptyQuery, isEmptyQuery, makeTerm, readQuery, splitTerms, topParts } from "../db-query";
import { QueryBuilder } from "../db-query-builder";
import { QueryText } from "../db-query-text";
import { DatabasePicker, DatabaseStrip, readDefaultDatabases } from "../db-picker";
import { dbSearchApi, type DbConnector, type DbQuery, type DbSearchApi, type RunPage } from "../db-search-api";
import { TranslationsPanel, useQueryPreview } from "../db-translations";
import { countText } from "../db-ui";
import { Icon } from "../icons";
import { plural, type Protocol } from "./review-api";
import { Btn, errorText, formatDate } from "./review-ui";
import { reportText, notifyPossible } from "./review-sources";
import type { StageProps } from "./ReviewPage";
import "../db-search.css";
import "../db-boolean.css";

export interface ReviewSearch {
  id: string;
  name: string;
  query: DbQuery;
  connectors: string[];
  overrides: Record<string, string>;
  at?: number;
  runs?: { runId: string; at: number; batchId: string; added: number; known?: number; update: boolean }[];
}

/** The question's parts as concept blocks (population, intervention … each a block of terms). */
export function queryFromQuestion(question: Protocol["question"]): DbQuery {
  const order = question.framework === "spider" ? ["s", "pi", "d", "e", "r"] : question.framework === "peco" ? ["p", "e", "o"] : ["p", "i", "o"];
  let q = emptyQuery();
  let first = true;
  for (const key of order) {
    const text = question.parts?.[key]?.trim();
    if (!text) continue;
    const terms = splitTerms(text.replace(/\b(and|or)\b/gi, ",")).map((t) => makeTerm(t));
    if (!terms.length) continue;
    const head = q.expr.items[0];
    q = first && head?.type === "group" ? addTerms(q, head.id, terms) : addConcept(q, terms);
    first = false;
  }
  return q;
}

const newId = () => `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function Searches(props: StageProps) {
  const { summary } = props;
  const searches = (summary as unknown as { searches?: ReviewSearch[] }).searches ?? [];
  const [editing, setEditing] = useState<ReviewSearch | null>(searches.length ? null : { id: newId(), name: "", query: queryFromQuestion(summary.protocol.question), connectors: [], overrides: {} });
  if (editing) return <SearchBuilder {...props} search={editing} onDone={() => setEditing(null)} />;
  return (
    <div className="kx-rv-searches">
      <div className="kx-rv-section-head">
        <h2>Database searches</h2>
        <Btn primary icon="search" onClick={() => setEditing({ id: newId(), name: "", query: queryFromQuestion(summary.protocol.question), connectors: [], overrides: {} })}>
          New search
        </Btn>
      </div>
      <ul className="kx-rv-search-list">
        {searches.map((s) => (
          <SearchRow key={s.id} {...props} search={s} onEdit={() => setEditing(s)} />
        ))}
      </ul>
    </div>
  );
}

function SearchRow(props: StageProps & { search: ReviewSearch; onEdit: () => void }) {
  const { search: s, invoke, workspaceId } = props;
  const runs = s.runs ?? [];
  const last = runs.at(-1);
  const [running, setRunning] = useState<string>();
  const update = async () => {
    const api = await dbSearchApi(invoke, workspaceId);
    await runAndImport(props, api, s, true, setRunning);
  };
  return (
    <li className="kx-rv-search-row">
      <div>
        <strong>{s.name || "Search"}</strong>
        <small>{describeQuery(readQuery(s.query))}</small>
        <small>
          {plural(s.connectors.length, "database")} · {last ? `last run ${formatDate(last.at)}: ${plural(last.added, "new record")}${last.known ? `, ${last.known.toLocaleString()} already here` : ""}` : "not run yet"} · {plural(runs.length, "run")}
        </small>
      </div>
      {running ? (
        <span className="kx-rv-muted" role="status">
          {running}
        </span>
      ) : (
        <>
          <Btn small onClick={props.onEdit}>
            Edit
          </Btn>
          <Btn small primary icon="retry" onClick={() => void update().catch((e) => (setRunning(undefined), props.notify(errorText(e), "error")))} title="Runs the search again and imports only records not already in the review, as a new dated import">
            {runs.length ? "Update search" : "Run"}
          </Btn>
        </>
      )}
    </li>
  );
}

/** Runs a review search and imports what it found (an update: only what is new). */
async function runAndImport(props: StageProps, api: DbSearchApi, s: ReviewSearch, update: boolean, status: (text: string | undefined) => void) {
  const { api: review, viewer, notify, onChanged } = props;
  status("Starting…");
  const { runId } = await api.start({ query: cleanQuery(s.query), connectors: s.connectors, overrides: s.overrides, label: s.name });
  let page: RunPage | undefined;
  for (;;) {
    page = await api.results(runId, { dedupe: false, offset: 0, limit: 1 });
    const done = page.progress.filter((p) => !["running", "waiting", "queued"].includes(p.state)).length;
    status(`Searching ${done}/${page.progress.length} databases · ${countText(page.fetched)} found`);
    if (page.state !== "running") break;
    await new Promise((r) => setTimeout(r, 800));
  }
  if (page.state === "failed") throw Error("The search failed: see Database search for each database's error");
  status("Importing…");
  const { report } = await review.importDbRun(runId, { name: s.name || "Database search" }, viewer, undefined, { searchId: s.id, onlyNew: update && (s.runs?.length ?? 0) > 0 });
  status(undefined);
  notify(report.added ? reportText(report) : "Nothing new since the last run", report.added ? "ok" : undefined);
  if (report.added) notifyPossible(review, notify);
  onChanged();
}

function SearchBuilder(props: StageProps & { search: ReviewSearch; onDone: () => void }) {
  const { invoke, workspaceId, api: review, viewer, notify, onChanged } = props;
  const [api, setApi] = useState<DbSearchApi>();
  const [connectors, setConnectors] = useState<DbConnector[]>([]);
  const [search, setSearch] = useState<ReviewSearch>(() => ({ ...props.search, query: readQuery(props.search.query), connectors: props.search.connectors.length ? props.search.connectors : readDefaultDatabases(workspaceId) }));
  const [mode, setMode] = useState<"blocks" | "text">("blocks");
  const [picking, setPicking] = useState(false);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [running, setRunning] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void dbSearchApi(invoke, workspaceId).then(async (a) => {
      if (!live) return;
      setApi(a);
      const list = await a.connectors().catch(() => []);
      if (!live) return;
      setConnectors(list);
      setSearch((s) => ({ ...s, connectors: s.connectors.filter((id) => list.some((c) => c.id === id)) }));
    });
    return () => {
      live = false;
    };
  }, [invoke, workspaceId]);
  const setQuery = useCallback((q: DbQuery) => setSearch((s) => ({ ...s, query: q })), []);
  const chosen = useMemo(() => search.connectors.map((id) => connectors.find((c) => c.id === id)).filter((c): c is DbConnector => !!c), [search.connectors, connectors]);
  const preview = useQueryPreview(api, search.query, search.connectors, search.overrides);
  const countsFrom = chosen.find((c) => preview.estimates[c.id]?.perConcept?.length);
  const conceptCounts = useMemo(() => {
    const per = countsFrom ? preview.estimates[countsFrom.id]?.perConcept : undefined;
    return per ? topParts(search.query).map((_, i) => per[i] ?? null) : undefined;
  }, [countsFrom, preview.estimates, search.query]);
  const empty = isEmptyQuery(search.query);
  const runnable = !empty && chosen.some((c) => !c.manual && !(c.needsKey && !c.hasKey));
  const name = search.name.trim() || describeQuery(search.query).replace(/^Find works about /, "").replace(/\.$/, "").slice(0, 60);
  const save = async () => {
    const s = { ...search, name, query: cleanQuery(search.query) };
    await review.saveSearch(s, viewer);
    return s;
  };
  const started = useRef(false);
  const run = async () => {
    if (!api || started.current) return;
    started.current = true;
    setError("");
    try {
      const s = await save();
      await runAndImport(props, api, s, false, setRunning);
      props.onDone();
    } catch (e) {
      setError(errorText(e));
      setRunning(undefined);
    } finally {
      started.current = false;
    }
  };
  return (
    <div className="kx-rv-search-builder kx-db-page">
      <div className="kx-rv-section-head">
        <h2>Search databases</h2>
        <span className="kx-rv-muted">Starts from your question; the results are imported into this review, with the strategy and each database’s count.</span>
        <span className="kx-rv-spacer" />
        <Btn onClick={props.onDone}>Back</Btn>
      </div>
      <div className="kx-db-build">
        <div className="kx-db-build-main">
          <DatabaseStrip connectors={connectors} selected={search.connectors} onOpen={() => setPicking(true)} onRemove={(id) => setSearch((s) => ({ ...s, connectors: s.connectors.filter((c) => c !== id) }))} />
          <div className="kx-db-section-head">
            <h2>Search</h2>
            <span className="kx-spacer" />
            <div className="kx-rv-seg" role="radiogroup" aria-label="Edit the search as">
              {(["blocks", "text"] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
                  {m === "blocks" ? "Blocks" : "Text"}
                </button>
              ))}
            </div>
          </div>
          {mode === "text" && <QueryText api={api} query={search.query} onChange={setQuery} />}
          <QueryBuilder query={search.query} onChange={setQuery} connectors={chosen} conceptCounts={conceptCounts} countsFrom={countsFrom?.name} />
          <p className="kx-db-sentence" aria-live="polite">
            {describeQuery(search.query)}
          </p>
          <div className="kx-db-run-bar">
            <input className="kx-db-name" aria-label="Name of this search" placeholder="Name this search" value={search.name} onChange={(e) => setSearch((s) => ({ ...s, name: e.target.value }))} />
            <Btn disabled={empty} onClick={() => void save().then(() => (notify("Search saved with the review", "ok"), onChanged(), props.onDone())).catch((e) => setError(errorText(e)))}>
              <Icon name="bookmark" size={12} /> Save
            </Btn>
            <span className="kx-spacer" />
            {running ? (
              <span className="kx-rv-muted" role="status">
                {running}
              </span>
            ) : (
              <Btn primary icon="search" disabled={!runnable} onClick={() => void run()} title={!search.connectors.length ? "Choose databases first" : empty ? "Add a term first" : undefined}>
                Search and import
              </Btn>
            )}
          </div>
          {error && <p className="kx-inline-error">{error}</p>}
        </div>
        <TranslationsPanel
          connectors={chosen}
          query={search.query}
          preview={preview}
          overrides={search.overrides}
          onOverride={(id, native) =>
            setSearch((s) => {
              const next = { ...s.overrides };
              if (native === undefined) delete next[id];
              else next[id] = native;
              return { ...s, overrides: next };
            })
          }
          allowed={allowed}
          onAllow={(id, on) => setAllowed((a) => (on ? [...a.filter((x) => x !== id), id] : a.filter((x) => x !== id)))}
          onLeaveOut={(id) => setSearch((s) => ({ ...s, connectors: s.connectors.filter((c) => c !== id) }))}
        />
      </div>
      {picking && <DatabasePicker workspaceId={workspaceId} connectors={connectors} selected={search.connectors} onChange={(ids) => setSearch((s) => ({ ...s, connectors: ids }))} onClose={() => setPicking(false)} />}
    </div>
  );
}
