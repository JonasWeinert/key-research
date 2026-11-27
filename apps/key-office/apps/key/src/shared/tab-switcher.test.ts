import { describe, expect, it } from "vitest";
import { isSwitcherStart, rowBadge, startSwitcher, switcherKey, switcherOrder, touchMru, withoutTab, type SwitcherSession } from "./tab-switcher";

const down = (key: string, extra: Record<string, boolean> = {}) => ({ type: "keyDown", key, control: true, ...extra });

describe("tab switcher", () => {
  it("keeps tabs in most-recently-used order", () => {
    let mru: string[] = [];
    for (const id of ["a", "b", "c", "b"]) mru = touchMru(mru, id);
    expect(mru).toEqual(["b", "c", "a"]);
    expect(touchMru(mru, "d", new Set(["a", "d"]))).toEqual(["d", "a"]);
    expect(switcherOrder(["c", "a"], ["a", "b", "c", "d"])).toEqual(["c", "a", "b", "d"]);
  });

  it("starts on the previous tab, or the oldest with Shift", () => {
    expect(startSwitcher(["a", "b", "c"])?.selected).toBe(1);
    expect(startSwitcher(["a", "b", "c"], { reverse: true })?.selected).toBe(2);
    expect(startSwitcher(["a"])?.selected).toBe(0);
    expect(startSwitcher([])).toBeUndefined();
    expect(isSwitcherStart(down("Tab"))).toBe(true);
    expect(isSwitcherStart(down("Tab", { meta: true }))).toBe(false);
    expect(isSwitcherStart({ type: "keyDown", key: "Tab" })).toBe(false);
  });

  it("moves with Tab, Shift-Tab and arrows, and commits when Ctrl is let go", () => {
    let s = startSwitcher(["a", "b", "c"])!;
    s = switcherKey(s, down("Tab")).session;
    expect(s.selected).toBe(2);
    s = switcherKey(s, down("Tab")).session;
    expect(s.selected).toBe(0);
    s = switcherKey(s, down("Tab", { shift: true })).session;
    expect(s.selected).toBe(2);
    s = switcherKey(s, down("ArrowUp")).session;
    expect(s.selected).toBe(1);
    expect(switcherKey(s, { type: "keyUp", key: "Control" }).effect).toEqual({ kind: "commit", tabId: "b" });
    expect(switcherKey(s, { type: "keyUp", key: "Tab", control: true }).effect.kind).toBe("none");
  });

  it("jumps with digits, cancels with Esc and closes with W", () => {
    const order = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const s = startSwitcher(order)!;
    expect(switcherKey(s, down("3")).effect).toEqual({ kind: "commit", tabId: "t2" });
    expect(switcherKey(s, down("0")).effect).toEqual({ kind: "commit", tabId: "t9" });
    expect(switcherKey(startSwitcher(["a", "b"])!, down("5")).effect.kind).toBe("none");
    expect(switcherKey(s, down("Escape")).effect.kind).toBe("cancel");
    expect(switcherKey(s, down("w")).effect).toEqual({ kind: "close", tabId: "t1" });
    expect(rowBadge(0)).toBe("1");
    expect(rowBadge(9)).toBe("0");
    expect(rowBadge(10)).toBeUndefined();
  });

  it("waits for Enter when opened from the palette", () => {
    const s = startSwitcher(["a", "b"], { sticky: true })!;
    expect(switcherKey(s, { type: "keyUp", key: "Control" }).effect.kind).toBe("none");
    expect(switcherKey(s, { type: "keyDown", key: "ArrowDown" }).session.selected).toBe(0);
    expect(switcherKey(s, { type: "keyDown", key: "Enter" }).effect).toEqual({ kind: "commit", tabId: "b" });
  });

  it("keeps a sensible selection when a tab closes", () => {
    const s: SwitcherSession = { order: ["a", "b", "c"], selected: 2, sticky: false };
    expect(withoutTab(s, "c")).toMatchObject({ order: ["a", "b"], selected: 1 });
    expect(withoutTab(s, "a")).toMatchObject({ order: ["b", "c"], selected: 1 });
    expect(withoutTab({ order: ["a"], selected: 0, sticky: false }, "a")).toBeUndefined();
  });
});
