// Bibliography import and export sheets (key-biblio in the host does the reading, writing,
// duplicate checks and undo): drop or pick a file or paste text, check a preview, choose
// where it goes and what happens to duplicates, follow the progress, read the summary
// and undo the whole import in one click. Export writes a selection, a collection or the
// library to BibTeX, BibLaTeX, RIS, CSL-JSON or CSV, copies it, or keeps it exported.
// Opened anywhere with `openBibImport()` / `openBibExport()`.
import { Button } from "@key/design-system";
import { SegmentedTabs } from "@key-reader/ui/SegmentedTabs";
import { useEffect, useMemo, useRef, useState } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon } from "./icons";
import { libraryChanged } from "./library-nav";
import { bridge, type Collection, type Invoke } from "./library-api";
import type { StatusItem } from "../shared/status-items";
import "./biblio.css";
import { Explain } from "./explain";

export type BibFormat = "bibtex" | "biblatex" | "ris" | "csl-json" | "csv" | "tsv" | "endnote-xml";
export const EXPORT_FORMATS: [BibFormat, string, string][] = [
  ["bibtex", "BibTeX", "bib"],
  ["biblatex", "BibLaTeX", "bib"],
  ["ris", "RIS", "ris"],
  ["csl-json", "CSL-JSON", "json"],
  ["csv", "CSV", "csv"],
];
const IMPORT_FORMATS: [BibFormat, string][] = [
  ["bibtex", "BibTeX or BibLaTeX"],
  ["ris", "RIS"],
  ["csl-json", "CSL-JSON"],
  ["csv", "CSV"],
  ["tsv", "TSV"],
  ["endnote-xml", "EndNote XML"],
];
const IMPORT_EXTENSIONS = ["bib", "bibtex", "ris", "json", "csv", "tsv", "txt", "xml", "enw"];

export interface ExportOptions {
  notes: boolean;
  abstracts: boolean;
  files: boolean;
  keywords: boolean;
  encoding: "unicode" | "latex";
}
export const DEFAULT_EXPORT_OPTIONS: ExportOptions = { notes: false, abstracts: true, files: false, keywords: true, encoding: "unicode" };

interface Warning {
  line: number;
  message: string;
}
interface DuplicateMatch {
  sourceId: string;
  kind: "exact" | "possible";
  reason: string;
  title: string;
}
interface PreviewRow {
  line: number;
  title: string;
  creators: string;
  year?: number | null;
  itemType: string;
  citationKey?: string | null;
  fields: string[];
  files: number;
  notes: number;
  duplicate?: DuplicateMatch | null;
}
interface Preview {
  format: BibFormat;
  formatLabel: string;
  total: number;
  rows: PreviewRow[];
  fields: [string, number][];
  warnings: Warning[];
  warningCount: number;
  exactDuplicates: number;
  possibleDuplicates: number;
  filesFound: number;
  filesMissing: number;
  notes: number;
  groups: string[];
}
export interface ImportReport {
  id: string;
  format: string;
  total: number;
  added: number;
  merged: number;
  skipped: number;
  flagged: [number, string, string][];
  skippedRows: [number, string, string][];
  errors: Warning[];
  warnings: Warning[];
  filesAttached: number;
  filesMissing: number;
  notesAdded: number;
  collectionsCreated: number;
  createdIds: string[];
  undone: boolean;
}
interface Progress {
  stage: string;
  done: number;
  total: number;
}
type Policy = "skip" | "merge" | "keep";

const n = (value: number) => value.toLocaleString();
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;
const message = (e: unknown) => String(e).replace(/^Error: /, "");
const FIELD_LABELS: Record<string, string> = {
  creators: "Creators",
  title: "Title",
  shortTitle: "Short title",
  date: "Date",
  containerTitle: "Journal / container",
  containerShort: "Abbreviation",
  volume: "Volume",
  issue: "Issue",
  pages: "Pages",
  edition: "Edition",
  series: "Series",
  publisher: "Publisher",
  place: "Place",
  institution: "Institution",
  genre: "Genre",
  doi: "DOI",
  isbn: "ISBN",
  issn: "ISSN",
  pmid: "PMID",
  pmcid: "PMCID",
  arxivId: "arXiv",
  url: "URL",
  accessed: "Accessed",
  abstract: "Abstract",
  language: "Language",
  rights: "Rights",
  citationKey: "Citation key",
  extra: "Extra",
  tags: "Tags",
};
const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field;
/** Kept fields (no column of their own) read as properties. */
const isKept = (field: string) => field.includes(".");

