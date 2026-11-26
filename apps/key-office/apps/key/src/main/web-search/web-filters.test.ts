import { describe, expect, it, vi } from "vitest";
import { activeWebFilters, meetsWebFilters, pickWebFilters, toWebFilters, webFilterKey, type FilterToken } from "../../shared/web-filters";
import type { WebResult } from "../../shared/web-search";
import { WebSearch, applicable, filterPlan } from "./index";
import { openAlexFilter, openalex } from "./openalex";
import { s2Params, s2PaperId, semanticScholar } from "./semantic-scholar";
import openalexFixture from "./fixtures/openalex-search.json";
import s2Fixture from "./fixtures/s2-search.json";

const token = (field: string, value: string, op?: string, label = value): FilterToken => ({ field, value, op, label });
const work = (over: Partial<WebResult>): WebResult => ({ provider: "a", providerId: "1", title: "A study of attention", authors: ["Ashish Vaswani", "Noam Shazeer"], ids: {}, ...over });

describe("search tokens as web filters", () => {
  it("knows which tokens the web can apply", () => {
    expect(webFilterKey(token("creator", "Smith", "contains"))).toBe("author");
    expect(webFilterKey(token("person", "p1", "is", "Jane Smith"))).toBe("author");
    expect(webFilterKey(token("container", "Nature"))).toBe("venue");
    expect(webFilterKey(token("workType", "preprint"))).toBe("type");
    expect(webFilterKey(token("itemType", "software"))).toBeUndefined();
    for (const field of ["tag", "collection", "notes", "fulltext", "item", "kind", "property", "url", "isbn"]) expect(webFilterKey(token(field, "x"))).toBeUndefined();
  });
  it("turns tokens into filters", () => {
    expect(
      toWebFilters([
        token("year", "2018", "gte"),
        token("year", "2021", "lte"),
        token("creator", "Vaswani", "contains"),
        token("person", "p9", "is", "Noam Shazeer"),
        token("title", "attention", "contains"),
        token("venue", "v1", "is", "NeurIPS"),
        token("doi", "10.1/ABC"),
        token("oaStatus", "gold"),
        token("workType", "book-chapter"),
        token("citations", "100", "gt"),
        token("tag", "covid"),
      ]),
    ).toEqual({ yearFrom: 2018, yearTo: 2021, authors: ["Vaswani", "Noam Shazeer"], title: "attention", venue: "NeurIPS", doi: "10.1/abc", openAccess: true, oaStatus: "gold", type: "chapter", minCitations: 101 });
    expect(toWebFilters([token("year", "2019")])).toEqual({ yearFrom: 2019, yearTo: 2019 });
    expect(toWebFilters([token("year", "2019", "gt")])).toEqual({ yearFrom: 2020 });
    expect(toWebFilters([token("oaStatus", "closed")])).toEqual({ openAccess: false });
    expect(activeWebFilters({ yearTo: 2000, authors: ["x"], retracted: false })).toEqual(["year", "author", "retracted"]);
    expect(pickWebFilters({ yearFrom: 1, title: "t", venue: "v" }, ["year", "venue"])).toEqual({ yearFrom: 1, venue: "v" });
  });
  it("checks a result against filters", () => {
    expect(meetsWebFilters(work({ year: 2017 }), { yearFrom: 2015, yearTo: 2018 }, ["year"])).toBe(true);
    expect(meetsWebFilters(work({ year: 2019 }), { yearFrom: 2015, yearTo: 2018 }, ["year"])).toBe(false);
    expect(meetsWebFilters(work({}), { authors: ["vaswani"] }, ["author"])).toBe(true);
    expect(meetsWebFilters(work({}), { authors: ["Väswani", "Parmar"] }, ["author"])).toBe(false);
    expect(meetsWebFilters(work({ venue: "Neural Information Processing Systems" }), { venue: "information processing" }, ["venue"])).toBe(true);
    expect(meetsWebFilters(work({}), { title: "attention" }, ["title"])).toBe(true);
    expect(meetsWebFilters(work({ openAccess: false }), { openAccess: true }, ["openAccess"])).toBe(false);
    expect(meetsWebFilters(work({ openAccess: true, oaStatus: "green" }), { openAccess: true, oaStatus: "gold" }, ["openAccess"])).toBe(false);
    expect(meetsWebFilters(work({ type: "proceedings-article" }), { type: "conference-paper" }, ["type"])).toBe(true);
    expect(meetsWebFilters(work({ citedBy: 50 }), { minCitations: 100 }, ["citations"])).toBe(false);
    expect(meetsWebFilters(work({ ids: { arxiv: "1706.03762" } }), { arxiv: "1706.03762" }, ["arxiv"])).toBe(true);
  });
});

