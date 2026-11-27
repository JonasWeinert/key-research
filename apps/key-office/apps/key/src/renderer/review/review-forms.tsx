// The extraction form builder: forms (from templates or blank) made of sections and fields —
// text, long text, number, choice, multiple choice, date, yes/no, and tables (repeating groups
// for arms and outcomes) — each with guidance, a required flag and "quote required".
import { useState } from "react";
import { Explain, Hint } from "../explain";
import { Icon } from "../icons";
import type { Field, Form, ReviewApi, Rules } from "./review-api";
import { Btn, MenuButton, Row, Segmented, Toggle, errorText, useLoad } from "./review-ui";

const KINDS: [Field["kind"], string][] = [
  ["text", "Text"],
  ["longtext", "Long text"],
  ["number", "Number"],
  ["choice", "Choice"],
  ["multi", "Multiple choice"],
  ["date", "Date"],
  ["yesno", "Yes / no"],
  ["table", "Table (repeating rows)"],
];
const newId = (prefix: string) => `${prefix}${Math.random().toString(16).slice(2, 8)}`;
const blankField = (kind: Field["kind"] = "text"): Field => ({ id: newId("f_"), label: "New field", kind, guidance: "", required: false, quote: false, options: kind === "choice" || kind === "multi" ? ["Yes", "No", "Unclear"] : [], unit: "", columns: kind === "table" ? [{ ...blankField("text"), label: "Column 1" }] : [], role: "" });

