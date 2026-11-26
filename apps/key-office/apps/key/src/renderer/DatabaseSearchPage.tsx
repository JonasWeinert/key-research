// The Database search tab, for systematic searches: build a query from blocks, see how each
// chosen database will run it and how much each would find, run it, screen the de-duplicated
// results, save the search to run again, and export the report. The builder, the "how each
// database" panel and the results are components of their own (db-query-builder.tsx,
// db-translations.tsx, db-results.tsx) for other pages to embed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SegmentedTabs } from "@key-reader/ui/SegmentedTabs";
import { addConcept, addTerms, cleanQuery, describeQuery, emptyQuery, exportQuery, importQuery, isEmptyQuery, makeTerm, splitTerms, TEMPLATES } from "./db-query";
import { QueryBuilder } from "./db-query-builder";
import { DatabasePicker, DatabaseStrip, readDefaultDatabases } from "./db-picker";
import { ReportSheet } from "./db-report";
import { DbResults } from "./db-results";
import { dbSearchApi, type DbConnector, type DbQuery, type DbSearchApi, type RunPage, type SavedSearch, type TermSuggestion } from "./db-search-api";
import { onPendingDatabaseText, takePendingDatabaseText } from "./db-search-entry";
import { TranslationsPanel, useQueryPreview } from "./db-translations";
import { countText, downloadText, plural, Popover } from "./db-ui";
import { EmptyState, Explain, Hint } from "./explain";
import { Icon } from "./icons";
import { toast } from "./item-actions";
import type { Invoke } from "./library-api";
import { useStatusItems } from "./status-bar";
import type { TagIndex } from "./tag-analysis";
import { openWebLink } from "./web-search";
import "./db-search.css";

