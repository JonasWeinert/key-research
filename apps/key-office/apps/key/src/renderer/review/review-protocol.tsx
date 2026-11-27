// std-A: Setup › Protocol. The protocol as a document, item by item in PRISMA-P's order, with
// what Key already knows written in (question, criteria, rules, forms, searches) and plain
// guidance for the rest; a completeness meter; the review type (systematic, scoping, rapid,
// living), which chooses the checklists; registration, which locks the protocol so every later
// change is a dated amendment with its reason (the deviations log); and the exports: a
// PRISMA-P protocol, PROSPERO's fields as a copy sheet, an OSF outline. Edits ride the Setup
// draft, so they save and version like the rest of the protocol. Nothing is submitted anywhere.
import { useMemo, useState } from "react";
import { downloadText } from "../db-ui";
import { Explain } from "../explain";
import { GlobalDialog } from "../GlobalDrawer";
import { Icon } from "../icons";
import type { Protocol } from "./review-api";
import { Btn, MenuButton, Row, Segmented, errorText, formatDate, useLoad } from "./review-ui";
import { copyText, reportingApi, type Author, type Plan, type PlannedOutcome, type ProtocolDoc, type ProtocolField, type Registration } from "./review-reporting-api";
import type { StageProps } from "./ReviewPage";
import "./review-reporting.css";

type Props = StageProps & { draft: Protocol; change: (f: (p: Protocol) => void) => void };

const TYPE_HINT: Record<string, string> = {
  systematic: "PRISMA 2020 and PRISMA-P. Register with PROSPERO (health outcomes) or OSF.",
  scoping: "Maps the evidence rather than pooling it: PRISMA-ScR's checklist; risk of bias and certainty are optional.",
  rapid: "A systematic review with shortcuts (for example one screener with a second checking exclusions). Say which in the protocol.",
  living: "Searched again on a schedule and updated as studies appear: describe the living mode.",
};

type WithPlan = Protocol & { plan?: Plan };
/** The plan as stored (read only). */
const planOf = (p: Protocol): Plan => (p as WithPlan).plan ?? {};

/** The plan in the shape the host writes it, empty parts left out, so a saved draft compares
 * equal to what comes back (or Setup would see it as changed and save again). */
function canonical(x: Plan): Plan | undefined {
  const out: Plan = {};
  if (x.reviewType && x.reviewType !== "systematic") out.reviewType = x.reviewType;
  const text = Object.keys(x.text ?? {})
    .filter((k) => x.text![k])
    .sort();
  if (text.length) out.text = Object.fromEntries(text.map((k) => [k, x.text![k]]));
  if (x.authors?.length) out.authors = x.authors.map((a) => ({ name: a.name ?? "", affiliation: a.affiliation ?? "", email: a.email ?? "", contribution: a.contribution ?? "", guarantor: !!a.guarantor, contact: !!a.contact }));
  if (x.outcomes?.length) out.outcomes = x.outcomes.map((o) => ({ name: o.name ?? "", priority: o.priority ?? "", timepoint: o.timepoint ?? "", measure: o.measure ?? "" }));
  if (x.subgroups?.length) out.subgroups = [...x.subgroups];
  if (x.sensitivity?.length) out.sensitivity = [...x.sensitivity];
  return Object.keys(out).length ? out : undefined;
}

/** Objects with their keys in alphabetical order, as the host's JSON comes. */
const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;

/** Changes the draft's plan (keys kept in the host's order, so an unchanged draft reads as unchanged). */
const editPlan = (change: Props["change"], f: (x: Plan) => void) =>
  change((d) => {
    const x: Plan = JSON.parse(JSON.stringify(planOf(d)));
    f(x);
    const next = canonical(x);
    const all = { ...(d as WithPlan), plan: next ? (sorted(next) as Plan) : undefined };
    for (const k of Object.keys(d)) delete (d as unknown as Record<string, unknown>)[k];
    for (const k of Object.keys(all).sort()) if ((all as Record<string, unknown>)[k] !== undefined) (d as unknown as Record<string, unknown>)[k] = (all as Record<string, unknown>)[k];
  });

