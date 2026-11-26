// One row for a source or work wherever pages list them (a source's references, cited-by and
// related works; a topic's, person's, journal's or tag's sources): the title and byline, and
// opened in place its abstract (read when first opened), its people, journal and tags as
// entity links, and what can be done with it: Open, Open to the side, or Add to library for
// works not in it yet (asking where, see add-from-source.tsx), and Add to Inbox to decide on
// later (inbox-save.tsx). ⌥-click opens it to the side,
// ⌘-click or a double-click in a tab.
import { useState, type MouseEvent, type ReactNode } from "react";
import { useRetryingLookup } from "@key-reader/pdfjs/use-retrying-lookup";
import { CreatorLink, TagLink, VenueLink } from "./entity-ui";
import { Icon } from "./icons";
import { openItemAt } from "./item-actions";
import { setItemDrag } from "./item-links";
import { itemAttrs } from "./item-ui";
import { KIND_ICON, shortCreators, type Invoke, type Source, type WorkReference } from "./library-api";
import { addFromSource, type AddOrigin } from "./add-from-source";
import { useLibraryMatch } from "./library-match";
import { AddToInboxButton, type InboxOrigin } from "./inbox-save";
import "./entity.css";

export type ListWork = Pick<WorkReference, "title" | "byline" | "year" | "container" | "doi" | "openalexId" | "matchedSourceId" | "text"> & {
  /** What the context already knows of its abstract (a feed's summary): shown when no lookup has one. */
  abstract?: string | null;
  url?: string | null;
  authors?: string[] | null;
};
type About = { abstract?: string | null; doi?: string | null; oaUrl?: string | null; source?: Source | null };

