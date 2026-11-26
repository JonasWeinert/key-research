// The analysis and plans themselves are tested in Rust (key-store tag_analysis_tests.rs);
// this covers what the manager still does itself: its tree (form defaults come from the host).
import { describe, expect, it } from "vitest";
import type { TagIndex } from "./tag-analysis";
import { buildTree, sortTree, visibleRows } from "./tag-plan";

function indexOf(itemTags: string[][], tree: TagIndex["tree"] = {}): TagIndex {
  const names: string[] = [];
  const at = new Map<string, number>();
  const items = itemTags.map((tags, i) => ({
    id: `s${i}`,
    title: `Item ${i}`,
    tags: tags.map((t) => {
      if (!at.has(t)) {
        at.set(t, names.length);
        names.push(t);
      }
      return at.get(t)!;
    }),
  }));
  const counts = names.map((_, i) => items.filter((it) => it.tags.includes(i)).length);
  return { tags: names.map((name, i) => ({ name, count: counts[i] })), items, sourceCount: items.length, tree };
}

describe("tag manager tree", () => {
  it("nests by the store's tree, without cycles, with totals", () => {
    const index = indexOf([["Surveys", "Methods"], ["Surveys"], ["Interviews"]], { Surveys: { parent: "Methods" }, Methods: { parent: "Surveys" }, Interviews: { parent: "Methods" } });
    const tree = buildTree(index);
    expect(tree.nodes.get("methods")?.children.map((c) => c.name).sort()).toEqual(["Interviews", "Surveys"]);
    expect(tree.nodes.get("methods")?.total).toBe(3);
    expect(tree.roots.map((r) => r.name)).toEqual(["Methods"]);
  });

  it("filters rows with their ancestors", () => {
    const tree = buildTree(indexOf([["Surveys"], ["Other"]], { Surveys: { parent: "Methods" } }));
    const rows = visibleRows(sortTree(tree.roots, "name"), new Set(), "surv");
    expect(rows.map((r) => r.name)).toEqual(["Methods", "Surveys"]);
  });

});
