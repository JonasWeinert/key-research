// The extraction form builder: forms (from templates or blank) made of sections and fields —
// text, long text, number, choice, multiple choice, date, yes/no, and tables (repeating groups
// for arms and outcomes) — each with guidance, required, a quote, whether its place in the
// document is needed, and "Show when…" logic on other answers. A field shown on another's answer
// sits indented under it with its rule in words ("Shown when Study type is Qualitative"); a
// choice's option can get a follow-up question; dragging a field onto another nests it there.
// The preview shows which fields sample answers bring up. The rules are checked in Rust
// (key-review/src/logic.rs), which also refuses circles with a plain message.
import { useEffect, useMemo, useState } from "react";
import { Explain, Hint } from "../explain";
import { Icon } from "../icons";
import type { Condition, Field, FieldCheck, Form, ReviewApi, Rules, Section, ShowWhen, SourceRule } from "./review-api";
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
const blankField = (kind: Field["kind"] = "text"): Field => ({ id: newId("f_"), label: "New field", kind, guidance: "", required: false, quote: false, options: kind === "choice" || kind === "multi" ? ["Yes", "No", "Unclear"] : [], unit: "", columns: kind === "table" ? [{ ...blankField("text"), label: "Column 1" }] : [], role: "", source: "" });

const SOURCE: [Field["source"], string][] = [
  ["", "Review default"],
  ["none", "Not needed"],
  ["encouraged", "Encouraged"],
  ["required", "Required"],
];

/** The operators a condition on a field of this kind offers. */
function opsFor(kind: Field["kind"] | undefined): [string, string][] {
  const answered: [string, string][] = [
    ["filled", "is answered"],
    ["empty", "is not answered"],
  ];
  if (kind === "choice" || kind === "multi")
    return [
      ["is", "is"],
      ["isNot", "is not"],
      ["oneOf", "is one of"],
      ...answered,
    ];
  if (kind === "yesno")
    return [
      ["yes", "is yes"],
      ["no", "is no"],
      ...answered,
    ];
  if (kind === "number")
    return [
      ["gt", "is above"],
      ["ge", "is at least"],
      ["lt", "is below"],
      ["le", "is at most"],
      ["is", "is"],
      ...answered,
    ];
  return [["is", "is"], ...answered];
}

/** The rule in words, for the chip (the host gives the same words in the preview). */
function ruleText(rule: ShowWhen, fields: Field[]): string {
  const label = (id: string) => fields.find((f) => f.id === id)?.label ?? id;
  const words: Record<string, string> = { is: "is", isNot: "is not", oneOf: "is", filled: "is answered", empty: "is not answered", yes: "is yes", no: "is no", lt: "is below", le: "is at most", gt: "is above", ge: "is at least" };
  const v = (c: Condition) => (Array.isArray(c.value) ? (c.value as unknown[]).join(" or ") : c.value == null ? "" : String(c.value));
  return `Shown when ${rule.conditions.map((c) => `${label(c.field)} ${words[c.op] ?? c.op}${["filled", "empty", "yes", "no"].includes(c.op) ? "" : ` ${v(c)}`}`).join(rule.all ? " and " : " or ")}`;
}

