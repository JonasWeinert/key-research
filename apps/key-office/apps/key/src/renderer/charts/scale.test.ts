import { describe, expect, it } from "vitest";
import { binValues, formatTick, logTicks, niceTicks, scale } from "./scale";
import { printColors } from "./export";

describe("chart scales", () => {
  it("picks round ticks", () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(-1.3, 0.4, 4)).toEqual([-1, -0.5, 0]);
    expect(niceTicks(3, 3)).toEqual([3]);
  });
  it("maps linear and log domains", () => {
    const x = scale([0, 10], [0, 100]);
    expect(x(5)).toBe(50);
    const l = scale([0.1, 10], [0, 200], { log: true });
    expect(l(1)).toBeCloseTo(100);
    expect(logTicks(0.1, 10)).toEqual([0.1, 0.2, 0.5, 1, 2, 5, 10]);
  });
  it("bins values and formats ticks", () => {
    const bins = binValues([1, 2, 2, 3, 4, 10], 3);
    expect(bins.map((b) => b.count)).toEqual([4, 1, 1]);
    expect(formatTick(0.25)).toBe("0.25");
    expect(formatTick(1200)).toBe("1200");
  });
  it("exports with print colours", () => {
    expect(printColors('style="fill: var(--kx-text)"')).toBe('style="fill: #1d1d1f"');
    expect(printColors("var(--unknown, #123456)")).toBe("#123456");
  });
});
