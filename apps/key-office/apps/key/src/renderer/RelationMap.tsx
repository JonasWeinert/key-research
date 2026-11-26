// A calm map of how the things in a library relate around one of them: the centre in the
// middle, its strongest topics, fields, people, journals, tags and collections around it,
// each kind in its own sector, colour and shape, nearer and larger the more sources they
// share. One SVG, laid out once per change (no simulation); it loads when it scrolls into
// view. Hovering a node lights up what it goes with; clicking offers Search library, Open
// overview and Centre map here, and re-centring glides the shared nodes to their places.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { EntityPopover, entityChoices, isEntityKind, type EntityRef } from "./entity-ui";
import { showInLibrary, sourceFilter } from "./filter-links";
import { Icon, type IconName } from "./icons";
import { openItemAt } from "./item-actions";
import { showMenu } from "./item-ui";
import { bridge, type Invoke, type MapKind, type MapNode, type RelationMapData } from "./library-api";
import { MAP_LABEL, MAP_ORDER, arc, labelAnchor, layoutMap, nodeKey, truncate, type PlacedNode } from "./relation-map-layout";
import "./relation-map.css";

export interface MapCenter {
  kind: MapKind;
  id: string;
  name: string;
}
export interface MapOptions {
  /** Kinds shown (all when unset). */
  kinds?: MapKind[];
  /** At most this many of each kind. */
  cap?: number;
  /** Shared sources a node needs. */
  minCount?: number;
}
type Variant = "page" | "paper" | "embed";

const HEIGHT: Record<Variant, number> = { page: 440, paper: 300, embed: 380 };
const CAPS = [5, 8, 14];
const KIND_ICON: Record<MapKind, IconName> = { topic: "topic", field: "topic", person: "person", venue: "journal", tag: "tag", collection: "collection", source: "doc" };

// Answers are kept while the library is unchanged, so re-centring back is instant.
const cache = new Map<string, Promise<RelationMapData | null>>();
function load(invoke: Invoke, workspaceId: string, center: MapCenter, cap: number) {
  const kind = center.kind === "field" ? "topic" : center.kind;
  const key = `${workspaceId}|${kind}:${center.id}|${cap}`;
  if (!cache.has(key)) {
    const answer = invoke<RelationMapData | null>("store_relation_map", { kind, id: center.id, limit: cap }, workspaceId);
    answer.catch(() => cache.delete(key));
    cache.set(key, answer);
  }
  return cache.get(key)!;
}

