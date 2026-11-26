// Starts the secret store and the keyed services for the app, moves old plaintext keys into
// it, and keeps the library hosts told: the OpenAlex key reaches each host in a request on
// its IPC channel when it starts and again whenever the key or its preference changes.
import { app, safeStorage, shell } from "electron";
import { join, resolve } from "node:path";
import type { AppSettingsStore } from "../app-settings";
import type { HostRequest } from "../rust-bridge";
import { SecretStore, preferredBackend } from "../secrets";
import type { Registry } from "../workspaces";
import { KeyedServices, migratePlaintextKeys, type HostKeyUsage } from "./index";
import { UsageStore } from "./usage";

let services: KeyedServices | undefined;

/** For the registry's prelude: what a starting host is told about the OpenAlex key. */
export function hostKeyRequests(): HostRequest[] {
  if (!services) return [];
  return [{ command: "store_enrich_options", args: { apiKey: services.key("openalex") ?? "", keyMode: services.mode("openalex") } }];
}

export async function startKeyedServices(options: { registry: () => Registry; appSettings: AppSettingsStore }) {
  const userData = app.getPath("userData");
  const choice = await preferredBackend({
    env: process.env,
    platform: process.platform,
    isPackaged: app.isPackaged,
    bundlePath: process.platform === "darwin" ? resolve(app.getPath("exe"), "../../..") : undefined,
  });
  const secrets = new SecretStore({ dir: userData, backend: choice.backend, reason: choice.reason, safeStorage: choice.backend === "keychain" ? safeStorage : undefined });
  await secrets.load().catch(() => undefined);
  const usage = new UsageStore(join(userData, "service-usage.json"));
  await usage.load();
  const keyed = (services = new KeyedServices({
    secrets,
    usage,
    settings: () => options.appSettings.get(),
    openExternal: (url) => void shell.openExternal(url),
    collectHostUsage: async () => {
      for (const { result } of await options.registry().broadcast<HostKeyUsage>("store_key_usage", {})) keyed.recordHost("openalex", result);
    },
  }));
  await migratePlaintextKeys(options.appSettings, secrets).catch(() => false);
  const push = () => {
    for (const request of hostKeyRequests()) void options.registry().broadcast(request.command, request.args);
  };
  secrets.onChange(push);
  let mode = keyed.mode("openalex");
  usage.onChange(() => {
    if (keyed.mode("openalex") === mode) return;
    mode = keyed.mode("openalex");
    push();
  });
  // Hosts that started before the keys were read.
  push();
  setInterval(() => void keyed.handle("services_list", {}).catch(() => {}), 60_000).unref();
  app.on("before-quit", () => void usage.flush());
  return keyed;
}
