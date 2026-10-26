import { spawnSync } from 'node:child_process';

// Options live in .kysely-codegenrc.json and must match the pg type parsers in
// client.ts: int8 -> number (range-checked), numeric -> string, date -> string.
// kysely-codegen reads the connection from DATABASE_URL; point it at the owner.
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('DATABASE_OWNER_URL is required');
const result = spawnSync('npx kysely-codegen', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: url },
});
process.exitCode = result.status ?? 1;
