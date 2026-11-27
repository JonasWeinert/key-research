// Sources: where the records come from, labelled the way PRISMA 2020 reports them — databases,
// registers and other methods (citation searching, websites, organisations). Records arrive from
// a file (dropped or chosen), the library (a collection, a search, or a selection sent from the
// library), a Database search run (with its strategy and per-database counts) or are typed in.
// Each import is a batch to inspect or remove. Exact duplicates are removed on import; likely
// ones wait here for a person to compare. Records is every record in one table (edit, remove,
// restore, fill missing abstracts); Duplicates lists every duplicate decision (review-records.tsx).
import { useEffect, useRef, useState } from "react";
import { EmptyState, Explain, Hint } from "../explain";
import { GlobalDialog } from "../GlobalDrawer";
import { Icon } from "../icons";
import type { Collection } from "../library-api";
import { OTHER_METHODS, plural, type Batch, type ImportReport, type RecordMeta } from "./review-api";
import { Btn, Confirm, MenuButton, errorText, formatDate, useLoad } from "./review-ui";
import { DuplicatesView, RecordsTable } from "./review-records";
import type { StageProps } from "./ReviewPage";

const GROUPS: [Batch["group"], string, string][] = [
  ["databases", "Database", "Bibliographic databases such as PubMed, Embase, Scopus or Web of Science"],
  ["registers", "Register", "Trial and study registers such as ClinicalTrials.gov or the WHO ICTRP"],
  ["other", "Other method", "Citation searching, websites, organisations, experts, hand searching"],
];
/** Database and register names to suggest: Key's connectors, then common ones. */
const KNOWN_SOURCES = ["PubMed", "MEDLINE (Ovid)", "Embase", "Scopus", "Web of Science", "CINAHL", "PsycINFO", "Cochrane CENTRAL", "EconLit", "ERIC", "Google Scholar", "ClinicalTrials.gov", "WHO ICTRP"];
function useSourceNames(invoke: StageProps["invoke"], workspaceId: string) {
  const names = useLoad(() => invoke<{ name: string; prisma?: string }[]>("db_connectors", {}, workspaceId).catch(() => []), [workspaceId]);
  return [...new Set([...(names.value ?? []).map((c) => c.name), ...KNOWN_SOURCES])];
}

