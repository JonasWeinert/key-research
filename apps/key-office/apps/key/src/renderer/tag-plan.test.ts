import { describe, expect, it } from "vitest";
import type { TagIndex } from "./tag-analysis";
import { applyPrediction, buildTree, sortTree } from "./tag-plan";

const index: TagIndex = {
  tags: [
    { name: "ML", count: 2 },
    { name: "Machine learning", count: 1 },
    { name: "Methods", count: 2 },
  ],
  items: [
    { id: "a", title: "A", tags: [0, 2] },
    { id: "b", title: "B", tags: [0, 1] },
    { id: "c", title: "C", tags: [2] },
  ],
  sourceCount: 3,
  tree: { ML: { parent: "Methods" } },
};

describe("applyPrediction", () => {
  it("applies the host's item edits and tree entries", () => {
    const next = applyPrediction(index, [
      {
        items: [
          { id: "a", remove: ["ML"], add: ["Machine learning"] },
          { id: "b", remove: ["ML"], add: [] },
        ],
        tree: { ML: null, "Machine learning": { parent: "Methods" } },
      },
    ]);
    expect(next.tags).toEqual([
      { name: "Machine learning", count: 2 },
      { name: "Methods", count: 2 },
    ]);
    expect(next.items.map((i) => i.tags.map((t) => next.tags[t].name))).toEqual([["Methods", "Machine learning"], ["Machine learning"], ["Methods"]]);
    expect(next.tree).toEqual({ "Machine learning": { parent: "Methods" } });
  });

  it("only moves the tree when no item changes, and composes predictions", () => {
    const nested = applyPrediction(index, [{ items: [], tree: { "Machine learning": { parent: "Methods" } } }]);
    expect(nested.tags).toBe(index.tags);
    expect(buildTree(nested).nodes.get("machine learning")?.parent).toBe("Methods");
    const both = applyPrediction(index, [
      { items: [{ id: "a", remove: ["Methods"], add: [] }, { id: "c", remove: ["Methods"], add: [] }], tree: {} },
      { items: [{ id: "b", remove: ["Machine learning"], add: [] }], tree: {} },
    ]);
    expect(both.tags.map((t) => t.name)).toEqual(["ML"]);
  });
  it("sorts names naturally", () => {
    const tree = buildTree({ ...index, tags: [{ name: "b10", count: 1 }, { name: "B2", count: 1 }, { name: "a", count: 1 }], items: [], tree: {} });
    expect(sortTree(tree.roots, "name").map((n) => n.name)).toEqual(["a", "B2", "b10"]);
  });
});
