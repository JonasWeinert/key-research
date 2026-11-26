// What a source cites and what in the library cites it. One list for the PDF's own
// bibliography and OpenAlex's: works in the library link to their page; the others are
// faint, with Add to put them in the library in one click. Related works come from OpenAlex
// when asked for and are not stored. OpenAlex lookups show a skeleton while they run and are
// retried quietly while OpenAlex is rate limited or unreachable.
import { useState } from "react";
import { useRetryingLookup } from "@key-reader/pdfjs/use-retrying-lookup";
import { Icon } from "./icons";
import type { Invoke, OpenAlexExtra, SourceGraph } from "./library-api";
import { SourceListItem, type ListWork } from "./source-list";
import "./entity.css";

const SHOWN = 12;

type Work = ListWork;

export function WorkReferences({ invoke, workspaceId, sourceId, graph, hasWork, onChanged }: { invoke: Invoke; workspaceId: string; sourceId: string; graph: SourceGraph; hasWork: boolean; onChanged: () => void }) {
  const [all, setAll] = useState(false);
  const [askedExtra, setAskedExtra] = useState(false);
  const [extraLookup, retryExtra] = useRetryingLookup<OpenAlexExtra>(askedExtra ? sourceId : null, () =>
    invoke<OpenAlexExtra>("store_openalex_extra", { kind: "source", id: sourceId }, workspaceId),
  );
  const extra = extraLookup.status === "ready" ? extraLookup.value : undefined;
  // Added from here: the chooser offers this source's collections (add-from-source.tsx).
  const origin = { workspaceId, sourceId };
  const row = (key: string, work: Work) => <SourceListItem key={key} work={work} invoke={invoke} workspaceId={workspaceId} origin={origin} onAdded={onChanged} />;
  // Works already in the library first, each group in the bibliography's order.
  const references = [...graph.references.filter((r) => r.matchedSourceId), ...graph.references.filter((r) => !r.matchedSourceId)];
  const inLibrary = references.filter((r) => r.matchedSourceId).length;
  const shown = all ? references : references.slice(0, SHOWN);
  return (
    <>
      {references.length > 0 && (
        <section className="kx-page-section kx-work-references" aria-label="References">
          <h3>
            References <span className="kx-count">{references.length}</span>
            {inLibrary > 0 && <span className="kx-count"> · {inLibrary} in your library</span>}
          </h3>
          <ul className="kx-work-list">
            {shown.map((work) => (
              row(`${work.origin}:${work.seq}`, work)
            ))}
          </ul>
          {references.length > SHOWN && (
            <button className="kx-page-parts-hint kx-work-more" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${references.length}`}
            </button>
          )}
        </section>
      )}
      {graph.citedBy.length > 0 && (
        <section className="kx-page-section" aria-label="Cited by">
          <h3>
            Cited by in your library <span className="kx-count">{graph.citedBy.length}</span>
          </h3>
          <ul className="kx-work-list">
            {graph.citedBy.map((s) => (
              row(s.id, { title: s.title, year: s.year, matchedSourceId: s.id })
            ))}
          </ul>
        </section>
      )}
      {hasWork && (
        <section className="kx-page-section" aria-label="Related works">
          {!askedExtra ? (
            <button className="kx-page-action" onClick={() => setAskedExtra(true)}>
              <Icon name="sparkle" size={12} /> Related works and citations by year
            </button>
          ) : !extra ? (
            extraLookup.status === "missing" || extraLookup.status === "unavailable" ? (
              <p className="kx-work-abstract kx-work-muted">
                {extraLookup.status === "missing" ? "OpenAlex has no related works for this source." : "Couldn’t reach OpenAlex."}{" "}
                {extraLookup.status === "unavailable" && (
                  <button className="kx-work-retry" onClick={retryExtra}>
                    Retry
                  </button>
                )}
              </p>
            ) : (
              <div className="kx-work-abstract kx-skeleton" role="status" aria-label="Asking OpenAlex">
                <div className="kx-skeleton-line short" />
                <div className="kx-skeleton-line" />
                <div className="kx-skeleton-line" />
              </div>
            )
          ) : (
            <>
              <h3>Citations by year</h3>
              <YearBars counts={extra.countsByYear.map((c) => ({ year: c.year, n: c.cited_by_count ?? 0 }))} />
              {extra.related.length > 0 && (
                <>
                  <h3>
                    Related works <span className="kx-count">{extra.related.length}</span>
                  </h3>
                  <ul className="kx-work-list">
                    {extra.related.map((work) => (
                      row(work.openalexId, work)
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
}

/** A small bar per year, oldest first. */
export function YearBars({ counts }: { counts: { year: number; n: number }[] }) {
  const sorted = [...counts].sort((a, b) => a.year - b.year);
  if (!sorted.length) return <p className="kx-page-parts-hint">No counts yet.</p>;
  const max = Math.max(1, ...sorted.map((c) => c.n));
  return (
    <>
      <div className="kx-year-bars" role="img" aria-label={sorted.map((c) => `${c.year}: ${c.n}`).join(", ")}>
        {sorted.map((c) => (
          <span key={c.year} style={{ height: `${(c.n / max) * 100}%` }} title={`${c.year}: ${c.n}`} />
        ))}
      </div>
      <div className="kx-year-axis">
        <span>{sorted[0].year}</span>
        <span>{sorted.at(-1)!.year}</span>
      </div>
    </>
  );
}