function RegisterSheet({ initial, onClose, onSave }: { initial: Registration | null; onClose: () => void; onSave: (r: Registration) => Promise<unknown> }) {
  const [r, setR] = useState<Registration>(initial ?? { registry: "PROSPERO", id: "", date: new Date().toISOString().slice(0, 10), url: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <GlobalDialog label="Protocol registration" onClose={onClose} busy={busy}>
      <form
        className="kx-rv-dialog kx-rp-sheet"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          onSave(r)
            .then(onClose)
            .catch((err) => setError(errorText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>{initial ? "Registration details" : "Record the registration"}</h2>
        <p className="kx-rv-muted">Register the protocol with the registry yourself (Key does not submit anything), then record it here. From then on, every change to what the protocol says needs a reason and is listed as a deviation from the protocol.</p>
        <Row label="Registry">
          <Segmented
            label="Registry"
            value={["PROSPERO", "OSF", "INPLASY"].includes(r.registry) ? r.registry : "Other"}
            options={[
              ["PROSPERO", "PROSPERO"],
              ["OSF", "OSF"],
              ["INPLASY", "INPLASY"],
              ["Other", "Other"],
            ]}
            onChange={(v) => setR({ ...r, registry: v === "Other" ? "" : v })}
          />
        </Row>
        {!["PROSPERO", "OSF", "INPLASY"].includes(r.registry) && (
          <Row label="Registry name">
            <input className="kx-rv-input" value={r.registry} onChange={(e) => setR({ ...r, registry: e.target.value })} aria-label="Registry name" autoFocus />
          </Row>
        )}
        <Row label="Registration number" hint="For example CRD42026000000, or the OSF registration's DOI.">
          <input className="kx-rv-input" value={r.id} onChange={(e) => setR({ ...r, id: e.target.value })} aria-label="Registration number" />
        </Row>
        <Row label="Date registered">
          <input className="kx-rv-input" type="date" value={r.date} onChange={(e) => setR({ ...r, date: e.target.value })} aria-label="Date registered" />
        </Row>
        <Row label="Address" hint="The registry record's link.">
          <input className="kx-rv-input" value={r.url} placeholder="https://" onChange={(e) => setR({ ...r, url: e.target.value })} aria-label="Registration address" />
        </Row>
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary="true" disabled={busy}>
            {initial ? "Save" : "Register and lock"}
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

function ProsperoSheet({ doc, onClose, notify }: { doc: ProtocolDoc; onClose: () => void; notify: StageProps["notify"] }) {
  let section = "";
  return (
    <GlobalDialog label="PROSPERO copy sheet" onClose={onClose}>
      <div className="kx-rv-dialog kx-rp-prospero" data-testid="prospero-sheet">
        <h2>PROSPERO copy sheet</h2>
        <p className="kx-rv-muted">Each field of PROSPERO's registration form in the form's order, with this review's text. Copy each into the form. Labels follow a description of the 2025 form: check them against the form itself.</p>
        <div className="kx-rp-prospero-list">
          {doc.prospero.map((f, i) => {
            const head = f.section !== section ? (section = f.section) : "";
            return (
              <div key={i}>
                {head && <h3>{head}</h3>}
                <div className="kx-rp-copyrow">
                  <div>
                    <strong>{f.label}</strong>
                    {f.value ? <p>{f.value}</p> : <p className="kx-rv-muted">Not stated yet · {f.from}</p>}
                  </div>
                  <Btn small quiet icon="copy" disabled={!f.value} onClick={() => void copyText(f.value).then((ok) => notify(ok ? `Copied “${f.label}”` : "Could not copy", ok ? "ok" : "error"))}>
                    Copy
                  </Btn>
                </div>
              </div>
            );
          })}
        </div>
        <div className="kx-rv-dialog-actions">
          <Btn primary onClick={onClose}>
            Done
          </Btn>
        </div>
      </div>
    </GlobalDialog>
  );
}

function AuthorsEditor({ authors, team, onChange }: { authors: Author[]; team: { name: string }[]; onChange: (a: Author[]) => void }) {
  const set = (i: number, patch: Partial<Author>) => onChange(authors.map((a, j) => (j === i ? { ...a, ...patch } : patch.guarantor ? { ...a, guarantor: false } : patch.contact ? { ...a, contact: false } : a)));
  const blank: Author = { name: "", affiliation: "", email: "", contribution: "", guarantor: false, contact: false };
  return (
    <div className="kx-rp-authors">
      {authors.map((a, i) => (
        <div key={i} className="kx-rp-author">
          <input className="kx-rv-input" value={a.name} placeholder="Name" onChange={(e) => set(i, { name: e.target.value })} aria-label="Author name" />
          <input className="kx-rv-input" value={a.affiliation} placeholder="Affiliation" onChange={(e) => set(i, { affiliation: e.target.value })} aria-label="Affiliation" />
          <input className="kx-rv-input" value={a.email} placeholder="E-mail" onChange={(e) => set(i, { email: e.target.value })} aria-label="E-mail" />
          <input className="kx-rv-input" value={a.contribution} placeholder="Contribution (screening, analysis …)" onChange={(e) => set(i, { contribution: e.target.value })} aria-label="Contribution" />
          <label className="kx-check" title="Takes responsibility for the review">
            <input type="radio" checked={a.guarantor} onChange={() => set(i, { guarantor: true })} /> Guarantor
          </label>
          <label className="kx-check">
            <input type="radio" checked={a.contact} onChange={() => set(i, { contact: true })} /> Contact
          </label>
          <button type="button" className="kx-rv-icon" aria-label="Remove author" onClick={() => onChange(authors.filter((_, j) => j !== i))}>
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
      <div className="kx-rp-pair-tools">
        <Btn small icon="plus" onClick={() => onChange([...authors, blank])}>
          Add an author
        </Btn>
        {team.some((m) => !authors.some((a) => a.name === m.name)) && (
          <Btn small icon="person" onClick={() => onChange([...authors, ...team.filter((m) => !authors.some((a) => a.name === m.name)).map((m, i) => ({ ...blank, name: m.name, guarantor: !authors.length && i === 0, contact: !authors.length && i === 0 }))])}>
            Add the review team
          </Btn>
        )}
      </div>
    </div>
  );
}

function OutcomesEditor({ outcomes, onChange }: { outcomes: PlannedOutcome[]; onChange: (o: PlannedOutcome[]) => void }) {
  const set = (i: number, patch: Partial<PlannedOutcome>) => onChange(outcomes.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  return (
    <div className="kx-rp-authors">
      {outcomes.map((o, i) => (
        <div key={i} className="kx-rp-outcome">
          <input className="kx-rv-input" value={o.name} placeholder="Outcome" onChange={(e) => set(i, { name: e.target.value })} aria-label="Outcome" />
          <select className="kx-rv-input" value={o.priority || "secondary"} onChange={(e) => set(i, { priority: e.target.value })} aria-label="Priority">
            <option value="primary">Primary</option>
            <option value="secondary">Secondary</option>
          </select>
          <input className="kx-rv-input" value={o.measure} placeholder="Measure (scale, unit)" onChange={(e) => set(i, { measure: e.target.value })} aria-label="Measure" />
          <input className="kx-rv-input" value={o.timepoint} placeholder="Time point" onChange={(e) => set(i, { timepoint: e.target.value })} aria-label="Time point" />
          <button type="button" className="kx-rv-icon" aria-label="Remove outcome" onClick={() => onChange(outcomes.filter((_, j) => j !== i))}>
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
      <Btn small icon="plus" onClick={() => onChange([...outcomes, { name: "", priority: outcomes.length ? "secondary" : "primary", measure: "", timepoint: "" }])}>
        Add an outcome
      </Btn>
    </div>
  );
}

function Lines({ value, onChange, placeholder, label }: { value: string[]; onChange: (v: string[]) => void; placeholder: string; label: string }) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <textarea
      className="kx-rv-input"
      rows={Math.max(2, value.length + 1)}
      value={text}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean));
      }}
    />
  );
}

function FieldControl({ field, draft, change, team }: { field: ProtocolField; draft: Protocol; change: Props["change"]; team: { name: string }[] }) {
  const p = planOf(draft);
  const value = p.text?.[field.id] ?? "";
  const setText = (v: string) =>
    editPlan(change, (x) => {
      x.text = { ...(x.text ?? {}), [field.id]: v };
    });
  switch (field.kind) {
    case "authors":
      return <AuthorsEditor authors={p.authors ?? []} team={team} onChange={(a) => editPlan(change, (x) => void (x.authors = a))} />;
    case "outcomes":
      return (
        <>
          <OutcomesEditor outcomes={p.outcomes ?? []} onChange={(o) => editPlan(change, (x) => void (x.outcomes = o))} />
          <textarea className="kx-rv-input kx-rp-gapless" rows={2} value={value} placeholder="How one result is chosen when a study reports several (time points, scales, analyses)" onChange={(e) => setText(e.target.value)} aria-label="Choosing among several results" />
        </>
      );
    case "analyses":
      return (
        <div className="kx-rp-twocol">
          <label>
            <span>Subgroup analyses, one per line</span>
            <Lines value={p.subgroups ?? []} placeholder="Age group (under 65, 65 and over)" label="Subgroup analyses" onChange={(v) => editPlan(change, (x) => void (x.subgroups = v))} />
          </label>
          <label>
            <span>Sensitivity analyses, one per line</span>
            <Lines value={p.sensitivity ?? []} placeholder="Excluding studies at high risk of bias" label="Sensitivity analyses" onChange={(v) => editPlan(change, (x) => void (x.sensitivity = v))} />
          </label>
        </div>
      );
    case "registration":
    case "amendments":
      return field.effective ? <p className="kx-rp-para">{field.effective}</p> : <p className="kx-rv-muted">{field.kind === "registration" ? "Not registered yet." : "Listed once the protocol is registered."}</p>;
    case "date":
      return <input className="kx-rv-input kx-rp-date" type="date" value={value || (field.fromKey ? field.suggestion : "")} onChange={(e) => setText(e.target.value)} aria-label={field.label} />;
    default: {
      const suggestion = !value && field.suggestion;
      return suggestion ? (
        <div className="kx-rp-suggested">
          <p>{field.suggestion}</p>
          <div>
            <span className="kx-rv-muted">
              <Icon name="sparkle" size={11} /> From the review: kept up to date until you edit it
            </span>
            <Btn small quiet icon="pen" onClick={() => setText(field.suggestion)}>
              Edit
            </Btn>
          </div>
        </div>
      ) : field.kind === "long" ? (
        <textarea className="kx-rv-input" rows={Math.min(8, Math.max(2, Math.ceil(value.length / 90) + 1))} value={value} onChange={(e) => setText(e.target.value)} aria-label={field.label} />
      ) : (
        <input className="kx-rv-input" value={value} onChange={(e) => setText(e.target.value)} aria-label={field.label} />
      );
    }
  }
}

export function ProtocolSection(props: Props) {
  const { invoke, workspaceId, reviewId, summary, viewer, notify, onChanged, draft, change } = props;
  const rapi = useMemo(() => reportingApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const doc = useLoad(() => rapi.protocolDoc(), [rapi, summary.events]);
  const [registering, setRegistering] = useState(false);
  const [prospero, setProspero] = useState(false);
  const d = doc.value;
  const reviewType = planOf(draft).reviewType || "systematic";
  const exportKind = (kind: string) =>
    rapi
      .exportFile(kind)
      .then((f) => downloadText(f.filename, f.content, f.mime))
      .catch((e) => notify(errorText(e), "error"));
  if (!d) return doc.error ? <p className="kx-inline-error">{doc.error}</p> : <div className="kx-rv-loading" aria-busy="true" />;
  const pct = d.completeness.required ? Math.round((d.completeness.done / d.completeness.required) * 100) : 0;
  let section = "";
  return (
    <div className="kx-rp-protocol" data-testid="protocol-builder">
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Protocol</h2>
          <Explain help="review.protocol" />
          <MenuButton
            label="Export the protocol"
            icon="download"
            width={280}
            items={[
              { label: "Protocol, PRISMA-P order (Markdown)", icon: "fileMarkdown", run: () => void exportKind("protocol") },
              { label: "Protocol for Word (HTML)", icon: "fileDoc", run: () => void exportKind("protocol-html") },
              null,
              { label: "PROSPERO copy sheet…", icon: "copy", run: () => setProspero(true) },
              { label: "PROSPERO fields (Markdown)", icon: "fileMarkdown", run: () => void exportKind("prospero-sheet") },
              { label: "OSF preregistration outline (Markdown)", icon: "fileMarkdown", run: () => void exportKind("osf-prereg") },
              null,
              { label: "Deviations from protocol (CSV)", icon: "table", run: () => void exportKind("deviations"), disabled: !d.locked },
              { label: "Deviations from protocol (Markdown)", icon: "fileMarkdown", run: () => void exportKind("deviations-md"), disabled: !d.locked },
            ]}
          />
        </div>
        <div className="kx-rp-complete" title={d.completeness.missing.length ? `Still to write: ${d.completeness.missing.join(", ")}` : "Every required field has text"}>
          <span className="kx-rp-complete-bar" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </span>
          <span data-testid="protocol-completeness">
            {d.completeness.done} of {d.completeness.required} required fields
          </span>
          {d.completeness.missing.length > 0 && <span className="kx-rv-muted">Next: {d.completeness.missing.slice(0, 3).join(", ")}</span>}
        </div>
        <Row label="Review type" hint={TYPE_HINT[reviewType]}>
          <Segmented label="Review type" value={reviewType} options={d.reviewTypes.map((t) => [t.id, t.label.replace(" systematic review", "").replace(" review", "")] as [string, string])} onChange={(v) => editPlan(change, (x) => void (x.reviewType = v))} />
        </Row>
      </section>
      <section className="kx-rv-section kx-rp-registration" data-locked={d.locked || undefined}>
        <div className="kx-rv-section-head">
          <h2>Registration</h2>
          {d.registration ? (
            <Btn small onClick={() => setRegistering(true)}>
              Edit details…
            </Btn>
          ) : (
            <Btn small primary icon="lock" onClick={() => setRegistering(true)}>
              Record registration…
            </Btn>
          )}
        </div>
        {d.registration ? (
          <>
            <p className="kx-rp-registered" data-testid="registered">
              <Icon name="lock" size={13} /> Protocol registered on {d.registration.date}
              {d.registration.id ? `, id ${d.registration.id}` : ""} ({d.registration.registry}).
            </p>
            <p className="kx-rv-muted">
              {d.registeredBeforeConduct === false ? "Registered after screening had started: say so in the manuscript (AMSTAR 2 item 2)." : "Registered before the first screening decision."} Every change to the question, criteria, rules, forms or plan is now an amendment with a reason.
            </p>
          </>
        ) : (
          <p className="kx-rv-muted">Not registered. Register with PROSPERO (reviews with a health outcome), OSF Registries or INPLASY before screening starts, then record it here: Key then keeps every later change as a dated amendment.</p>
        )}
        {d.locked && (
          <div className="kx-rp-deviations" data-testid="deviations">
            <h3>Deviations from protocol</h3>
            {d.deviations.length ? (
              <table className="kx-rp-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Version</th>
                    <th>What changed</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {d.deviations.map((x) => (
                    <tr key={x.version}>
                      <td>{formatDate(x.at)}</td>
                      <td>{x.version}</td>
                      <td>{x.changes.length ? x.changes.join("; ") : "Settings changed"}</td>
                      <td>{x.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="kx-rv-muted">None since registration.</p>
            )}
          </div>
        )}
      </section>
      <section className="kx-rv-section kx-rp-fields">
        {d.fields
          .filter((f) => f.kind !== "registration")
          .map((f) => {
            const head = f.section !== section ? (section = f.section) : "";
            return (
              <div key={f.id}>
                {head && <h3 className="kx-rp-field-section">{head}</h3>}
                <Row
                  label={
                    <span className="kx-rp-field-label">
                      {f.label}
                      {f.item && <small className="kx-rp-item-badge">PRISMA-P {f.item}</small>}
                      {f.required && !f.done && <i className="kx-rp-dot" title="Still to write" />}
                    </span>
                  }
                  hint={f.guidance}
                  wide={f.kind !== "text" && f.kind !== "date"}
                >
                  <FieldControl field={f} draft={draft} change={change} team={summary.team} />
                </Row>
              </div>
            );
          })}
      </section>
      {registering && (
        <RegisterSheet
          initial={d.registration}
          onClose={() => setRegistering(false)}
          onSave={(r) =>
            rapi.register(r, viewer).then(() => {
              notify(d.registration ? "Registration updated" : "Protocol registered: later changes are amendments", "ok");
              doc.reload();
              onChanged();
            })
          }
        />
      )}
      {prospero && <ProsperoSheet doc={d} notify={notify} onClose={() => setProspero(false)} />}
    </div>
  );
}
