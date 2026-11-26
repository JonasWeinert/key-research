import { describe, expect, it } from "vitest";
import { jobFraction, referencesProgress, stageLabel } from "./analysis-progress";
import type { IndexJob } from "./library-api";

const job = (patch: Partial<IndexJob>): IndexJob => ({ id: "s", title: "Paper", kind: "pdf", stage: "queued", done: 0, total: 0, ...patch });

describe("analysis progress", () => {
  it("names the layout pass and its page", () => {
    expect(stageLabel(job({ stage: "analysing", phase: "layout", done: 11, total: 30, step: 1, steps: 2 }))).toBe("Reading layout · page 12 of 30");
    expect(stageLabel(job({ stage: "analysing", phase: "layout-model", done: 0, total: 30, step: 2, steps: 2 }))).toBe("Recognising layout · page 1 of 30");
    expect(stageLabel(job({ stage: "analysing" }))).toBe("Analysing layout…");
  });
  it("splits reading over its passes, then embedding", () => {
    expect(jobFraction(job({ stage: "analysing", done: 15, total: 30, step: 1, steps: 2 }))).toBeCloseTo(0.125);
    expect(jobFraction(job({ stage: "analysing", done: 15, total: 30, step: 2, steps: 2 }))).toBeCloseTo(0.375);
    expect(jobFraction(job({ stage: "embedding", done: 5, total: 10 }))).toBeCloseTo(0.75);
  });
  it("counts reference lookups", () => {
    expect(referencesProgress({ id: "s", stage: "resolving", done: 7, total: 42 })).toEqual({ fraction: 7 / 42, label: "Looking up references · 7 of 42" });
    expect(referencesProgress({ id: "s", stage: "detecting", done: 0, total: 0 })?.fraction).toBeUndefined();
    expect(referencesProgress({ id: "s", stage: "resolving", done: 1, total: 2 }, "other")).toBeUndefined();
  });
});
