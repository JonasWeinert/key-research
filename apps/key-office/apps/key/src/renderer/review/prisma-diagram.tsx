// The PRISMA 2020 flow diagram, drawn from the review's real numbers (key-review's prisma.rs).
// The layout follows the PRISMA 2020 template for new reviews (Page et al., BMJ 2021): boxes for
// identification, screening and inclusion, exclusions to the right, and a second column for
// records found by other methods when there are any. Theme tokens on screen, print colours on
// export (charts/export.ts). While screening is under way the boxes say how far it is ("75 of
// 315", "240 still to screen", muted); the figure for publication (`final`) never shows those.
import { forwardRef, type ReactNode } from "react";
import type { Named, Prisma } from "./review-api";

const LINE = 15;
const PAD = 10;
const n = (v: number) => `(n = ${v.toLocaleString("en-GB")})`;

/** Lines of a box: wrapped to about `chars` characters. */
function wrap(text: string, chars: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > chars && line) {
      lines.push(line);
      line = w;
    } else line = (line + " " + w).trim();
  }
  if (line) lines.push(line);
  return lines;
}

interface Box {
  x: number;
  y: number;
  w: number;
  lines: { text: string; bold?: boolean; indent?: boolean; deep?: boolean; muted?: boolean }[];
}
const height = (b: Box) => b.lines.length * LINE + PAD * 2 - 3;

function BoxView({ b, tone }: { b: Box; tone?: "side" | "main" }) {
  return (
    <g>
      <rect x={b.x} y={b.y} width={b.w} height={height(b)} rx={6} style={{ fill: tone === "side" ? "var(--kx-bg-sunken)" : "var(--kx-bg-raised)", stroke: "var(--kx-line-strong)", strokeWidth: 1 }} />
      {b.lines.map((l, i) => (
        <text key={i} x={b.x + PAD + (l.deep ? 22 : l.indent ? 10 : 0)} y={b.y + PAD + 9 + i * LINE} fontSize={11.5} fontWeight={l.bold ? 600 : 400} fontStyle={l.muted ? "italic" : undefined} style={{ fill: l.muted ? "var(--kx-text-3)" : "var(--kx-text)" }}>
          {l.text}
        </text>
      ))}
    </g>
  );
}

function arrow(x1: number, y1: number, x2: number, y2: number, key: string): ReactNode {
  return <line key={key} x1={x1} y1={y1} x2={x2} y2={y2} markerEnd="url(#kx-prisma-arrow)" style={{ stroke: "var(--kx-text-2)", strokeWidth: 1.2 }} />;
}

function listLines(title: string, items: Named[], chars: number, empty?: string): Box["lines"] {
  const out: Box["lines"] = wrap(title, chars).map((t) => ({ text: t }));
  if (!items.length && empty) out.push({ text: empty, indent: true });
  for (const it of items) for (const [i, t] of wrap(`${it.name} ${n(it.count)}`, chars - 2).entries()) out.push({ text: t, indent: i === 0 ? true : true });
  return out;
}