function FieldEditor({ field, onChange, onRemove, onMove, nested }: { field: Field; onChange: (f: Field) => void; onRemove: () => void; onMove: (by: number) => void; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="kx-rv-field-edit">
      <div className="kx-rv-field-edit-head">
        <input className="kx-rv-input" value={field.label} aria-label="Field label" onChange={(e) => onChange({ ...field, label: e.target.value })} />
        <select className="kx-rv-select" value={field.kind} aria-label="Field type" onChange={(e) => onChange({ ...blankField(e.target.value as Field["kind"]), id: field.id, label: field.label, guidance: field.guidance, required: field.required, quote: field.quote })}>
          {KINDS.filter(([k]) => !nested || k !== "table").map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        {field.required && <span className="kx-rv-pill" data-tone="info">Required</span>}
        {field.quote && <span className="kx-rv-pill" data-tone="muted">Quote</span>}
        <button type="button" className="kx-rv-icon" aria-label="Move up" onClick={() => onMove(-1)}>
          <Icon name="chevronUp" size={12} />
        </button>
        <button type="button" className="kx-rv-icon" aria-label="Move down" onClick={() => onMove(1)}>
          <Icon name="chevronDown" size={12} />
        </button>
        <button type="button" className="kx-rv-icon" aria-label={open ? "Hide field details" : "Field details"} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="gear" size={12} />
        </button>
        <button type="button" className="kx-rv-icon" aria-label="Remove field" onClick={onRemove}>
          <Icon name="trash" size={12} />
        </button>
      </div>
      {open && (
        <div className="kx-rv-field-edit-body">
          <label className="kx-rv-field" data-wide>
            <span>Guidance</span>
            <textarea className="kx-rv-input" rows={2} value={field.guidance} onChange={(e) => onChange({ ...field, guidance: e.target.value })} />
          </label>
          <span className="kx-rv-inline">
            <label className="kx-check">
              <input type="checkbox" checked={field.required} onChange={(e) => onChange({ ...field, required: e.target.checked })} />
              Required
            </label>
            <label className="kx-check">
              <input type="checkbox" checked={field.quote} onChange={(e) => onChange({ ...field, quote: e.target.checked })} />
              Quote required
            </label>
            {field.kind === "number" && (
              <label className="kx-rv-inline">
                Unit <input className="kx-rv-input kx-rv-short" value={field.unit} onChange={(e) => onChange({ ...field, unit: e.target.value })} />
              </label>
            )}
            {!nested && (
              <label className="kx-rv-inline" title="What the meta-analysis reads from this field">
                Used as
                <select className="kx-rv-select" value={field.role} onChange={(e) => onChange({ ...field, role: e.target.value })}>
                  <option value="">Data</option>
                  {field.kind === "table" && <option value="outcomes">Outcome data</option>}
                  <option value="subgroup">Subgroup</option>
                </select>
              </label>
            )}
          </span>
          {(field.kind === "choice" || field.kind === "multi") && (
            <label className="kx-rv-field" data-wide>
              <span>Options (one per line)</span>
              <textarea className="kx-rv-input" rows={3} value={field.options.join("\n")} onChange={(e) => onChange({ ...field, options: e.target.value.split("\n").map((o) => o.trim()).filter(Boolean) })} />
            </label>
          )}
          {field.kind === "table" && (
            <div className="kx-rv-columns">
              <span className="kx-rv-muted">Columns</span>
              <FieldList fields={field.columns} nested onChange={(columns) => onChange({ ...field, columns })} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function FieldList({ fields, onChange, nested }: { fields: Field[]; onChange: (f: Field[]) => void; nested?: boolean }) {
  return (
    <>
      <ul className="kx-rv-field-list">
        {fields.map((f, i) => (
          <FieldEditor
            key={f.id}
            field={f}
            nested={nested}
            onChange={(next) => onChange(fields.map((x, j) => (j === i ? next : x)))}
            onRemove={() => onChange(fields.filter((_, j) => j !== i))}
            onMove={(by) => {
              const to = i + by;
              if (to < 0 || to >= fields.length) return;
              const next = [...fields];
              next.splice(to, 0, ...next.splice(i, 1));
              onChange(next);
            }}
          />
        ))}
      </ul>
      <Btn small icon="plus" onClick={() => onChange([...fields, blankField()])}>
        {nested ? "Column" : "Field"}
      </Btn>
    </>
  );
}

export function FormsEditor({ forms, onChange, api, rules, onRules }: { forms: Form[]; onChange: (f: Form[]) => void; api: ReviewApi; rules: Rules; onRules: (r: Rules) => void }) {
  const templates = useLoad(() => api.formTemplates(), [api]);
  const [openForm, setOpenForm] = useState<string | undefined>(forms[0]?.id);
  const [error, setError] = useState("");
  const add = (t: Form) => {
    const taken = new Set(forms.map((f) => f.id));
    let id = t.id;
    for (let n = 2; taken.has(id); n++) id = `${t.id}-${n}`;
    onChange([...forms, { ...t, id }]);
    setOpenForm(id);
  };
  return (
    <>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Extraction rules</h2>
          <Explain help="review.extraction" />
        </div>
        <Row label="Extractors per study" hint="Two people extract independently, then agree on differences.">
          <Segmented label="Extractors" value={rules.extractors} options={[[1, "1"], [2, "2"]]} onChange={(v) => onRules({ ...rules, extractors: v })} />
        </Row>
        <Row label="Every value needs a quote" hint="Otherwise only fields marked “quote required” do.">
          <Toggle label="Quote required" checked={rules.quoteRequired} onChange={(v) => onRules({ ...rules, quoteRequired: v })} />
        </Row>
      </section>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Forms</h2>
          <MenuButton label="Add a form" icon="plus" items={(templates.value ?? []).map((t) => ({ label: t.name, run: () => add(t) }))}>
            Add a form
          </MenuButton>
        </div>
        <Hint help="review.forms" />
        {error && <p className="kx-inline-error">{error}</p>}
        <ul className="kx-rv-forms">
          {forms.map((form, fi) => (
            <li key={form.id} className="kx-rv-form-card">
              <div className="kx-rv-form-head">
                <button type="button" className="kx-rv-icon" aria-expanded={openForm === form.id} aria-label={openForm === form.id ? "Collapse form" : "Expand form"} onClick={() => setOpenForm(openForm === form.id ? undefined : form.id)}>
                  <Icon name={openForm === form.id ? "chevronDown" : "chevronRight"} size={12} />
                </button>
                <input className="kx-rv-input kx-rv-form-name" value={form.name} aria-label="Form name" onChange={(e) => onChange(forms.map((f, j) => (j === fi ? { ...f, name: e.target.value } : f)))} />
                <span className="kx-rv-muted">{form.sections.reduce((n, s) => n + s.fields.length, 0)} fields</span>
                <button
                  type="button"
                  className="kx-rv-icon"
                  aria-label="Remove form"
                  onClick={() => {
                    setError("");
                    if (forms.length === 1) return setError("Keep at least one form");
                    onChange(forms.filter((_, j) => j !== fi));
                  }}
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
              {openForm === form.id && (
                <div className="kx-rv-form-body">
                  {form.sections.map((s, si) => (
                    <div key={s.id} className="kx-rv-form-section">
                      <div className="kx-rv-form-section-head">
                        <input className="kx-rv-input" value={s.title} aria-label="Section title" onChange={(e) => onChange(forms.map((f, j) => (j === fi ? { ...f, sections: f.sections.map((x, k) => (k === si ? { ...x, title: e.target.value } : x)) } : f)))} />
                        <button type="button" className="kx-rv-icon" aria-label="Remove section" onClick={() => onChange(forms.map((f, j) => (j === fi ? { ...f, sections: f.sections.filter((_, k) => k !== si) } : f)))}>
                          <Icon name="trash" size={12} />
                        </button>
                      </div>
                      {s.guidance && <p className="kx-rv-muted">{s.guidance}</p>}
                      <FieldList fields={s.fields} onChange={(fields) => onChange(forms.map((f, j) => (j === fi ? { ...f, sections: f.sections.map((x, k) => (k === si ? { ...x, fields } : x)) } : f)))} />
                    </div>
                  ))}
                  <Btn small icon="plus" onClick={() => onChange(forms.map((f, j) => (j === fi ? { ...f, sections: [...f.sections, { id: newId("s-"), title: "New section", guidance: "", fields: [] }] } : f)))}>
                    Section
                  </Btn>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export { errorText };
