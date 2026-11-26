// People, journals, topics and tags wherever they appear. Everywhere the same choice: a
// click shows a small popover (who or what it is, and what the library holds of it) with
// "Search library", which filters the library by it, and "Open overview", its own page;
// right-click offers both as menu items. Item links in notes (key://person/…) take part
// through `ItemLayer`, which shows the same popover.
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Creator } from "./citation";
import { FilterLink, FilterLinks, showInLibrary, sourceFilter } from "./filter-links";
import { Icon, type IconName } from "./icons";
import { openItemAt, shellContext } from "./item-actions";
import { creatorName, type PersonPageData, type TagPageData, type TopicPageData, type VenuePageData } from "./library-api";
import { itemHref } from "./note-editor";
import type { SearchFilter } from "./search-suggest";
import "./entity.css";
import { useDismiss } from "@key-reader/ui/dismiss";

export type EntityKind = "person" | "venue" | "topic" | "tag";
export const ENTITY_KINDS: readonly EntityKind[] = ["person", "venue", "topic", "tag"];
export const isEntityKind = (kind: string): kind is EntityKind => (ENTITY_KINDS as readonly string[]).includes(kind);
export const ENTITY_ICON: Record<EntityKind, IconName> = { person: "person", venue: "journal", topic: "topic", tag: "tag" };
export const ENTITY_COMMAND: Record<EntityKind, string> = { person: "store_person", venue: "store_venue", topic: "store_topic", tag: "store_tag" };

export interface EntityRef {
  kind: EntityKind;
  id: string;
  name: string;
}

export const entityFilter = (e: EntityRef): SearchFilter =>
  e.kind === "person"
    ? sourceFilter.person(e.id, e.name)
    : e.kind === "venue"
      ? sourceFilter.venue(e.id, e.name)
      : e.kind === "tag"
        ? sourceFilter.tag(e.id)
        : sourceFilter.topic(e.id, e.name);

/** Elements whose view filters its own list (the library): a search there adds a token. */
const localSearch = new WeakMap<Element, (filter: SearchFilter) => void>();

/** "Search library": in the library itself the filter joins the search; elsewhere the library opens with it. */
export function searchEntity(entity: EntityRef, from?: Element | null) {
  const filter = entityFilter(entity);
  const local = from && localSearch.get(from);
  if (local) return local(filter);
  const { workspaceId } = shellContext();
  if (workspaceId) showInLibrary(workspaceId, filter);
}
export const openOverview = (entity: EntityRef, placement: "tab" | "split" = "tab") => openItemAt({ kind: entity.kind, id: entity.id }, placement, entity.name);

/** The two choices as menu entries (right-click, the map's nodes). */
export function entityChoices(entity: EntityRef, from?: Element | null) {
  return [
    { label: "Search library", icon: "search" as const, run: () => searchEntity(entity, from) },
    { label: "Open overview", icon: "external" as const, shortcut: "↩", run: () => openOverview(entity) },
  ];
}

/** Marks an element as showing an entity, for hover previews and the right-click menu. */
export function entityAttrs(entity: EntityRef) {
  return { "data-item": itemHref({ kind: entity.kind, id: entity.id }), "data-item-title": entity.name || undefined };
}

type Facts = { title: string; subtitle?: string; lines: string[]; badge?: string; chips: { label: string; entity?: EntityRef }[] };
type PageData = PersonPageData | VenuePageData | TopicPageData | TagPageData;

