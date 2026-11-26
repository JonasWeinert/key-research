import { describe, expect, it } from "vitest";
import { analyzeTags, editDistance, jaroWinkler, normalize, splitPath, type TagIndex } from "./tag-analysis";
import { buildTree, planChange } from "./tag-plan";

/** An index from items written as tag lists. */
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

const repeat = <T,>(n: number, value: T) => Array.from({ length: n }, () => value);

const messy = () =>
  indexOf([
    ...repeat(6, ["Machine learning", "Methods"]),
    ...repeat(2, ["machine-learning", "Methods"]),
    ["machine learnings"],
    ...repeat(3, ["ML"]),
    ...repeat(4, ["status: read"]),
    ...repeat(2, ["status: to read"]),
    ["status: reading"],
    ...repeat(5, ["Deep learning", "Neural networks"]),
    ...repeat(4, ["Surveys", "Methods"]),
    ...repeat(3, ["Interviews", "Methods"]),
    ...repeat(2, ["RCT", "Methods"]),
    ...repeat(3, ["_tablet"]),
    ["1234"],
    ["https://example.org/x"],
    ...repeat(3, ["Behaviour"]),
    ["Behavior"],
  ]);

describe("tag normalisation", () => {
  it("folds case, diacritics, separators, plurals and spelling", () => {
    expect(normalize("Machine-Learning").squash).toBe(normalize("machine learnings").squash);
    expect(normalize("Économie").squash).toBe("economie");
    expect(normalize("#Policies").squash).toBe("policy");
    expect(normalize("behaviour").squash).toBe(normalize("Behavior").squash);
    expect(normalize("Analysis").squash).toBe("analysis");
  });
  it("splits names that spell out a path", () => {
    expect(splitPath("methods/survey")).toEqual(["methods", "survey"]);
    expect(splitPath("Topic::Health::Insurance")).toEqual(["Topic", "Health", "Insurance"]);
    expect(splitPath("status: read")).toEqual(["status", "read"]);
    expect(splitPath("Covid - Lockdown")).toEqual(["Covid", "Lockdown"]);
    expect(splitPath("self-employment")).toBeUndefined();
    expect(splitPath("https://x.org/a")).toBeUndefined();
  });
  it("measures similarity", () => {
    expect(editDistance("modeling", "modelling")).toBe(1);
    expect(editDistance("abcd", "abdc")).toBe(1);
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961, 2);
  });
});

describe("tag analysis", () => {
  const suggestions = analyzeTags(messy());
  const find = (kind: string, test: (s: (typeof suggestions)[number]) => boolean) => suggestions.filter((s) => s.kind === kind).find(test);

  it("merges variants and initialisms into the most used name", () => {
    const merge = find("merge", (s) => s.tags.includes("machine-learning"));
    expect(merge?.plan).toEqual({ type: "merge", from: ["machine learnings", "machine-learning", "ML"].sort((a, b) => a.localeCompare(b)), to: "Machine learning" });
    expect(merge?.items).toBe(12);
    expect(find("merge", (s) => s.tags.includes("Behavior"))?.plan).toMatchObject({ to: "Behaviour" });
    expect(find("merge", (s) => s.tags.includes("status: to read"))).toBeUndefined();
  });

  it("reads delimiter families as hierarchy and as a property", () => {
    expect(find("hierarchy", (s) => s.tags.includes("status: read"))?.plan).toMatchObject({ type: "hierarchy" });
    const property = find("property", (s) => s.tags.includes("status: to read"));
    expect(property?.plan).toMatchObject({ type: "property", name: "Status", propertyType: "select" });
    expect((property?.plan as { values: [string, string][] }).values).toContainEqual(["status: to read", "To read"]);
  });

  it("finds subsumption, togetherness, flags, methods and junk", () => {
    expect(find("nest", (s) => s.plan.type === "nest" && s.plan.parent === "Methods")?.plan).toMatchObject({ children: expect.arrayContaining(["Surveys", "Interviews"]) });
    expect(find("merge", (s) => s.tags.includes("Deep learning") && s.tags.includes("Neural networks"))).toBeTruthy();
    expect(find("property", (s) => s.tags[0] === "_tablet")?.plan).toMatchObject({ propertyType: "boolean", name: "Tablet" });
    expect(find("property", (s) => s.title.includes("Method"))?.tags).toEqual(expect.arrayContaining(["Surveys", "Interviews", "RCT"]));
    expect(find("cleanup", (s) => s.tags.includes("1234"))?.tags).toEqual(expect.arrayContaining(["1234", "https://example.org/x"]));
  });

  it("is deterministic and remembers dismissals", () => {
    const again = analyzeTags(messy());
    expect(again.map((s) => s.id)).toEqual(suggestions.map((s) => s.id));
    const dismissed = new Set([suggestions[0].id]);
    expect(analyzeTags(messy(), { dismissed }).some((s) => s.id === suggestions[0].id)).toBe(false);
  });

  it("offers to merge into an existing property", () => {
    const s = analyzeTags(messy(), { properties: [{ name: "status", type: "select", options: ["Read"] }] }).find((x) => x.kind === "property" && x.tags.includes("status: read"));
    expect(s?.plan).toMatchObject({ name: "status" });
    expect(s?.title).toContain("to the “status” property");
  });

  it("stays fast on a large messy library", () => {
    const words = "health economics policy insurance labour market climate energy migration education poverty inequality trade finance banking housing urban rural gender ageing".split(" ");
    const tags = Array.from({ length: 5000 }, (_, i) => `${words[i % words.length]} ${words[(i * 7) % words.length]} ${i % 3 ? "" : "s"}${i}`);
    const items = Array.from({ length: 5000 }, (_, i) => [tags[i], tags[(i * 13) % 5000], tags[(i * 31) % 5000], tags[i % 50]]);
    const index = indexOf(items);
    const start = performance.now();
    analyzeTags(index);
    expect(performance.now() - start).toBeLessThan(4000);
  });
});

