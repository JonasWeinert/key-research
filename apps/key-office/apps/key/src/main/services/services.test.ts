import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../web-search/http";
import { WebSearch } from "../web-search";
import { parseScholarPage, parseSummary } from "../web-search/scholar-serpapi";
import { SecretStore } from "../secrets";
import type { AppSettings } from "../app-settings";
import { keyCanHelp, withKeyFallback, type ServiceKeys } from "./fallback";
import { KeyedServices, publicSettings } from "./index";
import { UsageStore, applyOutcome, rolled } from "./usage";
import openalexFixture from "../web-search/fixtures/openalex-search.json";
import scholarFixture from "../web-search/fixtures/serpapi-scholar.json";

const KEY = "sk-test-abcdefgh9876";
const settings = { openalexMailto: "", webProviders: {} } as unknown as AppSettings;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("fallback policy", () => {
  it("asks without the key first and with it only when that could help", async () => {
    const run = vi.fn(async (key?: string) => {
      if (!key) throw new ProviderError("OpenAlex is limiting requests", 429, true);
      return "ok";
    });
    const record = vi.fn();
    expect(await withKeyFallback({ key: KEY, mode: "fallback", run, record })).toBe("ok");
    expect(run.mock.calls.map((c) => c[0])).toEqual([undefined, KEY]);
    expect(record).toHaveBeenCalledWith({ ok: true });

    const fine = vi.fn(async () => "fine");
    await withKeyFallback({ key: KEY, mode: "fallback", run: fine, record });
    expect(fine).toHaveBeenCalledTimes(1);
    const notFound = vi.fn(async () => {
      throw new ProviderError("OpenAlex returned HTTP 404", 404);
    });
    await expect(withKeyFallback({ key: KEY, mode: "fallback", run: notFound })).rejects.toThrow("404");
    expect(notFound).toHaveBeenCalledTimes(1);
  });
  it("always uses the key when chosen and counts a refused key as invalid", async () => {
    const record = vi.fn();
    const run = vi.fn(async () => {
      throw new ProviderError("refused", 403);
    });
    await expect(withKeyFallback({ key: KEY, mode: "always", run, record })).rejects.toThrow();
    expect(run.mock.calls).toEqual([[KEY]]);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ ok: false, invalid: true }));
  });
  it("knows which errors a key helps with", () => {
    expect(keyCanHelp(new ProviderError("x", 429, true))).toBe(true);
    expect(keyCanHelp(new ProviderError("x", 403))).toBe(true);
    expect(keyCanHelp(new ProviderError("x", undefined, true))).toBe(true);
    expect(keyCanHelp(new ProviderError("x", 404))).toBe(false);
    expect(keyCanHelp(Object.assign(Error("t"), { name: "TimeoutError" }))).toBe(true);
  });
});

describe("usage counting", () => {
  it("counts today and this month, rolling over", () => {
    const day1 = new Date(2026, 10, 30, 12).getTime();
    const day2 = new Date(2026, 11, 1, 9).getTime();
    let usage = applyOutcome(undefined, { ok: true, at: day1 });
    usage = applyOutcome(usage, { ok: false, error: "OpenAlex is limiting requests", at: day1 + 1, remaining: 99, remainingLabel: "left" });
    expect(usage).toMatchObject({ today: 2, thisMonth: 2, total: 2, lastError: "OpenAlex is limiting requests", remaining: 99 });
    expect(rolled(usage, day2)).toMatchObject({ today: 0, thisMonth: 0, total: 2 });
    usage = applyOutcome(usage, { ok: true, at: day2 });
    expect(usage).toMatchObject({ today: 1, thisMonth: 1, total: 3, lastUsedAt: day2 });
  });
  it("persists counters and the preference", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "key-usage-")), "service-usage.json");
    const store = new UsageStore(path);
    await store.load();
    store.record("openalex", { ok: true });
    store.setMode("openalex", "always");
    await store.flush();
    const again = new UsageStore(path);
    await again.load();
    expect(again.usage("openalex").today).toBe(1);
    expect(again.mode("openalex")).toBe("always");
    expect(again.mode("scholar-serpapi")).toBe("fallback");
  });
});

async function services(fetch?: typeof globalThis.fetch) {
  const dir = await mkdtemp(join(tmpdir(), "key-services-"));
  const secrets = new SecretStore({ dir, backend: "local", reason: "tests" });
  await secrets.load();
  const usage = new UsageStore(join(dir, "service-usage.json"));
  await usage.load();
  return { secrets, usage, keyed: new KeyedServices({ secrets, usage, settings: () => settings, fetch }) };
}