// ── Opening ────────────────────────────────────────────────────────────────────

export interface ImportRequest {
  workspaceId?: string;
  collectionId?: string | null;
  /** Files dropped on the library. */
  paths?: string[];
}
export interface ExportRequest {
  workspaceId?: string;
  ids?: string[];
  collectionId?: string | null;
}
export const openBibImport = (request: ImportRequest = {}) => window.dispatchEvent(new CustomEvent("key:open-bib-import", { detail: request }));
export const openBibExport = (request: ExportRequest = {}) => window.dispatchEvent(new CustomEvent("key:open-bib-export", { detail: request }));
/** Bibliography files among dropped paths (the rest are sources to add). */
export const isBibliographyPath = (path: string) => /\.(bib|bibtex|ris|enw|nbib)$/i.test(path);

/** The sheets, over any tab (mounted once by the shell). */
export function BiblioSheets({ invoke, workspaceId }: { invoke: Invoke; workspaceId?: string }) {
  const [importing, setImporting] = useState<ImportRequest>();
  const [exporting, setExporting] = useState<ExportRequest>();
  useEffect(() => {
    const onImport = (e: Event) => setImporting((e as CustomEvent<ImportRequest>).detail ?? {});
    const onExport = (e: Event) => setExporting((e as CustomEvent<ExportRequest>).detail ?? {});
    window.addEventListener("key:open-bib-import", onImport);
    window.addEventListener("key:open-bib-export", onExport);
    return () => {
      window.removeEventListener("key:open-bib-import", onImport);
      window.removeEventListener("key:open-bib-export", onExport);
    };
  }, []);
  const target = importing?.workspaceId ?? exporting?.workspaceId ?? workspaceId;
  return (
    <>
      {importing && target && <ImportSheet invoke={invoke} workspaceId={target} request={importing} onClose={() => setImporting(undefined)} />}
      {exporting && target && <ExportSheet invoke={invoke} workspaceId={target} request={exporting} onClose={() => setExporting(undefined)} />}
    </>
  );
}

function useCollections(invoke: Invoke, workspaceId: string) {
  const [collections, setCollections] = useState<Collection[]>([]);
  useEffect(() => {
    void invoke<Collection[]>("store_collections", {}, workspaceId)
      .then(setCollections)
      .catch(() => {});
  }, [invoke, workspaceId]);
  return collections;
}

