// Analysis: pool an extracted outcome across the included studies (key-review's meta.rs) and
// show the forest plot, heterogeneity, subgroups, leave-one-out and the funnel plot with Egger's
// test. Every number comes from Rust; this file only lays them out. Below the model controls and
// the headline, the views (review-synthesis.tsx): pooled result, small-study effects,
// meta-regression, several estimates per study and sensitivity.
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, Explain, Hint } from "../explain";
import { ForestPlot, type ForestPlotProps, type ForestRow } from "../charts/charts";
import { pngBlob, saveFile, svgMarkup } from "../charts/export";
import { formatNumber } from "../charts/scale";
import type { Analysis, Pooled } from "./review-api";
import { MenuButton, Segmented, Toggle, errorText, useLoad } from "./review-ui";
import { AdvancedSynthesis } from "./review-synthesis";
import { backTransform } from "./review-synthesis-api";
import type { StageProps } from "./ReviewPage";
// std-C: risk of bias in the analysis (forest plot columns, sensitivity, subgroups) and GRADE.
import { RateCertainty, RobControl, RobFlags, useRobAnalysis } from "./review-rob-analysis";
import "./review-rob.css";
// end std-C

const MEASURES: Record<string, [string, string][]> = {
  dichotomous: [
    ["RR", "Risk ratio"],
    ["OR", "Odds ratio"],
    ["RD", "Risk difference"],
  ],
  continuous: [
    ["MD", "Mean difference"],
    ["SMD", "Standardised mean difference"],
  ],
  generic: [["GEN", "Generic inverse variance"]],
};
// std-D: more effect sizes for each data type.
MEASURES.continuous.push(["ROM", "Response ratio (ratio of means)"], ["SMCR", "Standardised mean change (pre–post)"]);
MEASURES.generic.push(["HR", "Hazard ratio (from HR and CI)"], ["PCOR", "Partial correlation (from t and df)"], ["PCORSD", "Partial correlation, economics SE"]);
MEASURES.correlation = [["ZCOR", "Correlation (Fisher's z)"], ["COR", "Correlation (r)"], ["PCOR", "Partial correlation (from t and df)"]];
MEASURES.proportion = [["PLO", "Proportion (logit)"], ["PFT", "Proportion (double arcsine)"]];
MEASURES.rate = [["IRR", "Incidence rate ratio"]];

const p = (v: number) => (v < 0.001 ? "< 0.001" : v.toFixed(3));

interface Input {
  id: string;
  label: string;
  e1?: number | null;
  n1?: number | null;
  e2?: number | null;
  n2?: number | null;
  m1?: number | null;
  sd1?: number | null;
  m2?: number | null;
  sd2?: number | null;
}

