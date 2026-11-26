// Stage and count labels for indexing and reference analysis, shared by the shell
// (rows, source page, status bar) and the PDF reader's analysis line. No React here.
import type { IndexActivity, IndexJob, ReferencesActivity } from "./library-api";

/** 0–1 progress of one source: reading pages is the first half, embedding the second. */
export function jobProgress(activity: IndexActivity | undefined, id: string): { fraction: number; label: string } | undefined {
  if (!activity) return undefined;
  const reading = activity.reading?.id === id ? activity.reading : undefined;
  const embedding = activity.embedding?.id === id ? activity.embedding : undefined;
  if (embedding) return { fraction: 0.5 + 0.5 * ratio(embedding), label: stageLabel(embedding) };
  if (reading) return { fraction: 0.5 * readingRatio(reading), label: stageLabel(reading) };
  return undefined;
}
const ratio = (job: IndexJob) => (job.total ? Math.min(1, job.done / job.total) : 0);
/** Layout analysis runs one or two passes over the pages; each takes its share. */
const readingRatio = (job: IndexJob) =>
  job.stage === "analysing" && job.steps ? Math.min(1, ((job.step ?? 1) - 1 + ratio(job)) / job.steps) : job.stage === "chunking" ? 1 : ratio(job);
const page = (job: IndexJob) => `page ${Math.min(job.done + 1, job.total)} of ${job.total}`;

/** One source's reference lookup (`store_status.references`), for rows and panels. */
export function referencesProgress(references: ReferencesActivity | null | undefined, id?: string): { fraction?: number; label: string } | undefined {
  if (!references || (id && references.id !== id)) return undefined;
  if (references.stage === "resolving" && references.total)
    return { fraction: Math.min(1, references.done / references.total), label: `Looking up references · ${references.done} of ${references.total}` };
  return { label: "Finding references…" };
}

export function stageLabel(job: IndexJob) {
  switch (job.stage) {
    case "opening":
      return "Opening…";
    case "identifying":
      return "Identifying…";
    case "analysing":
      if (!job.total) return "Analysing layout…";
      return `${job.phase === "layout-model" ? "Recognising layout" : "Reading layout"} · ${page(job)}`;
    case "reading":
      return job.total ? `Reading text · ${page(job)}` : "Reading text…";
    case "chunking":
      return job.total ? `Splitting ${job.total} pages into passages…` : "Splitting into passages…";
    case "embedding":
      return `Indexing passages · ${job.done} of ${job.total}`;
    default:
      return "Queued";
  }
}
/** 0–1 through indexing one job: reading (or layout) is the first half, embedding the second. */
export const jobFraction = (job: IndexJob) => (job.stage === "embedding" ? 0.5 + 0.5 * ratio(job) : 0.5 * readingRatio(job));
