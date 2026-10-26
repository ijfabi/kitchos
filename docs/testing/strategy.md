# Testing strategy

| Layer             | Tooling                                    | Scope                                                                                |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Domain unit       | Vitest + fast-check                        | Money, rounding, allocation, quantities, pricing, recipe explosion, state machines   |
| API integration   | Vitest + Supertest + Testcontainers (PG18) | Full HTTP flows against real migrations, seed, RLS and the restricted runtime role   |
| Database          | Same harness                               | Append-only and immutability triggers, grants, reconciliation of projections         |
| E2E               | Playwright (Chromium)                      | Customer order → kitchen → pickup through the real UI (local; CI job pending)        |
| Load (planned)    | k6                                         | Order placement and kitchen commands; reports must state hardware, data, concurrency |
| Reliability (pl.) | Fault injection                            | Process kill mid-transaction, DB failover, duplicate/out-of-order events, WAN loss   |

## Independent review

Each milestone is reviewed by independent subagents: a code reviewer (report only) and an
adversarial tester that writes a separate test file and must not weaken assertions to make them
pass. Genuine defects they find are fixed and their tests kept as regressions.

## Principles

- Assert on **persisted state** (ledger rows, balances, outbox, audit), not only HTTP responses.
- Every concurrency test is **mutation-checked**: we remove the protecting mechanism and confirm
  the test fails. Example: removing `FOR UPDATE` in `InventoryService.reserve` makes the
  "reservation row locks alone prevent overselling" test fail (6 of 6 reservations succeed
  against 2 units).
- Ledger reconciliation (`on_hand = Σ movements`, `reserved = Σ active reservations`) is asserted
  after every inventory scenario.
- Tests share one seeded database per run and assert on deltas, so files run serially.

## Running

```bash
pnpm db:up                      # local Postgres/Redis (only needed for running the app)
pnpm --filter @kitchos/domain test
pnpm --filter @kitchos/api test # starts its own PostgreSQL 18 container via Testcontainers
pnpm test:e2e                   # needs pnpm db:up/migrate/seed; starts API (:4000) and web (:3100)
```