export function AnalysisView(stageProps: StageProps) {
  const { api, summary, notify, go } = stageProps;
  const outcomes = useLoad(() => api.outcomes(), [api, summary.events]);
  const [choice, setChoice] = useState(0);
  const chosen = outcomes.value?.[choice];
  const kind = (chosen?.kind || "dichotomous") as keyof typeof MEASURES;
  const [measure, setMeasure] = useState("RR");
  const [method, setMethod] = useState<"fe" | "dl" | "reml">("reml");
  const [hk, setHk] = useState(false);
  const [subgroups, setSubgroups] = useState(false);
  useEffect(() => {
    const options = MEASURES[kind] ?? MEASURES.generic;
    if (!options.some(([m]) => m === measure)) setMeasure(options[0][0]);
  }, [kind, measure]);
  const result = useLoad(
    () => (chosen ? api.analyse({ outcome: chosen.outcome, timepoint: chosen.timepoint, options: { measure, method, hartungKnapp: hk, level: 0.95 }, subgroups }) : Promise.resolve(undefined)),
    [api, chosen?.outcome, chosen?.timepoint, measure, method, hk, subgroups, summary.events],
  );
  // std-C
  const rob = useRobAnalysis(stageProps, chosen, { measure, method, hartungKnapp: hk, level: 0.95 }, subgroups);
  const forest = useRef<SVGSVGElement>(null);
  if (!summary.included) return <EmptyState help="empty.review.analysis" icon="activity" learnMore="review.meta" />;
  if (outcomes.value && !outcomes.value.length)
    return <EmptyState help="empty.review.outcomes" icon="table" action={{ label: "Add an outcome data form in Setup", onClick: () => go("setup") }} learnMore="review.meta" />;
  const shown = rob.override ?? result.value; // std-C: with a risk-of-bias option on
  const a = shown?.analysis;
  const input = (shown?.input ?? []) as Input[];
  const base = `${(chosen?.outcome ?? "outcome").replace(/[^\w]+/g, "-").toLowerCase()}`;
  return (
    <div className="kx-rv-analysis">
      <div className="kx-rv-analysis-controls">
        <label className="kx-rv-field">
          <span>Outcome</span>
          <select className="kx-rv-select" value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
            {outcomes.value?.map((o, i) => (
              <option key={i} value={i}>
                {o.outcome}
                {o.timepoint ? ` · ${o.timepoint}` : ""} ({o.studies})
              </option>
            ))}
          </select>
        </label>
        <label className="kx-rv-field">
          <span>Effect measure</span>
          <select className="kx-rv-select" value={measure} onChange={(e) => setMeasure(e.target.value)}>
            {(MEASURES[kind] ?? MEASURES.generic).map(([m, l]) => (
              <option key={m} value={m}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <div className="kx-rv-field">
          <span>Model</span>
          <Segmented label="Model" value={method} options={[["fe", "Fixed effect"], ["dl", "Random (DL)"], ["reml", "Random (REML)"]]} onChange={setMethod} />
        </div>
        <label className="kx-rv-field kx-rv-field-toggle" title="Wider, more honest intervals when there are few studies">
          <span>Hartung–Knapp</span>
          <Toggle label="Hartung–Knapp" checked={hk && method !== "fe"} onChange={setHk} />
        </label>
        <label className="kx-rv-field kx-rv-field-toggle" title="Pool within the groups of a field used as Subgroup (e.g. study design)">
          <span>Subgroups</span>
          <Toggle label="Subgroups" checked={subgroups} onChange={setSubgroups} />
        </label>
        <RobControl rob={rob} />
        <Explain help="review.meta" />
        {a && <RateCertainty rob={rob} />}
      </div>
      {result.error && <p className="kx-inline-error">{result.error}</p>}
      {a && (
        <>
          <Headline a={a} />
          <RobFlags rob={rob} ratio={a.ratio} />
          {chosen && (
            <AdvancedSynthesis
              props={stageProps}
              base={{ outcome: chosen.outcome, timepoint: chosen.timepoint, options: { measure, method, hartungKnapp: hk, level: 0.95 }, subgroups }}
              pooled={
                <>
                  <section className="kx-rv-section">
                    <div className="kx-rv-section-head">
                      <h2>Forest plot</h2>
                      <MenuButton
                        label="Export forest plot"
                        icon="download"
                        items={[
                          { label: "SVG image", run: () => forest.current && saveFile(`${base}-forest.svg`, svgMarkup(forest.current)) },
                          { label: "PNG image", run: () => forest.current && void pngBlob(forest.current, 3).then((b) => saveFile(`${base}-forest.png`, b)).catch((e) => notify(errorText(e), "error")) },
                        ]}
                      />
                    </div>
                    <ForestFigure ref={forest} a={a} input={input} kind={kind} marks={rob.marks} />
                    {a.skipped.length > 0 && (
                      <p className="kx-rv-muted">
                        Left out: {a.skipped.map(([s, why]) => `${s} (${why.replace(`${s}: `, "")})`).join("; ")}
                      </p>
                    )}
                  </section>
                  {a.leaveOneOut.length > 0 && (
                    <section className="kx-rv-section">
                      <div className="kx-rv-section-head">
                        <h2>Leave one out</h2>
                      </div>
                      <table className="kx-rv-table">
                        <thead>
                          <tr>
                            <th>Without</th>
                            <th className="kx-rv-num">Estimate [95% CI]</th>
                            <th className="kx-rv-num">I²</th>
                          </tr>
                        </thead>
                        <tbody>
                          {a.leaveOneOut.map((l) => (
                            <tr key={l.id}>
                              <td>{l.label}</td>
                              <td className="kx-rv-num">{ci(a, l.estimate, l.lower, l.upper)}</td>
                              <td className="kx-rv-num">{l.i2.toFixed(0)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </section>
                  )}
                </>
              }
              funnelSection={
                a.egger ? (
                  <p className="kx-rv-more-egger">
                    Egger’s test: t = {a.egger.t.toFixed(2)}, df = {a.egger.df}, p = {p(a.egger.p)}. {a.studies.length < 10 ? "With fewer than 10 studies the test has little power." : a.egger.p < 0.1 ? "The funnel may be asymmetric." : "No clear asymmetry."}
                  </p>
                ) : (
                  <Hint help="review.egger.few" />
                )
              }
              plots={() => (forest.current ? { [`${base}-forest.svg`]: svgMarkup(forest.current) } : {})}
            />
          )}
        </>
      )}
    </div>
  );
}

// std-D: back-transformed for proportions and Fisher's z as well as ratios.
const tr = (a: Analysis, v: number) => {
  const t = (a as Analysis & { transform?: string; harmonicN?: number | null }).transform;
  return t ? backTransform(v, t, (a as Analysis & { harmonicN?: number | null }).harmonicN) : a.ratio ? Math.exp(v) : v;
};
const ci = (a: Analysis, e: number, l: number, u: number) => `${formatNumber(tr(a, e))} [${formatNumber(tr(a, l))}, ${formatNumber(tr(a, u))}]`;

function het(pooled: Pooled) {
  return `Heterogeneity: τ² = ${pooled.tau2.toPrecision(3)}, I² = ${pooled.i2.toFixed(0)}%, Q = ${pooled.q.toFixed(2)} (df = ${pooled.df}, p = ${p(pooled.qP)})`;
}

function Headline({ a }: { a: Analysis }) {
  const m = a.main;
  const model = m.method === "fe" ? "Fixed effect" : `Random effects (${m.method === "dl" ? "DerSimonian–Laird" : "REML"}${m.hartungKnapp ? ", Hartung–Knapp" : ""})`;
  return (
    <section className="kx-rv-headline">
      <div>
        <span className="kx-rv-muted">
          {a.measureLabel} · {model} · {m.k} studies
        </span>
        <strong>{ci(a, m.estimate, m.lower, m.upper)}</strong>
        <span className="kx-rv-muted">
          {m.hartungKnapp ? "t" : "z"} = {m.statistic.toFixed(2)}, p = {p(m.p)}
        </span>
      </div>
      <dl>
        <div>
          <dt>I²</dt>
          <dd>{m.i2.toFixed(0)}%</dd>
        </div>
        <div>
          <dt>τ²</dt>
          <dd>{m.tau2.toPrecision(3)}</dd>
        </div>
        <div>
          <dt>Q (p)</dt>
          <dd>
            {m.q.toFixed(1)} ({p(m.qP)})
          </dd>
        </div>
        {m.piLower != null && m.piUpper != null && (
          <div>
            <dt>Prediction interval</dt>
            <dd>
              {formatNumber(tr(a, m.piLower))} to {formatNumber(tr(a, m.piUpper))}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}


const ForestFigure = forwardRef<SVGSVGElement, { a: Analysis; input: Input[]; kind: string; marks?: ForestPlotProps["marks"] }>(function ForestFigure({ a, input, kind, marks }, ref) {
  const rows = useMemo(() => {
    const byId = new Map(input.map((s) => [s.id, s]));
    const columns = (id: string) => {
      const s = byId.get(id);
      if (!s) return [];
      const f = (v?: number | null) => (v == null ? "–" : String(Number(v.toPrecision(4))));
      if (kind === "dichotomous") return [`${f(s.e1)}/${f(s.n1)}`, `${f(s.e2)}/${f(s.n2)}`];
      if (kind === "continuous") return [`${f(s.m1)} (${f(s.sd1)}) ${f(s.n1)}`, `${f(s.m2)} (${f(s.sd2)}) ${f(s.n2)}`];
      return [];
    };
    const study = (s: Analysis["studies"][number]): ForestRow => ({ id: s.id, label: s.label, estimate: tr(a, s.yi), lower: tr(a, s.lower), upper: tr(a, s.upper), weight: s.weight, columns: columns(s.id) });
    const out: ForestRow[] = [];
    if (a.subgroups.length > 1) {
      for (const g of a.subgroups) {
        out.push({ id: `h-${g.name}`, label: g.name, kind: "heading" });
        for (const s of a.studies.filter((x) => g.studies.includes(x.id))) out.push(study(s));
        out.push({ id: `g-${g.name}`, label: "Subtotal", kind: "subtotal", estimate: tr(a, g.pooled.estimate), lower: tr(a, g.pooled.lower), upper: tr(a, g.pooled.upper), note: het(g.pooled) });
      }
    } else out.push(...a.studies.map(study));
    const m = a.main;
    out.push({ id: "total", label: m.method === "fe" ? "Total (fixed effect)" : "Total (random effects)", kind: "summary", estimate: tr(a, m.estimate), lower: tr(a, m.lower), upper: tr(a, m.upper), weight: 100, note: `${het(m)}${a.subgroupTest ? `; subgroup differences: Q = ${a.subgroupTest.q.toFixed(2)}, df = ${a.subgroupTest.df}, p = ${p(a.subgroupTest.p)}` : ""}` });
    if (m.piLower != null && m.piUpper != null) out.push({ id: "pi", label: "Prediction interval", kind: "prediction", lower: tr(a, m.piLower), upper: tr(a, m.piUpper) });
    return out;
  }, [a, input, kind]);
  const headers = kind === "dichotomous" ? ["Events/total (1)", "Events/total (2)"] : kind === "continuous" ? ["Mean (SD) n (1)", "Mean (SD) n (2)"] : [];
  return <ForestPlot ref={ref} rows={rows} columnHeaders={headers} log={a.ratio} axisLabel={a.measureLabel} favours={["Favours group 1", "Favours group 2"]} label={`Forest plot: ${a.measureLabel}`} marks={marks} width={marks ? 760 + marks.headers.length * 18 + 10 : 760} />;
});
