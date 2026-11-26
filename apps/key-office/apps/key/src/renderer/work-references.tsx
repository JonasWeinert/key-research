// What a source cites and what in the library cites it. One list for the PDF's own
// bibliography and OpenAlex's: works in the library link to their page; the others are
// faint, with Add to put them in the library in one click. Related works come from OpenAlex
// when asked for and are not stored. OpenAlex lookups show a skeleton while they run and are
// retried quietly while OpenAlex is rate limited or unreachable.
import { useState } from "react";
import { useRetryingLookup } from "@key-reader/pdfjs/use-retrying-lookup";
import { Icon } from "./icons";
import { openItemAt } from "./item-actions";
import { itemAttrs } from "./item-ui";
import { libraryChanged } from "./library-nav";
import type { Invoke, OpenAlexExtra, Source, SourceGraph, WorkReference } from "./library-api";
import "./entity.css";

const SHOWN = 12;

type Work = Pick<WorkReference, "title" | "byline" | "year" | "container" | "doi" | "openalexId" | "matchedSourceId" | "text">;

/** One work: its title and byline; opened, its abstract (read when first opened) and what
 *  can be done with it. Works already in the library say so. */
function WorkRow({ work, invoke, workspaceId, onAdd }: { work: Work; invoke: Invoke; workspaceId: string; onAdd?: () => Promise<void> }) {
  const title = work.title || work.text || work.doi || "Untitled work";
  const detail = [work.byline, work.year, work.container].filter(Boolean).join(" · ");
  const inLibrary = !!work.matchedSourceId;
  const [open, setOpen] = useState(false);
  // Read when first opened, kept when folded again.
  const [asked, setAsked] = useState(false);
  const [lookup, retry] = useRetryingLookup<{ abstract?: string | null; doi?: string | null; oaUrl?: string | null }>(
    asked ? `${work.matchedSourceId ?? ""}|${work.openalexId ?? ""}` : null,
    () =>
      inLibrary
        ? invoke<Source | null>("store_source", { id: work.matchedSourceId }, workspaceId).then((s) => ({ abstract: s?.abstract, doi: s?.doi, oaUrl: s?.oaUrl }))
        : work.openalexId
          ? invoke<{ abstract?: string | null; doi?: string | null; oaUrl?: string | null }>("store_openalex_work", { openalexId: work.openalexId }, workspaceId)
          : Promise.resolve({ abstract: null, doi: work.doi }),
  );
  const about = lookup.status === "ready" ? lookup.value : undefined;
  const [adding, setAdding] = useState(false);
  const toggle = () => {
    setOpen(!open);
    setAsked(true);
  };
  const link = about ? (about.doi ? `https://doi.org/${about.doi}` : about.oaUrl) : work.doi ? `https://doi.org/${work.doi}` : undefined;
  return (
    <li data-in-library={inLibrary} data-open={open} {...(inLibrary ? itemAttrs({ kind: "source", id: work.matchedSourceId!, title }) : {})}>
      <button className="kx-work-head" aria-expanded={open} onClick={toggle}>
        <Icon name="chevronRight" size={10} />
        <span className="kx-work-text">
          <span className="kx-work-title">{title}</span>
          {detail && <small>{detail}</small>}
        </span>
        {inLibrary && <span className="kx-work-badge">In library</span>}
      </button>
      {open && (
        <div className="kx-work-body">
          {lookup.status === "loading" || lookup.status === "idle" ? (
            <div className="kx-work-abstract kx-skeleton" role="status" aria-label="Loading the abstract">
              <div className="kx-skeleton-line" />
              <div className="kx-skeleton-line" />
              <div className="kx-skeleton-line short" />
            </div>
          ) : lookup.status === "unavailable" ? (
            <p className="kx-work-abstract kx-work-muted">
              Couldn’t load the abstract.{" "}
              <button className="kx-work-retry" onClick={retry}>
                Retry
              </button>
            </p>
          ) : lookup.status === "missing" ? (
            <p className="kx-work-abstract kx-work-muted">No abstract available.</p>
          ) : about?.abstract ? (
            <p className="kx-work-abstract">{about.abstract}</p>
          ) : (
            <p className="kx-work-abstract kx-work-muted">No abstract available.</p>
          )}
          {!inLibrary && work.text && work.text !== title && <p className="kx-work-abstract kx-work-muted">{work.text}</p>}
          <div className="kx-work-actions">
            {inLibrary ? (
              <button className="kx-page-action" onClick={(e) => openItemAt({ kind: "source", id: work.matchedSourceId! }, e.altKey ? "split" : "tab", title)}>
                <Icon name="doc" size={12} /> Open
              </button>
            ) : (
              onAdd && (
                <button
                  className="kx-page-action"
                  disabled={adding}
                  onClick={() => {
                    setAdding(true);
                    void onAdd().finally(() => setAdding(false));
                  }}
                >
                  <Icon name="plus" size={12} /> {adding ? "Adding…" : "Add to library"}
                </button>
              )
            )}
            {link && (
              <a className="kx-page-action" href={link} target="_blank" rel="noreferrer">
                <Icon name="external" size={12} /> {link.includes("doi.org") ? "DOI" : "Open access copy"}
              </a>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function WorkReferences({ invoke, workspaceId, sourceId, graph, hasWork, onChanged }: { invoke: Invoke; workspaceId: string; sourceId: string; graph: SourceGraph; hasWork: boolean; onChanged: () => void }) {
  const [all, setAll] = useState(false);
  const [askedExtra, setAskedExtra] = useState(false);
  const [extraLookup, retryExtra] = useRetryingLookup<OpenAlexExtra>(askedExtra ? sourceId : null, () =>
    invoke<OpenAlexExtra>("store_openalex_extra", { kind: "source", id: sourceId }, workspaceId),
  );
  const extra = extraLookup.status === "ready" ? extraLookup.value : undefined;
  const add = async (work: Work) => {
    if (!work.openalexId) return;
    await invoke("store_add_work", { openalexId: work.openalexId, title: work.title, doi: work.doi, year: work.year }, workspaceId);
    libraryChanged();
    onChanged();
  };
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
              <WorkRow key={`${work.origin}:${work.seq}`} work={work} invoke={invoke} workspaceId={workspaceId} onAdd={work.openalexId ? () => add(work) : undefined} />
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
              <WorkRow key={s.id} work={{ title: s.title, year: s.year, matchedSourceId: s.id }} invoke={invoke} workspaceId={workspaceId} />
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
                      <WorkRow key={work.openalexId} work={work} invoke={invoke} workspaceId={workspaceId} onAdd={() => add(work)} />
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
