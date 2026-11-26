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
  it("folds a host's counts into the service", async () => {
    const { keyed, usage } = await services();
    keyed.recordHost("openalex", { requests: 3, failures: 1, lastError: "OpenAlex is limiting requests with this key", remaining: 12 });
    expect(usage.usage("openalex")).toMatchObject({ today: 3, lastError: "OpenAlex is limiting requests with this key", remaining: 12 });
  });
});