function facts(kind: EntityKind, data: PageData): Facts {
  const sources = (n: number) => `${n} ${n === 1 ? "source" : "sources"} in your library`;
  const span = (a?: number | null, b?: number | null) => (a && b ? (a === b ? `${a}` : `${a}–${b}`) : "");
  if (kind === "person") {
    const { person, coauthors, firstYear, lastYear } = data as PersonPageData;
    return {
      title: person.name,
      subtitle: person.institution?.name ?? undefined,
      badge: person.orcid ? "ORCID" : undefined,
      lines: [
        [sources(person.sourceCount), span(firstYear, lastYear)].filter(Boolean).join(" · "),
        [person.worksCount != null && `${person.worksCount.toLocaleString()} works`, person.hIndex != null && `h-index ${person.hIndex}`, person.citedByCount != null && `${person.citedByCount.toLocaleString()} citations`]
          .filter(Boolean)
          .join(" · "),
      ].filter(Boolean),
      chips: coauthors.slice(0, 4).map((c) => ({ label: c.name, entity: { kind: "person", id: c.id, name: c.name } })),
    };
  }
  if (kind === "venue") {
    const { venue, firstYear, lastYear, people } = data as VenuePageData;
    return {
      title: venue.name,
      subtitle: [venue.publisher?.name, venue.issnL && `ISSN ${venue.issnL}`].filter(Boolean).join(" · ") || undefined,
      badge: venue.isOa ? "Open access" : undefined,
      lines: [[sources(venue.sourceCount), span(firstYear, lastYear)].filter(Boolean).join(" · "), venue.hIndex != null ? `h-index ${venue.hIndex}` : ""].filter(Boolean),
      chips: people.slice(0, 4).map((c) => ({ label: c.name, entity: { kind: "person", id: c.id, name: c.name } })),
    };
  }
  if (kind === "tag") {
    const tag = data as TagPageData;
    return { title: tag.name, subtitle: "Tag", lines: [[sources(tag.sourceCount), span(tag.firstYear, tag.lastYear)].filter(Boolean).join(" · ")], chips: [] };
  }
  const { topic, children } = data as TopicPageData;
  return {
    title: topic.name,
    subtitle: topic.path.map((t) => t.name).join(" › ") || undefined,
    lines: [sources(topic.sourceCount)],
    chips: children.slice(0, 4).map((c) => ({ label: c.name, entity: { kind: "topic", id: c.id, name: c.name } })),
  };
}

