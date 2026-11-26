// Remote metadata lookups (OpenAlex, Crossref, Semantic Scholar …) fail in two ways: for a
// while (rate limits, quotas, 5xx, timeouts, offline) or for good (not found, nothing to
// look up). Transient failures are retried with exponential backoff and jitter, honouring a
// provider's "retry after"; permanent ones are not. Errors arrive as host strings, so the
// classification reads the message.

export type LookupFailure = 'transient' | 'permanent';

const PERMANENT =
  /\bnot found\b|has no record|found no reliable|not in openalex|\b404\b|\b410\b|no usable doi|did not contain a usable|does not contain enough|not enough title|invalid reference|no such|unknown (work|source|id)|returned invalid metadata|\b400\b|\b422\b/i;

/** Whether trying again later could help. Unknown errors count as transient (attempts are bounded). */
export function classifyLookupError(error: unknown): LookupFailure {
  return PERMANENT.test(errorText(error)) ? 'permanent' : 'transient';
}

export function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text.replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '');
}

/** A provider's requested wait in ms, from "retry after about 30s" or "Retry-After: 30". */
export function retryAfterMs(error: unknown): number | undefined {
  const text = errorText(error);
  const match = /retry[- ]after(?::|\s+about)?\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)?/i.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return match[2]?.toLowerCase() === 'ms' ? value : value * 1000;
}

export interface RetryPolicy {
  /** Total tries, the first included. */
  attempts: number;
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 1500, maxMs: 30_000 };

/**
 * The wait before retry `attempt` (1 = the first retry): exponential, with jitter in the
 * upper half so retries from several cards spread out, never shorter than the provider asked.
 */
export function retryDelay(
  attempt: number,
  policy: Pick<RetryPolicy, 'baseMs' | 'maxMs'> = DEFAULT_RETRY,
  requestedMs?: number,
  random: () => number = Math.random,
) {
  const exponential = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  const jittered = exponential * (0.5 + random() * 0.5);
  return Math.round(Math.max(jittered, requestedMs ?? 0));
}

export class LookupError extends Error {
  constructor(
    readonly cause: unknown,
    readonly failure: LookupFailure,
    /** True when transient tries ran out (or the provider asked to wait longer than we will). */
    readonly exhausted: boolean,
  ) {
    super(errorText(cause));
    this.name = 'LookupError';
  }
}

export interface RetryOptions extends Partial<RetryPolicy> {
  signal?: AbortSignal;
  /** Called before each wait; `attempt` is the retry about to run. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

const sleepFor = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });

/** Runs `run` until it succeeds, fails for good, or the tries run out (then a LookupError). */
export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const policy = { ...DEFAULT_RETRY, ...lookupTestPolicy(), ...stripUndefined(options) };
  const sleep = options.sleep ?? sleepFor;
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');
      return await run(attempt);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure = classifyLookupError(error);
      if (failure === 'permanent') throw new LookupError(error, failure, false);
      const requested = retryAfterMs(error);
      if (attempt + 1 >= policy.attempts || (requested ?? 0) > policy.maxMs * 2) {
        throw new LookupError(error, failure, true);
      }
      const delay = retryDelay(attempt + 1, policy, requested, options.random);
      options.onRetry?.(attempt + 1, delay, error);
      await sleep(delay, options.signal);
    }
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ── Test seam ────────────────────────────────────────────────────────────────
// Smokes cannot make a provider return 429 on demand. `window.__KEY_LOOKUP_FAULTS__ =
// { scholarly: 3, baseMs: 200 }` makes the next three lookups on that channel fail as rate
// limited (and shortens the waits). Absent in normal use.
type FaultTable = Record<string, number | undefined> & { baseMs?: number; attempts?: number };
const faults = () =>
  (globalThis as unknown as { __KEY_LOOKUP_FAULTS__?: FaultTable }).__KEY_LOOKUP_FAULTS__;

function lookupTestPolicy(): Partial<RetryPolicy> {
  const table = faults();
  if (!table) return {};
  return stripUndefined({ baseMs: table.baseMs, attempts: table.attempts });
}

/** True while simulated failures are queued for `channel`. */
export function lookupFaultPending(channel: string) {
  return (faults()?.[channel] ?? 0) > 0;
}

/** Throws a simulated rate limit when one is queued for `channel`. */
export function takeLookupFault(channel: string) {
  const table = faults();
  const left = table?.[channel] ?? 0;
  if (!table || left <= 0) return;
  table[channel] = left - 1;
  throw new Error('Provider rate limited the lookup (HTTP 429)');
}
