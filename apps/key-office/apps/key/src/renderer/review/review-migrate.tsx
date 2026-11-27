// Moving an in-progress review into Key: a CSV exported by Covidence, Rayyan or another tool,
// previewed with a column mapping the reviewer can change (key-review's migrate.rs does the
// reading and the import).
import { useEffect, useMemo, useState } from "react";
import { Explain } from "../explain";
import { GlobalDialog } from "../GlobalDrawer";
import type { Invoke } from "../library-api";
import type { Member } from "./review-api";
import { Btn, Segmented, errorText } from "./review-ui";
import { synthesisApi, type MigrateMapping, type MigratePreview } from "./review-synthesis-api";
import "./review-synthesis.css";

const OPEN = "key:review-migrate";
export const openMigrate = () => window.dispatchEvent(new CustomEvent(OPEN));

const FIELDS: [string, string][] = [
  ["title", "Title"],
  ["authors", "Authors"],
  ["year", "Year"],
  ["journal", "Journal"],
  ["doi", "DOI"],
  ["pmid", "PubMed ID"],
  ["abstract", "Abstract"],
  ["volume", "Volume"],
  ["issue", "Issue"],
  ["pages", "Pages"],
  ["notes", "Notes"],
  ["labels", "Labels or tags"],
  ["decision", "Decision"],
  ["reasons", "Exclusion reason"],
  ["id", "Their record ID"],
];

export function MigrateHost({ invoke, workspaceId, reviewId, viewer, team, onDone }: { invoke: Invoke; workspaceId: string; reviewId: string; viewer: string; team: Member[]; onDone: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPEN, on);
    return () => window.removeEventListener(OPEN, on);
  }, []);
  const api = useMemo(() => synthesisApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  return open ? <MigrateSheet api={api} viewer={viewer} team={team} onClose={() => setOpen(false)} onDone={onDone} /> : null;
}

function MigrateSheet({ api, viewer, team, onClose, onDone }: { api: ReturnType<typeof synthesisApi>; viewer: string; team: Member[]; onClose: () => void; onDone: (text: string) => void }) {
  const [text, setText] = useState<string>();
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<MigratePreview>();
  const [mapping, setMapping] = useState<MigrateMapping>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choose = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      setName(f.name);
      void f.text().then((t) => {
        setText(t);
        api
          .migratePreview(t)
          .then((p) => {
            setPreview(p);
            setMapping(p.mapping);
            setError("");
          })
          .catch((e) => setError(errorText(e)));
      });
    };
    input.click();
  };
  const setColumn = (field: string, col: string) => {
    if (!mapping) return;
    const columns = { ...mapping.columns };
    if (col === "") delete columns[field];
    else columns[field] = Number(col);
    setMapping({ ...mapping, columns });
  };
  return (
    <GlobalDialog label="Move a review into Key" onClose={onClose} busy={busy}>
      <form
        className="kx-rv-dialog kx-rv-migrate"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text || !mapping) return;
          setBusy(true);
          api
            .migrate(text, mapping, viewer)
            .then((r) => {
              onDone(`Added ${r.added} records with ${r.decisions} decisions${r.leftUndecided ? `; ${r.leftUndecided} where reviewers disagreed are left to screen` : ""}${r.duplicates ? `; ${r.duplicates} duplicates of records already here` : ""}.`);
              onClose();
            })
            .catch((err) => setError(errorText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>
          Move a review into Key <Explain help="review.migrate" />
        </h2>
        <p>Choose a CSV exported from Covidence (Export › References, one list per stage) or Rayyan (Export, articles file), or any spreadsheet of records with decisions.</p>
        <div className="kx-rv-inline">
          <Btn icon="upload" onClick={choose}>
            {name ? "Another file…" : "Choose a CSV…"}
          </Btn>
          {preview && (
            <span className="kx-rv-muted">
              {name}: {preview.rows} records, read as {preview.format === "covidence" ? "a Covidence export" : preview.format === "rayyan" ? "a Rayyan export" : "a CSV"}
            </span>
          )}
        </div>
        {preview?.notes.map((n) => (
          <p key={n} className="kx-rv-more-warn">
            {n}
          </p>
        ))}
        {preview && mapping && (
          <>
            <div className="kx-rv-migrate-map">
              {FIELDS.map(([field, label]) => (
                <label key={field} className="kx-rv-field">
                  <span>{label}</span>
                  <select className="kx-rv-select" value={mapping.columns[field] ?? ""} onChange={(e) => setColumn(field, e.target.value)} aria-label={`Column for ${label}`}>
                    <option value="">—</option>
                    {preview.columns.map((c, i) => (
                      <option key={i} value={i}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="kx-rv-more-controls">
              <div className="kx-rv-field">
                <span>Decisions are for</span>
                <Segmented label="Stage" value={mapping.stage} onChange={(stage) => setMapping({ ...mapping, stage })} options={[["ta", "Title and abstract"], ["ft", "Full text"]]} />
              </div>
              <label className="kx-rv-field">
                <span>Decisions come from</span>
                <select className="kx-rv-select" value={mapping.decisions} onChange={(e) => setMapping({ ...mapping, decisions: e.target.value as MigrateMapping["decisions"] })} aria-label="Decisions come from">
                  <option value="rayyan">Rayyan's notes (each reviewer)</option>
                  <option value="column">The decision column</option>
                  <option value="list">The whole list</option>
                  <option value="none">No decisions: records only</option>
                </select>
              </label>
              {mapping.decisions === "list" && (
                <div className="kx-rv-field">
                  <span>Every record in this file was</span>
                  <Segmented label="List decision" value={mapping.listDecision || "include"} onChange={(listDecision) => setMapping({ ...mapping, listDecision })} options={[["include", "Included"], ["exclude", "Excluded"], ["maybe", "Maybe"]]} />
                </div>
              )}
            </div>
            {mapping.decisions === "rayyan" && preview.reviewers.length > 0 && (
              <div className="kx-rv-migrate-map">
                {preview.reviewers.map((who) => (
                  <label key={who} className="kx-rv-field">
                    <span>{who} is</span>
                    <select className="kx-rv-select" value={mapping.reviewers[who] ?? ""} onChange={(e) => setMapping({ ...mapping, reviewers: { ...mapping.reviewers, [who]: e.target.value } })} aria-label={`Team member for ${who}`}>
                      <option value="">Not matched (agreed decisions only)</option>
                      {team.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            <div className="kx-rv-migrate-sample">
              <table className="kx-rv-table">
                <thead>
                  <tr>
                    {preview.columns.map((c, i) => (
                      <th key={i}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((r, i) => (
                    <tr key={i}>
                      {preview.columns.map((_, j) => (
                        <td key={j} title={r[j]}>
                          {r[j]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary disabled={busy || !preview || mapping?.columns.title == null}>
            {busy ? "Importing…" : `Import ${preview?.rows ?? ""} records`}
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}