describe("OpenAlex filters", () => {
  it("maps each filter onto the filter parameter", () => {
    expect(
      openAlexFilter({ yearFrom: 2018, yearTo: 2021, authors: ["Vaswani, A."], title: "attention: all", doi: "10.1/x", openAccess: true, oaStatus: "gold", type: "chapter", minCitations: 10, maxCitations: 99, abstract: "transformer", language: "en", retracted: false }),
    ).toEqual([
      "publication_year:2018-2021",
      "raw_author_name.search:Vaswani A.",
      "title.search:attention all",
      "abstract.search:transformer",
      "doi:https://doi.org/10.1/x",
      "oa_status:gold",
      "type:book-chapter",
      "cited_by_count:>9",
      "cited_by_count:<100",
      "language:en",
      "is_retracted:false",
    ]);
    expect(openAlexFilter({ yearFrom: 2019, yearTo: 2019 })).toEqual(["publication_year:2019"]);
    expect(openAlexFilter({ arxiv: "1706.03762", pmid: "123", type: "conference-paper", openAccess: false })).toEqual([
      "doi:https://doi.org/10.48550/arxiv.1706.03762",
      "pmid:123",
      "is_oa:false",
      "primary_location.source.type:conference",
    ]);
  });
  it("searches by filters alone without words", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(openalexFixture)));
    await openalex.search("", { limit: 5, filters: { authors: ["Vaswani"] } }, { mailto: "m", fetch });
    const url = new URL((fetch.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.has("search")).toBe(false);
    expect(url.searchParams.get("filter")).toBe("raw_author_name.search:Vaswani");
  });
  it("applies everything but venues itself", () => {
    expect(filterPlan(openalex, { venue: "Nature", authors: ["x"], language: "de" })).toEqual({ active: ["author", "venue", "language"], local: ["venue"], unsupported: [] });
  });
});

describe("Semantic Scholar filters", () => {
  it("maps filters onto search parameters", () => {
    expect(s2Params({ yearFrom: 2018, yearTo: 2021, venue: "Nature, Medicine", openAccess: true, type: "conference-paper", minCitations: 5 })).toEqual({
      year: "2018-2021",
      venue: "Nature  Medicine",
      openAccessPdf: "",
      publicationTypes: "Conference",
      minCitationCount: "5",
    });
    expect(s2Params({ yearTo: 2000, type: "thesis" })).toEqual({ year: "-2000" });
    expect(s2PaperId({ doi: "10.1/x" })).toBe("DOI:10.1/x");
    expect(s2PaperId({ pmcid: "PMC123" })).toBe("PMCID:123");
  });
  it("looks a DOI up instead of searching", async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify(s2Fixture.data[1])));
    const page = await semanticScholar.search("anything", { limit: 10, filters: { doi: "10.18653/v1/n19-1423" } }, { mailto: "", fetch });
    expect(new URL(fetch.mock.calls[0][0]).pathname).toBe("/graph/v1/paper/DOI:10.18653/v1/n19-1423");
    expect(page.results.map((r) => r.doi)).toEqual(["10.18653/v1/n19-1423"]);
    const missing = vi.fn(async () => new Response("{}", { status: 404 }));
    expect((await semanticScholar.search("x", { limit: 10, filters: { doi: "10.1/none" } }, { mailto: "", fetch: missing })).results).toEqual([]);
  });
  it("uses the filter words when there are no others", async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ data: [] })));
    await semanticScholar.search("", { limit: 10, filters: { authors: ["Vaswani"], yearFrom: 2017 } }, { mailto: "", fetch });
    const params = new URL(fetch.mock.calls[0][0]).searchParams;
    expect(params.get("query")).toBe("Vaswani");
    expect(params.get("year")).toBe("2017-");
  });
  it("cannot tell languages or retractions", () => {
    expect(filterPlan(semanticScholar, { language: "de", authors: ["x"], yearFrom: 1 })).toEqual({ active: ["year", "author", "language"], local: ["author"], unsupported: ["language"] });
    expect(applicable(semanticScholar)).not.toContain("language");
    expect(applicable(openalex)).toContain("language");
  });
});

describe("filtered searches", () => {
  const settings = () => ({ openalexMailto: "", openalexApiKey: "", webProviders: {} }) as never;
  it("checks what a provider cannot ask for on its results", async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify(s2Fixture)));
    const web = new WebSearch({ settings, invoke: async () => ({}), emit: () => {}, fetch });
    const page = (await web.handle("web_search", { provider: "s2", query: "language models", limit: 10, filters: { authors: ["Devlin"] } }, "w")) as { results: WebResult[] };
    expect(page.results.map((r) => r.authors[0])).toEqual(["Jacob Devlin"]);
    // Asked for more, since some are left out.
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("limit")).toBe("20");
  });
  it("leaves out a provider that cannot apply a filter, and says so", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(s2Fixture)));
    const web = new WebSearch({ settings, invoke: async () => ({}), emit: () => {}, fetch });
    expect(await web.handle("web_search", { provider: "s2", query: "x y", limit: 10, filters: { language: "de" } }, "w")).toEqual({ results: [], skipped: ["language"] });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("tells the search page which filters each provider applies", async () => {
    const web = new WebSearch({ settings, invoke: async () => ({}), emit: () => {} });
    const providers = (await web.handle("web_providers", {}, "w")) as { id: string; filters: string[] }[];
    expect(providers.find((p) => p.id === "openalex")?.filters).toContain("retracted");
    expect(providers.find((p) => p.id === "s2")?.filters).not.toContain("retracted");
  });
});
