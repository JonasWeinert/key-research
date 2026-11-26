import { classifyLookupError } from "@key-reader/pdfjs/remote-retry";
import { jobFraction, stageLabel } from "./analysis-progress";
import type { IndexJob } from "./library-api";
import "./reader-analysis.css";

/** What the library knows about this PDF's analysis (key-store). */
export interface AnalysisReport {
  analysis: {
    engine: string;
    analyzedAt: number;
    referencesStatus: string;
    referencesError?: string | null;
    referencesTotal: number;
    referencesDone: number;
    referencesMatched: number;
  } | null;
  references: {
    number?: number | null;
    page?: number | null;
    rects?: number[][];
    text: string;
    metadata?: { title?: string; year?: number | string; authors?: string[]; doi?: string } | null;
    matchedSourceId?: string | null;
  }[];
  layoutModel: boolean;
  indexStatus?: string | null;
  /** Headings layout analysis found: the rail's chapters when the PDF has no outline. */
  sections?: { title: string; page: number; top: number }[];
  /** Where indexing has got with this PDF while it runs (newer hosts). */
  job?: IndexJob | null;
}
const ENGINES: Record<string, string> = {
  "layout-onnx": "Layout analysis with the layout model",
  layout: "Layout analysis",
  pdfium: "Plain PDF text",
  html: "Read from the page",
};
export const working = (report: AnalysisReport | null | undefined) =>
  !!report &&
  (["pending", "indexing"].includes(report.indexStatus ?? "") ||
    ["pending", "detecting", "resolving"].includes(report.analysis?.referencesStatus ?? ""));

const STEPS = 3;

/** How far analysis has got (stage, counts and a bar where the total is known), and a
 *  way to run it again. Reading the PDF, finding its references, looking them up. */
export function AnalysisStatus({ report, onRerun, subject = "pdf" }: { report: AnalysisReport | null | undefined; onRerun: () => void; subject?: "pdf" | "page" }) {
  const it = subject === "page" ? "page" : "PDF";
  if (report === undefined) return null;
  const a = report?.analysis;
  const indexing = ["pending", "indexing"].includes(report?.indexStatus ?? "");
  const job = indexing ? report?.job : undefined;
  let line: string;
  let detail: string | undefined;
  let progress: number | undefined;
  let step: number | undefined;
  if (!report) line = `This ${it} is not in a library, so it is analysed only while open.`;
  else if (indexing) {
    step = 1;
    if (job && job.stage !== "queued") {
      line = stageLabel(job);
      progress = jobFraction(job);
    } else line = report.indexStatus === "pending" ? `Waiting to read this ${it}…` : subject === "page" ? "Reading this page…" : report.layoutModel ? "Analysing the layout of this PDF…" : "Reading this PDF…";
    detail = "then its references are found and looked up";
  } else if (!a) line = "Not analysed with the current method yet. Re-run to read it again.";
  else if (a.referencesStatus === "detecting" || a.referencesStatus === "pending") {
    step = 2;
    line = a.referencesStatus === "pending" ? "Waiting to find references…" : "Finding references…";
  } else if (a.referencesStatus === "resolving") {
    step = 3;
    line = `Looking up references · ${a.referencesDone} of ${a.referencesTotal}`;
    progress = a.referencesTotal ? a.referencesDone / a.referencesTotal : 0;
    const identified = report.references.filter((r) => r.metadata?.title).length;
    detail = [`${a.referencesTotal} found`, identified ? `${identified} identified` : "", a.referencesMatched ? `${a.referencesMatched} in your library` : ""].filter(Boolean).join(" · ");
  } else if (a.referencesStatus === "none") line = `No reference list found in this ${it}.`;
  else if (a.referencesStatus === "failed")
    // Rate limits and outages pass: say so quietly rather than show the provider's error.
    line =
      classifyLookupError(a.referencesError ?? "") === "transient"
        ? "Reference lookup paused: the scholarly indexes are busy. Re-run to try again."
        : `Looking up references did not finish (${a.referencesError ?? "no reason given"}). Check the internet connection and re-run.`;
  else {
    const identified = report.references.filter((r) => r.metadata?.title).length;
    line = [`${a.referencesTotal} ${a.referencesTotal === 1 ? "reference" : "references"}`, identified ? `${identified} identified` : "", a.referencesMatched ? `${a.referencesMatched} in your library` : ""]
      .filter(Boolean)
      .join(" · ");
  }
  const busy = working(report);
  return (
    <div className="key-pdf-analysis" role="status" data-working={busy || undefined} data-step={step}>
      <div>
        <span>{line}</span>
        {busy && step ? (
          <small>
            Step {step} of {STEPS}
            {detail ? ` · ${detail}` : ""}
          </small>
        ) : (
          a && !indexing && <small>{ENGINES[a.engine] ?? a.engine} · {new Date(a.analyzedAt).toLocaleDateString()}</small>
        )}
      </div>
      {report && !indexing && (
        <button type="button" onClick={onRerun} title={`Read this ${it} again and look up its references`}>
          {a ? "Re-run" : "Analyse"}
        </button>
      )}
      {busy && (
        <span className="key-pdf-analysis-bar" data-indeterminate={progress === undefined || undefined} aria-hidden="true">
          <i style={progress === undefined ? undefined : { width: `${Math.max(2, Math.round(progress * 100))}%` }} />
        </span>
      )}
    </div>
  );
}