/** Collections as an indented list, parents first. */
function collectionTree(collections: Collection[]) {
  const out: { collection: Collection; depth: number }[] = [];
  const walk = (parent: string | null | undefined, depth: number) => {
    for (const c of collections.filter((c) => (c.parentId ?? null) === (parent ?? null))) {
      out.push({ collection: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// ── Import ────────────────────────────────────────────────────────────────────

function ImportSheet({ invoke, workspaceId, request, onClose }: { invoke: Invoke; workspaceId: string; request: ImportRequest; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <GlobalDrawer onClose={onClose} busy={busy} presentation="sheet" label="Import references">
      <ImportFlow invoke={invoke} workspaceId={workspaceId} request={request} onClose={onClose} onBusy={setBusy} />
    </GlobalDrawer>
  );
}

function ImportFlow({ invoke, workspaceId, request, onClose, onBusy }: { invoke: Invoke; workspaceId: string; request: ImportRequest; onClose: () => void; onBusy: (busy: boolean) => void }) {
  const collections = useCollections(invoke, workspaceId);
  const [input, setInput] = useState<{ path?: string; text?: string; name?: string }>(() => (request.paths?.[0] ? { path: request.paths[0], name: request.paths[0].split("/").pop() } : {}));
  const [paste, setPaste] = useState("");
  const [format, setFormat] = useState<BibFormat | "">("");
  const [preview, setPreview] = useState<Preview>();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [targets, setTargets] = useState<string[]>(request.collectionId ? [request.collectionId] : []);
  const [policy, setPolicy] = useState<Policy>("skip");
  const [files, setFiles] = useState(true);
  const [notes, setNotes] = useState(true);
  const [groups, setGroups] = useState(true);
  const [progress, setProgress] = useState<Progress | "starting">();
  const [report, setReport] = useState<ImportReport>();
  const [undoing, setUndoing] = useState(false);
  const [dropping, setDropping] = useState(false);
  const hasInput = !!(input.path || input.text);

  // Read again whenever the input or the chosen format changes.
  useEffect(() => {
    if (!hasInput) return;
    let live = true;
    setReading(true);
    setError("");
    void invoke<Preview>("store_biblio_preview", { path: input.path ?? null, text: input.text ?? null, fileName: input.name ?? null, format: format || null }, workspaceId)
      .then((p) => {
        if (!live) return;
        setPreview(p);
        if (!format) setFormat(p.format === "biblatex" ? "bibtex" : p.format);
      })
      .catch((e) => live && (setPreview(undefined), setError(message(e))))
      .finally(() => live && setReading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, format, workspaceId]);

  const running = !!progress;
  useEffect(() => onBusy(running || undoing), [running, undoing, onBusy]);

  const chooseFile = async () => {
    const path = await bridge().choosePath?.({ mode: "open", title: "Import references", extensions: IMPORT_EXTENSIONS });
    if (path) {
      setFormat("");
      setInput({ path, name: path.split("/").pop() });
    }
  };
  const start = async () => {
    setError("");
    setProgress("starting");
    const timer = setInterval(() => {
      void invoke<Progress | null>("store_biblio_progress", {}, workspaceId)
        .then((p) => p && setProgress(p))
        .catch(() => {});
    }, 250);
    try {
      const result = await invoke<ImportReport>(
        "store_biblio_import",
        {
          path: input.path ?? null,
          text: input.text ?? null,
          fileName: input.name ?? null,
          format: format || null,
          options: { collectionIds: targets, duplicates: policy, files, notes, groups },
        },
        workspaceId,
      );
      setReport(result);
      libraryChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      clearInterval(timer);
      setProgress(undefined);
    }
  };
  const undo = async () => {
    if (!report) return;
    setUndoing(true);
    try {
      setReport(await invoke<ImportReport>("store_biblio_undo", { id: report.id }, workspaceId));
      libraryChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setUndoing(false);
    }
  };

  const step = report ? "done" : running ? "running" : hasInput ? "preview" : "source";
  const title = report ? (report.undone ? "Import undone" : "Import finished") : "Import references";
  const lede =
    step === "source"
      ? "BibTeX, BibLaTeX, RIS, CSL-JSON, CSV or EndNote XML. Fields Key has no place for are kept as properties."
      : step === "preview" && preview
        ? `${preview.formatLabel} · ${plural(preview.total, "entry", "entries")}${input.name ? ` from ${input.name}` : ""}`
        : step === "done" && report
          ? report.undone
            ? "Everything the import added was removed and merged sources were put back."
            : `${report.format}${input.name ? ` from ${input.name}` : ""}`
          : "";
  const toImport = preview ? preview.total - (policy === "skip" ? preview.exactDuplicates : 0) : 0;
  return (
    <div
      className="key-property-editor kx-bib-import"
      role="dialog"
      aria-label={title}
      data-step={step}
      data-modal-view={step}
      onDragOver={(e) => {
        if (step !== "source" && step !== "preview") return;
        if ([...e.dataTransfer.types].includes("Files")) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        const file = e.dataTransfer.files[0];
        if (!file) return;
        e.preventDefault();
        const path = bridge().pathForFile(file);
        setFormat("");
        if (path) setInput({ path, name: file.name });
        else void file.text().then((text) => setInput({ text, name: file.name }));
      }}
    >
      <header>
        <h2>{title}</h2>
        <p>
          {lede}
          {step === "source" && (
            <>
              {" "}
              <Explain help="import.formats" label="Which file do I need?" />
            </>
          )}
        </p>
        <button className="kx-sheet-close" aria-label="Close" disabled={running || undoing} onClick={onClose}>
          <Icon name="close" size={10} />
        </button>
      </header>
      <div className="key-property-body">
        {step === "source" && (
          <div className="kx-bib-source">
            <button type="button" className="kx-bib-drop" data-dropping={dropping || undefined} onClick={() => void chooseFile()}>
              <span className="kx-bib-drop-icon">
                <Icon name="upload" size={18} />
              </span>
              <strong>Drop a bibliography file here</strong>
              <span>or click to choose one</span>
            </button>
            <label className="kx-bib-paste">
              <span>Or paste references</span>
              <textarea
                aria-label="References to import"
                spellCheck={false}
                placeholder={"@article{key,\n  title = {…},\n}"}
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
              />
            </label>
          </div>
        )}
        {step === "preview" && (
          <ImportPreview
            preview={preview}
            reading={reading}
            format={format}
            onFormat={setFormat}
            collections={collections}
            targets={targets}
            onTargets={setTargets}
            policy={policy}
            onPolicy={setPolicy}
            files={files}
            onFiles={setFiles}
            notes={notes}
            onNotes={setNotes}
            groups={groups}
            onGroups={setGroups}
          />
        )}
        {step === "running" && (
          <div className="kx-bib-progress" aria-live="polite">
            <strong>{typeof progress === "object" ? `${progress.stage}…` : "Starting…"}</strong>
            {typeof progress === "object" && progress.total > 0 && progress.stage !== "Reading" ? <progress max={progress.total} value={progress.done} /> : <progress />}
            <small>{typeof progress === "object" && progress.total > 0 && progress.stage !== "Reading" ? `${n(progress.done)} of ${n(progress.total)}` : preview ? plural(preview.total, "entry", "entries") : ""}</small>
          </div>
        )}
        {step === "done" && report && <ImportSummary report={report} />}
        {error && <p className="kx-inline-error">{error}</p>}
      </div>
      <footer>
        {step === "preview" && preview && (
          <span className="kx-bib-count" aria-live="polite">
            {toImport === preview.total ? plural(toImport, "entry", "entries") : `${n(toImport)} of ${plural(preview.total, "entry", "entries")}`}
          </span>
        )}
        <span className="kx-footer-spacer" />
        {step === "source" && (
          <>
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" className="key-property-primary" disabled={!paste.trim()} onClick={() => setInput({ text: paste })}>
              Continue
            </Button>
          </>
        )}
        {step === "preview" && (
          <>
            <Button
              type="button"
              onClick={() => {
                setInput({});
                setPreview(undefined);
                setFormat("");
                setError("");
              }}
            >
              Back
            </Button>
            <Button variant="primary" className="key-property-primary" disabled={!preview || reading || !preview.total} onClick={() => void start()}>
              Import {preview ? plural(toImport, "entry", "entries") : ""}
            </Button>
          </>
        )}
        {step === "done" && report && (
          <>
            {!report.undone && (report.added > 0 || report.merged > 0) && (
              <Button type="button" disabled={undoing} onClick={() => void undo()}>
                <Icon name="undo" size={12} /> {undoing ? "Undoing…" : "Undo import"}
              </Button>
            )}
            <Button variant="primary" className="key-property-primary" disabled={undoing} onClick={onClose}>
              Done
            </Button>
          </>
        )}
      </footer>
    </div>
  );
}

function Check({ checked, onChange, label, detail, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; detail?: string; disabled?: boolean }) {
  return (
    <label className="kx-bib-check" data-disabled={disabled || undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {detail && <small>{detail}</small>}
      </span>
    </label>
  );
}

function ImportPreview(props: {
  preview?: Preview;
  reading: boolean;
  format: BibFormat | "";
  onFormat: (format: BibFormat) => void;
  collections: Collection[];
  targets: string[];
  onTargets: (ids: string[]) => void;
  policy: Policy;
  onPolicy: (policy: Policy) => void;
  files: boolean;
  onFiles: (value: boolean) => void;
  notes: boolean;
  onNotes: (value: boolean) => void;
  groups: boolean;
  onGroups: (value: boolean) => void;
}) {
  const { preview, reading, collections, targets, onTargets } = props;
  const tree = useMemo(() => collectionTree(collections), [collections]);
  const [showWarnings, setShowWarnings] = useState(false);
  if (!preview) return <div className="kx-bib-reading" aria-busy={reading}>{reading ? "Reading…" : null}</div>;
  const columns = preview.fields.filter(([f]) => !isKept(f));
  const kept = preview.fields.filter(([f]) => isKept(f));
  return (
    <div className="kx-bib-preview" aria-busy={reading}>
      <div className="kx-bib-preview-main">
        <div className="kx-bib-facts">
          <span>
            <Icon name="quote" size={12} /> {plural(preview.total, "entry", "entries")}
          </span>
          {preview.exactDuplicates > 0 && (
            <span data-tone="warning">
              <Icon name="layers" size={12} /> {n(preview.exactDuplicates)} already in the library
            </span>
          )}
          {preview.possibleDuplicates > 0 && (
            <span data-tone="warning">
              <Icon name="layers" size={12} /> {n(preview.possibleDuplicates)} possibly already in the library
            </span>
          )}
          {preview.filesFound + preview.filesMissing > 0 && (
            <span>
              <Icon name="filePdf" size={12} /> {plural(preview.filesFound, "file")} found{preview.filesMissing ? `, ${n(preview.filesMissing)} missing` : ""}
            </span>
          )}
          {preview.notes > 0 && (
            <span>
              <Icon name="note" size={12} /> {plural(preview.notes, "note")}
            </span>
          )}
          {preview.warningCount > 0 && (
            <button type="button" data-tone="error" onClick={() => setShowWarnings((s) => !s)} aria-expanded={showWarnings}>
              <Icon name="warning" size={12} /> {plural(preview.warningCount, "problem")}
            </button>
          )}
        </div>
        {showWarnings && <WarningList warnings={preview.warnings} total={preview.warningCount} />}
        <div className="kx-bib-table" role="table" aria-label="First entries">
          <div role="row" className="kx-bib-row kx-bib-head">
            <span role="columnheader">Title</span>
            <span role="columnheader">Authors</span>
            <span role="columnheader">Year</span>
            <span role="columnheader">Key</span>
          </div>
          {preview.rows.map((row, i) => (
            <div role="row" key={i} className="kx-bib-row" data-duplicate={row.duplicate?.kind}>
              <span role="cell" className="kx-bib-title">
                <span title={row.title}>{row.title || "Untitled"}</span>
                <small>
                  {row.fields.filter((f) => !["title", "creators", "date", "citationKey"].includes(f)).slice(0, 7).map(fieldLabel).join(" · ")}
                  {row.duplicate && <em> · {row.duplicate.kind === "exact" ? row.duplicate.reason : "Possible duplicate"}</em>}
                </small>
              </span>
              <span role="cell">{row.creators}</span>
              <span role="cell">{row.year ?? ""}</span>
              <span role="cell" className="kx-bib-key">{row.citationKey ?? ""}</span>
            </div>
          ))}
          {preview.total > preview.rows.length && <p className="kx-bib-more">and {plural(preview.total - preview.rows.length, "more entry", "more entries")}</p>}
        </div>
        <details className="kx-bib-fields">
          <summary>
            Fields found: {columns.length} with a column{kept.length ? `, ${kept.length} kept as properties` : ""}
          </summary>
          <div>
            {[...columns, ...kept].map(([field, count]) => (
              <span key={field} className="kx-bib-chip" data-kept={isKept(field) || undefined} title={`${n(count)} ${count === 1 ? "entry" : "entries"}`}>
                {fieldLabel(field)} <small>{n(count)}</small>
              </span>
            ))}
          </div>
        </details>
      </div>
      <aside className="kx-bib-options">
        <label className="kx-bib-field">
          <span>Format</span>
          <select value={props.format} onChange={(e) => props.onFormat(e.target.value as BibFormat)} aria-label="Format">
            {IMPORT_FORMATS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="kx-bib-field">
          <span>Add to</span>
          <div className="kx-bib-collections" role="group" aria-label="Collections">
            {tree.length === 0 && <small>No collections yet: entries go to All sources.</small>}
            {tree.map(({ collection, depth }) => (
              <label key={collection.id} style={{ paddingLeft: 6 + depth * 14 }}>
                <input
                  type="checkbox"
                  checked={targets.includes(collection.id)}
                  onChange={(e) => onTargets(e.target.checked ? [...targets, collection.id] : targets.filter((id) => id !== collection.id))}
                />
                <Icon name="collection" size={12} />
                <span>{collection.name}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="kx-bib-field" role="radiogroup" aria-label="Duplicates">
          <span>
            Already in the library <Explain help="import.duplicates" />
          </span>
          {(
            [
              ["skip", "Skip", "Same DOI, ISBN, PMID or arXiv ID: left out. Same title: imported and listed."],
              ["merge", "Merge", "Fill the existing source’s empty fields and add tags and notes."],
              ["keep", "Import anyway", "Duplicates can be merged later."],
            ] as [Policy, string, string][]
          ).map(([id, label, detail]) => (
            <label key={id} className="kx-bib-radio">
              <input type="radio" name="kx-bib-policy" checked={props.policy === id} onChange={() => props.onPolicy(id)} />
              <span>
                {label}
                <small>{detail}</small>
              </span>
            </label>
          ))}
        </div>
        <div className="kx-bib-field">
          <span>Also bring</span>
          <Check checked={props.files} onChange={props.onFiles} label="Attached files" detail={preview.filesFound ? `${plural(preview.filesFound, "file")} on this Mac` : "None found"} disabled={!preview.filesFound} />
          <Check checked={props.notes} onChange={props.onNotes} label="Notes" disabled={!preview.notes} />
          <Check checked={props.groups} onChange={props.onGroups} label="Groups as collections" detail={preview.groups.length ? preview.groups.slice(0, 3).join(", ") + (preview.groups.length > 3 ? "…" : "") : undefined} disabled={!preview.groups.length} />
        </div>
      </aside>
    </div>
  );
}

function WarningList({ warnings, total }: { warnings: Warning[]; total: number }) {
  return (
    <ul className="kx-bib-warnings">
      {warnings.map((w, i) => (
        <li key={i}>
          {w.line > 0 && <span className="kx-bib-line">Line {w.line}</span>}
          {w.message}
        </li>
      ))}
      {total > warnings.length && <li>and {plural(total - warnings.length, "more")}</li>}
    </ul>
  );
}

function ImportSummary({ report }: { report: ImportReport }) {
  const lines = [
    [report.added, `${plural(report.added, "source")} added`],
    [report.merged, `${plural(report.merged, "source")} merged into existing ones`],
    [report.skipped, `${plural(report.skipped, "duplicate")} skipped`],
    [report.flagged.length, `${plural(report.flagged.length, "possible duplicate")} imported to review`],
    [report.filesAttached, `${plural(report.filesAttached, "file")} attached`],
    [report.filesMissing, `${plural(report.filesMissing, "file")} not found`],
    [report.notesAdded, `${plural(report.notesAdded, "note")} added`],
    [report.collectionsCreated, `${plural(report.collectionsCreated, "collection")} created`],
  ].filter(([count]) => count) as [number, string][];
  const problems = [...report.errors, ...report.warnings];
  return (
    <div className="kx-bib-summary">
      <span className="kx-bib-done" data-undone={report.undone || undefined}>
        <Icon name={report.undone ? "undo" : "check"} size={16} />
      </span>
      <ul>
        {report.undone ? <li>The library is as it was before the import.</li> : lines.map(([, text]) => <li key={text}>{text}</li>)}
      </ul>
      {!report.undone && problems.length > 0 && (
        <>
          <h3>{plural(problems.length, "problem")}</h3>
          <WarningList warnings={problems.slice(0, 100)} total={problems.length} />
        </>
      )}
    </div>
  );
}

// ── Export ────────────────────────────────────────────────────────────────────

type ExportScope = "selection" | "collection" | "library";

function ExportSheet({ invoke, workspaceId, request, onClose }: { invoke: Invoke; workspaceId: string; request: ExportRequest; onClose: () => void }) {
  const collections = useCollections(invoke, workspaceId);
  const [scope, setScope] = useState<ExportScope>(request.ids?.length ? "selection" : request.collectionId ? "collection" : "library");
  const [collectionId, setCollectionId] = useState(request.collectionId ?? "");
  const [format, setFormat] = useState<BibFormat>(() => (localStorage.getItem("key.export.format") as BibFormat) || "bibtex");
  const [options, setOptions] = useState<ExportOptions>(() => {
    try {
      return { ...DEFAULT_EXPORT_OPTIONS, ...JSON.parse(localStorage.getItem("key.export.options") || "{}") };
    } catch {
      return DEFAULT_EXPORT_OPTIONS;
    }
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    try {
      localStorage.setItem("key.export.format", format);
      localStorage.setItem("key.export.options", JSON.stringify(options));
    } catch {}
  }, [format, options]);
  useEffect(() => {
    if (!collectionId && collections[0]) setCollectionId(collections[0].id);
  }, [collections, collectionId]);
  const tree = useMemo(() => collectionTree(collections), [collections]);
  const args = () => ({
    format,
    options,
    scope: scope === "selection" ? { ids: request.ids } : scope === "collection" ? { collectionId } : {},
  });
  const extension = EXPORT_FORMATS.find(([id]) => id === format)?.[2] ?? "txt";
  const baseName = scope === "collection" ? collections.find((c) => c.id === collectionId)?.name ?? "Collection" : scope === "selection" ? "References" : "Library";
  const run = async (what: "copy" | "save" | "keep") => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (what === "copy") {
        const result = await invoke<{ text: string; count: number }>("store_biblio_export", args(), workspaceId);
        await navigator.clipboard.writeText(result.text);
        setNotice(`Copied ${plural(result.count, "reference")}`);
        return;
      }
      const path = await bridge().choosePath?.({ mode: "save", title: what === "keep" ? "Keep exported to" : "Export references", defaultPath: `${baseName}.${extension}`, extensions: [extension] });
      if (!path) return;
      if (what === "save") {
        const result = await invoke<{ count: number }>("store_biblio_export", { ...args(), path }, workspaceId);
        setNotice(`Exported ${plural(result.count, "reference")}`);
      } else {
        const target = await invoke<AutoExportTarget>(
          "store_autoexport_save",
          { target: { id: "", collectionId: scope === "collection" ? collectionId : null, format, path, options } },
          workspaceId,
        );
        if (target.lastError) throw new Error(target.lastError);
        setNotice("Key keeps this file up to date. Change it in Settings › Citation keys & export.");
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const bib = format === "bibtex" || format === "biblatex";
  return (
    <GlobalDrawer onClose={onClose} busy={busy} presentation="sheet" label="Export references">
      <div className="key-property-editor kx-bib-export" role="dialog" aria-label="Export references" data-modal-view="export">
        <header>
          <h2>Export references</h2>
          <p>
            A file of references for another app. Entries are ordered by citation key, so a file exported again only changes where the library did. <Explain help="export.formats" label="Which format?" />
          </p>
          <button className="kx-sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={10} />
          </button>
        </header>
        <div className="key-property-body">
          <div className="kx-bib-export-grid">
            <span className="kx-bib-label">Export</span>
            <div>
              <SegmentedTabs
                label="What to export"
                value={scope}
                onChange={(value) => setScope(value as ExportScope)}
                tabs={[
                  ...(request.ids?.length ? [{ id: "selection", label: `Selection (${n(request.ids.length)})` }] : []),
                  ...(collections.length ? [{ id: "collection", label: "Collection" }] : []),
                  { id: "library", label: "Library" },
                ]}
              />
              {scope === "collection" && (
                <select className="kx-bib-select" value={collectionId} onChange={(e) => setCollectionId(e.target.value)} aria-label="Collection">
                  {tree.map(({ collection, depth }) => (
                    <option key={collection.id} value={collection.id}>
                      {"  ".repeat(depth) + collection.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <span className="kx-bib-label">Format</span>
            <div className="kx-bib-formats" role="radiogroup" aria-label="Format">
              {EXPORT_FORMATS.map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={format === id} onClick={() => setFormat(id)}>
                  {label}
                </button>
              ))}
            </div>
            {bib && (
              <>
                <span className="kx-bib-label">Characters</span>
                <div className="kx-bib-encoding" role="radiogroup" aria-label="Characters">
                  <label className="kx-bib-radio">
                    <input type="radio" name="kx-bib-encoding" checked={options.encoding === "unicode"} onChange={() => setOptions({ ...options, encoding: "unicode" })} />
                    <span>
                      Unicode<small>For biber and modern BibTeX (Overleaf’s default).</small>
                    </span>
                  </label>
                  <label className="kx-bib-radio">
                    <input type="radio" name="kx-bib-encoding" checked={options.encoding === "latex"} onChange={() => setOptions({ ...options, encoding: "latex" })} />
                    <span>
                      LaTeX escapes<small>{"Accents as {\\\"u}, for classic BibTeX."}</small>
                    </span>
                  </label>
                </div>
              </>
            )}
            <span className="kx-bib-label">Include</span>
            <div className="kx-bib-includes">
              <Check checked={options.abstracts} onChange={(abstracts) => setOptions({ ...options, abstracts })} label="Abstracts" />
              <Check checked={options.keywords} onChange={(keywords) => setOptions({ ...options, keywords })} label="Tags as keywords" />
              <Check checked={options.notes} onChange={(notes) => setOptions({ ...options, notes })} label="Notes" />
              <Check checked={options.files} onChange={(files) => setOptions({ ...options, files })} label="File paths" />
            </div>
          </div>
          {notice && (
            <p className="kx-bib-notice" role="status">
              <Icon name="check" size={12} /> {notice}
            </p>
          )}
          {error && <p className="kx-inline-error">{error}</p>}
        </div>
        <footer>
          {scope !== "selection" && (
            <Button type="button" disabled={busy} onClick={() => void run("keep")} title="Rewrite the file whenever the library changes">
              Keep exported…
            </Button>
          )}
          <span className="kx-footer-spacer" />
          <Button type="button" disabled={busy} onClick={() => void run("copy")}>
            <Icon name="copy" size={12} /> Copy
          </Button>
          <Button variant="primary" className="key-property-primary" disabled={busy || (scope === "collection" && !collectionId)} onClick={() => void run("save")}>
            Export…
          </Button>
        </footer>
      </div>
    </GlobalDrawer>
  );
}

// ── Auto-export status ────────────────────────────────────────────────────────

export interface AutoExportTarget {
  id: string;
  collectionId?: string | null;
  format: BibFormat;
  path: string;
  options: ExportOptions;
  lastWritten?: number | null;
  lastChecked?: number | null;
  lastError?: string | null;
  count?: number | null;
}

/** A status bar item while an auto-export fails. */
export function useAutoExportStatus(invoke: Invoke, workspaceId?: string): StatusItem | undefined {
  const [failing, setFailing] = useState<AutoExportTarget[]>([]);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => {
    if (!workspaceId) return;
    const check = () =>
      void invoke<AutoExportTarget[]>("store_autoexport_targets", {}, workspaceId)
        .then((targets) => setFailing(targets.filter((t) => t.lastError)))
        .catch(() => {});
    check();
    timer.current = setInterval(check, 15_000);
    window.addEventListener("key:autoexport-changed", check);
    return () => {
      clearInterval(timer.current);
      window.removeEventListener("key:autoexport-changed", check);
    };
  }, [invoke, workspaceId]);
  if (!failing.length) return undefined;
  const name = failing[0].path.split("/").pop();
  return {
    id: "autoexport",
    label: failing.length === 1 ? `Export to ${name} failed` : `${failing.length} auto-exports failed`,
    tone: "error",
    title: `${failing.map((t) => `${t.path}: ${t.lastError}`).join("\n")}\n\nOpen Settings › Citation keys & export`,
    priority: 60,
  };
}
