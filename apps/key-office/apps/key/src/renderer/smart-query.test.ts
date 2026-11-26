import { describe, expect, it } from "vitest";
import { detectQuery, readDoi, type Detection } from "./smart-query";

const brief = (d: Detection) => ({ id: d.id, filters: d.filters.map((f) => `${f.field}${f.op === "is" ? "=" : ` ${f.op} `}${f.value}`), kinds: d.kinds, rest: d.rest });
const first = (text: string, options = {}) => {
  const [d] = detectQuery(text, options);
  return d && brief(d);
};

describe("smart query detection", () => {
  it("reads a pasted DOI however it is written", () => {
    for (const text of ["10.1038/s41591-021-01384-9", "doi:10.1038/S41591-021-01384-9", "https://doi.org/10.1038/s41591-021-01384-9.", "DOI 10.1038/s41591-021-01384-9", "https://dx.doi.org/10.1038%2Fs41591-021-01384-9"])
      expect(first(text)).toEqual({ id: "doi", filters: ["doi=10.1038/s41591-021-01384-9"], kinds: undefined, rest: "" });
    expect(readDoi("(see doi:10.1016/S0140-6736(20)30183-5)")?.doi).toBe("10.1016/s0140-6736(20)30183-5");
    expect(first("malaria 10.1000/abc")?.rest).toBe("malaria");
    expect(first("see https://doi.org/10.5555/Interaction.2022.")?.rest).toBe("see");
  });

  it("reads arXiv, PubMed and ISBN identifiers and links", () => {
    expect(first("arXiv:1706.03762v7")?.filters).toEqual(["arxiv=1706.03762"]);
    expect(first("https://arxiv.org/abs/2101.00001")?.filters).toEqual(["arxiv=2101.00001"]);
    expect(first("1706.03762")?.filters).toEqual(["arxiv=1706.03762"]);
    expect(first("10.48550/arXiv.1706.03762")?.filters).toEqual(["arxiv=1706.03762"]);
    expect(first("PMID: 33599681")?.filters).toEqual(["pmid=33599681"]);
    expect(first("https://pubmed.ncbi.nlm.nih.gov/33599681/")?.filters).toEqual(["pmid=33599681"]);
    expect(first("33599681")?.filters).toEqual(["pmid=33599681"]);
    expect(first("pmc8190434")?.filters).toEqual(["pmcid=PMC8190434"]);
    expect(first("ISBN 978-0-262-03384-8")?.filters).toEqual(["isbn=9780262033848"]);
    expect(first("9780262033848")?.filters).toEqual(["isbn=9780262033848"]);
    expect(first("isbn 0-262-03384-4")?.filters).toEqual(["isbn=0262033844"]);
    // A number that fails the ISBN checksum is not one.
    expect(first("9780262033849")?.id).not.toBe("isbn");
    expect(first("https://www.nature.com/articles/s41591-021/")).toEqual({ id: "url", filters: ["url contains nature.com/articles/s41591-021"], kinds: undefined, rest: "" });
  });

  it("reads years and ranges of years", () => {
    expect(first("2015-2020")?.filters).toEqual(["year gte 2015", "year lte 2020"]);
    expect(first("malaria 2020–2015")).toEqual({ id: "years", filters: ["year gte 2015", "year lte 2020"], kinds: undefined, rest: "malaria" });
    expect(first(">2018")?.filters).toEqual(["year gte 2019"]);
    expect(first(">= 2018 trials")?.filters).toEqual(["year gte 2018"]);
    expect(first("since 2020")).toEqual({ id: "years", filters: ["year gte 2020"], kinds: undefined, rest: "" });
    expect(first("vaccines before 2010")).toEqual({ id: "years", filters: ["year lte 2009"], kinds: undefined, rest: "vaccines" });
    expect(first("malaria 2019")).toEqual({ id: "year", filters: ["year=2019"], kinds: undefined, rest: "malaria" });
    // A year alone is the store's suggestion already; other numbers are not years.
    expect(detectQuery("2019")).toEqual([]);
    expect(first("cohort of 3000 patients")).toBeUndefined();
  });

  it("reads citations as author and year", () => {
    expect(first("Narang 2021")).toEqual({ id: "citation", filters: ["creator contains Narang", "year=2021"], kinds: undefined, rest: "" });
    expect(first("Narang et al. 2021")?.filters).toEqual(["creator contains Narang", "year=2021"]);
    expect(first("Narang et al., (2021)")?.filters).toEqual(["creator contains Narang", "year=2021"]);
    expect(first("Smith and Jones 2019a")?.filters).toEqual(["creator contains Smith", "creator contains Jones", "year=2019"]);
    expect(first("van der Berg 2020")?.id).not.toBe("citation");
    expect(first("Since 2020")?.id).toBe("years");
    expect(first("malaria 2019")?.id).toBe("year");
  });

  it("reads a quoted phrase as the exact title", () => {
    expect(first('"Attention is all you need"')).toEqual({ id: "title", filters: ["title=Attention is all you need"], kinds: undefined, rest: "" });
    expect(first("“Deep learning” review")?.rest).toBe("review");
  });

  it("reads kinds of items", () => {
    expect(first("malaria pdfs")).toEqual({ id: "kind", filters: ["kind=pdf"], kinds: undefined, rest: "malaria" });
    expect(first("web pages about falls")).toEqual({ id: "kind", filters: ["kind=web"], kinds: undefined, rest: "about falls" });
    expect(first("notes on falls")).toBeUndefined();
    expect(first("notes on falls", { kinds: true })).toEqual({ id: "kind", filters: [], kinds: ["note"], rest: "on falls" });
  });

  it("names tags and collections within a longer query", () => {
    const known = { tags: ["to read", "review"], collections: [{ id: "c1", name: "Falls project" }] };
    expect(first("to read malaria", { known })).toEqual({ id: "tag", filters: ["tag=to read"], kinds: undefined, rest: "malaria" });
    expect(first("#review sepsis", { known })?.filters).toEqual(["tag=review"]);
    expect(first("#unknown sepsis", { known })?.filters).toEqual(["tag=unknown"]);
    expect(first("Falls project video", { known })).toEqual({ id: "collection", filters: ["collection=c1"], kinds: undefined, rest: "video" });
    // The whole query as a name is already the store's suggestion; part of a word is no name.
    expect(detectQuery("review", { known })).toEqual([]);
    expect(first("reviewers agree", { known })).toBeUndefined();
  });

  it("offers every reading at once when there are several", () => {
    const [all, ...each] = detectQuery("pdf since 2020 malaria");
    expect(brief(all)).toEqual({ id: "all", filters: ["year gte 2020", "kind=pdf"], kinds: undefined, rest: "malaria" });
    expect(each.map((d) => d.id)).toEqual(["years", "kind"]);
  });

  it("leaves plain text alone", () => {
    for (const text of ["deep learning", "falls in memory care", "ab", "covid 19 vaccines"]) expect(detectQuery(text)).toEqual([]);
  });
});
