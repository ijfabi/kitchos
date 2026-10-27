import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { DB } from './generated/db.ts';

/**
 * int8 (bigint) columns hold money in cents and counters. Parse them to JS
 * numbers but refuse anything beyond 2^53 rather than silently losing
 * precision. numeric stays a string and is converted exactly by
 * @kitchos/domain parseDecimalQty.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${value} exceeds safe integer range`);
  return n;
});
// Business dates are calendar dates in the restaurant's timezone; never turn
// them into a JS Date (which would apply the server's local timezone).
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export type Database = Kysely<DB>;
export type Tx = Transaction<DB>;

export interface CreateDbOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
}

export function createDb({
  connectionString,
  max = 10,
  applicationName = 'kitchos',
}: CreateDbOptions): {
  db: Database;
  pool: pg.Pool;
} {
  const pool = new pg.Pool({
    connectionString,
    max,
    application_name: applicationName,
    // Server-side limits.
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 30_000,
    // Detect half-open connections (network blip, host sleep/resume) with TCP
    // keepalive, and never wait forever for a pooled connection. (A client-side
    // query_timeout is deliberately not used: node-postgres would return the
    // timed-out socket to the pool.)
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}

/** Identity of whoever is performing a tenant-scoped operation. */
export interface TenantContext {
  readonly orgId: string;
  readonly userId?: string | null;
  readonly deviceId?: string | null;
}

/**
 * Runs `fn` in a transaction bound to one tenant. `app.org_id` is set with
 * is_local = true so it cannot leak to the next user of the pooled connection,
 * and every RLS policy filters on it.
 */
export async function withTenant<T>(
  db: Database,
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
  options: { isolation?: 'read committed' | 'repeatable read' | 'serializable' } = {},
): Promise<T> {
  return db
    .transaction()
    .setIsolationLevel(options.isolation ?? 'read committed')
    .execute(async (tx) => {
      await sql`select set_config('app.org_id', ${ctx.orgId}, true)`.execute(tx);
      return fn(tx);
    });
}
