import { useRef } from 'react';
import { ApiError, newIdempotencyKey } from './api';

/** A network or server failure: the request may have been recorded even though it looks failed. */
export const outcomeUnknown = (err: unknown) =>
  !(err instanceof ApiError) || err.status === 0 || err.status >= 500;

export const OUTCOME_UNKNOWN_HINT =
  'This may already have been recorded. Retry without changing anything, or check before editing.';

/**
 * One idempotency key per submission attempt. The key survives network and 5xx
 * failures so a retry of the same body replays the original result; it rotates
 * after a definitive answer, or when the body changes (the API rejects a reused
 * key with a different body).
 */
export function useAttemptKey() {
  const attempt = useRef<{ key: string; body: string } | null>(null);
  return {
    keyFor(body: unknown): string {
      const json = JSON.stringify(body);
      if (attempt.current?.body !== json) {
        attempt.current = { key: newIdempotencyKey(), body: json };
      }
      return attempt.current.key;
    },
    settle(err?: unknown): void {
      const definitive =
        err === undefined || (err instanceof ApiError && err.status >= 400 && err.status < 500);
      if (definitive) attempt.current = null;
    },
  };
}
