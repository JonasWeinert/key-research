// Setup: the protocol (question, rules, criteria, keywords), the team, splits (pilot
// rounds and assignment) and the history of versions. Edits are a draft: before anyone decided
// under the current version they save as they are made; after, saving makes a new version with
// a note and can flag the decisions the change affects for re-screening.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Explain, Hint } from "../explain";
import { downloadText } from "../db-ui";
import { Icon } from "../icons";
import { ELEMENT_LABEL, ELEMENT_PART, plural, reasonText, type Condition, type Criterion, type Member, type Protocol, type ReasonRule, type Stage } from "./review-api";
import { Btn, MenuButton, Row, Segmented, Toggle, errorText, formatTime, useLoad } from "./review-ui";
import type { StageProps } from "./ReviewPage";
import { FormsEditor } from "./review-forms";
import { boundKeys, criterionKeys } from "./review-session";
// std-A: the protocol document (PRISMA-P / PROSPERO / OSF), registration and deviations
import { ProtocolSection } from "./review-protocol";
import { takeFocus } from "./review-reporting-api";

type Section = "question" | "protocol" | "team" | "criteria" | "keywords" | "forms" | "splits" | "history";
const SECTIONS: [Section, string][] = [
  ["question", "Question"],
  // std-A
  ["protocol", "Protocol"],
  ["team", "Team & rules"],
  ["criteria", "Criteria"],
  ["keywords", "Keywords & labels"],
  ["forms", "Extraction forms"],
  ["splits", "Pilot & assignment"],
  ["history", "Versions & audit"],
];

const newId = (prefix: string) => `${prefix}${Math.random().toString(16).slice(2, 10)}`;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function Setup(props: StageProps) {
  const { summary, api, viewer, notify, onChanged } = props;
  const [section, setSection] = useState<Section>(() => takeFocus(props.reviewId, SECTIONS.map(([id]) => id)) ?? (summary.active ? "criteria" : "question"));
  const [draft, setDraft] = useState<Protocol>(() => clone(summary.protocol));
  const base = useRef(summary.protocol);
  // Start from the latest protocol (another window may have saved one since this tab last read).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onChanged(), []);
  // A protocol saved elsewhere (another window, a template) replaces an unchanged draft.
  useEffect(() => {
    if (same(draft, base.current)) setDraft(clone(summary.protocol));
    base.current = summary.protocol;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.protocol]);
  const dirty = !same(draft, summary.protocol);
  // std-A: a registered protocol changes only by an amendment with a reason (never as typed).
  const versioned = summary.versionHasDecisions || !!summary.reporting?.locked;
  // Before decisions exist, edits save as they are made.
  useEffect(() => {
    if (!dirty || versioned) return;
    const t = setTimeout(() => {
      void api
        .saveProtocol(draft, "", viewer, false)
        .then((r) => {
          if (r.autoApplied) notify(`Rules excluded ${plural(r.autoApplied, "record")} automatically`, "ok");
          onChanged();
        })
        .catch((e) => notify(errorText(e), "error"));
    }, 700);
    return () => clearTimeout(t);
  }, [draft, dirty, versioned, api, viewer, onChanged, notify]);
  const change = useCallback((f: (p: Protocol) => void) => setDraft((d) => {
    const next = clone(d);
    f(next);
    return next;
  }), []);
  const loadTemplate = useRef<HTMLInputElement>(null);
  const child = { ...props, draft, change };
  return (
    <div className="kx-rv-setup">
      <nav className="kx-rv-subnav" aria-label="Setup sections">
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" aria-current={section === id ? "page" : undefined} onClick={() => setSection(id)}>
            {label}
            {id === "criteria" && draft.criteria.length > 0 && <small>{draft.criteria.length}</small>}
          </button>
        ))}
        <div className="kx-rv-subnav-foot">
          <span className="kx-rv-muted">Protocol version {summary.versionNumber}</span>
          <MenuButton
            label="Templates"
            icon="copy"
            items={[
              { label: "Load a template…", icon: "upload", run: () => loadTemplate.current?.click() },
              { label: "Save as template…", icon: "download", run: () => void api.exportFile("template", viewer).then((f) => downloadText(f.filename, f.content, f.mime)) },
            ]}
          />
          <input
            ref={loadTemplate}
            type="file"
            accept=".json"
            hidden
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (!f)
                return;
              void f
                .text()
                .then((t) => api.readTemplate(t))
                .then((p) => {
                  // A template brings rules, criteria, reasons, forms and keywords; the question stays.
                  setDraft((d) => ({ ...p, question: d.question, registration: d.registration, notes: d.notes }));
                  notify("Template loaded: review the changes, then save", "ok");
                })
                .catch((err) => notify(errorText(err), "error"));
            }}
          />
        </div>
      </nav>
      <div className="kx-rv-setup-body">
        {section === "question" && <QuestionSection {...child} />}
        {section === "protocol" && <ProtocolSection {...child} />}
        {section === "team" && <TeamSection {...child} />}
        {section === "criteria" && <CriteriaSection {...child} />}
        {section === "keywords" && <KeywordsSection {...child} />}
        {section === "forms" && <FormsEditor forms={draft.forms} onChange={(forms) => change((p) => void (p.forms = forms))} api={api} rules={draft.rules} onRules={(r) => change((p) => void (p.rules = r))} />}
        {section === "splits" && <SplitsSection {...props} />}
        {section === "history" && <HistorySection {...props} />}
      </div>
      {dirty && versioned && <SaveBar {...props} draft={draft} onDiscard={() => setDraft(clone(summary.protocol))} />}
    </div>
  );
}

