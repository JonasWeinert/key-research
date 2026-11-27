// Starts the secret store and the keyed services for the app, moves old plaintext keys into
// it, and keeps the library hosts told: each host gets the keys in requests on its IPC channel
// when it starts and again whenever a key, its preference or the web search settings change
// (`store_enrich_options` for the library's OpenAlex lookups, `web_options` for web search).
// What the hosts asked with a key comes back with `store_key_usage` and `web_key_usage`.
import { app, safeStorage, shell } from "electron";
import { join, resolve } from "node:path";
import type { AppSettingsStore } from "../app-settings";
import type { HostRequest } from "../rust-bridge";
import { SecretStore, preferredBackend } from "../secrets";
import type { Registry } from "../workspaces";
import { webOptions } from "../web-search";
import { KeyedServices, migratePlaintextKeys, type HostKeyUsage } from "./index";
import { SERVICES } from "./registry";
import { UsageStore } from "./usage";

let services: KeyedServices | undefined;
let secretStore: SecretStore | undefined;
/** The secret store, once loaded (the AI assistant keeps its keys there too). */
export const secrets = () => secretStore;
let settingsStore: AppSettingsStore | undefined;

/** For the registry's prelude: what a starting host is told about the keys. */
export function hostKeyRequests(): HostRequest[] {
  if (!services) return [];
  const keyed = services;
  const keys = Object.fromEntries(SERVICES.map((s) => [s.id, { key: keyed.key(s.id) ?? "", mode: keyed.mode(s.id) }]));
  const requests: HostRequest[] = [{ command: "store_enrich_options", args: { apiKey: keyed.key("openalex") ?? "", keyMode: keyed.mode("openalex") } }];
  if (settingsStore) requests.push({ command: "web_options", args: webOptions(settingsStore.get(), keys) });
  // Database search connectors name the keys they use by service id (connectors/COMMANDS.md);
  // downloaded connector bundles are app-wide, so every workspace shares one folder.
  const dbKeys = Object.fromEntries(SERVICES.map((s) => [s.id, keyed.key(s.id) ?? null]));
  const mailto = settingsStore?.get().openalexMailto ?? "";
  requests.push({ command: "db_options", args: { keys: dbKeys, mailto, connectorsDir: join(app.getPath("userData"), "connectors") } });
  return requests;
}

let pushHosts: (() => Promise<unknown>) | undefined;
let webProvidersChanged: (() => void) | undefined;
/** Called once the hosts have the new keys and web search settings. */
export function onWebProvidersChanged(listener: () => void) {
  webProvidersChanged = listener;
}
/** Tells running hosts again (the web search settings changed). */
export function pushHostKeys(): Promise<unknown> {
  return pushHosts?.() ?? Promise.resolve();
}

export async function startKeyedServices(options: { registry: () => Registry; appSettings: AppSettingsStore }) {
  const userData = app.getPath("userData");
  settingsStore = options.appSettings;
  const choice = await preferredBackend({
    env: process.env,
    platform: process.platform,
    isPackaged: app.isPackaged,
    bundlePath: process.platform === "darwin" ? resolve(app.getPath("exe"), "../../..") : undefined,
  });
  const secrets = new SecretStore({ dir: userData, backend: choice.backend, reason: choice.reason, safeStorage: choice.backend === "keychain" ? safeStorage : undefined });
  await secrets.load().catch(() => undefined);
  secretStore = secrets;
  const usage = new UsageStore(join(userData, "service-usage.json"));
  await usage.load();
  const keyed = (services = new KeyedServices({
    secrets,
    usage,
    settings: () => options.appSettings.get(),
    openExternal: (url) => void shell.openExternal(url),
    collectHostUsage: async () => {
      const registry = options.registry();
      const [library, web] = await Promise.all([registry.broadcast<HostKeyUsage>("store_key_usage", {}), registry.broadcast<Record<string, HostKeyUsage>>("web_key_usage", {})]);
      for (const { result } of library) keyed.recordHost("openalex", result);
      for (const { result } of web) for (const [service, report] of Object.entries(result ?? {})) keyed.recordHost(service, report);
    },
  }));
  await migratePlaintextKeys(options.appSettings, secrets).catch(() => false);
  const push = (pushHosts = () => {
    const sent = Promise.all(hostKeyRequests().map((request) => options.registry().broadcast(request.command, request.args).catch(() => undefined)));
    // Web search settings or a key changed: views showing engines read them again.
    void sent.then(() => webProvidersChanged?.());
    return sent;
  });
  secrets.onChange(push);
  let modes = SERVICES.map((s) => keyed.mode(s.id)).join();
  usage.onChange(() => {
    const now = SERVICES.map((s) => keyed.mode(s.id)).join();
    if (now === modes) return;
    modes = now;
    push();
  });
  // Hosts that started before the keys were read.
  push();
  setInterval(() => void keyed.handle("services_list", {}).catch(() => {}), 60_000).unref();
  app.on("before-quit", () => void usage.flush());
  return keyed;
}
