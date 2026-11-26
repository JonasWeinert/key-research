// Settings → Services & API keys, in the main process: the keys (SecretStore), how each is
// used (fallback or always) and how often (UsageStore). The renderer asks through
// `services_*` commands on key:invoke and only ever sees whether a key is set, its last four
// characters and the counters, never a key.
import type { AppSettings, AppSettingsStore } from "../app-settings";
import { PROVIDERS } from "../web-search/registry";
import type { Fetch } from "../web-search/http";
import type { SecretStore } from "../secrets";
import type { ServiceKeys } from "./fallback";
import { SERVICES, secretName, serviceFor, type KeyedService, type Validation } from "./registry";
import type { KeyMode, Outcome, UsageStore } from "./usage";

const DEFAULT_MAILTO = "key-app@users.noreply.github.com";

/** What one library host reports (store_key_usage), drained on each read. */
export interface HostKeyUsage {
  requests?: number;
  failures?: number;
  lastError?: string;
  lastAt?: number;
  remaining?: number;
  invalid?: boolean;
}

export class KeyedServices implements ServiceKeys {
  constructor(
    private readonly deps: {
      secrets: SecretStore;
      usage: UsageStore;
      settings: () => AppSettings;
      fetch?: Fetch;
      openExternal?: (url: string) => void;
      /** Asks running library hosts what they used since the last time. */
      collectHostUsage?: () => Promise<void>;
      services?: KeyedService[];
    },
  ) {}

  private get services() {
    return this.deps.services ?? SERVICES;
  }

  key(service: string) {
    return this.deps.secrets.get(secretName(service));
  }
  mode(service: string): KeyMode {
    return this.deps.usage.mode(service);
  }
  record(service: string, outcome: Outcome) {
    this.deps.usage.record(service, outcome);
  }
  /** Folds what a host counted into the service's usage. */
  recordHost(service: string, report: HostKeyUsage | undefined) {
    if (!report || !(report.requests || report.failures)) return;
    this.deps.usage.record(service, {
      requests: report.requests ?? 0,
      ok: !report.failures,
      error: report.failures ? report.lastError || "A request with the key failed" : undefined,
      invalid: report.invalid,
      remaining: report.remaining,
      remainingLabel: report.remaining === undefined ? undefined : "requests left today",
      at: report.lastAt,
    });
  }

  handles(command: string) {
    return command.startsWith("services_");
  }

  async handle(command: string, args: any): Promise<unknown> {
    switch (command) {
      case "services_list":
        await this.deps.collectHostUsage?.().catch(() => {});
        return this.list();
      case "services_set_key": {
        const service = this.service(args?.id);
        const key = String(args?.key ?? "").trim();
        if (!key) throw Error("Paste a key");
        await this.deps.secrets.set(secretName(service.id), key);
        this.deps.usage.forget(service.id);
        return this.list();
      }
      case "services_remove": {
        const service = this.service(args?.id);
        await this.deps.secrets.delete(secretName(service.id));
        this.deps.usage.forget(service.id);
        return this.list();
      }
      case "services_test": {
        const service = this.service(args?.id);
        const key = String(args?.key ?? "").trim() || this.key(service.id);
        if (!key) throw Error("Paste a key to test");
        const settings = this.deps.settings();
        const result = await service.validate(key, { fetch: this.deps.fetch, mailto: settings.openalexMailto || DEFAULT_MAILTO }).catch((): Validation => ({ ok: false, message: "The test did not finish" }));
        // Only the stored key's result is remembered; a pasted, unsaved one is just answered.
        if (key === this.key(service.id)) this.deps.usage.validated(service.id, result.ok, result.remaining, result.ok ? undefined : result.message);
        return { ok: result.ok, message: result.message, remaining: result.remaining };
      }
      case "services_set_mode": {
        const service = this.service(args?.id);
        this.deps.usage.setMode(service.id, args?.mode === "always" ? "always" : "fallback");
        return this.list();
      }
      case "services_unlock":
        await this.deps.secrets.unlock();
        return this.list();
      case "services_forget_locked":
        await this.deps.secrets.clear();
        return this.list();
      case "services_open_key_page": {
        const service = this.service(args?.id);
        this.deps.openExternal?.(service.keyUrl);
        return true;
      }
      default:
        throw Error(`Unknown command ${command}`);
    }
  }

  private service(id: unknown) {
    const service = serviceFor(String(id));
    if (!service) throw Error(`No service ${String(id)}`);
    return service;
  }

  list() {
    const storage = this.deps.secrets.status();
    return {
      storage,
      services: this.services.map((s) => ({
        id: s.id,
        name: s.name,
        via: s.via,
        summary: s.summary,
        usedFor: s.usedFor,
        keyUrlLabel: s.keyUrlLabel,
        keyRequired: !!s.keyRequired,
        key: this.deps.secrets.info(secretName(s.id)),
        mode: this.mode(s.id),
        usage: this.deps.usage.usage(s.id),
      })),
    };
  }
}

/** Keys from older settings files (plain JSON) move into the secret store, and leave the file. */
export async function migratePlaintextKeys(settings: AppSettingsStore, secrets: SecretStore) {
  const current = settings.get();
  if (secrets.status().locked) return false;
  const moves: [string, string][] = [];
  if (current.openalexApiKey) moves.push([secretName("openalex"), current.openalexApiKey]);
  const providers: AppSettings["webProviders"] = {};
  for (const [id, entry] of Object.entries(current.webProviders ?? {})) {
    const service = PROVIDERS.find((p) => p.id === id)?.capabilities.service;
    if (entry.apiKey && service) moves.push([secretName(service), entry.apiKey]);
    const { apiKey, ...rest } = entry;
    providers[id] = service ? rest : entry;
  }
  if (!moves.length) return false;
  for (const [name, value] of moves) if (!secrets.get(name)) await secrets.set(name, value);
  await settings.update({ openalexApiKey: "", webProviders: providers });
  return true;
}

/** The app settings as the renderer may see them: without any key. */
export function publicSettings(settings: AppSettings): AppSettings {
  const webProviders: AppSettings["webProviders"] = {};
  for (const [id, entry] of Object.entries(settings.webProviders ?? {})) webProviders[id] = { enabled: entry.enabled };
  return { ...settings, openalexApiKey: "", webProviders };
}
