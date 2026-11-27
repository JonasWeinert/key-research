// More analyses under the main meta-analysis: several estimates per study, meta-regression,
// small-study effects and publication bias, and sensitivity tools, each a clearly explained
// choice; then saving the analysis and the exports others can import. Every number comes from
// key-review (synthesis.rs and friends); this file lays them out.
import { useMemo, useRef, useState } from "react";
import { Explain, Hint } from "../explain";
import { ContourFunnel, ForestPlot, ScatterPlot, type ForestRow } from "../charts/charts";
import { saveFile, svgMarkup } from "../charts/export";
import { formatNumber } from "../charts/scale";
import { downloadText } from "../db-ui";
import { GlobalDialog } from "../GlobalDrawer";
import { Btn, MenuButton, Segmented, Toggle, errorText, useLoad } from "./review-ui";
import { backTransform, saveBase64, synthesisApi, type AnalysisSpec, type BaseRequest, type Coef, type ModeratorRef, type PooledLite, type RevmanProblem, type SynthesisOptions, type SynthesisResult } from "./review-synthesis-api";
import type { StageProps } from "./ReviewPage";
import "./review-synthesis.css";

type Tab = "dependence" | "metareg" | "bias" | "sensitivity";
const p3 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "–" : v < 0.001 ? "< 0.001" : v.toFixed(3));
const n = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "–" : formatNumber(v, d));
const key = (m: ModeratorRef) => `${m.source}:${m.form}:${m.field}`;

