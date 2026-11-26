import { describe, expect, it } from "vitest";
import {
  activateWorkspaceTab,
  activeGroup,
  activeWorkspaceTab,
  addGroupWithTab,
  addWorkspaceTab,
  allTabs,
  closeWorkspaceTab,
  dragGroupSash,
  equalizeGroups,
  findViewTab,
  focusGroup,
  layoutGroups,
  layoutPanel,
  moveWorkspaceTab,
  normalizeTabs,
  pinWorkspaceTab,
  reorderWorkspaceTab,
  replaceWorkspaceView,
  setGroupSizes,
  shownTabs,
  singleWorkspaceTab,
  splitWorkspaceTab,
  tabsState,
  tabsToClose,
  MAX_GROUPS,
  MIN_GROUP_WIDTH,
  PANEL_MIN,
  READER_MIN,
  type WorkspaceTabsState,
} from "./tab-model";

const initial = () => tabsState(["a", "b", "c", "d"].map(singleWorkspaceTab));
const views = (s: WorkspaceTabsState) => s.groups.map((g) => g.tabs.map((t) => t.viewId));
const tabOf = (s: WorkspaceTabsState, viewId: string) => findViewTab(s, viewId)!.tab.id;
function invariant(state: WorkspaceTabsState, expected: string[]) {
  const owned = allTabs(state).map((t) => t.viewId);
  expect([...owned].sort()).toEqual([...expected].sort());
  expect(new Set(owned).size).toBe(owned.length);
  expect(state.groups.length).toBeGreaterThan(0);
  expect(state.groups.map((g) => g.id)).toContain(state.activeGroupId);
  expect(state.groups.reduce((s, g) => s + g.size, 0)).toBeCloseTo(1);
  for (const group of state.groups) {
    if (state.groups.length > 1) expect(group.tabs.length).toBeGreaterThan(0);
    if (group.tabs.length) expect(group.tabs.map((t) => t.id)).toContain(group.activeTabId);
    const pinned = group.tabs.map((t) => Boolean(t.pinned));
    expect(pinned).toEqual([...pinned].sort((a, b) => Number(b) - Number(a)));
  }
}