type View = "build" | "results" | "saved";
const draftKey = (ws: string) => `key.dbSearch.draft:${ws}`;
interface Draft {
  query: DbQuery;
  connectors: string[];
  overrides: Record<string, string>;
  name: string;
  savedId?: string;
}
function readDraft(workspaceId: string): Draft {
  try {
    const raw = localStorage.getItem(draftKey(workspaceId));
    if (raw) {
      const d = JSON.parse(raw) as Draft;
      if (d?.query?.concepts) return { ...d, overrides: d.overrides ?? {}, name: d.name ?? "" };
    }
  } catch {}
  return { query: emptyQuery(), connectors: readDefaultDatabases(workspaceId), overrides: {}, name: "" };
}
/** Words handed over from a search field: one term each when it is a list, else the phrase. */
function withText(draft: Draft, text: string): Draft {
  const terms = splitTerms(text).map((t) => makeTerm(t));
  const first = draft.query.concepts[0];
  const query = isEmptyQuery(draft.query) && first ? addTerms(draft.query, first.id, terms) : addConcept(draft.query, terms);
  return { ...draft, query };
}
const dialectOf = (text: string) => (/\b(TITLE-ABS-KEY|TITLE|ABS|KEY|AUTH)\s*\(/.test(text) ? "scopus" : /\b(TS|TI|AB|AU)\s*=\s*\(/.test(text) ? "wos" : /\[[a-z /]+\]/i.test(text) ? "pubmed" : "auto");

export default function DatabaseSearchPage({ invoke, workspaceId, viewId, active }: { invoke: Invoke; workspaceId: string; viewId?: string; active: boolean }) {
  const [api, setApi] = useState<DbSearchApi>();
  const [connectors, setConnectors] = useState<DbConnector[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [draft, setDraftState] = useState<Draft>(() => {
    const base = readDraft(workspaceId);
    const text = takePendingDatabaseText(workspaceId);
    return text ? withText(base, text) : base;
  });
  const setDraft = useCallback(
    (change: (d: Draft) => Draft) =>
      setDraftState((d) => {
        const next = change(d);
        try {
          localStorage.setItem(draftKey(workspaceId), JSON.stringify(next));
        } catch {}
        return next;
      }),
    [workspaceId],
  );
  useEffect(() => onPendingDatabaseText(workspaceId, (text) => setDraft((d) => withText(d, text))), [workspaceId, setDraft]);
  const { query, overrides, name } = draft;
  const setQuery = useCallback((q: DbQuery) => setDraft((d) => ({ ...d, query: q })), [setDraft]);
  const [view, setView] = useState<View>("build");
  const [picking, setPicking] = useState(false);
  const [run, setRun] = useState<{ runId: string; label: string; query: DbQuery; connectors: string[] }>();
  const [runPage, setRunPage] = useState<RunPage>();
  const [reporting, setReporting] = useState(false);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [menu, setMenu] = useState<{ kind: "templates" | "more"; anchor: DOMRect }>();
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void dbSearchApi(invoke, workspaceId).then(async (a) => {
      if (!live) return;
      setApi(a);
      try {
        const list = await a.connectors();
        if (!live) return;
        setConnectors(list);
        setDraft((d) => ({ ...d, connectors: d.connectors.filter((id) => list.some((c) => c.id === id)) }));
        setSaved(await a.saved());
      } catch (e) {
        if (live) setLoadError(String((e as Error)?.message ?? e).replace(/^.*?Error: /, ""));
      }
    });
    return () => {
      live = false;
    };
  }, [invoke, workspaceId, setDraft]);
  const refreshSaved = useCallback(() => void api?.saved().then(setSaved, () => {}), [api]);

  const chosen = useMemo(() => draft.connectors.map((id) => connectors.find((c) => c.id === id)).filter((c): c is DbConnector => !!c), [draft.connectors, connectors]);
  const preview = useQueryPreview(api, query, draft.connectors, overrides);
  // Concept counts on the cards: from the first chosen database that answers them.
  const countsFrom = chosen.find((c) => preview.estimates[c.id]?.perConcept?.length);
  const conceptCounts = useMemo(() => {
    const per = countsFrom ? preview.estimates[countsFrom.id]?.perConcept : undefined;
    if (!per) return undefined;
    // perConcept follows the concepts that have terms; empty cards get no count.
    let at = 0;
    return query.concepts.map((c) => (c.terms.some((t) => t.text.trim()) ? (per[at++] ?? null) : undefined)) as (number | null)[];
  }, [countsFrom, preview.estimates, query.concepts]);

  // Synonyms from your own tags, and MeSH where the host offers it.
  const tags = useRef<Promise<{ name: string; count: number }[]>>(undefined);
  const suggest = useCallback(
    async (text: string): Promise<TermSuggestion[]> => {
      tags.current ??= invoke<TagIndex>("store_tag_index", {}, workspaceId).then((i) => i.tags, () => []);
      const q = text.toLowerCase();
      const [mine, mesh] = await Promise.all([tags.current, api ? api.suggest(text, draft.connectors) : Promise.resolve([])]);
      const fromLibrary = mine
        .filter((t) => t.name.toLowerCase().includes(q) && t.name.toLowerCase() !== q)
        .sort((a, b) => b.count - a.count)
        .slice(0, 4)
        .map((t): TermSuggestion => ({ text: t.name.split("/").pop() ?? t.name, from: "library", count: t.count }));
      return [...fromLibrary, ...mesh];
    },
    [api, invoke, workspaceId, draft.connectors],
  );

  const pasteQuery = useCallback(
    async (text: string) => {
      if (!api) return;
      const dialect = dialectOf(text);
      const before = draft;
      try {
        const parsed = await api.parse(text, dialect);
        if (parsed.query) {
          setDraft((d) => ({ ...d, query: { ...parsed.query!, filters: { ...d.query.filters, ...parsed.query!.filters } } }));
          toast(`Read the pasted query as ${plural(parsed.query.concepts.length, "concept")}${parsed.warnings?.length ? `. ${parsed.warnings[0]}` : ""}`, () => setDraft(() => before));
          return;
        }
        throw new Error(parsed.error);
      } catch (e) {
        // Kept as the matching database's own query, so nothing is lost.
        const target = chosen.find((c) => c.id === dialect) ?? chosen[0];
        if (!target) return toast("Choose a database first, to keep this query as its own");
        setDraft((d) => ({ ...d, overrides: { ...d.overrides, [target.id]: text } }));
        toast(`${String((e as Error)?.message || "Couldn’t read the query into blocks")} Kept as the ${target.name} query.`, () => setDraft(() => before));
      }
    },
    [api, chosen, draft, setDraft],
  );

  const start = async (from?: SavedSearch) => {
    if (!api) return;
    const label = from?.name ?? (name.trim() || describeQuery(query).replace(/^Find works about /, "").replace(/\.$/, "").slice(0, 80));
    try {
      const out = from ? await api.runSaved(from.id) : await api.start({ query: cleanQuery(query), connectors: draft.connectors, overrides, label, savedId: draft.savedId });
      setRun({ runId: out.runId, label, query: from?.query ?? cleanQuery(query), connectors: from?.connectors ?? draft.connectors });
      setRunPage(undefined);
      setView("results");
      if (from) refreshSaved();
    } catch (e) {
      toast(`Couldn’t start the search: ${String((e as Error)?.message ?? e).replace(/^.*?Error: /, "")}`);
    }
  };
  const save = async () => {
    if (!api) return;
    const label = name.trim() || describeQuery(query).replace(/^Find works about /, "").replace(/\.$/, "").slice(0, 60);
    const out = await api.save({ id: draft.savedId, name: label, query: cleanQuery(query), connectors: draft.connectors, overrides });
    setDraft((d) => ({ ...d, savedId: out.id, name: out.name }));
    refreshSaved();
    toast(draft.savedId ? `Updated “${out.name}”` : `Saved “${out.name}”`);
  };
  const load = (s: SavedSearch) => {
    setDraft(() => ({ query: s.query, connectors: s.connectors, overrides: s.overrides ?? {}, name: s.name, savedId: s.id }));
    setView("build");
  };

  // While a search runs, the status bar says so.
  const running = runPage?.state === "running";
  const fraction = runPage && runPage.progress.length ? runPage.progress.filter((p) => p.state !== "running" && p.state !== "waiting" && p.state !== "queued").length / runPage.progress.length : undefined;
  useStatusItems(
    viewId,
    runPage
      ? [
          running
            ? { id: "db-run", label: `Searching ${plural(runPage.progress.length, "database")} · ${countText(runPage.total)}`, progress: fraction, title: "Show the results", priority: 70 }
            : { id: "db-run", label: `${countText(runPage.total)} works found`, icon: "database", title: "Show the results", priority: 40 },
        ]
      : [],
    (id) => id === "db-run" && setView("results"),
  );

  const empty = isEmptyQuery(query);
  const runnable = !empty && chosen.some((c) => !c.manual && !(c.needsKey && !c.hasKey));
  const manualOnly = chosen.length > 0 && !runnable && !empty;
  const latest = saved.find((s) => s.id === draft.savedId);

  return (
    <section className="kx-db-page" aria-label="Database search" data-active={active || undefined}>
      <header className="kx-db-page-head">
        <div className="kx-db-title">
          <h1>Database search</h1>
          {api?.isMock && (
            <span className="kx-db-badge" data-tone="warning" title="This build's library has no database search engine yet: counts and works are made up">
              Sample data
            </span>
          )}
        </div>
        <SegmentedTabs
          label="Database search"
          size="small"
          value={view}
          onChange={setView}
          tabs={[
            { id: "build", label: "Query" },
            { id: "results", label: "Results", badge: runPage ? countText(runPage.total) : undefined },
            { id: "saved", label: "Saved", badge: saved.length || undefined },
          ]}
          className="kx-db-tabs"
        />
        <div className="kx-db-head-tools">
          <button type="button" className="kx-page-action" aria-haspopup="menu" onClick={(e) => setMenu({ kind: "templates", anchor: e.currentTarget.getBoundingClientRect() })}>
            <Icon name="sparkle" size={12} /> Examples
          </button>
          <button type="button" className="kx-db-icon-button" aria-label="More" aria-haspopup="menu" onClick={(e) => setMenu({ kind: "more", anchor: e.currentTarget.getBoundingClientRect() })}>
            <Icon name="more" size={14} />
          </button>
        </div>
      </header>
      {api?.isMock ? <Hint help="dbsearch.sample" className="kx-db-sample" /> : view === "build" && <Hint help="dbsearch.intro" className="kx-db-sample" />}
      {loadError && <p className="kx-inline-error">{loadError}</p>}

      {view === "build" && (
        <div className="kx-db-build">
          <div className="kx-db-build-main">
            <DatabaseStrip connectors={connectors} selected={draft.connectors} onOpen={() => setPicking(true)} onRemove={(id) => setDraft((d) => ({ ...d, connectors: d.connectors.filter((c) => c !== id) }))} />
            <div className="kx-db-section-head">
              <h2>Concepts</h2>
              <Explain help="dbsearch.concepts" />
              <span className="kx-db-muted">Every concept must match; any synonym within one may.</span>
            </div>
            <QueryBuilder query={query} onChange={setQuery} connectors={chosen} conceptCounts={conceptCounts} countsFrom={countsFrom?.name} suggest={suggest} onPasteQuery={(t) => void pasteQuery(t)} />
            <p className="kx-db-sentence" aria-live="polite">
              {describeQuery(query)}
            </p>
            <div className="kx-db-run-bar">
              <input className="kx-db-name" aria-label="Name of this search" placeholder="Name this search (optional)" value={name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              <button type="button" className="kx-page-action" disabled={empty || !draft.connectors.length} onClick={() => void save()}>
                <Icon name="bookmark" size={12} /> {draft.savedId ? "Update saved search" : "Save search"}
              </button>
              <span className="kx-spacer" />
              {manualOnly && <span className="kx-db-muted">Only manual databases chosen: open each from the panel.</span>}
              <button type="button" className="kx-page-action kx-page-action-primary kx-db-run" disabled={!runnable} onClick={() => void start()} title={!draft.connectors.length ? "Choose databases first" : empty ? "Add a term first" : undefined}>
                <Icon name="search" size={12} /> Search {chosen.filter((c) => !c.manual).length > 1 ? `${chosen.filter((c) => !c.manual && !(c.needsKey && !c.hasKey)).length} databases` : ""}
              </button>
            </div>
            {latest?.lastRunAt && (
              <p className="kx-db-muted">
                Last run {new Date(latest.lastRunAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}: {plural(latest.lastCount ?? 0, "work")}.
              </p>
            )}
          </div>
          <TranslationsPanel
            connectors={chosen}
            query={query}
            preview={preview}
            overrides={overrides}
            onOverride={(id, native) =>
              setDraft((d) => {
                const next = { ...d.overrides };
                if (native === undefined) delete next[id];
                else next[id] = native;
                return { ...d, overrides: next };
              })
            }
            onReportProblem={(c) => void api?.reportProblem(c.id, c.health.lastError).then((r) => openWebLink(r.url))}
          />
        </div>
      )}

      {view === "results" &&
        (run && api ? (
          <DbResults
            api={api}
            invoke={invoke}
            workspaceId={workspaceId}
            runId={run.runId}
            connectors={connectors}
            label={run.label}
            queryText={describeQuery(run.query)}
            onPage={setRunPage}
            onReport={() => setReporting(true)}
          />
        ) : (
          <EmptyState help="empty.dbsearch-results" icon="database" action={{ label: "Build a query", onClick: () => setView("build") }} />
        ))}

      {view === "saved" && (
        <div className="kx-db-saved">
          <div className="kx-db-section-head">
            <h2>Saved searches</h2>
            <Explain help="dbsearch.saved" />
          </div>
          {!saved.length ? (
            <EmptyState help="empty.dbsearch-saved" icon="bookmark" compact />
          ) : (
            <ul className="kx-db-saved-list">
              {saved.map((s) => (
                <li key={s.id}>
                  <button type="button" className="kx-db-saved-main" onClick={() => load(s)} title="Open in the query builder">
                    <span className="kx-db-saved-name">{s.name}</span>
                    <small>{describeQuery(s.query)}</small>
                    <small>
                      {plural(s.connectors.length, "database")} · {s.lastRunAt ? `last run ${new Date(s.lastRunAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}, ${plural(s.lastCount ?? 0, "work")}` : "never run"}
                    </small>
                  </button>
                  {!!s.newCount && <span className="kx-db-badge" data-tone="accent">{s.newCount} new since last run</span>}
                  <button type="button" className="kx-page-action" onClick={() => void start(s)}>
                    <Icon name="retry" size={12} /> Run again
                  </button>
                  <button
                    type="button"
                    className="kx-db-icon-button"
                    aria-label={`Delete ${s.name}`}
                    onClick={() => {
                      void api?.removeSaved(s.id).then(refreshSaved);
                      if (draft.savedId === s.id) setDraft((d) => ({ ...d, savedId: undefined }));
                    }}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {picking && <DatabasePicker workspaceId={workspaceId} connectors={connectors} selected={draft.connectors} onChange={(ids) => setDraft((d) => ({ ...d, connectors: ids }))} onClose={() => setPicking(false)} />}
      {reporting && run && runPage && api && <ReportSheet api={api} invoke={invoke} workspaceId={workspaceId} runId={run.runId} page={runPage} connectors={connectors} query={run.query} name={run.label} onClose={() => setReporting(false)} />}
      {menu?.kind === "templates" && (
        <Popover anchor={menu.anchor} label="Examples" width={320} onClose={() => setMenu(undefined)} className="kx-db-templates">
          <div className="kx-db-menu-label">Start from an example</div>
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                const before = draft;
                const ids = t.connectors.filter((id) => connectors.some((c) => c.id === id));
                setDraft((d) => ({ ...d, query: t.build(), connectors: ids.length ? ids : d.connectors, overrides: {}, name: "", savedId: undefined }));
                setMenu(undefined);
                setView("build");
                toast(`Example: ${t.title}`, () => setDraft(() => before));
              }}
            >
              <span className="kx-db-template">
                <b>{t.title}</b>
                <small>{t.about}</small>
              </span>
            </button>
          ))}
        </Popover>
      )}
      {menu?.kind === "more" && (
        <Popover anchor={menu.anchor} label="More" width={240} onClose={() => setMenu(undefined)}>
          <button type="button" onClick={() => (setMenu(undefined), file.current?.click())}>
            <Icon name="upload" size={12} /> Import query…
          </button>
          <button type="button" disabled={empty} onClick={() => (setMenu(undefined), downloadText(`${name.trim() || "Database query"}.json`, exportQuery(query, { name, connectors: draft.connectors, overrides }), "application/json"))}>
            <Icon name="download" size={12} /> Export query…
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(undefined);
              void navigator.clipboard.readText().then((t) => (t.trim() ? pasteQuery(t) : toast("The clipboard is empty")));
            }}
          >
            <Icon name="copy" size={12} /> Paste a PubMed or Scopus query
          </button>
          <hr />
          <button
            type="button"
            onClick={() => {
              setMenu(undefined);
              const before = draft;
              setDraft((d) => ({ ...d, query: emptyQuery(), overrides: {}, name: "", savedId: undefined }));
              toast("Started a new query", () => setDraft(() => before));
            }}
          >
            <Icon name="plus" size={12} /> New query
          </button>
          <button type="button" onClick={() => (setMenu(undefined), void api?.checkUpdates().then((r) => toast(r.state === "updated" ? `Updated ${plural(r.changed.length, "connector")}` : r.state === "failed" ? `Couldn’t check: ${r.error ?? "unknown error"}` : "Connectors are up to date")))}>
            <Icon name="sync" size={12} /> Check for connector updates
          </button>
        </Popover>
      )}
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          void f.text().then((text) => {
            try {
              const out = importQuery(text);
              setDraft((d) => ({ query: out.query, connectors: out.connectors?.filter((id) => connectors.some((c) => c.id === id)) ?? d.connectors, overrides: out.overrides ?? {}, name: out.name ?? "", savedId: undefined }));
              setView("build");
              toast(`Imported ${out.name ? `“${out.name}”` : "the query"}`);
            } catch (err) {
              toast(String((err as Error).message));
            }
          });
        }}
      />
    </section>
  );
}
