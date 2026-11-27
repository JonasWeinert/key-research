import { describe, expect, it } from "vitest";
import { addConcept, addTerms, cleanQuery, describeQuery, emptyQuery, EXCLUDE, exportQuery, importQuery, looksBoolean, makeTerm, moveTerm, removeConcept, removeTerm, setBlockField, setFilters, splitTerms, TEMPLATES, updateTerm } from "./db-query";
import { parseBoolean } from "./db-search-mock";
import type { DbQuery } from "./db-search-api";

const texts = (q: DbQuery) => q.concepts.map((c) => c.terms.map((t) => t.text));

function twoConcepts() {
  let q = emptyQuery();
  q = addTerms(q, q.concepts[0].id, ["mindfulness", "meditation"].map((t) => makeTerm(t)));
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

describe("block edits", () => {
  it("builds concepts (AND) of synonyms (OR) and skips duplicates", () => {
    let q = twoConcepts();
    q = addTerms(q, q.concepts[0].id, [makeTerm("Mindfulness")]);
    expect(texts(q)).toEqual([["mindfulness", "meditation"], ["anxiety", "depress"]]);
    expect(q.concepts[1].label).toBe("Outcome");
  });
  it("moves a term between concepts and into the exclusions", () => {
    let q = twoConcepts();
    const meditation = q.concepts[0].terms[1];
    q = moveTerm(q, meditation.id, q.concepts[1].id, 0);
    expect(texts(q)).toEqual([["mindfulness"], ["meditation", "anxiety", "depress"]]);
    q = moveTerm(q, meditation.id, EXCLUDE);
    expect(q.exclude.map((t) => t.text)).toEqual(["meditation"]);
    expect(texts(q)[1]).toEqual(["anxiety", "depress"]);
  });
  it("edits and removes terms and concepts", () => {
    let q = twoConcepts();
    const id = q.concepts[0].terms[0].id;
    q = updateTerm(q, id, { field: "title", truncate: true });
    expect(q.concepts[0].terms[0]).toMatchObject({ field: "title", truncate: true });
    q = setBlockField(q, q.concepts[1].id, "subject");
    expect(q.concepts[1].terms.every((t) => t.field === "subject")).toBe(true);
    q = removeTerm(q, id);
    expect(texts(q)[0]).toEqual(["meditation"]);
    q = removeConcept(q, q.concepts[0].id);
    q = removeConcept(q, q.concepts[0].id);
    expect(q.concepts).toHaveLength(1);
    expect(q.concepts[0].terms).toEqual([]);
  });
  it("drops empty filters and blank terms before sending", () => {
    let q = setFilters(twoConcepts(), { yearFrom: 2015, types: [], openAccess: false });
    expect(q.filters).toEqual({ yearFrom: 2015 });
    q = addConcept(q, [makeTerm("  ")]);
    expect(cleanQuery(q).concepts).toHaveLength(2);
  });
});

describe("the query in words", () => {
  it("says what will be found", () => {
    const q = setFilters(twoConcepts(), { yearFrom: 2015, yearTo: 2026 });
    expect(describeQuery(q)).toBe("Find works about (mindfulness or meditation) and (anxiety or depress*), published 2015–2026.");
    const ex = { ...q, exclude: [makeTerm("protocol")], filters: { openAccess: true, languages: ["en"] } };
    expect(describeQuery(ex)).toBe("Find works about (mindfulness or meditation) and (anxiety or depress*), but not protocol, in English, free to read.");
    expect(describeQuery(emptyQuery())).toMatch(/Add a term/);
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
  it("accepts a bare query and lists of strings, and explains what is wrong", () => {
    expect(texts(importQuery(JSON.stringify({ concepts: [["a", "b*"], { terms: [{ text: "c", phrase: true }] }] })).query)).toEqual([["a", "b"], ["c"]]);
    expect(() => importQuery("not json")).toThrow(/not JSON/);
    expect(() => importQuery("{}")).toThrow(/no concepts/);
  });
  it("every template builds a query", () => {
    for (const t of TEMPLATES) expect(cleanQuery(t.build()).concepts.length).toBeGreaterThan(1);
  });
});

describe("pasted boolean strings", () => {
  it("tells a boolean query from a list of terms", () => {
    expect(looksBoolean("(a OR b) AND c")).toBe(true);
    expect(looksBoolean('"mindfulness"[tiab]')).toBe(true);
    expect(looksBoolean("anxiety\ndepression")).toBe(false);
  });
  it("reads a PubMed query into blocks", () => {
    const out = parseBoolean('("mindfulness"[tiab] OR meditat*[tiab] OR "Mindfulness"[MeSH Terms]) AND (anxiety[ti] OR depress*) NOT protocol[ti]');
    expect(out.raw).toBeUndefined();
    const q = out.query!;
    expect(texts(q)).toEqual([["mindfulness", "meditat", "Mindfulness"], ["anxiety", "depress"]]);
    expect(q.concepts[0].terms.map((t) => t.field)).toEqual(["title_abstract", "title_abstract", "subject"]);
    expect(q.concepts[0].terms[1].truncate).toBe(true);
    expect(q.concepts[1].terms[0].field).toBe("title");
    expect(q.exclude.map((t) => [t.text, t.field])).toEqual([["protocol", "title"]]);
  });
  it("reads Scopus and Web of Science field functions", () => {
    const scopus = parseBoolean('TITLE-ABS-KEY("cash transfer*" OR "social protection") AND TITLE(school*)').query!;
    expect(texts(scopus)).toEqual([["cash transfer", "social protection"], ["school"]]);
    expect(scopus.concepts[1].terms[0].field).toBe("title");
    expect(scopus.concepts[0].terms[0]).toMatchObject({ mode: "phrase", truncate: true });
    const wos = parseBoolean("TS=(obesity OR overweight) AND TS=(exercise)").query!;
    expect(texts(wos)).toEqual([["obesity", "overweight"], ["exercise"]]);
  });
  it("keeps what blocks cannot show as the database's own query", () => {
    const out = parseBoolean("(a AND b) OR c");
    expect(out.query).toBeUndefined();
    expect(out.raw).toBe("(a AND b) OR c");
    expect(out.error).toMatch(/kept/);
  });
});
