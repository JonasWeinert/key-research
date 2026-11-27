import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SecretStore } from "../secrets";
import type { AppSettings } from "../app-settings";
import { KeyedServices, publicSettings } from "./index";
import { UsageStore, applyOutcome, rolled } from "./usage";

const KEY = "sk-test-abcdefgh9876";
const settings = { openalexMailto: "", webProviders: {} } as unknown as AppSettings;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
  it("tells a refused Scopus key from one that needs the institution's network", async () => {
    let status = 401;
    let els = "AUTHENTICATION_ERROR - Invalid API Key";
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("/content/search/scopus?");
      expect((init.headers as Record<string, string>)["X-ELS-APIKey"]).toBe(KEY);
      return new Response("{}", { status, headers: { "x-els-status": els, "x-ratelimit-remaining": "19990" } });
    });
    const { keyed } = await services(fetch as never);
    await keyed.handle("services_set_key", { id: "elsevier", key: KEY });
    expect(await keyed.handle("services_test", { id: "elsevier" })).toMatchObject({ ok: false, message: "Elsevier refused this key" });
    status = 401;
    els = "AUTHORIZATION_ERROR - The requestor is not authorized";
    expect(await keyed.handle("services_test", { id: "elsevier" })).toMatchObject({ ok: true });
    status = 200;
    els = "OK";
    expect(await keyed.handle("services_test", { id: "elsevier" })).toMatchObject({ ok: true, remaining: { value: 19990, label: "requests left this week" } });
  });
  it("tests a Web of Science Starter key with one record", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("/apis/wos-starter/v1/documents?");
      expect((init.headers as Record<string, string>)["X-ApiKey"]).toBe(KEY);
      return json({ metadata: { total: 1, page: 1, limit: 1 }, hits: [] });
    });
    const { keyed } = await services(fetch as never);
    await keyed.handle("services_set_key", { id: "clarivate-wos", key: KEY });
    expect(await keyed.handle("services_test", { id: "clarivate-wos" })).toMatchObject({ ok: true, message: "Web of Science accepted the key" });
  });
  it("folds a host's counts into the service", async () => {
    const { keyed, usage } = await services();
    keyed.recordHost("openalex", { requests: 3, failures: 1, lastError: "OpenAlex is limiting requests with this key", remaining: 12 });
    expect(usage.usage("openalex")).toMatchObject({ today: 3, lastError: "OpenAlex is limiting requests with this key", remaining: 12 });
  });
});

describe("web search engine keys", () => {
  it("checks a Tavily key on its usage endpoint, which runs no search", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.tavily.com/usage");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
      return json({ key: { usage: 150, limit: 1000 }, account: { current_plan: "Researcher", plan_usage: 150, plan_limit: 1000 } });
    });
    const { keyed } = await services(fetch as never);
    const list = (await keyed.handle("services_set_key", { id: "tavily", key: KEY })) as ReturnType<KeyedServices["list"]>;
    expect(list.services.find((s) => s.id === "tavily")).toMatchObject({ engine: true, checkUsesQuota: false, hasPricing: true });
    expect(JSON.stringify(list)).not.toContain(KEY);
    expect(await keyed.handle("services_test", { id: "tavily" })).toMatchObject({ ok: true, remaining: { value: 850, label: "credits left this month" } });
  });
  it("says when an engine's key is spent or refused", async () => {
    let status = 432;
    const fetch = vi.fn(async () => json({ detail: { error: "limit" } }, status));
    const { keyed } = await services(fetch as never);
    await keyed.handle("services_set_key", { id: "tavily", key: KEY });
    expect(await keyed.handle("services_test", { id: "tavily" })).toMatchObject({ ok: false, message: "Tavily accepted the key, but it has no credits left" });
    status = 401;
    expect(await keyed.handle("services_test", { id: "tavily" })).toMatchObject({ ok: false, message: "Tavily refused this key" });
  });
  it("reads Firecrawl's remaining credits without a search", async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.firecrawl.dev/v2/team/credit-usage");
      return json({ success: true, data: { remainingCredits: 420, planCredits: 500 } });
    });
    const { keyed } = await services(fetch as never);
    await keyed.handle("services_set_key", { id: "firecrawl", key: KEY });
    expect(await keyed.handle("services_test", { id: "firecrawl" })).toMatchObject({ ok: true, remaining: { value: 420, label: "credits left" } });
  });
  it("checks keys of engines without an account endpoint with the smallest search, and says so", async () => {
    const calls: { url: string; body?: string; headers: Record<string, string> }[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as string | undefined, headers: init.headers as Record<string, string> });
      return json({ results: [] });
    });
    const { keyed } = await services(fetch as never);
    for (const id of ["exa", "brave", "perplexity", "you", "jina"]) {
      const list = (await keyed.handle("services_set_key", { id, key: KEY })) as ReturnType<KeyedServices["list"]>;
      expect(list.services.find((s) => s.id === id)?.checkUsesQuota).toBe(true);
      expect(await keyed.handle("services_test", { id })).toMatchObject({ ok: true });
    }
    expect(JSON.parse(calls[0].body!)).toMatchObject({ numResults: 1 });
    expect(calls[0].headers["x-api-key"]).toBe(KEY);
    expect(calls[1].url).toContain("count=1");
    expect(calls[1].headers["X-Subscription-Token"]).toBe(KEY);
    expect(JSON.parse(calls[2].body!)).toMatchObject({ max_results: 1 });
    expect(calls[3].headers["X-API-Key"]).toBe(KEY);
    expect(calls[4].url).toBe("https://r.jina.ai/https://example.com");
  });
});