function ShowWhenEditor({ rule, fields, onChange, scope }: { rule: ShowWhen | null | undefined; fields: Field[]; onChange: (r: ShowWhen | null) => void; scope: string }) {
  const r = rule ?? { conditions: [], all: true };
  const set = (conditions: Condition[], all = r.all) => onChange(conditions.length ? { conditions, all } : null);
  return (
    <div className="kx-rv-showwhen" aria-label={`Show when (${scope})`}>
      <span className="kx-rv-muted">Show when</span>
      {r.conditions.map((c, i) => {
        const target = fields.find((f) => f.id === c.field);
        const ops = opsFor(target?.kind);
        const needsValue = !["filled", "empty", "yes", "no"].includes(c.op);
        const put = (next: Partial<Condition>) => set(r.conditions.map((x, j) => (j === i ? { ...x, ...next } : x)));
        return (
          <span key={i} className="kx-rv-condition">
            {i > 0 && (
              <select className="kx-rv-select" value={r.all ? "all" : "any"} aria-label="All or any" onChange={(e) => set(r.conditions, e.target.value === "all")}>
                <option value="all">and</option>
                <option value="any">or</option>
              </select>
            )}
            <select className="kx-rv-select" value={c.field} aria-label="Field" onChange={(e) => put({ field: e.target.value, op: opsFor(fields.find((f) => f.id === e.target.value)?.kind)[0][0], value: "" })}>
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <select className="kx-rv-select" value={c.op} aria-label="Condition" onChange={(e) => put({ op: e.target.value })}>
              {ops.map(([id, l]) => (
                <option key={id} value={id}>
                  {l}
                </option>
              ))}
            </select>
            {needsValue &&
              (target && (target.kind === "choice" || target.kind === "multi") && c.op !== "oneOf" ? (
                <select className="kx-rv-select" value={String(c.value ?? "")} aria-label="Answer" onChange={(e) => put({ value: e.target.value })}>
                  <option value="">—</option>
                  {target.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : c.op === "oneOf" ? (
                <input className="kx-rv-input" aria-label="Answers" placeholder="A, B" value={Array.isArray(c.value) ? (c.value as string[]).join(", ") : String(c.value ?? "")} onChange={(e) => put({ value: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
              ) : (
                <input className="kx-rv-input kx-rv-short" aria-label="Answer" inputMode={target?.kind === "number" ? "decimal" : undefined} value={String(c.value ?? "")} onChange={(e) => put({ value: target?.kind === "number" && e.target.value !== "" && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value })} />
              ))}
            <button type="button" className="kx-rv-icon" aria-label="Remove condition" onClick={() => set(r.conditions.filter((_, j) => j !== i))}>
              <Icon name="close" size={10} />
            </button>
          </span>
        );
      })}
      {fields.length > 0 && (
        <Btn small quiet icon="plus" onClick={() => set([...r.conditions, { field: fields[0].id, op: opsFor(fields[0].kind)[0][0], value: "" }])}>
          {r.conditions.length ? "Condition" : "Add a condition"}
        </Btn>
      )}
      {!fields.length && <span className="kx-rv-muted">(add another field first)</span>}
    </div>
  );
}

function ChecksEditor({ field, others, onChange }: { field: Field; others: Field[]; onChange: (checks: FieldCheck[]) => void }) {
  const checks = field.checks ?? [];
  const numbers = others.filter((f) => f.kind === "number" && f.id !== field.id);
  return (
    <div className="kx-rv-checks">
      <span className="kx-rv-muted">Checks</span>
      {checks.map((c, i) => (
        <span key={i} className="kx-rv-condition">
          <select className="kx-rv-select" value={c.op} aria-label="Check" onChange={(e) => onChange(checks.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}>
            <option value="le">at most</option>
            <option value="lt">below</option>
            <option value="ge">at least</option>
            <option value="gt">above</option>
          </select>
          <select className="kx-rv-select" value={c.other ?? ""} aria-label="Other field" onChange={(e) => onChange(checks.map((x, j) => (j === i ? { ...x, other: e.target.value || null } : x)))}>
            <option value="">a number…</option>
            {numbers.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          {!c.other && <input className="kx-rv-input kx-rv-short" aria-label="Number" value={String(c.value ?? "")} onChange={(e) => onChange(checks.map((x, j) => (j === i ? { ...x, value: Number(e.target.value) } : x)))} />}
          <input className="kx-rv-input" aria-label="Message" placeholder="Message, e.g. Events cannot exceed the total" value={c.message} onChange={(e) => onChange(checks.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)))} />
          <button type="button" className="kx-rv-icon" aria-label="Remove check" onClick={() => onChange(checks.filter((_, j) => j !== i))}>
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      <Btn small quiet icon="plus" onClick={() => onChange([...checks, { op: "le", other: numbers[0]?.id ?? null, value: null, message: "" }])}>
        Check
      </Btn>
    </div>
  );
}

function FieldEditor(props: {
  field: Field;
  /** Fields it can be shown on (the form's, or a table's columns). */
  scope: Field[];
  depth: number;
  onChange: (f: Field) => void;
  onRemove: () => void;
  onMove: (by: number) => void;
  onFollowUp: (option: string) => void;
  onDropOn: (draggedId: string) => void;
  nested?: boolean;
}) {
  const { field, onChange, nested, scope, depth } = props;
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const others = scope.filter((f) => f.id !== field.id && f.kind !== "table");
  return (
    <li
      className="kx-rv-field-edit"
      data-depth={depth || undefined}
      style={depth ? { marginInlineStart: depth * 22 } : undefined}
      data-over={over || undefined}
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.setData("application/x-key-field", field.id);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-key-field")) {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const id = e.dataTransfer.getData("application/x-key-field");
        if (id && id !== field.id) props.onDropOn(id);
      }}
    >
      {field.showWhen && field.showWhen.conditions.length > 0 && (
        <button type="button" className="kx-rv-rule-chip" title="Change when it is shown" onClick={() => setOpen(true)}>
          <Icon name="arrowRight" size={10} /> {ruleText(field.showWhen, scope)}
        </button>
      )}
      <div className="kx-rv-field-edit-head">
        <span className="kx-rv-grip" aria-hidden="true" title="Drag onto another field to show it only on that field's answer">
          <Icon name="grip" size={12} />
        </span>
        <input className="kx-rv-input" value={field.label} aria-label="Field label" onChange={(e) => onChange({ ...field, label: e.target.value })} />
        <select className="kx-rv-select" value={field.kind} aria-label="Field type" onChange={(e) => onChange({ ...blankField(e.target.value as Field["kind"]), id: field.id, label: field.label, guidance: field.guidance, required: field.required, quote: field.quote, showWhen: field.showWhen, source: field.source })}>
          {KINDS.filter(([k]) => !nested || k !== "table").map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        {field.required && <span className="kx-rv-pill" data-tone="info">Required</span>}
        {field.quote && <span className="kx-rv-pill" data-tone="muted">Quote</span>}
        {field.source === "required" && <span className="kx-rv-pill" data-tone="muted">Source</span>}
        <button type="button" className="kx-rv-icon" aria-label="Move up" onClick={() => props.onMove(-1)}>
          <Icon name="chevronUp" size={12} />
        </button>
        <button type="button" className="kx-rv-icon" aria-label="Move down" onClick={() => props.onMove(1)}>
          <Icon name="chevronDown" size={12} />
        </button>
        <button type="button" className="kx-rv-icon" aria-label={open ? "Hide field details" : "Field details"} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="gear" size={12} />
        </button>
        <button type="button" className="kx-rv-icon" aria-label="Remove field" onClick={props.onRemove}>
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
              Required (when shown)
            </label>
            <label className="kx-check">
              <input type="checkbox" checked={field.quote} onChange={(e) => onChange({ ...field, quote: e.target.checked })} />
              Quote required
            </label>
            <label className="kx-rv-inline" title="Whether the value's place in the document (page, position, quoted text) is needed">
              Source position
              <select className="kx-rv-select" value={field.source ?? ""} aria-label="Source position" onChange={(e) => onChange({ ...field, source: e.target.value as Field["source"] })}>
                {SOURCE.map(([id, l]) => (
                  <option key={id} value={id}>
                    {l}
                  </option>
                ))}
              </select>
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
          {(field.kind === "choice" || field.kind === "yesno") && (
            <span className="kx-rv-inline kx-rv-wrap">
              <span className="kx-rv-muted">Add follow-up question for</span>
              {(field.kind === "yesno" ? ["Yes", "No"] : field.options).map((o) => (
                <Btn key={o} small quiet icon="plus" onClick={() => props.onFollowUp(o)}>
                  {o}
                </Btn>
              ))}
            </span>
          )}
          <ShowWhenEditor rule={field.showWhen} fields={others} scope={field.label} onChange={(showWhen) => onChange({ ...field, showWhen })} />
          {field.kind === "number" && <ChecksEditor field={field} others={scope} onChange={(checks) => onChange({ ...field, checks })} />}
          {field.kind === "table" && (
            <div className="kx-rv-columns">
              <span className="kx-rv-muted">Columns (a column can be shown on another column of the same row)</span>
              <FieldList fields={field.columns} nested onChange={(columns) => onChange({ ...field, columns })} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** The fields in display order with their depth: a field shown on one earlier field of the list
 * sits under it. */
function tree(fields: Field[]): { field: Field; index: number; depth: number }[] {
  const depth = new Map<string, number>();
  const parent = (f: Field) => {
    const c = f.showWhen?.conditions;
    if (!c || c.length !== 1) return undefined;
    const i = fields.findIndex((x) => x.id === c[0].field);
    return i >= 0 && i < fields.indexOf(f) ? fields[i] : undefined;
  };
  return fields.map((f, index) => {
    const p = parent(f);
    const d = p ? (depth.get(p.id) ?? 0) + 1 : 0;
    depth.set(f.id, d);
    return { field: f, index, depth: d };
  });
}

function FieldList({ fields, onChange, nested, scope }: { fields: Field[]; onChange: (f: Field[]) => void; nested?: boolean; scope?: Field[] }) {
  const all = scope ?? fields;
  const shown = tree(fields);
  /** After a field and everything shown under it. */
  const endOf = (index: number) => {
    let end = index;
    const d = shown[index].depth;
    while (end + 1 < shown.length && shown[end + 1].depth > d) end++;
    return end;
  };
  return (
    <>
      <ul className="kx-rv-field-list">
        {shown.map(({ field: f, index: i, depth }) => (
          <FieldEditor
            key={f.id}
            field={f}
            depth={depth}
            scope={all}
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
            onFollowUp={(option) => {
              const kind = f.kind === "yesno" ? (option === "Yes" ? "yes" : "no") : "is";
              const follow: Field = { ...blankField("text"), label: `If ${option.toLowerCase()}: …`, showWhen: { conditions: [{ field: f.id, op: kind, value: kind === "is" ? option : null }], all: true } };
              const next = [...fields];
              next.splice(endOf(i) + 1, 0, follow);
              onChange(next);
            }}
            onDropOn={(dragged) => {
              // Nest the dragged field under this one: shown when this is answered (a choice:
              // its first option), placed after this field's own follow-ups.
              const from = fields.findIndex((x) => x.id === dragged);
              if (from < 0) return;
              const moving = fields[from];
              const cond: Condition = f.kind === "choice" && f.options[0] ? { field: f.id, op: "is", value: f.options[0] } : f.kind === "yesno" ? { field: f.id, op: "yes", value: null } : { field: f.id, op: "filled", value: null };
              const next = fields.filter((x) => x.id !== dragged);
              const at = next.findIndex((x) => x.id === f.id);
              const shownNext = tree(next);
              let end = at;
              while (end + 1 < shownNext.length && shownNext[end + 1].depth > shownNext[at].depth) end++;
              next.splice(end + 1, 0, { ...moving, showWhen: { conditions: [cond], all: true } });
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

/** Sample answers and the fields they bring up, from the host's evaluation of the rules. */
function Preview({ api, form }: { api: ReviewApi; form: Form }) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<{ visible: string[]; error: string | null }>();
  useEffect(() => {
    let live = true;
    void api
      .formPreview(form, answers)
      .then((r) => live && setResult(r))
      .catch((e) => live && setResult({ visible: [], error: errorText(e) }));
    return () => {
      live = false;
    };
  }, [api, form, answers]);
  const visible = new Set(result?.visible ?? []);
  const fields = form.sections.flatMap((s) => s.fields);
  return (
    <div className="kx-rv-preview-form" aria-label="Preview">
      <p className="kx-rv-muted">Preview: answer as a study would, and see which questions appear.</p>
      {result?.error && <p className="kx-inline-error">{result.error}</p>}
      <ul>
        {fields.map((f) => (
          <li key={f.id} data-hidden={!visible.has(f.id) || undefined}>
            <span>
              {f.label}
              {f.required && visible.has(f.id) && <span className="kx-rv-required">*</span>}
              {!visible.has(f.id) && <small> · hidden, not required</small>}
            </span>
            {visible.has(f.id) &&
              (f.kind === "choice" ? (
                <select className="kx-rv-select" aria-label={`Sample ${f.label}`} value={String(answers[f.id] ?? "")} onChange={(e) => setAnswers({ ...answers, [f.id]: e.target.value || undefined })}>
                  <option value="">—</option>
                  {f.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : f.kind === "yesno" ? (
                <select className="kx-rv-select" aria-label={`Sample ${f.label}`} value={answers[f.id] == null ? "" : String(answers[f.id])} onChange={(e) => setAnswers({ ...answers, [f.id]: e.target.value === "" ? undefined : e.target.value === "true" })}>
                  <option value="">—</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : f.kind === "number" || f.kind === "text" ? (
                <input className="kx-rv-input kx-rv-short" aria-label={`Sample ${f.label}`} value={String(answers[f.id] ?? "")} onChange={(e) => setAnswers({ ...answers, [f.id]: e.target.value === "" ? undefined : f.kind === "number" && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value })} />
              ) : null)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FormsEditor({ forms, onChange, api, rules, onRules }: { forms: Form[]; onChange: (f: Form[]) => void; api: ReviewApi; rules: Rules; onRules: (r: Rules) => void }) {
  const templates = useLoad(() => api.formTemplates(), [api]);
  const [openForm, setOpenForm] = useState<string | undefined>(forms[0]?.id);
  const [previewing, setPreviewing] = useState<string>();
  const [error, setError] = useState("");
  const add = (t: Form) => {
    const taken = new Set(forms.map((f) => f.id));
    let id = t.id;
    for (let n = 2; taken.has(id); n++) id = `${t.id}-${n}`;
    onChange([...forms, { ...t, id }]);
    setOpenForm(id);
  };
  const setSection = (fi: number, si: number, s: Section) => onChange(forms.map((f, j) => (j === fi ? { ...f, sections: f.sections.map((x, k) => (k === si ? s : x)) } : f)));
  const allFields = useMemo(() => new Map(forms.map((f) => [f.id, f.sections.flatMap((s) => s.fields)])), [forms]);
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
        <Row label="Source position" hint="Whether a value's place in the document (page, position, the quoted text) is needed. Checked when a study's form is completed; each field can differ.">
          <Segmented
            label="Source position default"
            value={(rules.sourceDefault || "none") as SourceRule}
            options={[
              ["none", "Not needed"],
              ["encouraged", "Encouraged"],
              ["required", "Required"],
            ]}
            onChange={(v) => onRules({ ...rules, sourceDefault: v })}
          />
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
                <Btn small quiet aria-pressed={previewing === form.id} onClick={() => setPreviewing(previewing === form.id ? undefined : form.id)}>
                  Preview
                </Btn>
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
              {previewing === form.id && <Preview api={api} form={form} />}
              {openForm === form.id && (
                <div className="kx-rv-form-body">
                  {form.sections.map((s, si) => (
                    <div key={s.id} className="kx-rv-form-section">
                      <div className="kx-rv-form-section-head">
                        <input className="kx-rv-input" value={s.title} aria-label="Section title" onChange={(e) => setSection(fi, si, { ...s, title: e.target.value })} />
                        <button type="button" className="kx-rv-icon" aria-label="Remove section" onClick={() => onChange(forms.map((f, j) => (j === fi ? { ...f, sections: f.sections.filter((_, k) => k !== si) } : f)))}>
                          <Icon name="trash" size={12} />
                        </button>
                      </div>
                      {s.showWhen && s.showWhen.conditions.length > 0 && <span className="kx-rv-rule-chip">{ruleText(s.showWhen, allFields.get(form.id) ?? []).replace("Shown when", "Section shown when")}</span>}
                      <details className="kx-rv-section-rule">
                        <summary>Show this section only when…</summary>
                        <ShowWhenEditor rule={s.showWhen} fields={(allFields.get(form.id) ?? []).filter((f) => !s.fields.includes(f) && f.kind !== "table")} scope={s.title} onChange={(showWhen) => setSection(fi, si, { ...s, showWhen })} />
                      </details>
                      {s.guidance && <p className="kx-rv-muted">{s.guidance}</p>}
                      <FieldList fields={s.fields} scope={allFields.get(form.id)} onChange={(fields) => setSection(fi, si, { ...s, fields })} />
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
