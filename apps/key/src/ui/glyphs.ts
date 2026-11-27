// Key's icon set, shared by the shell and the reader. Drawn for Key on a 16-unit grid:
// live area 1..15, one stroke weight (1.4 at 16px, optically adjusted per size), round caps
// and joins, container corners r 1.75–2.25, outer frames on quarter positions (2.25 / 13.75)
// so they land on device pixels at 2x. `s` is stroked, `f` filled (evenodd), `on` the filled
// variant for selected or active states.
export interface Glyph {
  s?: string;
  f?: string;
  on?: { s?: string; f?: string };
}

type P = [number, number];
const n = (v: number) => String(Math.round(v * 100) / 100);
const pt = ([x, y]: P) => `${n(x)} ${n(y)}`;

/** Rounded rectangle. */
const rr = (x: number, y: number, w: number, h: number, r: number) =>
  `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}V${n(y + h - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`;
/** Circle. */
const ci = (cx: number, cy: number, r: number) =>
  `M${n(cx - r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx + r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx - r)} ${n(cy)}Z`;
/** Polygon with every corner rounded by `r` (quadratic corners, so it stays tiny). */
const poly = (pts: P[], r: number, closed = true) => {
  const out: string[] = [];
  const len = pts.length;
  const corner = (i: number) => {
    const p = pts[i];
    const a = pts[(i - 1 + len) % len];
    const b = pts[(i + 1) % len];
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const db = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const ta = Math.min(r / da, 0.5);
    const tb = Math.min(r / db, 0.5);
    return {
      in: [p[0] + (a[0] - p[0]) * ta, p[1] + (a[1] - p[1]) * ta] as P,
      out: [p[0] + (b[0] - p[0]) * tb, p[1] + (b[1] - p[1]) * tb] as P,
      p,
    };
  };
  if (!closed) {
    out.push(`M${pt(pts[0])}`);
    for (let i = 1; i < len - 1; i++) {
      const c = corner(i);
      out.push(`L${pt(c.in)}Q${pt(c.p)} ${pt(c.out)}`);
    }
    out.push(`L${pt(pts[len - 1])}`);
    return out.join("");
  }
  const first = corner(0);
  out.push(`M${pt(first.out)}`);
  for (let i = 1; i <= len; i++) {
    const c = corner(i % len);
    out.push(`L${pt(c.in)}Q${pt(c.p)} ${pt(c.out)}`);
  }
  return out.join("") + "Z";
};
/** Star with `k` points. */
const star = (cx: number, cy: number, ro: number, ri: number, k: number, r: number) =>
  poly(
    Array.from({ length: k * 2 }, (_, i): P => {
      const a = -Math.PI / 2 + (i * Math.PI) / k;
      const rad = i % 2 ? ri : ro;
      return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
    }),
    r,
  );
