import { describe, expect, it, vi } from "vitest";
import { bareDoi, mergeWeb, sameWork, shortAuthors, snippetOf, titleKey, type WebResult } from "../../shared/web-search";
import { ProviderError, TtlCache, getJson, parseRetryAfter, withRetry } from "./http";
import { WebSearch, creatorOf, matchSource, sourceInput } from "./index";
import { abstractText, openalex, parseOpenAlexPage } from "./openalex";
import { parseS2Page, semanticScholar } from "./semantic-scholar";
import openalexFixture from "./fixtures/openalex-search.json";
import s2Fixture from "./fixtures/s2-search.json";

const result = (over: Partial<WebResult>): WebResult => ({ provider: "a", providerId: "1", title: "A study", authors: [], ids: {}, ...over });

describe("normalising", () => {
  it("bares DOIs and keys titles", () => {
    expect(bareDoi("https://doi.org/10.1038/ABC")).toBe("10.1038/abc");
    expect(bareDoi("doi: 10.1/x")).toBe("10.1/x");
    expect(bareDoi("")).toBeUndefined();
    expect(titleKey("Attention is All you Need!")).toBe(titleKey("attention is all  you need"));
    expect(titleKey("Über <i>Café</i>")).toBe("uber cafe");
  });
  it("cuts abstracts at a sentence and names authors short", () => {
    const text = "First sentence here. ".repeat(30);
    const cut = snippetOf(text, 100)!;
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.endsWith(".")).toBe(true);
    expect(snippetOf("  ")).toBeUndefined();
    expect(shortAuthors(["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"])).toBe("Vaswani et al.");
    expect(shortAuthors(["Ashish Vaswani", "Noam Shazeer"])).toBe("Vaswani & Shazeer");
  });
  it("rebuilds OpenAlex abstracts", () => {
    expect(abstractText({ world: [1], hello: [0, 2] })).toBe("hello world hello");
    expect(abstractText(null)).toBeUndefined();
  });
});

describe("OpenAlex responses", () => {
  const page = parseOpenAlexPage(openalexFixture as never);
  it("maps every field", () => {
    expect(page.cursor).toBe(openalexFixture.meta.next_cursor);
    expect(page.total).toBe(3);
    const [attention, bert, alphafold] = page.results;
    expect(attention).toMatchObject({
      provider: "openalex",
      providerId: "W2963403868",
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"],
      year: 2017,
      venue: "arXiv (Cornell University)",
      doi: undefined,
      ids: { openalex: "W2963403868", arxiv: "1706.03762", mag: "2963403868" },
      citedBy: 61234,
      openAccess: true,
      oaStatus: "green",
      pdfUrl: "https://arxiv.org/pdf/1706.03762",
      landingUrl: "https://arxiv.org/abs/1706.03762",
      type: "preprint",
    });
    expect(attention.abstract).toMatch(/^The dominant sequence/);
    expect(bert).toMatchObject({ doi: "10.18653/v1/n19-1423", pdfUrl: "https://aclanthology.org/N19-1423.pdf", landingUrl: "https://doi.org/10.18653/v1/n19-1423", abstract: undefined });
    expect(alphafold).toMatchObject({ openAccess: false, pdfUrl: undefined, ids: { pmid: "34265844", pmcid: "8371605" } });
  });
  it("asks with the polite pool, the key and a cursor", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(openalexFixture)));
    await openalex.search("attention", { limit: 5, cursor: "abc", filters: { openAccess: true, yearFrom: 2015 } }, { mailto: "me@example.org", apiKey: "k", fetch });
    const url = new URL((fetch.mock.calls[0] as unknown as [string])[0]);
    expect(url.pathname).toBe("/works");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ search: "attention", "per-page": "5", cursor: "abc", mailto: "me@example.org", api_key: "k", filter: "publication_year:2015-,is_oa:true" });
  });
});

