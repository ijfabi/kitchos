# Progress log

## Milestone 1 — Foundation + first verified vertical slice (2026-10-26)

### Implemented

- Monorepo (pnpm/Turborepo, strict TypeScript 5.9, ESLint, Prettier), Docker Compose with
  PostgreSQL 18 and Redis 8, GitHub Actions CI (lint, format, typecheck, unit, integration,
  schema-drift, audit).
- Schema `0001_foundation` + `0002_runtime_grants`: tenancy hierarchy, identity, catalog with
  versioned menus/recipes, append-only stock ledger + trigger-maintained balances, reservations,
  orders/lines/modifiers/ingredient snapshots, payments, kitchen tasks, outbox with store
  sequences + NOTIFY, inbox, idempotency keys, audit log; RLS on all tenant tables; immutability
  and append-only triggers; least-privilege runtime role.
- Domain package: integer money with exact rounding, quantities, state machines (order, payment,
  kitchen task), server-side pricing with modifiers/combos/GST, recipe explosion.
- API (NestJS 12, ESM): staff login + scoped permissions; public menu; idempotent guest order
  placement with stock reservation; sandbox card payment; acceptance → station routing → kitchen
  tasks; start/complete with configurable consumption point and exactly-once ledger entries;
  ready/handoff; cancellation with manager rule after production; inventory balance/movement
  queries; SSE live events; health, readiness, Prometheus metrics, structured logs.
- Seed: KitchOS Central, Drive and Express with distinct menus, prices, stations, stock, staff,
  shortage policies; plus an isolation-test tenant (Rival Foods).

### Tests executed (local, Windows 11, Docker Desktop, Node 24.22)

| Suite                                   | Result       |
| --------------------------------------- | ------------ |
| `@kitchos/domain` unit + property tests | 15/15 passed |
| `@kitchos/api` integration (PG 18)      | 21/21 passed |
| ESLint / Prettier / tsc (4 packages)    | clean        |

Mutation check: removing the balance-row `FOR UPDATE` in `reserve()` makes the dedicated
concurrency test fail (6/6 reservations succeed against 2 units) — the test has teeth.

### Findings

- Order placement is already serialised per store by the order-number counter row lock; the
  balance row lock is still required for paths without a counter (consumption, future waste and
  transfers). Recorded as R-001.

### Remaining defects / gaps

See `RISKS.md` and `FEATURE_MATRIX.md`. Notably: no outbox relay, no MFA/OIDC, no offline edge,
UI in progress, no POS yet.

### Next work items

See "Immediate next tasks" in `IMPLEMENTATION_PLAN.md`.
