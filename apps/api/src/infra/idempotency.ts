import { createHash } from 'node:crypto';
import type { Tx } from '@kitchos/database';
import { ApiException } from './http-errors.ts';

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function requireIdempotencyKey(header: string | string[] | undefined): string {
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || !KEY_PATTERN.test(key)) {
    throw new ApiException(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'An Idempotency-Key header of 8-128 URL-safe characters is required',
    );
  }
  return key;
}

/**
 * Executes `fn` at most once per (tenant, scope, key) within the caller's
 * transaction. Concurrent duplicates block on the primary key until the first
 * commits, then receive its stored response. If `fn` throws, the whole
 * transaction (including the key) rolls back, so a failed attempt can be
 * retried with the same key. Reusing a key with a different body is rejected.
 */
export async function idempotent<T>(
  tx: Tx,
  orgId: string,
  scope: string,
  key: string,
  request: unknown,
  fn: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  const requestHash = createHash('sha256').update(stableStringify(request)).digest('hex');
  const inserted = await tx
    .insertInto('idempotency_keys')
    .values({ org_id: orgId, scope, key, request_hash: requestHash })
    .onConflict((oc) => oc.doNothing())
    .returning('key')
    .executeTakeFirst();

  if (!inserted) {
    const prior = await tx
      .selectFrom('idempotency_keys')
      .select(['request_hash', 'response_status', 'response_body'])
      .where('org_id', '=', orgId)
      .where('scope', '=', scope)
      .where('key', '=', key)
      .executeTakeFirstOrThrow();
    if (prior.request_hash !== requestHash) {
      throw new ApiException(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was used for a different request',
      );
    }
    if (prior.response_status === null) {
      throw new ApiException(
        409,
        'IDEMPOTENT_REQUEST_IN_PROGRESS',
        'The original request is still being processed',
      );
    }
    return { status: prior.response_status, body: prior.response_body as T, replayed: true };
  }

  const result = await fn();
  await tx
    .updateTable('idempotency_keys')
    .set({ response_status: result.status, response_body: JSON.stringify(result.body) })
    .where('org_id', '=', orgId)
    .where('scope', '=', scope)
    .where('key', '=', key)
    .execute();
  return { ...result, replayed: false };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
