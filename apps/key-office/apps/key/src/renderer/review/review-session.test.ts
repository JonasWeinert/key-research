import { describe, expect, it } from "vitest";
import { afterDecision, counter, current, finishesOnPick, mergeQueue, missing, onChoice, showRecord, startSession, step, toggle } from "./review-session";

describe("screening session counter", () => {
  it("counts through the session's list, not what is left", () => {
    let s = startSession(["a", "b", "c", "d"]);
    expect(counter(s)).toEqual({ position: 1, total: 4, done: false });
    // a is decided: the live queue loses it, the counter moves on to 2 of 4.
    s = afterDecision(s, ["b", "c", "d"]);
    expect(current(s)).toBe("b");
    expect(counter(s)).toEqual({ position: 2, total: 4, done: false });
    s = afterDecision(s, ["c", "d"]);
    expect(counter(s).position).toBe(3);
  });

  it("goes back to decided records and forward again consistently", () => {
    let s = startSession(["a", "b", "c"]);
    s = afterDecision(s, ["b", "c"]);
    s = step(s, -1);
    expect(current(s)).toBe("a");
    expect(counter(s).position).toBe(1);
    s = step(s, 1);
    expect(current(s)).toBe("b");
    // Re-deciding a (already decided) goes on to the next still waiting.
    s = step(s, -1);
    s = afterDecision(s, ["b", "c"]);
    expect(current(s)).toBe("b");
  });

  it("undo shows the record where it was", () => {
    let s = startSession(["a", "b", "c"]);
    s = afterDecision(s, ["b", "c"]);
    s = afterDecision(s, ["c"]);
    s = showRecord(s, "b");
    expect(counter(s)).toEqual({ position: 2, total: 3, done: false });
  });

  it("ends after the last, and returns to skipped ones first", () => {
    let s = startSession(["a", "b"]);
    s = step(s, 1); // skip a
    s = afterDecision(s, ["a"]);
    expect(current(s)).toBe("a");
    s = afterDecision(s, []);
    expect(counter(s).done).toBe(true);
  });

  it("adds new records at the end without moving the rest", () => {
    let s = startSession(["a", "b"]);
    s = mergeQueue(s, ["b", "x"]);
    expect(s.order).toEqual(["a", "b", "x"]);
    expect(current(s)).toBe("a");
  });

  it("opens a focused record first", () => {
    const s = startSession(["a", "b"], "z");
    expect(current(s)).toBe("z");
    expect(counter(s).total).toBe(3);
  });
});

describe("decision steps", () => {
  it("asks for the criterion by the rule", () => {
    expect(onChoice("none", "exclude", 3, [], "")).toBe("commit");
    expect(onChoice("first", "exclude", 3, [], "")).toBe("pick");
    expect(onChoice("first", "exclude", 3, ["c1"], "")).toBe("commit");
    expect(onChoice("first", "exclude", 3, [], "Not in English")).toBe("commit");
    expect(onChoice("first", "exclude", 3, ["c1", "c2"], "")).toBe("pick");
    expect(onChoice("all", "maybe", 3, [], "")).toBe("pick");
    expect(onChoice("all", "maybe", 3, ["c1", "c2"], "")).toBe("commit");
    expect(onChoice("all", "include", 3, [], "")).toBe("commit");
    // No criteria yet: nothing to choose.
    expect(onChoice("first", "exclude", 0, [], "")).toBe("commit");
    expect(missing("first", 3, ["a"], "x")).toMatch(/Choose one/);
  });

  it("toggles numbers: one for first, many for all", () => {
    expect(toggle("first", ["a"], "b")).toEqual(["b"]);
    expect(toggle("all", ["a"], "b")).toEqual(["a", "b"]);
    expect(toggle("all", ["a", "b"], "a")).toEqual(["b"]);
    expect(finishesOnPick("first", true)).toBe(true);
    expect(finishesOnPick("first", false)).toBe(false);
    expect(finishesOnPick("all", true)).toBe(false);
  });
});
