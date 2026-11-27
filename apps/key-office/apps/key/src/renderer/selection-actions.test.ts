import { describe, expect, it } from "vitest";
import { registerSelectionAction, selectionActions, selectionActionsFor } from "./selection-actions";

describe("selection actions", () => {
  it("registers, replaces by id, filters by group and when, and unregisters", () => {
    const ctx = { workspaceId: "w", sourceIds: ["a", "b"] };
    const offA = registerSelectionAction({ id: "t.a", label: "A", group: "ai", run: () => {} });
    const offB = registerSelectionAction({ id: "t.b", label: "B", when: (c) => c.sourceIds.length > 2, run: () => {} });
    registerSelectionAction({ id: "t.c", label: "C", when: () => { throw new Error("x"); }, run: () => {} });
    expect(selectionActionsFor(ctx).map((a) => a.label)).toEqual(["A"]);
    expect(selectionActionsFor(ctx, "ai").map((a) => a.id)).toEqual(["t.a"]);
    expect(selectionActionsFor({ ...ctx, sourceIds: ["a", "b", "c"] }, "other").map((a) => a.id)).toEqual(["t.b"]);
    const offA2 = registerSelectionAction({ id: "t.a", label: "A2", run: () => {} });
    expect(selectionActions().filter((a) => a.id === "t.a").map((a) => a.label)).toEqual(["A2"]);
    offA(); // the replaced registration no longer removes anything
    expect(selectionActions().some((a) => a.id === "t.a")).toBe(true);
    offA2();
    offB();
    registerSelectionAction({ id: "t.c", label: "C", run: () => {} })();
    expect(selectionActions().filter((a) => a.id.startsWith("t."))).toEqual([]);
  });

  it("offers an action for Inbox works only when its kinds say so", () => {
    const offLib = registerSelectionAction({ id: "k.lib", label: "Library only", run: () => {} });
    const offBoth = registerSelectionAction({ id: "k.both", label: "Both", kinds: ["library", "inbox"], run: () => {} });
    const offInbox = registerSelectionAction({ id: "k.inbox", label: "Inbox only", kinds: ["inbox"], when: (c) => (c.itemIds?.length ?? 0) > 1, run: () => {} });
    const ids = (ctx: Parameters<typeof selectionActionsFor>[0]) => selectionActionsFor(ctx).map((a) => a.id).filter((id) => id.startsWith("k."));
    expect(ids({ workspaceId: "w", sourceIds: ["a"] })).toEqual(["k.lib", "k.both"]);
    expect(ids({ workspaceId: "w", kind: "inbox", sourceIds: [], itemIds: ["i1", "i2"] })).toEqual(["k.both", "k.inbox"]);
    expect(ids({ workspaceId: "w", kind: "inbox", sourceIds: [], itemIds: ["i1"] })).toEqual(["k.both"]);
    offLib();
    offBoth();
    offInbox();
  });
});
