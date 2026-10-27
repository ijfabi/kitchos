# Progress log

## Milestone 7 — Refunds and payment reversal (2026-10-27)

### Implemented

- Migration `0007_refunds`: `payments.refunded_cents` (CHECK ≤ amount), append-only `refunds`
  (method, amount, refunded-before, cash rounding, treatment, reason), `refund` journal entry
  type, Sales returns account (4200) in the default chart.
- Domain: `refundPostings` (deposit release vs sales return) and `refundGstShare` (cumulative, so
  partial refunds return exactly the order GST at full refund) — property-tested.
- API: `POST /v1/restaurants/:id/orders/:orderId/refunds` (`payments.refund`, supervisor and up;
  idempotent; completed or cancelled orders only; order then payment locked; payment state
  machine; audit; `payment.refunded` event). Ledger consumer posts refunds; reconciliation now
  includes refunds. Order view lists refunds and the refunded amount.
- Orders & refunds screen; Playwright journey refunds part of a handed-over order and checks the
  books still reconcile.
- DB pool hardening: TCP keepalive and a pooled-connection timeout; keepalive on the LISTEN
  connection.
- ADR-0014; resolves R-016.

### Independent review and testing (subagents)

- **Both** the reviewer and the adversarial tester found the same defect, and the tester proved
  it: partial cash refunds were rounded independently, so 3c + 3c + 784c on a 790c cash payment
  handed back 795c. Fixed by recording `refunded_before_cents` under the payment lock and
  computing cash back cumulatively, capped at the cash actually taken (full refund returns
  exactly that); regression test kept and mutation-checked.
- Also fixed from the review: full cash refunds depended on the current rounding increment; GST
  ordering relied on uuidv7 time order (now uses the recorded refunded-before amount); the new
  client-side `query_timeout` would have returned dead sockets to the pool (removed; keepalive
  instead); the UI sent a possibly stale default amount.
- Adversarial suite (10 scenarios) otherwise held: 8 concurrent partial refunds, refunds racing
  handoff and cancel, idempotency abuse, discounted cash orders, comp orders, cross-tenant and
  permission checks, no stock effect, books reconcile.

### Findings

- An E2E run stalled for about an hour (environmental: the host paused); the rerun passed in
  31 s. It prompted the pool keepalive change. The screenshot from that run also exposed a
  vacuous E2E assertion (it matched a refund from an earlier run), now scoped to the refunded
  order's card.
- File shuffling exposed one more cross-file dependency (a global dead-letter count), now
  scoped to the restaurant under test.

### Tests executed

| Suite                                | Result                        |
| ------------------------------------ | ----------------------------- |
| `@kitchos/domain`                    | 40/40 passed                  |
| `@kitchos/api` integration           | 104/104 passed (×3, shuffled) |
| Playwright (5 journeys)              | 5/5 passed                    |
| ESLint / Prettier / tsc (5 packages) | clean                         |
| `next build`                         | succeeded                     |

### Not done

Refund approval for crew (R-018), line-level returns for mixed GST orders (R-019), split tender,
gift cards, till sessions, COGS/waste postings.

## Milestone 6 — Double-entry journal fed by the event dispatcher (2026-10-27)

### Implemented

- Migration `0006_ledger`: per-tenant chart of accounts (stable system keys, default chart via
  `app.create_default_chart`), accounting periods, append-only `journal_entries` / `journal_lines`
  with a deferred constraint trigger that rejects unbalanced entries, a closed-period trigger,
  lines insertable only by the transaction that created their entry, one entry per
  (source, entry type); `event_consumer_failures`; `app.orgs_with_pending_events` (definer
  function returning tenant ids only, PUBLIC execute revoked); dispatcher index.
- Domain: `paymentReceiptPostings`, `saleRecognitionPostings` (deposits before handover; revenue,
  discounts ex GST and GST at handover; cash rounding) — property-tested to balance and net to
  total − GST.
- API: `EventDispatcher` (per tenant inside `withTenant`; each attempt holds the outbox row lock,
  re-checks backoff, claims + handles inside a savepoint, forces deferred checks, records failures
  in the same transaction; exponential backoff; dead letter after 5 attempts; per-tenant error
  isolation), `LedgerConsumer`, `LedgerService`; accounting endpoints for business date,
  journal, trial balance and reconciliation.
