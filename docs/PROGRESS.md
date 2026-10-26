# Progress log

## Milestone 4 — POS core: staff order entry, cash tender, park / recall / void (2026-10-27)

### Implemented

- Migration `0004_pos_cash_payments`: per-restaurant `cash_rounding_increment_cents` (default 5c),
  payment `tendered_cents`, `change_cents`, `cash_rounding_cents`, `received_by`, with CHECK
  constraints enforcing `tendered = amount + rounding + change` for cash and no cash fields on
  card payments; method/provider consistency.
- Domain: `settleCash` / `cashPayableCents` (bigint, half-up to the increment, property-tested).
- API: `POST /v1/restaurants/:id/orders` (staff order entry, `orders.create`, attributed to the
  user, channel `pos` | `drive_thru`) and `POST …/orders/:orderId/payments` (cash or sandbox card,
  idempotent, restaurant-scoped). Public guest payments remain card-token only. Order view exposes
  `cashDueCents`; menu exposes the restaurant's cash rounding increment.
- POS UI (`/pos/:restaurantId`): touch product grid, modifier dialog, ticket, cash panel with
  cash-due display and quick tenders, change-due screen, sandbox card, park / recall / void.
- CI: new Playwright job running both journeys against a migrated, seeded PostgreSQL service.

### Independent review and testing (subagents)

- **Code review**: no critical/high defects; confirmed DB constraints, tenant scope, public-cash
  block and double-capture protection. Fixed its medium findings: the POS now keeps the payment
  idempotency key on network/5xx errors and, on `ORDER_NOT_AWAITING_PAYMENT`, refetches the order
  and shows the completed sale instead of inviting a second tender; the POS shows the rounded
  cash due and bases quick tenders on it. Also fixed: stale cash state on recall, Enter-key
  double submit guard, float-free tender formatting.
- **Adversarial testing** (`test/pos-adversarial.test.ts`, 12 scenarios): found a genuine defect —
  replaying a staff payment's idempotency key through **another restaurant's route** returned that
  restaurant's order (200) because the replay happened before the restaurant check. Fixed by
  scoping payment keys per surface and restaurant; the test is kept as a regression and
  mutation-checked (reverting the scope makes it fail).

### Tests executed

| Suite                                | Result                      |
| ------------------------------------ | --------------------------- |
| `@kitchos/domain`                    | 23/23 passed                |
| `@kitchos/api` integration           | 49/49 passed (×4, shuffled) |
| Playwright (customer journey, POS)   | 2/2 passed                  |
| ESLint / Prettier / tsc (5 packages) | clean                       |
| `next build`                         | succeeded                   |

### Findings

- File shuffling exposed another cross-file dependency (a count zeroed Central's coffee beans,
  now used by POS tests); the count test now restores stock after asserting.

### Not done (still open in this phase)

Discounts, coupons, manager overrides, staff/comp meals, receipt printing, refunds (need the
journal), till/drawer sessions, drive-thru order recall on the POS (list filters `pos`).

## Milestone 3 — Waste, receiving and counts without double deduction (2026-10-26)

### Implemented

- Migration `0003_inventory_operations`: `waste_prepared` movement type, standard unit costs,
  per-restaurant approval thresholds, `waste_records` + append-only `waste_record_lines`
  (treatment per ingredient), append-only goods receipts and stock counts; RLS and
  least-privilege grants (only review columns of a waste record are updatable).
- `InventoryService.recordMovements` — the single locked, idempotent path for all ledger writes
  (consumption refactored onto it with no behaviour change: 21/21 still passing).
- Waste API: raw and prepared waste, order-line-linked waste using the immutable ingredient
  snapshot, remakes, overproduction waste from the pinned recipe, approval/rejection with
  segregation of duties and compensating corrections, list and summary (reason/station/
  employee, reclassified vs direct cost).
- Goods receipts (with lot/expiry capture) and physical counts (variance vs locked on-hand,
  approval above threshold).
- Domain: exact standard-cost valuation (`extendedCostCents`, bigint arithmetic, property test).
- ADR-0011.

### Tests executed

| Suite                                | Result                      |
| ------------------------------------ | --------------------------- |
| `@kitchos/domain`                    | 18/18 passed                |
| `@kitchos/api` integration           | 31/31 passed (×2, shuffled) |
| ESLint / Prettier / tsc (5 packages) | clean                       |

Mutation check: forcing prepared waste to always deduct makes 3 waste tests fail (invariant 12
test, remake test, summary split).

### Findings

- Integration tests had a hidden cross-file dependency (a count zeroed patties used by other
  files); exposed when Vitest reordered files. Fixed, and file order is now shuffled every run.
- A mutation edit using `//` silently broke compilation and reported "no tests" — a reminder to
  confirm a mutation run actually executes tests before trusting it.

### Next

Inventory/waste UI for managers and crew; POS; outbox relay + journal postings.

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
