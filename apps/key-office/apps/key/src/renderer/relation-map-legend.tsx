// The relation map's legend: every kind the map can show, in its node's shape and colour,
// with how many it shows. A click shows only that kind (with the centre), ⌘/⇧-click adds
// or removes one, the active one again (or All) shows everything; hovering lights a kind up.
import type { KeyboardEvent, MouseEvent } from "react";
import type { MapKind } from "./library-api";
import { MAP_LABEL, MAP_ORDER } from "./relation-map-layout";

/** A kind's mark: the same shape in the map and its legend. */
export function Shape({ kind, r }: { kind: MapKind; r: number }) {
  switch (kind) {
    case "topic":
    case "field": {
      const d = r * 1.18;
      return <rect className="kx-map-shape" x={-d / 2} y={-d / 2} width={d} height={d} rx={d * 0.22} transform="rotate(45)" data-hollow={kind === "field" || undefined} />;
    }
    case "venue":
    case "collection":
      return <rect className="kx-map-shape" x={-r * 0.92} y={-r * 0.92} width={r * 1.84} height={r * 1.84} rx={r * 0.42} data-hollow={kind === "collection" || undefined} />;
    case "tag":
      return <rect className="kx-map-shape" x={-r * 1.25} y={-r * 0.72} width={r * 2.5} height={r * 1.44} rx={r * 0.72} />;
    case "source":
      return <rect className="kx-map-shape" x={-r * 0.72} y={-r * 0.95} width={r * 1.44} height={r * 1.9} rx={r * 0.3} />;
    default:
      return <circle className="kx-map-shape" r={r} />;
  }
}

/** Kinds shown when a selection is applied: none selected means all. */
export function nextSelection(selected: readonly MapKind[], kind: MapKind, add: boolean): MapKind[] {
  if (add) return selected.includes(kind) ? selected.filter((k) => k !== kind) : MAP_ORDER.filter((k) => k === kind || selected.includes(k));
  return selected.length === 1 && selected[0] === kind ? [] : [kind];
}

export function RelationMapLegend({
  kinds,
  counts,
  more,
  selected,
  onSelect,
  onHover,
  compact,
}: {
  /** The kinds listed, in order (those without nodes show muted). */
  kinds: readonly MapKind[];
  counts: ReadonlyMap<MapKind, number>;
  more?: Partial<Record<MapKind, number>>;
  /** The kinds the map is filtered to; empty when it shows all. */
  selected: readonly MapKind[];
  onSelect: (next: MapKind[]) => void;
  onHover: (kind: MapKind | undefined) => void;
  compact?: boolean;
}) {
  const all = selected.length === 0;
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "Home" ? -99 : e.key === "End" ? 99 : 0;
    if (!step) return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, at + step))]?.focus();
  };
  const pick = (kind: MapKind) => (e: MouseEvent<HTMLButtonElement>) => onSelect(nextSelection(selected, kind, e.metaKey || e.ctrlKey || e.shiftKey));
  return (
    <div className="kx-map-legend" role="toolbar" aria-label="Filter the map by kind" data-compact={compact || undefined} onKeyDown={move} onPointerLeave={() => onHover(undefined)}>
      <button type="button" className="kx-map-kind kx-map-all" aria-pressed={all} title="Show every kind" onClick={() => onSelect([])}>
        All
      </button>
      {kinds.map((k) => {
        const count = counts.get(k) ?? 0;
        const on = selected.includes(k);
        const name = MAP_LABEL[k][1];
        return (
          <button
            key={k}
            type="button"
            className="kx-map-kind"
            data-kind={k}
            data-off={(!all && !on) || undefined}
            aria-pressed={on}
            disabled={!count}
            title={!count ? `No ${name.toLowerCase()} here` : on && selected.length === 1 ? "Show every kind" : `Show only ${name.toLowerCase()} (⌘-click: add or remove)`}
            onClick={pick(k)}
            onPointerEnter={() => count && onHover(k)}
            onFocus={() => count && onHover(k)}
            onBlur={() => onHover(undefined)}
          >
            <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden>
              <Shape kind={k} r={4} />
            </svg>
            {name}
            <small title={more?.[k] ? `${more[k]} more not shown` : undefined}>
              {count}
              {!!more?.[k] && ` +${more[k]}`}
            </small>
          </button>
        );
      })}
    </div>
  );
}
