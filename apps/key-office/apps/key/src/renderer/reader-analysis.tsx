import { classifyLookupError } from "@key-reader/pdfjs/remote-retry";
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
}
const ENGINES: Record<string, string> = {
  "layout-onnx": "Layout analysis with the layout model",
  layout: "Layout analysis",
  pdfium: "Plain PDF text",
};
export const working = (report: AnalysisReport | null | undefined) =>
  !!report &&
  (["pending", "indexing"].includes(report.indexStatus ?? "") ||
    ["pending", "detecting", "resolving"].includes(report.analysis?.referencesStatus ?? ""));

/** How far analysis has got, and a way to run it again. */
export function AnalysisStatus({ report, onRerun }: { report: AnalysisReport | null | undefined; onRerun: () => void }) {
  if (report === undefined) return null;
  const a = report?.analysis;
  const indexing = ["pending", "indexing"].includes(report?.indexStatus ?? "");
  let line: string;
  let progress: number | undefined;
  if (!report) line = "This PDF is not in a library, so it is analysed only while open.";
  else if (indexing) line = report.layoutModel ? "Analysing the layout of this PDF…" : "Reading this PDF…";
  else if (!a) line = "Not analysed with the current method yet.";
  else if (a.referencesStatus === "detecting" || a.referencesStatus === "pending") line = "Finding references…";
  else if (a.referencesStatus === "resolving") {
    line = `Looking up references · ${a.referencesDone} of ${a.referencesTotal}`;
    progress = a.referencesTotal ? a.referencesDone / a.referencesTotal : 0;
  } else if (a.referencesStatus === "none") line = "No reference list found.";
  else if (a.referencesStatus === "failed")
    // Rate limits and outages pass: say so quietly rather than show the provider's error.
    line =
      classifyLookupError(a.referencesError ?? "") === "transient"
        ? "Reference lookup paused: the scholarly indexes are busy. Re-run to try again."
        : `Reference lookup failed: ${a.referencesError ?? "unknown error"}`;
  else line = `${a.referencesTotal} references looked up${a.referencesMatched ? ` · ${a.referencesMatched} in your library` : ""}`;
  return (
    <div className="key-pdf-analysis" role="status" data-working={working(report) || undefined}>
      <div>
        <span>{line}</span>
        {a && !indexing && <small>{ENGINES[a.engine] ?? a.engine} · {new Date(a.analyzedAt).toLocaleDateString()}</small>}
      </div>
      {report && !indexing && (
        <button type="button" onClick={onRerun} title="Read this PDF again and look up its references">
          {a ? "Re-run" : "Analyse"}
        </button>
      )}
      {progress !== undefined && (
        <span className="key-pdf-analysis-bar" aria-hidden="true">
          <i style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      )}
    </div>
  );
}