describe("tag plans", () => {
  it("merges with the tree kept in step", () => {
    const index = messy();
    index.tree = { "machine-learning": { parent: "AI" }, Child: { parent: "ML" } };
    const change = planChange({ type: "merge", from: ["ML", "machine-learning"], to: "Machine learning" }, index);
    expect(change.operation.replace).toEqual([
      { from: "ML", to: ["Machine learning"] },
      { from: "machine-learning", to: ["Machine learning"] },
    ]);
    expect(change.operation.tree).toEqual({ "machine-learning": null, "Machine learning": { parent: "AI" }, Child: { parent: "Machine learning" } });
    expect(change.items).toBe(5);
  });

  it("splits delimiter paths into nested short names", () => {
    const change = planChange({ type: "hierarchy", splits: [{ tag: "status: read", path: ["status", "read"] }, { tag: "status: to read", path: ["status", "to read"] }] }, messy());
    expect(change.operation.replace).toEqual([
      { from: "status: read", to: ["read"] },
      { from: "status: to read", to: ["to read"] },
    ]);
    expect(change.operation.tree).toMatchObject({ status: {}, read: { parent: "status" }, "to read": { parent: "status" } });
  });

  it("nests without cycles and builds totals", () => {
    const index = messy();
    index.tree = { Surveys: { parent: "Methods" } };
    expect(() => planChange({ type: "nest", parent: "Surveys", children: ["Methods"] }, index)).toThrow();
    const tree = buildTree(index);
    expect(tree.nodes.get("methods")?.children.map((c) => c.name)).toEqual(["Surveys"]);
    expect(tree.nodes.get("methods")?.total).toBe(tree.nodes.get("methods")?.count);
    const abstract = planChange({ type: "nest", parent: "Learning", children: ["Machine learning", "Deep learning"] }, index);
    expect(abstract.operation.tree).toEqual({ Learning: {}, "Machine learning": { parent: "Learning" }, "Deep learning": { parent: "Learning" } });
  });

  it("converts to a property and removes tags", () => {
    const change = planChange({ type: "property", name: "Tablet", propertyType: "boolean", values: [["_tablet", true]], removeTags: true }, messy());
    expect(change.operation.property).toEqual({ name: "Tablet", config: { type: "boolean" }, values: [["_tablet", true]], removeTags: true });
    expect(change.items).toBe(3);
    const del = planChange({ type: "delete", tags: ["1234"] }, messy());
    expect(del.operation.replace).toEqual([{ from: "1234", to: [] }]);
  });
});
