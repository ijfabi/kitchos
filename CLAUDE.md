# CLAUDE.md — working on KitchOS

KitchOS is a multi-tenant restaurant operating system. Read `docs/architecture/overview.md`,
`docs/IMPLEMENTATION_PLAN.md` and `docs/PROGRESS.md` before starting work.

## Commands

```bash
pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:seed   # local Postgres 18 on :55432, Redis on :56379
pnpm db:reset                                   # drop + migrate + seed (local only)
pnpm --filter @kitchos/api dev                  # API on :4000
pnpm --filter @kitchos/web dev                  # web on :3000
pnpm lint && pnpm format:check && pnpm typecheck
pnpm --filter @kitchos/domain test              # unit + property tests
pnpm --filter @kitchos/api test                 # integration (starts its own PG container)
pnpm --filter @kitchos/database codegen         # regenerate Kysely types after a migration
```

## Non-negotiable rules

- **Money** is integer cents (`Cents`); never floats, never `parseFloat`. Divide only via
  `divRoundHalfUp`/`inclusiveTax`/`allocate` in `@kitchos/domain`.
- **Quantities** are `numeric(18,3)` strings in the DB and integer milli-units in TS
  (`parseDecimalQty`/`formatDecimalQty`).
- **Never trust client tenant ids or prices.** Run tenant work inside `withTenant(db, { orgId }, …)`.
- **Ledgers are append-only.** Never UPDATE/DELETE `stock_movements`, `audit_log`,
  `order_line_ingredients`; correct with new movements.
- **Every stock movement has a unique source** (`source_type`, `source_id`, `source_key`) so
  replays are no-ops. Insert with `ON CONFLICT ON CONSTRAINT stock_movements_source_unique DO NOTHING`.
- **Lock order:** order → kitchen task → stock balances (ascending item id) → event sequence.
  Append outbox events last.
- **State changes** go through the domain state machines and a version-checked `UPDATE`.
- **Published menu/recipe versions are immutable**; publish a new version instead.
- New schema → new migration file (never edit an applied one) → regenerate types → grant the
  runtime role only what it needs in a migration.
- NestJS providers use explicit `@Inject(Token)`; there is no `emitDecoratorMetadata`.
- Do not mark a feature done without persisted state, server-side enforcement, tests that check
  persisted state, and updated docs (`FEATURE_MATRIX.md`, `PROGRESS.md`).
- Never invent metrics. Benchmarks need hardware, workload, duration and raw results.
- Ask before spending money, using credentials, destructive actions or external publishing.

## Layout

`apps/api` (NestJS, bounded contexts per folder) · `apps/web` (Next.js surfaces) ·
`packages/domain` (pure rules) · `packages/contracts` (Zod wire schemas) ·
`packages/database` (migrations, Kysely client, seed) · `infrastructure/docker` · `docs/`.
