import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Highlight, filterTerms, hasMatch, queryPattern } from "./search-highlight";

const marked = (text: string, ...queries: string[]) => renderToStaticMarkup(<Highlight text={text} pattern={queryPattern(...queries)} />);

describe("highlighting query words", () => {
  it("matches whole words without case or accents, the last word as a prefix", () => {
    expect(marked("Gödel and the Machine", "godel machi")).toBe("<mark>Gödel</mark> and the <mark>Machine</mark>");
    expect(marked("Attention heads", "attention ")).toBe("<mark>Attention</mark> heads");
    expect(marked("Pretension", "tension")).toBe("Pretension");
    expect(queryPattern("the of")).toBeUndefined();
  });
  it("marks a quoted phrase as one", () => {
    expect(marked("Deep learning, and learning deep", '"deep learning"')).toBe("<mark>Deep learning</mark>, and learning deep");
    expect(marked("Deep-learning works", '"deep learning" works')).toBe("<mark>Deep-learning</mark> <mark>works</mark>");
  });
  it("adds the words of filter tokens", () => {
    const terms = filterTerms([
      { field: "creator", op: "contains", value: "Vaswani", label: "Vaswani" },
      { field: "venue", value: "v1", label: "Neural Information Processing Systems" },
      { field: "doi", value: "10.1/abc", label: "10.1/abc" },
      { field: "tag", value: "covid", label: "covid" },
      { field: "year", op: "gte", value: "2018", label: "2018 or later" },
      { field: "collection", value: "c1", label: "Reading" },
    ]);
    const pattern = queryPattern("", terms);
    expect(hasMatch("A. Vaswani", pattern)).toBe(true);
    expect(hasMatch("Neural Information Processing Systems", pattern)).toBe(true);
    expect(hasMatch("Information", pattern)).toBe(false);
    expect(hasMatch("doi 10.1/abc", pattern)).toBe(true);
    expect(hasMatch("10 things", pattern)).toBe(false);
    expect(hasMatch("2018", pattern)).toBe(false);
    expect(hasMatch("Reading", pattern)).toBe(false);
  });
});