/** Where records came from, the way PRISMA 2020 reports it. */
export function OriginSheet(props: StageProps & { batchId?: string; onClose: () => void }) {
  const { api, summary, viewer, notify, onChanged, onClose } = props;
  const batches = summary.batches.filter((b) => !b.removed);
  const toCheck = new Set((summary.originsToCheck ?? []).map((o) => o.batchId));
  const [id, setId] = useState(props.batchId ?? batches.find((b) => toCheck.has(b.batch.id))?.batch.id ?? batches[0]?.batch.id);
  const current = batches.find((b) => b.batch.id === id)?.batch;
  const sensible = (b?: Batch): Partial<Batch> => (!b ? { group: "databases", name: "" } : b.group === "other" && !OTHER_METHODS.includes(b.name) ? { group: "databases", name: "" } : { group: b.group, name: b.name });
  const [origin, setOrigin] = useState<Partial<Batch>>(() => sensible(current));
  const [error, setError] = useState("");
  const names = useSourceNames(props.invoke, props.workspaceId);
  return (
    <GlobalDialog label="Where the records came from" onClose={onClose}>
      <form
        className="kx-rv-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!id) return;
          api
            .batchOrigin(id, (origin.group ?? "databases") as "databases" | "registers" | "other", origin.name ?? "", viewer)
            .then(() => {
              notify("PRISMA counts updated", "ok");
              onChanged();
              onClose();
            })
            .catch((err) => setError(errorText(err)));
        }}
      >
        <h2>Where did these records come from?</h2>
        <p className="kx-rv-muted">PRISMA 2020 counts records from databases and registers in the left column, where they are screened, and records found by other methods (citation searching, websites …) in the right one.</p>
        {batches.length > 1 && (
          <label className="kx-rv-field" data-wide>
            <span>Import</span>
            <select
              className="kx-rv-select"
              value={id}
              onChange={(e) => {
                setId(e.target.value);
                setOrigin(sensible(batches.find((b) => b.batch.id === e.target.value)?.batch));
              }}
            >
              {batches.map((b) => (
                <option key={b.batch.id} value={b.batch.id}>
                  {b.batch.name || b.batch.fileName || "Import"} · {plural(b.records, "record")}
                  {toCheck.has(b.batch.id) ? " · to check" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <OriginFields batch={origin} onChange={setOrigin} names={names} />
        {error && <p className="kx-inline-error">{error}</p>}
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

/** Databases, registers or other methods, and the name (a database's, with suggestions). */
export function OriginFields({ batch, onChange, names }: { batch: Partial<Batch>; onChange: (b: Partial<Batch>) => void; names: string[] }) {
  const group = batch.group ?? "databases";
  return (
    <div className="kx-rv-form">
      <div className="kx-rv-field" data-wide>
        <span>Identified via</span>
        <div className="kx-rv-seg" role="radiogroup" aria-label="Identified via">
          {GROUPS.map(([gid, label, hint]) => (
            <button key={gid} type="button" role="radio" aria-checked={group === gid} title={hint} onClick={() => onChange({ ...batch, group: gid, name: gid === "other" ? (OTHER_METHODS.includes(batch.name ?? "") ? batch.name : "Citation searching") : OTHER_METHODS.includes(batch.name ?? "") ? "" : batch.name })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <label className="kx-rv-field" data-wide>
        <span>{group === "other" ? "Method" : group === "registers" ? "Register" : "Database"}</span>
        {group === "other" ? (
          <select className="kx-rv-select" value={batch.name ?? ""} onChange={(e) => onChange({ ...batch, name: e.target.value })}>
            {OTHER_METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        ) : (
          <>
            <input className="kx-rv-input" list="kx-rv-source-names" value={batch.name ?? ""} placeholder={group === "registers" ? "e.g. ClinicalTrials.gov" : "e.g. Scopus — or leave it to name later"} onChange={(e) => onChange({ ...batch, name: e.target.value })} />
            <datalist id="kx-rv-source-names">
              {names.map((nm) => (
                <option key={nm} value={nm} />
              ))}
            </datalist>
          </>
        )}
      </label>
      {group !== "other" && !batch.name?.trim() && <p className="kx-rv-muted kx-rv-field" data-wide>Counted as “Databases — source not specified” until you name it.</p>}
    </div>
  );
}

export function reportText(r: ImportReport) {
  const parts = [`Added ${plural(r.added, "record")}`];
  if (r.duplicates) parts.push(`${plural(r.duplicates, "duplicate")} removed`);
  if (r.possibleDuplicates) parts.push(`${plural(r.possibleDuplicates, "possible duplicate")} to check`);
  if (r.autoExcluded) parts.push(`${r.autoExcluded} excluded by rules`);
  return parts.join(" · ");
}

type SourcesView = "records" | "duplicates" | "imports";

export function Sources(props: StageProps) {
  const { summary } = props;
  const [view, setView] = useState<SourcesView>(() => (summary.records ? "records" : "imports"));
  const tabs: [SourcesView, string, string][] = [
    ["records", "Records", summary.records ? summary.active.toLocaleString() : ""],
    ["duplicates", "Duplicates", summary.openPairs ? `${summary.openPairs} to check` : summary.duplicates ? summary.duplicates.toLocaleString() : ""],
    ["imports", "Imports", summary.batches.filter((b) => !b.removed).length.toLocaleString()],
  ];
  return (
    <div className="kx-rv-sources-page" data-view={view}>
      <div className="kx-rv-toolbar">
        <div className="kx-rv-seg" role="radiogroup" aria-label="Sources view">
          {tabs.map(([id, label, badge]) => (
            <button key={id} type="button" role="radio" aria-checked={view === id} onClick={() => setView(id)}>
              {label}
              {badge && badge !== "0" && <span className="kx-rv-seg-badge">{badge}</span>}
            </button>
          ))}
        </div>
        {summary.removedByHand > 0 && <span className="kx-rv-muted">{plural(summary.removedByHand, "record")} removed by hand</span>}
      </div>
      {view === "records" && <RecordsTable {...props} />}
      {view === "duplicates" && <DuplicatesView {...props} pairs={summary.openPairs > 0 ? <Duplicates {...props} /> : null} />}
      {view === "imports" && <Imports {...props} />}
    </div>
  );
}

function Imports(props: StageProps) {
  const { summary, api, viewer, notify, onChanged } = props;
  const [file, setFile] = useState<{ name: string; text: string }>();
  const [library, setLibrary] = useState(false);
  const [manual, setManual] = useState(false);
  const [removing, setRemoving] = useState<Batch>();
  const [origin, setOrigin] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const runs = useLoad(() => api.dbRuns().catch(() => []), [api]);
  const readFile = (f: File) =>
    f
      .text()
      .then((text) => setFile({ name: f.name, text }))
      .catch((e) => notify(errorText(e), "error"));
  const batches = summary.batches;
  return (
    <div
      className="kx-rv-sources"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={(e) => {
        const f = e.dataTransfer.files[0];
        setDragging(false);
        if (!f) return;
        e.preventDefault();
        e.stopPropagation();
        void readFile(f);
      }}
    >
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Add records</h2>
          <Explain help="review.sources" />
        </div>
        <div className="kx-rv-add-grid">
          <button type="button" className="kx-rv-add-card" data-drop={dragging || undefined} onClick={() => input.current?.click()}>
            <Icon name="upload" size={18} />
            <strong>Import a file</strong>
            <span>RIS, BibTeX, EndNote XML, PubMed .nbib or CSV — or drop it here</span>
          </button>
          <input
            ref={input}
            type="file"
            hidden
            accept=".ris,.bib,.bibtex,.nbib,.txt,.xml,.csv,.tsv,.json,.medline"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (f) void readFile(f);
            }}
          />
          <button type="button" className="kx-rv-add-card" onClick={() => setLibrary(true)}>
            <Icon name="books" size={18} />
            <strong>From your library</strong>
            <span>A collection, a search, or the whole library</span>
          </button>
          <button type="button" className="kx-rv-add-card" onClick={() => setManual(true)}>
            <Icon name="pen" size={18} />
            <strong>Add by hand</strong>
            <span>A record found by citation searching, a website or an expert</span>
          </button>
        </div>
        <Hint help="review.sources.selection" />
      </section>
      {(runs.value?.length ?? 0) > 0 && (
        <section className="kx-rv-section">
          <div className="kx-rv-section-head">
            <h2>From Database search</h2>
            <span className="kx-rv-muted">The strategy and each database’s count go into PRISMA’s identification box</span>
          </div>
          <ul className="kx-rv-runs">
            {runs.value!.slice(0, 6).map((r) => {
              const imported = batches.some((b) => b.batch.dbRunId === r.runId && !b.removed);
              return (
                <li key={r.runId}>
                  <Icon name="database" size={14} />
                  <span>
                    <strong>{r.label || "Database search"}</strong>
                    <small>
                      {formatDate(r.startedAt)} · {plural(r.total ?? 0, "unique record")}
                      {r.perConnector && ` · ${Object.keys(r.perConnector).length} databases`}
                    </small>
                  </span>
                  <Btn
                    small
                    disabled={imported}
                    onClick={() =>
                      void api
                        .importDbRun(r.runId, {}, viewer)
                        .then(({ report }) => {
                          notify(reportText(report), "ok");
                          onChanged();
                        })
                        .catch((e) => notify(errorText(e), "error"))
                    }
                  >
                    {imported ? "Imported" : "Import"}
                  </Btn>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {summary.originsToCheck?.length > 0 && (
        <div className="kx-rv-missing-bar kx-rv-origin-bar" role="status">
          <span>
            {summary.originsToCheck.map((o) => (
              <span key={o.batchId} className="kx-rv-origin-line">
                <strong>{plural(o.records, "record")}</strong> counted as “{o.name}”. {o.why}.
              </span>
            ))}
          </span>
          <Btn small primary onClick={() => setOrigin(summary.originsToCheck[0].batchId)}>
            Where did these come from?
          </Btn>
        </div>
      )}
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Imports</h2>
          {summary.records > 0 && (
            <span className="kx-rv-muted">
              {plural(summary.records, "record")} imported · {plural(summary.duplicates, "duplicate")} removed · {plural(summary.active, "record")} to screen
            </span>
          )}
        </div>
        {batches.length === 0 ? (
          <EmptyState compact help="empty.review.sources" icon="upload" action={{ label: "Import a file…", icon: "upload", onClick: () => input.current?.click() }} />
        ) : (
          <table className="kx-rv-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>PRISMA</th>
                <th className="kx-rv-num">Records</th>
                <th className="kx-rv-num">Duplicates</th>
                <th>Added</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {batches.map(({ batch, records, duplicates, removed, actorName }) => (
                <tr key={batch.id} data-removed={removed || undefined}>
                  <td>
                    <strong>{batch.name || batch.fileName || "Import"}</strong>
                    <small>
                      {[batch.kind === "file" ? batch.fileName : batch.kind === "database" ? "Database search run" : batch.kind === "library" ? "Key library" : "Added by hand", Object.entries(batch.perSource ?? {}).map(([n, c]) => `${n} ${c}`).join(", ")].filter(Boolean).join(" · ")}
                    </small>
                    {batch.strategy && (
                      <details>
                        <summary>Search strategy</summary>
                        <pre>{batch.strategy}</pre>
                      </details>
                    )}
                  </td>
                  <td>{GROUPS.find((g) => g[0] === batch.group)?.[1] ?? batch.group}</td>
                  <td className="kx-rv-num">{records.toLocaleString()}</td>
                  <td className="kx-rv-num">{(duplicates + (batch.duplicatesRemoved ?? 0)).toLocaleString()}</td>
                  <td>
                    {removed ? "Removed" : formatDate(batch.at)}
                    <small>{actorName}</small>
                  </td>
                  <td>
                    {!removed && (
                      <MenuButton
                        label="Import actions"
                        items={[
                          { label: "Came from…", icon: "pen", run: () => setOrigin(batch.id) },
                          null,
                          { label: "Remove this import…", icon: "trash", danger: true, run: () => setRemoving(batch) },
                        ]}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {file && <ImportSheet {...props} file={file} onClose={() => setFile(undefined)} />}
      {origin && <OriginSheet {...props} batchId={origin} onClose={() => setOrigin(undefined)} />}
      {library && <LibrarySheet {...props} onClose={() => setLibrary(false)} />}
      {manual && <ManualSheet {...props} onClose={() => setManual(false)} />}
      {removing && (
        <Confirm
          title={`Remove “${removing.name || removing.fileName}”?`}
          body={<p>Its records leave screening and the PRISMA counts. Decisions on them are kept in the audit trail, and importing the same file again brings them back.</p>}
          confirm="Remove import"
          danger
          onClose={() => setRemoving(undefined)}
          onConfirm={() => api.removeBatch(removing.id, viewer).then(onChanged)}
        />
      )}
    </div>
  );
}

/** Where a batch comes from, in PRISMA's words. */
function Provenance({ batch, onChange, kind, names }: { batch: Partial<Batch>; onChange: (b: Partial<Batch>) => void; kind: "file" | "library" | "other"; names: string[] }) {
  const group = batch.group ?? "databases";
  return (
    <div className="kx-rv-form">
      <OriginFields batch={batch} onChange={onChange} names={names} />
      {kind !== "library" && group !== "other" && (
        <>
          <label className="kx-rv-field">
            <span>Date searched</span>
            <input className="kx-rv-input" type="date" value={batch.searchedAt ?? ""} onChange={(e) => onChange({ ...batch, searchedAt: e.target.value })} />
          </label>
          <label className="kx-rv-field" data-wide>
            <span>Search strategy</span>
            <textarea className="kx-rv-input" rows={3} placeholder="The search as run, for the methods section and PRISMA-S" value={batch.strategy ?? ""} onChange={(e) => onChange({ ...batch, strategy: e.target.value })} />
          </label>
        </>
      )}
    </div>
  );
}

function guessName(fileName: string, format: string) {
  const lower = fileName.toLowerCase();
  if (format.includes("PubMed") || lower.includes("pubmed")) return "PubMed";
  for (const [needle, name] of [["embase", "Embase"], ["scopus", "Scopus"], ["wos", "Web of Science"], ["savedrecs", "Web of Science"], ["cinahl", "CINAHL"], ["psycinfo", "PsycINFO"], ["cochrane", "Cochrane Library"], ["ctgov", "ClinicalTrials.gov"], ["clinicaltrials", "ClinicalTrials.gov"]] as const)
    if (lower.includes(needle)) return name;
  return fileName.replace(/\.[^.]+$/, "");
}

function ImportSheet({ api, viewer, notify, onChanged, file, onClose, invoke, workspaceId }: StageProps & { file: { name: string; text: string }; onClose: () => void }) {
  const names = useSourceNames(invoke, workspaceId);
  const preview = useLoad(() => api.previewFile(file.text, file.name), [file]);
  const [batch, setBatch] = useState<Partial<Batch>>({ group: "databases", name: "", searchedAt: new Date().toISOString().slice(0, 10) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (preview.value && !batch.name) setBatch((b) => ({ ...b, name: guessName(file.name, preview.value!.format), group: guessName(file.name, preview.value!.format) === "ClinicalTrials.gov" ? "registers" : b.group }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.value]);
  const p = preview.value;
  return (
    <GlobalDialog label="Import records" onClose={onClose} busy={busy}>
      <form
        className="kx-rv-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          api
            .importFile(file.text, file.name, batch, viewer)
            .then(({ report }) => {
              notify(reportText(report), "ok");
              onChanged();
              onClose();
            })
            .catch((err) => setError(errorText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>Import {file.name}</h2>
        {preview.error ? (
          <p className="kx-inline-error">{preview.error}</p>
        ) : p ? (
          <div className="kx-rv-preview">
            <p>
              <strong>{plural(p.count, "record")}</strong> in {p.format}
              {p.warnings > 0 && <span className="kx-rv-muted"> · {plural(p.warnings, "line")} Key could not read</span>}
            </p>
            <ul>
              {p.sample.map((s, i) => (
                <li key={i}>
                  {s.title || "Untitled"} <small>{s.byline}</small>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="kx-rv-muted">Reading…</p>
        )}
        <Provenance batch={batch} onChange={setBatch} kind="file" names={names} />
        <Hint help="review.import.dedup" />
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary disabled={busy || !p || !batch.name?.trim()}>
            {busy ? "Importing…" : p ? `Import ${plural(p.count, "record")}` : "Import"}
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

function LibrarySheet({ api, invoke, workspaceId, viewer, notify, onChanged, onClose }: StageProps & { onClose: () => void }) {
  const collections = useLoad(() => invoke<Collection[]>("store_collections", {}, workspaceId).catch(() => [] as Collection[]), [workspaceId]);
  const [scope, setScope] = useState("all");
  const [text, setText] = useState("");
  // Records from the library came from a database search most of the time: say which (or later).
  const [batch, setBatch] = useState<Partial<Batch>>({ group: "databases", name: "" });
  const names = useSourceNames(invoke, workspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = collections.value?.find((c) => c.id === scope);
  return (
    <GlobalDialog label="Add records from the library" onClose={onClose} busy={busy}>
      <form
        className="kx-rv-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          const query: Record<string, unknown> = {};
          if (scope !== "all") query.collectionId = scope;
          if (text.trim()) query.text = text.trim();
          api
            .importLibrary({ query }, batch, viewer)
            .then(({ report }) => {
              notify(reportText(report), "ok");
              onChanged();
              onClose();
            })
            .catch((err) => setError(errorText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>Add records from the library</h2>
        <p>The records stay linked to their library sources, so their PDFs open at full text and their custom properties can drive rules.</p>
        <div className="kx-rv-form">
          <label className="kx-rv-field">
            <span>Which</span>
            <select className="kx-rv-select" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">The whole library</option>
              {collections.value?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.sourceCount})
                </option>
              ))}
            </select>
          </label>
          <label className="kx-rv-field">
            <span>Matching</span>
            <input className="kx-rv-input" value={text} placeholder="Optional: words, or a smart search like year:2015..2024" onChange={(e) => setText(e.target.value)} />
          </label>
        </div>
        <Provenance batch={batch} onChange={setBatch} kind="library" names={names} />
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary disabled={busy}>
            {busy ? "Adding…" : chosen ? `Add from ${chosen.name}` : "Add"}
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

function ManualSheet({ api, viewer, notify, onChanged, onClose, invoke, workspaceId }: StageProps & { onClose: () => void }) {
  const names = useSourceNames(invoke, workspaceId);
  const [record, setRecord] = useState<Partial<RecordMeta> & { authorsText?: string }>({});
  const [batch, setBatch] = useState<Partial<Batch>>({ group: "other", name: "Citation searching" });
  const [error, setError] = useState("");
  const set = (k: string, v: unknown) => setRecord((r) => ({ ...r, [k]: v }));
  return (
    <GlobalDialog label="Add a record" onClose={onClose}>
      <form
        className="kx-rv-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          const { authorsText, ...rest } = record;
          const authors = (authorsText ?? "").split(/;|\n/).map((a) => a.trim()).filter(Boolean);
          api
            .importRecords([{ ...rest, authors, year: rest.year ? Number(rest.year) : null }], batch, viewer)
            .then(({ report }) => {
              notify(reportText(report), "ok");
              onChanged();
              onClose();
            })
            .catch((err) => setError(errorText(err)));
        }}
      >
        <h2>Add a record</h2>
        <div className="kx-rv-form">
          <label className="kx-rv-field" data-wide>
            <span>Title</span>
            <input className="kx-rv-input" autoFocus required value={record.title ?? ""} onChange={(e) => set("title", e.target.value)} />
          </label>
          <label className="kx-rv-field" data-wide>
            <span>Authors</span>
            <input className="kx-rv-input" placeholder="Family, Given; Family, Given" value={record.authorsText ?? ""} onChange={(e) => set("authorsText", e.target.value)} />
          </label>
          <label className="kx-rv-field">
            <span>Year</span>
            <input className="kx-rv-input" inputMode="numeric" value={record.year ?? ""} onChange={(e) => set("year", e.target.value)} />
          </label>
          <label className="kx-rv-field">
            <span>DOI</span>
            <input className="kx-rv-input" value={record.doi ?? ""} onChange={(e) => set("doi", e.target.value)} />
          </label>
          <label className="kx-rv-field" data-wide>
            <span>Journal or source</span>
            <input className="kx-rv-input" value={record.journal ?? ""} onChange={(e) => set("journal", e.target.value)} />
          </label>
          <label className="kx-rv-field" data-wide>
            <span>Abstract</span>
            <textarea className="kx-rv-input" rows={4} value={record.abstractText ?? ""} onChange={(e) => set("abstractText", e.target.value)} />
          </label>
        </div>
        <Provenance batch={batch} onChange={setBatch} kind="other" names={names} />
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary disabled={!record.title?.trim()}>
            Add record
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

function Duplicates({ api, summary, viewer, notify, onChanged }: StageProps) {
  const pairs = useLoad(() => api.pairs(0, 1), [api, summary.openPairs]);
  const pair = pairs.value?.pairs[0];
  const decide = (choice: "duplicate" | "distinct", keep?: string) => {
    if (!pair?.a || !pair.b) return;
    api
      .resolvePair(pair.a.id, pair.b.id, choice, keep, viewer)
      .then(onChanged)
      .catch((e) => notify(errorText(e), "error"));
  };
  const side = (r: RecordMeta | null) =>
    r && (
      <div className="kx-rv-pair-side">
        <strong>{r.title}</strong>
        <small>{[r.authors.slice(0, 3).join("; "), r.year, r.journal].filter(Boolean).join(" · ")}</small>
        {r.doi && <small>doi:{r.doi}</small>}
        {r.abstractText && <p>{r.abstractText.slice(0, 320)}{r.abstractText.length > 320 ? "…" : ""}</p>}
      </div>
    );
  return (
    <section className="kx-rv-section kx-rv-dupes">
      <div className="kx-rv-section-head">
        <h2>Possible duplicates</h2>
        <span className="kx-rv-muted">{plural(summary.openPairs, "pair")} to check · {pair?.reason}</span>
      </div>
      {pair && (
        <div className="kx-rv-pair">
          {side(pair.a)}
          {side(pair.b)}
          <div className="kx-rv-pair-actions">
            <Btn onClick={() => decide("duplicate", pair.a?.id)} title="Keep the left record; the right one is removed as a duplicate">
              Same: keep left
            </Btn>
            <Btn onClick={() => decide("duplicate", pair.b?.id)} title="Keep the right record">
              Same: keep right
            </Btn>
            <Btn primary onClick={() => decide("distinct")}>
              Different records
            </Btn>
          </div>
        </div>
      )}
    </section>
  );
}
