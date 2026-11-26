import { describe, expect, it } from "vitest";
import type { TagIndex } from "./tag-analysis";
import { applyLocally, buildTree, sortTree } from "./tag-plan";

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

describe("applyLocally", () => {
  it("merges names on items and clears tree entries", () => {
    const next = applyLocally(index, [{ replace: [{ from: "ML", to: ["Machine learning"] }], tree: { ML: null, "Machine learning": { parent: "Methods" } } }]);
    expect(next.tags).toEqual([
      { name: "Machine learning", count: 2 },
      { name: "Methods", count: 2 },
    ]);
    expect(next.items.map((i) => i.tags.map((t) => next.tags[t].name))).toEqual([["Machine learning", "Methods"], ["Machine learning"], ["Methods"]]);
    expect(next.tree).toEqual({ "Machine learning": { parent: "Methods" } });
  });

  it("only moves the tree for a nest, and drops removed tags", () => {
    const nested = applyLocally(index, [{ replace: [], tree: { "Machine learning": { parent: "Methods" } } }]);
    expect(nested.tags).toBe(index.tags);
    expect(buildTree(nested).nodes.get("machine learning")?.parent).toBe("Methods");
    const removed = applyLocally(index, [{ replace: [{ from: "Methods", to: [] }], tree: {} }]);
    expect(removed.tags.map((t) => t.name)).toEqual(["ML", "Machine learning"]);
  });

  it("sorts names naturally", () => {
    const tree = buildTree({ ...index, tags: [{ name: "b10", count: 1 }, { name: "B2", count: 1 }, { name: "a", count: 1 }], items: [], tree: {} });
    expect(sortTree(tree.roots, "name").map((n) => n.name)).toEqual(["a", "B2", "b10"]);
  });
});
