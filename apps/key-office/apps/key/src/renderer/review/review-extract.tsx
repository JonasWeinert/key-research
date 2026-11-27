// Extraction: the included studies on the left, the chosen study's forms on the right. Each
// value is saved as it is entered, with its quote and page (typed, or taken from a highlight in
// Key's reader). With two extractors, differing values show side by side until one is agreed.
import { useCallback, useEffect, useState } from "react";
import { EmptyState, Hint } from "../explain";
import { downloadText } from "../db-ui";
import { Icon } from "../icons";
import { bridge } from "../library-api";
import { highlightPage, type Highlight } from "../item-actions";
import { plural, type ExtractionView, type Field, type Form } from "./review-api";
import { Btn, MenuButton, errorText, useLoad } from "./review-ui";
import { openFullText } from "./review-screen";
import type { StageProps } from "./ReviewPage";

type Slot = ExtractionView["values"][string];

const display = (v: unknown): string => {
  if (v == null || v === "") return "";
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? Object.values(x as object).filter((y) => y !== "" && y != null).join(" / ") : String(x))).join("; ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
};

export function Extraction(props: StageProps) {
  const { api, summary, viewer, notify } = props;
  const studies = useLoad(() => api.studies(viewer), [api, viewer, summary.events]);
  const [current, setCurrent] = useState<string>();
  useEffect(() => {
    if (!current && studies.value?.studies.length) setCurrent(studies.value.studies[0].id);
  }, [studies.value, current]);
  const exportFile = (kind: string) => api.exportFile(kind, viewer).then((f) => downloadText(f.filename, f.content, f.mime)).catch((e) => notify(errorText(e), "error"));
  if (!summary.included) return <EmptyState help="empty.review.extraction" icon="table" action={{ label: "Go to full-text screening", onClick: () => props.go("ft") }} learnMore="review.extraction" />;
  const list = studies.value?.studies ?? [];
  return (
    <div className="kx-rv-extract">
      <aside className="kx-rv-studies" aria-label="Included studies">
        <div className="kx-rv-studies-head">
          <strong>{plural(list.length, "study", "studies")}</strong>
          <MenuButton
            label="Export extraction"
            icon="download"
            items={[
              { label: "Extraction table (CSV, one row per study)", run: () => void exportFile("extraction") },
              { label: "Long format (CSV, one row per value)", run: () => void exportFile("extraction-long") },
              { label: "Outcome data for R (meta, metafor)", run: () => void exportFile("outcomes") },
              { label: "Outcome data for RevMan (CSV)", run: () => void exportFile("revman") },
            ]}
          />
        </div>
        <ul>
          {list.map((s) => (
            <li key={s.id}>
              <button type="button" aria-current={current === s.id || undefined} onClick={() => setCurrent(s.id)}>
                <span className="kx-rv-study-title">{s.byline || s.title}</span>
                <small>{s.title}</small>
                <span className="kx-rv-study-state">
                  <span className="kx-rv-meter" aria-label={`${s.mine} of ${s.fields} fields`}>
                    <span style={{ width: `${s.fields ? Math.min(100, (s.mine / s.fields) * 100) : 0}%` }} />
                  </span>
                  {s.conflicts > 0 && <span className="kx-rv-pill" data-tone="warning">{s.conflicts} differ</span>}
                  {s.missingRequired > 0 && <span className="kx-rv-pill" data-tone="muted">{s.missingRequired} required left</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="kx-rv-extract-body">{current && <StudyForm key={current} {...props} recordId={current} sourceId={list.find((s) => s.id === current)?.sourceId ?? null} onSaved={studies.reload} />}</section>
    </div>
  );
}

function StudyForm(props: StageProps & { recordId: string; sourceId: string | null; onSaved: () => void }) {
  const { api, viewer, recordId, notify, invoke, workspaceId, sourceId } = props;
  const view = useLoad(() => api.extraction(recordId, viewer), [api, recordId, viewer]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const refresh = useCallback(() => {
    if (sourceId) void invoke<Highlight[]>("library_annotations", { hash: sourceId }, workspaceId).then((h) => setHighlights((h ?? []).filter((x) => x.text))).catch(() => {});
  }, [invoke, workspaceId, sourceId]);
  useEffect(() => {
    refresh();
    const off = bridge().on?.("library-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      off?.();
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  const save = (form: Form, field: Field, value: unknown, extra: { quote?: string; page?: number | null; final?: boolean }) =>
    api
      .extract(recordId, form.id, field.id, value, { ...extra, sourceId }, viewer)
      .then(() => {
        view.reload();
        props.onSaved();
      })
      .catch((e) => notify(errorText(e), "error"));
  if (!view.value) return <div className="kx-rv-loading" aria-busy="true" />;
  return (
    <>
      <div className="kx-rv-extract-tools">
        {sourceId ? (
          <Btn icon="filePdf" onClick={() => void openFullText(invoke, workspaceId, sourceId).then((ok) => !ok && notify("This study has no PDF yet: find it at full text", "error")).catch((e) => notify(errorText(e), "error"))}>
            Open full text beside
          </Btn>
        ) : (
          <span className="kx-rv-muted">No full text linked</span>
        )}
        {highlights.length > 0 && <span className="kx-rv-muted">{plural(highlights.length, "highlight")} to quote from</span>}
      </div>
      {view.value.forms.map((form) => (
        <div key={form.id} className="kx-rv-xform">
          <h2>{form.name}</h2>
          {form.sections.map((section) => (
            <fieldset key={section.id} className="kx-rv-xsection">
              <legend>{section.title}</legend>
              {section.guidance && <p className="kx-rv-muted">{section.guidance}</p>}
              {section.fields.map((field) => (
                <FieldInput key={field.id} form={form} field={field} needQuote={field.quote || props.summary.protocol.rules.quoteRequired} slot={view.value!.values[`${form.id}/${field.id}`]} highlights={highlights} extractors={view.value!.extractors} onSave={(value, extra) => save(form, field, value, extra)} canAgree={props.summary.canResolve || props.summary.protocol.rules.conflicts === "consensus"} />
              ))}
            </fieldset>
          ))}
        </div>
      ))}
      <Hint help="review.extraction.quotes" />
    </>
  );
}

function FieldInput({ field, slot, highlights, onSave, extractors, canAgree, needQuote }: { form: Form; field: Field; needQuote: boolean; slot: Slot | undefined; highlights: Highlight[]; onSave: (value: unknown, extra: { quote?: string; page?: number | null; final?: boolean }) => void; extractors: number; canAgree: boolean }) {
  const mine = slot?.mine;
  const [value, setValue] = useState<unknown>(mine?.value ?? (field.kind === "table" ? [] : field.kind === "multi" ? [] : ""));
  const [quote, setQuote] = useState(mine?.quote ?? "");
  const [page, setPage] = useState<number | null>(mine?.page ?? null);
  const [quoting, setQuoting] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const commit = (v = value, q = quote, p = page) => {
    const empty = v === "" || v == null || (Array.isArray(v) && !v.length);
    // A value that needs a quote waits for one instead of failing.
    if (needQuote && !empty && !q.trim()) {
      setWaiting(true);
      setQuoting(true);
      return;
    }
    setWaiting(false);
    if (JSON.stringify(v) === JSON.stringify(mine?.value ?? (field.kind === "table" || field.kind === "multi" ? [] : "")) && q === (mine?.quote ?? "") && p === (mine?.page ?? null)) return;
    onSave(v, { quote: q, page: p });
  };
  const input = (() => {
    switch (field.kind) {
      case "longtext":
        return <textarea className="kx-rv-input" rows={3} value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} onBlur={() => commit()} />;
      case "number":
        return (
          <span className="kx-rv-inline">
            <input className="kx-rv-input kx-rv-short" inputMode="decimal" value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} onBlur={() => commit(value === "" ? "" : Number.isNaN(Number(value)) ? value : Number(value))} />
            {field.unit && <span className="kx-rv-muted">{field.unit}</span>}
          </span>
        );
      case "date":
        return <input className="kx-rv-input kx-rv-date" type="date" value={String(value ?? "")} onChange={(e) => (setValue(e.target.value), commit(e.target.value))} />;
      case "yesno":
        return (
          <span className="kx-rv-seg" role="radiogroup" aria-label={field.label}>
            {[
              [true, "Yes"],
              [false, "No"],
              ["unclear", "Unclear"],
            ].map(([v, l]) => (
              <button key={String(v)} type="button" role="radio" aria-checked={value === v} onClick={() => (setValue(v), commit(v))}>
                {String(l)}
              </button>
            ))}
          </span>
        );
      case "choice":
        return (
          <select className="kx-rv-select" value={String(value ?? "")} onChange={(e) => (setValue(e.target.value), commit(e.target.value))}>
            <option value="">—</option>
            {field.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        );
      case "multi": {
        const list = Array.isArray(value) ? (value as string[]) : [];
        return (
          <span className="kx-rv-inline kx-rv-wrap">
            {field.options.map((o) => (
              <label key={o} className="kx-check">
                <input
                  type="checkbox"
                  checked={list.includes(o)}
                  onChange={(e) => {
                    const next = e.target.checked ? [...list, o] : list.filter((x) => x !== o);
                    setValue(next);
                    commit(next);
                  }}
                />
                {o}
              </label>
            ))}
          </span>
        );
      }
      case "table":
        return <TableInput field={field} value={Array.isArray(value) ? (value as Record<string, unknown>[]) : []} onChange={(v) => setValue(v)} onCommit={(v) => commit(v)} />;
      default:
        return <input className="kx-rv-input" value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} onBlur={() => commit()} />;
    }
  })();
  const differs = slot?.differs && !slot.final;
  return (
    <div className="kx-rv-xfield" data-kind={field.kind} data-differs={differs || undefined}>
      <div className="kx-rv-xfield-label">
        <span>
          {field.label}
          {field.required && <span className="kx-rv-required" aria-label="required">*</span>}
        </span>
        {field.guidance && <small>{field.guidance}</small>}
      </div>
      <div className="kx-rv-xfield-input">
        {input}
        <div className="kx-rv-quote">
          {quote || quoting ? (
            <>
              <textarea className="kx-rv-input" rows={2} data-waiting={waiting || undefined} placeholder={waiting ? "Add the quote that backs this value to save it" : "Quote from the paper"} value={quote} onChange={(e) => setQuote(e.target.value)} onBlur={() => commit()} aria-label="Quote" />
              <input className="kx-rv-input kx-rv-page" placeholder="p." inputMode="numeric" value={page ?? ""} onChange={(e) => setPage(e.target.value ? Number(e.target.value) : null)} onBlur={() => commit()} aria-label="Page" />
            </>
          ) : (
            <button type="button" className="kx-link-button kx-rv-quote-add" data-needed={needQuote || undefined} onClick={() => setQuoting(true)}>
              {needQuote ? "Add the quote (required)" : "Add a quote"}
            </button>
          )}
          {highlights.length > 0 && (
            <MenuButton
              label="Quote a highlight"
              icon="quote"
              width={360}
              items={highlights.slice(0, 30).map((h) => ({
                label: `${(h.text ?? "").slice(0, 90)}${(h.text ?? "").length > 90 ? "…" : ""}`,
                hint: highlightPage(h) != null ? `p. ${(highlightPage(h) ?? 0) + 1}` : undefined,
                run: () => {
                  const q = h.text ?? "";
                  const p = highlightPage(h) != null ? (highlightPage(h) ?? 0) + 1 : null;
                  setQuote(q);
                  setPage(p);
                  setQuoting(true);
                  commit(value, q, p);
                },
              }))}
            />
          )}
        </div>
        {extractors > 1 && slot && (slot.others.length > 0 || slot.othersCount > 0 || slot.final) && (
          <div className="kx-rv-xothers">
            {slot.others.length === 0 && slot.othersCount > 0 && <span className="kx-rv-muted">Another extractor has a value (shown once you enter yours)</span>}
            {slot.others.map((o) => (
              <div key={o.reviewer} className="kx-rv-xother">
                <span>
                  <strong>{o.reviewerName}</strong> {display(o.value) || "—"}
                  {o.quote && <small>“{o.quote.slice(0, 120)}”</small>}
                </span>
                {differs && canAgree && (
                  <Btn small onClick={() => onSave(o.value, { quote: o.quote, page: o.page, final: true })}>
                    Agree on this
                  </Btn>
                )}
              </div>
            ))}
            {differs && canAgree && mine && (
              <Btn small onClick={() => onSave(mine.value, { quote: mine.quote, page: mine.page, final: true })}>
                Agree on mine
              </Btn>
            )}
            {slot.final && (
              <span className="kx-rv-agreed">
                <Icon name="check" size={11} /> Agreed: {display(slot.final.value)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TableInput({ field, value, onChange, onCommit }: { field: Field; value: Record<string, unknown>[]; onChange: (v: Record<string, unknown>[]) => void; onCommit: (v: Record<string, unknown>[]) => void }) {
  const set = (i: number, col: string, v: unknown) => onChange(value.map((r, j) => (j === i ? { ...r, [col]: v } : r)));
  return (
    <div className="kx-rv-xtable-wrap">
      <table className="kx-rv-xtable">
        <thead>
          <tr>
            {field.columns.map((c) => (
              <th key={c.id} title={c.guidance}>
                {c.label}
              </th>
            ))}
            <th aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {value.map((row, i) => (
            <tr key={i}>
              {field.columns.map((c) => (
                <td key={c.id}>
                  {c.kind === "choice" ? (
                    <select className="kx-rv-select" value={String(row[c.id] ?? "")} onChange={(e) => onCommit(value.map((r, j) => (j === i ? { ...r, [c.id]: e.target.value } : r)))}>
                      <option value="">—</option>
                      {c.options.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="kx-rv-input"
                      inputMode={c.kind === "number" ? "decimal" : undefined}
                      value={String(row[c.id] ?? "")}
                      onChange={(e) => set(i, c.id, c.kind === "number" && e.target.value !== "" && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value)}
                      onBlur={() => onCommit(value)}
                      aria-label={c.label}
                    />
                  )}
                </td>
              ))}
              <td>
                <button type="button" className="kx-rv-icon" aria-label="Remove row" onClick={() => onCommit(value.filter((_, j) => j !== i))}>
                  <Icon name="minus" size={11} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Btn small icon="plus" onClick={() => onChange([...value, {}])}>
        Row
      </Btn>
    </div>
  );
}
