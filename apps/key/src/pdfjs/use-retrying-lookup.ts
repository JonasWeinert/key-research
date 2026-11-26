import { useCallback, useEffect, useRef, useState } from 'react';
import { LookupError, errorText, takeLookupFault, withRetry, type RetryOptions } from './remote-retry';

/**
 * loading: show a skeleton (first try or a transient failure being retried).
 * missing: the provider has nothing (permanent). unavailable: transient tries ran out.
 */
export type RetryingLookup<T> =
  | { status: 'idle' }
  | { status: 'loading'; attempt: number }
  | { status: 'ready'; value: T }
  | { status: 'missing'; error: string }
  | { status: 'unavailable'; error: string };

/**
 * Runs a remote lookup for `key` (null: nothing to look up), retrying transient failures in
 * the background. `retry()` starts again after it gave up. `channel` names the test seam.
 */
export function useRetryingLookup<T>(
  key: string | null,
  run: (attempt: number) => Promise<T>,
  options: { channel?: string } & Omit<RetryOptions, 'signal' | 'onRetry'> = {},
): [RetryingLookup<T>, () => void] {
  const runRef = useRef(run);
  runRef.current = run;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [round, setRound] = useState(0);
  const [state, setState] = useState<RetryingLookup<T>>({ status: 'idle' });
  useEffect(() => {
    if (key === null) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading', attempt: 0 });
    const { channel, ...retry } = optionsRef.current;
    withRetry(
      attempt => {
        if (channel) takeLookupFault(channel);
        return runRef.current(attempt);
      },
      {
        ...retry,
        signal: controller.signal,
        onRetry: attempt => {
          if (!controller.signal.aborted) setState({ status: 'loading', attempt });
        },
      },
    ).then(
      value => {
        if (!controller.signal.aborted) setState({ status: 'ready', value });
      },
      error => {
        if (controller.signal.aborted) return;
        const permanent = error instanceof LookupError && error.failure === 'permanent';
        setState({ status: permanent ? 'missing' : 'unavailable', error: errorText(error) });
      },
    );
    return () => controller.abort();
  }, [key, round]);
  const again = useCallback(() => setRound(value => value + 1), []);
  return [state, again];
}
