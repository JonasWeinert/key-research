/** A window's tabs, in editor groups side by side (like VS Code's). Each tab shows exactly
 * one view; each group has its own strip and its own active tab, and one group has focus. */
export interface WorkspaceTab {
  id: string;
  viewId: string;
  /** Pinned tabs sit, compact, before every other tab of their group and survive Close Others. */
  pinned?: boolean;
}

export interface TabGroup {
  id: string;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  /** The group's share of the content width; a window's sizes sum to 1. */
  size: number;
}

export interface WorkspaceTabsState {
  /** Left to right. Never empty: a window without tabs keeps one empty group. */
  groups: TabGroup[];
  activeGroupId: string;
}

export type GroupSide = "left" | "right";

/** Height of each group's tab strip, above its content. */
export const TAB_STRIP_HEIGHT = 40;
/** Half the width of the sash between groups (and between a reader and its panel). */
export const GROUP_GAP = 3;
/** More groups than this stop being readable in one window. */
export const MAX_GROUPS = 6;
/** A group is never dragged narrower than this. */
export const MIN_GROUP_WIDTH = 240;
/** A reader's details-and-notes panel: its default share of the tab, and the narrowest each side gets. */
export const PANEL_RATIO = 0.4;
export const PANEL_MIN = 300;
export const READER_MIN = 320;

const newId = () => crypto.randomUUID();

export function singleWorkspaceTab(viewId: string): WorkspaceTab {
  return { id: newId(), viewId };
}

export function newTabGroup(tabs: WorkspaceTab[] = [], size = 1): TabGroup {
  return { id: newId(), tabs, activeTabId: tabs.at(-1)?.id ?? null, size };
}

export function emptyTabsState(): WorkspaceTabsState {
  const group = newTabGroup();
  return { groups: [group], activeGroupId: group.id };
}

/** One group holding `tabs`, the last one active. */
export function tabsState(tabs: WorkspaceTab[]): WorkspaceTabsState {
  const group = newTabGroup(tabs);
  return { groups: [group], activeGroupId: group.id };
}

export function allTabs(state: WorkspaceTabsState): WorkspaceTab[] {
  return state.groups.flatMap((g) => g.tabs);
}

export function findTab(state: WorkspaceTabsState, tabId: string) {
  for (const group of state.groups) {
    const index = group.tabs.findIndex((t) => t.id === tabId);
    if (index >= 0) return { group, tab: group.tabs[index], index };
  }
  return undefined;
}

export function findViewTab(state: WorkspaceTabsState, viewId: string) {
  for (const group of state.groups) {
    const index = group.tabs.findIndex((t) => t.viewId === viewId);
    if (index >= 0) return { group, tab: group.tabs[index], index };
  }
  return undefined;
}

export function activeGroup(state: WorkspaceTabsState): TabGroup {
  return state.groups.find((g) => g.id === state.activeGroupId) ?? state.groups[0];
}

/** The focused group's active tab. */
export function activeWorkspaceTab(state: WorkspaceTabsState): WorkspaceTab | null {
  const group = activeGroup(state);
  return group?.tabs.find((t) => t.id === group.activeTabId) ?? group?.tabs[0] ?? null;
}

/** Each group's shown tab, left to right. */
export function shownTabs(state: WorkspaceTabsState): WorkspaceTab[] {
  return state.groups.flatMap((g) => {
    const tab = g.tabs.find((t) => t.id === g.activeTabId) ?? g.tabs[0];
    return tab ? [tab] : [];
  });
}

/** Pinned tabs first, each set in its own order. */
function pinnedFirst(tabs: WorkspaceTab[]): WorkspaceTab[] {
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
}

/** Keeps the invariants every operation relies on: at least one group, no empty group
 * beside others, sizes that sum to 1, and active ids that exist. */
export function normalizeTabs(state: WorkspaceTabsState): WorkspaceTabsState {
  let groups = state.groups.filter((g) => g.tabs.length > 0);
  if (!groups.length) groups = [state.groups[0] ?? newTabGroup()];
  const sizes = groups.map((g) => (Number.isFinite(g.size) && g.size > 0 ? g.size : 1 / groups.length));
  const total = sizes.reduce((sum, s) => sum + s, 0) || 1;
  groups = groups.map((g, i) => {
    const size = sizes[i] / total;
    const activeTabId = g.tabs.some((t) => t.id === g.activeTabId) ? g.activeTabId : (g.tabs[0]?.id ?? null);
    return g.size === size && g.activeTabId === activeTabId ? g : { ...g, size, activeTabId };
  });
  const activeGroupId = groups.some((g) => g.id === state.activeGroupId) ? state.activeGroupId : groups[0].id;
  return { groups, activeGroupId };
}