describe("Semantic Scholar responses", () => {
  const page = parseS2Page(s2Fixture as never);
  it("maps every field", () => {
    expect(page.cursor).toBe("3");
    const [attention, bert, gpt] = page.results;
    expect(attention).toMatchObject({
      provider: "s2",
      providerId: "204e3073870fae3d05bcbc2f6a8e263d9b72e776",
      authors: ["Ashish Vaswani", "Noam M. Shazeer"],
      venue: "Neural Information Processing Systems",
      doi: undefined,
      ids: { s2: "204e3073870fae3d05bcbc2f6a8e263d9b72e776", arxiv: "1706.03762", mag: "2963403868" },
      citedBy: 120000,
      openAccess: false,
      pdfUrl: "https://arxiv.org/pdf/1706.03762",
      landingUrl: "https://www.semanticscholar.org/paper/204e3073870fae3d05bcbc2f6a8e263d9b72e776",
      type: "proceedings-article",
    });
    expect(bert).toMatchObject({ doi: "10.18653/v1/n19-1423", oaStatus: "hybrid", pdfUrl: "https://aclanthology.org/N19-1423.pdf", abstract: undefined });
    expect(gpt).toMatchObject({ type: "preprint", ids: { arxiv: "2005.14165" } });
  });
  it("sends the key as a header and pages by offset", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [] })));
    const out = await semanticScholar.search("attention", { limit: 10, cursor: "20" }, { mailto: "", apiKey: "secret", fetch });
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url).searchParams.get("offset")).toBe("20");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("secret");
    expect(out).toEqual({ results: [], cursor: undefined, total: undefined });
  });
});

describe("merging providers", () => {
  it("joins the same work by DOI, arXiv id, then title and year", () => {
    const merged = mergeWeb([
      { provider: "openalex", results: parseOpenAlexPage(openalexFixture as never).results },
      { provider: "s2", results: parseS2Page(s2Fixture as never).results },
    ]);
    expect(merged.map((h) => h.title)).toEqual([
      "Attention Is All You Need",
      "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
      "Highly accurate protein structure prediction with AlphaFold",
      "Language Models are Few-Shot Learners",
    ]);
    const [attention, bert] = merged;
    expect(attention.foundBy).toEqual(["openalex", "s2"]);
    expect(attention.ids).toMatchObject({ openalex: "W2963403868", s2: "204e3073870fae3d05bcbc2f6a8e263d9b72e776", arxiv: "1706.03762" });
    // The richer abstract and the higher count win.
    expect(attention.abstract).toMatch(/attention mechanism\.$/);
    expect(attention.citedBy).toBe(120000);
    expect(attention.openAccess).toBe(true);
    expect(bert.key).toBe("doi:10.18653/v1/n19-1423");
    expect(bert.foundBy).toEqual(["openalex", "s2"]);
  });
  it("keeps works apart whose DOIs differ, or whose years are far apart", () => {
    const merged = mergeWeb([
      { provider: "a", results: [result({ title: "Review", doi: "10.1/a", year: 2020 }), result({ providerId: "2", title: "Same name", year: 1990 })] },
      { provider: "b", results: [result({ title: "Review", doi: "10.1/b", year: 2020 }), result({ providerId: "3", title: "Same name", year: 2020 })] },
    ]);
    expect(merged).toHaveLength(4);
    expect(sameWork({ title: "X", year: 2001 }, { title: "x", year: 2002 })).toBe(true);
  });
  it("interleaves by rank, agreement first among equals", () => {
    const merged = mergeWeb([
      { provider: "a", results: [result({ providerId: "a1", title: "One" }), result({ providerId: "a2", title: "Two" })] },
      { provider: "b", results: [result({ providerId: "b1", title: "Three" }), result({ providerId: "b2", title: "Two" })] },
    ]);
    expect(merged.map((h) => h.title)).toEqual(["One", "Three", "Two"]);
    expect(merged[2].foundBy).toEqual(["a", "b"]);
  });
});

