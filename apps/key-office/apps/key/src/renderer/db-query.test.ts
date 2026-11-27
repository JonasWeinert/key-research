import { describe, expect, it } from "vitest";
import { addConcept, addTerms, cleanQuery, describeQuery, emptyQuery, exportQuery, findNode, importQuery, joinerAt, looksBoolean, makeTerm, moveNode, readQuery, removeNode, setFilters, setGroupField, setJoiner, splitTerms, TEMPLATES, terms, ungroup, updateNode, wrapNodes } from "./db-query";
import { parseBoolean } from "./db-search-mock";
import type { DbQuery, QGroup, QNode } from "./db-search-api";

const groups = (q: DbQuery) => q.expr.items.filter((n): n is QGroup => n.type === "group");
const texts = (q: DbQuery) => q.expr.items.map((n) => terms(n).map((t) => t.text));
/** The tree in a compact text form, to compare shapes. */
const shape = (n: QNode): string => (n.type === "term" ? `${n.not ? "!" : ""}${n.text}` : `${n.not ? "!" : ""}${n.op}(${n.items.map(shape).join(" ")})`);

function twoConcepts() {
  let q = emptyQuery();
  q = addTerms(q, q.expr.items[0].id, ["mindfulness", "meditation"].map((t) => makeTerm(t)));
  q = addConcept(q, ["anxiety", "depress*"].map((t) => makeTerm(t)), "Outcome");
  return q;
}

describe("terms", () => {
  it("reads phrases and truncation from what was typed", () => {
    expect(makeTerm('"social capital"')).toMatchObject({ text: "social capital", mode: "phrase", truncate: false });
    expect(makeTerm("child*")).toMatchObject({ text: "child", mode: "words", truncate: true });
    expect(makeTerm("young people")).toMatchObject({ mode: "phrase" });
  });
  it("splits a pasted list", () => {
    expect(splitTerms("anxiety\ndepression\n\n- stress\nanxiety")).toEqual(["anxiety", "depression", "stress"]);
    expect(splitTerms("a OR b OR c")).toEqual(["a", "b", "c"]);
    expect(splitTerms("a, b; c")).toEqual(["a, b", "c"]);
    expect(splitTerms("a, b")).toEqual(["a", "b"]);
  });
});

