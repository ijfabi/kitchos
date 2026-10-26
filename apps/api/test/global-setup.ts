import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from '@kitchos/database';
import { seedDemo } from '@kitchos/database/seed';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/**
 * One disposable PostgreSQL 18 per test run, migrated and seeded exactly like
 * a real environment, with the same restricted runtime role (RLS enforced).
 */
export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('kitchos')
    .withUsername('kitchos_owner')
    .withPassword('owner_test')
    .start();
  const ownerUrl = container.getConnectionUri();
  const admin = new pg.Client({ connectionString: ownerUrl });
  await admin.connect();
  await admin.query(`CREATE ROLE kitchos_app LOGIN PASSWORD 'app_test' NOBYPASSRLS`);
  await admin.end();
  await migrate(ownerUrl, () => undefined);
  await seedDemo(ownerUrl, () => undefined);

  const appUrl = new URL(ownerUrl);
  appUrl.username = 'kitchos_app';
  appUrl.password = 'app_test';
  project.provide('ownerUrl', ownerUrl);
  project.provide('appUrl', appUrl.toString());
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
