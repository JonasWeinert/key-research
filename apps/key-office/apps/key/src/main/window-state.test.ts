import { describe, expect, it } from "vitest";
import { readSavedTabs } from "./window-state";

const pdf = { type: "pdf", workspaceId: "w", hash: "h", title: "Paper" };
const note = { type: "content", section: "note", workspaceId: "w", noteId: "n", title: "Note" };
const home = { type: "home" };

describe("saved window arrangements", () => {
  it("restores a version 1 split tab as tabs of their own, in reading order", () => {
    const legacy = {
      tabs: [
        { layout: { view: home }, active: 0, pinned: true },
        { layout: { split: "row", ratio: 0.6, a: { view: pdf }, b: { split: "column", ratio: 0.5, a: { view: note }, b: { view: home } } }, active: 1 },
      ],
      active: 1,
    };
    expect(readSavedTabs(legacy)).toEqual({
      groups: [{ tabs: [{ view: home, pinned: true }, { view: pdf }, { view: note }, { view: home }], active: 2, size: 1 }],
      active: 0,
    });
  });
  it("reads groups, and drops what it cannot read", () => {
    const saved = {
      groups: [
        { tabs: [{ view: pdf, panel: { view: note, ratio: 0.4 } }], active: 0, size: 0.6 },
        { tabs: [{ view: null }], active: 0, size: 0.4 },
        { tabs: [{ view: home }], active: 0, size: -1 },
      ],
      active: 1,
    };
    expect(readSavedTabs(saved)).toEqual({
      groups: [
        { tabs: [{ view: pdf, panel: { view: note, ratio: 0.4 } }], active: 0, size: 0.6 },
        { tabs: [{ view: home }], active: 0, size: 1 },
      ],
      active: 1,
    });
    expect(readSavedTabs({ tabs: [{ layout: { split: "diagonal" }, active: 0 }], active: 0 })).toBeUndefined();
    expect(readSavedTabs(null)).toBeUndefined();
  });
});