export const PrismaDiagram = forwardRef<SVGSVGElement, { p: Prisma; final?: boolean }>(function PrismaDiagram({ p, final }, ref) {
  // Work in progress, shown on screen only.
  const wip = (count: number, what: string) => (!final && count > 0 ? [{ text: `${count.toLocaleString("en-GB")} ${what}`, indent: true, muted: true }] : []);
  const of = (done: number, pending: number) => (!final && pending > 0 ? `(n = ${done.toLocaleString("en-GB")} of ${(done + pending).toLocaleString("en-GB")})` : n(done));
  const other = p.otherMethods.length > 0;
  const unnamedHint = !final && p.unnamed > 0 ? [{ text: "Name the database in Sources", deep: true, muted: true }] : [];
  const W = 250,
    S = 230,
    gap = 40,
    left = 34;
  const aX = left,
    aSideX = aX + W + gap;
  const bX = aSideX + S + 60,
    bSideX = bX + W + gap;
  const chars = 40,
    sideChars = 36;
  // Identification
  const ident: Box = {
    x: aX,
    y: 34,
    w: W,
    lines: [
      ...wrap("Records identified from:", chars).map((t) => ({ text: t })),
      ...(p.databases.length ? [{ text: `Databases ${n(p.databases.reduce((s, d) => s + d.count, 0))}`, indent: true }] : [{ text: "Databases (n = 0)", indent: true }]),
      ...p.databases.flatMap((d) => wrap(`${d.name} ${n(d.count)}`, chars - 4).map((t) => ({ text: t, deep: true }))),
      ...unnamedHint,
      { text: `Registers ${n(p.registers.reduce((s, d) => s + d.count, 0))}`, indent: true },
      ...p.registers.flatMap((d) => wrap(`${d.name} ${n(d.count)}`, chars - 4).map((t) => ({ text: t, deep: true }))),
    ],
  };
  const removed: Box = {
    x: aSideX,
    y: ident.y,
    w: S,
    lines: [
      ...wrap("Records removed before screening:", sideChars).map((t) => ({ text: t })),
      { text: `Duplicate records ${n(p.duplicates)}`, indent: true },
      ...wrap(`Marked ineligible by automation tools ${n(p.automation)}`, sideChars - 2).map((t) => ({ text: t, indent: true })),
      ...wrap(`Removed for other reasons ${n(p.removedOther)}`, sideChars - 2).map((t) => ({ text: t, indent: true })),
    ],
  };
  const row1 = Math.max(ident.y + height(ident), removed.y + height(removed)) + 44;
  const screened: Box = { x: aX, y: row1, w: W, lines: [{ text: `Records screened ${of(p.screened, p.screeningPending)}` }, ...wip(p.screeningPending, "still to screen")] };
  const excluded: Box = { x: aSideX, y: row1, w: S, lines: [{ text: `Records excluded ${n(p.screeningExcluded)}` }] };
  const row2 = Math.max(screened.y + height(screened), excluded.y + height(excluded)) + 34;
  const sought: Box = { x: aX, y: row2, w: W, lines: wrap(`Reports sought for retrieval ${n(p.main.sought)}`, chars).map((t) => ({ text: t })) };
  const notRetrieved: Box = { x: aSideX, y: row2, w: S, lines: wrap(`Reports not retrieved ${n(p.main.notRetrieved)}`, sideChars).map((t) => ({ text: t })) };
  const row3 = Math.max(sought.y + height(sought), notRetrieved.y + height(notRetrieved)) + 34;
  const assessed: Box = { x: aX, y: row3, w: W, lines: [...wrap(`Reports assessed for eligibility ${of(p.main.assessed, p.main.pending)}`, chars).map((t) => ({ text: t })), ...wip(p.main.pending, "still to assess")] };
  const reasons: Box = { x: aSideX, y: row3, w: S, lines: listLines(`Reports excluded ${n(p.main.excluded)}`, p.main.excludedReasons, sideChars) };
  // Other methods
  // Other methods: PRISMA 2020's right-hand path has no screening box. Key screens these records
  // at title and abstract too; those it excluded there are reported under "Records identified".
  const bIdent: Box | null = other
    ? {
        x: bX,
        y: ident.y,
        w: W,
        lines: [
          ...listLines("Records identified from:", p.otherMethods, chars),
          ...(p.other.screenedOut ? wrap(`Excluded on title and abstract ${n(p.other.screenedOut)}`, chars - 2).map((t) => ({ text: t, indent: true })) : []),
          ...wip(p.other.screeningPending, "still to screen"),
        ],
      }
    : null;
  const bSought: Box | null = other ? { x: bX, y: row2, w: W, lines: wrap(`Reports sought for retrieval ${n(p.other.sought)}`, chars).map((t) => ({ text: t })) } : null;
  const bNot: Box | null = other ? { x: bSideX, y: row2, w: S, lines: wrap(`Reports not retrieved ${n(p.other.notRetrieved)}`, sideChars).map((t) => ({ text: t })) } : null;
  const bAssessed: Box | null = other ? { x: bX, y: row3, w: W, lines: [...wrap(`Reports assessed for eligibility ${of(p.other.assessed, p.other.pending)}`, chars).map((t) => ({ text: t })), ...wip(p.other.pending, "still to assess")] } : null;
  const bReasons: Box | null = other ? { x: bSideX, y: row3, w: S, lines: listLines(`Reports excluded ${n(p.other.excluded)}`, p.other.excludedReasons, sideChars) } : null;
  const row4 = Math.max(assessed.y + height(assessed), reasons.y + height(reasons), bReasons ? bReasons.y + height(bReasons) : 0) + 44;
  const included: Box = { x: aX, y: row4, w: W, lines: [{ text: `Studies included in review ${n(p.studiesIncluded)}`, bold: true }, { text: `Reports of included studies ${n(p.reportsIncluded)}` }] };
  const width = other ? bSideX + S + 12 : aSideX + S + 12;
  const total = included.y + height(included) + 16;
  const mid = (b: Box) => b.y + height(b) / 2;
  const phase = (label: string, y1: number, y2: number) => (
    <g key={label}>
      <rect x={4} y={y1} width={20} height={y2 - y1} rx={5} style={{ fill: "var(--kx-accent-soft)" }} />
      <text x={14} y={(y1 + y2) / 2} transform={`rotate(-90 14 ${(y1 + y2) / 2})`} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600} style={{ fill: "var(--kx-accent-text)" }}>
        {label}
      </text>
    </g>
  );
  const boxes = [ident, removed, screened, excluded, sought, notRetrieved, assessed, reasons, included, bIdent, bSought, bNot, bAssessed, bReasons].filter(Boolean) as Box[];
  return (
    <svg ref={ref} className="kx-chart kx-prisma" viewBox={`0 0 ${width} ${total}`} width="100%" role="img" aria-label="PRISMA 2020 flow diagram">
      <defs>
        <marker id="kx-prisma-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10Z" style={{ fill: "var(--kx-text-2)" }} />
        </marker>
      </defs>
      <text x={aX} y={20} fontSize={12} fontWeight={600} style={{ fill: "var(--kx-text-2)" }}>
        Identification of studies via databases and registers
      </text>
      {other && (
        <text x={bX} y={20} fontSize={12} fontWeight={600} style={{ fill: "var(--kx-text-2)" }}>
          Identification of studies via other methods
        </text>
      )}
      {phase("Identification", ident.y, Math.max(ident.y + height(ident), removed.y + height(removed)))}
      {phase("Screening", screened.y, Math.max(assessed.y + height(assessed), reasons.y + height(reasons)))}
      {phase("Included", included.y, included.y + height(included))}
      {boxes.map((b, i) => (
        <BoxView key={i} b={b} tone={b.x === aSideX || b.x === bSideX ? "side" : "main"} />
      ))}
      {arrow(aX + W, mid(ident), aSideX, mid(ident), "a1")}
      {arrow(aX + W / 2, ident.y + height(ident), aX + W / 2, screened.y, "a2")}
      {arrow(aX + W, mid(screened), aSideX, mid(screened), "a3")}
      {arrow(aX + W / 2, screened.y + height(screened), aX + W / 2, sought.y, "a4")}
      {arrow(aX + W, mid(sought), aSideX, mid(sought), "a5")}
      {arrow(aX + W / 2, sought.y + height(sought), aX + W / 2, assessed.y, "a6")}
      {arrow(aX + W, mid(assessed), aSideX, mid(assessed), "a7")}
      {arrow(aX + W / 2, assessed.y + height(assessed), aX + W / 2, included.y, "a8")}
      {bIdent && bSought && bNot && bAssessed && bReasons && (
        <>
          {arrow(bX + W / 2, bIdent.y + height(bIdent), bX + W / 2, bSought.y, "b1")}
          {arrow(bX + W, mid(bSought), bSideX, mid(bSought), "b2")}
          {arrow(bX + W / 2, bSought.y + height(bSought), bX + W / 2, bAssessed.y, "b3")}
          {arrow(bX + W, mid(bAssessed), bSideX, mid(bAssessed), "b4")}
          <polyline points={`${bX + W / 2},${bAssessed.y + height(bAssessed)} ${bX + W / 2},${mid(included)} ${aX + W},${mid(included)}`} markerEnd="url(#kx-prisma-arrow)" style={{ fill: "none", stroke: "var(--kx-text-2)", strokeWidth: 1.2 }} />
        </>
      )}
    </svg>
  );
});
