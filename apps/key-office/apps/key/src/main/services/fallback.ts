// The owner's rule for user-supplied keys: they are a fallback. A request goes out without
// the key first; only when that fails in a way a key can help with (rate limited, over the
// shared quota, refused, or still unreachable after the usual retries) is it sent again with
// the key. "Always use" sends the key from the start.
import { ProviderError, isAbort } from "../web-search/http";
import type { KeyMode, Outcome } from "./usage";

/** Whether the same request with a key could succeed where the keyless one did not. */
export function keyCanHelp(error: unknown) {
  if (error instanceof ProviderError) return error.status === 429 || error.status === 401 || error.status === 402 || error.status === 403 || error.transient;
  // A timeout (not the user's cancel, which callers check first).
  return error instanceof Error && error.name === "TimeoutError";
}

export interface KeyedRun<T> {
  key?: string;
  mode: KeyMode;
  /** The request; `key` is undefined for the keyless attempt. */
  run: (key: string | undefined) => Promise<T>;
  /** Counts each request made with the key. */
  record?: (outcome: Outcome) => void;
  /** The caller gave up (no second attempt then). */
  signal?: AbortSignal;
}

/** What callers (web search, the library hosts) are told about the user's keys. */
export interface ServiceKeys {
  key(service: string): string | undefined;
  mode(service: string): KeyMode;
  record(service: string, outcome: Outcome): void;
}

export async function withKeyFallback<T>({ key, mode, run, record, signal }: KeyedRun<T>): Promise<T> {
  if (!key) return run(undefined);
  if (mode === "fallback") {
    try {
      return await run(undefined);
    } catch (error) {
      if (signal?.aborted || (isAbort(error) && !(error instanceof Error && error.name === "TimeoutError")) || !keyCanHelp(error)) throw error;
    }
  }
  try {
    const value = await run(key);
    record?.({ ok: true });
    return value;
  } catch (error) {
    if (!signal?.aborted) {
      const status = error instanceof ProviderError ? error.status : undefined;
      record?.({ ok: false, error: error instanceof Error ? error.message : "Request failed", invalid: status === 401 || status === 403 });
    }
    throw error;
  }
}
