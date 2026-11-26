import { AddToLibraryButton, type LibraryWorks } from "@key-reader/pdfjs/library-works";
import type { AnalysisReport } from "./reader-analysis";
import "./reference-aside.css";

type KnownReference = AnalysisReport["references"][number];

/** Under a reference in the References list: what it resolved to, and Add to library (or In
 *  library, which opens it). Nothing while the reference is not resolved yet. */
export function ReferenceAside({
  known,
  works,
  onOpen,
}: {
  known: KnownReference | undefined;
  works: LibraryWorks | undefined;
  onOpen: (sourceId: string) => void;
}) {
  const meta = known?.metadata;
  if (!meta?.title && !known?.matchedSourceId) return null;
  const work = meta?.title
    ? { title: meta.title, doi: meta.doi, authors: meta.authors, year: meta.year }
    : undefined;
  const authors = meta?.authors?.length
    ? `${meta.authors[0].split(/\s+/).at(-1)}${meta.authors.length > 1 ? " et al." : ""}`
    : "";
  const byline = [authors, meta?.year].filter(Boolean).join(" · ");
  return (
    <div className="key-ref-aside">
      {meta?.title && (
        <span className="key-ref-aside-title" title={meta.doi ? `${meta.title}\ndoi:${meta.doi}` : meta.title}>
          {meta.title}
          {byline && <small>{byline}</small>}
        </span>
      )}
      {work && works ? (
        <AddToLibraryButton works={works} work={work} knownSourceId={known?.matchedSourceId} variant="row" />
      ) : known?.matchedSourceId ? (
        <button type="button" className="key-work-add key-work-add-row" data-state="present" onClick={() => onOpen(known.matchedSourceId!)}>
          In library
        </button>
      ) : null}
    </div>
  );
}
