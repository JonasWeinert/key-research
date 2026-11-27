// The conversion helper on an outcome row ("I have a median and IQR…"): pick what the paper
// reports, type it in, and Key computes what the analysis needs (key-review's conversions.rs),
// fills the row and stores the method and its source with it (`_conversions`).
import { useEffect, useMemo, useState } from "react";
import { Explain } from "../explain";
import { GlobalDialog } from "../GlobalDrawer";
import { Icon } from "../icons";
import type { Invoke } from "../library-api";
import { Btn, Segmented, Toggle, errorText } from "./review-ui";
import { synthesisApi, type Conversion } from "./review-synthesis-api";
import "./review-synthesis.css";

const OPEN = "key:review-convert";
interface Detail {
  row: Record<string, unknown>;
  apply: (row: Record<string, unknown>) => void;
}

/** Opens the helper for one outcome row; `apply` receives the filled row. */
export const openConvert = (detail: Detail) => window.dispatchEvent(new CustomEvent<Detail>(OPEN, { detail }));

const LABEL: Record<string, string> = {
  median: "Median",
  q1: "First quartile (Q1)",
  q3: "Third quartile (Q3)",
  min: "Minimum",
  max: "Maximum",
  n: "Participants (n)",
  se: "Standard error",
  lower: "Lower limit",
  upper: "Upper limit",
  estimate: "Estimate",
  p: "p-value",
  t: "t statistic",
  r: "Correlation (r)",
  sdBaseline: "SD at baseline",
  sdFinal: "SD at follow-up",
  sdChange: "SD of the change",
  n1: "n (arm A)",
  m1: "Mean (arm A)",
  sd1: "SD (arm A)",
  n2: "n (arm B)",
  m2: "Mean (arm B)",
  sd2: "SD (arm B)",
  e1: "Events (arm A)",
  e2: "Events (arm B)",
  percent: "Percentage",
  comparisons: "Comparisons sharing it",
  events: "Events (optional)",
  clusterSize: "Average cluster size",
  icc: "Intracluster correlation (ICC)",
  df: "Degrees of freedom (optional)",
};
const OPTIONAL: Record<string, string[]> = { "combine-groups": ["e1", "e2"], "split-shared-group": ["events"], "cluster-adjust": ["events"], "se-from-p": ["df"] };
const GROUPED = ["mean-sd-from-median-iqr", "mean-sd-from-median-range", "mean-sd-from-five", "sd-from-se", "sd-from-ci", "sd-change", "combine-groups", "events-from-percent", "split-shared-group", "cluster-adjust"];
const RATIO = ["se-from-ci", "se-from-p", "se-from-t", "ci-from-se"];

