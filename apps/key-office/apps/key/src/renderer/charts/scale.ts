// Scales and ticks for the small SVG charts (charts/*.tsx). Pure functions, no DOM.

export interface Scale {
  (value: number): number;
  domain: [number, number];
  range: [number, number];
  ticks: number[];
  log: boolean;
}

/** About `count` round tick values covering [lo, hi] (1, 2, 2.5 or 5 times a power of ten). */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (lo === hi) return [lo];
  if (lo > hi) [lo, hi] = [hi, lo];
  const raw = (hi - lo) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const start = Math.ceil(lo / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** Ticks for a ratio axis drawn on the log scale: 0.1, 0.2, 0.5, 1, 2, 5, 10 … within [lo, hi]. */
export function logTicks(lo: number, hi: number): number[] {
  if (!(lo > 0) || !(hi > 0)) return [];
  const out: number[] = [];
  for (let p = Math.floor(Math.log10(lo)) - 1; p <= Math.ceil(Math.log10(hi)) + 1; p++)
    for (const m of [1, 2, 5]) {
      const v = Number((m * 10 ** p).toPrecision(6));
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
    }
  // A narrow range shows too few: fall back to linear ticks on the ratio.
  return out.length >= 3 ? out : niceTicks(lo, hi, 4).filter((v) => v > 0);
}

/** Maps [d0, d1] onto [r0, r1]; with `log`, the domain is in ratio units and drawn on log10. */
export function scale(domain: [number, number], range: [number, number], { log = false, ticks = 5, nice = true }: { log?: boolean; ticks?: number; nice?: boolean } = {}): Scale {
  let [d0, d1] = domain;
  if (d0 === d1) {
    d0 -= log ? d0 / 2 : 1;
    d1 += log ? d1 : 1;
  }
  if (log && nice && d0 > 0 && d1 > 0) {
    // Out to the nearest 1, 2 or 5 times a power of ten, so the axis has round ticks.
    const steps = (p: number) => [1, 2, 5].map((m) => m * 10 ** p);
    const p0 = Math.floor(Math.log10(d0)),
      p1 = Math.floor(Math.log10(d1));
    d0 = [...steps(p0 - 1), ...steps(p0)].filter((v) => v <= d0 * 1.0001).at(-1) ?? d0;
    d1 = [...steps(p1), ...steps(p1 + 1)].find((v) => v >= d1 * 0.9999) ?? d1;
  }
  let tickValues = log ? logTicks(d0, d1) : niceTicks(d0, d1, ticks);
  if (nice && !log && tickValues.length) {
    d0 = Math.min(d0, tickValues[0]);
    d1 = Math.max(d1, tickValues[tickValues.length - 1]);
    tickValues = niceTicks(d0, d1, ticks);
  }
  const t = (v: number) => (log ? Math.log10(Math.max(v, 1e-12)) : v);
  const a = t(d0),
    b = t(d1);
  const [r0, r1] = range;
  const f = ((v: number) => r0 + ((t(v) - a) / (b - a || 1)) * (r1 - r0)) as Scale;
  f.domain = [d0, d1];
  f.range = range;
  f.ticks = tickValues;
  f.log = log;
  return f;
}

/** A tick label: short, without trailing zeros. */
export function formatTick(v: number): string {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 10000 || abs < 0.001) return v.toExponential(0);
  return String(Number(v.toPrecision(3)));
}

/** A number for a table cell: `digits` decimals. */
export function formatNumber(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "–";
  return v.toFixed(digits);
}

/** Equal-width bins over the values (Sturges' rule unless `bins` is given). */
export function binValues(values: number[], bins?: number): { from: number; to: number; count: number }[] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [];
  const lo = Math.min(...finite),
    hi = Math.max(...finite);
  const n = Math.max(1, bins ?? Math.ceil(Math.log2(finite.length) + 1));
  if (lo === hi) return [{ from: lo, to: hi, count: finite.length }];
  const width = (hi - lo) / n;
  const out = Array.from({ length: n }, (_, i) => ({ from: lo + i * width, to: lo + (i + 1) * width, count: 0 }));
  for (const v of finite) out[Math.min(n - 1, Math.floor((v - lo) / width))].count++;
  return out;
}