export function SourceListItem({
  work,
  source,
  invoke,
  workspaceId,
  origin,
  onAdded,
  badge = !source,
  selected,
  onSelect,
  picked,
  aside,
  actions,
  inbox,
}: {
  /** A work known by its metadata (a reference, a related work). */
  work?: ListWork;
  /** A source in the library: shown from its record, without a lookup for its details. */
  source?: Source;
  invoke: Invoke;
  workspaceId: string;
  /** The source whose context lists it: Add to library offers its collections. */
  origin?: AddOrigin;
  onAdded?: (source: Source) => void;
  /** Says "In library" on works the library has (off where every row is in it). */
  badge?: boolean;
  /** The row the keyboard is on, in lists that triage (the Inbox). */
  selected?: boolean;
  onSelect?: (e: MouseEvent<HTMLLIElement>) => void;
  /** Picked for an action on several rows (the Inbox's selection). */
  picked?: boolean;
  /** Marks beside the title (unread, saved, where it came from). */
  aside?: ReactNode;
  /** More actions after the row's own, when opened. */
  actions?: ReactNode;
  /** Where Add to Inbox says the work was found (default: the origin source); false hides it. */
  inbox?: InboxOrigin | false;
}) {
  // A work the host did not match already (related works, cited-by): asked by its identifiers,
  // with its title only ever "possibly" the library's.
  const unmatched = !source && work && !work.matchedSourceId;
  const match = useLibraryMatch(
    invoke,
    workspaceId,
    unmatched ? { doi: work.doi, openalex: work.openalexId, title: work.title, year: work.year, firstAuthor: work.byline?.split(/,|\band\b/)[0]?.trim() } : null,
  );
  const id = source?.id ?? work?.matchedSourceId ?? (match?.certain ? match.sourceId : undefined);
  const possible = !id && match && !match.certain ? match.sourceId : undefined;
  const inLibrary = !!id;
  const title = source ? source.title || "Untitled" : work?.title || work?.text || work?.doi || "Untitled work";
  const container = source ? source.containerShort || source.containerTitle : work?.container;
  const detail = source
    ? [shortCreators(source.creators), source.year, container, source.retracted === 1 ? "Retracted" : ""].filter(Boolean).join(" · ")
    : [work?.byline, work?.year, work?.container].filter(Boolean).join(" · ");
  const [open, setOpen] = useState(false);
  // Read when first opened, kept when folded again.
  const [asked, setAsked] = useState(false);
  const [lookup, retry] = useRetryingLookup<About>(asked && !source ? `${id ?? ""}|${work?.openalexId ?? ""}` : null, () =>
    inLibrary
      ? invoke<Source | null>("store_source", { id }, workspaceId).then((s) => ({ abstract: s?.abstract, doi: s?.doi, oaUrl: s?.oaUrl, source: s }))
      : work?.openalexId
        ? invoke<About>("store_openalex_work", { openalexId: work.openalexId }, workspaceId)
        : Promise.resolve({ abstract: null, doi: work?.doi }),
  );
  const looked: About | undefined = source ? { abstract: source.abstract, doi: source.doi, oaUrl: source.oaUrl, source } : lookup.status === "ready" ? lookup.value : undefined;
  const about: About | undefined = looked && !looked.abstract && work?.abstract ? { ...looked, abstract: work.abstract } : looked;
  const status = source ? "ready" : lookup.status;
  const record = about?.source ?? undefined;
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<Source>();
  const toggle = () => {
    setOpen(!open);
    setAsked(true);
  };
  const openAt = (placement: "tab" | "split") => {
    const target = id ?? added?.id;
    if (target) openItemAt({ kind: "source", id: target }, placement, title);
  };
  const doi = about?.doi ?? work?.doi;
  const link = doi ? `https://doi.org/${doi}` : (about?.oaUrl ?? undefined);
  const add = (e: MouseEvent<HTMLButtonElement>) => {
    if (!work) return;
    setAdding(true);
    void addFromSource(invoke, origin ?? { workspaceId }, { ...work, doi: work.doi ?? about?.doi, url: work.url ?? undefined }, e.currentTarget)
      .then((s) => {
        if (!s) return;
        setAdded(s);
        onAdded?.(s);
      })
      .catch(() => {})
      .finally(() => setAdding(false));
  };
  const creators = record?.creators ?? [];
  return (
    <li
      className="kx-source-item"
      data-in-library={inLibrary || !!added}
      data-open={open}
      data-selected={selected || undefined}
      data-picked={picked || undefined}
      onMouseDown={onSelect}
      {...(id ? itemAttrs({ kind: "source", id, title }) : {})}
      draggable={!!id}
      onDragStart={id ? (e) => setItemDrag(e.dataTransfer, [{ kind: "source", id, title }]) : undefined}
    >
      <button
        className="kx-work-head"
        aria-expanded={open}
        onClick={(e) => {
          if (inLibrary && (e.altKey || e.metaKey)) return openAt(e.altKey ? "split" : "tab");
          toggle();
        }}
        onDoubleClick={() => inLibrary && openAt("tab")}
      >
        <Icon name="chevronRight" size={10} />
        {source && (
          <span className="kx-source-item-kind" data-kind={source.kind}>
            <Icon name={KIND_ICON[source.kind] ?? "doc"} size={13} />
          </span>
        )}
        <span className="kx-work-text">
          <span className="kx-work-title">{title}</span>
          {detail && <small>{detail}</small>}
        </span>
        {aside}
        {badge && (inLibrary || added) && <span className="kx-work-badge">In library</span>}
        {badge && possible && !added && (
          <span className="kx-work-badge" data-possible title="A source with this title is in your library">
            Possibly in library
          </span>
        )}
      </button>
      {open && (
        <div className="kx-work-body">
          {status === "loading" || status === "idle" ? (
            <div className="kx-work-abstract kx-skeleton" role="status" aria-label="Loading the abstract">
              <div className="kx-skeleton-line" />
              <div className="kx-skeleton-line" />
              <div className="kx-skeleton-line short" />
            </div>
          ) : status === "unavailable" ? (
            <p className="kx-work-abstract kx-work-muted">
              Couldn’t load the abstract.{" "}
              <button className="kx-work-retry" onClick={retry}>
                Retry
              </button>
            </p>
          ) : about?.abstract ? (
            <p className="kx-work-abstract">{about.abstract}</p>
          ) : (
            <p className="kx-work-abstract kx-work-muted">No abstract available.</p>
          )}
          {!inLibrary && work?.text && work.text !== title && <p className="kx-work-abstract kx-work-muted">{work.text}</p>}
          {record && (creators.length > 0 || record.containerTitle || record.tags.length > 0) && (
            <p className="kx-source-item-entities">
              {creators.slice(0, 6).map((c, i) => (
                <CreatorLink key={`${i}:${c.family ?? ""}${c.given ?? ""}${c.literal ?? ""}`} creator={c} />
              ))}
              {creators.length > 6 && <small>+{creators.length - 6}</small>}
              {record.containerTitle && (
                <VenueLink venueId={record.venueId} title={record.containerTitle}>
                  {record.containerShort || record.containerTitle}
                </VenueLink>
              )}
              {record.tags.slice(0, 6).map((t) => (
                <TagLink key={t} tag={t}>
                  #{t}
                </TagLink>
              ))}
            </p>
          )}
          <div className="kx-work-actions">
            {inLibrary || added ? (
              <>
                <button className="kx-page-action" onClick={(e) => openAt(e.altKey ? "split" : "tab")}>
                  <Icon name="doc" size={12} /> Open
                </button>
                <button className="kx-page-action" onClick={() => openAt("split")} title="Open beside this page (⌥-click)">
                  <Icon name="split" size={12} /> Open to the side
                </button>
              </>
            ) : (
              work &&
              (work.openalexId || work.doi || work.title) && (
                <>
                  {possible && (
                    <button className="kx-page-action" onClick={() => openItemAt({ kind: "source", id: possible }, "split", title)} title="Open the source with this title">
                      <Icon name="doc" size={12} /> Open the possible match
                    </button>
                  )}
                  <button className="kx-page-action" disabled={adding} onClick={add}>
                    <Icon name="plus" size={12} /> {adding ? "Adding…" : possible ? "Add anyway" : "Add to library"}
                  </button>
                  {inbox !== false && (
                    <AddToInboxButton
                      invoke={invoke}
                      workspaceId={workspaceId}
                      work={{
                        title: work.title || work.text || null,
                        authors: work.authors ?? (work.byline ? work.byline.split(/,\s*/).filter((a) => a && a !== "et al.") : null),
                        year: work.year ?? null,
                        venue: work.container ?? null,
                        abstract: about?.abstract ?? work.abstract ?? null,
                        doi: doi ?? null,
                        ids: work.openalexId ? { openalex: work.openalexId } : null,
                        landingUrl: work.url ?? null,
                      }}
                      origin={inbox || { kind: "source", sourceId: origin?.sourceId ?? null }}
                    />
                  )}
                </>
              )
            )}
            {actions}
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