function mapGroup(state: WorkspaceTabsState, groupId: string, update: (group: TabGroup) => TabGroup): WorkspaceTabsState {
  return { ...state, groups: state.groups.map((g) => (g.id === groupId ? update(g) : g)) };
}

export function focusGroup(state: WorkspaceTabsState, groupId: string): WorkspaceTabsState {
  return state.groups.some((g) => g.id === groupId) ? { ...state, activeGroupId: groupId } : state;
}

/** Shows `tabId` in its group and gives that group focus. */
export function activateWorkspaceTab(state: WorkspaceTabsState, tabId: string): WorkspaceTabsState {
  const found = findTab(state, tabId);
  if (!found) return state;
  return { ...mapGroup(state, found.group.id, (g) => ({ ...g, activeTabId: tabId })), activeGroupId: found.group.id };
}

/** Adds a tab to a group (the focused one by default), at `index` or at its end. Pinned tabs stay first. */
export function addWorkspaceTab(
  state: WorkspaceTabsState,
  tab: WorkspaceTab,
  options: { groupId?: string; index?: number; activate?: boolean } = {},
): WorkspaceTabsState {
  const groupId = state.groups.some((g) => g.id === options.groupId) ? options.groupId! : activeGroup(state).id;
  const activate = options.activate !== false;
  const next = mapGroup(state, groupId, (g) => {
    const tabs = [...g.tabs];
    const pinned = tabs.filter((t) => t.pinned).length;
    const at = options.index === undefined || !Number.isFinite(options.index) ? tabs.length : Math.trunc(options.index);
    tabs.splice(tab.pinned ? Math.min(Math.max(0, at), pinned) : Math.min(Math.max(pinned, at), tabs.length), 0, tab);
    return { ...g, tabs, activeTabId: activate || !g.activeTabId ? tab.id : g.activeTabId };
  });
  return activate ? { ...next, activeGroupId: groupId } : next;
}

/** Removes a tab. Its group shows the tab beside it; an emptied group closes (unless it is
 * the last), handing its width and focus to its neighbour. */
export function closeWorkspaceTab(state: WorkspaceTabsState, tabId: string): WorkspaceTabsState {
  const found = findTab(state, tabId);
  if (!found) return state;
  const { group, index } = found;
  const tabs = group.tabs.filter((t) => t.id !== tabId);
  if (!tabs.length && state.groups.length > 1) return removeGroup(state, group.id);
  const activeTabId = group.activeTabId === tabId ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : group.activeTabId;
  return mapGroup(state, group.id, (g) => ({ ...g, tabs, activeTabId }));
}

/** Takes a group out; its width goes to the neighbour that takes focus (the right one, or the left at the end). */
function removeGroup(state: WorkspaceTabsState, groupId: string): WorkspaceTabsState {
  const index = state.groups.findIndex((g) => g.id === groupId);
  if (index < 0 || state.groups.length < 2) return state;
  const removed = state.groups[index];
  const heir = state.groups[index + 1] ?? state.groups[index - 1];
  const groups = state.groups.filter((g) => g.id !== groupId).map((g) => (g.id === heir.id ? { ...g, size: g.size + removed.size } : g));
  return normalizeTabs({ groups, activeGroupId: state.activeGroupId === groupId ? heir.id : state.activeGroupId });
}

/** Reorders within a group; a tab stays among the pinned tabs, or among the others. */
export function reorderWorkspaceTab(state: WorkspaceTabsState, tabId: string, index: number): WorkspaceTabsState {
  const found = findTab(state, tabId);
  if (!found || !Number.isFinite(index)) return state;
  return mapGroup(state, found.group.id, (g) => {
    const tabs = [...g.tabs];
    const [moved] = tabs.splice(found.index, 1);
    const pinned = tabs.filter((tab) => tab.pinned).length;
    const [min, max] = moved.pinned ? [0, pinned] : [pinned, tabs.length];
    tabs.splice(Math.min(max, Math.max(min, Math.trunc(index))), 0, moved);
    return { ...g, tabs };
  });
}

/** Moves a tab into another group at `index` (its end by default), where it becomes active
 * and focused. Within its own group this is a reorder. */
export function moveWorkspaceTab(state: WorkspaceTabsState, tabId: string, groupId: string, index?: number): WorkspaceTabsState {
  const found = findTab(state, tabId);
  if (!found || !state.groups.some((g) => g.id === groupId)) return state;
  if (found.group.id === groupId) {
    const reordered = index === undefined ? state : reorderWorkspaceTab(state, tabId, index);
    return activateWorkspaceTab(reordered, tabId);
  }
  const without = closeWorkspaceTab(state, tabId);
  return addWorkspaceTab(without, found.tab, { groupId, index });
}