interface DraftProps extends StageProps {
  draft: Protocol;
  change: (f: (p: Protocol) => void) => void;
}

function SaveBar({ api, summary, viewer, draft, notify, onChanged, onDiscard }: StageProps & { draft: Protocol; onDiscard: () => void }) {
  const [note, setNote] = useState("");
  const [rescreen, setRescreen] = useState(true);
  const [busy, setBusy] = useState(false);
  const impact = useLoad(() => api.impact(draft), [api, draft]);
  const affected = (impact.value?.ta ?? 0) + (impact.value?.ft ?? 0);
  return (
    <div className="kx-rv-savebar" role="region" aria-label="Save protocol changes">
      <Icon name="info" size={14} />
      <span className="kx-rv-savebar-text">
        {summary.reporting?.locked && impact.value?.newVersion !== false
          ? `The protocol is registered: saving records an amendment (version ${summary.versionNumber + 1}), listed with its reason as a deviation from the protocol.`
          : !impact.value?.newVersion && impact.value
            ? "This change does not alter what the protocol says: it saves without a new version."
            : `Decisions were made under version ${summary.versionNumber}. Saving makes version ${summary.versionNumber + 1}.`}
        {affected > 0 && (
          <label className="kx-check">
            <input type="checkbox" checked={rescreen} onChange={(e) => setRescreen(e.target.checked)} />
            Flag {plural(affected, "decided record")} the change could affect for re-screening
          </label>
        )}
      </span>
      <input className="kx-rv-input" placeholder="What changed and why (required)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Change note" />
      <Btn onClick={onDiscard}>Discard</Btn>
      <Btn
        primary
        disabled={busy || (!note.trim() && impact.value?.newVersion !== false)}
        onClick={() => {
          setBusy(true);
          api
            .saveProtocol(draft, note, viewer, rescreen)
            .then((r) => {
              notify(`Saved as version ${r.number}${r.flagged ? ` · ${plural(r.flagged, "record")} to re-screen` : ""}${r.autoApplied ? ` · ${r.autoApplied} excluded by rules` : ""}`, "ok");
              onChanged();
            })
            .catch((e) => notify(errorText(e), "error"))
            .finally(() => setBusy(false));
        }}
      >
        {impact.value?.newVersion === false ? "Save" : `Save version ${summary.versionNumber + 1}`}
      </Btn>
    </div>
  );
}

// ── Question ─────────────────────────────────────────────────────────────────────

const FRAMEWORKS: Record<string, [string, string, string][]> = {
  pico: [
    ["p", "Population", "Who: participants, condition, setting"],
    ["i", "Intervention", "What is done or given"],
    ["c", "Comparison", "Against what: placebo, usual care, another intervention"],
    ["o", "Outcomes", "What is measured, and when"],
  ],
  peco: [
    ["p", "Population", "Who: participants, condition, setting"],
    ["e", "Exposure", "What people are exposed to"],
    ["c", "Comparator", "Unexposed or less exposed people"],
    ["o", "Outcomes", "What is measured"],
  ],
  spider: [
    ["s", "Sample", "Who took part"],
    ["pi", "Phenomenon of interest", "The experience or behaviour studied"],
    ["d", "Design", "Interviews, focus groups, surveys …"],
    ["e", "Evaluation", "Views, experiences, attitudes"],
    ["r", "Research type", "Qualitative, quantitative or mixed"],
  ],
  free: [],
};

function QuestionSection({ draft, change }: DraftProps) {
  const q = draft.question;
  return (
    <section className="kx-rv-section">
      <div className="kx-rv-section-head">
        <h2>Review question</h2>
        <Explain help="review.question" />
      </div>
      <Row label="Framework" hint="A structure for the question; criteria usually follow its parts.">
        <Segmented
          label="Framework"
          value={q.framework}
          options={[
            ["pico", "PICO"],
            ["peco", "PECO"],
            ["spider", "SPIDER"],
            ["free", "Free text"],
          ]}
          onChange={(v) => change((p) => void (p.question.framework = v))}
        />
      </Row>
      <Row label="Question" wide>
        <textarea className="kx-rv-input" rows={2} placeholder="In adults with …, does … compared with … change …?" value={q.text} onChange={(e) => change((p) => void (p.question.text = e.target.value))} />
      </Row>
      {(FRAMEWORKS[q.framework] ?? []).map(([key, label, hint]) => (
        <Row key={key} label={label} hint={hint} wide>
          <input className="kx-rv-input" value={q.parts[key] ?? ""} onChange={(e) => change((p) => void (p.question.parts[key] = e.target.value))} />
        </Row>
      ))}
      <Row label="Registration" hint="PROSPERO, OSF or another registry's id.">
        <input className="kx-rv-input" placeholder="e.g. CRD42026000000" value={draft.registration} onChange={(e) => change((p) => void (p.registration = e.target.value))} />
      </Row>
      <Row label="Protocol notes" wide>
        <textarea className="kx-rv-input" rows={5} placeholder="Deviations from the registered protocol, decisions the team made, links" value={draft.notes} onChange={(e) => change((p) => void (p.notes = e.target.value))} />
      </Row>
    </section>
  );
}

// ── Team and rules ───────────────────────────────────────────────────────────────

