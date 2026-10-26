# Progress log

## Milestone 2 — Customer, kitchen, expo and pickup UI on the live API (2026-10-26)

### Implemented

- `apps/web` (Next.js 16, React 19, Tailwind 4, TanStack Query): restaurant picker; customer
  ordering with search, categories, allergen/energy info, modifier and meal customisation,
  cart, sandbox checkout and live order tracking with declined-payment retry; staff sign-in and
  workspace picker filtered by permissions; kitchen display per station with ageing timers,
  modifier call-outs, recipe notes, optimistic-concurrency commands, SSE live updates with
  polling fallback and a connection indicator; expo/handoff board; public pickup board.
- Playwright journey test driving the real UI end to end.

### Tests executed

| Suite                                  | Result       |
| -------------------------------------- | ------------ |
| `@kitchos/domain` unit + property      | 15/15 passed |
| `@kitchos/api` integration (PG 18)     | 21/21 passed |
| Playwright E2E (Chromium, local stack) | 1/1 passed   |
| ESLint / Prettier / tsc (5 packages)   | clean        |
| `next build` (production)              | succeeded    |

### Findings

- Port 3000 on the development machine is held by an unrelated Docker container; the web app
  now runs on **3100** (API CORS default updated).
- An early version of the E2E test passed vacuously: `getByText('Collected')` matched the
  progress-step label rather than the order status. Assertions now target the status element
  (`data-testid="order-status"`) and were re-verified.

### Remaining gaps

E2E not yet in CI; no POS; staff session in `sessionStorage` (device identity pending);
kitchen ageing thresholds are display constants, not per-restaurant configuration.

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