describe("retrying", () => {
  it("reads Retry-After in seconds and as a date", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
  it("turns 429 and 5xx into transient errors with their wait", async () => {
    const fetch = async () => new Response("{}", { status: 429, headers: { "retry-after": "2" } });
    await expect(getJson("http://x", { fetch, label: "X" })).rejects.toMatchObject({ status: 429, transient: true, retryAfterMs: 2000 });
    await expect(getJson("http://x", { fetch: async () => new Response("", { status: 403 }), label: "X" })).rejects.toMatchObject({ transient: false });
    await expect(getJson("http://x", { fetch: async () => Promise.reject(new TypeError("fetch failed")), label: "X" })).rejects.toMatchObject({ transient: true, message: "Couldn't reach X" });
  });
  it("backs off, honours Retry-After, then gives up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new ProviderError("busy", 429, true, 1500);
      if (calls === 2) throw new ProviderError("busy", 503, true);
      return "ok";
    };
    expect(await withRetry(flaky, { sleep, attempts: 3, baseMs: 100 })).toBe("ok");
    expect(waits).toEqual([1500, 200]);
    await expect(withRetry(async () => Promise.reject(new ProviderError("down", 500, true)), { sleep, attempts: 2, baseMs: 1 })).rejects.toThrow("down");
    // Not transient, or a wait too long to sit through: no retry.
    let tries = 0;
    await expect(withRetry(async () => (tries++, Promise.reject(new ProviderError("no", 400))), { sleep })).rejects.toThrow("no");
    await expect(withRetry(async () => (tries++, Promise.reject(new ProviderError("daily budget", 429, true, 3_600_000))), { sleep })).rejects.toThrow("daily budget");
    expect(tries).toBe(2);
  });
  it("stops when cancelled", async () => {
    const controller = new AbortController();
    const task = withRetry(async () => Promise.reject(new ProviderError("busy", 429, true)), { signal: controller.signal, baseMs: 10_000 });
    controller.abort();
    await expect(task).rejects.toBeTruthy();
  });
  it("caches for a while", () => {
    const cache = new TtlCache<number>(1000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });
});

describe("the library side", () => {
  it("makes a full reference from a result", () => {
    const [bert] = mergeWeb([{ provider: "s2", results: parseS2Page(s2Fixture as never).results.slice(1, 2) }]);
    expect(sourceInput(bert, "c1")).toMatchObject({
      kind: "reference",
      itemType: "article",
      title: bert.title,
      creators: [{ given: "Jacob", family: "Devlin", role: "author" }],
      year: 2019,
      doi: "10.18653/v1/n19-1423",
      arxivId: "1810.04805",
      oaUrl: "https://aclanthology.org/N19-1423.pdf",
      collections: ["c1"],
    });
    expect(creatorOf("Plato")).toEqual({ literal: "Plato", role: "author" });
  });
  it("recognises a work already in the library", () => {
    const sources = [
      { id: "s1", title: "Something else", doi: "https://doi.org/10.1/X" },
      { id: "s2", title: "Attention is all you need.", year: 2017 },
    ];
    expect(matchSource({ title: "Whatever", doi: "10.1/x" }, sources)?.id).toBe("s1");
    expect(matchSource({ title: "Attention Is All You Need", year: 2018 }, sources)?.id).toBe("s2");
    expect(matchSource({ title: "Attention Is All You Need", year: 2012 }, sources)).toBeUndefined();
    expect(matchSource({ title: "Something else", doi: "10.1/y" }, sources)).toBeUndefined();
  });
  it("searches one provider, caches, and leaves turned-off providers alone", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(openalexFixture)));
    let settings = { openalexMailto: "", openalexApiKey: "", webProviders: {} as Record<string, { enabled?: boolean }> };
    const web = new WebSearch({ settings: () => settings as never, invoke: async () => ({}), emit: () => {}, fetch });
    const page = (await web.handle("web_search", { provider: "openalex", query: "attention", limit: 3 }, "w")) as { results: unknown[] };
    expect(page.results).toHaveLength(3);
    await web.handle("web_search", { provider: "openalex", query: "Attention ", limit: 3 }, "w");
    expect(fetch).toHaveBeenCalledTimes(1);
    settings = { ...settings, webProviders: { openalex: { enabled: false } } };
    await expect(web.handle("web_search", { provider: "openalex", query: "other", limit: 3 }, "w")).rejects.toThrow(/turned off/);
    const providers = (await web.handle("web_providers", {}, "w")) as { id: string; enabled: boolean }[];
    expect(providers.map((p) => [p.id, p.enabled])).toEqual([
      ["openalex", false],
      ["s2", true],
      // Google Scholar needs a SerpApi key: off without one.
      ["scholar", false],
    ]);
  });
});
