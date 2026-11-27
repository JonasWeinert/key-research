// Risk of bias in the Analysis stage: each study's judgements beside the forest plot, a flag for
// studies without an assessment, and the analysis again without the studies at high risk or
// with the studies grouped by their overall risk (key_review::certainty::rob_analyse).
import { useMemo, useState } from "react";
import { Hint } from "../explain";
import type { Mark } from "../charts/charts";
import { formatNumber } from "../charts/scale";
import { certaintyApi, handCertainty, resultKey, type AnalysisOptions, type RobAnalysis } from "./review-certainty-api";
import { Btn, Segmented, useLoad } from "./review-ui";
import type { StageProps } from "./ReviewPage";

export type RobMode = "all" | "excludeHigh" | "subgroup";

export function useRobAnalysis(props: StageProps, chosen: { outcome: string; timepoint: string } | undefined, options: AnalysisOptions, subgroups: boolean) {
  const { invoke, workspaceId, reviewId, summary } = props;
  const api = useMemo(() => certaintyApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const [mode, setMode] = useState<RobMode>("all");
  const rob = useLoad(
    () => (chosen ? api.analyse(chosen.outcome, chosen.timepoint, options, subgroups, mode === "all" ? "" : mode) : Promise.resolve(undefined)),
    [api, chosen?.outcome, chosen?.timepoint, options.measure, options.method, options.hartungKnapp, subgroups, mode, summary.events],
  );
  const value: RobAnalysis | undefined = rob.value;
  const marks = useMemo(() => {
    const r = value?.rob;
    if (!r || !Object.keys(r.studies).length) return undefined;
    const columns = [...r.columns, { id: "overall", short: "O", name: "Overall" }];
    const of = (id: string): (Mark | null)[] =>
      columns.map((c) => {
        const l = r.studies[id]?.cells[c.id];
        return l ? { tone: l.tone, symbol: l.symbol, title: `${c.name}: ${l.label}` } : null;
      });
    return { headers: columns.map((c) => c.short), titles: columns.map((c) => c.name), of };
  }, [value]);
  const rate = () => {
    if (!chosen) return;
    handCertainty(reviewId, { key: resultKey(chosen.outcome, chosen.timepoint), options });
    props.go("certainty");
  };
  /** The analysis to show: with a risk-of-bias option on, the one from Rust's RoB analysis. */
  const override = mode !== "all" ? value : undefined;
  return { mode, setMode, value, override, marks, error: rob.error, rate };
}

export function RobControl({ rob }: { rob: ReturnType<typeof useRobAnalysis> }) {
  return (
    <div className="kx-rv-field" title="Use the Risk of bias stage's judgements">
      <span>Risk of bias</span>
      <Segmented
        label="Risk of bias"
        value={rob.mode}
        options={[
          ["all", "All studies"],
          ["excludeHigh", "Without high risk"],
          ["subgroup", "By risk of bias"],
        ]}
        onChange={rob.setMode}
      />
    </div>
  );
}

export function RobFlags({ rob, ratio }: { rob: ReturnType<typeof useRobAnalysis>; ratio: boolean }) {
  const r = rob.value?.rob;
  if (!r) return null;
  const tr = (v: number) => (ratio ? Math.exp(v) : v);
  return (
    <div className="kx-rob-flags">
      {r.missing.length > 0 && (
        <p className="kx-rob-banner" role="status">
          <span>
            No risk-of-bias assessment yet for {r.missing.length === 1 ? "1 study" : `${r.missing.length} studies`} in this analysis: {r.missing.slice(0, 5).join(", ")}
            {r.missing.length > 5 ? "…" : ""}.
          </span>
        </p>
      )}
      {rob.mode === "excludeHigh" && (
        <p className="kx-rv-muted">
          {r.excluded.length ? `Left out at high risk of bias: ${r.excluded.join(", ")}. ` : "No study is at high risk of bias for this result. "}
          All studies: {formatNumber(tr(r.all.estimate))} [{formatNumber(tr(r.all.lower))}, {formatNumber(tr(r.all.upper))}].
        </p>
      )}
      {rob.mode !== "all" && <Hint help="review.rob.analysis" />}
      {rob.error && <p className="kx-inline-error">{rob.error}</p>}
    </div>
  );
}

export function RateCertainty({ rob }: { rob: ReturnType<typeof useRobAnalysis> }) {
  return (
    <Btn small onClick={rob.rate} title="Rate the certainty of this outcome's evidence with GRADE, from this analysis">
      Rate certainty…
    </Btn>
  );
}