function Shape({ kind, r }: { kind: MapKind; r: number }) {
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

export default function RelationMap({
  invoke,
  workspaceId,
  center: origin,
  variant = "page",
  options,
  onOptions,
  onSummary,
}: {
  invoke: Invoke;
  workspaceId: string;
  center: MapCenter;
  variant?: Variant;
  options?: MapOptions;
  /** Where changed options are kept (an embed saves them in its note). */
  onOptions?: (options: MapOptions) => void;
  /** A line saying what the map shows, for a Markdown reader (an embed keeps it in its note). */
  onSummary?: (summary: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const [trail, setTrail] = useState<MapCenter[]>([]);
  const center = trail.at(-1) ?? origin;
  const [data, setData] = useState<RelationMapData | null>();
  const [cap, setCap] = useState(options?.cap ?? (variant === "paper" ? 5 : 8));
  const [hidden, setHidden] = useState<Set<MapKind>>(() => new Set(options?.kinds ? MAP_ORDER.filter((k) => !options.kinds!.includes(k)) : []));
  const [minCount, setMinCount] = useState(options?.minCount ?? 1);
  const [hover, setHover] = useState<string>();
  const [choice, setChoice] = useState<{ node: PlacedNode; el: Element }>();

  useEffect(() => setTrail([]), [origin.kind, origin.id]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const sizes = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    // Nothing is read or drawn until the map is on screen.
    const seen = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "120px" });
    sizes.observe(el);
    seen.observe(el);
    return () => {
      sizes.disconnect();
      seen.disconnect();
    };
  }, []);
  const reload = useCallback(() => {
    let live = true;
    void load(invoke, workspaceId, center, cap)
      .then((answer) => live && setData(answer))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [invoke, workspaceId, center.kind, center.id, cap]);
  const [stamp, setStamp] = useState(0);
  useEffect(
    () =>
      bridge().on("library-changed", () => {
        cache.clear();
        setStamp((s) => s + 1);
      }),
    [],
  );
  useEffect(() => (visible ? reload() : undefined), [visible, reload, stamp]);

  const kinds = useMemo(() => new Set(MAP_ORDER.filter((k) => !hidden.has(k))), [hidden]);
  const summaryRef = useRef(onSummary);
  summaryRef.current = onSummary;
  useEffect(() => {
    if (!data || trail.length) return;
    const shown = data.nodes.filter((n) => kinds.has(n.kind) && n.count >= minCount).slice(0, 60);
    const strongest = [...shown].sort((a, b) => b.count - a.count).slice(0, 6);
    const list = strongest.map((n) => (n.kind === "source" ? n.name : `${n.name} (${n.count})`)).join(", ");
    summaryRef.current?.(`Relation map of ${data.center.name}${list ? `: ${list}${shown.length > strongest.length ? ", …" : ""}` : ""}`);
  }, [data, kinds, minCount, trail.length]);
  const compact = variant === "paper" || width < 560;
  const height = width < 560 ? Math.min(HEIGHT[variant], 340) : HEIGHT[variant];
  const layout = useMemo(() => (data && width ? layoutMap(data, { width, height, kinds, minCount, compact }) : undefined), [data, width, height, kinds, minCount, compact]);
  const save = (next: Partial<MapOptions>) => onOptions?.({ kinds: MAP_ORDER.filter((k) => !hidden.has(k)), cap, minCount, ...next });

  const neighbours = useMemo(() => {
    if (!hover || !layout) return undefined;
    const set = new Set([hover]);
    for (const l of layout.links) {
      if (l.a === hover) set.add(l.b);
      if (l.b === hover) set.add(l.a);
    }
    return set;
  }, [hover, layout]);
  const byKey = useMemo(() => new Map(layout?.nodes.map((n) => [n.key, n]) ?? []), [layout]);
  // Ties between the shown nodes appear only for the one hovered: calm until asked.
  const hoverLinks = useMemo(() => (layout && hover ? layout.links.filter((l) => l.a === hover || l.b === hover) : []), [layout, hover]);

  const recenter = (node: MapNode) => {
    setHover(undefined);
    setTrail((t) => [...t, { kind: node.kind === "field" ? "topic" : node.kind, id: node.id, name: node.name }]);
  };
  const choose = (node: PlacedNode, el: Element, at?: { x: number; y: number }) => {
    const entityKind = node.kind === "field" ? "topic" : node.kind;
    if (isEntityKind(entityKind)) return setChoice({ node, el });
    const rect = el.getBoundingClientRect();
    const x = at?.x ?? rect.right;
    const y = at?.y ?? rect.bottom;
    const here = { label: "Centre map here", icon: "circle" as const, run: () => recenter(node) };
    if (node.kind === "collection")
      showMenu({ x, y, entries: [{ label: "Search library", icon: "search", run: () => showInLibrary(workspaceId, sourceFilter.collection(node.id, node.name)) }, here] });
    else
      showMenu({
        x,
        y,
        entries: [
          { label: "Open", icon: "arrowRight", shortcut: "↩", run: () => openItemAt({ kind: "source", id: node.id }, "tab", node.name) },
          { label: "Open beside", icon: "split", shortcut: "⌥↩", run: () => openItemAt({ kind: "source", id: node.id }, "split", node.name) },
          "-",
          here,
        ],
      });
  };

  const counts = useMemo(() => {
    const out = new Map<MapKind, number>();
    for (const n of data?.nodes ?? []) out.set(n.kind, (out.get(n.kind) ?? 0) + 1);
    return out;
  }, [data]);
  const maxCount = Math.max(1, ...(data?.nodes.filter((n) => n.kind !== "source").map((n) => n.count) ?? [1]));
  const hovered = hover ? byKey.get(hover) : undefined;
  const caption = (() => {
    if (!data) return "";
    if (!hovered) {
      if (variant === "paper") return "Its topics, people and journal, and the library sources closest to it";
      return `${data.center.count} ${data.center.count === 1 ? "source" : "sources"} · nearer and larger means more in common`;
    }
    const kind = MAP_LABEL[hovered.kind][0];
    const ties = layout!.links
      .filter((l) => l.a === hovered.key || l.b === hovered.key)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((l) => byKey.get(l.a === hovered.key ? l.b : l.a))
      .filter(Boolean)
      .map((n) => truncate(n!.name, 24));
    const amount =
      hovered.kind === "source"
        ? hovered.detail
        : variant === "paper"
          ? `${hovered.count} ${hovered.count === 1 ? "source" : "sources"} in your library`
          : `${hovered.count} of ${data.center.count} ${data.center.count === 1 ? "source" : "sources"}`;
    return [`${hovered.name}`, kind, amount, ties.length && `with ${ties.join(", ")}`].filter(Boolean).join(" · ");
  })();

  const onKey = (node: PlacedNode) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(node, e.currentTarget);
    }
  };
  const onClick = (node: PlacedNode) => (e: MouseEvent<SVGGElement>) => {
    e.stopPropagation();
    choose(node, e.currentTarget, { x: e.clientX, y: e.clientY });
  };
  const onContext = (node: PlacedNode) => (e: MouseEvent<SVGGElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const entityKind = node.kind === "field" ? "topic" : node.kind;
    const here = { label: "Centre map here", icon: "circle" as const, run: () => recenter(node) };
    if (!isEntityKind(entityKind)) return choose(node, e.currentTarget, { x: e.clientX, y: e.clientY });
    const entity: EntityRef = { kind: entityKind, id: node.id, name: node.name };
    showMenu({ x: e.clientX, y: e.clientY, entries: [...entityChoices(entity), "-", here] });
  };

  const centerKey = data ? nodeKey(data.center) : "";
  // In one keyed list in a fixed order, so a node that becomes the centre (or stops being
  // it) keeps its element and glides there.
  const all = layout && data ? [{ center: true as const, key: centerKey }, ...layout.nodes.map((n) => ({ center: false as const, key: n.key, node: n }))].sort((a, b) => (a.key < b.key ? -1 : 1)) : [];
  const spokes = layout ? [...layout.nodes].sort((a, b) => (a.key < b.key ? -1 : 1)) : [];

  return (
    <div className="kx-map" data-variant={variant} data-compact={compact || undefined} ref={box}>
      {variant !== "paper" && data && (
        <div className="kx-map-bar">
          <div className="kx-map-legend" role="group" aria-label="Kinds shown">
            {MAP_ORDER.filter((k) => counts.get(k)).map((k) => (
              <button
                key={k}
                className="kx-map-kind"
                data-kind={k}
                aria-pressed={!hidden.has(k)}
                title={hidden.has(k) ? `Show ${MAP_LABEL[k][1].toLowerCase()}` : `Hide ${MAP_LABEL[k][1].toLowerCase()}`}
                onClick={() => {
                  const next = new Set(hidden);
                  if (next.has(k)) next.delete(k);
                  else next.add(k);
                  setHidden(next);
                  save({ kinds: MAP_ORDER.filter((x) => !next.has(x)) });
                }}
              >
                <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden>
                  <Shape kind={k} r={4} />
                </svg>
                {MAP_LABEL[k][1]}
                {!!data.more[k] && <small>+{data.more[k]}</small>}
              </button>
            ))}
          </div>
          <span className="kx-spacer" />
          {maxCount > 1 && (
            <label className="kx-map-strength" title="Only what shares at least this many sources">
              <span>At least</span>
              <input
                type="range"
                min={1}
                max={Math.min(maxCount, 20)}
                value={Math.min(minCount, maxCount)}
                onChange={(e) => setMinCount(Number(e.target.value))}
                onPointerUp={() => save({ minCount })}
                onKeyUp={() => save({ minCount })}
                aria-label="Fewest shared sources"
              />
              <output>{Math.min(minCount, maxCount)}</output>
            </label>
          )}
          <div className="kx-map-caps" role="radiogroup" aria-label="How many of each">
            {CAPS.map((n) => (
              <button
                key={n}
                role="radio"
                aria-checked={cap === n}
                title={`Up to ${n} of each`}
                onClick={() => {
                  setCap(n);
                  save({ cap: n });
                }}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="kx-map-stage" style={{ height } as CSSProperties} onPointerLeave={() => setHover(undefined)}>
          {trail.length > 0 && (
            <button className="kx-map-back" onClick={() => setTrail((t) => t.slice(0, -1))} title={`Back to ${(trail.at(-2) ?? origin).name}`}>
              <Icon name="arrowLeft" size={12} />
              <span>{truncate((trail.at(-2) ?? origin).name, 22)}</span>
            </button>
          )}
        {data === null && <p className="kx-map-empty">This is no longer in the library.</p>}
        {data && !data.nodes.length && <p className="kx-map-empty">Nothing in the library relates to it yet. Topics, people and journals appear as sources are looked up.</p>}
        {layout && data && !!data.nodes.length && (
          <svg className="kx-map-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label={`How ${data.center.name} relates to the rest of the library`} data-hovering={hover ? "" : undefined}>
            <g className="kx-map-spokes">
              {spokes.map((n) => (
                <path
                  key={n.key}
                  data-kind={n.kind}
                  data-dim={(neighbours && !neighbours.has(n.key)) || undefined}
                  style={{ d: `path("M${layout.cx} ${layout.cy}L${n.x.toFixed(1)} ${n.y.toFixed(1)}")`, strokeWidth: 0.6 + 2.2 * n.strength, strokeOpacity: 0.16 + 0.3 * n.strength } as CSSProperties}
                />
              ))}
            </g>
            <g className="kx-map-links">
              {hoverLinks.map((l) => {
                const a = byKey.get(l.a);
                const b = byKey.get(l.b);
                if (!a || !b) return null;
                return <path key={`${l.a}|${l.b}`} d={arc(a, b, layout.cx, layout.cy)} data-kind={(hover === l.a ? b : a).kind} data-lit={hover ? "" : undefined} style={{ strokeWidth: 0.7 + 2 * l.strength } as CSSProperties} />;
              })}
            </g>
            <g className="kx-map-nodes">
              {all.map((entry) => {
                if (entry.center) {
                  const label = truncate(data.center.name, compact ? 30 : 38);
                  return (
                    <g key={entry.key} className="kx-map-node kx-map-center" data-kind={data.center.kind} style={{ transform: `translate(${layout.cx}px, ${layout.cy}px)` }}>
                      <circle className="kx-map-halo" r={layout.centerR + 7} />
                      <circle className="kx-map-shape" r={layout.centerR} />
                      <foreignObject x={-7} y={-7} width={14} height={14} aria-hidden>
                        <Icon name={KIND_ICON[data.center.kind]} size={14} className="kx-map-center-icon" />
                      </foreignObject>
                      <text y={layout.centerR + 17} textAnchor="middle" className="kx-map-center-label">
                        {label}
                        <title>{data.center.name}</title>
                      </text>
                    </g>
                  );
                }
                const n = entry.node;
                const anchor = labelAnchor(n.dx);
                const lx = n.dx * (n.r + 5);
                const ly = anchor === "middle" ? (n.dy > 0 ? n.r + 10 : -(n.r + 9)) : n.dy * (n.r + 3);
                const dim = neighbours && !neighbours.has(n.key);
                return (
                  <g
                    key={n.key}
                    className="kx-map-node"
                    data-kind={n.kind}
                    data-dim={dim || undefined}
                    data-lit={hover === n.key || undefined}
                    data-label={n.showLabel || hover === n.key || (neighbours?.has(n.key) ?? false) || undefined}
                    style={{ transform: `translate(${n.x.toFixed(1)}px, ${n.y.toFixed(1)}px)` }}
                    role="button"
                    tabIndex={0}
                    aria-label={`${n.name}, ${MAP_LABEL[n.kind][0].toLowerCase()}, ${n.kind === "source" ? n.detail : `${n.count} ${n.count === 1 ? "source" : "sources"}`}`}
                    onPointerEnter={() => setHover(n.key)}
                    onFocus={() => setHover(n.key)}
                    onBlur={() => setHover(undefined)}
                    onClick={onClick(n)}
                    onContextMenu={onContext(n)}
                    onKeyDown={onKey(n)}
                  >
                    <circle className="kx-map-hit" r={Math.max(12, n.r + 6)} />
                    <Shape kind={n.kind} r={n.r} />
                    <text x={lx} y={ly} textAnchor={anchor} dominantBaseline="middle" className="kx-map-label">
                      {n.label}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        )}
        {data === undefined && visible && <div className="kx-map-loading" aria-busy="true" />}
      </div>
      {data && !!data.nodes.length && (
        <p className="kx-map-caption" aria-live="polite">
          {caption}
        </p>
      )}
      {choice && (
        <EntityPopover
          entity={{ kind: (choice.node.kind === "field" ? "topic" : choice.node.kind) as EntityRef["kind"], id: choice.node.id, name: choice.node.name }}
          anchor={choice.el}
          onClose={() => setChoice(undefined)}
          extra={{ label: "Centre map here", icon: "circle", run: () => recenter(choice.node) }}
        />
      )}
    </div>
  );
}

const PAPER_OPEN = "key.paper-map.open";
/** A source's own small map, folded under its references until asked for (remembered). */
export function PaperRelations({ invoke, workspaceId, sourceId, title }: { invoke: Invoke; workspaceId: string; sourceId: string; title: string }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(PAPER_OPEN) === "1";
    } catch {
      return false;
    }
  });
  return (
    <details
      className="kx-page-section kx-map-section"
      aria-label="Relations"
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        try {
          localStorage.setItem(PAPER_OPEN, next ? "1" : "0");
        } catch {
          // Not remembered; it opens folded next time.
        }
      }}
    >
      <summary>
        <Icon name="chevronRight" size={12} className="kx-map-chevron" />
        <h3>Relations</h3>
      </summary>
      {open && <RelationMap invoke={invoke} workspaceId={workspaceId} center={{ kind: "source", id: sourceId, name: title }} variant="paper" />}
    </details>
  );
}
