// Certainty of the evidence (GRADE) per outcome, and the Summary of findings table. For each
// outcome Key runs its analysis and suggests a judgement for each domain from the data, with its
// reasons (key_review::grade); a suggestion is never applied by itself: choose each judgement,
// and write a footnote for any that rates down or up, or differs from the suggestion. The
// certainty, its explanation, the absolute effects and the plain-language statement come from
// Rust; this file lays them out.
import { useEffect, useMemo, useState } from "react";
import { EmptyState, Explain, Hint } from "../explain";
import { downloadText } from "../db-ui";
import { Icon } from "../icons";
import { formatNumber } from "../charts/scale";
import { certaintyApi, takeCertainty, type GradeOutcome, type Rating, type Sof } from "./review-certainty-api";
import { Btn, MenuButton, Segmented, errorText, useLoad } from "./review-ui";
import type { StageProps } from "./ReviewPage";
import "./review-rob.css";

const DOWN: [string, string, string][] = [
  ["riskOfBias", "Risk of bias", "Limitations in the studies' design or conduct for this outcome."],
  ["inconsistency", "Inconsistency", "Studies' results differ more than chance would explain, without a reason found."],
  ["indirectness", "Indirectness", "The studies' people, interventions, comparisons or outcomes differ from the question."],
  ["imprecision", "Imprecision", "The interval is wide, includes no effect or an important one, or there are too few participants."],
  ["publicationBias", "Publication bias", "Studies may be missing because of their results."],
];
const UP: [string, string, string][] = [
  ["largeEffect", "Large effect", "A large effect is unlikely to be explained by bias alone."],
  ["doseResponse", "Dose–response gradient", "More exposure goes with more effect."],
  ["confounding", "Confounding would reduce the effect", "Residual confounding would push towards no effect, yet an effect is seen."],
];
const DOWN_OPTS: [string, string][] = [
  ["none", "Not serious"],
  ["serious", "Serious (−1)"],
  ["verySerious", "Very serious (−2)"],
];
const OPTS: Record<string, [string, string][]> = {
  largeEffect: [
    ["none", "No"],
    ["large", "Large (+1)"],
    ["veryLarge", "Very large (+2)"],
  ],
  doseResponse: [
    ["none", "No"],
    ["present", "Yes (+1)"],
  ],
  confounding: [
    ["none", "No"],
    ["present", "Yes (+1)"],
  ],
};
const LABEL: Record<string, string> = { none: "not serious", serious: "serious", verySerious: "very serious", large: "large", veryLarge: "very large", present: "yes" };
const MEASURES: Record<string, [string, string][]> = {
  dichotomous: [["RR", "Risk ratio"], ["OR", "Odds ratio"], ["RD", "Risk difference"]],
  continuous: [["MD", "Mean difference"], ["SMD", "Standardised mean difference"]],
  generic: [["GEN", "Generic inverse variance"]],
};
const LEVEL_N: Record<string, number> = { high: 4, moderate: 3, low: 2, veryLow: 1 };

/** The GRADE circles: filled for each level of certainty, drawn (not font glyphs). */
export function CertaintyMark({ level, label = true }: { level: string | null | undefined; label?: boolean }) {
  if (!level) return null;
  const n = LEVEL_N[level] ?? 1;
  const text = { high: "High", moderate: "Moderate", low: "Low", veryLow: "Very low" }[level] ?? level;
  return (
    <span className="kx-gr-certainty" title={`${text} certainty`}>
      <span className="kx-gr-symbols" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <svg key={i} width="11" height="11" viewBox="0 0 11 11">
            <circle cx="5.5" cy="5.5" r="4.6" style={{ fill: i < n ? "var(--kx-accent)" : "none", stroke: "var(--kx-accent)", strokeWidth: 1.2 }} />
          </svg>
        ))}
      </span>
      {label && <span>{text}</span>}
    </span>
  );
}

const certaintyOf = (o: GradeOutcome) => (Array.isArray(o.certainty) ? { level: o.certainty[0], label: o.certainty[0], explanation: o.certainty[1] } : o.certainty);

