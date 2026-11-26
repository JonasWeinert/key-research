// Where a relation map's nodes go: the centre in the middle, each kind in its own sector
// around it (in a fixed order, sized by how many it shows), the strongest of a kind in the
// middle of its sector and nearest the centre. Deterministic and computed once per change,
// so nothing moves unless the data or the size does; labels that would collide give way to
// stronger ones (they show on hover).
import type { MapKind, MapNode, RelationMapData } from "./library-api";

export const MAP_ORDER: readonly MapKind[] = ["topic", "field", "person", "venue", "tag", "collection", "source"];
export const MAP_LABEL: Record<MapKind, [string, string]> = {
  topic: ["Topic", "Topics"],
  field: ["Field", "Fields"],
  person: ["Person", "People"],
  venue: ["Journal", "Journals"],
  tag: ["Tag", "Tags"],
  collection: ["Collection", "Collections"],
  source: ["Source", "Related sources"],
};

/** `topic:T1`; a field is a topic too (it centres as one). */
export const nodeKey = (node: Pick<MapNode, "kind" | "id">) => `${node.kind === "field" ? "topic" : node.kind}:${node.id}`;
/** The map's link ends name kinds as the store does (`field:…`). */
const linkKey = (node: Pick<MapNode, "kind" | "id">) => `${node.kind}:${node.id}`;

export interface PlacedNode extends MapNode {
  key: string;
  x: number;
  y: number;
  r: number;
  /** -1…1: which way its label reads out from the centre. */
  dx: number;
  dy: number;
  label: string;
  showLabel: boolean;
  /** 0…1 of the strongest shown. */
  strength: number;
}
export interface PlacedLink {
  a: string;
  b: string;
  weight: number;
  strength: number;
}
export interface Layout {
  width: number;
  height: number;
  cx: number;
  cy: number;
  centerR: number;
  nodes: PlacedNode[];
  links: PlacedLink[];
}

export interface LayoutOptions {
  width: number;
  height: number;
  kinds: ReadonlySet<MapKind>;
  /** Shared sources a node needs to be shown. */
  minCount: number;
  compact?: boolean;
}

