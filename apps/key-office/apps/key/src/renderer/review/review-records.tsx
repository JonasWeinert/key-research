// Sources › Records and Duplicates. Every record of the review in one virtualised table with
// chosen columns, sorting, filters (import, PRISMA group, stage status, abstract, full text),
// status chips (no abstract, no DOI, no full text, duplicate …) and multi-select with a bulk
// panel. A record opens beside the table: every field edited in place, "Look up" by DOI, PMID or
// title with a field-by-field comparison to accept, its full text attached, replaced or removed
// by drop or picker, where it was found, removed by hand (PRISMA: removed for other reasons) or
// restored, marked as another report of a study. Nothing needs leaving the review. Missing abstracts (and DOI, PMID, year,
// journal) are filled from the record's duplicates first, then the library, then (asked for)
// from OpenAlex, Crossref and PubMed, each value noting where it came from. Duplicates lists
// every duplicate decision, automatic and by hand, with the record kept, why they matched, and
// "Not duplicates" to split them again. All of it is events in the review's log (undoable).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlobalDialog } from "../GlobalDrawer";
import { Icon } from "../icons";
import { bridge } from "../library-api";
import { STAGE_LABEL, plural, type Batch, type DuplicateGroup, type ListRow, type Origin, type RecordMeta, type RecordView } from "./review-api";
import { Btn, Confirm, MenuButton, StatusPill, errorText, formatDate, useLoad } from "./review-ui";
import { provenance } from "./review-screen";
import { OriginFields, reportText } from "./review-sources";
import type { StageProps } from "./ReviewPage";
import { DiffChip, LinkDiffSheet, PossibleChip, PossibleMatchesSheet, linkApi, useLinkChanges, usePossibleCount } from "./review-link-sync";

const ROW = 52;
const PAGE = 200;

const STATUS_FILTERS: [string, string][] = [
  ["", "Any status"],
  ["active", "In screening"],
  ["ta:undecided", "Title & abstract: undecided"],
  ["ta:included", "Title & abstract: included"],
  ["ta:maybe", "Title & abstract: maybe"],
  ["ta:excluded", "Title & abstract: excluded"],
  ["ft:undecided", "Full text: undecided"],
  ["ft:included", "Full text: included"],
  ["ft:excluded", "Full text: excluded"],
  ["duplicates", "Duplicates (merged)"],
  ["removed", "Removed"],
];

type Col = "authors" | "year" | "journal" | "doi" | "import" | "status" | "fulltext";
const COLUMNS: [Col, string, number][] = [
  ["authors", "Authors", 160],
  ["year", "Year", 60],
  ["journal", "Journal", 160],
  ["doi", "DOI", 170],
  ["import", "Import", 130],
  ["status", "Status", 120],
  ["fulltext", "Full text", 80],
];
const SORTABLE: Partial<Record<Col | "title", string>> = { title: "title", authors: "authors", year: "year", journal: "journal", doi: "doi" };
const colsKey = "key.review.columns";
function readCols(): Col[] {
  try {
    const v = JSON.parse(localStorage.getItem(colsKey) ?? "null");
    if (Array.isArray(v)) return v.filter((c) => COLUMNS.some(([id]) => id === c));
  } catch {}
  return ["authors", "year", "journal", "status", "fulltext"];
}

/** What a record lacks or is, at a glance. */
function chips(row: ListRow): { text: string; tone: string; title?: string }[] {
  const out: { text: string; tone: string; title?: string }[] = [];
  if (row.removed) out.push({ text: "Removed", tone: "muted", title: row.removed });
  if (row.duplicateOf) out.push({ text: "Duplicate", tone: "muted", title: "Merged into another record (see Duplicates)" });
  if (row.studyOf) out.push({ text: "Report", tone: "info", title: "Another report of a study" });
  if (!row.hasAbstract) out.push({ text: "No abstract", tone: "amber" });
  if (!row.doi) out.push({ text: "No DOI", tone: "amber" });
  if (row.statuses && row.statuses.ft.name !== "notEligible" && !row.hasFullText) out.push({ text: "No full text", tone: "amber" });
  if (row.origin) out.push({ text: row.origin.name || row.origin.group, tone: "info", title: "Where it was found (not its import's)" });
  return out;
}