describe("tabs and groups", () => {
  it("opens tabs in the focused group, at its end", () => {
    let s = initial();
    s = addWorkspaceTab(s, singleWorkspaceTab("e"));
    expect(views(s)).toEqual([["a", "b", "c", "d", "e"]]);
    expect(activeWorkspaceTab(s)?.viewId).toBe("e");
    invariant(s, ["a", "b", "c", "d", "e"]);
  });

  it("splits a tab into a new group to the right, halving its group", () => {
    const base = initial();
    const split = splitWorkspaceTab(base, tabOf(base, "b"), base.groups[0].id, "right");
    expect(views(split)).toEqual([["a", "c", "d"], ["b"]]);
    expect(split.groups.map((g) => g.size)).toEqual([0.5, 0.5]);
    expect(activeWorkspaceTab(split)?.viewId).toBe("b");
    invariant(split, ["a", "b", "c", "d"]);
  });

  it("splits to the left, and never empties the target group", () => {
    const base = tabsState([singleWorkspaceTab("only")]);
    expect(splitWorkspaceTab(base, base.groups[0].tabs[0].id, base.groups[0].id, "left")).toBe(base);
    const two = initial();
    const left = splitWorkspaceTab(two, tabOf(two, "d"), two.groups[0].id, "left");
    expect(views(left)).toEqual([["d"], ["a", "b", "c"]]);
  });

  it("moving a group's last tab elsewhere closes the group and gives its width away", () => {
    let s = initial();
    s = splitWorkspaceTab(s, tabOf(s, "b"), s.groups[0].id, "right");
    s = splitWorkspaceTab(s, tabOf(s, "c"), s.groups[1].id, "right");
    expect(views(s)).toEqual([["a", "d"], ["b"], ["c"]]);
    const [left, , right] = s.groups;
    s = moveWorkspaceTab(s, tabOf(s, "b"), right.id, 0);
    expect(views(s)).toEqual([["a", "d"], ["b", "c"]]);
    expect(s.groups[0].size).toBeCloseTo(left.size);
    expect(activeWorkspaceTab(s)?.viewId).toBe("b");
    invariant(s, ["a", "b", "c", "d"]);
  });

  it("closing the last tab of a group closes the group and focuses its neighbour", () => {
    let s = initial();
    s = splitWorkspaceTab(s, tabOf(s, "d"), s.groups[0].id, "right");
    s = closeWorkspaceTab(s, tabOf(s, "d"));
    expect(views(s)).toEqual([["a", "b", "c"]]);
    expect(s.groups[0].size).toBe(1);
    invariant(s, ["a", "b", "c"]);
    // The last group stays, empty.
    let one = tabsState([singleWorkspaceTab("x")]);
    one = closeWorkspaceTab(one, one.groups[0].tabs[0].id);
    expect(one.groups).toHaveLength(1);
    expect(one.groups[0].tabs).toEqual([]);
    expect(activeWorkspaceTab(one)).toBeNull();
  });

  it("closing the active tab shows the one beside it", () => {
    let s = initial();
    s = activateWorkspaceTab(s, tabOf(s, "b"));
    s = closeWorkspaceTab(s, tabOf(s, "b"));
    expect(activeWorkspaceTab(s)?.viewId).toBe("c");
    s = activateWorkspaceTab(s, tabOf(s, "d"));
    s = closeWorkspaceTab(s, tabOf(s, "d"));
    expect(activeWorkspaceTab(s)?.viewId).toBe("c");
  });

  it("each group keeps its own active tab; activating focuses the tab's group", () => {
    let s = initial();
    s = splitWorkspaceTab(s, tabOf(s, "c"), s.groups[0].id, "right");
    s = moveWorkspaceTab(s, tabOf(s, "d"), s.groups[1].id);
    s = activateWorkspaceTab(s, tabOf(s, "a"));
    expect(activeGroup(s).id).toBe(s.groups[0].id);
    expect(shownTabs(s).map((t) => t.viewId)).toEqual(["a", "d"]);
    s = focusGroup(s, s.groups[1].id);
    expect(activeWorkspaceTab(s)?.viewId).toBe("d");
  });

  it("reorders within a group, pinned tabs first", () => {
    let s = initial();
    s = pinWorkspaceTab(s, tabOf(s, "c"), true);
    expect(views(s)).toEqual([["c", "a", "b", "d"]]);
    s = reorderWorkspaceTab(s, tabOf(s, "d"), 0);
    expect(views(s)).toEqual([["c", "d", "a", "b"]]);
    s = reorderWorkspaceTab(s, tabOf(s, "c"), 3);
    expect(views(s)).toEqual([["c", "d", "a", "b"]]);
    expect(tabsToClose(s, tabOf(s, "a"), "others").length).toBe(2);
    expect(tabsToClose(s, tabOf(s, "d"), "right").length).toBe(2);
    invariant(s, ["a", "b", "c", "d"]);
  });

  it("close-others stays within the tab's group", () => {
    let s = initial();
    s = splitWorkspaceTab(s, tabOf(s, "d"), s.groups[0].id, "right");
    expect(tabsToClose(s, tabOf(s, "a"), "others").length).toBe(2);
    expect(tabsToClose(s, tabOf(s, "d"), "others")).toEqual([]);
  });

  it("opens a new tab in a group of its own, up to the limit", () => {
    let s = tabsState([singleWorkspaceTab("a")]);
    for (let i = 1; i < MAX_GROUPS + 2; i++) s = addGroupWithTab(s, singleWorkspaceTab(`g${i}`), activeGroup(s).id);
    expect(s.groups).toHaveLength(MAX_GROUPS);
    invariant(s, ["a", ...Array.from({ length: MAX_GROUPS + 1 }, (_, i) => `g${i + 1}`)]);
  });

  it("replaces a launcher tab in place", () => {
    let s = initial();
    s = replaceWorkspaceView(s, "b", "z");
    expect(views(s)).toEqual([["a", "z", "c", "d"]]);
    expect(activeWorkspaceTab(s)?.viewId).toBe("z");
  });

  it("sizes: set, equalise, normalise", () => {
    let s = initial();
    s = splitWorkspaceTab(s, tabOf(s, "d"), s.groups[0].id, "right");
    s = setGroupSizes(s, [3, 1]);
    expect(s.groups.map((g) => g.size)).toEqual([0.75, 0.25]);
    s = equalizeGroups(s);
    expect(s.groups.map((g) => g.size)).toEqual([0.5, 0.5]);
    expect(setGroupSizes(s, [1])).toBe(s);
    const odd = normalizeTabs({ ...s, groups: [...s.groups, { id: "empty", tabs: [], activeTabId: null, size: 0.5 }], activeGroupId: "empty" });
    expect(odd.groups).toHaveLength(2);
    expect(odd.activeGroupId).toBe(s.groups[0].id);
  });
});

describe("geometry", () => {
  const rect = { x: 240, y: 0, width: 1206, height: 900 };
  it("lays groups out edge to edge with sashes between them", () => {
    const { groups, sashes } = layoutGroups(
      [
        { id: "a", size: 0.5 },
        { id: "b", size: 0.25 },
        { id: "c", size: 0.25 },
      ],
      rect,
      3,
    );
    expect(groups.map((g) => g.width).reduce((a, b) => a + b, 0) + sashes.length * 6).toBe(rect.width);
    expect(groups[0].x).toBe(240);
    expect(sashes[0].x).toBe(groups[0].x + groups[0].width);
    expect(groups[1].x).toBe(sashes[0].x + 6);
    expect(groups[2].x + groups[2].width).toBe(rect.x + rect.width);
  });
  it("drags a sash between two groups only, never below the minimum width", () => {
    const sizes = dragGroupSash([0.5, 0.25, 0.25], 1, 900, 1206, 3);
    expect(sizes[0]).toBe(0.5);
    expect(sizes[1] + sizes[2]).toBeCloseTo(0.5);
    const tight = dragGroupSash([0.5, 0.5], 0, 10, 1206, 3);
    expect(tight[0] * 1200).toBeCloseTo(MIN_GROUP_WIDTH);
  });
  it("gives a reader and its panel their room", () => {
    const wide = layoutPanel({ x: 0, y: 40, width: 1206, height: 800 }, 0.4, 3);
    expect(wide.main.width + wide.sash.width + wide.panel.width).toBe(1206);
    expect(wide.panel.x).toBe(wide.sash.x + 6);
    const squeezed = layoutPanel({ x: 0, y: 40, width: 900, height: 800 }, 0.9, 3);
    expect(squeezed.main.width).toBe(READER_MIN);
    const minimal = layoutPanel({ x: 0, y: 40, width: 900, height: 800 }, 0.05, 3);
    expect(minimal.panel.width).toBe(PANEL_MIN);
  });
});