export function Certainty(props: StageProps) {
  const { invoke, workspaceId, reviewId, summary, viewer, notify } = props;
  const api = useMemo(() => certaintyApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const list = useLoad(() => api.gradeList(), [api, summary.events]);
  const [view, setView] = useState<"outcomes" | "sof">("outcomes");
  const [key, setKey] = useState<string>();
  const [handed, setHanded] = useState<ReturnType<typeof takeCertainty>>(null);
  useEffect(() => {
    const h = takeCertainty(reviewId);
    if (h) {
      setHanded(h);
      setKey(h.key);
      setView("outcomes");
    }
  }, [reviewId]);
  const outcomes = list.value?.outcomes ?? [];
  useEffect(() => {
    if (!key && outcomes.length) setKey(outcomes[0].key);
  }, [key, outcomes]);
  if (!summary.included) return <EmptyState help="empty.review.analysis" icon="activity" learnMore="review.grade" />;
  if (list.value && !outcomes.length) return <EmptyState help="empty.review.outcomes" icon="table" action={{ label: "Add an outcome data form in Setup", onClick: () => props.go("setup") }} learnMore="review.grade" />;
  const rated = outcomes.filter((o) => o.rated);
  const move = (k: string, by: number) => {
    const order = rated.map((o) => o.key);
    const i = order.indexOf(k);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    void api.gradeOrder(order, viewer).then(list.reload).catch((e) => notify(errorText(e), "error"));
  };
  const exportFile = (kind: string) => props.api.exportFile(kind, viewer).then((f) => downloadText(f.filename, f.content, f.mime)).catch((e) => notify(errorText(e), "error"));
  return (
    <div className="kx-rv-extract kx-gr-stage">
      <div className="kx-rv-toolbar kx-rv-extract-bar">
        <Segmented label="Certainty view" value={view} onChange={setView} options={[["outcomes", "Rate outcomes"], ["sof", rated.length ? `Summary of findings (${rated.length})` : "Summary of findings"]]} />
        <span className="kx-rv-muted">
          {rated.length} of {outcomes.length} outcomes rated
        </span>
        <span className="kx-rv-spacer" />
        <Explain help="review.grade" />
        <MenuButton
          label="Export summary of findings"
          icon="download"
          items={[
            { label: "Summary of findings for Word (HTML)", run: () => void exportFile("sof-html") },
            { label: "Summary of findings (Markdown)", run: () => void exportFile("sof-md") },
            { label: "Summary of findings (CSV)", run: () => void exportFile("sof-csv") },
            null,
            { label: "Certainty judgements and footnotes (CSV)", run: () => void exportFile("grade-csv") },
          ]}
        />
      </div>
      {view === "sof" ? (
        <SofView api={api} events={summary.events} onOpen={(k) => { setKey(k); setView("outcomes"); }} />
      ) : (
        <div className="kx-gr">
          <ul className="kx-gr-list" aria-label="Outcomes">
            {outcomes.map((o) => (
              <li key={o.key}>
                <button type="button" aria-current={o.key === key || undefined} onClick={() => setKey(o.key)}>
                  <span>{o.label}</span>
                  <small>
                    {o.rated ? <CertaintyMark level={o.level} /> : "Not rated yet"}
                    {o.studies ? ` · ${o.studies} ${o.studies === 1 ? "study" : "studies"}` : ""}
                  </small>
                </button>
                {o.rated && (
                  <span className="kx-gr-order">
                    <button type="button" aria-label="Move up in the summary" onClick={() => move(o.key, -1)}>
                      <Icon name="chevronUp" size={10} />
                    </button>
                    <button type="button" aria-label="Move down in the summary" onClick={() => move(o.key, 1)}>
                      <Icon name="chevronDown" size={10} />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {key && <OutcomeRating key={key} {...props} api2={api} outcomeKey={key} handed={handed?.key === key ? handed : null} onSaved={list.reload} />}
        </div>
      )}
    </div>
  );
}

function OutcomeRating(props: StageProps & { api2: ReturnType<typeof certaintyApi>; outcomeKey: string; handed: ReturnType<typeof takeCertainty>; onSaved: () => void }) {
  const { api2: api, outcomeKey, viewer, notify, handed } = props;
  const stored = useLoad(() => api.gradeOutcome(outcomeKey), [api, outcomeKey]);
  const [draft, setDraft] = useState<Rating>();
  const [preview, setPreview] = useState<GradeOutcome>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const v = stored.value;
    if (!v) return;
    const r = { ...v.rating };
    if (!v.stored && handed) r.analysis = { measure: handed.options.measure, method: handed.options.method, hartungKnapp: handed.options.hartungKnapp };
    setDraft(r);
    setPreview(v);
  }, [stored.value, handed]);
  // Suggestions follow the draft (assumed risk, MID, measure) before it is saved.
  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(() => void api.gradePreview(draft).then(setPreview).catch(() => {}), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, draft?.analysis.measure, draft?.analysis.method, draft?.analysis.hartungKnapp, draft?.mid, draft?.ois, draft?.assumedRisk, draft?.design, draft?.start, JSON.stringify(draft?.domains), draft?.label]);
  if (!draft || !preview) return <div className="kx-gr-main" aria-busy="true" />;
  const set = (patch: Partial<Rating>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setDomain = (id: string, patch: Partial<{ judgement: string; footnote: string }>) => set({ domains: { ...draft.domains, [id]: { judgement: draft.domains[id]?.judgement ?? "", footnote: draft.domains[id]?.footnote ?? "", ...patch } } });
  const c = certaintyOf(preview);
  const a = preview.analysis;
  const kind = (preview.kind || "dichotomous") as keyof typeof MEASURES;
  const save = () => {
    setSaving(true);
    setError("");
    api
      .gradeSet(draft, viewer)
      .then(() => {
        notify(`${preview.label}: certainty saved`, "ok");
        stored.reload();
        props.onSaved();
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setSaving(false));
  };
  const nonRandomised = draft.design === "nonRandomised";
  const domains = nonRandomised ? [...DOWN, ...UP] : DOWN;
  const unjudged = domains.filter(([id]) => !draft.domains[id]?.judgement).length;
  return (
    <div className="kx-gr-main">
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>{preview.label}</h2>
          <CertaintyMark level={c.level} />
        </div>
        <p className="kx-rv-muted">{c.explanation}</p>
        {preview.error ? (
          <p className="kx-inline-error">{preview.error}</p>
        ) : (
          a && (
            <dl className="kx-gr-facts">
              <div>
                <dt>{a.measureLabel}</dt>
                <dd>
                  {formatNumber(a.estimate)} [{formatNumber(a.lower)}, {formatNumber(a.upper)}]
                </dd>
              </div>
              <div>
                <dt>Studies (participants)</dt>
                <dd>
                  {a.k}
                  {preview.participants ? ` (${Math.round(preview.participants).toLocaleString()})` : ""}
                </dd>
              </div>
              <div>
                <dt>I²</dt>
                <dd>{a.i2.toFixed(0)}%</dd>
              </div>
              {preview.effectText && (
                <div>
                  <dt>{preview.absolute ? "Absolute effect" : "Difference"}</dt>
                  <dd>{preview.effectText}</dd>
                </div>
              )}
              {preview.robCoverage && (
                <div>
                  <dt>Risk of bias assessed</dt>
                  <dd>
                    {preview.robCoverage.assessed} of {preview.robCoverage.total}
                  </dd>
                </div>
              )}
            </dl>
          )
        )}
        <div className="kx-rv-analysis-controls">
          <label className="kx-rv-field">
            <span>Name in the table</span>
            <input className="kx-rv-input" value={draft.label} placeholder={preview.label} onChange={(e) => set({ label: e.target.value })} />
          </label>
          <label className="kx-rv-field">
            <span>Importance</span>
            <select className="kx-rv-select" value={draft.importance ?? ""} onChange={(e) => set({ importance: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Not rated</option>
              {[9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {n} · {n >= 7 ? "critical" : n >= 4 ? "important" : "of limited importance"}
                </option>
              ))}
            </select>
          </label>
          <label className="kx-rv-field">
            <span>Effect measure</span>
            <select className="kx-rv-select" value={draft.analysis.measure} onChange={(e) => set({ analysis: { ...draft.analysis, measure: e.target.value } })}>
              {(MEASURES[kind] ?? MEASURES.generic).map(([m, l]) => (
                <option key={m} value={m}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <div className="kx-rv-field">
            <span>Model</span>
            <Segmented label="Model" value={draft.analysis.method as "fe" | "dl" | "reml"} options={[["fe", "Fixed"], ["dl", "DL"], ["reml", "REML"]]} onChange={(v) => set({ analysis: { ...draft.analysis, method: v } })} />
          </div>
        </div>
        <div className="kx-rv-analysis-controls">
          <div className="kx-rv-field">
            <span>Evidence from</span>
            <Segmented label="Evidence from" value={draft.design} options={[["randomised", "Randomised trials"], ["nonRandomised", "Non-randomised studies"]]} onChange={(v) => set({ design: v, start: "" })} />
          </div>
          {nonRandomised && (
            <div className="kx-rv-field" title="With ROBINS-I, non-randomised evidence may start high, since that tool already rates confounding and selection">
              <span>Starts</span>
              <Segmented label="Starting level" value={draft.start || "low"} options={[["low", "Low"], ["high", "High (rated with ROBINS-I)"]]} onChange={(v) => set({ start: v })} />
            </div>
          )}
          {kind !== "continuous" && kind !== "generic" && (
            <label className="kx-rv-field" title="The risk without the intervention, per 1,000, for the absolute effects">
              <span>Assumed risk per 1,000</span>
              <input className="kx-rv-input kx-rv-short" type="number" min={0} max={1000} value={draft.assumedRisk ?? ""} placeholder={preview.studyControlRisk != null ? String(Math.round(preview.studyControlRisk)) : ""} onChange={(e) => set({ assumedRisk: e.target.value === "" ? null : Number(e.target.value) })} />
            </label>
          )}
          <label className="kx-rv-field" title={kind === "continuous" ? "In the outcome's units (SDs for a standardised mean difference)" : "Per 1,000: the smallest difference people would care about"}>
            <span>Smallest important difference</span>
            <input className="kx-rv-input kx-rv-short" type="number" min={0} value={draft.mid ?? ""} onChange={(e) => set({ mid: e.target.value === "" ? null : Number(e.target.value) })} />
          </label>
          <label className="kx-rv-field" title="Optimal information size in participants; empty: computed where it can be">
            <span>Information size</span>
            <input className="kx-rv-input kx-rv-short" type="number" min={0} value={draft.ois ?? ""} placeholder="auto" onChange={(e) => set({ ois: e.target.value === "" ? null : Number(e.target.value) })} />
          </label>
        </div>
      </section>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>{nonRandomised ? "Rate down, or up" : "Rate down"}</h2>
          <span className="kx-rv-muted">{unjudged ? `${unjudged} still to judge` : "Every domain judged"}</span>
        </div>
        {domains.map(([id, name, about]) => {
          const s = preview.suggestions?.[id];
          const d = draft.domains[id];
          const opts = OPTS[id] ?? DOWN_OPTS;
          const moved = d?.judgement && d.judgement !== "none";
          const differs = s?.judgement && d?.judgement && s.judgement !== d.judgement;
          return (
            <div key={id} className="kx-gr-domain" data-domain={id}>
              <div>
                <h3>{name}</h3>
                <p className="kx-rv-muted">{about}</p>
              </div>
              <div>
                <div className="kx-gr-suggest">
                  {s?.judgement ? (
                    <>
                      <span className="kx-rv-pill" data-tone={s.judgement === "none" ? "green" : "amber"}>
                        Key suggests: {LABEL[s.judgement] ?? s.judgement}
                      </span>
                      {d?.judgement !== s.judgement && (
                        <Btn small quiet onClick={() => setDomain(id, { judgement: s.judgement! })}>
                          Use
                        </Btn>
                      )}
                    </>
                  ) : (
                    <span className="kx-rv-pill">Judge by hand</span>
                  )}
                </div>
                {s && s.why.length > 0 && (
                  <ul>
                    {s.why.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                <Segmented label={name} value={d?.judgement || ""} options={opts as [string, string][]} onChange={(v) => setDomain(id, { judgement: v })} />
                {(moved || differs || d?.footnote) && (
                  <textarea
                    className="kx-rv-input"
                    rows={2}
                    aria-label={`${name} footnote`}
                    data-waiting={!d?.footnote?.trim() || undefined}
                    placeholder={differs ? "Footnote: why you differ from the suggestion (required)" : "Footnote: the reason, as it will read under the table (required)"}
                    value={d?.footnote ?? ""}
                    onChange={(e) => setDomain(id, { footnote: e.target.value })}
                  />
                )}
              </div>
            </div>
          );
        })}
      </section>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>What it means</h2>
        </div>
        <p className="kx-gr-statement">{draft.statement || preview.suggestedStatement}</p>
        <label className="kx-rv-field" data-wide>
          <span>Your wording (empty: Key's suggestion from the effect and its certainty)</span>
          <textarea className="kx-rv-input" rows={2} value={draft.statement} onChange={(e) => set({ statement: e.target.value })} />
        </label>
        <label className="kx-rv-field" data-wide>
          <span>Comment for the table</span>
          <input className="kx-rv-input" value={draft.comment} onChange={(e) => set({ comment: e.target.value })} />
        </label>
        <Hint help="review.grade.statement" />
      </section>
      {error && <p className="kx-inline-error">{error}</p>}
      <div className="kx-rv-dialog-actions">
        {preview.history?.changes ? <span className="kx-rv-muted">Saved {preview.history.changes} {preview.history.changes === 1 ? "time" : "times"}, last by {preview.history.by}</span> : <span />}
        <Btn primary disabled={saving} onClick={save}>
          {preview.stored ? "Save changes" : "Save rating"}
        </Btn>
      </div>
    </div>
  );
}

function SofView({ api, events, onOpen }: { api: ReturnType<typeof certaintyApi>; events: number; onOpen: (key: string) => void }) {
  const sof = useLoad(() => api.sof(), [api, events]);
  const t: Sof | undefined = sof.value;
  if (sof.error) return <p className="kx-inline-error">{sof.error}</p>;
  if (!t) return <div className="kx-gr-main" aria-busy="true" />;
  if (!t.rows.length) return <EmptyState help="empty.review.sof" icon="table" compact />;
  return (
    <div className="kx-gr-main">
      <table className="kx-rv-table kx-gr-sof">
        <thead>
          <tr>
            <th>Outcome</th>
            <th className="kx-rv-num">Without the intervention</th>
            <th className="kx-rv-num">With the intervention</th>
            <th>Difference (95% CI)</th>
            <th>Relative effect (95% CI)</th>
            <th>Participants (studies)</th>
            <th>Certainty</th>
            <th>What happens</th>
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r) => (
            <tr key={r.key}>
              <td>
                <button type="button" className="kx-gr-link" onClick={() => onOpen(r.key)}>
                  {r.outcome}
                </button>
                {r.importanceLabel && <small>{r.importanceLabel}</small>}
              </td>
              <td className="kx-rv-num">{r.assumed != null ? `${Math.round(r.assumed)} per 1,000` : "–"}</td>
              <td className="kx-rv-num">{r.corresponding ? `${Math.round(r.corresponding[0])} per 1,000` : "–"}{r.corresponding && <small>{Math.round(r.corresponding[1])} to {Math.round(r.corresponding[2])}</small>}</td>
              <td>{r.effect ?? "–"}</td>
              <td>{r.relative ?? "–"}</td>
              <td>
                {r.participants ? Math.round(r.participants).toLocaleString() : "–"}
                <small>{r.design}</small>
              </td>
              <td>
                <CertaintyMark level={r.certainty} />
                {r.footnotes.length > 0 && <small>({r.footnotes.join(", ")})</small>}
              </td>
              <td>
                {r.statement}
                {r.comment && <small>{r.comment}</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {t.footnotes.length > 0 && (
        <ol className="kx-gr-notes" type="a">
          {t.footnotes.map((n) => (
            <li key={n.mark}>{n.text}</li>
          ))}
        </ol>
      )}
      <Hint help="review.grade.levels" />
      <Hint help="review.grade.gradepro" />
    </div>
  );
}
