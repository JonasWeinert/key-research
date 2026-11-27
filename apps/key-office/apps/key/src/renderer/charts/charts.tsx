// Small SVG charts shared across Key: horizontal bars, a histogram, a forest plot and a funnel
// plot. They draw with theme tokens (light and dark follow the app) and export through
// charts/export.ts with a fixed print palette. Each takes plain numbers: the analysis that
// makes them lives in Rust.
//
//   <BarChart items={[{ label: "Wrong population", value: 12 }]} />
//   <Histogram values={years} />
//   <ForestPlot rows={rows} log nullValue={1} axisLabel="Risk ratio" favours={["Favours A", "Favours B"]} />
//   <FunnelPlot points={[{ estimate: -0.3, se: 0.2 }]} center={-0.4} />
import { forwardRef, useId, type CSSProperties } from "react";
import { binValues, formatNumber, formatTick, scale } from "./scale";
import "./charts.css";

const ink = (token: string): CSSProperties => ({ fill: `var(${token})` });
const stroke = (token: string, width = 1, dash?: string): CSSProperties => ({ stroke: `var(${token})`, strokeWidth: width, fill: "none", ...(dash ? { strokeDasharray: dash } : {}) });
const FONT_SIZE = 11;
/** Rough text width for layout (SVG has no measuring before paint). */
const textWidth = (text: string, size = FONT_SIZE) => text.length * size * 0.56;
const clip = (text: string, max: number) => (textWidth(text) <= max ? text : `${text.slice(0, Math.max(1, Math.floor(max / (FONT_SIZE * 0.56)) - 1))}…`);

export type Tone = "accent" | "green" | "red" | "amber" | "muted" | "indigo";
const TONE: Record<Tone, string> = { accent: "--kx-accent", green: "--kx-green", red: "--kx-red", amber: "--kx-amber", muted: "--kx-text-3", indigo: "--kx-indigo" };

// ── Bars ─────────────────────────────────────────────────────────────────────────────

export interface BarItem {
  label: string;
  value: number;
  tone?: Tone;
  title?: string;
}