/** Opens a new group beside `targetGroupId` holding `tabId`, which leaves its own group.
 * The new group takes half the target's width. Nothing happens when the tab is the only
 * one of the target group (it would leave that group empty) or the window is full. */
export function splitWorkspaceTab(state: WorkspaceTabsState, tabId: string, targetGroupId: string, side: GroupSide): WorkspaceTabsState {
  const found = findTab(state, tabId);
  const target = state.groups.find((g) => g.id === targetGroupId);
  if (!found || !target || (side !== "left" && side !== "right")) return state;
  if (found.group.id === target.id && target.tabs.length < 2) return state;
  const sourceCloses = found.group.id !== target.id && found.group.tabs.length === 1;
  if (state.groups.length >= MAX_GROUPS && !sourceCloses) return state;
  const fresh = newTabGroup([found.tab], target.size / 2);
  let groups = state.groups.flatMap((g) => {
    if (g.id !== target.id) return [g];
    const half = { ...g, size: g.size / 2 };
    return side === "left" ? [fresh, half] : [half, fresh];
  });
  // The tab leaves where it was.
  groups = groups.map((g) => {
    if (g.id === fresh.id || !g.tabs.some((t) => t.id === tabId)) return g;
    const tabs = g.tabs.filter((t) => t.id !== tabId);
    const at = g.tabs.findIndex((t) => t.id === tabId);
    return { ...g, tabs, activeTabId: g.activeTabId === tabId ? (tabs[Math.min(at, tabs.length - 1)]?.id ?? null) : g.activeTabId };
  });
  const emptied = groups.find((g) => g.id !== fresh.id && !g.tabs.length);
  const next = { groups, activeGroupId: fresh.id };
  return emptied ? removeGroup(next, emptied.id) : normalizeTabs(next);
}

/** `tab` (new to the window) opens in a group of its own beside `targetGroupId`. */
export function addGroupWithTab(state: WorkspaceTabsState, tab: WorkspaceTab, targetGroupId: string, side: GroupSide = "right"): WorkspaceTabsState {
  const target = state.groups.find((g) => g.id === targetGroupId) ?? activeGroup(state);
  if (state.groups.length >= MAX_GROUPS) return addWorkspaceTab(state, tab, { groupId: target.id });
  const fresh = newTabGroup([tab], target.size / 2);
  const groups = state.groups.flatMap((g) => (g.id !== target.id ? [g] : side === "left" ? [fresh, { ...g, size: g.size / 2 }] : [{ ...g, size: g.size / 2 }, fresh]));
  return normalizeTabs({ groups, activeGroupId: fresh.id });
}

/** The group beside `groupId` on `side`, if any. */
export function neighbourGroup(state: WorkspaceTabsState, groupId: string, side: GroupSide): TabGroup | undefined {
  const index = state.groups.findIndex((g) => g.id === groupId);
  if (index < 0) return undefined;
  return state.groups[side === "left" ? index - 1 : index + 1];
}

/** Sets every group's share (in order); non-positive or missing shares keep the old value. */
export function setGroupSizes(state: WorkspaceTabsState, sizes: number[]): WorkspaceTabsState {
  if (!Array.isArray(sizes) || sizes.length !== state.groups.length) return state;
  return normalizeTabs({
    ...state,
    groups: state.groups.map((g, i) => (Number.isFinite(sizes[i]) && sizes[i] > 0 ? { ...g, size: sizes[i] } : g)),
  });
}

export function equalizeGroups(state: WorkspaceTabsState): WorkspaceTabsState {
  return { ...state, groups: state.groups.map((g) => ({ ...g, size: 1 / state.groups.length })) };
}

/** Pins a tab after its group's pinned ones, or unpins it to the start of the others. */
export function pinWorkspaceTab(state: WorkspaceTabsState, tabId: string, pinned: boolean): WorkspaceTabsState {
  const found = findTab(state, tabId);
  if (!found || Boolean(found.tab.pinned) === pinned) return state;
  return mapGroup(state, found.group.id, (g) => {
    const rest = g.tabs.filter((tab) => tab.id !== tabId);
    const at = rest.filter((tab) => tab.pinned).length;
    const { pinned: _, ...unpinned } = found.tab;
    rest.splice(at, 0, pinned ? { ...found.tab, pinned: true } : unpinned);
    return { ...g, tabs: rest };
  });
}

