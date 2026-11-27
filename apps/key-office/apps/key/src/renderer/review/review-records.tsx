// Sources › Records and Duplicates. Every record of the review in one virtualised table,
// searchable and filtered by import, PRISMA group, stage status, abstract and full text; a record
// opens to edit its metadata, remove it by hand (PRISMA: removed for other reasons) or restore
// it, and to mark it as another report of a study. Missing abstracts (and DOI, PMID, year,
// journal) are filled from the record's duplicates first, then the library, then (asked for)
// from OpenAlex, Crossref and PubMed, each value noting where it came from. Duplicates lists
// every duplicate decision, automatic and by hand, with the record kept, why they matched, and
// "Not duplicates" to split them again. All of it is events in the review's log (undoable).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlobalDialog } from "../GlobalDrawer";
import { Icon } from "../icons";
import { STAGE_LABEL, plural, type DuplicateGroup, type ListRow, type RecordMeta, type RecordView } from "./review-api";
import { Btn, Confirm, StatusPill, errorText, formatDate, useLoad } from "./review-ui";
import { provenance } from "./review-screen";
import type { StageProps } from "./ReviewPage";

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

export function RecordsTable(props: StageProps) {
  const { api, summary, viewer, notify, onChanged } = props;
  const [text, setText] = useState("");
  const [batch, setBatch] = useState("");
  const [group, setGroup] = useState("");
  const [status, setStatus] = useState("");
  const [hasAbstract, setHasAbstract] = useState<"" | "yes" | "no">("");
  const [hasFullText, setHasFullText] = useState<"" | "yes" | "no">("");
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<Map<number, ListRow>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [open, setOpen] = useState<string>();
  const [filling, setFilling] = useState(false);
  const [lookups, setLookups] = useState<string[]>();
  const box = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const loaded = useRef(new Set<number>());
  const query = useMemo(() => {
    const [stage, f] = status.includes(":") ? status.split(":") : ["ta", status];
    return { stage: stage as "ta" | "ft", filter: f, text, batch, group, hasAbstract, hasFullText, scope: "sources" as const };
  }, [status, text, batch, group, hasAbstract, hasFullText]);

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

  const fill = () => {
    setFilling(true);
    api
      .fillMissing(viewer)
      .then((r) => {
        const n = Object.values(r.filled).reduce((a, b) => a + b, 0);
        notify(n ? `Filled ${plural(r.filled.abstractText ?? 0, "abstract")}${n > (r.filled.abstractText ?? 0) ? ` and ${plural(n - (r.filled.abstractText ?? 0), "other value")}` : ""} from duplicates and the library` : "Nothing more in the duplicates or the library", n ? "ok" : undefined);
        onChanged();
        if (r.lookupCandidates.length) setLookups(r.lookupCandidates);
      })
      .catch((e) => notify(errorText(e), "error"))
      .finally(() => setFilling(false));
  };

  return (
    <div className="kx-rv-records">
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
                {b.batch.name || b.batch.fileName}
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
      {summary.missingAbstracts > 0 && (
        <div className="kx-rv-missing-bar">
          <Icon name="info" size={13} />
          <span>
            <strong>{plural(summary.missingAbstracts, "record")}</strong> without an abstract{summary.filledAbstracts ? ` · ${plural(summary.filledAbstracts, "abstract")} filled in so far` : ""}
          </span>
          <Btn small primary disabled={filling} onClick={fill} title="From each record's duplicates in other imports first, then the same work in your library; every value notes where it came from">
            {filling ? "Looking…" : "Find missing abstracts"}
          </Btn>
          <Btn small quiet onClick={() => setHasAbstract("no")}>
            Show them
          </Btn>
        </div>
      )}
      <div className="kx-rv-rows" ref={box} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} role="table" aria-label="Records">
        {total === 0 ? (
          <p className="kx-rv-list-empty">No records match.</p>
        ) : (
          <div style={{ height: total * ROW, position: "relative" }}>
            {Array.from({ length: last - first }, (_, i) => first + i).map((i) => {
              const row = rows.get(i);
              return (
                <div key={i} className="kx-rv-list-row kx-rv-record-row" role="row" style={{ top: i * ROW, height: ROW }} data-removed={(row && !row.active) || undefined}>
                  {row ? (
                    <>
                      <button type="button" className="kx-rv-list-main" onClick={() => setOpen(row.id)}>
                        <span className="kx-rv-list-title">{row.title || "Untitled"}</span>
                        <span className="kx-rv-list-sub">
                          {[row.byline, row.journal, row.batchName].filter(Boolean).join(" · ")}
                          {!row.hasAbstract && " · no abstract"}
                          {row.filled?.abstractText && <em> · abstract from {provenance(row.filled.abstractText)}</em>}
                        </span>
                      </button>
                      <span className="kx-rv-list-state">
                        {row.removed && <span className="kx-rv-pill" data-tone="muted" title={row.removed}>Removed</span>}
                        {row.duplicateOf && <span className="kx-rv-pill" data-tone="muted">Duplicate</span>}
                        {row.studyOf && <span className="kx-rv-pill" data-tone="info" title="Another report of a study">Report</span>}
                        {row.hasFullText && <Icon name="filePdf" size={12} aria-label="Has a full text" />}
                        {row.statuses && row.active && <StatusPill status={row.statuses.ft.name !== "notEligible" ? row.statuses.ft : row.statuses.ta} compact />}
                      </span>
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
      {open && <RecordSheet {...props} recordId={open} onClose={() => setOpen(undefined)} onChange={restart} />}
      {lookups && <LookupSheet {...props} ids={lookups} onClose={() => setLookups(undefined)} />}
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
  ["abstractText", "Abstract", "long"],
];

function RecordSheet({ api, viewer, notify, onChanged, recordId, onClose, onChange, summary }: StageProps & { recordId: string; onClose: () => void; onChange: () => void }) {
  const view = useLoad(() => api.record(recordId, "ta", viewer), [api, recordId, summary.events]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState("");
  const v = view.value;
  useEffect(() => {
    if (!v) return;
    setDraft(Object.fromEntries(EDITABLE.map(([k]) => [k, k === "authors" ? v.meta.authors.join("; ") : String(v.meta[k] ?? "")])));
  }, [v]);
  if (!v) return null;
  const changed = EDITABLE.filter(([k]) => draft[k] !== (k === "authors" ? v.meta.authors.join("; ") : String(v.meta[k] ?? "")));
  const save = () => {
    const fields: Record<string, unknown> = {};
    for (const [k, , kind] of changed) fields[k] = k === "authors" ? draft[k].split(/;\s*/).map((a) => a.trim()).filter(Boolean) : kind === "year" ? (draft[k] ? Number(draft[k]) : null) : draft[k];
    api
      .editRecord(recordId, fields, viewer)
      .then(() => {
        notify("Record corrected", "ok");
        onChanged();
        onChange();
      })
      .catch((e) => setError(errorText(e)));
  };
  const restore = () =>
    api
      .removeRecords([recordId], false, "", viewer)
      .then(() => (notify("Record restored", "ok"), onChanged(), onChange()))
      .catch((e) => setError(errorText(e)));
  // One sheet at a time: removing or linking takes the record sheet's place.
  if (removing)
    return (
      <RemoveSheet
        onClose={() => setRemoving(false)}
        onRemove={(reason) =>
          api.removeRecords([recordId], true, reason, viewer).then(() => {
            notify("Record removed", "ok", { label: "Undo", run: () => void restore() });
            onChanged();
            onChange();
            onClose();
          })
        }
      />
    );
  if (linking) return <StudySheet {...{ api, viewer, notify, onChanged }} view={v} onClose={() => setLinking(false)} onDone={onChange} summary={summary} />;
  return (
    <GlobalDialog label="Record" onClose={onClose}>
      <div className="kx-rv-dialog kx-rv-record-sheet">
        <h2>{v.meta.title || "Untitled"}</h2>
        <p className="kx-rv-muted">
          {v.batch?.name} · {STAGE_LABEL.ta}: <StatusPill status={v.statuses.ta} compact />
          {v.statuses.ft.name !== "notEligible" && (
            <>
              {" "}
              · {STAGE_LABEL.ft}: <StatusPill status={v.statuses.ft} compact />
            </>
          )}
        </p>
        {v.removed && <p className="kx-rv-warning">Removed by hand: {v.removed}. PRISMA counts it as removed for other reasons.</p>}
        {v.duplicateOf && <p className="kx-rv-muted">A duplicate of another record (see Duplicates).</p>}
        {v.studyOf && <p className="kx-rv-muted">Another report of a study: counted once in “studies included”.</p>}
        <div className="kx-rv-form">
          {EDITABLE.map(([k, label, kind]) => (
            <label key={k} className="kx-rv-field" data-wide={kind !== "year" && !["volume", "issue", "pages", "pmid"].includes(k) ? true : undefined}>
              <span>
                {label}
                {v.filled?.[k] && <small className="kx-rv-provenance"> · from {provenance(v.filled[k])}</small>}
              </span>
              {kind === "long" ? (
                <textarea className="kx-rv-input" rows={5} value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
              ) : (
                <input className="kx-rv-input" inputMode={kind === "year" ? "numeric" : undefined} value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
              )}
            </label>
          ))}
        </div>
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          {v.removed ? (
            <Btn onClick={restore}>Restore record</Btn>
          ) : (
            <Btn danger onClick={() => setRemoving(true)}>
              Remove…
            </Btn>
          )}
          <Btn onClick={() => setLinking(true)} title="Several papers about one study: they count once as a study">
            {v.studyOf ? "Report of a study…" : "Another report of…"}
          </Btn>
          <span className="kx-rv-spacer" />
          <Btn onClick={onClose}>Close</Btn>
          <Btn primary disabled={!changed.length} onClick={save}>
            Save changes
          </Btn>
        </div>
      </div>
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

/** Opt-in: the records still without an abstract that have a DOI or PMID, looked up online
 * through Key's own lookups (OpenAlex, Crossref, PubMed), in the background. */
function LookupSheet({ api, invoke, workspaceId, viewer, notify, onChanged, ids, onClose }: StageProps & { ids: string[]; onClose: () => void }) {
  const [progress, setProgress] = useState<{ done: number; filled: number }>();
  const stop = useRef(false);
  const run = async () => {
    stop.current = false;
    let filled = 0;
    setProgress({ done: 0, filled: 0 });
    const metas = await api.records({ stage: "ta", filter: "active", hasAbstract: "no", scope: "sources", limit: 1000 }, viewer);
    const doiOf = new Map(metas.rows.map((r) => [r.id, r.doi ?? ""]));
    for (let i = 0; i < ids.length && !stop.current; i++) {
      const doi = doiOf.get(ids[i]);
      if (doi) {
        try {
          const found = await invoke<{ source: string; abstractText?: string | null; journal?: string | null; year?: number | null; doi?: string | null }>("scholarly_lookup_resource", { resource: doi }, workspaceId);
          const fields: Record<string, unknown> = {};
          if (found.abstractText) fields.abstractText = found.abstractText;
          if (found.journal) fields.journal = found.journal;
          if (found.year) fields.year = found.year;
          if (Object.keys(fields).length) filled += (await api.enrich(ids[i], fields, found.source || "online lookup", viewer)).filled > 0 ? 1 : 0;
        } catch {
          // Not found or offline: the next one.
        }
      }
      setProgress({ done: i + 1, filled });
    }
    notify(`Filled ${plural(filled, "record")} from online lookups`, filled ? "ok" : undefined);
    onChanged();
    onClose();
  };
  return (
    <GlobalDialog label="Look up abstracts online" onClose={onClose}>
      <div className="kx-rv-dialog">
        <h2>Look up {plural(ids.length, "abstract")} online?</h2>
        <p>
          These records have a DOI or PMID but no abstract in their duplicates or the library. Key can ask OpenAlex, Crossref and PubMed for them, one at a time in the background. Each value notes where it came from; nothing that is already
          there is replaced.
        </p>
        {progress && (
          <p role="status">
            {progress.done} of {ids.length} looked up · {progress.filled} filled
          </p>
        )}
        <div className="kx-rv-dialog-actions">
          <Btn
            onClick={() => {
              stop.current = true;
              onClose();
            }}
          >
            {progress ? "Stop" : "Not now"}
          </Btn>
          {!progress && (
            <Btn primary onClick={() => void run()}>
              Look up online
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