- Books screen with reconciliation status, day-activity trial balance and journal; Playwright
  check that a real sale appears balanced and reconciled.
- ADR-0013 (resolves R-004).

### Independent review and testing (subagents)

- **Adversarial testing** (`accounting-adversarial.test.ts`, 11 scenarios incl. two app
  instances dispatching concurrently, replay storms, rounding, comps, cancel-after-payment,
  closed periods, tenant joins): **no ledger defects found**.
- **Code review** found and I fixed: lines could be appended to an already-posted entry (even
  in a closed period); multiple replicas could burn retry attempts and dead-letter early because
  the failure was recorded after the lock was released (both testers flagged this); the
  reconciliation backlog ignored the selected day and double-counted dead letters; one tenant's
  error could abort the pass for all; the definer function was executable by PUBLIC; no index for
  the dispatcher scan; inactive accounts with postings would drop out of the trial balance.
- Fixing the dispatcher surfaced a missing DELETE grant (clearing failure rows on success); the
  failure path recorded it correctly, which is how it was found.

### Tests executed

| Suite                                | Result                      |
| ------------------------------------ | --------------------------- |
| `@kitchos/domain`                    | 35/35 passed                |
| `@kitchos/api` integration           | 88/88 passed (×2, shuffled) |
| Playwright (4 journeys)              | 4/4 passed                  |
| ESLint / Prettier / tsc (5 packages) | clean                       |
| `next build`                         | succeeded                   |

### Not done

COGS/waste postings, refunds/reversals (deposits of cancelled paid orders remain — R-016), till
sessions, shift close, period-close UI, dead-letter requeue (R-017), external bus relay.
Migration 0006 was amended before ever being committed or deployed.

## Milestone 5 — POS discounts and manager overrides (2026-10-27)

### Implemented

- Migration `0005_discounts_and_overrides`: per-restaurant self-approval limits, per-line
  `discount_cents`, append-only `order_discounts` (one per order), `manager_overrides` with hashed
  single-use secrets bound to restaurant, order, requester, expiry and the exact discount;
  approver ≠ requester enforced by CHECK; RLS and column-level grants.
- Domain: `applyDiscount` (percent/amount, largest-remainder allocation across lines, GST on the
  discounted taxable portion), `discountBasisPoints` — property-tested.
- API: `POST /v1/restaurants/:id/orders/:orderId/discount` (`discount.apply`) with the
  self-approval policy; `POST /v1/restaurants/:id/overrides` for terminal re-authentication;
  fully discounted orders are accepted straight to the kitchen; `order.discounted` event;
  audit for grants, denials and discounts. `CredentialThrottle` now shared by sign-in and
  overrides.
- POS UI: discount panel (percent/amount, reason), inline manager approval showing the amount,
  discount line on the ticket, comp completion screen.
- Permissions: `discount.apply` (crew and above), `discount.approve` (supervisor and above).
- ADR-0012.

### Independent review and testing (subagents)

Both the reviewer and the adversarial tester independently found the same **high-severity
defect**: an override was not bound to an amount, so a manager approving "15%" could be turned
into a 100% comp by the crew member (proved by a failing test). Fixed by binding the override
to the exact discount, computing and returning the approved amount at grant time, and auditing
it; regression tests kept and mutation-checked (removing the binding fails 2 tests).

Also fixed from their findings: the override endpoint added an extra password-guessing budget
and its per-account key included the (spoofable) client IP; successful checks counted towards
lockout; failed overrides were not audited; the discount panel generated a new idempotency key
per request (lost responses surfaced as errors), re-placed the ticket from a stale closure,
had a render-lagged double-submit guard and kept the approver's email in memory.

Not changed (recorded as risks): supervisors can comp without a second person (R-013);
account-level throttling enables temporary approver lockout (R-014).

### Tests executed

| Suite                                | Result                      |
| ------------------------------------ | --------------------------- |
| `@kitchos/domain`                    | 28/28 passed                |
| `@kitchos/api` integration           | 69/69 passed (×2, shuffled) |
| Playwright (3 journeys)              | 3/3 passed                  |
| ESLint / Prettier / tsc (5 packages) | clean                       |
| `next build`                         | succeeded                   |

### Notes

- Migration 0005 was amended before it was ever committed or deployed (local DB reset); applied,
  released migrations remain immutable.

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