/** Gear outline: `k` flat-topped teeth. */
const gear = (cx: number, cy: number, ro: number, ri: number, k: number) => {
  const pts: P[] = [];
  const step = (Math.PI * 2) / k;
  for (let i = 0; i < k; i++) {
    const a = i * step - Math.PI / 2;
    for (const [da, rad] of [[-0.3, ri], [-0.17, ro], [0.17, ro], [0.3, ri]] as const)
      pts.push([cx + rad * Math.cos(a + da * step * 1.6), cy + rad * Math.sin(a + da * step * 1.6)]);
  }
  return poly(pts, 0.45);
};
/** Four-pointed sparkle with softly concave sides. */
const spark = (cx: number, cy: number, r: number) => {
  const k = r * 0.16;
  return `M${n(cx)} ${n(cy - r)}Q${n(cx + k)} ${n(cy - k)} ${n(cx + r)} ${n(cy)}Q${n(cx + k)} ${n(cy + k)} ${n(cx)} ${n(cy + r)}Q${n(cx - k)} ${n(cy + k)} ${n(cx - r)} ${n(cy)}Q${n(cx - k)} ${n(cy - k)} ${n(cx)} ${n(cy - r)}Z`;
};
/** Stadium between two centres. */
const capsule = ([x1, y1]: P, [x2, y2]: P, r: number) => {
  const l = Math.hypot(x2 - x1, y2 - y1);
  const nx = (-(y2 - y1) / l) * r;
  const ny = ((x2 - x1) / l) * r;
  return `M${n(x1 + nx)} ${n(y1 + ny)}L${n(x2 + nx)} ${n(y2 + ny)}A${n(r)} ${n(r)} 0 0 0 ${n(x2 - nx)} ${n(y2 - ny)}L${n(x1 - nx)} ${n(y1 - ny)}A${n(r)} ${n(r)} 0 0 0 ${n(x1 + nx)} ${n(y1 + ny)}Z`;
};
/** Segment from circle a to circle b, trimmed by their radii plus a gap. */
const seg = ([ax, ay]: P, ra: number, [bx, by]: P, rb: number) => {
  const l = Math.hypot(bx - ax, by - ay);
  const ux = (bx - ax) / l;
  const uy = (by - ay) / l;
  return `M${n(ax + ux * ra)} ${n(ay + uy * ra)}L${n(bx - ux * rb)} ${n(by - uy * rb)}`;
};

// Shared bodies.
const PAGE = "M4.75 1.75H9.5L12.75 5V12.75C12.75 13.58 12.08 14.25 11.25 14.25H4.75C3.92 14.25 3.25 13.58 3.25 12.75V3.25C3.25 2.42 3.92 1.75 4.75 1.75Z";
const FOLD = "M9.25 1.75V4.25C9.25 4.8 9.7 5.25 10.25 5.25H12.75";
const WINDOW = rr(1.75, 2.75, 12.5, 10.5, 2.25);
const RING = ci(8, 8, 5.75);
const LENS = ci(7, 7, 4.5) + "M10.3 10.3 13.5 13.5";
const STAR = star(8, 8.4, 6.1, 2.65, 5, 0.75);
const BOOKMARK = "M4.25 3.5C4.25 2.81 4.81 2.25 5.5 2.25H10.5C11.19 2.25 11.75 2.81 11.75 3.5V13.75L8 11 4.25 13.75Z";
const TAG = poly([[2, 8], [5.6, 3.25], [13.75, 3.25], [13.75, 12.75], [5.6, 12.75]], 1.5);
const TAG_HOLE = ci(6.4, 8, 1.05);
const BUBBLE = "M3.75 2.75H12.25C13.08 2.75 13.75 3.42 13.75 4.25V10.25C13.75 11.08 13.08 11.75 12.25 11.75H7.75L4.75 14V11.75H3.75C2.92 11.75 2.25 11.08 2.25 10.25V4.25C2.25 3.42 2.92 2.75 3.75 2.75Z";
const FOLDER = "M2.25 4.5C2.25 3.81 2.81 3.25 3.5 3.25H6.05C6.4 3.25 6.73 3.4 6.97 3.66L8.1 4.9H12.5C13.19 4.9 13.75 5.46 13.75 6.15V12.25C13.75 12.94 13.19 13.5 12.5 13.5H3.5C2.81 13.5 2.25 12.94 2.25 12.25Z";
const PERSON_HEAD = ci(8, 5.25, 2.6);
const PERSON_BODY = "M3.1 13.1C3.1 10.95 5.25 9.5 8 9.5S12.9 10.95 12.9 13.1C12.9 13.47 12.62 13.75 12.25 13.75H3.75C3.38 13.75 3.1 13.47 3.1 13.1Z";
const STACK = rr(2.25, 5.75, 11.5, 8, 1.75) + "M3.9 3.8H12.1M5.6 1.9H10.4";
const HOUSE = "M8 2.85 4.1 6.15V12.5C4.1 13.19 4.66 13.75 5.35 13.75H6.75V10.75H9.25V13.75H10.65C11.34 13.75 11.9 13.19 11.9 12.5V6.15Z";
const TRIANGLE = poly([[8, 2.25], [14.2, 13.25], [1.8, 13.25]], 1.4);
const PIN = poly([[5.25, 2.25], [10.75, 2.25], [9.6, 3.4], [9.6, 6], [11.75, 8.9], [4.25, 8.9], [6.4, 6], [6.4, 3.4]], 0.6);
const HEART = "M8 13.4C5.4 11.6 2.25 9.3 2.25 6.2 2.25 4.3 3.7 2.85 5.45 2.85 6.6 2.85 7.5 3.45 8 4.3 8.5 3.45 9.4 2.85 10.55 2.85 12.3 2.85 13.75 4.3 13.75 6.2 13.75 9.3 10.6 11.6 8 13.4Z";
const PLAY = poly([[5, 2.9], [13.1, 8], [5, 13.1]], 1.2);
const REL: [P, number][] = [[[8, 8.25], 1.85], [[3.6, 3.6], 1.3], [[12.4, 4.25], 1.3], [[4.6, 12.75], 1.3], [[12.5, 12.25], 1.3]];

