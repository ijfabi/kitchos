import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Arbitrary constant: serialises concurrent migrators (e.g. several replicas booting).
const MIGRATION_LOCK_KEY = 72_406_117;

/**
 * Forward-only SQL migrations. Each file runs in its own transaction and is
 * recorded with a checksum; editing an applied migration is an error rather
 * than a silent divergence between environments.
 */
export async function migrate(
  connectionString: string,
  log: (msg: string) => void = console.log,
): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`create table if not exists schema_migrations (
      name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    const done = new Map(
      (
        await client.query<{ name: string; checksum: string }>(
          'select name, checksum from schema_migrations',
        )
      ).rows.map((r) => [r.name, r.checksum]),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(body.replace(/\r\n/g, '\n')).digest('hex');
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum)
          throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      log(`applying ${file}`);
      await client.query('begin');
      try {
        await client.query(body);
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client
      .query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    await client.end();
  }
  return applied;
}

/** Development/test only: drops everything owned by the connecting role. */
export async function resetDatabase(connectionString: string): Promise<void> {
  const url = new URL(connectionString);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) &&
    process.env.KITCHOS_ALLOW_RESET !== '1'
  ) {
    throw new Error(`Refusing to reset non-local database host ${url.hostname}`);
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('drop schema if exists app cascade');
    await client.query('drop schema public cascade');
    await client.query('create schema public');
  } finally {
    await client.end();
  }
}