function TeamSection({ summary, api, viewer, notify, onChanged, draft, change }: DraftProps) {
  const [team, setTeam] = useState<Member[]>(summary.team);
  useEffect(() => setTeam(summary.team), [summary.team]);
  const saveTeam = (next: Member[]) => {
    setTeam(next);
    api
      .saveTeam(next, viewer)
      .then(onChanged)
      .catch((e) => {
        notify(errorText(e), "error");
        setTeam(summary.team);
      });
  };
  const roles: [string, string][] = [
    ["owner", "Owner"],
    ["reviewer", "Reviewer"],
    ["tiebreaker", "Tie-breaker"],
  ];
  const r = draft.rules;
  const stageRule = (stage: Stage, label: string) => (
    <div className="kx-rv-rule-card">
      <h3>{label}</h3>
      <Row label="Reviewers per record" hint="Two independent reviewers is the Cochrane standard.">
        <Segmented label={`${label} reviewers`} value={r[stage].reviewers} options={[[1, "1"], [2, "2"], [3, "3"]]} onChange={(v) => change((p) => void (p.rules[stage].reviewers = v))} />
      </Row>
      <Row label="When excluding, require the criterion not met?" hint="“The first one”: the first in the list that it does not meet, which PRISMA reports. Other… is always offered.">
        <Segmented
          label={`${label}: criterion when excluding`}
          value={(r[stage].reasons as string) === "one" ? "first" : r[stage].reasons}
          options={REASON_RULES}
          onChange={(v) => change((p) => void (p.rules[stage].reasons = v))}
        />
      </Row>
      <Row label="Offer “Maybe”" hint={stage === "ta" ? "Maybe moves a record on to full text." : "Usually off: full text should settle it."}>
        <Toggle label={`${label} maybe`} checked={r[stage].maybe} onChange={(v) => change((p) => void (p.rules[stage].maybe = v))} />
      </Row>
      {r[stage].maybe && (
        <Row label="When choosing Maybe, require the criterion in doubt?" hint="Asked the same way as when excluding.">
          <Segmented label={`${label}: criterion for maybe`} value={r[stage].maybeReasons || "none"} options={REASON_RULES} onChange={(v) => change((p) => void (p.rules[stage].maybeReasons = v))} />
        </Row>
      )}
    </div>
  );
  return (
    <>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Team</h2>
          <Explain help="review.team" />
        </div>
        <Hint help="review.team.local" />
        <table className="kx-rv-table kx-rv-team">
          <tbody>
            {team.map((m, i) => (
              <tr key={m.id}>
                <td>
                  <input
                    className="kx-rv-input"
                    defaultValue={m.name}
                    aria-label="Name"
                    onBlur={(e) => {
                      const name = e.currentTarget.value.trim();
                      if (name && name !== m.name) saveTeam(team.map((x, j) => (j === i ? { ...x, name, initials: name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() } : x)));
                    }}
                  />
                </td>
                <td className="kx-rv-roles">
                  {roles.map(([id, label]) => (
                    <label key={id} className="kx-check">
                      <input type="checkbox" checked={m.roles.includes(id)} onChange={(e) => saveTeam(team.map((x, j) => (j === i ? { ...x, roles: e.target.checked ? [...x.roles, id] : x.roles.filter((y) => y !== id) } : x)))} />
                      {label}
                    </label>
                  ))}
                </td>
                <td>{m.id === viewer ? <span className="kx-rv-pill" data-tone="info">You</span> : <Btn small quiet onClick={() => saveTeam(team.filter((x) => x.id !== m.id))}>Remove</Btn>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Btn icon="plus" small onClick={() => saveTeam([...team, { id: newId("m"), name: `Reviewer ${team.length + 1}`, roles: ["reviewer"], initials: `R${team.length + 1}` }])}>
          Add a person
        </Btn>
      </section>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Screening rules</h2>
          <Explain help="review.rules" />
        </div>
        <div className="kx-rv-rule-grid">
          {stageRule("ta", "Title & abstract")}
          {stageRule("ft", "Full text")}
        </div>
        <Row label="Blind screening" hint="Reviewers see each other's decisions only once both have decided.">
          <Toggle label="Blind screening" checked={r.blind} onChange={(v) => change((p) => void (p.rules.blind = v))} />
        </Row>
        <Row label="Conflicts are resolved by" hint={r.conflicts === "third" ? "Only people with the tie-breaker or owner role can resolve." : "Any reviewer may record the agreed decision."}>
          <Segmented
            label="Conflicts"
            value={r.conflicts}
            options={[
              ["consensus", "Consensus"],
              ["third", "A tie-breaker"],
            ]}
            onChange={(v) => change((p) => void (p.rules.conflicts = v))}
          />
        </Row>
        <Row label="Show rule suggestions" hint="Criteria linked to metadata suggest an exclusion beside each record.">
          <Toggle label="Rule suggestions" checked={r.suggestions} onChange={(v) => change((p) => void (p.rules.suggestions = v))} />
        </Row>
        <Row label="AI assistance" hint="Off by default. A suggestion with its rationale from the AI provider in Key Settings; never a decision, never a reviewer. Titles and abstracts are sent to that provider.">
          <Toggle label="AI assistance" checked={r.aiAssist} onChange={(v) => change((p) => void (p.rules.aiAssist = v))} />
        </Row>
        <Row label="Also keep review marks as my highlights on library copies" hint="Off by default. Evidence, value sources and support passages in full texts that are library sources also become your highlights there, labelled with what they are for; they follow the marks when those change or go.">
          <Toggle label="Mirror review marks" checked={!!r.mirrorMarks} onChange={(v) => change((p) => void (p.rules.mirrorMarks = v))} />
        </Row>
        <Row label="Go to the next record after a decision" hint="Off: the record stays until Enter or J, to check what was recorded.">
          <Toggle label="Auto-advance" checked={r.autoAdvance !== false} onChange={(v) => change((p) => void (p.rules.autoAdvance = v))} />
        </Row>
        <Row label="Decision keys" hint="Single letters for include, exclude and maybe.">
          <span className="kx-rv-keys">
            {(["include", "exclude", "maybe"] as const).map((k) => (
              <label key={k}>
                <small>{k}</small>
                <input
                  className="kx-rv-input kx-rv-key"
                  maxLength={1}
                  value={draft.shortcuts[k] ?? k[0]}
                  onChange={(e) => change((p) => void (p.shortcuts[k] = e.target.value.toLowerCase().replace(/[^a-z]/, "") || k[0]))}
                />
              </label>
            ))}
          </span>
        </Row>
      </section>
    </>
  );
}

// ── Criteria ─────────────────────────────────────────────────────────────────────

const FIELDS: [string, string, "text" | "number" | "bool" | "list"][] = [
  ["itemType", "Document type", "text"],
  ["year", "Year", "number"],
  ["language", "Language", "text"],
  ["title", "Title", "text"],
  ["abstract", "Abstract", "text"],
  ["journal", "Journal", "text"],
  ["keywords", "Keywords", "list"],
  ["authors", "Authors", "list"],
  ["doi", "DOI", "text"],
  ["hasAbstract", "Has an abstract", "bool"],
  ["hasFullText", "Has full text", "bool"],
  ["hasDoi", "Has a DOI", "bool"],
  ["property", "Custom property…", "text"],
  ["formula", "Formula…", "bool"],
];
const OPS: Record<string, [string, string][]> = {
  text: [
    ["is", "is"],
    ["isNot", "is not"],
    ["oneOf", "is one of"],
    ["contains", "contains"],
    ["notContains", "does not contain"],
    ["exists", "is filled in"],
    ["missing", "is empty"],
  ],
  list: [
    ["contains", "contains"],
    ["notContains", "does not contain"],
    ["exists", "has any"],
    ["missing", "has none"],
  ],
  number: [
    ["ge", "is at least"],
    ["le", "is at most"],
    ["gt", "is after"],
    ["lt", "is before"],
    ["is", "is"],
  ],
  bool: [
    ["true", "yes"],
    ["false", "no"],
  ],
};
const fieldKind = (field: string) => (field.startsWith("property:") ? "text" : (FIELDS.find((f) => f[0] === field)?.[2] ?? "text"));

function ConditionRow({ c, onChange, onRemove }: { c: Condition; onChange: (c: Condition) => void; onRemove: () => void }) {
  const isProperty = c.field.startsWith("property:");
  const kind = fieldKind(c.field);
  const ops = c.field === "formula" ? [["true", "is true"] as [string, string]] : OPS[kind];
  return (
    <div className="kx-rv-condition">
      <select
        className="kx-rv-select"
        aria-label="Field"
        value={isProperty ? "property" : c.field}
        onChange={(e) => {
          const field = e.target.value === "property" ? "property:" : e.target.value;
          const k = fieldKind(field);
          onChange({ field, op: field === "formula" ? "true" : OPS[k][0][0], value: k === "bool" && field !== "formula" ? null : "" });
        }}
      >
        {FIELDS.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      {isProperty && <input className="kx-rv-input kx-rv-condition-name" placeholder="Property name" value={c.field.slice(9)} onChange={(e) => onChange({ ...c, field: `property:${e.target.value}` })} aria-label="Property name" />}
      {c.field !== "formula" && (
        <select className="kx-rv-select" aria-label="Comparison" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value })}>
          {ops.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      )}
      {(c.field === "formula" || (kind !== "bool" && !["exists", "missing"].includes(c.op))) && (
        <input
          className="kx-rv-input"
          aria-label="Value"
          placeholder={c.field === "formula" ? "{year} >= 2000 and {hasAbstract}" : c.field === "itemType" ? "journalArticle" : c.op === "oneOf" ? "en, de, fr" : ""}
          inputMode={kind === "number" ? "numeric" : undefined}
          value={String(c.value ?? "")}
          onChange={(e) => onChange({ ...c, value: kind === "number" && e.target.value.trim() !== "" && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value })}
        />
      )}
      <button type="button" className="kx-rv-icon" aria-label="Remove condition" onClick={onRemove}>
        <Icon name="minus" size={12} />
      </button>
    </div>
  );
}

function CriterionCard({ c, number, keys, onChange, onRemove, onMove, first, last, autoOpen }: { c: Criterion; number: number; keys?: { ta?: string; ft?: string }; onChange: (c: Criterion) => void; onRemove: () => void; onMove: (by: number) => void; first: boolean; last: boolean; autoOpen?: boolean }) {
  const [open, setOpen] = useState(!!autoOpen);
  const link = c.link;
  return (
    <li className="kx-rv-criterion">
      <div className="kx-rv-criterion-head">
        <span className="kx-rv-criterion-number" title="Its place in the order: PRISMA reports the first criterion a study does not meet">
          {number}
        </span>
        {keys && (keys.ta || keys.ft) && (
          <span className="kx-rv-criterion-keys" title="Its key while screening (title & abstract, then full text)">
            {keys.ta === keys.ft || !keys.ft || !keys.ta ? (
              <kbd>{(keys.ta ?? keys.ft)!.toUpperCase()}</kbd>
            ) : (
              <>
                <kbd>{keys.ta.toUpperCase()}</kbd>
                <kbd>{keys.ft.toUpperCase()}</kbd>
              </>
            )}
          </span>
        )}
        <span className="kx-rv-criterion-prefix">Include if</span>
        <input className="kx-rv-input kx-rv-criterion-label" placeholder="what a study must meet, e.g. adults aged 18 or over" value={c.label} onChange={(e) => onChange({ ...c, label: e.target.value })} aria-label="Criterion" autoFocus={autoOpen && !c.label} />
        {c.stages.length === 1 && <span className="kx-rv-pill" data-tone="muted">{c.stages[0] === "ta" ? "Title & abstract" : "Full text"}</span>}
        {link && (
          <span className="kx-rv-pill" data-tone="info" title="Linked to metadata">
            {link.effect === "auto" ? "Auto" : "Suggests"}
          </span>
        )}
        <button type="button" className="kx-rv-icon" aria-label="Move up" disabled={first} onClick={() => onMove(-1)}>
          <Icon name="chevronUp" size={12} />
        </button>
        <button type="button" className="kx-rv-icon" aria-label="Move down" disabled={last} onClick={() => onMove(1)}>
          <Icon name="chevronDown" size={12} />
        </button>
        <button type="button" className="kx-rv-icon" aria-label={open ? "Hide details" : "Show details"} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? "collapse" : "expand"} size={12} />
        </button>
        <button type="button" className="kx-rv-icon" aria-label="Remove criterion" onClick={onRemove}>
          <Icon name="trash" size={12} />
        </button>
      </div>
      <div className="kx-rv-criterion-reason">
        <span>Reported, when not met, as</span>
        <input className="kx-rv-input" value={c.reason} placeholder={reasonText({ ...c, reason: "" })} onChange={(e) => onChange({ ...c, reason: e.target.value })} aria-label="Reported when not met as" />
      </div>
      {open && (
        <div className="kx-rv-criterion-body">
          <label className="kx-rv-field" data-wide>
            <span>Guidance for reviewers</span>
            <textarea className="kx-rv-input" rows={2} placeholder="How to decide, borderline cases, examples" value={c.guidance} onChange={(e) => onChange({ ...c, guidance: e.target.value })} />
          </label>
          <div className="kx-rv-field">
            <span>Checked at</span>
            <span className="kx-rv-inline">
              {(["ta", "ft"] as Stage[]).map((s) => (
                <label key={s} className="kx-check">
                  <input type="checkbox" checked={c.stages.includes(s)} onChange={(e) => onChange({ ...c, stages: e.target.checked ? [...c.stages, s] : c.stages.filter((x) => x !== s) })} />
                  {s === "ta" ? "Title & abstract" : "Full text"}
                </label>
              ))}
            </span>
          </div>
          <div className="kx-rv-link">
            <div className="kx-rv-link-head">
              <label className="kx-check">
                <input type="checkbox" checked={!!link} onChange={(e) => onChange({ ...c, link: e.target.checked ? { conditions: [{ field: "year", op: "ge", value: 2000 }], all: true, effect: "suggest" } : null })} />
                Check it from the record’s details
              </label>
              <Explain help="review.criteria.link" />
            </div>
            {link && (
              <>
                <p className="kx-rv-muted">{link.failsWhen ? "Not met when" : "Met when"}</p>
                {link.conditions.map((cond, i) => (
                  <ConditionRow
                    key={i}
                    c={cond}
                    onChange={(next) => onChange({ ...c, link: { ...link, conditions: link.conditions.map((x, j) => (j === i ? next : x)) } })}
                    onRemove={() => onChange({ ...c, link: link.conditions.length > 1 ? { ...link, conditions: link.conditions.filter((_, j) => j !== i) } : null })}
                  />
                ))}
                <div className="kx-rv-link-tools">
                  <Btn small icon="plus" onClick={() => onChange({ ...c, link: { ...link, conditions: [...link.conditions, { field: "itemType", op: "is", value: "" }] } })}>
                    Condition
                  </Btn>
                  {link.conditions.length > 1 && <Segmented label="Match" value={link.all ? "all" : "any"} options={[["all", "All"], ["any", "Any"]]} onChange={(v) => onChange({ ...c, link: { ...link, all: v === "all" } })} />}
                  <span className="kx-rv-muted">otherwise</span>
                  <Segmented
                    label="Effect"
                    value={link.effect}
                    options={[
                      ["suggest", "Suggest exclude"],
                      ["auto", "Exclude automatically"],
                    ]}
                    onChange={(effect) => onChange({ ...c, link: { ...link, effect } })}
                  />
                </div>
                {link.effect === "auto" && <p className="kx-rv-warning">Undecided records that do not meet it are excluded by “Rules” under this criterion, counted by PRISMA as “marked ineligible by automation tools”, and can be taken back.</p>}
              </>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** Criteria grouped by the question's parts; order within the list is the reason hierarchy. */
function CriteriaSection({ draft, change, api, summary }: DraftProps) {
  const framework = draft.question.framework || "pico";
  const suggestions = useLoad(() => api.criteriaSuggestions(draft.question), [api, framework, JSON.stringify(draft.question.parts)]);
  const [fresh, setFresh] = useState<string>();
  const order = suggestions.value?.elements.map((e) => e.id) ?? [];
  // Elements in the framework's order, then any others criteria use (from an older question).
  const elements = [...order, ...[...new Set(draft.criteria.map((c) => c.element))].filter((e) => !order.includes(e))];
  const rank = (e: string) => (elements.indexOf(e) < 0 ? elements.length : elements.indexOf(e));
  /** Keeps the list grouped, so its order (the hierarchy) is what the groups show. */
  const grouped = (list: Criterion[]) => list.map((c, i) => [c, i] as const).sort((a, b) => rank(a[0].element) - rank(b[0].element) || a[1] - b[1]).map(([c]) => c);
  const add = (c: Criterion) =>
    change((p) => {
      const taken = new Set(p.criteria.map((x) => x.id));
      let id = c.id || newId("c-");
      for (let n = 2; taken.has(id); n++) id = `${c.id || "c"}-${n}`;
      p.criteria = grouped([...p.criteria, { ...c, id }]);
      // A blank criterion opens for writing; a suggestion is complete as it is.
      if (!c.label) setFresh(id);
    });
  const move = (id: string, by: number) =>
    change((p) => {
      const list = grouped(p.criteria);
      const i = list.findIndex((c) => c.id === id);
      const j = i + by;
      if (j < 0 || j >= list.length || list[j].element !== list[i].element) return;
      [list[i], list[j]] = [list[j], list[i]];
      p.criteria = list;
    });
  const shown = draft.criteria.map((c, i) => ({ c, i }));
  // Each criterion's key while screening, per stage (the same keys the screening view uses).
  const keyOf = (c: Criterion, stage: Stage) => {
    const list = draft.criteria.filter((x) => !x.stages.length || x.stages.includes(stage));
    const at = list.findIndex((x) => x.id === c.id);
    return at < 0 ? undefined : criterionKeys(list.length, boundKeys(draft.shortcuts ?? {}, draft.labelKeys ?? {}))[at];
  };
  const offered = (element: string) =>
    (suggestions.value?.criteria ?? []).filter((s) => s.element === element && !draft.criteria.some((c) => c.id === s.id || reasonText(c).toLowerCase() === reasonText(s).toLowerCase()));
  const part = (element: string) => {
    const key = ELEMENT_PART[framework]?.[element];
    return key ? draft.question.parts[key]?.trim() : undefined;
  };
  return (
    <section className="kx-rv-section kx-rv-criteria-editor">
      <div className="kx-rv-section-head">
        <h2>Eligibility criteria</h2>
        <Explain help="review.criteria" />
      </div>
      <Hint help="review.criteria.hint" />
      {elements.map((element) => {
        const mine = shown.filter(({ c }) => c.element === element);
        const chips = offered(element);
        const first = mine[0]?.i;
        const last = mine.at(-1)?.i;
        return (
          <div key={element} className="kx-rv-element" data-element={element}>
            <div className="kx-rv-element-head">
              <h3>{ELEMENT_LABEL[element] ?? element}</h3>
              {part(element) && <span className="kx-rv-muted">{part(element)}</span>}
            </div>
            {mine.length > 0 && (
              <ul className="kx-rv-criteria">
                {mine.map(({ c, i }) => (
                  <CriterionCard
                    key={c.id}
                    c={c}
                    number={i + 1}
                    keys={{ ta: keyOf(c, "ta"), ft: keyOf(c, "ft") }}
                    first={i === first}
                    last={i === last}
                    autoOpen={c.id === fresh}
                    onMove={(by) => move(c.id, by)}
                    onRemove={() => change((p) => void (p.criteria = p.criteria.filter((x) => x.id !== c.id)))}
                    onChange={(next) => change((p) => void (p.criteria = p.criteria.map((x) => (x.id === c.id ? next : x))))}
                  />
                ))}
              </ul>
            )}
            <div className="kx-rv-chips" aria-label={`Suggested criteria: ${ELEMENT_LABEL[element] ?? element}`}>
              {chips.map((s) => (
                <button key={s.id} type="button" className="kx-rv-chip" title={`Include if: ${s.label}${s.guidance ? ` — ${s.guidance}` : ""}`} onClick={() => add(s)}>
                  <Icon name="plus" size={10} />
                  {reasonText(s)}
                </button>
              ))}
              {element === "other" &&
                (summary.otherReasons ?? [])
                  .filter((o) => !draft.criteria.some((c) => reasonText(c).toLowerCase() === o.text.toLowerCase()))
                  .map((o) => (
                    <button key={o.text} type="button" className="kx-rv-chip" data-from-other title={`Written under Other ${o.count} times while screening: make it a criterion`} onClick={() => add({ id: "", element, label: `Not: ${o.text}`, reason: o.text, guidance: "", stages: ["ta", "ft"], link: null })}>
                      <Icon name="plus" size={10} />
                      {o.text} <small>· Other ×{o.count}</small>
                    </button>
                  ))}
              <button type="button" className="kx-rv-chip" data-blank onClick={() => add({ id: "", element, label: "", reason: "", guidance: "", stages: ["ta", "ft"], link: null })}>
                <Icon name="plus" size={10} />
                Own criterion
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

const REASON_RULES: [ReasonRule, string][] = [
  ["none", "No"],
  ["first", "The first one"],
  ["all", "All that apply"],
];

// ── Keywords and labels ──────────────────────────────────────────────────────────

function ListInput({ value, onChange, placeholder, label }: { value: string[]; onChange: (v: string[]) => void; placeholder: string; label: string }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => setText(value.join(", ")), [value]);
  return (
    <textarea
      className="kx-rv-input"
      rows={2}
      aria-label={label}
      placeholder={placeholder}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(text.split(/[,\n]/).map((t) => t.trim()).filter(Boolean))}
    />
  );
}

function KeywordsSection({ draft, change }: DraftProps) {
  return (
    <>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Highlighted words</h2>
          <Explain help="review.keywords" />
        </div>
        <Row label={<span className="kx-rv-mark" data-kind="include">For inclusion</span>} hint="Comma-separated; end with * for any ending (random*)." wide>
          <ListInput label="Words for inclusion" value={draft.keywords.include} placeholder="randomi*, trial, adults" onChange={(v) => change((p) => void (p.keywords.include = v))} />
        </Row>
        <Row label={<span className="kx-rv-mark" data-kind="exclude">For exclusion</span>} wide>
          <ListInput label="Words for exclusion" value={draft.keywords.exclude} placeholder="mice, rats, protocol, editorial" onChange={(v) => change((p) => void (p.keywords.exclude = v))} />
        </Row>
        <Row label="Labels" hint="Tags for records, offered in screening." wide>
          <ListInput label="Labels" value={draft.labels} placeholder="Background, Check later" onChange={(v) => change((p) => void (p.labels = v))} />
        </Row>
        {draft.labels.length > 0 && (
          <Row label="Label keys" hint="A letter toggles the label while screening (it does not move on). Not I, E, M, J, K, U or N." wide>
            <span className="kx-rv-keys">
              {draft.labels.map((l) => (
                <label key={l}>
                  <small>{l}</small>
                  <input
                    className="kx-rv-input kx-rv-key"
                    maxLength={1}
                    aria-label={`Key for ${l}`}
                    value={draft.labelKeys?.[l] ?? ""}
                    onChange={(e) =>
                      change((p) => {
                        const k = e.target.value.toLowerCase().replace(/[^a-z]/, "");
                        p.labelKeys = { ...(p.labelKeys ?? {}) };
                        if (k) p.labelKeys[l] = k;
                        else delete p.labelKeys[l];
                      })
                    }
                  />
                </label>
              ))}
            </span>
          </Row>
        )}
      </section>
    </>
  );
}

// ── Pilot rounds and assignment ──────────────────────────────────────────────────

function kappaText(k: number | null | undefined, band?: string) {
  if (k == null) return "–";
  return `${k.toFixed(2)}${band ? ` (${band})` : ""}`;
}

function SplitsSection({ summary, api, viewer, notify, onChanged }: StageProps) {
  const reviewers = summary.team.filter((m) => m.roles.includes("reviewer") || m.roles.includes("owner"));
  const [stage, setStage] = useState<Stage>("ta");
  const [size, setSize] = useState(Math.min(50, Math.max(10, Math.round(summary.active * 0.05))));
  const [who, setWho] = useState<string[]>(reviewers.slice(0, 2).map((m) => m.id));
  const current = summary.assignments.find((a) => a.stage === stage);
  const [mode, setMode] = useState<"everyone" | "split">((current?.assignment?.mode as "split") ?? "everyone");
  const [shares, setShares] = useState<Record<string, number>>(() => Object.fromEntries(reviewers.map((m) => [m.id, current?.assignment?.reviewers.find((r) => r.id === m.id)?.share ?? 1])));
  const [double, setDouble] = useState(Math.round((current?.assignment?.double ?? 0) * 100));
  const pilots = summary.pilots.filter((p) => p.pilot.stage === stage);
  const agreement = useLoad(() => api.agreement(stage), [api, stage, summary.events]);
  const totalShare = reviewers.reduce((n, m) => n + (shares[m.id] ?? 0), 0) || 1;
  return (
    <>
      <div className="kx-rv-inline">
        <Segmented label="Stage" value={stage} options={[["ta", "Title & abstract"], ["ft", "Full text"]]} onChange={setStage} />
      </div>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Pilot rounds</h2>
          <Explain help="review.pilot" />
        </div>
        {pilots.length > 0 && (
          <table className="kx-rv-table">
            <thead>
              <tr>
                <th>Round</th>
                <th className="kx-rv-num">Screened</th>
                <th className="kx-rv-num">Agreement</th>
                <th className="kx-rv-num">Kappa</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {pilots.map(({ pilot, done, agreement: a }) => (
                <tr key={pilot.id}>
                  <td>
                    <strong>{pilot.name}</strong>
                    <small>{pilot.reviewers.map((id) => summary.team.find((m) => m.id === id)?.name ?? id).join(", ")}</small>
                  </td>
                  <td className="kx-rv-num">
                    {done} / {pilot.records.length}
                  </td>
                  <td className="kx-rv-num">{a.overall.percent == null ? "–" : `${a.overall.percent.toFixed(0)}%`}</td>
                  <td className="kx-rv-num" title={a.overall.method}>
                    {kappaText(a.overall.kappa, a.overall.band)}
                  </td>
                  <td>
                    {pilot.open ? (
                      <Btn small onClick={() => void api.pilotSet(pilot.id, false, viewer).then(onChanged)}>Close round</Btn>
                    ) : (
                      <span className="kx-rv-muted">Closed</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="kx-rv-pilot-form">
          <label className="kx-rv-field">
            <span>Sample size</span>
            <input className="kx-rv-input kx-rv-short" type="number" min={5} value={size} onChange={(e) => setSize(Number(e.target.value) || 10)} />
          </label>
          <div className="kx-rv-field">
            <span>Reviewers</span>
            <span className="kx-rv-inline">
              {reviewers.map((m) => (
                <label key={m.id} className="kx-check">
                  <input type="checkbox" checked={who.includes(m.id)} onChange={(e) => setWho(e.target.checked ? [...who, m.id] : who.filter((x) => x !== m.id))} />
                  {m.name}
                </label>
              ))}
            </span>
          </div>
          <Btn
            primary
            disabled={who.length < 2}
            title={who.length < 2 ? "Add a second reviewer in Team & rules" : undefined}
            onClick={() =>
              void api
                .pilotCreate(stage, size, who, "", viewer)
                .then((p) => {
                  notify(`${p.name}: ${plural(p.records.length, "record")} drawn at random for ${who.length} reviewers`, "ok");
                  onChanged();
                })
                .catch((e) => notify(errorText(e), "error"))
            }
          >
            Start a pilot round
          </Btn>
        </div>
      </section>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Who screens what</h2>
          <Explain help="review.assign" />
        </div>
        <Row label="Records go to">
          <Segmented label="Assignment" value={mode} options={[["everyone", "Everyone (as many as the rules need)"], ["split", "Split between reviewers"]]} onChange={setMode} />
        </Row>
        {mode === "split" && (
          <>
            {reviewers.map((m) => (
              <Row key={m.id} label={m.name} hint={`${Math.round(((shares[m.id] ?? 0) / totalShare) * 100)}% of the records${current?.counts[m.id] ? ` · ${current.counts[m.id].toLocaleString()} assigned now` : ""}`}>
                <input className="kx-rv-input kx-rv-short" type="number" min={0} step={1} value={shares[m.id] ?? 0} onChange={(e) => setShares({ ...shares, [m.id]: Math.max(0, Number(e.target.value)) })} aria-label={`${m.name}'s share`} />
              </Row>
            ))}
            <Row label="Also screened by a second reviewer" hint="A random share, for checking agreement during the main round.">
              <span className="kx-rv-inline">
                <input className="kx-rv-input kx-rv-short" type="number" min={0} max={100} value={double} onChange={(e) => setDouble(Math.min(100, Math.max(0, Number(e.target.value))))} aria-label="Double-screened percent" />%
              </span>
            </Row>
          </>
        )}
        <Btn
          primary
          onClick={() =>
            void api
              .assign(stage, mode, mode === "split" ? reviewers.map((m) => ({ id: m.id, share: shares[m.id] ?? 0 })).filter((r) => r.share > 0) : [], double / 100, viewer)
              .then(() => {
                notify(mode === "split" ? "Records split between reviewers" : "Everyone screens every record", "ok");
                onChanged();
              })
              .catch((e) => notify(errorText(e), "error"))
          }
        >
          Apply
        </Btn>
      </section>
      {agreement.value && agreement.value.overall.n > 0 && (
        <section className="kx-rv-section">
          <div className="kx-rv-section-head">
            <h2>Agreement so far</h2>
            <Explain help="review.kappa" />
          </div>
          <p>
            Over {plural(agreement.value.overall.n, "record")} screened by more than one person: {agreement.value.overall.percent?.toFixed(0)}% agreement, {agreement.value.overall.method} {kappaText(agreement.value.overall.kappa, agreement.value.overall.band)}.
          </p>
          {agreement.value.pairs.length > 1 && (
            <ul className="kx-rv-plain">
              {agreement.value.pairs.map((p) => (
                <li key={`${p.a}-${p.b}`}>
                  {p.aName} and {p.bName}: {p.agreement.percent?.toFixed(0)}%, kappa {kappaText(p.agreement.kappa)} ({p.agreement.n})
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

// ── Versions and audit ───────────────────────────────────────────────────────────

function HistorySection({ summary, api, viewer }: StageProps) {
  const [offset, setOffset] = useState(0);
  const audit = useLoad(() => api.audit(offset, 100), [api, offset, summary.events]);
  const versions = useMemo(() => [...summary.versions].reverse(), [summary.versions]);
  return (
    <>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Protocol versions</h2>
          <Explain help="review.versions" />
        </div>
        <ol className="kx-rv-versions">
          {versions.map((v) => (
            <li key={v.id} data-current={v.number === summary.versionNumber || undefined}>
              <strong>Version {v.number}</strong>
              <span>{v.note || (v.number === 1 ? "First version" : "No note")}</span>
              <small>
                {v.actorName} · {formatTime(v.at)} · {plural(v.decisions, "decision")}
              </small>
            </li>
          ))}
        </ol>
      </section>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Audit trail</h2>
          <Btn small icon="download" onClick={() => void api.exportFile("audit", viewer).then((f) => downloadText(f.filename, f.content, f.mime))}>
            Export CSV
          </Btn>
        </div>
        <Hint help="review.audit" />
        <table className="kx-rv-table kx-rv-audit">
          <tbody>
            {audit.value?.events.map((e) => (
              <tr key={e.id}>
                <td className="kx-rv-muted">{formatTime(e.at)}</td>
                <td>{e.actorName}</td>
                <td>{e.what}</td>
                <td className="kx-rv-muted">{e.version ? `v${e.version}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {audit.value && audit.value.total > 100 && (
          <div className="kx-rv-inline">
            <Btn small disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>
              Newer
            </Btn>
            <span className="kx-rv-muted">
              {offset + 1}–{Math.min(audit.value.total, offset + 100)} of {audit.value.total.toLocaleString()}
            </span>
            <Btn small disabled={offset + 100 >= audit.value.total} onClick={() => setOffset(offset + 100)}>
              Older
            </Btn>
          </div>
        )}
      </section>
    </>
  );
}