describe("tree edits", () => {
  it("builds concepts (AND) of synonyms (OR) and skips duplicates", () => {
    let q = twoConcepts();
    q = addTerms(q, q.expr.items[0].id, [makeTerm("Mindfulness")]);
    expect(texts(q)).toEqual([["mindfulness", "meditation"], ["anxiety", "depress"]]);
    expect(groups(q)[1].label).toBe("Outcome");
    expect(shape(q.expr)).toBe("and(or(mindfulness meditation) or(anxiety depress))");
  });
  it("moves a term between groups and into nested ones", () => {
    let q = twoConcepts();
    const [first, second] = groups(q);
    const meditation = first.items[1];
    q = moveNode(q, meditation.id, second.id, 0);
    expect(texts(q)).toEqual([["mindfulness"], ["meditation", "anxiety", "depress"]]);
    // Into a group inside a group; never into itself.
    q = addTerms(q, second.id, [{ type: "group", id: "inner", op: "and", items: [] }]);
    q = moveNode(q, meditation.id, "inner");
    expect(shape(q.expr)).toBe("and(or(mindfulness) or(anxiety depress and(meditation)))");
    expect(moveNode(q, second.id, "inner")).toBe(q);
  });
  it("changes the operator between two items, grouping where needed", () => {
    let q = twoConcepts();
    const first = groups(q)[0];
    // Two items: the group's operator changes.
    q = setJoiner(q, first.id, 1, "and");
    expect(shape(q.expr)).toMatch(/^and\(and\(mindfulness meditation\)/);
    q = setJoiner(q, first.id, 1, "not");
    expect(joinerAt(findNode(q.expr, first.id)!.node as QGroup, 1)).toBe("not");
    // More items: read left to right, what comes before the word is bracketed.
    let r = emptyQuery();
    const card = r.expr.items[0].id;
    r = addTerms(r, card, ["AI", "ML", "regression"].map((t) => makeTerm(t)));
    r = setJoiner(r, card, 2, "not");
    expect(shape(r.expr)).toBe("and(and(or(AI ML) !regression))");
    r = setJoiner(r, card, 1, "and");
    expect(shape(r.expr)).toBe("and(and(or(AI ML) regression))");
    let s = emptyQuery();
    s = addTerms(s, s.expr.items[0].id, ["a", "b", "c", "d"].map((t) => makeTerm(t)));
    s = setJoiner(s, s.expr.items[0].id, 2, "and");
    expect(shape(s.expr)).toBe("and(or(and(or(a b) c) d))");
  });
  it("wraps, ungroups, negates and removes", () => {
    let q = twoConcepts();
    const [first, second] = groups(q);
    q = wrapNodes(q, [first.items[0].id]);
    expect(shape(q.expr)).toBe("and(or(and(mindfulness) meditation) or(anxiety depress))");
    const inner = (q.expr.items[0] as QGroup).items[0];
    q = ungroup(q, inner.id);
    expect(shape(q.expr)).toBe("and(or(mindfulness meditation) or(anxiety depress))");
    q = wrapNodes(q, [first.id, second.id]);
    expect(shape(q.expr)).toBe("and(or(or(mindfulness meditation) or(anxiety depress)))");
    q = updateNode(q, (q.expr.items[0] as QGroup).id, { not: true });
    expect(shape(q.expr)).toMatch(/^and\(!or/);
    q = removeNode(q, q.expr.items[0].id);
    expect(q.expr.items).toHaveLength(1);
    expect(terms(q.expr)).toEqual([]);
  });
  it("sets a field for a whole group", () => {
    let q = twoConcepts();
    q = setGroupField(q, groups(q)[1].id, "subject");
    expect(terms(groups(q)[1]).every((t) => t.field === "subject")).toBe(true);
  });
  it("drops empty filters and blank terms before sending", () => {
    let q = setFilters(twoConcepts(), { yearFrom: 2015, types: [], openAccess: false });
    expect(q.filters).toEqual({ yearFrom: 2015 });
    q = addConcept(q, [makeTerm("  ")]);
    expect(cleanQuery(q).expr.items).toHaveLength(2);
  });
});

describe("older shapes", () => {
  it("reads concepts and exclusions as a tree", () => {
    const q = readQuery({ concepts: [{ label: "P", terms: [{ text: "a" }, { text: "b" }] }], exclude: [{ text: "c" }], filters: { yearFrom: 2000 } });
    expect(shape(q.expr)).toBe("and(or(a b) !c)");
    expect(q.filters).toEqual({ yearFrom: 2000 });
  });
  it("reads a host tree without ids", () => {
    const q = readQuery({ expr: { type: "group", op: "and", items: [{ type: "term", text: "x", field: "title" }, { type: "group", op: "or", not: true, items: [{ type: "term", text: "y" }] }] } });
    expect(shape(q.expr)).toBe("and(x !or(y))");
    expect(terms(q.expr).every((t) => t.id)).toBe(true);
  });
});

describe("the query in words", () => {
  it("says what will be found", () => {
    const q = setFilters(twoConcepts(), { yearFrom: 2015, yearTo: 2026 });
    expect(describeQuery(q)).toBe("Find works about (mindfulness or meditation) and (anxiety or depress*), published 2015–2026.");
    const ex = setFilters(addTerms(q, q.expr.id, [{ ...makeTerm("protocol"), not: true }]), { yearFrom: undefined, yearTo: undefined, openAccess: true, languages: ["en"] });
    expect(describeQuery(ex)).toBe("Find works about (mindfulness or meditation) and (anxiety or depress*), but not protocol, in English, free to read.");
    expect(describeQuery(emptyQuery())).toMatch(/Add a term/);
  });
  it("reads nested logic", () => {
    const t = TEMPLATES.find((x) => x.id === "nested")!.build();
    expect(describeQuery(t)).toMatch(/\(health or doctor\*\) and \(\(“artificial intelligence” or “machine learning”\) but not regression\)/);
  });
});

describe("import and export", () => {
  it("round-trips a query with its databases and overrides", () => {
    const q = setFilters(twoConcepts(), { yearFrom: 2010, types: ["article"] });
    const text = exportQuery(q, { name: "Mindfulness", connectors: ["pubmed"], overrides: { pubmed: "x[tiab]" } });
    const back = importQuery(text);
    expect(texts(back.query)).toEqual(texts(q));
    expect(back.query.filters).toEqual({ yearFrom: 2010, types: ["article"] });
    expect(back).toMatchObject({ name: "Mindfulness", connectors: ["pubmed"], overrides: { pubmed: "x[tiab]" } });
  });
  it("accepts older files, bare queries and exported strategies, and explains what is wrong", () => {
    expect(texts(importQuery(JSON.stringify({ concepts: [["a", "b*"], { terms: [{ text: "c", phrase: true }] }] })).query)).toEqual([["a", "b"], ["c"]]);
    const strategy = { format: "key-search-strategy", version: 1, label: "Rerun", rerun: { query: { expr: { type: "group", op: "and", items: [{ type: "term", text: "z" }] } }, connectors: ["openalex"] } };
    expect(importQuery(JSON.stringify(strategy))).toMatchObject({ name: "Rerun", connectors: ["openalex"] });
    expect(() => importQuery("not json")).toThrow(/not JSON/);
    expect(() => importQuery("{}")).toThrow(/no concepts/);
  });
  it("every template builds a query", () => {
    for (const t of TEMPLATES) expect(cleanQuery(t.build()).expr.items.length).toBeGreaterThan(1);
  });
});

describe("pasted boolean strings (sample engine)", () => {
  it("tells a boolean query from a list of terms", () => {
    expect(looksBoolean("(a OR b) AND c")).toBe(true);
    expect(looksBoolean('"mindfulness"[tiab]')).toBe(true);
    expect(looksBoolean("anxiety\ndepression")).toBe(false);
  });
  it("reads a PubMed query into blocks", () => {
    const out = parseBoolean('("mindfulness"[tiab] OR meditat*[tiab] OR "Mindfulness"[MeSH Terms]) AND (anxiety[ti] OR depress*) NOT protocol[ti]');
    expect(out.raw).toBeUndefined();
    const q = out.query!;
    expect(shape(q.expr)).toBe("and(or(mindfulness meditat Mindfulness) or(anxiety depress) !protocol)");
    expect(terms(q.expr).map((t) => t.field)).toEqual(["title_abstract", "title_abstract", "subject", "title", "title_abstract", "title"]);
  });
});
