import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LookupError,
  classifyLookupError,
  lookupFaultPending,
  retryAfterMs,
  retryDelay,
  takeLookupFault,
  withRetry,
} from './remote-retry';

describe('classifyLookupError', () => {
  it('treats rate limits, server errors, timeouts and the offline case as transient', () => {
    for (const message of [
      'Semantic Scholar rate limited the lookup; retry after about 30s',
      'Semantic Scholar returned HTTP 503',
      'OpenAlex: HTTP 429 Too Many Requests',
      'Metadata lookup timed out',
      'Metadata lookup pending; retry after lease expiry',
      'OpenAlex: error sending request: connection refused',
    ]) {
      expect(classifyLookupError(new Error(message))).toBe('transient');
    }
  });
  it('treats not found and unusable references as permanent', () => {
    for (const message of [
      'Semantic Scholar has no record for this DOI',
      'Semantic Scholar found no reliable title match',
      'Not in OpenAlex yet',
      'provider returned HTTP 404',
      'Work not found',
      'the reference did not contain a usable DOI or title',
      'The reference does not contain enough title text to match',
    ]) {
      expect(classifyLookupError(message)).toBe('permanent');
    }
  });
  it('reads Electron-wrapped IPC errors', () => {
    expect(
      classifyLookupError(new Error("Error invoking remote method 'key:invoke': Error: Work not found")),
    ).toBe('permanent');
  });
});

describe('retryAfterMs', () => {
  it('reads the provider cooldown in seconds and milliseconds', () => {
    expect(retryAfterMs('rate limited the lookup; retry after about 30s')).toBe(30_000);
    expect(retryAfterMs('HTTP 429, Retry-After: 4')).toBe(4000);
    expect(retryAfterMs('retry after 250ms')).toBe(250);
    expect(retryAfterMs('HTTP 503')).toBeUndefined();
  });
});

describe('retryDelay', () => {
  it('grows exponentially, jitters in the upper half and caps', () => {
    const policy = { baseMs: 1000, maxMs: 8000 };
    expect(retryDelay(1, policy, undefined, () => 0)).toBe(500);
    expect(retryDelay(1, policy, undefined, () => 1)).toBe(1000);
    expect(retryDelay(3, policy, undefined, () => 1)).toBe(4000);
    expect(retryDelay(10, policy, undefined, () => 1)).toBe(8000);
  });
  it('never retries sooner than the provider asked', () => {
    expect(retryDelay(1, { baseMs: 1000, maxMs: 8000 }, 6000, () => 0)).toBe(6000);
  });
});

describe('withRetry', () => {
  const instant = () => Promise.resolve();
  it('retries transient failures and returns the first success', async () => {
    const run = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error('HTTP 429'))
      .mockRejectedValueOnce(new Error('HTTP 502'))
      .mockResolvedValue('ok');
    const waits: number[] = [];
    await expect(
      withRetry(run, { sleep: instant, random: () => 1, baseMs: 100, onRetry: (_, ms) => waits.push(ms) }),
    ).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([100, 200]);
  });
  it('does not retry permanent failures', async () => {
    const run = vi.fn(() => Promise.reject(new Error('Work not found')));
    const error = await withRetry(run, { sleep: instant }).catch(e => e);
    expect(error).toBeInstanceOf(LookupError);
    expect(error.failure).toBe('permanent');
    expect(error.exhausted).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('gives up after the bounded attempts', async () => {
    const run = vi.fn(() => Promise.reject(new Error('timed out')));
    const error = await withRetry(run, { sleep: instant, attempts: 3 }).catch(e => e);
    expect(error.exhausted).toBe(true);
    expect(error.failure).toBe('transient');
    expect(run).toHaveBeenCalledTimes(3);
  });
  it('gives up at once when the provider asks to wait far longer than we would', async () => {
    const run = vi.fn(() => Promise.reject(new Error('rate limited; retry after about 3600s')));
    const error = await withRetry(run, { sleep: instant }).catch(e => e);
    expect(error.exhausted).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('stops when aborted', async () => {
    const controller = new AbortController();
    const run = vi.fn(() => Promise.reject(new Error('HTTP 500')));
    const pending = withRetry(run, {
      signal: controller.signal,
      sleep: () => {
        controller.abort();
        return Promise.reject(new Error('aborted'));
      },
    });
    await expect(pending).rejects.toThrow('aborted');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('lookup fault seam', () => {
  afterEach(() => {
    delete (globalThis as { __KEY_LOOKUP_FAULTS__?: unknown }).__KEY_LOOKUP_FAULTS__;
  });
  it('fails the queued number of lookups as rate limited', () => {
    (globalThis as { __KEY_LOOKUP_FAULTS__?: unknown }).__KEY_LOOKUP_FAULTS__ = { scholarly: 2 };
    expect(lookupFaultPending('scholarly')).toBe(true);
    expect(() => takeLookupFault('scholarly')).toThrow(/429/);
    expect(() => takeLookupFault('scholarly')).toThrow(/429/);
    expect(() => takeLookupFault('scholarly')).not.toThrow();
    expect(lookupFaultPending('scholarly')).toBe(false);
  });
});