/** The tabs Close Other Tabs or Close Tabs to the Right would close, within the tab's group:
 * never pinned ones. */
export function tabsToClose(state: WorkspaceTabsState, tabId: string, which: "others" | "right"): string[] {
  const found = findTab(state, tabId);
  if (!found) return [];
  return found.group.tabs
    .filter((tab, i) => !tab.pinned && (which === "others" ? i !== found.index : i > found.index))
    .map((tab) => tab.id);
}

/** Puts `viewId` in the place of the tab showing `replacedViewId` (a launcher being used). */
export function replaceWorkspaceView(state: WorkspaceTabsState, replacedViewId: string, viewId: string): WorkspaceTabsState {
  const found = findViewTab(state, replacedViewId);
  if (!found || findViewTab(state, viewId)) return state;
  const next = mapGroup(state, found.group.id, (g) => ({ ...g, tabs: g.tabs.map((t) => (t.id === found.tab.id ? { ...t, viewId } : t)) }));
  return activateWorkspaceTab(next, found.tab.id);
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface LaidOutGroup extends Rect {
  id: string;
}
export interface LaidOutSash extends Rect {
  /** The sash sits between group `index` and group `index + 1`. */
  index: number;
}

/** Pixel rectangles for every group (strip included) and the sashes between them. Main
 * (native views) and the renderer (strips, DOM panes, sashes) share this, so they never disagree. */
export function layoutGroups(groups: Pick<TabGroup, "id" | "size">[], rect: Rect, gap = GROUP_GAP) {
  const n = groups.length;
  const usable = Math.max(0, rect.width - Math.max(0, n - 1) * 2 * gap);
  const total = groups.reduce((sum, g) => sum + (g.size > 0 ? g.size : 0), 0) || 1;
  const laidOut: LaidOutGroup[] = [],
    sashes: LaidOutSash[] = [];
  let share = 0,
    previous = 0;
  groups.forEach((g, i) => {
    share += g.size > 0 ? g.size : 0;
    const edge = i === n - 1 ? usable : Math.round((usable * share) / total);
    const x = rect.x + previous + i * 2 * gap;
    const width = Math.max(0, edge - previous);
    laidOut.push({ id: g.id, x, y: rect.y, width, height: rect.height });
    if (i < n - 1) sashes.push({ index: i, x: x + width, y: rect.y, width: 2 * gap, height: rect.height });
    previous = edge;
  });
  return { groups: laidOut, sashes };
}

/** A group's content: below its tab strip. */
export function groupBody<R extends Rect>(group: R): R {
  const strip = Math.min(TAB_STRIP_HEIGHT, group.height);
  return { ...group, y: group.y + strip, height: group.height - strip };
}

/** New sizes after dragging the sash between group `index` and the next to `x` (pixels from
 * the content area's left edge). Only those two groups change; neither gets narrower than
 * MIN_GROUP_WIDTH (or a fair half when even that does not fit). */
export function dragGroupSash(sizes: number[], index: number, x: number, width: number, gap = GROUP_GAP): number[] {
  if (index < 0 || index >= sizes.length - 1 || !Number.isFinite(x)) return sizes;
  const usable = Math.max(1, width - (sizes.length - 1) * 2 * gap);
  const total = sizes.reduce((s, v) => s + v, 0) || 1;
  const fractions = sizes.map((s) => s / total);
  const before = fractions.slice(0, index).reduce((s, v) => s + v, 0);
  const pair = fractions[index] + fractions[index + 1];
  const pointer = (x - index * 2 * gap - gap) / usable - before;
  const min = Math.min(MIN_GROUP_WIDTH / usable, pair / 2);
  const left = Math.min(pair - min, Math.max(min, pointer));
  const next = [...fractions];
  next[index] = left;
  next[index + 1] = pair - left;
  return next;
}

/** A reader and its details-and-notes panel side by side in one tab's content. */
export function layoutPanel(rect: Rect, ratio: number, gap = GROUP_GAP) {
  const room = Math.max(0, rect.width - 2 * gap);
  const wanted = Math.round(room * (Number.isFinite(ratio) ? ratio : PANEL_RATIO));
  const panelWidth =
    room >= PANEL_MIN + READER_MIN ? Math.min(room - READER_MIN, Math.max(PANEL_MIN, wanted)) : Math.round(room * PANEL_RATIO);
  const mainWidth = room - panelWidth;
  return {
    main: { ...rect, width: mainWidth },
    sash: { ...rect, x: rect.x + mainWidth, width: 2 * gap },
    panel: { ...rect, x: rect.x + mainWidth + 2 * gap, width: panelWidth },
  };
}
