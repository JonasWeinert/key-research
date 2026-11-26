// How often each API key was used: requests today and this month, the last use, the last
// error and the remaining quota when the service reports one. Kept in userData
// (service-usage.json) with the per-service preference; never holds a key.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type KeyMode = "fallback" | "always";
export interface ServiceUsage {
  day: string;
  today: number;
  month: string;
  thisMonth: number;
  total: number;
  lastUsedAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  /** As the service last reported it. */
  remaining?: number;
  remainingLabel?: string;
  remainingAt?: number;
  /** The last validation: "valid" or "invalid". */
  validity?: "valid" | "invalid";
  validatedAt?: number;
}
export interface Outcome {
  /** Requests made with the key (default 1). */
  requests?: number;
  ok: boolean;
  error?: string;
  remaining?: number;
  remainingLabel?: string;
  /** The service refused the key itself (401, 403 with a key). */
  invalid?: boolean;
  at?: number;
}
interface FileShape {
  usage: Record<string, ServiceUsage>;
  modes: Record<string, KeyMode>;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const dayOf = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const monthOf = (at: number) => dayOf(at).slice(0, 7);
const empty = (at: number): ServiceUsage => ({ day: dayOf(at), today: 0, month: monthOf(at), thisMonth: 0, total: 0 });

/** Counters roll over at local midnight and at the first of the month. */
export function rolled(usage: ServiceUsage | undefined, at: number): ServiceUsage {
  const out = { ...(usage ?? empty(at)) };
  if (out.day !== dayOf(at)) {
    out.day = dayOf(at);
    out.today = 0;
  }
  if (out.month !== monthOf(at)) {
    out.month = monthOf(at);
    out.thisMonth = 0;
  }
  return out;
}

export function applyOutcome(usage: ServiceUsage | undefined, outcome: Outcome): ServiceUsage {
  const at = outcome.at ?? Date.now();
  const out = rolled(usage, at);
  const requests = Math.max(0, outcome.requests ?? 1);
  out.today += requests;
  out.thisMonth += requests;
  out.total += requests;
  if (requests) out.lastUsedAt = Math.max(out.lastUsedAt ?? 0, at);
  if (outcome.ok) {
    if (outcome.invalid === false || out.validity === "invalid") out.validity = "valid";
  } else if (outcome.error) {
    out.lastError = outcome.error.slice(0, 200);
    out.lastErrorAt = at;
  }
  if (outcome.invalid) out.validity = "invalid";
  if (outcome.remaining !== undefined && Number.isFinite(outcome.remaining)) {
    out.remaining = outcome.remaining;
    out.remainingLabel = outcome.remainingLabel;
    out.remainingAt = at;
  }
  return out;
}

export class UsageStore {
  private file: FileShape = { usage: {}, modes: {} };
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  constructor(private readonly path: string) {}

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      this.file = { usage: parsed?.usage && typeof parsed.usage === "object" ? parsed.usage : {}, modes: parsed?.modes && typeof parsed.modes === "object" ? parsed.modes : {} };
    } catch {
      this.file = { usage: {}, modes: {} };
    }
  }
  usage(id: string, at = Date.now()): ServiceUsage {
    return rolled(this.file.usage[id], at);
  }
  mode(id: string): KeyMode {
    return this.file.modes[id] === "always" ? "always" : "fallback";
  }
  setMode(id: string, mode: KeyMode) {
    this.file.modes[id] = mode === "always" ? "always" : "fallback";
    this.save(true);
  }
  record(id: string, outcome: Outcome) {
    this.file.usage[id] = applyOutcome(this.file.usage[id], outcome);
    this.save();
  }
  validated(id: string, valid: boolean, remaining?: { value: number; label?: string }, error?: string) {
    const at = Date.now();
    const usage = rolled(this.file.usage[id], at);
    usage.validity = valid ? "valid" : "invalid";
    usage.validatedAt = at;
    if (!valid && error) {
      usage.lastError = error;
      usage.lastErrorAt = at;
    }
    if (remaining) {
      usage.remaining = remaining.value;
      usage.remainingLabel = remaining.label;
      usage.remainingAt = at;
    }
    this.file.usage[id] = usage;
    this.save(true);
  }
  forget(id: string) {
    delete this.file.usage[id];
    this.save(true);
  }
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Counting is frequent: writes are gathered for a couple of seconds. */
  private save(now = false) {
    for (const listener of this.listeners) listener();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), now ? 0 : 2000);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const run = async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(this.file, null, 2));
      await rename(temporary, this.path);
    };
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => {});
    return next;
  }
}