describe("keyed services", () => {
  it("never answers a key, only its hint", async () => {
    const { keyed } = await services();
    const list = (await keyed.handle("services_set_key", { id: "openalex", key: KEY })) as ReturnType<KeyedServices["list"]>;
    expect(JSON.stringify(list)).not.toContain(KEY);
    expect(list.services.find((s) => s.id === "openalex")?.key).toMatchObject({ set: true, hint: "9876" });
    expect(keyed.key("openalex")).toBe(KEY);
    const hidden = publicSettings({ ...settings, openalexApiKey: KEY, webProviders: { s2: { enabled: true, apiKey: KEY } } });
    expect(JSON.stringify(hidden)).not.toContain(KEY);
  });
  it("tests a SerpApi key against the free account endpoint and keeps the quota", async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toContain("/account.json");
      return json({ plan_searches_left: 240, total_searches_left: 240 });
    });
    const { keyed, usage } = await services(fetch as never);
    await keyed.handle("services_set_key", { id: "scholar-serpapi", key: KEY });
    expect(await keyed.handle("services_test", { id: "scholar-serpapi" })).toMatchObject({ ok: true, remaining: { value: 240 } });
    expect(usage.usage("scholar-serpapi")).toMatchObject({ validity: "valid", remaining: 240 });
  });
  it("folds a host's counts into the service", async () => {
    const { keyed, usage } = await services();
    keyed.recordHost("openalex", { requests: 3, failures: 1, lastError: "OpenAlex is limiting requests with this key", remaining: 12 });
    expect(usage.usage("openalex")).toMatchObject({ today: 3, lastError: "OpenAlex is limiting requests with this key", remaining: 12 });
  });
});

describe("Google Scholar via SerpApi", () => {
  it("parses results", () => {
    expect(parseSummary("A Vaswani, N Shazeer, N Parmar… - Advances in neural …, 2017 - proceedings.neurips.cc")).toEqual({ authors: ["A Vaswani", "N Shazeer", "N Parmar"], year: 2017, venue: "Advances in neural" });
    const page = parseScholarPage(scholarFixture as never, 0);
    expect(page.results).toHaveLength(2);
    expect(page.results[0]).toMatchObject({ provider: "scholar", title: "Attention is all you need", year: 2017, citedBy: 150000, pdfUrl: "https://arxiv.org/pdf/1706.03762" });
    expect(page.cursor).toBe("2");
  });
});

describe("web search with keys", () => {
  const keysOf = (keys: Record<string, string>, mode: "fallback" | "always" = "fallback") => ({
    key: (s: string) => keys[s],
    mode: () => mode,
    record: vi.fn<ServiceKeys["record"]>(),
  });
  it("retries a rate-limited OpenAlex search with the key", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      urls.push(url);
      return url.includes("api_key=") ? json(openalexFixture) : json({ error: "limited" }, 429);
    });
    const keys = keysOf({ openalex: KEY });
    const search = new WebSearch({ settings: () => settings, invoke: async () => ({}), emit: () => {}, fetch: fetch as never, keys });
    process.env.KEY_WEB_MAX_RETRY_WAIT_MS = "1";
    const page = await search.search("openalex", "attention", { limit: 3 });
    expect(page.results.length).toBe(3);
    expect(urls.filter((u) => u.includes("api_key=")).length).toBe(1);
    expect(urls[0]).not.toContain("api_key=");
    expect(keys.record).toHaveBeenCalledWith("openalex", { ok: true });
  });
  it("falls back to Google Scholar when a catalogue fails, once per query", async () => {
    const fetch = vi.fn(async (url: string) => (url.includes("search.json") ? json(scholarFixture) : json({}, 503)));
    const keys = keysOf({ "scholar-serpapi": KEY });
    const search = new WebSearch({ settings: () => settings, invoke: async () => ({}), emit: () => {}, fetch: fetch as never, keys });
    process.env.KEY_WEB_MAX_RETRY_WAIT_MS = "1";
    const providers = (await search.handle("web_providers", {}, "")) as { id: string; enabled: boolean; apiKey: boolean }[];
    expect(providers.find((p) => p.id === "scholar")).toMatchObject({ enabled: false, apiKey: false });
    const [a, b] = await Promise.all([search.search("openalex", "attention", { limit: 20 }), search.search("s2", "attention", { limit: 20 })]);
    expect(a.results[0].provider).toBe("scholar");
    expect(b.results[0].provider).toBe("scholar");
    expect(fetch.mock.calls.filter(([u]) => String(u).includes("search.json")).length).toBe(1);
    expect(keys.record).toHaveBeenCalledWith("scholar-serpapi", { ok: true });
  });
});