export function AdvancedSynthesis({ props, base, plots }: { props: StageProps; base: BaseRequest; plots: () => Record<string, string> }) {
  const { invoke, workspaceId, reviewId, viewer, notify, summary } = props;
  const api = useMemo(() => synthesisApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const [tab, setTab] = useState<Tab>("bias");
  const moderators = useLoad(() => api.moderators(), [api, summary.events]);
  const [chosen, setChosen] = useState<ModeratorRef[]>([]);
  const [regMethod, setRegMethod] = useState<"reml" | "fe">("reml");
  const [kh, setKh] = useState(true);
  const [perm, setPerm] = useState(false);
  const [depModel, setDepModel] = useState<"che" | "three-level" | "aggregate" | "off">("che");
  const [rho, setRho] = useState(0.6);
  const [petAlpha, setPetAlpha] = useState<"two" | "one">("two");
  const [tfEst, setTfEst] = useState<"L0" | "R0">("L0");
  const [cumOrder, setCumOrder] = useState<"year" | "precision" | "listed">("year");
  const options: SynthesisOptions = {
    moderators: chosen,
    metareg: chosen.length ? { method: regMethod, knappHartung: kh, permutations: perm ? 1000 : 0 } : null,
    dependence: depModel === "off" ? null : { model: depModel, rho, robust: true },
    bias: { petPeese: true, oneSided: petAlpha === "one", trimFill: tfEst, selection: true, uwls: true },
    sensitivity: { influence: true, cumulative: cumOrder, models: true },
  };
  // A first pass tells whether studies give several estimates; the dependence model applies
  // only then.
  const probe = useLoad(() => api.synthesis({ ...base, moderators: [], metareg: null, dependence: null, bias: null, sensitivity: null }), [api, JSON.stringify(base), summary.events]);
  const multiple = probe.value?.multipleEstimates ?? false;
  const request = { ...base, ...options, dependence: multiple ? options.dependence : null };
  const result = useLoad(() => (probe.value ? api.synthesis(request) : Promise.resolve(undefined)), [api, JSON.stringify(request), !!probe.value, summary.events]);
  const r = result.value;
  const spec = (): AnalysisSpec => ({ id: `${base.outcome}|${base.timepoint ?? ""}|${base.options.measure}`, name: "", request: base, advanced: { ...options, dependence: multiple ? options.dependence : null } });
  const [bundleOpen, setBundleOpen] = useState(false);
  const [revman, setRevman] = useState<RevmanProblem[]>();
  const bubble = useRef<SVGSVGElement>(null);
  const funnel = useRef<SVGSVGElement>(null);
  const baujat = useRef<SVGSVGElement>(null);
  const cumulative = useRef<SVGSVGElement>(null);
  const slug = base.outcome.replace(/[^\w]+/g, "-").toLowerCase();
  const myPlots = () => {
    const out: Record<string, string> = { ...plots() };
    for (const [name, ref] of [["bubble", bubble], ["contour-funnel", funnel], ["baujat", baujat], ["cumulative", cumulative]] as const) if (ref.current) out[`${slug}-${name}.svg`] = svgMarkup(ref.current);
    return out;
  };
  const tabs: [Tab, string][] = [
    ["bias", "Small-study effects"],
    ["metareg", "Meta-regression"],
    ["dependence", multiple && r ? `Several estimates (${r.k} in ${r.studies})` : "Several estimates"],
    ["sensitivity", "Sensitivity"],
  ];
  const tr = (v: number) => (r ? backTransform(v, r.transform) : v);
  const ci = (e: number, l: number, u: number) => `${n(tr(e))} [${n(tr(l))}, ${n(tr(u))}]`;
  const logNote = r && r.transform !== "none" ? (r.transform === "exp" ? " (log scale)" : " (analysis scale)") : "";
  return (
    <section className="kx-rv-section kx-rv-more" aria-label="More analyses">
      <div className="kx-rv-section-head">
        <h2>More analyses</h2>
        <Segmented label="Analysis" value={tab} options={tabs} onChange={setTab} />
        <div className="kx-rv-more-actions">
          <Btn
            small
            icon="check"
            onClick={() =>
              void api
                .saveAnalysis(spec(), viewer)
                .then(() => notify("Analysis saved: it goes into the R script, the bundle and the PRISMA report", "ok"))
                .catch((e) => notify(errorText(e), "error"))
            }
          >
            Save analysis
          </Btn>
          <MenuButton
            label="Export for others"
            icon="download"
            width={300}
            items={[
              { label: "R script reproducing this analysis (.zip)", icon: "function", run: () => void api.exportR(spec()).then(saveBase64).catch((e) => notify(errorText(e), "error")) },
              {
                label: "RevMan Web import files (.zip)",
                icon: "table",
                run: () =>
                  void api
                    .revman()
                    .then((f) => {
                      saveBase64(f);
                      setRevman(f.problems);
                    })
                    .catch((e) => notify(errorText(e), "error")),
              },
              { label: "Replication bundle for OSF or a journal…", icon: "folder", run: () => setBundleOpen(true) },
              null,
              { label: "Included studies (RIS)", run: () => void api.studies("ris", "included").then((f) => downloadText(f.filename, f.content, f.mime)) },
              { label: "Included studies (BibTeX)", run: () => void api.studies("bib", "included").then((f) => downloadText(f.filename, f.content, f.mime)) },
              { label: "Excluded studies with reasons (RIS)", run: () => void api.studies("ris", "excluded").then((f) => downloadText(f.filename, f.content, f.mime)) },
              { label: "All records with decisions (CSV)", run: () => void api.studies("csv", "all").then((f) => downloadText(f.filename, f.content, f.mime)) },
            ]}
          >
            Export
          </MenuButton>
          <Explain help="review.exports" />
        </div>
      </div>
      {r?.dependenceWarning && tab !== "dependence" && (
        <p className="kx-rv-more-warn">
          {r.dependenceWarning}{" "}
          <button type="button" className="kx-rv-more-link" onClick={() => setTab("dependence")}>
            Choose a model
          </button>
        </p>
      )}
      {result.error && <p className="kx-inline-error">{result.error}</p>}
      {tab === "dependence" && (
        <div className="kx-rv-more-body">
          <div className="kx-rv-more-controls">
            <div className="kx-rv-field">
              <span>Model</span>
              <Segmented
                label="Model for several estimates"
                value={depModel}
                onChange={setDepModel}
                options={[
                  ["che", "Robust (recommended)"],
                  ["three-level", "Three-level"],
                  ["aggregate", "One per study"],
                  ["off", "Ignore"],
                ]}
              />
            </div>
            {depModel !== "three-level" && depModel !== "off" && (
              <label className="kx-rv-field">
                <span>Assumed correlation within a study</span>
                <input className="kx-rv-input kx-rv-more-num" type="number" min={0} max={0.99} step={0.1} value={rho} onChange={(e) => setRho(Math.min(0.99, Math.max(0, Number(e.target.value))))} />
              </label>
            )}
            <Explain help="review.dependence" />
          </div>
          {!multiple ? (
            <p className="kx-rv-muted">Every study gives one estimate for this outcome, so the usual analysis above already applies. These models matter when a study reports several (outcome measures, time points, comparisons).</p>
          ) : (
            r?.dependence && <Dependence d={r.dependence} tr={tr} ci={ci} logNote={logNote} />
          )}
        </div>
      )}
      {tab === "metareg" && (
        <div className="kx-rv-more-body">
          <div className="kx-rv-more-controls">
            <div className="kx-rv-field">
              <span>Model</span>
              <Segmented label="Meta-regression model" value={regMethod} onChange={setRegMethod} options={[["reml", "Mixed effects (REML)"], ["fe", "Fixed effect"]]} />
            </div>
            <label className="kx-rv-field kx-rv-field-toggle" title="t and F tests with an adjusted standard error: safer with few studies">
              <span>Knapp–Hartung</span>
              <Toggle label="Knapp–Hartung" checked={kh && regMethod === "reml"} onChange={setKh} />
            </label>
            <label className="kx-rv-field kx-rv-field-toggle" title="p-values from reshuffling the moderator across studies, without assuming normality">
              <span>Permutation test</span>
              <Toggle label="Permutation test" checked={perm} onChange={setPerm} />
            </label>
            <Explain help="review.metareg" />
          </div>
          <Hint help="review.metareg.pick" />
          <div className="kx-rv-more-mods" role="group" aria-label="Moderators">
            {moderators.value?.map((m) => {
              const on = chosen.some((c) => key(c) === key(m));
              return (
                <label key={key(m)} className="kx-rv-more-mod" data-on={on || undefined}>
                  <input type="checkbox" checked={on} onChange={(e) => setChosen(e.target.checked ? [...chosen, { source: m.source, form: m.form, field: m.field, kind: m.kind, name: m.name }] : chosen.filter((c) => key(c) !== key(m)))} />
                  <span>{m.label}</span>
                  <small>
                    {m.kind === "continuous" ? "number" : "categories"} · {m.studies} {m.studies === 1 ? "study" : "studies"}
                  </small>
                </label>
              );
            })}
            {moderators.value && !moderators.value.length && <p className="kx-rv-muted">No study characteristics yet: add number or choice fields to an extraction form (for example dose or study design) and fill them in.</p>}
          </div>
          {r?.metaRegression?.error && <p className="kx-inline-error">{r.metaRegression.error}</p>}
          {r?.metaRegression?.note && <p className="kx-rv-muted">{r.metaRegression.note}</p>}
          {r?.metaRegression?.coefficients && (
            <>
              <p className="kx-rv-more-model">
                {r.metaRegression.method} · {r.metaRegression.test} · {r.metaRegression.k} studies
              </p>
              <CoefTable coefs={r.metaRegression.coefficients} perm={r.metaRegression.permutation?.p} logNote={logNote} />
              <dl className="kx-rv-more-stats">
                <Stat label="R² (between-study variance explained)" value={r.metaRegression.r2 == null ? "–" : `${r.metaRegression.r2.toFixed(0)}%`} />
                <Stat label="Residual τ²" value={r.metaRegression.tau2.toPrecision(3)} />
                <Stat label="Residual I²" value={`${r.metaRegression.i2.toFixed(0)}%`} />
                <Stat label={`QE (df = ${r.metaRegression.qeDf})`} value={`${r.metaRegression.qe.toFixed(2)}, p ${p3(r.metaRegression.qeP)}`} />
                <Stat label={r.metaRegression.qmDf[1] != null ? `F(${r.metaRegression.qmDf[0]}, ${r.metaRegression.qmDf[1]})` : `QM (df = ${r.metaRegression.qmDf[0]})`} value={`${r.metaRegression.qm.toFixed(2)}, p ${p3(r.metaRegression.qmP)}`} />
                {r.metaRegression.permutation && <Stat label={`Permutation p (${r.metaRegression.permutation.exact ? "exact" : `${r.metaRegression.permutation.iterations} shuffles`})`} value={p3(r.metaRegression.permutation.qmP)} />}
              </dl>
              {r.metaRegression.warnings.map((w) => (
                <p key={w} className="kx-rv-more-warn">
                  {w}
                </p>
              ))}
              {r.metaRegression.bubble && (
                <Figure title="Bubble plot" name={`${slug}-bubble.svg`} svg={bubble}>
                  <ScatterPlot
                    ref={bubble}
                    label={`Bubble plot: ${r.metaRegression.bubble.moderator}`}
                    points={r.metaRegression.bubble.points.map((p) => ({ x: p.x, y: p.yi, size: p.weight, label: p.label }))}
                    line={r.metaRegression.bubble.line}
                    xLabel={r.metaRegression.bubble.moderator}
                    yLabel={`${r.measureLabel}${logNote}`}
                  />
                </Figure>
              )}
            </>
          )}
        </div>
      )}
      {tab === "bias" && r?.bias && (
        <div className="kx-rv-more-body">
          <div className="kx-rv-more-controls">
            <div className="kx-rv-field">
              <span>PET-PEESE rule</span>
              <Segmented label="PET-PEESE test" value={petAlpha} onChange={setPetAlpha} options={[["two", "Two-sided 5%"], ["one", "One-sided 5%"]]} />
            </div>
            <div className="kx-rv-field">
              <span>Trim and fill estimator</span>
              <Segmented label="Trim and fill estimator" value={tfEst} onChange={setTfEst} options={[["L0", "L0"], ["R0", "R0"]]} />
            </div>
            <Explain help="review.bias" />
          </div>
          {r.bias.caution && <p className="kx-rv-more-warn">{r.bias.caution}</p>}
          <table className="kx-rv-table kx-rv-more-table">
            <thead>
              <tr>
                <th>Method</th>
                <th className="kx-rv-num">Corrected estimate [95% CI]</th>
                <th className="kx-rv-num">p</th>
                <th>What it says</th>
              </tr>
            </thead>
            <tbody>
              {r.bias.petPeese &&
                (r.bias.petPeese.error ? (
                  <ErrorRow name="PET-PEESE" error={r.bias.petPeese.error} />
                ) : (
                  <>
                    <tr>
                      <td>
                        FAT-PET
                        <small>{r.bias.petPeese.pet.seType === "CR2" ? "robust (CR2) standard errors" : "weighted least squares"}</small>
                      </td>
                      <td className="kx-rv-num">{ci(r.bias.petPeese.pet.intercept.estimate, r.bias.petPeese.pet.intercept.lower, r.bias.petPeese.pet.intercept.upper)}</td>
                      <td className="kx-rv-num">{p3(r.bias.petPeese.pet.intercept.p)}</td>
                      <td>Funnel asymmetry (FAT): slope {n(r.bias.petPeese.pet.slope.estimate)}, p {p3(r.bias.petPeese.pet.slope.p)}</td>
                    </tr>
                    <tr>
                      <td>PEESE</td>
                      <td className="kx-rv-num">{ci(r.bias.petPeese.peese.intercept.estimate, r.bias.petPeese.peese.intercept.lower, r.bias.petPeese.peese.intercept.upper)}</td>
                      <td className="kx-rv-num">{p3(r.bias.petPeese.peese.intercept.p)}</td>
                      <td>Quadratic in the standard error: less biased when there is a real effect.</td>
                    </tr>
                    <tr data-chosen>
                      <td>
                        <strong>PET-PEESE</strong>
                        <small>uses {r.bias.petPeese.chosen}</small>
                      </td>
                      <td className="kx-rv-num">
                        <strong>{ci(r.bias.petPeese.estimate.estimate, r.bias.petPeese.estimate.lower, r.bias.petPeese.estimate.upper)}</strong>
                      </td>
                      <td className="kx-rv-num">{p3(r.bias.petPeese.estimate.p)}</td>
                      <td>{r.bias.petPeese.rule}</td>
                    </tr>
                  </>
                ))}
              {r.bias.uwls && (
                <>
                  <tr>
                    <td>UWLS</td>
                    <td className="kx-rv-num">{ci(r.bias.uwls.uwls.estimate, r.bias.uwls.uwls.lower, r.bias.uwls.uwls.upper)}</td>
                    <td className="kx-rv-num">{p3(r.bias.uwls.uwls.p)}</td>
                    <td>Unrestricted weighted least squares: the fixed-effect point estimate with a regression standard error.</td>
                  </tr>
                  <tr>
                    <td>WAAP</td>
                    <td className="kx-rv-num">{r.bias.uwls.waap ? ci(r.bias.uwls.waap.estimate, r.bias.uwls.waap.lower, r.bias.uwls.waap.upper) : "–"}</td>
                    <td className="kx-rv-num">{p3(r.bias.uwls.waap?.p)}</td>
                    <td>{r.bias.uwls.note}</td>
                  </tr>
                </>
              )}
              {r.bias.trimFill &&
                (r.bias.trimFill.error ? (
                  <ErrorRow name="Trim and fill" error={r.bias.trimFill.error} />
                ) : (
                  <tr>
                    <td>
                      Trim and fill<small>{r.bias.trimFill.estimator}</small>
                    </td>
                    <td className="kx-rv-num">{ci(r.bias.trimFill.pooled.estimate, r.bias.trimFill.pooled.lower, r.bias.trimFill.pooled.upper)}</td>
                    <td className="kx-rv-num">{p3(r.bias.trimFill.pooled.p)}</td>
                    <td>{r.bias.trimFill.k0 === 0 ? "No studies imputed." : `${r.bias.trimFill.k0} ${r.bias.trimFill.k0 === 1 ? "study" : "studies"} imputed on the ${r.bias.trimFill.side} (hollow in the plot).`}</td>
                  </tr>
                ))}
              {r.bias.selection &&
                (r.bias.selection.error ? (
                  <ErrorRow name="Selection model" error={r.bias.selection.error} />
                ) : (
                  <tr>
                    <td>
                      Selection model<small>3-parameter, step at p = .025</small>
                    </td>
                    <td className="kx-rv-num">{ci(r.bias.selection.estimate, r.bias.selection.lower, r.bias.selection.upper)}</td>
                    <td className="kx-rv-num">{p3(r.bias.selection.p)}</td>
                    <td>
                      Non-significant results {r.bias.selection.delta < 1 ? `about ${Math.round(r.bias.selection.delta * 100)}% as likely` : "as likely or more"} to be published; test of selection p {p3(r.bias.selection.lrtP)}.
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="kx-rv-more-model">Estimates are shown on the outcome's scale; tests are on the analysis scale.</p>
          {r.points.length > 2 && (
            <Figure title="Contour-enhanced funnel plot" name={`${slug}-contour-funnel.svg`} svg={funnel}>
              <ContourFunnel
                ref={funnel}
                points={r.points.map((p) => ({ estimate: p.yi, se: Math.sqrt(p.vi), label: p.label }))}
                filled={r.bias.trimFill && !r.bias.trimFill.error ? r.bias.trimFill.filled.map(([y, v]) => ({ estimate: y, se: Math.sqrt(v) })) : []}
                adjusted={r.bias.petPeese && !r.bias.petPeese.error ? r.bias.petPeese.estimate.estimate : undefined}
                axisLabel={`${r.measureLabel}${logNote}`}
                tickFormat={r.transform === "exp" ? (v) => formatNumber(Math.exp(v), 2) : undefined}
              />
              <p className="kx-rv-more-caption">Shaded: where a study would be significant at the level shown. Dashed line: the PET-PEESE estimate.</p>
            </Figure>
          )}
        </div>
      )}
      {tab === "sensitivity" && r?.sensitivity && (
        <div className="kx-rv-more-body">
          <div className="kx-rv-more-controls">
            <div className="kx-rv-field">
              <span>Cumulative order</span>
              <Segmented label="Cumulative order" value={cumOrder} onChange={setCumOrder} options={[["year", "By year"], ["precision", "Most precise first"], ["listed", "As listed"]]} />
            </div>
            <Explain help="review.sensitivity" />
          </div>
          {r.sensitivity.note && <p className="kx-rv-more-warn">{r.sensitivity.note}</p>}
          {r.sensitivity.models && (
            <table className="kx-rv-table kx-rv-more-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="kx-rv-num">Estimate [95% CI]</th>
                  <th className="kx-rv-num">τ²</th>
                  <th className="kx-rv-num">I²</th>
                </tr>
              </thead>
              <tbody>
                {r.sensitivity.models.map((m) => (
                  <tr key={m.model}>
                    <td>{m.model}</td>
                    <td className="kx-rv-num">{ci(m.pooled.estimate, m.pooled.lower, m.pooled.upper)}</td>
                    <td className="kx-rv-num">{m.pooled.tau2.toPrecision(3)}</td>
                    <td className="kx-rv-num">{m.pooled.i2.toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {Array.isArray(r.sensitivity.influence) && (
            <div className="kx-rv-analysis-grid kx-rv-more-grid">
              <div>
                <h3 className="kx-rv-more-h3">Influence</h3>
                <table className="kx-rv-table kx-rv-more-table">
                  <thead>
                    <tr>
                      <th>Study</th>
                      <th className="kx-rv-num" title="Externally studentised residual: above about 2 fits poorly">Residual</th>
                      <th className="kx-rv-num" title="Cook's distance: how far the pooled result moves without it">Cook's D</th>
                      <th className="kx-rv-num" title="DFBETAS: the change in the estimate, in standard errors">DFBETAS</th>
                      <th className="kx-rv-num">τ² without</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.sensitivity.influence.map((s) => (
                      <tr key={s.id} data-flag={s.influential || undefined}>
                        <td>
                          {s.label}
                          {s.influential && <small>Influential</small>}
                        </td>
                        <td className="kx-rv-num">{n(s.rstudent)}</td>
                        <td className="kx-rv-num">{n(s.cookD, 3)}</td>
                        <td className="kx-rv-num">{n(s.dfbetas)}</td>
                        <td className="kx-rv-num">{s.tau2Del.toPrecision(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Figure title="Baujat plot" name={`${slug}-baujat.svg`} svg={baujat}>
                <ScatterPlot ref={baujat} label="Baujat plot" points={r.sensitivity.influence.map((s) => ({ x: s.baujatX, y: s.baujatY, label: s.label, tone: s.influential ? "red" : "accent" }))} labelOutliers xLabel="Contribution to heterogeneity" yLabel="Influence on the result" />
              </Figure>
            </div>
          )}
          {r.sensitivity.cumulative && r.sensitivity.cumulative.length > 1 && (
            <Figure title="Cumulative meta-analysis" name={`${slug}-cumulative.svg`} svg={cumulative}>
              <ForestPlot
                ref={cumulative}
                rows={r.sensitivity.cumulative.map((c): ForestRow => ({ id: c.id, label: `+ ${c.label}`, estimate: tr(c.pooled.estimate), lower: tr(c.pooled.lower), upper: tr(c.pooled.upper), kind: "subtotal" }))}
                log={r.transform === "exp"}
                axisLabel={r.measureLabel}
                label="Cumulative meta-analysis"
              />
            </Figure>
          )}
        </div>
      )}
      {(result.loading || probe.loading) && !r && <p className="kx-rv-muted">Calculating…</p>}
      {bundleOpen && <BundleSheet onClose={() => setBundleOpen(false)} run={(anon) => api.bundle(viewer, myPlots(), spec(), anon).then(saveBase64)} />}
      {revman && <RevmanSheet problems={revman} onClose={() => setRevman(undefined)} />}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ErrorRow({ name, error }: { name: string; error: string }) {
  return (
    <tr>
      <td>{name}</td>
      <td colSpan={3} className="kx-rv-muted">
        {error}
      </td>
    </tr>
  );
}

function CoefTable({ coefs, perm, logNote, robust }: { coefs: Coef[]; perm?: number[]; logNote: string; robust?: boolean }) {
  return (
    <table className="kx-rv-table kx-rv-more-table">
      <thead>
        <tr>
          <th>Term</th>
          <th className="kx-rv-num">Coefficient{logNote}</th>
          <th className="kx-rv-num">95% CI</th>
          <th className="kx-rv-num">{robust ? "df" : "SE"}</th>
          <th className="kx-rv-num">p</th>
          {perm && <th className="kx-rv-num">Permutation p</th>}
        </tr>
      </thead>
      <tbody>
        {coefs.map((c, i) => (
          <tr key={c.name}>
            <td>{c.name}</td>
            <td className="kx-rv-num">{n(c.estimate, 3)}</td>
            <td className="kx-rv-num">
              [{n(c.lower, 3)}, {n(c.upper, 3)}]
            </td>
            <td className="kx-rv-num">{robust ? n(c.df, 1) : n(c.se, 3)}</td>
            <td className="kx-rv-num">{p3(c.p)}</td>
            {perm && <td className="kx-rv-num">{p3(perm[i])}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Dependence({ d, ci, logNote }: { d: NonNullable<SynthesisResult["dependence"]>; tr: (v: number) => number; ci: (e: number, l: number, u: number) => string; logNote: string }) {
  if (d.error) return <p className="kx-inline-error">{d.error}</p>;
  const main = d.robust ?? d.coefficients;
  const intercept = main[0];
  const pooled: PooledLite | null = d.pooled;
  return (
    <div className="kx-rv-more-dep">
      <p className="kx-rv-more-model">
        {d.modelLabel} · {d.k} estimates in {d.studies} studies{d.rho != null ? ` · assumed correlation ${d.rho}` : ""}
      </p>
      {main.length === 1 && (
        <div className="kx-rv-headline kx-rv-more-headline">
          <div>
            <span className="kx-rv-muted">Pooled effect{d.robust ? " (robust CR2, Satterthwaite df)" : ""}</span>
            <strong>{ci(intercept.estimate, intercept.lower, intercept.upper)}</strong>
            <span className="kx-rv-muted">
              {intercept.df != null ? `t(${intercept.df.toFixed(1)})` : "z"} = {intercept.statistic.toFixed(2)}, p = {p3(intercept.p)}
            </span>
          </div>
          <dl>
            {d.sigma2 && (
              <>
                <div>
                  <dt>Between studies (σ²)</dt>
                  <dd>{d.sigma2[0].toPrecision(3)}</dd>
                </div>
                <div>
                  <dt>Within studies (σ²)</dt>
                  <dd>{d.sigma2[1].toPrecision(3)}</dd>
                </div>
              </>
            )}
            {pooled && (
              <div>
                <dt>τ² / I²</dt>
                <dd>
                  {pooled.tau2.toPrecision(3)} / {pooled.i2.toFixed(0)}%
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}
      {main.length > 1 && <CoefTable coefs={main} logNote={logNote} robust={!!d.robust} />}
      {d.warnings.map((w) => (
        <p key={w} className="kx-rv-more-warn">
          {w}
        </p>
      ))}
    </div>
  );
}

function Figure({ title, name, svg, children }: { title: string; name: string; svg: React.RefObject<SVGSVGElement | null>; children: React.ReactNode }) {
  return (
    <figure className="kx-rv-more-figure">
      <figcaption>
        <h3 className="kx-rv-more-h3">{title}</h3>
        <MenuButton label={`Export ${title.toLowerCase()}`} icon="download" items={[{ label: "SVG image", run: () => svg.current && saveFile(name, svgMarkup(svg.current)) }]} />
      </figcaption>
      {children}
    </figure>
  );
}

function BundleSheet({ onClose, run }: { onClose: () => void; run: (anonymise: boolean) => Promise<unknown> }) {
  const [anon, setAnon] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <GlobalDialog label="Replication bundle" onClose={onClose} busy={busy}>
      <form
        className="kx-rv-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          run(anon)
            .then(onClose)
            .catch((err) => setError(errorText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>Replication bundle</h2>
        <p>One zip with what a journal or OSF asks for: the protocol and search report (when written), PRISMA numbers, screening decisions with reasons, extraction data in wide and long form with the data dictionary and sources, risk of bias and certainty (when assessed), each saved analysis with its data, R script and plots, the audit trail, a README describing every file and a manifest of SHA-256 checksums.</p>
        <p className="kx-rv-muted">Nothing is uploaded: deposit the file yourself.</p>
        <label className="kx-rv-more-check">
          <Toggle label="Anonymise reviewers" checked={anon} onChange={setAnon} />
          <span>Replace reviewer names with Reviewer 1, 2 … (leaves out the review's own event log, which names people)</span>
        </label>
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary disabled={busy}>
            {busy ? "Building…" : "Export bundle"}
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

function RevmanSheet({ problems, onClose }: { problems: RevmanProblem[]; onClose: () => void }) {
  const errors = problems.filter((p) => p.severity === "error").length;
  return (
    <GlobalDialog label="RevMan Web files" onClose={onClose}>
      <div className="kx-rv-dialog">
        <h2>RevMan Web files</h2>
        <p>Import references.ris first (Studies › Import study references), then the three CSVs (Import study data › Import from CSV) with study-centric data management on. Names must match your RevMan review exactly.</p>
        {problems.length === 0 ? (
          <p className="kx-rv-more-ok">The files pass every check from RevMan's documented import rules.</p>
        ) : (
          <>
            <p className={errors ? "kx-inline-error" : "kx-rv-more-warn"}>{errors ? `${errors} row(s) RevMan would reject:` : "Things to check before importing:"}</p>
            <ul className="kx-rv-more-problems">
              {problems.map((p, i) => (
                <li key={i} data-severity={p.severity}>
                  <strong>{p.file || "All files"}</strong>
                  {p.row ? ` row ${p.row}` : ""}
                  {p.study ? ` (${p.study})` : ""}: {p.message}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="kx-rv-muted">The layout follows RevMan's published import documentation; Cochrane's Excel templates were not available to compare column by column.</p>
        <div className="kx-rv-dialog-actions">
          <button type="button" className="kx-rv-btn" data-primary onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </GlobalDialog>
  );
}
