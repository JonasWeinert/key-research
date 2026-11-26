// A source's analysis as it runs, for its page: indexing (stage, pages, passages), then
// finding and looking up its references. Polls `store_analysis` only while work is left.
import { useEffect, useState } from "react";
import { jobFraction, stageLabel } from "./analysis-progress";
import type { Invoke } from "./library-api";
import { working, type AnalysisReport } from "./reader-analysis";

export interface StageProgress {
  label: string;
  /** 0–1 when the total is known; undefined shows an indeterminate bar. */
  fraction?: number;
}

/** The references step of a report: "Finding references…", "Looking up references · 7 of 42". */
export function referencesStage(report: AnalysisReport | null | undefined): StageProgress | undefined {
  const a = report?.analysis;
  if (!a) return undefined;
  if (a.referencesStatus === "pending") return { label: "Waiting to find references…" };
  if (a.referencesStatus === "detecting") return { label: "Finding references…" };
  if (a.referencesStatus === "resolving")
    return { label: `Looking up references · ${a.referencesDone} of ${a.referencesTotal}`, fraction: a.referencesTotal ? a.referencesDone / a.referencesTotal : 0 };
  return undefined;
}

/** What was found, once done: "42 references · 38 identified · 3 in your library". */
export function referencesSummary(report: AnalysisReport | null | undefined): string | undefined {
  const a = report?.analysis;
  if (!a) return undefined;
  if (a.referencesStatus === "none") return "No reference list found";
  if (a.referencesStatus !== "done" || !a.referencesTotal) return undefined;
  const identified = report!.references.filter((r) => r.metadata?.title).length;
  return [`${a.referencesTotal} ${a.referencesTotal === 1 ? "reference" : "references"}`, identified ? `${identified} identified` : "", a.referencesMatched ? `${a.referencesMatched} in your library` : ""]
    .filter(Boolean)
    .join(" · ");
}

export function useSourceProgress(invoke: Invoke, workspaceId: string, sourceId: string, kind: string | undefined, indexStatus: string | undefined) {
  const [report, setReport] = useState<AnalysisReport | null>();
  useEffect(() => {
    if (kind !== "pdf") return setReport(undefined);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let next: AnalysisReport | null = null;
      try {
        next = await invoke<AnalysisReport>("store_analysis", { id: sourceId }, workspaceId);
      } catch {}
      if (stopped) return;
      setReport(next);
      if (working(next)) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // indexStatus: a re-run or a new file starts polling again.
  }, [invoke, workspaceId, sourceId, kind, indexStatus]);
  const indexing = ["pending", "indexing"].includes(report?.indexStatus ?? "");
  const job = indexing && report?.job && report.job.stage !== "queued" ? report.job : undefined;
  return {
    index: job ? ({ label: stageLabel(job), fraction: jobFraction(job) } satisfies StageProgress) : undefined,
    references: indexing ? undefined : referencesStage(report),
    summary: referencesSummary(report),
    /** The live index status, to refresh a source loaded before indexing moved on. */
    indexStatus: report?.indexStatus ?? undefined,
  };
}
