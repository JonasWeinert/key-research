// A search result as one item and the places it matched: the search tab's rows, and the
// compact rows of the note's library panel. What a click does is up to the caller.
import type { DragEvent, MouseEvent, ReactNode } from "react";
import { kindOf, type FindKind } from "./global-search";
import { Icon } from "./icons";
import { itemAttrs } from "./item-ui";
import { Snippet, foundIcon } from "./search-sections";
import type { Found } from "./unified-search";

export const KIND_ONE: Record<FindKind, string> = { source: "Source", note: "Note", record: "Page", canvas: "Canvas", highlight: "Highlight" };

/** The results of one item in one section: the item, and each place it matched. */
export interface ItemGroup {
  key: string;
  item: Found;
  matches: Found[];
}

/** Results by item, like the library's search: a source once, its passages beneath it. */
export function byItem(entries: Found[]): ItemGroup[] {
  const groups = new Map<string, ItemGroup>();
  for (const entry of entries) {
    // A highlight is an item of its own; a page of a document belongs to the document.
    const key = entry.anchor?.startsWith("highlight:") ? `${entry.kind}:${entry.id}:${entry.anchor}` : `${entry.kind}:${entry.id}`;
    const group = groups.get(key) ?? { key, item: { ...entry, anchor: entry.anchor?.startsWith("highlight:") ? entry.anchor : undefined, snippet: undefined, where: undefined }, matches: [] };
    if (entry.snippet || entry.where) group.matches.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** One item found: its kind's icon, its title, its byline and each passage that matched.
 *  `compact` is the narrow panel's row: one line of title, one of byline, at most two passages. */
export function FoundHit({
  group,
  index,
  selected,
  onActive,
  onPick,
  titleHint,
  byline,
  compact,
  actions,
  onDragStart,
  onMatchDragStart,
  id,
}: {
  group: ItemGroup;
  index: number;
  selected: boolean;
  onActive: (index: number) => void;
  /** The item (its title) or one of its matches was clicked. */
  onPick: (entry: Found, event: MouseEvent) => void;
  titleHint?: string;
  /** Overrides the item's own byline (authors · year). */
  byline?: string;
  compact?: boolean;
  /** Shown at the row's end (the panel's "open in a tab"). */
  actions?: ReactNode;
  onDragStart?: (event: DragEvent) => void;
  onMatchDragStart?: (match: Found, event: DragEvent) => void;
  id?: string;
}) {
  const { item } = group;
  const kind = kindOf(item);
  const meta = byline ?? item.byline;
  const matches = compact ? group.matches.slice(0, 2) : group.matches;
  return (
    <article
      id={id}
      role="option"
      aria-selected={selected}
      data-index={index}
      className={`kx-hit kx-found-hit${compact ? " kx-found-hit--compact" : ""}`}
      {...itemAttrs(item)}
      draggable={onDragStart ? true : undefined}
      onDragStart={onDragStart}
      onMouseMove={() => !selected && onActive(index)}
    >
      <span className="kx-row-kind" data-kind={item.sourceKind ?? kind}>
        <Icon name={foundIcon(item)} size={compact ? 14 : 15} data-color={item.color} />
      </span>
      <div className="kx-hit-body">
        <button type="button" className="kx-found-open" title={titleHint} tabIndex={compact ? -1 : undefined} onClick={(e) => onPick(item, e)}>
          <strong className="kx-hit-title">{item.title}</strong>
          {!compact && <span className="kx-found-kind">{KIND_ONE[kind]}</span>}
        </button>
        {meta && <span className="kx-hit-meta">{meta}</span>}
        {matches.length > 0 && (
          <ul className="kx-hit-matches">
            {matches.map((match, i) => (
              <li key={`${match.anchor ?? ""}:${match.passageId ?? i}`}>
                <button
                  type="button"
                  className="kx-passage"
                  data-related={match.group === "meaning"}
                  tabIndex={compact ? -1 : undefined}
                  draggable={onMatchDragStart ? true : undefined}
                  onDragStart={onMatchDragStart && ((e) => (e.stopPropagation(), onMatchDragStart(match, e)))}
                  onClick={(e) => onPick(match, e)}
                >
                  {match.where && <span className="kx-match-where">{match.where}</span>}
                  {match.snippet && (
                    <span className="kx-match-text">
                      <Snippet text={match.snippet} />
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {actions}
    </article>
  );
}
