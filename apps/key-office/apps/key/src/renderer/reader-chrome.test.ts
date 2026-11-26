import { describe, expect, it } from "vitest";
import { chromeAfterScroll, type ChromeScroll } from "./reader-chrome";

const run = (tops: number[]) => tops.reduce<ChromeScroll>((state, top) => chromeAfterScroll(state, top), { away: false, lastTop: null });

describe("the reader's floating toolbar", () => {
  it("steps aside when reading down and returns when scrolling up", () => {
    expect(run([100, 200, 400]).away).toBe(true);
    expect(run([100, 400, 300]).away).toBe(false);
  });
  it("always shows near the top of the document", () => {
    expect(run([400, 600, 20]).away).toBe(false);
  });
  it("ignores small movements, so inertia tails don't make it flicker", () => {
    expect(run([100, 400, 397, 395]).away).toBe(true);
  });
});
