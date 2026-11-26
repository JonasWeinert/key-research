import {
  activateWorkspaceTab,
  addGroupWithTab,
  addWorkspaceTab,
  findViewTab,
  neighbourGroup,
  singleWorkspaceTab,
  type WorkspaceTabsState,
} from "./tab-model";

/** Swaps the view a tab shows, keeping the tab's place. */
function reuseTab(state: WorkspaceTabsState, viewId: string, resultViewId: string): WorkspaceTabsState | undefined {
  const reusable = findViewTab(state, viewId);
  if (!reusable) return undefined;
  const groups = state.groups.map((g) =>
    g.id === reusable.group.id ? { ...g, tabs: g.tabs.map((t) => (t.id === reusable.tab.id ? { ...t, viewId: resultViewId } : t)) } : g,
  );
  return activateWorkspaceTab({ ...state, groups }, reusable.tab.id);
}

/** Open a search result in its own tab, right after the results it came from.
 * Stepping to a result in another document reuses the result's tab (when the
 * caller marks the old view replaceable) instead of piling up tabs; a view that is
 * already open anywhere is simply brought forward.
 */
export function placeSearchResultTab(
  state: WorkspaceTabsState,
  sourceViewId: string,
  resultViewId: string,
  replaceableViewId?: string,
): WorkspaceTabsState {
  const source = findViewTab(state, sourceViewId);
  if (!source || sourceViewId === resultViewId) return state;
  const open = findViewTab(state, resultViewId);
  if (open) return activateWorkspaceTab(state, open.tab.id);
  const reused = replaceableViewId && replaceableViewId !== sourceViewId ? reuseTab(state, replaceableViewId, resultViewId) : undefined;
  if (reused) return reused;
  return addWorkspaceTab(state, singleWorkspaceTab(resultViewId), { groupId: source.group.id, index: source.index + 1 });
}

/** Open a search result beside its results: in the group to the right of the search's
 * (a new one when there is none), so the search keeps its place. A result shown there
 * before is replaced, so stepping through results reuses one tab; a view already open is
 * simply focused.
 */
export function placeSearchResultBeside(
  state: WorkspaceTabsState,
  sourceViewId: string,
  resultViewId: string,
  replaceableViewId?: string,
): WorkspaceTabsState {
  const source = findViewTab(state, sourceViewId);
  if (!source || sourceViewId === resultViewId) return state;
  const open = findViewTab(state, resultViewId);
  if (open) return activateWorkspaceTab(state, open.tab.id);
  const reused = replaceableViewId && replaceableViewId !== sourceViewId ? reuseTab(state, replaceableViewId, resultViewId) : undefined;
  if (reused) return reused;
  const right = neighbourGroup(state, source.group.id, "right");
  const tab = singleWorkspaceTab(resultViewId);
  return right ? addWorkspaceTab(state, tab, { groupId: right.id }) : addGroupWithTab(state, tab, source.group.id, "right");
}