/** Horizontal bars with their labels and values, largest scale at `max` (default: the largest value). */
export const BarChart = forwardRef<SVGSVGElement, { items: BarItem[]; width?: number; barHeight?: number; max?: number; label: string; valueFormat?: (v: number) => string }>(function BarChart(
  { items, width = 420, barHeight = 18, max, label, valueFormat = (v) => v.toLocaleString() },
  ref,
) {
  const labelWidth = Math.min(width * 0.45, Math.max(60, ...items.map((i) => textWidth(i.label) + 8)));
  const valueWidth = Math.max(28, ...items.map((i) => textWidth(valueFormat(i.value)) + 8));
  const plot = Math.max(40, width - labelWidth - valueWidth);
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  const gap = 6;
  const height = items.length * (barHeight + gap) + gap;
  return (
    <svg ref={ref} className="kx-chart" viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={label}>
      {items.map((item, i) => {
        const y = gap + i * (barHeight + gap);
        const w = Math.max(item.value > 0 ? 2 : 0, (item.value / top) * plot);
        return (
          <g key={`${item.label}-${i}`}>
            {item.title && <title>{item.title}</title>}
            <text x={labelWidth - 8} y={y + barHeight / 2} textAnchor="end" dominantBaseline="central" style={ink("--kx-text-2")} fontSize={FONT_SIZE}>
              {clip(item.label, labelWidth - 10)}
            </text>
            <rect x={labelWidth} y={y} width={plot} height={barHeight} rx={4} style={ink("--kx-fill")} />
            <rect x={labelWidth} y={y} width={w} height={barHeight} rx={4} style={ink(TONE[item.tone ?? "accent"])} />
            <text x={labelWidth + plot + 6} y={y + barHeight / 2} dominantBaseline="central" style={ink("--kx-text-3")} fontSize={FONT_SIZE}>
              {valueFormat(item.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
});

// ── Histogram ────────────────────────────────────────────────────────────────────────

/** Vertical bars over equal-width bins of `values` (or ready `bins`). */
export const Histogram = forwardRef<SVGSVGElement, { values?: number[]; bins?: { from: number; to: number; count: number }[]; binCount?: number; width?: number; height?: number; label: string; tone?: Tone; /** How bin edges read (years: as they are). */ binFormat?: (v: number) => string }>(function Histogram(
  { values = [], bins, binCount, width = 320, height = 120, label, tone = "accent", binFormat = formatTick },
  ref,
) {
  const data = bins ?? binValues(values, binCount);
  const pad = { left: 28, right: 8, top: 8, bottom: 20 };
  const top = Math.max(1, ...data.map((b) => b.count));
  const y = scale([0, top], [height - pad.bottom, pad.top], { ticks: 3 });
  const barWidth = data.length ? (width - pad.left - pad.right) / data.length : 0;
  return (
    <svg ref={ref} className="kx-chart" viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={label}>
      {/* Bins hold counts: whole-number ticks only (no "0.5 sources"). */}
      {y.ticks.filter((t) => Number.isInteger(t)).map((t) => (
        <g key={t}>
          <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} style={stroke("--kx-line-content")} />
          <text x={pad.left - 4} y={y(t)} textAnchor="end" dominantBaseline="central" fontSize={10} style={ink("--kx-text-3")}>
            {formatTick(t)}
          </text>
        </g>
      ))}
      {data.map((b, i) => (
        <rect key={i} x={pad.left + i * barWidth + 1} y={y(b.count)} width={Math.max(1, barWidth - 2)} height={Math.max(0, y(0) - y(b.count))} rx={2} style={ink(TONE[tone])}>
          <title>{`${b.from === b.to ? binFormat(b.from) : `${binFormat(b.from)}–${binFormat(b.to)}`}: ${b.count}`}</title>
        </rect>
      ))}
      {data.length > 0 && (
        <>
          <text x={pad.left} y={height - 6} fontSize={10} style={ink("--kx-text-3")}>
            {binFormat(data[0].from)}
          </text>
          <text x={width - pad.right} y={height - 6} textAnchor="end" fontSize={10} style={ink("--kx-text-3")}>
            {binFormat(data[data.length - 1].to)}
          </text>
        </>
      )}
    </svg>
  );
});

// ── Forest plot ──────────────────────────────────────────────────────────────────────

export interface ForestRow {
  id: string;
  label: string;
  /** On the scale the axis shows (ratios as ratios when `log`). */
  estimate?: number | null;
  lower?: number | null;
  upper?: number | null;
  /** Percent weight (squares are sized by it). */
  weight?: number | null;
  /** study (square), summary or subtotal (diamond), prediction (dashed line), heading (text only). */
  kind?: "study" | "summary" | "subtotal" | "prediction" | "heading";
  /** Extra columns before the plot (events/total, mean (SD) n …). */
  columns?: string[];
  /** A note under a summary row (heterogeneity). */
  note?: string;
}

export interface ForestPlotProps {
  rows: ForestRow[];
  /** Headers of `columns`. */
  columnHeaders?: string[];
  /** A ratio measure, drawn on the log scale. */
  log?: boolean;
  nullValue?: number;
  axisLabel?: string;
  favours?: [string, string];
  width?: number;
  digits?: number;
  label?: string;
  /** Limits of the axis; default: the intervals'. */
  domain?: [number, number];
}

const ROW = 20;

/** Studies' estimates with their intervals, and pooled diamonds, on one axis. */
export const ForestPlot = forwardRef<SVGSVGElement, ForestPlotProps>(function ForestPlot(
  { rows, columnHeaders = [], log = false, nullValue = log ? 1 : 0, axisLabel, favours, width = 760, digits = 2, label = "Forest plot", domain },
  ref,
) {
  const clipId = useId().replace(/:/g, "");
  const studyWidth = Math.min(220, Math.max(110, ...rows.map((r) => textWidth(r.label) + 12)));
  const colWidths = columnHeaders.map((h, i) => Math.max(textWidth(h) + 14, ...rows.map((r) => textWidth(r.columns?.[i] ?? "") + 14)));
  const estWidth = Math.max(textWidth("Estimate [95% CI]") + 12, ...rows.map((r) => textWidth(estimateText(r, digits)) + 12));
  const weightWidth = rows.some((r) => r.weight != null) ? 56 : 0;
  const fixed = studyWidth + colWidths.reduce((a, b) => a + b, 0) + estWidth + weightWidth;
  const plotWidth = Math.max(160, width - fixed - 16);
  const plotLeft = studyWidth + colWidths.reduce((a, b) => a + b, 0) + 8;
  const values = rows.flatMap((r) => [r.lower, r.upper, r.estimate]).filter((v): v is number => v != null && Number.isFinite(v) && (!log || v > 0));
  let lo = domain?.[0] ?? Math.min(nullValue, ...values);
  let hi = domain?.[1] ?? Math.max(nullValue, ...values);
  if (!values.length) [lo, hi] = log ? [0.5, 2] : [-1, 1];
  if (log) {
    // Keep the axis readable: at most four decades.
    lo = Math.max(lo, hi / 1e4);
  }
  const x = scale([lo, hi], [plotLeft, plotLeft + plotWidth], { log, ticks: 5 });
  const header = 26;
  const bodyRows = rows.reduce((n, r) => n + (r.note ? 2 : 1), 0);
  const axisY = header + bodyRows * ROW + 8;
  const height = axisY + (axisLabel || favours ? 44 : 26);
  const maxWeight = Math.max(1, ...rows.map((r) => (r.kind ?? "study") === "study" ? (r.weight ?? 0) : 0));
  const clamp = (v: number) => Math.min(plotLeft + plotWidth, Math.max(plotLeft, x(v)));
  let line = 0;
  return (
    <svg ref={ref} className="kx-chart kx-forest" viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={label}>
      <defs>
        <clipPath id={clipId}>
          <rect x={plotLeft} y={0} width={plotWidth} height={height} />
        </clipPath>
      </defs>
      <g fontSize={FONT_SIZE} fontWeight={600} style={ink("--kx-text-2")}>
        <text x={0} y={16}>Study</text>
        {columnHeaders.map((h, i) => (
          <text key={h} x={studyWidth + colWidths.slice(0, i + 1).reduce((a, b) => a + b, 0) - 8} y={16} textAnchor="end">
            {h}
          </text>
        ))}
        <text x={plotLeft + plotWidth + 8 + estWidth - 4} y={16} textAnchor="end">
          Estimate [95% CI]
        </text>
        {weightWidth > 0 && (
          <text x={width - 4} y={16} textAnchor="end">
            Weight
          </text>
        )}
      </g>
      <line x1={0} x2={width} y1={header - 4} y2={header - 4} style={stroke("--kx-line")} />
      <line x1={x(nullValue)} x2={x(nullValue)} y1={header} y2={axisY} style={stroke("--kx-line-strong")} />
      {rows.map((row) => {
        const y = header + line * ROW + ROW / 2;
        line += row.note ? 2 : 1;
        const kind = row.kind ?? "study";
        const has = row.estimate != null && Number.isFinite(row.estimate) && (!log || row.estimate > 0);
        const bold = kind === "summary" || kind === "subtotal" || kind === "heading";
        return (
          <g key={row.id} data-kind={kind}>
            <text x={kind === "study" ? 0 : 0} y={y} dominantBaseline="central" fontSize={FONT_SIZE} fontWeight={bold ? 600 : 400} fontStyle={kind === "prediction" ? "italic" : undefined} style={ink(kind === "prediction" ? "--kx-text-3" : "--kx-text")}>
              {clip(row.label, studyWidth - 8)}
            </text>
            {row.columns?.map((c, i) => (
              <text key={i} x={studyWidth + colWidths.slice(0, i + 1).reduce((a, b) => a + b, 0) - 8} y={y} textAnchor="end" dominantBaseline="central" fontSize={FONT_SIZE} style={ink("--kx-text-2")}>
                {c}
              </text>
            ))}
            {has && (
              <g clipPath={`url(#${clipId})`}>
                {kind === "study" && (
                  <>
                    <line x1={clamp(row.lower ?? row.estimate!)} x2={clamp(row.upper ?? row.estimate!)} y1={y} y2={y} style={stroke("--kx-text-2", 1.2)} />
                    {(() => {
                      const side = 4 + 8 * Math.sqrt((row.weight ?? maxWeight / 2) / maxWeight);
                      return <rect x={x(row.estimate!) - side / 2} y={y - side / 2} width={side} height={side} style={ink("--kx-accent")} />;
                    })()}
                  </>
                )}
                {(kind === "summary" || kind === "subtotal") && row.lower != null && row.upper != null && (
                  <polygon
                    points={`${clamp(row.lower)},${y} ${x(row.estimate!)},${y - 6} ${clamp(row.upper)},${y} ${x(row.estimate!)},${y + 6}`}
                    style={{ ...ink(kind === "summary" ? "--kx-text" : "--kx-text-2"), stroke: "none" }}
                  />
                )}
                {kind === "prediction" && row.lower != null && row.upper != null && <line x1={clamp(row.lower)} x2={clamp(row.upper)} y1={y} y2={y} style={stroke("--kx-text-3", 1.5, "4 3")} />}
              </g>
            )}
            {kind !== "heading" && (
              <text x={plotLeft + plotWidth + 8 + estWidth - 4} y={y} textAnchor="end" dominantBaseline="central" fontSize={FONT_SIZE} fontWeight={bold ? 600 : 400} style={ink("--kx-text-2")} className="kx-chart-num">
                {estimateText(row, digits)}
              </text>
            )}
            {weightWidth > 0 && row.weight != null && kind !== "heading" && (
              <text x={width - 4} y={y} textAnchor="end" dominantBaseline="central" fontSize={FONT_SIZE} style={ink("--kx-text-3")} className="kx-chart-num">
                {`${row.weight.toFixed(1)}%`}
              </text>
            )}
            {row.note && (
              <text x={0} y={y + ROW} dominantBaseline="central" fontSize={10} style={ink("--kx-text-3")}>
                {row.note}
              </text>
            )}
          </g>
        );
      })}
      <line x1={plotLeft} x2={plotLeft + plotWidth} y1={axisY} y2={axisY} style={stroke("--kx-line-strong")} />
      {x.ticks
        .filter((t) => t >= x.domain[0] - 1e-9 && t <= x.domain[1] + 1e-9)
        .map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={axisY} y2={axisY + 4} style={stroke("--kx-line-strong")} />
            <text x={x(t)} y={axisY + 14} textAnchor="middle" fontSize={10} style={ink("--kx-text-3")}>
              {formatTick(t)}
            </text>
          </g>
        ))}
      {favours && (
        <g fontSize={10} style={ink("--kx-text-3")}>
          <text x={x(nullValue) - 6} y={axisY + 28} textAnchor="end">
            {favours[0]}
          </text>
          <text x={x(nullValue) + 6} y={axisY + 28}>
            {favours[1]}
          </text>
        </g>
      )}
      {axisLabel && (
        <text x={plotLeft + plotWidth / 2} y={axisY + (favours ? 40 : 28)} textAnchor="middle" fontSize={10} style={ink("--kx-text-2")}>
          {axisLabel}
        </text>
      )}
    </svg>
  );
});

function estimateText(row: ForestRow, digits: number) {
  if (row.kind === "heading") return "";
  if (row.estimate == null || !Number.isFinite(row.estimate)) return row.kind === "prediction" && row.lower != null ? `[${formatNumber(row.lower, digits)}, ${formatNumber(row.upper, digits)}]` : "–";
  return `${formatNumber(row.estimate, digits)} [${formatNumber(row.lower, digits)}, ${formatNumber(row.upper, digits)}]`;
}

// ── Funnel plot ──────────────────────────────────────────────────────────────────────

export interface FunnelPoint {
  /** On the analysis scale (log ratios for ratio measures). */
  estimate: number;
  se: number;
  label?: string;
}

/** Each study's estimate against its standard error (0 at the top), with the pooled estimate
 * and its pseudo 95% confidence region. `tickFormat` shows the axis on the outcome's scale
 * (e.g. `Math.exp` for ratios). */
export const FunnelPlot = forwardRef<SVGSVGElement, { points: FunnelPoint[]; center: number; width?: number; height?: number; axisLabel?: string; tickFormat?: (v: number) => string; label?: string }>(function FunnelPlot(
  { points, center, width = 420, height = 300, axisLabel, tickFormat = formatTick, label = "Funnel plot" },
  ref,
) {
  const pad = { left: 44, right: 12, top: 12, bottom: axisLabel ? 40 : 26 };
  const maxSe = Math.max(0.01, ...points.map((p) => p.se)) * 1.1;
  const spread = 1.96 * maxSe;
  const xs = points.map((p) => p.estimate);
  const lo = Math.min(center - spread, ...xs),
    hi = Math.max(center + spread, ...xs);
  const x = scale([lo, hi], [pad.left, width - pad.right], { ticks: 5 });
  const y = scale([0, maxSe], [pad.top, height - pad.bottom], { ticks: 4, nice: false });
  return (
    <svg ref={ref} className="kx-chart kx-funnel" viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={label}>
      <polygon points={`${x(center)},${y(0)} ${x(center - spread)},${y(maxSe)} ${x(center + spread)},${y(maxSe)}`} style={{ ...ink("--kx-fill"), stroke: "none" }} />
      <line x1={x(center)} x2={x(center - spread)} y1={y(0)} y2={y(maxSe)} style={stroke("--kx-line-strong", 1, "4 3")} />
      <line x1={x(center)} x2={x(center + spread)} y1={y(0)} y2={y(maxSe)} style={stroke("--kx-line-strong", 1, "4 3")} />
      <line x1={x(center)} x2={x(center)} y1={y(0)} y2={y(maxSe)} style={stroke("--kx-text-3")} />
      {y.ticks.map((t) => (
        <g key={t}>
          <text x={pad.left - 6} y={y(t)} textAnchor="end" dominantBaseline="central" fontSize={10} style={ink("--kx-text-3")}>
            {formatTick(t)}
          </text>
        </g>
      ))}
      <text x={12} y={(pad.top + height - pad.bottom) / 2} transform={`rotate(-90 12 ${(pad.top + height - pad.bottom) / 2})`} textAnchor="middle" fontSize={10} style={ink("--kx-text-2")}>
        Standard error
      </text>
      <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} style={stroke("--kx-line-strong")} />
      {x.ticks.map((t) => (
        <text key={t} x={x(t)} y={height - pad.bottom + 14} textAnchor="middle" fontSize={10} style={ink("--kx-text-3")}>
          {tickFormat(t)}
        </text>
      ))}
      {axisLabel && (
        <text x={(pad.left + width - pad.right) / 2} y={height - 6} textAnchor="middle" fontSize={10} style={ink("--kx-text-2")}>
          {axisLabel}
        </text>
      )}
      {points.map((p, i) => (
        <circle key={i} cx={x(p.estimate)} cy={y(Math.min(p.se, maxSe))} r={4} style={{ ...ink("--kx-accent"), stroke: "var(--kx-bg)", strokeWidth: 1 }}>
          {p.label && <title>{p.label}</title>}
        </circle>
      ))}
    </svg>
  );
});

// ── std-D: scatter, bubble and contour-enhanced funnel plots ───────────────────────────

export interface ScatterPoint {
  x: number;
  y: number;
  label?: string;
  /** Relative size (bubble plots: percent weight). */
  size?: number;
  tone?: Tone;
  /** Drawn hollow (imputed studies). */
  hollow?: boolean;
}

interface XYProps {
  points: ScatterPoint[];
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
  label: string;
  /** Label points whose `label` is set and that lie beyond this share of the ranges (Baujat). */
  labelOutliers?: boolean;
  /** A fitted line with its band (bubble plots). */
  line?: { x: number; fit: number; lower: number; upper: number }[];
  /** A horizontal reference line. */
  yRef?: number;
  yFormat?: (v: number) => string;
}

/** Points on two axes, optionally sized by weight, with a fitted line and band. */
export const ScatterPlot = forwardRef<SVGSVGElement, XYProps>(function ScatterPlot({ points, width = 420, height = 280, xLabel, yLabel, label, labelOutliers, line, yRef, yFormat = formatTick }, ref) {
  const pad = { left: 48, right: 14, top: 12, bottom: xLabel ? 40 : 26 };
  const xs = [...points.map((p) => p.x), ...(line ?? []).map((l) => l.x)];
  const ys = [...points.map((p) => p.y), ...(line ?? []).flatMap((l) => [l.lower, l.upper]), ...(yRef != null ? [yRef] : [])];
  const pad5 = (lo: number, hi: number) => (hi > lo ? [lo - (hi - lo) * 0.05, hi + (hi - lo) * 0.05] : [lo - 1, hi + 1]) as [number, number];
  const x = scale(pad5(Math.min(...xs), Math.max(...xs)), [pad.left, width - pad.right], { ticks: 5 });
  const y = scale(pad5(Math.min(...ys), Math.max(...ys)), [height - pad.bottom, pad.top], { ticks: 4 });
  const maxSize = Math.max(1, ...points.map((p) => p.size ?? 0));
  const radius = (p: ScatterPoint) => (p.size != null ? 3 + 9 * Math.sqrt(p.size / maxSize) : 4);
  const [x0, x1] = x.domain;
  const [y0, y1] = y.domain;
  return (
    <svg ref={ref} className="kx-chart kx-scatter" viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={label}>
      {y.ticks.map((t) => (
        <g key={`y${t}`}>
          <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} style={stroke("--kx-line-content")} />
          <text x={pad.left - 6} y={y(t)} textAnchor="end" dominantBaseline="central" fontSize={10} style={ink("--kx-text-3")}>
            {yFormat(t)}
          </text>
        </g>
      ))}
      {x.ticks.map((t) => (
        <text key={`x${t}`} x={x(t)} y={height - pad.bottom + 14} textAnchor="middle" fontSize={10} style={ink("--kx-text-3")}>
          {formatTick(t)}
        </text>
      ))}
      <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} style={stroke("--kx-line-strong")} />
      {yRef != null && <line x1={pad.left} x2={width - pad.right} y1={y(yRef)} y2={y(yRef)} style={stroke("--kx-line-strong", 1, "4 3")} />}
      {line && line.length > 1 && (
        <>
          <polygon points={[...line.map((l) => `${x(l.x)},${y(l.upper)}`), ...[...line].reverse().map((l) => `${x(l.x)},${y(l.lower)}`)].join(" ")} style={{ ...ink("--kx-accent-soft"), stroke: "none", opacity: 0.8 }} />
          <polyline points={line.map((l) => `${x(l.x)},${y(l.fit)}`).join(" ")} style={stroke("--kx-accent", 1.5)} />
        </>
      )}
      {points.map((p, i) => {
        const near = labelOutliers && p.label && (p.x - x0) / (x1 - x0 || 1) < 0.6 && (p.y - y0) / (y1 - y0 || 1) < 0.6;
        return (
          <g key={i}>
            <circle cx={x(p.x)} cy={y(p.y)} r={radius(p)} style={p.hollow ? { fill: "var(--kx-bg)", stroke: `var(${TONE[p.tone ?? "accent"]})`, strokeWidth: 1.5 } : { ...ink(TONE[p.tone ?? "accent"]), stroke: "var(--kx-bg)", strokeWidth: 1, opacity: p.size != null ? 0.75 : 1 }}>
              {p.label && <title>{p.label}</title>}
            </circle>
            {labelOutliers && p.label && !near && (
              <text x={x(p.x) + radius(p) + 3} y={y(p.y)} dominantBaseline="central" fontSize={10} style={ink("--kx-text-2")}>
                {clip(p.label, 120)}
              </text>
            )}
          </g>
        );
      })}
      {xLabel && (
        <text x={(pad.left + width - pad.right) / 2} y={height - 6} textAnchor="middle" fontSize={10} style={ink("--kx-text-2")}>
          {xLabel}
        </text>
      )}
      {yLabel && (
        <text x={12} y={(pad.top + height - pad.bottom) / 2} transform={`rotate(-90 12 ${(pad.top + height - pad.bottom) / 2})`} textAnchor="middle" fontSize={10} style={ink("--kx-text-2")}>
          {yLabel}
        </text>
      )}
    </svg>
  );
});

/** A funnel centred on no effect with the regions where a study would be significant at
 * p < .10, .05 and .01 shaded (Peters et al. 2008); imputed studies (trim and fill) hollow. */
export const ContourFunnel = forwardRef<SVGSVGElement, { points: FunnelPoint[]; filled?: FunnelPoint[]; nullValue?: number; adjusted?: number; width?: number; height?: number; axisLabel?: string; tickFormat?: (v: number) => string; label?: string }>(function ContourFunnel(
  { points, filled = [], nullValue = 0, adjusted, width = 420, height = 300, axisLabel, tickFormat = formatTick, label = "Contour-enhanced funnel plot" },
  ref,
) {
  const pad = { left: 44, right: 12, top: 12, bottom: axisLabel ? 52 : 38 };
  const all = [...points, ...filled];
  const maxSe = Math.max(0.01, ...all.map((p) => p.se)) * 1.08;
  const z = [1.645, 1.96, 2.576];
  const reach = z[2] * maxSe;
  const lo = Math.min(nullValue - reach, ...all.map((p) => p.estimate)),
    hi = Math.max(nullValue + reach, ...all.map((p) => p.estimate));
  const x = scale([lo, hi], [pad.left, width - pad.right], { ticks: 5 });
  const y = scale([0, maxSe], [pad.top, height - pad.bottom], { ticks: 4, nice: false });
  const wedge = (zz: number) => `${x(nullValue)},${y(0)} ${x(nullValue - zz * maxSe)},${y(maxSe)} ${x(nullValue + zz * maxSe)},${y(maxSe)}`;
  const bands: [string, string][] = [
    ["--kx-fill-2", "p < 0.01"],
    ["--kx-fill", "0.01 – 0.05"],
    ["--kx-bg-sunken", "0.05 – 0.10"],
  ];
  return (
    <svg ref={ref} className="kx-chart kx-funnel" viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={label}>
      <rect x={pad.left} y={pad.top} width={width - pad.left - pad.right} height={height - pad.top - pad.bottom} style={{ ...ink("--kx-fill-2"), stroke: "none" }} />
      <polygon points={wedge(z[2])} style={{ ...ink("--kx-fill"), stroke: "none" }} />
      <polygon points={wedge(z[1])} style={{ ...ink("--kx-bg-sunken"), stroke: "none" }} />
      <polygon points={wedge(z[0])} style={{ ...ink("--kx-bg"), stroke: "none" }} />
      <line x1={x(nullValue)} x2={x(nullValue)} y1={y(0)} y2={y(maxSe)} style={stroke("--kx-line-strong")} />
      {adjusted != null && <line x1={x(adjusted)} x2={x(adjusted)} y1={y(0)} y2={y(maxSe)} style={stroke("--kx-accent", 1, "4 3")} />}
      {y.ticks.map((t) => (
        <text key={t} x={pad.left - 6} y={y(t)} textAnchor="end" dominantBaseline="central" fontSize={10} style={ink("--kx-text-3")}>
          {formatTick(t)}
        </text>
      ))}
      <text x={12} y={(pad.top + height - pad.bottom) / 2} transform={`rotate(-90 12 ${(pad.top + height - pad.bottom) / 2})`} textAnchor="middle" fontSize={10} style={ink("--kx-text-2")}>
        Standard error
      </text>
      <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} style={stroke("--kx-line-strong")} />
      {x.ticks.map((t) => (
        <text key={t} x={x(t)} y={height - pad.bottom + 14} textAnchor="middle" fontSize={10} style={ink("--kx-text-3")}>
          {tickFormat(t)}
        </text>
      ))}
      {axisLabel && (
        <text x={(pad.left + width - pad.right) / 2} y={height - pad.bottom + 28} textAnchor="middle" fontSize={10} style={ink("--kx-text-2")}>
          {axisLabel}
        </text>
      )}
      <g fontSize={10} style={ink("--kx-text-3")}>
        {bands.map(([tone, text], i) => (
          <g key={text} transform={`translate(${pad.left + i * 96}, ${height - 12})`}>
            <rect x={0} y={-8} width={10} height={10} rx={2} style={{ ...ink(tone), stroke: "var(--kx-line-strong)", strokeWidth: 0.5 }} />
            <text x={14} y={0}>
              {text}
            </text>
          </g>
        ))}
      </g>
      {filled.map((p, i) => (
        <circle key={`f${i}`} cx={x(p.estimate)} cy={y(Math.min(p.se, maxSe))} r={4} style={{ fill: "var(--kx-bg)", stroke: "var(--kx-text-3)", strokeWidth: 1.5 }}>
          <title>Imputed by trim and fill</title>
        </circle>
      ))}
      {points.map((p, i) => (
        <circle key={i} cx={x(p.estimate)} cy={y(Math.min(p.se, maxSe))} r={4} style={{ ...ink("--kx-accent"), stroke: "var(--kx-bg)", strokeWidth: 1 }}>
          {p.label && <title>{p.label}</title>}
        </circle>
      ))}
    </svg>
  );
});
// std-D end.
