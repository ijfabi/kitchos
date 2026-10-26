# ADR-0003: Kysely + hand-written SQL migrations instead of Prisma

- Status: Accepted (2026-10-26)

## Context

The brief prefers Prisma "or another suitable typed data access layer". KitchOS's correctness
depends heavily on database features: row-level security policies, CHECK constraints,
partial unique indexes, `SECURITY DEFINER` functions, append-only and immutability triggers,
`SELECT … FOR UPDATE` in deterministic order, `ON CONFLICT … DO NOTHING` against named
constraints, and `set_config` per transaction.

## Decision

- Schema is defined in **forward-only SQL migrations** (`packages/database/migrations`), applied by
  a small runner that records SHA-256 checksums and takes an advisory lock.
- Queries use **Kysely** (typed SQL builder). Types are **generated from the live schema** with
  kysely-codegen (`pnpm --filter @kitchos/database codegen`) and committed.
- pg type parsers: `int8 → number` (throws beyond 2^53), `numeric → string` (exact), `date → string`
  (never a timezone-shifted JS Date).

## Consequences

- Full control of locking, constraints and RLS; the SQL is reviewable as SQL.
- Generated types must be regenerated after each migration (CI should verify; tracked in PLAN).
- No ORM-level relation helpers; repositories write explicit joins.
