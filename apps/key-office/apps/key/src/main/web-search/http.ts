// Requests for web search providers: JSON over fetch, errors that say whether trying again
// may help (and when), retries with backoff that honour Retry-After, and a small cache so
// paging back and forth or retyping a query does not ask again.

/** Why a provider gave no answer. `transient` errors are worth another try. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly transient = false,
    /** From Retry-After, when the provider said. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export const isAbort = (error: unknown) => error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

/** Retry-After as seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export async function getJson<T>(url: string, init: { signal?: AbortSignal; headers?: Record<string, string>; fetch?: Fetch; label: string }): Promise<T> {
  let response: Response;
  try {
    // Each attempt gets 15 s; the caller's signal cancels it sooner.
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    response = await (init.fetch ?? fetch)(url, { headers: { Accept: "application/json", ...init.headers }, signal });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ProviderError(`Couldn't reach ${init.label}`, undefined, true);
  }
  if (response.ok) {
    try {
      return (await response.json()) as T;
    } catch {
      throw new ProviderError(`${init.label} sent an unreadable answer`, response.status, true);
    }
  }
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  if (response.status === 429) throw new ProviderError(`${init.label} is limiting requests`, 429, true, retryAfter);
  if (response.status >= 500) throw new ProviderError(`${init.label} is not answering (HTTP ${response.status})`, response.status, true, retryAfter);
  if (response.status === 401 || response.status === 403) throw new ProviderError(`${init.label} refused the API key`, response.status);
  throw new ProviderError(`${init.label} returned HTTP ${response.status}`, response.status);
}

export interface RetryOptions {
  attempts?: number;
  /** First backoff; doubled each time. */
  baseMs?: number;
  /** A Retry-After longer than this is not waited for: the error goes to the user. */
  maxWaitMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (error: ProviderError, attempt: number, waitMs: number) => void;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", stop, { once: true });
  });

/** Runs `task` again after transient errors: 1 s, 2 s … or what Retry-After asks, if not too long. */
export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const wait = options.sleep ?? sleep;
  let delay = options.baseMs ?? 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (options.signal?.aborted || !(error instanceof ProviderError) || !error.transient || attempt >= attempts) throw error;
      const ms = error.retryAfterMs ?? delay;
      if (ms > (options.maxWaitMs ?? 10_000)) throw error;
      options.onRetry?.(error, attempt, ms);
      await wait(ms, options.signal);
      delay *= 2;
    }
  }
}

/** A few minutes of answers, newest kept. */
export class TtlCache<T> {
  private entries = new Map<string, { at: number; value: T }>();
  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly size = 200,
  ) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T) {
    this.entries.delete(key);
    this.entries.set(key, { at: Date.now(), value });
    while (this.entries.size > this.size) this.entries.delete(this.entries.keys().next().value!);
  }
  clear() {
    this.entries.clear();
  }
}