/** The choice itself, placed under `anchor` (or at a point) and kept on screen. */
export function EntityPopover({
  entity,
  anchor,
  onClose,
  extra,
}: {
  entity: EntityRef;
  anchor: Element | DOMRect;
  onClose: () => void;
  /** A further choice, e.g. the map's "Centre map here". */
  extra?: { label: string; icon: IconName; run: () => void };
}) {
  const { invoke, workspaceId } = shellContext();
  const libraryFilter = useContext(FilterLinks);
  const [current, setCurrent] = useState(entity);
  const [data, setData] = useState<Facts | null>();
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  useEffect(() => {
    if (!invoke || !workspaceId) return;
    let live = true;
    setData(undefined);
    void invoke<PageData | null>(ENTITY_COMMAND[current.kind], { id: current.id }, workspaceId)
      .then((page) => live && setData(page ? facts(current.kind, page) : null))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [invoke, workspaceId, current.kind, current.id]);
  useLayoutEffect(() => {
    const box = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
    const width = ref.current?.offsetWidth ?? 300;
    const height = ref.current?.offsetHeight ?? 160;
    const below = box.bottom + 6 + height < window.innerHeight;
    setPlace({ left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)), top: below ? box.bottom + 6 : Math.max(8, box.top - height - 6) });
  }, [anchor, data]);
  // Outside presses, scrolling away (or the chip scrolling out of view) and Escape close it.
  const anchorRef = useRef<Element | null>(anchor instanceof Element ? anchor : null);
  anchorRef.current = anchor instanceof Element ? anchor : null;
  useDismiss(true, { refs: [ref, anchorRef], anchor: anchor instanceof Element ? anchorRef : undefined, onDismiss: onClose });
  const named = { ...current, name: data?.title ?? current.name };
  const search = () => {
    if (libraryFilter) libraryFilter(entityFilter(named));
    else searchEntity(named, anchor instanceof Element ? anchor : null);
    onClose();
  };
  const open = (placement: "tab" | "split" = "tab") => {
    openOverview(named, placement);
    onClose();
  };
  return createPortal(
    <div
      ref={ref}
      className="kx-entity-popover"
      role="dialog"
      aria-label={data?.title ?? current.name}
      data-kind={current.kind}
      style={place ? { left: place.left, top: place.top } : { visibility: "hidden" }}
      {...entityAttrs(current)}
      data-no-preview=""
      onKeyDown={(e) => {
        if (e.key === "Enter" && !(e.target as Element).closest("button")) open(e.altKey ? "split" : "tab");
      }}
    >
      <header>
        <span className="kx-entity-icon">
          <Icon name={ENTITY_ICON[current.kind]} size={14} />
        </span>
        <span className="kx-entity-heading">
          <strong>{data?.title ?? current.name}</strong>
          {data?.subtitle && <small>{data.subtitle}</small>}
        </span>
        {data?.badge && <span className="kx-entity-badge">{data.badge}</span>}
      </header>
      {data === null ? (
        <p className="kx-entity-line">Not in this library any more.</p>
      ) : (
        <>
          {(data?.lines ?? ["…"]).map((line) => (
            <p className="kx-entity-line" key={line}>
              {line}
            </p>
          ))}
          {!!data?.chips.length && (
            <div className="kx-entity-chips" aria-label={current.kind === "person" ? "Co-authors" : current.kind === "venue" ? "Authors" : "Narrower topics"}>
              {data.chips.map((chip) => (
                <button key={chip.label} className="kx-entity-chip" onClick={() => chip.entity && setCurrent(chip.entity)}>
                  {chip.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <div className="kx-entity-choices" role="group" aria-label="Show">
        <button className="kx-entity-choice" onClick={search} disabled={data === null}>
          <Icon name="search" size={13} />
          <span>Search library</span>
          <small>Filter your sources</small>
        </button>
        <button className="kx-entity-choice" onClick={(e) => open(e.altKey ? "split" : "tab")} disabled={data === null} autoFocus>
          <Icon name="relations" size={13} />
          <span>Open overview</span>
          <small>Its page and map</small>
        </button>
        {extra && (
          <button
            className="kx-entity-choice"
            onClick={() => {
              extra.run();
              onClose();
            }}
          >
            <Icon name={extra.icon} size={13} />
            <span>{extra.label}</span>
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** A name, journal, topic or tag that offers the choice; plain text where nothing is known of it. */
export function EntityLink({ entity, children, className }: { entity?: EntityRef; children: ReactNode; className?: string }) {
  const [anchor, setAnchor] = useState<HTMLElement>();
  const libraryFilter = useContext(FilterLinks);
  if (!entity) return <span className={className}>{children}</span>;
  return (
    <>
      <button
        type="button"
        ref={(el) => {
          if (el && libraryFilter) localSearch.set(el, libraryFilter);
        }}
        className={`kx-filter-link kx-entity-link${className ? ` ${className}` : ""}`}
        data-entity={entity.kind}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        {...entityAttrs(entity)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          // ⌥-click opens the overview beside, as item links do.
          if (e.altKey || e.metaKey) return openOverview(entity, e.altKey ? "split" : "tab");
          const target = e.currentTarget;
          setAnchor((open) => (open ? undefined : target));
        }}
      >
        {children}
      </button>
      {anchor && <EntityPopover entity={entity} anchor={anchor} onClose={() => setAnchor(undefined)} />}
    </>
  );
}

/** For a field edited in place (the journal): a small button beside it with the popover. */
export function EntityButton({ entity }: { entity: EntityRef }) {
  const [anchor, setAnchor] = useState<HTMLElement>();
  return (
    <>
      <button
        type="button"
        className="kx-filter-button"
        title={`About ${entity.name}`}
        aria-label={`About ${entity.name}`}
        aria-haspopup="dialog"
        {...entityAttrs(entity)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const target = e.currentTarget;
          setAnchor((open) => (open ? undefined : target));
        }}
      >
        <Icon name={ENTITY_ICON[entity.kind]} size={11} />
      </button>
      {anchor && <EntityPopover entity={entity} anchor={anchor} onClose={() => setAnchor(undefined)} />}
    </>
  );
}

/** An author: their page and choice when the library knows them, else a filter by name. */
export function CreatorLink({ creator, children }: { creator: Creator; children?: ReactNode }) {
  const name = creatorName(creator);
  if (creator.personId) return <EntityLink entity={{ kind: "person", id: creator.personId, name }}>{children ?? name}</EntityLink>;
  return <FilterLink filter={sourceFilter.creator(creator)}>{children ?? name}</FilterLink>;
}

export function TagLink({ tag, children }: { tag: string; children?: ReactNode }) {
  return <EntityLink entity={{ kind: "tag", id: tag, name: tag }}>{children ?? tag}</EntityLink>;
}

/** A journal title: its page and choice when it is linked to one, else a filter by title. */
export function VenueLink({ venueId, title, children }: { venueId?: string | null; title: string; children?: ReactNode }) {
  if (venueId) return <EntityLink entity={{ kind: "venue", id: venueId, name: title }}>{children ?? title}</EntityLink>;
  return <FilterLink filter={title ? sourceFilter.container(title) : undefined}>{children ?? title}</FilterLink>;
}
