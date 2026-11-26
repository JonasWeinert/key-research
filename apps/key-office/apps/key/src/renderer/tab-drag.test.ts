import { describe, expect, it } from "vitest";
import { follow, moveTo, pressTab, release, shiftFor, slotFor, type DragEnvironment, type StripGeometry } from "./tab-drag";

// Four 100px tabs with 2px gaps, starting at x=10; the strip ends at y=40.
const geometry = (pinned = 0): StripGeometry => ({
  left: 10,
  right: 500,
  bottom: 40,
  pinned,
  spans: [0, 1, 2, 3].map((i) => ({ left: 10 + i * 102, width: 100 })),
});
const env: DragEnvironment = { viewport: { width: 1000, height: 800 }, lone: false, canTearOff: true };
const pressed = (origin: number, g = geometry()) =>
  pressTab({ pointerId: 1, tabId: `t${origin}`, groupId: "g", origin, start: { x: g.spans[origin].left + 50, y: 20 }, geometry: g });

describe("tab drag", () => {
  it("stays a press inside the threshold", () => {
    const drag = pressed(0);
    expect(follow(drag, 63, 22, env)).toEqual({ mode: "pressed" });
    expect(release(drag)).toEqual({ kind: "click" });
  });

  it("finds the slot by the dragged tab's middle and opens it up", () => {
    const drag = pressed(0);
    drag.phase = follow(drag, 60 + 220, 20, env);
    expect(drag.phase).toMatchObject({ mode: "reorder", slot: 2 });
    expect([1, 2, 3].map((i) => shiftFor(drag, i))).toEqual([-102, -102, 0]);
    expect(release(drag)).toEqual({ kind: "reorder", index: 2 });
  });

  it("keeps the dragged tab inside the strip", () => {
    const drag = pressed(1);
    drag.phase = follow(drag, -5 + 20, 20, env);
    expect(drag.phase).toMatchObject({ mode: "reorder", slot: 0, offset: -102 });
  });

  it("reaches the last slot when pushed against the strip's end", () => {
    const g = { ...geometry(), spans: geometry().spans.slice(0, 2) };
    const drag = pressed(0, g);
    drag.phase = follow(drag, 400, 20, env);
    expect(release(drag)).toEqual({ kind: "reorder", index: 1 });
  });

  it("keeps pinned and unpinned tabs in their own runs", () => {
    const g = geometry(2);
    expect(slotFor(g, 3, -400)).toBe(2);
    expect(slotFor(g, 0, 400)).toBe(1);
  });

  it("leaves the strip for another target, or the window", () => {
    const drag = pressed(0);
    const target = { label: "Release to move to this group", drop: { kind: "move" as const, tabId: "t0", groupId: "h", index: 0 } };
    drag.phase = follow(drag, 300, 300, { ...env, locate: () => target });
    expect(release(drag)).toEqual({ kind: "drop", drop: target.drop });
    drag.phase = follow(drag, 1200, 300, env);
    expect(release(drag)).toEqual({ kind: "tear-off" });
    drag.phase = follow(drag, 1200, 300, { ...env, lone: true });
    expect(release(drag)).toEqual({ kind: "cancel" });
  });

  it("moves an item by id", () => {
    const list = ["a", "b", "c"].map((id) => ({ id }));
    expect(moveTo(list, "a", 2).map((t) => t.id)).toEqual(["b", "c", "a"]);
    expect(moveTo(list, "c", 0).map((t) => t.id)).toEqual(["c", "a", "b"]);
  });
});
