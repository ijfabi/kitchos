# Testing strategy

| Layer             | Tooling                                    | Scope                                                                                |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Domain unit       | Vitest + fast-check                        | Money, rounding, allocation, quantities, pricing, recipe explosion, state machines   |
| API integration   | Vitest + Supertest + Testcontainers (PG18) | Full HTTP flows against real migrations, seed, RLS and the restricted runtime role   |
| Database          | Same harness                               | Append-only and immutability triggers, grants, reconciliation of projections         |
| E2E (planned)     | Playwright                                 | Customer order → kitchen → pickup through the real UI                                |
| Load (planned)    | k6                                         | Order placement and kitchen commands; reports must state hardware, data, concurrency |
| Reliability (pl.) | Fault injection                            | Process kill mid-transaction, DB failover, duplicate/out-of-order events, WAN loss   |

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
```