export function ConvertHost({ invoke, workspaceId, reviewId }: { invoke: Invoke; workspaceId: string; reviewId: string }) {
  const [detail, setDetail] = useState<Detail>();
  useEffect(() => {
    const on = (e: Event) => setDetail((e as CustomEvent<Detail>).detail);
    window.addEventListener(OPEN, on);
    return () => window.removeEventListener(OPEN, on);
  }, []);
  const api = useMemo(() => synthesisApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  return detail ? <ConvertSheet api={api} detail={detail} onClose={() => setDetail(undefined)} /> : null;
}

function ConvertSheet({ api, detail, onClose }: { api: ReturnType<typeof synthesisApi>; detail: Detail; onClose: () => void }) {
  const [kinds, setKinds] = useState<{ kind: string; title: string; inputs: string[] }[]>([]);
  const [kind, setKind] = useState("mean-sd-from-median-iqr");
  const [group, setGroup] = useState<"1" | "2">("1");
  const measure = String(detail.row.measure ?? "").toUpperCase();
  const [ratio, setRatio] = useState(["RR", "OR", "HR", "IRR"].includes(measure));
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Conversion>();
  const [error, setError] = useState("");
  useEffect(() => void api.conversionKinds().then(setKinds).catch((e) => setError(errorText(e))), [api]);
  const spec = kinds.find((k) => k.kind === kind);
  const inputs = [...(spec?.inputs ?? []), ...(OPTIONAL[kind] ?? [])];
  const numbers = Object.fromEntries(Object.entries(values).filter(([k, v]) => inputs.includes(k) && v.trim() !== "" && Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)]));
  const ready = (spec?.inputs ?? []).every((k) => k in numbers);
  useEffect(() => {
    if (!ready) {
      setResult(undefined);
      setError("");
      return;
    }
    const t = setTimeout(
      () =>
        void api
          .convert({ kind, inputs: numbers, group, ratio })
          .then((r) => {
            setResult(r);
            setError("");
          })
          .catch((e) => {
            setResult(undefined);
            setError(errorText(e));
          }),
      150,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, kind, group, ratio, JSON.stringify(numbers), ready]);
  const apply = () => {
    if (!result) return;
    const previous = Array.isArray(detail.row._conversions) ? (detail.row._conversions as unknown[]) : [];
    detail.apply({ ...detail.row, ...result.fill, _conversions: [...previous, { kind: result.kind, method: result.method, formula: result.formula, citation: result.citation, inputs: result.inputs, fill: result.fill, warnings: result.warnings, at: Date.now() }] });
    onClose();
  };
  return (
    <GlobalDialog label="Convert reported statistics" onClose={onClose}>
      <form
        className="kx-rv-dialog kx-rv-convert"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <h2>
          Convert reported statistics <Explain help="review.convert" />
        </h2>
        <label className="kx-rv-field">
          <span>The paper reports</span>
          <select className="kx-rv-select kx-rv-convert-kinds" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Conversion">
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.title}
              </option>
            ))}
          </select>
        </label>
        <div className="kx-rv-more-controls">
          {GROUPED.includes(kind) && (
            <div className="kx-rv-field">
              <span>Fills the columns of</span>
              <Segmented label="Group" value={group} onChange={setGroup} options={[["1", String(detail.row.group1 || "Intervention")], ["2", String(detail.row.group2 || "Comparison")]]} />
            </div>
          )}
          {RATIO.includes(kind) && (
            <label className="kx-rv-field kx-rv-field-toggle">
              <span>A ratio (OR, RR, HR)</span>
              <Toggle label="A ratio" checked={ratio} onChange={setRatio} />
            </label>
          )}
        </div>
        <div className="kx-rv-convert-inputs">
          {inputs.map((k) => (
            <label key={k} className="kx-rv-field">
              <span>{LABEL[k] ?? k}</span>
              <input className="kx-rv-input" inputMode="decimal" aria-label={LABEL[k] ?? k} value={values[k] ?? ""} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
            </label>
          ))}
        </div>
        {result && (
          <div className="kx-rv-convert-result" aria-live="polite">
            <dl>
              {Object.entries(result.outputs).map(([k, v]) => (
                <div key={k}>
                  <dt>{k === "sd" ? "SD" : k === "se" ? "SE" : k === "designEffect" ? "Design effect" : k === "r" ? "Correlation" : k[0].toUpperCase() + k.slice(1)}</dt>
                  <dd>{Number(v.toPrecision(6))}</dd>
                </div>
              ))}
            </dl>
            <p>{result.formula}</p>
            <p>
              <Icon name="book" size={10} /> {result.citation}
            </p>
            {result.warnings.map((w) => (
              <p key={w} className="kx-rv-more-warn">
                {w}
              </p>
            ))}
          </div>
        )}
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary disabled={!result}>
            Fill the row
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

/** "converted" under a value filled by the helper, naming the method and its source. */
export function ConvertedMark({ row, column }: { row: Record<string, unknown>; column: string }) {
  const list = Array.isArray(row._conversions) ? (row._conversions as { method?: string; citation?: string; fill?: Record<string, number> }[]) : [];
  const c = [...list].reverse().find((x) => x.fill && column in x.fill && x.fill[column] === row[column]);
  if (!c) return null;
  return (
    <span className="kx-rv-converted" title={`${c.method}. ${c.citation}`}>
      <Icon name="function" size={9} />
      converted
    </span>
  );
}
