// A database search's results: progress per database while it runs, then the works found as a
// virtualised list of the shared source rows, de-duplicated (one row per work, with every
// database that found it) or per database; sorting and filters; a side preview with the
// abstract, links and where each copy came from; and many at once added to the library (to a
// collection, tagged with the search's name, PDFs looked for), to the Inbox or to a review.
// Reusable: it needs a run id and the API, nothing of the page around it.
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { DOC_TYPES, inboxStates, saveToInbox, type DbConnector, type DbRecord, type DbSearchApi, type LibraryState, type Progress, type RunPage } from "./db-search-api";
import { countText, plural } from "./db-ui";
import { Explain } from "./explain";
import { findPdfs } from "./find-pdf";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon } from "./icons";
import { toast } from "./item-actions";
import type { Collection, Invoke, Source } from "./library-api";
import { libraryChanged } from "./library-nav";
// Sample runs live only in this window, not on the host, so they cannot go to a review.
import { SendRunToReview } from "./review/review-entry";
import { SourceListItem, type ListWork } from "./source-list";
import { openWebLink } from "./web-search";

const POLL = 400;
const PAGE = 500;

export type ResultSort = "relevance" | "year-desc" | "year-asc" | "title" | "databases";
export interface ResultFilter {
  connectors: string[];
  yearFrom?: number;
  yearTo?: number;
  types: string[];
  hasAbstract: boolean;
  openAccess: boolean;
  hideInLibrary: boolean;
  onlyNew: boolean;
}
const NO_FILTER: ResultFilter = { connectors: [], types: [], hasAbstract: false, openAccess: false, hideInLibrary: false, onlyNew: false };