export function RecordsTable(props: StageProps) {
  const { api, summary, viewer, notify, onChanged } = props;
  const [text, setText] = useState("");
  const [batch, setBatch] = useState("");
  const [group, setGroup] = useState("");
  const [status, setStatus] = useState("");
  const [hasAbstract, setHasAbstract] = useState<"" | "yes" | "no">("");
  const [hasFullText, setHasFullText] = useState<"" | "yes" | "no">("");
  const [sort, setSort] = useState("");
  const [cols, setColsState] = useState<Col[]>(readCols);
  const setCols = (c: Col[]) => {
    setColsState(c);
    try {
      localStorage.setItem(colsKey, JSON.stringify(c));
    } catch {}
  };
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<Map<number, ListRow>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [open, setOpen] = useState<string>();
  const [filling, setFilling] = useState(false);
  const [completing, setCompleting] = useState<string[]>();
  const [removing, setRemoving] = useState<string[]>();
  const [origin, setOrigin] = useState<string[]>();
  const [adding, setAdding] = useState(false);
  // Linked records whose details differ from the library, and records possibly in it.
  const [differ, setDiffer] = useState<Record<string, number>>({});
  const [matching, setMatching] = useState(false);
  const possible = usePossibleCount(props.invoke, props.workspaceId, props.reviewId, summary.events);
  const box = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const loaded = useRef(new Set<number>());
  const query = useMemo(() => {
    const [stage, f] = status.includes(":") ? status.split(":") : ["ta", status];
    return { stage: stage as "ta" | "ft", filter: f, text, batch, group, hasAbstract, hasFullText, scope: "sources" as const, sort };
  }, [status, text, batch, group, hasAbstract, hasFullText, sort]);

  const fetchPage = useCallback(
    (page: number, gen: number) => {
      if (loaded.current.has(page)) return;
      loaded.current.add(page);
      api
        .records({ ...query, offset: page * PAGE, limit: PAGE }, viewer)
        .then((r) => {
          if (gen !== generation.current) return;
          setTotal(r.total);
          setRows((old) => {
            const next = new Map(old);
            r.rows.forEach((row, i) => next.set(page * PAGE + i, row));
            return next;
          });
        })
        .catch((e) => notify(errorText(e), "error"));
    },
    [api, query, viewer, notify],
  );
  const restart = useCallback(() => {
    const gen = ++generation.current;
    loaded.current = new Set();
    setRows(new Map());
    fetchPage(0, gen);
  }, [fetchPage]);
  useEffect(() => {
    const t = setTimeout(restart, text ? 200 : 0);
    return () => clearTimeout(t);
  }, [restart, text, summary.events]);
  const loadDiffer = useCallback(() => void linkApi(props.invoke, props.workspaceId, props.reviewId).pending().then(setDiffer, () => {}), [props.invoke, props.workspaceId, props.reviewId]);
  useEffect(loadDiffer, [loadDiffer, summary.events]);
  // A linked source edited in the library: its row shows the new details at once.
  useLinkChanges(props.invoke, props.workspaceId, props.reviewId, () => {
    restart();
    loadDiffer();
  });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(scrollTop / ROW) - 10);
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW) + 10);
  useEffect(() => {
    for (let p = Math.floor(first / PAGE); p <= Math.floor(Math.max(first, last - 1) / PAGE); p++) fetchPage(p, generation.current);
  }, [first, last, fetchPage]);

  /** Every id matching the filters (for "select all" and bulk actions on everything shown). */
  const allIds = async () => {
    const ids: string[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await api.records({ ...query, offset, limit: 1000 }, viewer);
      ids.push(...page.rows.map((r) => r.id));
      if (ids.length >= page.total || !page.rows.length) return ids;
    }
  };
  const fill = () => {
    setFilling(true);
    api
      .fillMissing(viewer)
      .then((r) => {
        const n = Object.values(r.filled).reduce((a, b) => a + b, 0);
        notify(n ? `Filled ${plural(r.filled.abstractText ?? 0, "abstract")}${n > (r.filled.abstractText ?? 0) ? ` and ${plural(n - (r.filled.abstractText ?? 0), "other value")}` : ""} from duplicates and the library` : "Nothing more in the duplicates or the library", n ? "ok" : undefined);
        onChanged();
        if (r.lookupCandidates.length) setCompleting(r.lookupCandidates);
      })
      .catch((e) => notify(errorText(e), "error"))
      .finally(() => setFilling(false));
  };
  const ids = [...selected];
  const sortBy = (key?: string) => key && setSort(sort === key ? `-${key}` : sort === `-${key}` ? "" : key);
  const arrow = (key?: string) => (key && sort === key ? " ↑" : key && sort === `-${key}` ? " ↓" : "");
  // With a record open beside, the table keeps its first two columns.
  const shownCols = open ? cols.slice(0, 2) : cols;
  const grid = `28px minmax(200px, 1fr) ${shownCols.map((c) => `${COLUMNS.find(([id]) => id === c)![2]}px`).join(" ")}`;

  return (
    <div className="kx-rv-records" data-panel={open ? true : undefined}>
      <div className="kx-rv-records-main">
        <div className="kx-rv-filters">
          <input className="kx-rv-input kx-rv-search" type="search" placeholder="Search titles, abstracts, authors" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search records" />
          <select className="kx-rv-select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            {STATUS_FILTERS.map(([id, l]) => (
              <option key={id} value={id}>
                {l}
              </option>
            ))}
          </select>
          <select className="kx-rv-select" value={batch} onChange={(e) => setBatch(e.target.value)} aria-label="Import">
            <option value="">Every import</option>
            {summary.batches
              .filter((b) => !b.removed)
              .map((b) => (
                <option key={b.batch.id} value={b.batch.id}>
                  {b.batch.name || b.batch.fileName || "Source not specified"}
                </option>
              ))}
          </select>
          <select className="kx-rv-select" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Origin">
            <option value="">Any origin</option>
            <option value="databases">Databases</option>
            <option value="registers">Registers</option>
            <option value="other">Other methods</option>
          </select>
          <select className="kx-rv-select" value={hasAbstract} onChange={(e) => setHasAbstract(e.target.value as "" | "yes" | "no")} aria-label="Abstract">
            <option value="">Abstract: any</option>
            <option value="yes">With an abstract</option>
            <option value="no">Without an abstract</option>
          </select>
          <select className="kx-rv-select" value={hasFullText} onChange={(e) => setHasFullText(e.target.value as "" | "yes" | "no")} aria-label="Full text">
            <option value="">Full text: any</option>
            <option value="yes">With a full text</option>
            <option value="no">Without a full text</option>
          </select>
          <span className="kx-rv-muted">{plural(total, "record")}</span>
        </div>
        <div className="kx-rv-bulk" role="toolbar" aria-label={selected.size ? "Selected records" : "Records"}>
          {selected.size ? (
            <>
              <strong>{selected.size.toLocaleString()} selected</strong>
              <Btn small icon="sparkle" onClick={() => setCompleting(ids)} title="Look each up by DOI, PMID or title and compare field by field">
                Complete metadata…
              </Btn>
              <Btn small icon="pen" onClick={() => setOrigin(ids)}>
                Came from…
              </Btn>
              <MenuButton
                label="Label selected"
                icon="tag"
                items={[...new Set([...summary.protocol.labels, ...summary.labelsInUse])].map((l) => ({ label: l, run: () => void api.labels(ids, [l], [], viewer).then(() => (onChanged(), restart())) }))}
              />
              <Btn small onClick={() => void api.removeRecords(ids, false, "", viewer).then(() => (notify("Restored", "ok"), onChanged(), restart()))}>Restore</Btn>
              <Btn small danger icon="trash" onClick={() => setRemoving(ids)}>
                Remove…
              </Btn>
              <Btn small quiet onClick={() => setSelected(new Set())}>
                Clear
              </Btn>
            </>
          ) : (
            <>
              <Btn small icon="plus" onClick={() => setAdding(true)}>
                Add a record
              </Btn>
              {summary.missingAbstracts > 0 && (
                <Btn small primary disabled={filling} onClick={fill} title="From each record's duplicates in other imports first, then the same work in your library; then, if you agree, online lookups. Every value notes where it came from.">
                  {filling ? "Looking…" : `Find ${plural(summary.missingAbstracts, "missing abstract")}`}
                </Btn>
              )}
              <Btn small icon="sparkle" onClick={() => void allIds().then(setCompleting)} title="Look up every record shown and compare field by field">
                Complete metadata…
              </Btn>
              <PossibleChip count={possible} onClick={() => setMatching(true)} />
              <span className="kx-rv-spacer" />
              <MenuButton
                label="Columns"
                icon="columns"
                items={COLUMNS.map(([id, label]) => ({ label: `${cols.includes(id) ? "✓ " : ""}${label}`, run: () => setCols(cols.includes(id) ? cols.filter((c) => c !== id) : COLUMNS.map(([c]) => c).filter((c) => c === id || cols.includes(c))) }))}
              />
            </>
          )}
        </div>
        <div className="kx-rv-table-head" style={{ gridTemplateColumns: grid }} role="row">
          <input
            type="checkbox"
            aria-label="Select every record shown"
            checked={total > 0 && selected.size === total}
            onChange={(e) => (e.target.checked ? void allIds().then((a) => setSelected(new Set(a))) : setSelected(new Set()))}
          />
          <button type="button" role="columnheader" onClick={() => sortBy("title")}>
            Title{arrow("title")}
          </button>
          {shownCols.map((c) => (
            <button key={c} type="button" role="columnheader" disabled={!SORTABLE[c]} onClick={() => sortBy(SORTABLE[c])}>
              {COLUMNS.find(([id]) => id === c)![1]}
              {arrow(SORTABLE[c])}
            </button>
          ))}
        </div>
        <div className="kx-rv-rows" ref={box} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} role="table" aria-label="Records">
          {total === 0 ? (
            <p className="kx-rv-list-empty">No records match.</p>
          ) : (
            <div style={{ height: total * ROW, position: "relative" }}>
              {Array.from({ length: last - first }, (_, i) => first + i).map((i) => {
                const row = rows.get(i);
                return (
                  <div key={i} className="kx-rv-record-row" role="row" style={{ top: i * ROW, height: ROW, gridTemplateColumns: grid }} data-removed={(row && !row.active) || undefined} data-open={(row && row.id === open) || undefined} data-selected={(row && selected.has(row.id)) || undefined}>
                    {row ? (
                      <>
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.title}`}
                          checked={selected.has(row.id)}
                          onChange={() =>
                            setSelected((s) => {
                              const n = new Set(s);
                              if (n.has(row.id)) n.delete(row.id);
                              else n.add(row.id);
                              return n;
                            })
                          }
                        />
                        <button type="button" className="kx-rv-list-main" onClick={() => setOpen(row.id)}>
                          <span className="kx-rv-list-title">{row.title || "Untitled"}</span>
                          <span className="kx-rv-chips-inline">
                            {chips(row).map((c) => (
                              <span key={c.text} className="kx-rv-pill" data-tone={c.tone} title={c.title}>
                                {c.text}
                              </span>
                            ))}
                            {differ[row.id] ? (
                              <span className="kx-rv-pill" data-tone="amber" data-differ="" title="Its details differ from the same work in your library: open the record to compare">
                                {differ[row.id] === 1 ? "1 field differs" : `${differ[row.id]} fields differ`}
                              </span>
                            ) : null}
                            {row.filled?.abstractText && <em className="kx-rv-provenance">abstract from {provenance(row.filled.abstractText)}</em>}
                          </span>
                        </button>
                        {shownCols.map((c) => (
                          <span key={c} className="kx-rv-cell" data-col={c}>
                            {c === "authors" && (row.authors?.slice(0, 2).join("; ") + ((row.authors?.length ?? 0) > 2 ? " et al." : "") || row.byline)}
                            {c === "year" && (row.year ?? "")}
                            {c === "journal" && row.journal}
                            {c === "doi" && row.doi}
                            {c === "import" && (row.batchName || "Source not specified")}
                            {c === "status" && row.statuses && row.active && <StatusPill status={row.statuses.ft.name !== "notEligible" ? row.statuses.ft : row.statuses.ta} compact />}
                            {c === "fulltext" && (row.hasFullText ? <Icon name="filePdf" size={12} aria-label="Has a full text" /> : <span className="kx-rv-muted">—</span>)}
                          </span>
                        ))}
                      </>
                    ) : (
                      <span className="kx-rv-list-placeholder" />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {open && <RecordPanel key={open} {...props} recordId={open} onClose={() => setOpen(undefined)} onChange={restart} />}
      {completing && <CompleteSheet {...props} ids={completing} onClose={() => setCompleting(undefined)} onDone={restart} />}
      {removing && (
        <RemoveSheet
          onClose={() => setRemoving(undefined)}
          onRemove={(reason) =>
            api.removeRecords(removing, true, reason, viewer).then(() => {
              notify(`${plural(removing.length, "record")} removed`, "ok", { label: "Undo", run: () => void api.removeRecords(removing, false, "", viewer).then(() => (onChanged(), restart())) });
              setSelected(new Set());
              onChanged();
              restart();
            })
          }
        />
      )}
      {origin && <RecordOriginSheet {...props} ids={origin} onClose={() => setOrigin(undefined)} onDone={restart} />}
      {matching && <PossibleMatchesSheet invoke={props.invoke} workspaceId={props.workspaceId} reviewId={props.reviewId} actor={viewer} notify={notify} onClose={() => setMatching(false)} onChanged={() => (onChanged(), restart(), loadDiffer())} />}
      {adding && <AddRecordSheet {...props} onClose={() => setAdding(false)} onDone={(id) => (restart(), setOpen(id))} />}
    </div>
  );
}

const EDITABLE: [keyof RecordMeta, string, "text" | "long" | "year"][] = [
  ["title", "Title", "text"],
  ["authors", "Authors", "text"],
  ["year", "Year", "year"],
  ["journal", "Journal or source", "text"],
  ["volume", "Volume", "text"],
  ["issue", "Issue", "text"],
  ["pages", "Pages", "text"],
  ["doi", "DOI", "text"],
  ["pmid", "PMID", "text"],
  ["url", "Link", "text"],
  ["abstractText", "Abstract", "long"],
];
const shown = (m: RecordMeta, k: keyof RecordMeta) => (k === "authors" ? m.authors.join("; ") : String(m[k] ?? ""));

/** A lookup's answer as the record's fields. */
type Found = { source: string; fields: Record<string, unknown> };
async function lookUp(invoke: StageProps["invoke"], workspaceId: string, m: Pick<RecordMeta, "doi" | "pmid" | "title" | "url">): Promise<Found | null> {
  const fields: Record<string, unknown> = {};
  const take = (r: { title?: string | null; abstractText?: string | null; authors?: string[] | null; year?: number | null; journal?: string | null; doi?: string | null; pmid?: string | null }) => {
    if (r.title) fields.title = r.title;
    if (r.abstractText) fields.abstractText = r.abstractText;
    if (r.authors?.length) fields.authors = r.authors;
    if (r.year) fields.year = r.year;
    if (r.journal) fields.journal = r.journal;
    if (r.doi) fields.doi = r.doi;
    if (r.pmid) fields.pmid = r.pmid;
  };
  // By DOI or PMID: web search's lookups (OpenAlex, then Crossref or PubMed), in the host.
  if (m.doi?.trim() || m.pmid?.trim()) {
    const r = await invoke<({ source: string } & Parameters<typeof take>[0]) | null>("review_lookup", { doi: m.doi ?? "", pmid: m.pmid ?? "" }, workspaceId);
    if (r) {
      take(r);
      return { source: r.source, fields };
    }
  }
  // By title (or link): the reader's scholarly lookup.
  const resource = m.url?.trim() || m.title?.trim();
  if (!resource) return null;
  const r = await invoke<{ source: string; title?: string; abstractText?: string | null; authors?: string[]; year?: number | null; journal?: string | null; doi?: string | null; certainty?: string | null }>("scholarly_lookup_resource", { resource }, workspaceId);
  take(r);
  return { source: r.source || "online lookup", fields };
}
const same = (a: unknown, b: unknown) => String(Array.isArray(a) ? a.join("; ") : (a ?? "")).trim().toLowerCase() === String(Array.isArray(b) ? b.join("; ") : (b ?? "")).trim().toLowerCase();
/** Fields a lookup would change: missing ones ticked, differing ones offered. */
function diffOf(m: RecordMeta, found: Found) {
  return Object.entries(found.fields)
    .filter(([k, v]) => !same((m as unknown as Record<string, unknown>)[k], v))
    .map(([k, v]) => ({ field: k, from: (m as unknown as Record<string, unknown>)[k], to: v, missing: !String((m as unknown as Record<string, unknown>)[k] ?? "").trim() || (Array.isArray((m as unknown as Record<string, unknown>)[k]) && !((m as unknown as Record<string, unknown>)[k] as unknown[]).length) }));
}
const LABEL: Record<string, string> = Object.fromEntries(EDITABLE.map(([k, l]) => [k, l]));
const showValue = (v: unknown) => (Array.isArray(v) ? v.join("; ") : v == null || v === "" ? "—" : String(v));

/** One record, beside the table: every field editable in place, Look up, its file, its origin. */
function RecordPanel(props: StageProps & { recordId: string; onClose: () => void; onChange: () => void }) {
  const { api, viewer, notify, onChanged, recordId, onClose, onChange, summary, invoke, workspaceId } = props;
  const view = useLoad(() => api.record(recordId, "ta", viewer), [api, recordId, summary.events]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [found, setFound] = useState<{ source: string; diff: ReturnType<typeof diffOf>; on: Set<string> }>();
  const [looking, setLooking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [linking, setLinking] = useState(false);
  const [origin, setOrigin] = useState(false);
  const [over, setOver] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [differ, setDiffer] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const v = view.value;
  const linked = v?.sourceId;
  useEffect(() => {
    if (!linked) return setDiffer(0);
    void linkApi(invoke, workspaceId, props.reviewId).diff(recordId).then((d) => setDiffer(d?.diff.pending ?? 0), () => setDiffer(0));
  }, [invoke, workspaceId, props.reviewId, recordId, linked, v]);
  useLinkChanges(invoke, workspaceId, props.reviewId, (records, all) => (all || records[recordId]) && view.reload());
  useEffect(() => {
    if (v) setDraft(Object.fromEntries(EDITABLE.map(([k]) => [k, shown(v.meta, k)])));
  }, [v]);
  if (!v) return <aside className="kx-rv-record-panel" aria-busy="true" />;
  const after = () => (onChanged(), onChange(), view.reload());
  const saveField = (k: keyof RecordMeta, kind: string) => {
    if (draft[k] === shown(v.meta, k)) return;
    const value = k === "authors" ? draft[k].split(/;\s*/).map((a) => a.trim()).filter(Boolean) : kind === "year" ? (draft[k] ? Number(draft[k]) : null) : draft[k];
    api
      .editRecord(recordId, { [k]: value } as Partial<RecordMeta>, viewer)
      .then(after)
      .catch((e) => {
        notify(errorText(e), "error");
        setDraft((d) => ({ ...d, [k]: shown(v.meta, k) }));
      });
  };
  const lookup = () => {
    setLooking(true);
    lookUp(invoke, workspaceId, v.meta)
      .then((f) => {
        if (!f) return notify("Nothing to look it up by: add a DOI, PMID or title", "error");
        const diff = diffOf(v.meta, f);
        if (!diff.length) return notify("The lookup agrees with this record", "ok");
        setFound({ source: f.source, diff, on: new Set(diff.filter((d) => d.missing).map((d) => d.field)) });
      })
      .catch((e) => notify(`Couldn’t look it up: ${errorText(e)}`, "error"))
      .finally(() => setLooking(false));
  };
  const attach = (f: File) => {
    const path = bridge().pathForFile(f);
    if (!path) return notify("Could not read that file from disk", "error");
    api
      .attach(recordId, path, f.name, v.fulltext.file || v.hasFullText ? "replace" : "upload", viewer)
      .then(() => (notify(`Attached ${f.name}`, "ok", { label: "Undo", run: () => void api.detach(recordId, viewer).then(after) }), after()))
      .catch((e) => notify(errorText(e), "error"));
  };
  const restore = () => api.removeRecords([recordId], false, "", viewer).then(() => (notify("Record restored", "ok"), after()));
  const row = { ...v, hasAbstract: !!v.meta.abstractText, doi: v.meta.doi, statuses: v.statuses, active: !v.removed && !v.duplicateOf } as unknown as ListRow;
  return (
    <aside className="kx-rv-record-panel" aria-label="Record">
      <div className="kx-rv-record-panel-head">
        <span className="kx-rv-chips-inline">
          {chips(row).map((c) => (
            <span key={c.text} className="kx-rv-pill" data-tone={c.tone} title={c.title}>
              {c.text}
            </span>
          ))}
        </span>
        <button type="button" className="kx-rv-icon" aria-label="Close the record" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <p className="kx-rv-muted">
        {v.batch?.name || "Source not specified"} · {STAGE_LABEL.ta}: <StatusPill status={v.statuses.ta} compact />
        {v.statuses.ft.name !== "notEligible" && (
          <>
            {" "}
            · {STAGE_LABEL.ft}: <StatusPill status={v.statuses.ft} compact />
          </>
        )}
      </p>
      {v.removed && <p className="kx-rv-warning">Removed by hand: {v.removed}. PRISMA counts it as removed for other reasons.</p>}
      <div className="kx-rv-panel-actions">
        <Btn small primary icon="sparkle" disabled={looking} onClick={lookup} title="Look it up by DOI, PMID or title (OpenAlex, Crossref, PubMed) and compare field by field">
          {looking ? "Looking up…" : "Look up"}
        </Btn>
        <Btn small onClick={() => setOrigin(true)}>Came from…</Btn>
        <Btn small onClick={() => setLinking(true)}>{v.studyOf ? "Report of a study…" : "Another report of…"}</Btn>
        {v.removed ? <Btn small onClick={() => void restore()}>Restore</Btn> : <Btn small danger onClick={() => setRemoving(true)}>Remove…</Btn>}
      </div>
      {found && (
        <div className="kx-rv-diff" role="group" aria-label="Lookup results">
          <p>
            <strong>From {found.source}</strong> · tick what to take
          </p>
          {found.diff.map((d) => (
            <label key={d.field} className="kx-rv-diff-row">
              <input type="checkbox" checked={found.on.has(d.field)} onChange={() => setFound({ ...found, on: new Set(found.on.has(d.field) ? [...found.on].filter((x) => x !== d.field) : [...found.on, d.field]) })} />
              <span>
                <strong>{LABEL[d.field] ?? d.field}</strong>
                <del>{showValue(d.from).slice(0, 160)}</del>
                <ins>{showValue(d.to).slice(0, 300)}</ins>
              </span>
            </label>
          ))}
          <div className="kx-rv-step-actions">
            <Btn small onClick={() => setFound(undefined)}>Cancel</Btn>
            <Btn
              small
              primary
              disabled={!found.on.size}
              onClick={() =>
                void api
                  .enrich(recordId, Object.fromEntries(found.diff.filter((d) => found.on.has(d.field)).map((d) => [d.field, d.to])), found.source, viewer, true)
                  .then(() => (setFound(undefined), notify("Record completed", "ok"), after()))
                  .catch((e) => notify(errorText(e), "error"))
              }
            >
              Take {found.on.size}
            </Btn>
          </div>
        </div>
      )}
      <div className="kx-rv-form kx-rv-record-fields">
        {EDITABLE.map(([k, label, kind]) => (
          <label key={k} className="kx-rv-field" data-wide={!["year", "volume", "issue", "pages", "pmid"].includes(k) || undefined}>
            <span>
              {label}
              {v.filled?.[k] && <small className="kx-rv-provenance"> · from {provenance(v.filled[k])}</small>}
            </span>
            {kind === "long" ? (
              <textarea className="kx-rv-input" rows={6} value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} onBlur={() => saveField(k, kind)} aria-label={label} />
            ) : (
              <input className="kx-rv-input" aria-label={label} inputMode={kind === "year" ? "numeric" : undefined} value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} onBlur={() => saveField(k, kind)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
            )}
          </label>
        ))}
      </div>
      <section
        className="kx-rv-file-drop"
        data-over={over || undefined}
        aria-label="Full text"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) attach(f);
        }}
      >
        {v.sourceId && (
          <p className="kx-rv-inline" data-linked="">
            <span className="kx-rv-muted">
              <Icon name="books" size={11} /> In your library
            </span>
            <DiffChip count={differ} onClick={() => setComparing(true)} />
            {!differ && (
              <Btn small quiet onClick={() => setComparing(true)}>
                Compare…
              </Btn>
            )}
          </p>
        )}
        {comparing && (
          <LinkDiffSheet
            invoke={invoke}
            workspaceId={workspaceId}
            reviewId={props.reviewId}
            recordId={recordId}
            actor={viewer}
            origin="review"
            onClose={() => setComparing(false)}
            onDone={(message, undo) => {
              notify(message, "ok", undo ? { label: "Undo", run: () => void Promise.resolve(undo()).then(() => setTimeout(after, 150)) } : undefined);
              after();
            }}
          />
        )}
        <h4>Full text</h4>
        {v.fulltext.file ? (
          <p>
            <Icon name="filePdf" size={12} /> {v.fulltext.file.name} <small className="kx-rv-muted">kept with the review</small>
          </p>
        ) : v.hasFullText ? (
          <p>
            <Icon name="filePdf" size={12} /> In the library
          </p>
        ) : (
          <p className="kx-rv-muted">None yet. Drop a PDF or saved page here.</p>
        )}
        <span className="kx-rv-inline">
          <Btn small icon="link" onClick={() => file.current?.click()}>
            {v.hasFullText ? "Replace…" : "Attach…"}
          </Btn>
          {v.hasFullText && (
            <Btn small quiet onClick={() => void api.detach(recordId, viewer).then(() => (notify("Full text removed", "ok"), after()))}>
              Remove
            </Btn>
          )}
          {v.fulltext.file && !v.sourceId && (
            <Btn small quiet onClick={() => void api.toLibrary(recordId, viewer).then(() => (notify("Added to the library", "ok"), after()))}>
              Also add to library
            </Btn>
          )}
        </span>
        <input
          ref={file}
          type="file"
          hidden
          accept=".pdf,.html,.htm"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (f) attach(f);
          }}
        />
      </section>
      {removing && (
        <RemoveSheet
          onClose={() => setRemoving(false)}
          onRemove={(reason) => api.removeRecords([recordId], true, reason, viewer).then(() => (notify("Record removed", "ok", { label: "Undo", run: () => void restore() }), after()))}
        />
      )}
      {linking && <StudySheet {...{ api, viewer, notify, onChanged }} view={v} onClose={() => setLinking(false)} onDone={after} summary={summary} />}
      {origin && <RecordOriginSheet {...props} ids={[recordId]} current={v.origin} onClose={() => setOrigin(false)} onDone={after} />}
    </aside>
  );
}

/** Where some records were found, when not where their import says. */
function RecordOriginSheet(props: StageProps & { ids: string[]; current?: Origin | null; onClose: () => void; onDone: () => void }) {
  const { api, viewer, notify, onChanged, ids, onClose, onDone } = props;
  const [own, setOwn] = useState(!!props.current);
  const [origin, setOrigin] = useState<Partial<Batch>>(props.current ?? { group: "other", name: "Citation searching" });
  return (
    <GlobalDialog label="Where these records were found" onClose={onClose}>
      <form
        className="kx-rv-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          api
            .recordOrigin(ids, own ? { group: (origin.group ?? "databases") as Origin["group"], name: origin.name ?? "" } : null, viewer)
            .then(() => (notify("PRISMA counts updated", "ok"), onChanged(), onDone(), onClose()))
            .catch((err) => notify(errorText(err), "error"));
        }}
      >
        <h2>Where {ids.length === 1 ? "this record was" : `these ${ids.length.toLocaleString()} records were`} found</h2>
        <div className="kx-rv-radio-list">
          <label>
            <input type="radio" checked={!own} onChange={() => setOwn(false)} /> As their import says
          </label>
          <label>
            <input type="radio" checked={own} onChange={() => setOwn(true)} /> Somewhere else:
          </label>
        </div>
        {own && <OriginFields batch={origin} onChange={setOrigin} names={[]} />}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary>
            Save
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

function AddRecordSheet({ api, viewer, notify, onChanged, onClose, onDone, invoke, workspaceId }: StageProps & { onClose: () => void; onDone: (id: string) => void }) {
  const [doi, setDoi] = useState("");
  const [title, setTitle] = useState("");
  const [batch, setBatch] = useState<Partial<Batch>>({ group: "other", name: "Citation searching" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <GlobalDialog label="Add a record" onClose={onClose} busy={busy}>
      <form
        className="kx-rv-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          (async () => {
            // Looked up first, so the record arrives complete; edited in place afterwards.
            const f = await lookUp(invoke, workspaceId, { doi, title, pmid: "", url: "" }).catch(() => null);
            const record = { title: (f?.fields.title as string) || title || doi, doi: (f?.fields.doi as string) || doi, authors: (f?.fields.authors as string[]) ?? [], year: (f?.fields.year as number) ?? null, journal: (f?.fields.journal as string) ?? "", abstractText: (f?.fields.abstractText as string) ?? "" };
            const { report } = await api.importRecords([record], batch, viewer);
            notify(reportText(report), "ok");
            onChanged();
            const added = await api.records({ stage: "ta", filter: "all", batch: report.batchId, scope: "sources", limit: 1 }, viewer);
            onClose();
            if (added.rows[0]) onDone(added.rows[0].id);
          })()
            .catch((err) => setError(errorText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>Add a record</h2>
        <p className="kx-rv-muted">A DOI or a title is enough: Key looks the rest up, and you can edit every field after.</p>
        <div className="kx-rv-form">
          <label className="kx-rv-field" data-wide>
            <span>DOI</span>
            <input className="kx-rv-input" autoFocus value={doi} placeholder="10.…" onChange={(e) => setDoi(e.target.value)} />
          </label>
          <label className="kx-rv-field" data-wide>
            <span>or Title</span>
            <input className="kx-rv-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </div>
        <OriginFields batch={batch} onChange={setBatch} names={[]} />
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary disabled={busy || (!doi.trim() && !title.trim())}>
            {busy ? "Looking up…" : "Add record"}
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

function RemoveSheet({ onClose, onRemove }: { onClose: () => void; onRemove: (reason: string) => Promise<unknown> }) {
  const [reason, setReason] = useState("Not a research record (e.g. an erratum or index entry)");
  const choices = ["Not a research record (e.g. an erratum or index entry)", "Retracted", "Outside the search dates", "Imported by mistake"];
  return (
    <Confirm
      title="Remove this record?"
      body={<p>It leaves screening; PRISMA counts it as “removed for other reasons”. Its decisions stay in the audit trail, and it can be restored.</p>}
      confirm="Remove record"
      danger
      onClose={onClose}
      onConfirm={() => onRemove(reason)}
    >
      <div className="kx-rv-radio-list">
        {choices.map((c) => (
          <label key={c}>
            <input type="radio" checked={reason === c} onChange={() => setReason(c)} />
            {c}
          </label>
        ))}
      </div>
      <input className="kx-rv-input" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Why" />
    </Confirm>
  );
}

function StudySheet({ api, viewer, notify, onChanged, view, onClose, onDone }: Pick<StageProps, "api" | "viewer" | "notify" | "onChanged" | "summary"> & { view: RecordView; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<ListRow[]>([]);
  useEffect(() => {
    if (text.trim().length < 3) return setFound([]);
    const t = setTimeout(() => void api.records({ stage: "ta", filter: "active", text, scope: "sources", limit: 12 }, viewer).then((r) => setFound(r.rows.filter((x) => x.id !== view.meta.id))), 200);
    return () => clearTimeout(t);
  }, [api, text, viewer, view.meta.id]);
  const link = (to: string | null) =>
    api
      .linkStudy(view.meta.id, to, viewer)
      .then(() => {
        notify(to ? "Marked as another report of that study" : "Its own study again", "ok");
        onChanged();
        onDone();
        onClose();
      })
      .catch((e) => notify(errorText(e), "error"));
  return (
    <GlobalDialog label="Another report of a study" onClose={onClose}>
      <div className="kx-rv-dialog">
        <h2>Another report of which study?</h2>
        <p className="kx-rv-muted">Choose the study's main report. PRISMA counts reports and studies separately; extraction stays per report.</p>
        <input className="kx-rv-input" autoFocus placeholder="Search the study's title or author" value={text} onChange={(e) => setText(e.target.value)} />
        <ul className="kx-rv-radio-list">
          {found.map((r) => (
            <li key={r.id}>
              <button type="button" className="kx-rv-pick-row" onClick={() => void link(r.id)}>
                <span>
                  {r.title} <small>{r.byline}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="kx-rv-dialog-actions">
          {view.studyOf && <Btn onClick={() => void link(null)}>Its own study</Btn>}
          <span className="kx-rv-spacer" />
          <Btn onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </GlobalDialog>
  );
}

/** Complete metadata for many records: each looked up by DOI, PMID or title (OpenAlex, Crossref,
 * PubMed through Key's own lookup), one at a time in the background; then every difference per
 * field, missing values ticked, to accept. Asked for: nothing is sent until "Look up". */
function CompleteSheet({ api, invoke, workspaceId, viewer, notify, onChanged, ids, onClose, onDone }: StageProps & { ids: string[]; onClose: () => void; onDone: () => void }) {
  const [progress, setProgress] = useState<{ done: number; found: number }>();
  const [results, setResults] = useState<{ id: string; title: string; source: string; diff: ReturnType<typeof diffOf> }[]>([]);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [finished, setFinished] = useState(false);
  const [applying, setApplying] = useState(false);
  const stop = useRef(false);
  const run = async () => {
    stop.current = false;
    setProgress({ done: 0, found: 0 });
    let found = 0;
    for (let i = 0; i < ids.length && !stop.current; i += 50) {
      const metas = await Promise.all(ids.slice(i, i + 50).map((id) => api.record(id, "ta", viewer).then((v) => v.meta).catch(() => null)));
      for (const [j, m] of metas.entries()) {
        if (stop.current) break;
        if (m) {
          try {
            const f = await lookUp(invoke, workspaceId, m);
            const diff = f ? diffOf(m, f) : [];
            if (f && diff.length) {
              found++;
              setResults((r) => [...r, { id: m.id, title: m.title, source: f.source, diff }]);
              setOn((s) => new Set([...s, ...diff.filter((d) => d.missing).map((d) => `${m.id}/${d.field}`)]));
            }
          } catch {
            // Not found or offline: the next one.
          }
        }
        setProgress({ done: i + j + 1, found });
      }
    }
    setFinished(true);
  };
  const apply = async () => {
    setApplying(true);
    let n = 0;
    for (const r of results) {
      const fields = Object.fromEntries(r.diff.filter((d) => on.has(`${r.id}/${d.field}`)).map((d) => [d.field, d.to]));
      if (Object.keys(fields).length) {
        await api.enrich(r.id, fields, r.source, viewer, true);
        n++;
      }
    }
    notify(`Completed ${plural(n, "record")}`, "ok");
    onChanged();
    onDone();
    onClose();
  };
  const toggle = (key: string) => setOn((s) => (s.has(key) ? new Set([...s].filter((x) => x !== key)) : new Set([...s, key])));
  return (
    <GlobalDialog label="Complete metadata" onClose={onClose} busy={applying}>
      <div className="kx-rv-dialog kx-rv-complete">
        <h2>Complete the metadata of {plural(ids.length, "record")}</h2>
        {!progress ? (
          <p>Key looks each record up by its DOI, PMID or title (OpenAlex, Crossref, PubMed) and shows what differs, field by field. Missing values are ticked; changes to values you have are not, until you tick them. Each value notes where it came from.</p>
        ) : (
          <p role="status">
            {progress.done.toLocaleString()} of {ids.length.toLocaleString()} looked up · {plural(progress.found, "record")} with something to add{finished ? "" : "…"}
          </p>
        )}
        {results.length > 0 && (
          <ul className="kx-rv-complete-list">
            {results.map((r) => (
              <li key={r.id}>
                <strong>{r.title || "Untitled"}</strong> <small className="kx-rv-muted">from {r.source}</small>
                {r.diff.map((d) => (
                  <label key={d.field} className="kx-rv-diff-row">
                    <input type="checkbox" checked={on.has(`${r.id}/${d.field}`)} onChange={() => toggle(`${r.id}/${d.field}`)} />
                    <span>
                      <strong>{LABEL[d.field] ?? d.field}</strong>
                      <del>{showValue(d.from).slice(0, 120)}</del>
                      <ins>{showValue(d.to).slice(0, 200)}</ins>
                    </span>
                  </label>
                ))}
              </li>
            ))}
          </ul>
        )}
        <div className="kx-rv-dialog-actions">
          <Btn
            onClick={() => {
              stop.current = true;
              if (!progress || finished) onClose();
              else setFinished(true);
            }}
          >
            {progress && !finished ? "Stop" : "Cancel"}
          </Btn>
          {!progress ? (
            <Btn primary onClick={() => void run()}>
              Look up
            </Btn>
          ) : (
            <Btn primary disabled={!on.size || applying} onClick={() => void apply()}>
              Take {on.size.toLocaleString()} {on.size === 1 ? "value" : "values"}
            </Btn>
          )}
        </div>
      </div>
    </GlobalDialog>
  );
}

// ── Duplicates ────────────────────────────────────────────────────────────────

export function DuplicatesView(props: StageProps & { pairs: React.ReactNode }) {
  const { api, viewer, notify, onChanged, summary } = props;
  const data = useLoad(() => api.duplicates(), [api, summary.events]);
  const [merging, setMerging] = useState(false);
  const groups = data.value?.groups ?? [];
  const split = (kept: string, merged: string) =>
    api
      .resolvePair(merged, kept, "distinct", undefined, viewer)
      .then(() => {
        notify("Split: both records are screened", "ok", { label: "Undo", run: () => void api.resolvePair(kept, merged, "duplicate", kept, viewer).then(onChanged) });
        onChanged();
      })
      .catch((e) => notify(errorText(e), "error"));
  return (
    <div className="kx-rv-duplicates">
      {props.pairs}
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Duplicate decisions</h2>
          <span className="kx-rv-muted">{plural(summary.duplicates, "record")} merged into {plural(groups.length, "record")}</span>
          <Btn small icon="plus" onClick={() => setMerging(true)} title="Two records that are the same work, missed by de-duplication">
            Merge these…
          </Btn>
        </div>
        {groups.length === 0 ? (
          <p className="kx-rv-muted">No duplicates so far.</p>
        ) : (
          <ul className="kx-rv-dup-groups">
            {groups.map((g) => (
              <DupGroup key={g.kept?.id} group={g} onSplit={split} />
            ))}
          </ul>
        )}
      </section>
      {merging && <MergeSheet {...props} onClose={() => setMerging(false)} />}
    </div>
  );
}

function DupGroup({ group, onSplit }: { group: DuplicateGroup; onSplit: (kept: string, merged: string) => void }) {
  const k = group.kept;
  return (
    <li>
      <div className="kx-rv-dup-kept">
        <span className="kx-rv-pill" data-tone="green">Kept</span>
        <strong>{k?.title ?? "A record"}</strong>
        <small>{[k?.authors.slice(0, 2).join("; "), k?.year, group.keptBatch].filter(Boolean).join(" · ")}</small>
      </div>
      <ul>
        {group.merged.map((m) => (
          <li key={m.record?.id}>
            <span>
              <strong>{m.record?.title}</strong>
              <small>
                {m.batch} · {m.auto ? "Automatically" : `By ${m.by || "hand"}`}
                {m.at ? `, ${formatDate(m.at)}` : ""} · {m.why || "Same work"}
              </small>
            </span>
            <button type="button" className="kx-rv-btn" data-small onClick={() => k && m.record && onSplit(k.id, m.record.id)} title="They are different works: screen both">
              Not duplicates
            </button>
          </li>
        ))}
      </ul>
    </li>
  );
}

function MergeSheet({ api, viewer, notify, onChanged, onClose }: StageProps & { onClose: () => void }) {
  const [picked, setPicked] = useState<ListRow[]>([]);
  const [text, setText] = useState("");
  const [found, setFound] = useState<ListRow[]>([]);
  useEffect(() => {
    if (text.trim().length < 3) return setFound([]);
    const t = setTimeout(() => void api.records({ stage: "ta", filter: "active", text, scope: "sources", limit: 12 }, viewer).then((r) => setFound(r.rows)), 200);
    return () => clearTimeout(t);
  }, [api, text, viewer]);
  const merge = () => {
    const [keep, ...rest] = picked;
    Promise.all(rest.map((r) => api.resolvePair(keep.id, r.id, "duplicate", keep.id, viewer)))
      .then(() => {
        notify(`Merged ${plural(rest.length, "record")} into “${keep.title}”`, "ok");
        onChanged();
        onClose();
      })
      .catch((e) => notify(errorText(e), "error"));
  };
  return (
    <GlobalDialog label="Merge duplicates" onClose={onClose}>
      <div className="kx-rv-dialog">
        <h2>Merge records that are the same work</h2>
        <p className="kx-rv-muted">The first one chosen is kept; the others become its duplicates (and can be split again).</p>
        <input className="kx-rv-input" autoFocus placeholder="Search titles or authors" value={text} onChange={(e) => setText(e.target.value)} />
        <ul className="kx-rv-radio-list">
          {found.map((r) => {
            const on = picked.some((p) => p.id === r.id);
            return (
              <li key={r.id}>
                <label>
                  <input type="checkbox" checked={on} onChange={() => setPicked(on ? picked.filter((p) => p.id !== r.id) : [...picked, r])} />
                  <span>
                    {r.title} <small>{[r.byline, r.batchName].filter(Boolean).join(" · ")}</small>
                  </span>
                  {picked[0]?.id === r.id && <span className="kx-rv-pill" data-tone="green">Kept</span>}
                </label>
              </li>
            );
          })}
        </ul>
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary disabled={picked.length < 2} onClick={merge}>
            Merge {picked.length || ""}
          </Btn>
        </div>
      </div>
    </GlobalDialog>
  );
}
