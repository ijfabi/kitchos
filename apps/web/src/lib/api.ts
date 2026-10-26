import type { ApiError as ApiErrorBody } from '@kitchos/contracts';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string | null;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Statuses that carry a normal response body rather than an error (e.g. 402 payment declined). */
  acceptStatuses?: number[];
}

export async function api<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Cannot reach KitchOS. Check your connection and try again.',
    );
  }
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : undefined;
  if (res.ok || opts.acceptStatuses?.includes(res.status))
    return { status: res.status, data: json as T };
  const body = json as ApiErrorBody | undefined;
  throw new ApiError(
    res.status,
    body?.error.code ?? `HTTP_${res.status}`,
    body?.error.message ?? res.statusText,
    body?.error.details,
  );
}

export const get = async <T>(path: string, token?: string | null, signal?: AbortSignal) =>
  (await api<T>(path, { token, signal })).data;

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