const page = (inner: string, f?: string): Glyph => ({ s: PAGE + FOLD + inner, f });

export const glyphs = {
  // Actions
  plus: { s: "M8 3.25V12.75M3.25 8H12.75" },
  minus: { s: "M3.25 8H12.75" },
  close: { s: "M4.25 4.25 11.75 11.75M11.75 4.25 4.25 11.75" },
  check: { s: "M3.25 8.4 6.4 11.5 12.75 4.6" },
  search: { s: LENS },
  zoomIn: { s: LENS + "M5 7H9M7 5V9" },
  zoomOut: { s: LENS + "M5 7H9" },
  more: { f: ci(3.5, 8, 1.15) + ci(8, 8, 1.15) + ci(12.5, 8, 1.15) },
  grip: { f: ci(6, 4, 0.95) + ci(10, 4, 0.95) + ci(6, 8, 0.95) + ci(10, 8, 0.95) + ci(6, 12, 0.95) + ci(10, 12, 0.95) },
  copy: { s: rr(5.25, 5.25, 8.5, 8.5, 1.75) + "M10.75 2.25H4C3.03 2.25 2.25 3.03 2.25 4V10.75" },
  trash: { s: "M2.75 4.25H13.25M6 4.25V3.1C6 2.63 6.38 2.25 6.85 2.25H9.15C9.62 2.25 10 2.63 10 3.1V4.25M4 4.25 4.66 12.55C4.72 13.24 5.3 13.75 5.99 13.75H10.01C10.7 13.75 11.28 13.24 11.34 12.55L12 4.25M6.75 6.75V11.25M9.25 6.75V11.25" },
  pen: { s: "M10.4 2.85C11.07 2.18 12.15 2.18 12.82 2.85L13.15 3.18C13.82 3.85 13.82 4.93 13.15 5.6L5.6 13.15 2.25 13.75 2.85 10.4ZM9.25 4 12 6.75" },
  highlight: { s: poly([[10.2, 2.3], [13.7, 5.8], [8.6, 10.9], [5.1, 7.4]], 0.75) + "M5.1 7.4 4 10.8 3 11.8 4.2 13 5.2 12 8.6 10.9M9.75 13.75H13.75" },
  text: { s: "M3.5 3.5H12.5M8 3.5V12.75M6.25 12.75H9.75" },
  link: { s: capsule([4.6, 11.4], [7.1, 8.9], 2.2) + capsule([8.9, 7.1], [11.4, 4.6], 2.2) },
  external: { s: "M7 3.25H4.75C3.92 3.25 3.25 3.92 3.25 4.75V11.25C3.25 12.08 3.92 12.75 4.75 12.75H11.25C12.08 12.75 12.75 12.08 12.75 11.25V9M9.5 2.75H13.25V6.5M13.25 2.75 7.75 8.25" },
  upload: { s: "M8 10.25V2.75M5.25 5.5 8 2.75 10.75 5.5M2.75 9.75V12.25C2.75 13.08 3.42 13.75 4.25 13.75H11.75C12.58 13.75 13.25 13.08 13.25 12.25V9.75" },
  download: { s: "M8 2.75V10.25M5.25 7.5 8 10.25 10.75 7.5M2.75 9.75V12.25C2.75 13.08 3.42 13.75 4.25 13.75H11.75C12.58 13.75 13.25 13.08 13.25 12.25V9.75" },
  retry: { s: "M13.25 8A5.25 5.25 0 1 1 11.6 4.2M11.9 1.9V4.5H9.3" },
  sync: { s: "M12.8 6.5A5 5 0 0 0 3.6 5.3M3.2 9.5A5 5 0 0 0 12.4 10.7M3.25 2.6V5.4H6M12.75 13.4V10.6H10" },
  undo: { s: "M5.75 3.25 3 6 5.75 8.75M3 6H9.5A3.75 3.75 0 0 1 9.5 13.5H7.5" },
  redo: { s: "M10.25 3.25 13 6 10.25 8.75M13 6H6.5A3.75 3.75 0 0 0 6.5 13.5H8.5" },
  swap: { s: "M2.75 5.5H12.25M9.75 3 12.25 5.5 9.75 8M13.25 10.5H3.75M6.25 8 3.75 10.5 6.25 13" },
  filter: { s: "M2.75 4.5H13.25M4.75 8H11.25M6.75 11.5H9.25" },
  sort: { s: "M5 2.75V13.25M2.6 10.85 5 13.25 7.4 10.85M11 13.25V2.75M8.6 5.15 11 2.75 13.4 5.15" },
  pause: { s: "M5.75 3.75V12.25M10.25 3.75V12.25" },
  play: { s: PLAY, f: PLAY },
  sparkle: { s: spark(6.75, 9, 5) + spark(12.25, 3.75, 1.9), on: { s: spark(6.75, 9, 5) + spark(12.25, 3.75, 1.9), f: spark(6.75, 9, 5) + spark(12.25, 3.75, 1.9) } },
  fitWidth: { s: "M2.25 3V13M13.75 3V13M5 8H11M6.75 6.25 5 8 6.75 9.75M9.25 6.25 11 8 9.25 9.75" },
  expand: { s: "M9.5 2.75H13.25V6.5M13.25 2.75 9.25 6.75M6.5 13.25H2.75V9.5M2.75 13.25 6.75 9.25" },
  collapse: { s: "M13.25 6.75H9.25V2.75M9.25 6.75 13.5 2.5M2.75 9.25H6.75V13.25M6.75 9.25 2.5 13.5" },
  cursor: { s: poly([[4, 2.5], [12.4, 9.1], [8.4, 9.5], [6.1, 13.1]], 0.6) },
  hand: { s: "M5.25 8.6V3.9A1.05 1.05 0 0 1 7.35 3.9V7.4M7.35 7V2.95A1.05 1.05 0 0 1 9.45 2.95V7M9.45 7.2V3.9A1.05 1.05 0 0 1 11.55 3.9V9.4C11.55 11.9 9.9 13.6 7.65 13.6 6.1 13.6 5.1 12.9 4.3 11.7L2.55 9.05A1.05 1.05 0 0 1 4.15 7.7L5.25 8.85" },
  square: { s: rr(2.75, 2.75, 10.5, 10.5, 1.75) },
  circle: { s: ci(8, 8, 5.25) },
  connector: { s: "M3.25 12.75 12.25 3.75M7.75 3.25H12.75V8.25" },
  group: { s: "M2.25 4.25V3.25C2.25 2.7 2.7 2.25 3.25 2.25H4.25M11.75 2.25H12.75C13.3 2.25 13.75 2.7 13.75 3.25V4.25M13.75 11.75V12.75C13.75 13.3 13.3 13.75 12.75 13.75H11.75M4.25 13.75H3.25C2.7 13.75 2.25 13.3 2.25 12.75V11.75" + rr(4.75, 4.75, 4, 4, 0.75) + rr(7.25, 7.25, 4, 4, 0.75) },
  function: { s: "M11 2.9C9.6 2.4 8.4 3 8.1 4.6L6.9 11.4C6.6 13 5.4 13.6 4 13.1M5.25 6.75H10.25" },
  // Navigation
  chevronRight: { s: "M6 3.5 10.5 8 6 12.5" },
  chevronLeft: { s: "M10 3.5 5.5 8 10 12.5" },
  chevronDown: { s: "M3.5 6 8 10.5 12.5 6" },
  chevronUp: { s: "M3.5 10 8 5.5 12.5 10" },
  chevronUpDown: { s: "M5 6.25 8 3.25 11 6.25M5 9.75 8 12.75 11 9.75" },
  arrowRight: { s: "M2.75 8H13.25M9 3.75 13.25 8 9 12.25" },
  arrowLeft: { s: "M13.25 8H2.75M7 3.75 2.75 8 7 12.25" },
  // Windows and panes
  sidebar: { s: WINDOW + "M6 2.75V13.25", on: { s: WINDOW + "M6 2.75V13.25", f: "M6 2.75H4C2.76 2.75 1.75 3.76 1.75 5V11C1.75 12.24 2.76 13.25 4 13.25H6Z" } },
  panelRight: { s: WINDOW + "M10 2.75V13.25", on: { s: WINDOW + "M10 2.75V13.25", f: "M10 2.75H12C13.24 2.75 14.25 3.76 14.25 5V11C14.25 12.24 13.24 13.25 12 13.25H10Z" } },
  split: { s: WINDOW + "M8 2.75V13.25" },
  columns: { s: WINDOW + "M6 2.75V13.25M10 2.75V13.25" },
  tabs: { s: WINDOW + "M1.75 6.25H14.25M7.25 2.75V6.25" },
  windows: { s: rr(5.25, 2.25, 8.5, 7.5, 1.75) + "M5.25 4.9H13.75M5.25 6.75H3.75C2.92 6.75 2.25 7.42 2.25 8.25V12.25C2.25 13.08 2.92 13.75 3.75 13.75H9.75C10.58 13.75 11.25 13.08 11.25 12.25V9.75" },
  detach: { s: rr(2.25, 5.25, 8.5, 8.5, 1.75) + "M2.25 7.9H10.75M9.5 2.25H13.75V6.5M13.75 2.25 10.9 5.1" },
  display: { s: rr(1.75, 2.75, 12.5, 8.5, 1.75) + "M8 11.25V13.75M5.25 13.75H10.75" },
  // Content and files
  doc: page("M5.75 8.25H10.25M5.75 10.75H8.75"),
  filePdf: page("M5.75 7.75H10.25", rr(5, 9.5, 6, 2.75, 0.75)),
  fileDoc: page("M5.75 7.5H10.25M5.75 9.5H10.25M5.75 11.5H8.5"),
  fileSheet: page(rr(5.5, 7.25, 5, 4.75, 0.6) + "M5.5 9.6H10.5M8 7.25V12"),
  fileSlides: page(rr(5.25, 7.5, 5.5, 4, 0.6) + "M7.5 8.6 9.1 9.5 7.5 10.4Z"),
  fileMarkdown: page("M6.4 7.25 5.9 12.25M9.1 7.25 8.6 12.25M5 8.9H10.1M4.8 10.6H9.9"),
  fileHtml: page("M7 7.75 5.5 9.75 7 11.75M9 7.75 10.5 9.75 9 11.75"),
  note: { s: rr(2.25, 2.25, 11.5, 11.5, 2.25) + "M5 5.75H11M5 8.25H11M5 10.75H8.5" },
  canvas: { s: rr(2.25, 2.75, 5.25, 3.75, 1) + rr(8.5, 9.5, 5.25, 3.75, 1) + "M4.9 6.5V9.6C4.9 10.6 5.6 11.4 6.6 11.4H8.5" },
  database: { s: "M2.75 4.25C2.75 3.15 5.1 2.25 8 2.25S13.25 3.15 13.25 4.25 10.9 6.25 8 6.25 2.75 5.35 2.75 4.25ZM2.75 4.25V11.75C2.75 12.85 5.1 13.75 8 13.75S13.25 12.85 13.25 11.75V4.25M2.75 8C2.75 9.1 5.1 10 8 10S13.25 9.1 13.25 8" },
  table: { s: rr(2.25, 2.75, 11.5, 10.5, 1.75) + "M2.25 6.25H13.75M2.25 9.75H13.75M6.25 6.25V13.25" },
  list: { s: "M5.75 4H13.25M5.75 8H13.25M5.75 12H13.25", f: ci(2.9, 4, 0.9) + ci(2.9, 8, 0.9) + ci(2.9, 12, 0.9) },
  grid: { s: rr(2.25, 2.25, 4.75, 4.75, 1.25) + rr(9, 2.25, 4.75, 4.75, 1.25) + rr(2.25, 9, 4.75, 4.75, 1.25) + rr(9, 9, 4.75, 4.75, 1.25) },
  image: { s: rr(2.25, 2.75, 11.5, 10.5, 1.75) + "M2.5 11.4 5.6 8.3 8.5 11.2 10.2 9.5 13.5 12.6", f: ci(10.3, 5.9, 1.1) },
  video: { s: rr(1.75, 4, 8.75, 8, 1.75) + poly([[10.5, 7.1], [14.25, 5], [14.25, 11], [10.5, 8.9]], 0.6) },
  audio: { s: "M6 12V3.75L13 2.25V10.5" + ci(4.25, 12, 1.75) + ci(11.25, 10.5, 1.75) },
  book: { s: "M8 4.25C6.4 3.15 4.4 2.75 2.25 3V12.75C4.4 12.5 6.4 12.9 8 14 9.6 12.9 11.6 12.5 13.75 12.75V3C11.6 2.75 9.6 3.15 8 4.25ZM8 4.25V14" },
  books: { s: rr(2.25, 3.25, 3, 10.5, 0.75) + rr(5.25, 2.25, 3, 11.5, 0.75) + poly([[9.35, 4.1], [11.9, 3.4], [14.25, 12.75], [11.7, 13.45]], 0.7) + "M2.25 11.25H8.25" },
  quote: { f: ci(5.05, 10.25, 2.05) + ci(10.95, 10.25, 2.05), s: "M3.05 10.25C3.05 7.5 4.3 5.4 6.6 4.4M8.95 10.25C8.95 7.5 10.2 5.4 12.5 4.4" },
  comment: { s: BUBBLE, on: { s: BUBBLE, f: BUBBLE } },
  globe: { s: RING + "M2.25 8H13.75M8 2.25C6.4 3.75 5.5 5.75 5.5 8S6.4 12.25 8 13.75C9.6 12.25 10.5 10.25 10.5 8S9.6 3.75 8 2.25Z" },
  folder: { s: FOLDER + "M2.25 6.9H13.75", on: { s: FOLDER, f: FOLDER } },
  collection: { s: STACK, on: { s: STACK, f: rr(2.25, 5.75, 11.5, 8, 1.75) } },
  layers: { s: poly([[8, 2.25], [13.75, 5.25], [8, 8.25], [2.25, 5.25]], 0.6) + "M2.25 8 8 11 13.75 8M2.25 10.75 8 13.75 13.75 10.75" },
  disk: { s: rr(2.25, 8.75, 11.5, 5, 1.5) + "M2.6 9 4.2 4.05C4.4 3.55 4.8 3.25 5.35 3.25H10.65C11.2 3.25 11.6 3.55 11.8 4.05L13.4 9", f: ci(11, 11.25, 0.8) },
  // Entities
  user: { s: PERSON_HEAD + PERSON_BODY, on: { s: PERSON_HEAD + PERSON_BODY, f: PERSON_HEAD + PERSON_BODY } },
  person: { s: PERSON_HEAD + PERSON_BODY, on: { s: PERSON_HEAD + PERSON_BODY, f: PERSON_HEAD + PERSON_BODY } },
  journal: { s: rr(3.25, 2.25, 9.5, 11.5, 1.5) + "M5.5 2.25V13.75" + rr(7.25, 4.75, 3.25, 2.25, 0.5) },
  topic: { s: ci(6, 8, 3.75) + ci(10, 8, 3.75) },
  tag: { s: TAG + TAG_HOLE, on: { s: TAG, f: TAG + TAG_HOLE } },
  hash: { s: "M6.25 2.75 5.25 13.25M10.75 2.75 9.75 13.25M3 6H13.25M2.75 10H13" },
  institution: { s: poly([[2.25, 5.5], [8, 2.25], [13.75, 5.5]], 0.6) + "M2.25 5.5H13.75M4.25 7.5V11.5M6.75 7.5V11.5M9.25 7.5V11.5M11.75 7.5V11.5M2.25 13.5H13.75" },
  relations: { s: REL.map(([c, r]) => ci(c[0], c[1], r)).join("") + REL.slice(1).map(([c, r]) => seg(REL[0][0], REL[0][1] + 0.6, c, r + 0.6)).join("") },
  zotero: { s: rr(2.25, 2.25, 11.5, 11.5, 2.5) + "M5.5 5.25H10.5L5.5 10.75H10.5" },
  // Marks and states
  star: { s: STAR, on: { s: STAR, f: STAR } },
  bookmark: { s: BOOKMARK, on: { s: BOOKMARK, f: BOOKMARK } },
  pin: { s: PIN + "M8 8.9V13.75", on: { s: PIN + "M8 8.9V13.75", f: PIN } },
  heart: { s: HEART, on: { s: HEART, f: HEART } },
  info: { s: RING + "M8 7.25V11.25", f: ci(8, 5, 0.9), on: { f: ci(8, 8, 6.45) + rr(7.3, 6.55, 1.4, 5.4, 0.7) + ci(8, 4.95, 0.95) } },
  warning: { s: TRIANGLE + "M8 6.4V9.4", f: ci(8, 11.3, 0.85), on: { s: TRIANGLE, f: TRIANGLE + rr(7.3, 5.7, 1.4, 4.4, 0.7) + ci(8, 11.4, 0.9) } },
  clock: { s: RING + "M8 4.75V8L10.25 9.5" },
  activity: { s: "M1.75 8.5H4.25L6 3.75 9.5 12.25 11.25 8.5H14.25" },
  map: { s: "M2.25 4.25 6 2.75 10 4.5 13.75 3V12L10 13.5 6 11.75 2.25 13.25ZM6 2.75V11.75M10 4.5V13.5" },
  // Settings and system
  gear: { s: gear(8, 8, 6.1, 4.6, 8) + ci(8, 8, 2) },
  sun: { s: ci(8, 8, 2.75) + Array.from({ length: 8 }, (_, i) => { const a = (i * Math.PI) / 4; return `M${n(8 + 4.6 * Math.cos(a))} ${n(8 + 4.6 * Math.sin(a))}L${n(8 + 6 * Math.cos(a))} ${n(8 + 6 * Math.sin(a))}`; }).join("") },
  moon: { s: "M13.2 9.7A5.4 5.4 0 1 1 6.3 2.8 4.4 4.4 0 0 0 13.2 9.7Z", on: { s: "M13.2 9.7A5.4 5.4 0 1 1 6.3 2.8 4.4 4.4 0 0 0 13.2 9.7Z", f: "M13.2 9.7A5.4 5.4 0 1 1 6.3 2.8 4.4 4.4 0 0 0 13.2 9.7Z" } },
  lock: { s: rr(3.25, 7, 9.5, 6.75, 1.75) + "M5.5 7V5A2.5 2.5 0 0 1 10.5 5V7M8 9.6V11.1" },
  unlock: { s: rr(3.25, 7, 9.5, 6.75, 1.75) + "M5.5 7V5A2.5 2.5 0 0 1 10.4 4.3M8 9.6V11.1" },
  key: { s: ci(5.4, 10.6, 2.75) + "M7.35 8.65 13.25 2.75M11.25 4.75 12.75 6.25M9.6 6.4 10.85 7.65" },
  chip: { s: rr(4.25, 4.25, 7.5, 7.5, 1.5) + "M6.5 2.25V4.25M9.5 2.25V4.25M6.5 11.75V13.75M9.5 11.75V13.75M2.25 6.5H4.25M2.25 9.5H4.25M11.75 6.5H13.75M11.75 9.5H13.75" },
  puzzle: { s: "M3.25 5H5.4A1.6 1.6 0 1 1 8.6 5H10.75C11.3 5 11.75 5.45 11.75 6V7.4A1.6 1.6 0 1 1 11.75 10.6V12.75C11.75 13.3 11.3 13.75 10.75 13.75H8.6A1.6 1.6 0 1 0 5.4 13.75H3.25C2.7 13.75 2.25 13.3 2.25 12.75V6C2.25 5.45 2.7 5 3.25 5Z" },
  home: { s: "M2.5 7.4 8 2.75 13.5 7.4M4.25 6V12.5C4.25 13.19 4.81 13.75 5.5 13.75H10.5C11.19 13.75 11.75 13.19 11.75 12.5V6M6.75 13.75V10.75H9.25V13.75", on: { s: "M2.5 7.4 8 2.75 13.5 7.4" + HOUSE, f: HOUSE } },
  // Feeds and alerts: the Inbox tray, a feed, an alert bell; reading status.
  inbox: { s: rr(2.25, 2.25, 11.5, 11.5, 2) + "M2.25 9H5.5L6.5 10.75H9.5L10.5 9H13.75" },
  feed: { s: "M3.25 7.25A5.5 5.5 0 0 1 8.75 12.75M3.25 3.25A9.5 9.5 0 0 1 12.75 12.75", f: ci(4, 12, 1.15) },
  bell: { s: "M4.25 11.25V7.5A3.75 3.75 0 0 1 11.75 7.5V11.25L12.75 12.25H3.25ZM6.6 13.75H9.4M8 2.25V3.75" },
  readHalf: { s: ci(8, 8, 5.75), f: "M8 2.25A5.75 5.75 0 0 1 8 13.75Z" },
  // Reading mode: the PDF as reflowed text, and its typography ("Aa").
  readingMode: { s: rr(2.25, 2.25, 11.5, 11.5, 2) + "M5 5.5H11M5 8H11M5 10.5H8.75" },
  typography: { s: "M1.75 12.75 5 3.75 8.25 12.75M2.9 9.6H7.1M10 12.75 11.85 7.75 13.75 12.75M10.55 11.25H13.2" },
  // Systematic reviews: a clipboard with ticked rows; PRISMA's flow of boxes.
  checklist: { s: rr(3.25, 3, 9.5, 10.75, 1.75) + "M6 3V2.25H10V3M5.25 6.75 6.25 7.75 7.75 6.25M9 7H11M5.25 10.25 6.25 11.25 7.75 9.75M9 10.5H11" },
  flow: { s: rr(2.25, 2.25, 5, 3, 1) + rr(8.75, 2.25, 5, 3, 1) + rr(5.5, 10.75, 5, 3, 1) + "M4.75 5.25V7.75H11.25V5.25M8 7.75V10.75" },
} satisfies Record<string, Glyph>;

export type GlyphName = keyof typeof glyphs;