const CHAR = 6.15;
const MAX_LABEL = 26;
export const truncate = (text: string, max = MAX_LABEL) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function layoutMap(data: RelationMapData, options: LayoutOptions): Layout {
  const { width, height, compact } = options;
  const cx = width / 2;
  const cy = height / 2;
  const centerR = compact ? 15 : 19;
  const shown = data.nodes.filter((n) => options.kinds.has(n.kind) && (n.kind === "source" || n.count >= options.minCount));
  const groups = MAP_ORDER.map((kind) => shown.filter((n) => n.kind === kind)).filter((g) => g.length);
  const max = Math.max(1, ...shown.map((n) => n.count));
  const total = shown.length;
  // Two arcs, right and left of the centre, so every label reads outward on its own row.
  // The kinds go round clockwise (down the right, up the left) with a blank row between
  // kinds, split between the sides where a kind ends nearest the middle.
  const sorted = groups.map((g) => [...g].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)));
  const rows = total + Math.max(0, groups.length - 1);
  let split = sorted.length;
  let best = Infinity;
  for (let i = 1, used = 0; i <= sorted.length; i++) {
    used += sorted[i - 1].length + (i > 1 ? 1 : 0);
    const off = Math.abs(used - rows / 2);
    if (off < best && i < sorted.length) {
      best = off;
      split = i;
    }
  }
  if (sorted.length === 1) split = 1;
  const sides = [sorted.slice(0, split), sorted.slice(split)];
  // One kind alone is shared out over both sides.
  if (sorted.length === 1 && sorted[0].length > 1) {
    const half = Math.ceil(sorted[0].length / 2);
    sides[0] = [sorted[0].slice(0, half)];
    sides[1] = [sorted[0].slice(half)];
  }
  const rx = Math.max(70, width / 2 - (compact ? 120 : 160));
  const margin = compact ? 18 : 24;
  const nodes: PlacedNode[] = [];
  sides.forEach((side, s) => {
    const list: (MapNode | null)[] = side.flatMap((g, i) => (i ? [null, ...g] : g));
    if (!list.length) return;
    const step = list.length > 1 ? Math.min(compact ? 22 : 26, (height - 2 * margin) / (list.length - 1)) : 0;
    const top = cy - (step * (list.length - 1)) / 2;
    const ry = Math.max(40, (step * (list.length - 1)) / 2 + 30);
    const dir = s === 0 ? 1 : -1;
    // The left side runs bottom to top, so the kinds continue round.
    const ordered = s === 0 ? list : [...list].reverse();
    ordered.forEach((node, i) => {
      if (!node) return;
      const y = top + i * step;
      const strength = node.kind === "source" ? 0.5 + 0.5 * (node.count / Math.max(1, ...shown.filter((n) => n.kind === "source").map((g) => g.count))) : node.count / max;
      const arcWidth = rx * Math.sqrt(Math.max(0.2, 1 - ((y - cy) / ry) ** 2));
      // Stronger nearer the centre.
      const reach = 0.5 + 0.5 * (1 - Math.sqrt(strength));
      const x = cx + dir * Math.max(centerR + 36, arcWidth * reach);
      const r = (compact ? 3.5 : 4) + (compact ? 4 : 6) * Math.sqrt(strength);
      nodes.push({ ...node, key: nodeKey(node), x, y, r, dx: dir, dy: 0, label: truncate(node.name, compact ? 22 : MAX_LABEL), showLabel: true, strength });
    });
  });
  // Labels: strongest first; one that overlaps a placed label (or the centre's) hides.
  const boxes: [number, number, number, number][] = [labelBox(cx, cy + centerR + 6, 0, 1, truncate(data.center.name, 34), 12.5)];
  for (const node of [...nodes].sort((a, b) => b.strength - a.strength)) {
    const box = labelBox(node.x, node.y, node.dx, node.dy, node.label, 11.5, node.r);
    const clash = boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
    const outside = box[0] < 2 || box[2] > width - 2 || box[1] < 2 || box[3] > height - 2;
    node.showLabel = !clash && !outside;
    if (node.showLabel) boxes.push(box);
  }
  const keys = new Map(shown.map((n) => [linkKey(n), nodeKey(n)]));
  const placed = data.links.filter((l) => keys.has(l.a) && keys.has(l.b));
  const top = Math.max(1, ...placed.map((l) => l.weight));
  const links = placed.map((l) => ({ a: keys.get(l.a)!, b: keys.get(l.b)!, weight: l.weight, strength: l.weight / top }));
  return { width, height, cx, cy, centerR, nodes, links };
}

/** [left, top, right, bottom] of a label read outward from its node. */
export function labelBox(x: number, y: number, dx: number, dy: number, text: string, size: number, r = 0): [number, number, number, number] {
  const w = text.length * CHAR * (size / 11.5) + 4;
  const h = size + 4;
  const anchor = labelAnchor(dx);
  const lx = x + dx * (r + 5);
  const ly = y + (anchor === "middle" ? (dy > 0 ? r + h / 2 + 2 : -(r + h / 2 + 2)) : dy * (r + 3));
  const left = anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2;
  return [left, ly - h / 2, left + w, ly + h / 2];
}
export const labelAnchor = (dx: number): "start" | "end" | "middle" => (dx > 0.28 ? "start" : dx < -0.28 ? "end" : "middle");

/** A soft curve between two nodes, bowed toward the centre. */
export function arc(a: { x: number; y: number }, b: { x: number; y: number }, cx: number, cy: number) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const qx = mx + (cx - mx) * 0.45;
  const qy = my + (cy - my) * 0.45;
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)}Q${qx.toFixed(1)} ${qy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}