/** Follows a run: progress at once and often, records whenever more have arrived. */
export function useRun(api: DbSearchApi | undefined, runId: string | undefined, dedupe: boolean) {
  const [page, setPage] = useState<RunPage>();
  const [records, setRecords] = useState<DbRecord[]>([]);
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const loaded = useRef({ total: -1, at: 0, view: "" });
  useEffect(() => {
    setPage(undefined);
    setRecords([]);
    setError(undefined);
    loaded.current = { total: -1, at: 0, view: "" };
  }, [runId]);
  useEffect(() => {
    if (!api || !runId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const view = String(dedupe);
    const poll = async () => {
      try {
        const head = await api.results(runId, { dedupe, offset: 0, limit: 0 });
        if (!live) return;
        setPage(head);
        const done = head.state !== "running";
        const stale = head.total !== loaded.current.total || loaded.current.view !== view;
        // While running, the list catches up every second or so; at the end, all of it.
        if (stale && (done || Date.now() - loaded.current.at > 1200 || loaded.current.view !== view)) {
          const all: DbRecord[] = [];
          for (let offset = 0; offset < head.total; offset += PAGE) {
            const part = await api.results(runId, { dedupe, offset, limit: PAGE });
            if (!live) return;
            all.push(...part.records);
          }
          loaded.current = { total: head.total, at: Date.now(), view };
          setRecords(all);
        }
        if (!done || stale) timer = setTimeout(poll, done ? 0 : POLL);
      } catch (e) {
        if (live) setError(String((e as Error)?.message ?? e).replace(/^.*?Error: /, ""));
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, runId, dedupe, tick]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { page, records, error, refresh };
}

/** "Fetching 120 of 4,380" · "Waiting 2 s for PubMed's rate limit" · "Done: 500 of 4,380". */
export function progressText(p: Progress, name: string) {
  const of = p.total ? ` of ${countText(p.total)}` : "";
  switch (p.state) {
    case "queued":
      return "Waiting to start";
    case "running":
      return `Fetching ${countText(p.fetched)}${of}`;
    case "waiting":
      return `Pausing ${Math.max(1, Math.round((p.waitMs ?? 0) / 1000))} s: ${name} limits how fast it may be asked`;
    case "done":
      return `${countText(p.fetched)}${of}${p.hasMore ? " (more available)" : ""}`;
    case "failed":
      return p.error ? `Failed: ${p.error}` : "Failed";
    case "cancelled":
      return `Stopped at ${countText(p.fetched)}${of}`;
    case "skipped":
      return p.error ?? "Not searched";
  }
}

export function RunProgress({ page, connectors, onCancel, onMore }: { page: RunPage; connectors: DbConnector[]; onCancel: () => void; onMore: () => void }) {
  const name = (id: string) => connectors.find((c) => c.id === id)?.name ?? id;
  const running = page.state === "running";
  const more = page.progress.some((p) => p.hasMore || p.state === "cancelled");
  return (
    <section className="kx-db-progress" aria-label="Progress" data-state={page.state}>
      <ul>
        {page.progress.map((p) => {
          const fraction = p.state === "done" ? 1 : p.total ? Math.min(1, p.fetched / Math.min(p.total, Math.max(p.fetched, 500))) : 0;
          return (
            <li key={p.connector} data-state={p.state}>
              <span className="kx-db-progress-name">{name(p.connector)}</span>
              <span className="kx-db-progress-bar" aria-hidden="true">
                <span style={{ width: `${Math.round(fraction * 100)}%` }} />
              </span>
              <span className="kx-db-progress-text" role="status">
                {progressText(p, name(p.connector))}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="kx-db-progress-foot">
        <span>
          {running ? "Searching… " : page.state === "cancelled" ? "Stopped. " : page.state === "failed" ? "The search failed. " : "Done. "}
          {plural(page.fetched, "record")} fetched, {plural(page.duplicatesRemoved, "duplicate")} removed, {plural(page.total, "work")}.
        </span>
        <Explain help="dbsearch.progress" />
        <span className="kx-spacer" />
        {running ? (
          <button type="button" className="kx-page-action" onClick={onCancel}>
            Stop
          </button>
        ) : (
          more && (
            <button type="button" className="kx-page-action" onClick={onMore} title="Fetch further pages from the databases that have more">
              {page.state === "cancelled" ? "Resume" : "Fetch more"}
            </button>
          )
        )}
      </div>
    </section>
  );
}

/** The record's kind as the database names it (working paper, trial), else the general one. */
const kindOf = (r: DbRecord) => r.recordType ?? r.type;
const firstRank = (r: DbRecord) => Math.min(...r.provenance.map((p) => p.rank), 1e9);
function sortRecords(list: DbRecord[], sort: ResultSort) {
  const out = [...list];
  if (sort === "year-desc") out.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  else if (sort === "year-asc") out.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
  else if (sort === "title") out.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === "databases") out.sort((a, b) => b.foundBy.length - a.foundBy.length || firstRank(a) - firstRank(b));
  return out;
}

export interface DbResultsProps {
  api: DbSearchApi;
  invoke: Invoke;
  workspaceId: string;
  runId: string;
  connectors: DbConnector[];
  /** The search's name: the Inbox says where things came from, the optional tag. */
  label: string;
  /** The query in a line, for the Inbox's "Saved from". */
  queryText?: string;
  onPage?: (page: RunPage | undefined) => void;
  onReport?: () => void;
}

export function DbResults({ api, invoke, workspaceId, runId, connectors, label, queryText, onPage, onReport }: DbResultsProps) {
  const [dedupe, setDedupe] = useState(true);
  const { page, records, error, refresh } = useRun(api, runId, dedupe);
  useEffect(() => onPage?.(page), [page, onPage]);
  const [sort, setSort] = useState<ResultSort>("relevance");
  const [filter, setFilter] = useState<ResultFilter>(NO_FILTER);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState(-1);
  const [preview, setPreview] = useState<string>();
  const [states, setStates] = useState<Record<string, LibraryState>>({});
  const [adding, setAdding] = useState<string[]>();
  const [busy, setBusy] = useState<string>();
  const name = useCallback((id: string) => connectors.find((c) => c.id === id)?.name ?? id, [connectors]);
  useEffect(() => {
    setSelected(new Set());
    setPreview(undefined);
    setCurrent(-1);
    setFilter(NO_FILTER);
  }, [runId]);

  // In library / In Inbox, asked in batches once the records are in.
  const stateKey = `${runId}:${records.length}`;
  useEffect(() => {
    if (!records.length) return;
    let live = true;
    void (async () => {
      for (let at = 0; at < records.length && live; at += 200) {
        const part = records.slice(at, at + 200);
        const answer = await inboxStates(invoke, workspaceId, part);
        if (!live) return;
        setStates((s) => ({ ...s, ...Object.fromEntries(part.map((r, i) => [r.key, answer[i] ?? { state: r.inLibrary ? "library" : "none", sourceId: r.inLibrary }])) }));
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey, invoke, workspaceId]);
  const stateOf = (r: DbRecord): LibraryState => states[r.key] ?? { state: r.inLibrary ? "library" : "none", sourceId: r.inLibrary };

  const facets = useMemo(() => {
    const byConnector: Record<string, number> = {};
    const types: Record<string, number> = {};
    let min = Infinity;
    let max = -Infinity;
    for (const r of records) {
      for (const c of new Set(r.foundBy)) byConnector[c] = (byConnector[c] ?? 0) + 1;
      const kind = kindOf(r);
      if (kind) types[kind] = (types[kind] ?? 0) + 1;
      if (r.year) {
        min = Math.min(min, r.year);
        max = Math.max(max, r.year);
      }
    }
    return { byConnector, types, years: Number.isFinite(min) ? ([min, max] as const) : undefined };
  }, [records]);
  const shown = useMemo(() => {
    const f = filter;
    const list = records.filter(
      (r) =>
        (!f.connectors.length || r.foundBy.some((c) => f.connectors.includes(c))) &&
        (!f.yearFrom || (r.year ?? 0) >= f.yearFrom) &&
        (!f.yearTo || (r.year ?? 9999) <= f.yearTo) &&
        (!f.types.length || f.types.includes(kindOf(r) ?? "")) &&
        (!f.hasAbstract || !!r.abstract) &&
        (!f.openAccess || !!r.pdfUrl) &&
        (!f.onlyNew || !!r.isNew) &&
        (!f.hideInLibrary || (states[r.key]?.state ?? (r.inLibrary ? "library" : "none")) === "none"),
    );
    return sortRecords(list, sort);
  }, [records, filter, sort, states]);
  const anyNew = records.some((r) => r.isNew);

  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => 58, overscan: 8, getItemKey: (i) => `${shown[i]?.key}:${shown[i]?.provider}:${i}` });
  useEffect(() => {
    if (current >= 0) virtual.scrollToIndex(current, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  const previewed = preview ? records.find((r) => r.key === preview) : undefined;

  const toggle = (key: string, on?: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on ?? !next.has(key)) next.add(key);
      else next.delete(key);
      return next;
    });
  const allShownSelected = shown.length > 0 && shown.every((r) => selected.has(r.key));
  const chosen = () => records.filter((r, i, all) => selected.has(r.key) && all.findIndex((o) => o.key === r.key) === i);

  const addToInbox = async (list: DbRecord[]) => {
    setBusy("inbox");
    try {
      const out = await saveToInbox(invoke, workspaceId, list, label, queryText);
      setStates((s) => ({ ...s, ...Object.fromEntries(list.map((r, i) => [r.key, out.states[i]])) }));
      toast(`${out.saved ? `Added ${plural(out.saved, "work")} to the Inbox` : "Nothing new for the Inbox"}${out.existed ? `; ${out.existed} already there or in the library` : ""}`);
      setSelected(new Set());
    } catch (e) {
      toast(`Couldn’t add to the Inbox: ${String((e as Error)?.message ?? e).replace(/^.*?Error: /, "")}`);
    } finally {
      setBusy(undefined);
    }
  };

  const keys = (e: KeyboardEvent) => {
    const r = shown[current];
    if (e.key === "ArrowDown") setCurrent((i) => Math.min(shown.length - 1, i + 1));
    else if (e.key === "ArrowUp") setCurrent((i) => Math.max(0, i - 1));
    else if (e.key === " " && r) toggle(r.key);
    else if (e.key === "Enter" && r) setPreview(r.key);
    else if (e.key === "Escape" && preview) setPreview(undefined);
    else if (e.key === "a" && (e.metaKey || e.ctrlKey)) setSelected(new Set(shown.map((x) => x.key)));
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const r = shown[current];
    if (r && preview && preview !== r.key) setPreview(r.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const types = DOC_TYPES.filter(([id]) => facets.types[id]);
  return (
    <div className="kx-db-results" data-preview={!!previewed || undefined}>
      <div className="kx-db-results-main">
        {page && <RunProgress page={page} connectors={connectors} onCancel={() => void api.cancel(runId).then(refresh)} onMore={() => void api.more(runId).then(refresh)} />}
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-db-results-bar">
          <label className="kx-db-select-all" title="Select every work shown (⌘A)">
            <input type="checkbox" checked={allShownSelected} ref={(el) => void (el && (el.indeterminate = !allShownSelected && shown.some((r) => selected.has(r.key))))} onChange={() => setSelected(allShownSelected ? new Set() : new Set(shown.map((r) => r.key)))} aria-label="Select all shown" />
          </label>
          <span className="kx-db-results-count">{selected.size ? `${plural(selected.size, "work")} selected` : `${plural(shown.length, "work")}${shown.length !== records.length ? ` of ${countText(records.length)}` : ""}`}</span>
          {selected.size > 0 ? (
            <>
              <button type="button" className="kx-page-action kx-page-action-primary" onClick={() => setAdding([...selected])}>
                <Icon name="plus" size={12} /> Add to library…
              </button>
              <button type="button" className="kx-page-action" disabled={busy === "inbox"} onClick={() => void addToInbox(chosen())}>
                <Icon name="inbox" size={12} /> {busy === "inbox" ? "Adding…" : "Add to Inbox"}
              </button>
              {!api.isMock && <SendRunToReview invoke={invoke} workspaceId={workspaceId} runId={runId} keys={[...selected]} label={label} />}
              <button type="button" className="kx-page-action" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </>
          ) : (
            <>
              <div className="kx-segmented kx-db-view" role="group" aria-label="Show">
                <button type="button" aria-pressed={dedupe} onClick={() => setDedupe(true)} title="One row per work, with every database that found it">
                  Without duplicates
                </button>
                <button type="button" aria-pressed={!dedupe} onClick={() => setDedupe(false)} title="Every record as each database returned it">
                  Per database
                </button>
              </div>
              <select className="kx-db-sort" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as ResultSort)}>
                <option value="relevance">Best match</option>
                <option value="databases">Found by most databases</option>
                <option value="year-desc">Newest first</option>
                <option value="year-asc">Oldest first</option>
                <option value="title">Title</option>
              </select>
            </>
          )}
          <span className="kx-spacer" />
          {!api.isMock && !selected.size && page && page.state !== "running" && records.length > 0 && <SendRunToReview invoke={invoke} workspaceId={workspaceId} runId={runId} label={label} />}
          {onReport && page && page.state !== "running" && (
            <button type="button" className="kx-page-action" onClick={onReport}>
              <Icon name="list" size={12} /> Report…
            </button>
          )}
        </div>
        <div className="kx-db-facets" role="group" aria-label="Filter results">
          {Object.keys(facets.byConnector).length > 1 &&
            Object.entries(facets.byConnector).map(([id, n]) => (
              <button key={id} type="button" className="kx-db-facet" aria-pressed={filter.connectors.includes(id)} onClick={() => setFilter((f) => ({ ...f, connectors: f.connectors.includes(id) ? f.connectors.filter((c) => c !== id) : [...f.connectors, id] }))}>
                {name(id)} <span className="kx-count">{countText(n)}</span>
              </button>
            ))}
          {types.length > 1 &&
            types.map(([id, text]) => (
              <button key={id} type="button" className="kx-db-facet" aria-pressed={filter.types.includes(id)} onClick={() => setFilter((f) => ({ ...f, types: f.types.includes(id) ? f.types.filter((t) => t !== id) : [...f.types, id] }))}>
                {text} <span className="kx-count">{countText(facets.types[id])}</span>
              </button>
            ))}
          {facets.years && facets.years[0] !== facets.years[1] && (
            <span className="kx-db-facet-years">
              <input className="kx-db-year" aria-label="Results from year" placeholder={String(facets.years[0])} maxLength={4} value={filter.yearFrom ?? ""} onChange={(e) => setFilter((f) => ({ ...f, yearFrom: /^\d{4}$/.test(e.target.value) ? Number(e.target.value) : undefined }))} />–
              <input className="kx-db-year" aria-label="Results to year" placeholder={String(facets.years[1])} maxLength={4} value={filter.yearTo ?? ""} onChange={(e) => setFilter((f) => ({ ...f, yearTo: /^\d{4}$/.test(e.target.value) ? Number(e.target.value) : undefined }))} />
            </span>
          )}
          {(
            [
              ["hasAbstract", "Has abstract"],
              ["openAccess", "Has PDF"],
              ["hideInLibrary", "Not in library"],
              ...(anyNew ? ([["onlyNew", "New since last run"]] as const) : []),
            ] as const
          ).map(([k, text]) => (
            <button key={k} type="button" className="kx-db-facet" aria-pressed={filter[k]} onClick={() => setFilter((f) => ({ ...f, [k]: !f[k] }))}>
              {text}
            </button>
          ))}
        </div>
        <div ref={scroller} className="kx-db-results-list" role="listbox" aria-label="Works found" aria-multiselectable tabIndex={0} onKeyDown={keys}>
          {!shown.length ? (
            <p className="kx-db-muted kx-db-results-empty">{page?.state === "running" ? "The first works arrive in a moment…" : records.length ? "No work matches these filters." : "Nothing found. Try fewer concepts or more synonyms."}</p>
          ) : (
            <ul className="kx-work-list kx-db-work-list" style={{ height: virtual.getTotalSize() }}>
              {(() => {
                const items = virtual.getVirtualItems();
                const top = items[0]?.start ?? 0;
                return (
                  <>
                    <li aria-hidden="true" className="kx-db-spacer" style={{ height: top }} />
                    {items.map((item) => {
                      const r = shown[item.index];
                      const state = stateOf(r);
                      const work: ListWork = { title: r.title, authors: r.authors, byline: r.authors.slice(0, 3).join(", ") + (r.authors.length > 3 ? " et al." : ""), year: r.year, container: r.venue, doi: r.doi, openalexId: r.ids.openalex, abstract: r.abstract, url: r.landingUrl, matchedSourceId: state.state === "library" ? state.sourceId : undefined };
                      return (
                        <SourceListItem
                          key={item.key}
                          index={item.index}
                          itemRef={virtual.measureElement}
                          work={work}
                          badge={state.state !== "inbox"}
                          // The row's own Add to Inbox (below) records the search as the origin.
                          inbox={false}
                          invoke={invoke}
                          workspaceId={workspaceId}
                          selected={item.index === current}
                          onSelect={() => {
                            setCurrent(item.index);
                            setPreview(r.key);
                          }}
                          onAdded={(s) => setStates((all) => ({ ...all, [r.key]: { state: "library", sourceId: s.id } }))}
                          lead={
                            <label className="kx-db-row-check" onMouseDown={(e) => e.stopPropagation()}>
                              <input type="checkbox" aria-label={`Select ${r.title}`} checked={selected.has(r.key)} onChange={(e) => toggle(r.key, e.target.checked)} />
                            </label>
                          }
                          aside={
                            <span className="kx-db-row-marks">
                              {r.isNew && <span className="kx-db-badge" data-tone="accent">New</span>}
                              {state.state === "inbox" && <span className="kx-work-badge" data-possible>In Inbox</span>}
                              {(dedupe ? r.foundBy : [r.provider]).map((c) => (
                                <span key={c} className="kx-db-source-badge" title={`Found in ${name(c)}`}>
                                  {name(c)}
                                </span>
                              ))}
                            </span>
                          }
                          actions={
                            state.state === "none" && (
                              <button type="button" className="kx-page-action" onClick={() => void addToInbox([r])}>
                                <Icon name="inbox" size={12} /> Add to Inbox
                              </button>
                            )
                          }
                        />
                      );
                    })}
                  </>
                );
              })()}
            </ul>
          )}
        </div>
      </div>
      {previewed && <RecordPreview api={api} runId={runId} record={previewed} state={stateOf(previewed)} name={name} onClose={() => setPreview(undefined)} onInbox={() => void addToInbox([previewed])} onLibrary={() => setAdding([previewed.key])} />}
      {adding && (
        <AddSheet
          invoke={invoke}
          workspaceId={workspaceId}
          count={adding.length}
          label={label}
          onClose={() => setAdding(undefined)}
          onAdd={async ({ collectionId, tag, pdfs }) => {
            const out = await api.addToLibrary(runId, adding, { collectionId, tag });
            const ids = out.results.map((r) => r.sourceId).filter((id): id is string => !!id);
            setStates((s) => ({ ...s, ...Object.fromEntries(out.results.filter((r) => r.sourceId).map((r) => [r.key, { state: "library" as const, sourceId: r.sourceId }])) }));
            libraryChanged();
            setSelected(new Set());
            setAdding(undefined);
            const failed = out.results.filter((r) => r.error).length;
            toast(`Added ${plural(out.added, "work")} to the library${out.existed ? `; ${out.existed} were there already` : ""}${failed ? `; ${failed} failed` : ""}`);
            if (pdfs && ids.length) {
              const sources = await Promise.all(ids.map((id) => invoke<Source | null>("store_source", { id }, workspaceId).catch(() => null)));
              void findPdfs(invoke, workspaceId, sources.filter((s): s is Source => !!s && !s.filePath));
            }
          }}
        />
      )}
    </div>
  );
}

function RecordPreview({ api, runId, record, state, name, onClose, onInbox, onLibrary }: { api: DbSearchApi; runId: string; record: DbRecord; state: LibraryState; name: (id: string) => string; onClose: () => void; onInbox: () => void; onLibrary: () => void }) {
  const [versions, setVersions] = useState<DbRecord[]>();
  useEffect(() => {
    let live = true;
    setVersions(undefined);
    void api.record(runId, record.key).then(
      (r) => live && setVersions(r.versions),
      () => live && setVersions([]),
    );
    return () => {
      live = false;
    };
  }, [api, runId, record.key]);
  const links: [string, string][] = [
    ...(record.doi ? ([["DOI", `https://doi.org/${record.doi}`]] as [string, string][]) : []),
    ...(record.ids.pmid ? ([["PubMed", `https://pubmed.ncbi.nlm.nih.gov/${record.ids.pmid}/`]] as [string, string][]) : []),
    ...(record.landingUrl && !record.landingUrl.includes("doi.org") ? ([["Landing page", record.landingUrl]] as [string, string][]) : []),
    ...(record.pdfUrl ? ([["PDF", record.pdfUrl]] as [string, string][]) : []),
  ];
  return (
    <aside className="kx-db-preview" aria-label="Preview">
      <header>
        <span className="kx-db-muted">{[DOC_TYPES.find(([k]) => k === kindOf(record))?.[1] ?? kindOf(record), record.year, record.language && record.language !== "en" ? record.language.toUpperCase() : ""].filter(Boolean).join(" · ")}</span>
        <span className="kx-spacer" />
        <button type="button" className="kx-db-icon-button" aria-label="Close the preview" onClick={onClose}>
          <Icon name="close" size={10} />
        </button>
      </header>
      <h3>{record.title}</h3>
      {record.authors.length > 0 && <p className="kx-db-preview-authors">{record.authors.join(", ")}</p>}
      {record.venue && <p className="kx-db-muted">{record.venue}</p>}
      <div className="kx-db-preview-actions">
        {state.state === "library" ? (
          <span className="kx-work-badge">In library</span>
        ) : (
          <button type="button" className="kx-page-action kx-page-action-primary" onClick={onLibrary}>
            <Icon name="plus" size={12} /> Add to library…
          </button>
        )}
        {state.state === "none" && (
          <button type="button" className="kx-page-action" onClick={onInbox}>
            <Icon name="inbox" size={12} /> Add to Inbox
          </button>
        )}
        {state.state === "inbox" && <span className="kx-work-badge" data-possible>In Inbox</span>}
      </div>
      <h4>Abstract</h4>
      <p className="kx-db-preview-abstract">{record.abstract || <span className="kx-db-muted">No abstract in these databases.</span>}</p>
      {record.keywords?.length ? (
        <p className="kx-db-muted">
          <b>Keywords:</b> {record.keywords.join(", ")}
        </p>
      ) : null}
      {links.length > 0 && (
        <>
          <h4>Links</h4>
          <div className="kx-db-preview-links">
            {links.map(([text, url]) => (
              <button key={url} type="button" className="kx-db-link" onClick={() => openWebLink(url)}>
                <Icon name="external" size={11} /> {text}
              </button>
            ))}
          </div>
        </>
      )}
      <h4>
        Where it was found <Explain help="dbsearch.provenance" />
      </h4>
      <ul className="kx-db-provenance">
        {record.provenance.map((p) => (
          <li key={`${p.connector}:${p.sourceId}`}>
            <b>{name(p.connector)}</b> <span className="kx-db-muted">#{p.rank + 1} · id {p.sourceId} · {new Date(p.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span>
          </li>
        ))}
        {versions && versions.length > 1 && <li className="kx-db-muted">{versions.length} copies merged into this one.</li>}
      </ul>
    </aside>
  );
}

function AddSheet({ invoke, workspaceId, count, label, onClose, onAdd }: { invoke: Invoke; workspaceId: string; count: number; label: string; onClose: () => void; onAdd: (o: { collectionId?: string; tag?: string; pdfs: boolean }) => Promise<void> }) {
  const [collections, setCollections] = useState<Collection[]>();
  const [collectionId, setCollectionId] = useState("");
  const [tagOn, setTagOn] = useState(false);
  const [tag, setTag] = useState(label);
  const [pdfs, setPdfs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    void invoke<Collection[]>("store_collections", {}, workspaceId).then(setCollections, () => setCollections([]));
  }, [invoke, workspaceId]);
  const depth = (c: Collection): number => {
    const parent = c.parentId ? collections?.find((p) => p.id === c.parentId) : undefined;
    return parent ? depth(parent) + 1 : 0;
  };
  return (
    <GlobalDrawer presentation="sheet" label="Add to library" onClose={onClose} busy={busy}>
      <div className="key-property-editor kx-db-add-sheet" data-modal-view="add">
        <header>
          <h2>Add {plural(count, "work")} to the library</h2>
          <p>Works already in your library are not added twice; they are filed in the collection you choose.</p>
          <button className="kx-sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={10} />
          </button>
        </header>
        <div className="key-property-body">
          <label className="kx-db-form-row">
            <span>Collection</span>
            <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)} aria-label="Collection">
              <option value="">Library only, no collection</option>
              {(collections ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {" ".repeat(depth(c))}
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="kx-db-form-row">
            <span>Tag</span>
            <span className="kx-db-toggle">
              <input type="checkbox" checked={tagOn} onChange={(e) => setTagOn(e.target.checked)} />
              <input className="kx-db-tag-input" aria-label="Tag" value={tag} disabled={!tagOn} onChange={(e) => setTag(e.target.value)} />
            </span>
          </label>
          <label className="kx-db-form-row">
            <span>PDFs</span>
            <span className="kx-db-toggle">
              <input type="checkbox" checked={pdfs} onChange={(e) => setPdfs(e.target.checked)} />
              Find PDFs for the works added
            </span>
          </label>
          {error && <p className="kx-inline-error">{error}</p>}
        </div>
        <footer className="kx-merge-actions">
          <span className="kx-spacer" />
          <button type="button" className="kx-page-action" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="kx-page-action kx-page-action-primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              onAdd({ collectionId: collectionId || undefined, tag: tagOn && tag.trim() ? tag.trim() : undefined, pdfs })
                .catch((e) => setError(String((e as Error)?.message ?? e).replace(/^.*?Error: /, "")))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Adding…" : `Add ${plural(count, "work")}`}
          </button>
        </footer>
      </div>
    </GlobalDrawer>
  );
}
