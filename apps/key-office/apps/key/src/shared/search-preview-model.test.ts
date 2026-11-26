import { describe, it, expect } from "vitest";
import { placeSearchResultBeside, placeSearchResultTab } from "./search-preview-model";
import { activeWorkspaceTab, newTabGroup, type WorkspaceTab, type WorkspaceTabsState } from "./tab-model";
const tab = (id: string, viewId: string): WorkspaceTab => ({ id, viewId });
const state = (...groups: WorkspaceTab[][]): WorkspaceTabsState => {
  const made = groups.map((tabs) => ({ ...newTabGroup(tabs, 1 / groups.length), activeTabId: tabs[0]?.id ?? null }));
  return { groups: made, activeGroupId: made[0].id };
};
const views = (s: WorkspaceTabsState) => s.groups.map((g) => g.tabs.map((t) => t.viewId));
describe("search results open in tabs", () => {
  it("opens a result in a new tab right after its results", () => {
    const s = placeSearchResultTab(state([tab("list", "library"), tab("other", "note")]), "library", "pdf");
    expect(views(s)).toEqual([["library", "pdf", "note"]]);
    expect(activeWorkspaceTab(s)?.viewId).toBe("pdf");
  });
  it("reuses the result tab when stepping to another document", () => {
    const s = placeSearchResultTab(state([tab("list", "library"), tab("result", "pdf-a")]), "library", "pdf-b", "pdf-a");
    expect(views(s)).toEqual([["library", "pdf-b"]]);
    expect(activeWorkspaceTab(s)?.id).toBe("result");
  });
  it("brings an already open document forward instead of duplicating it", () => {
    const s = placeSearchResultTab(state([tab("list", "library")], [tab("work", "note"), tab("doc", "pdf")]), "library", "pdf");
    expect(views(s)).toEqual([["library"], ["note", "pdf"]]);
    expect(activeWorkspaceTab(s)?.id).toBe("doc");
  });
});

describe("placeSearchResultBeside", () => {
  it("opens a result in a group right of the search, and reuses its tab for the next one", () => {
    const search = state([tab("search", "search")]);
    const first = placeSearchResultBeside(search, "search", "pdf:a");
    expect(views(first)).toEqual([["search"], ["pdf:a"]]);
    expect(activeWorkspaceTab(first)?.viewId).toBe("pdf:a");
    const second = placeSearchResultBeside(first, "search", "pdf:b", "pdf:a");
    expect(views(second)).toEqual([["search"], ["pdf:b"]]);
    expect(views(placeSearchResultBeside(second, "search", "pdf:b", "pdf:b"))).toEqual([["search"], ["pdf:b"]]);
  });
  it("uses the group already right of the search", () => {
    const s = placeSearchResultBeside(state([tab("search", "search")], [tab("n", "note")]), "search", "pdf:a");
    expect(views(s)).toEqual([["search"], ["note", "pdf:a"]]);
  });
});
