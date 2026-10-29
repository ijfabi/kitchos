# Decision log

Architecture decisions are recorded as ADRs in `docs/adr/`. Smaller decisions are logged here.

| #        | Decision                                                                                                                    | Date       |
| -------- | --------------------------------------------------------------------------------------------------------------------------- | ---------- |
| ADR-0001 | Modular monolith first; two-plane (cloud + restaurant) architecture                                                         | 2026-10-26 |
| ADR-0002 | pnpm + Turborepo monorepo, ESM, TS 5.9 pinned, explicit DI tokens, single Next.js app                                       | 2026-10-26 |
| ADR-0003 | Kysely + SQL migrations instead of Prisma                                                                                   | 2026-10-26 |
| ADR-0004 | Integer cents; milli-unit quantities; bigint division with explicit rounding                                                | 2026-10-26 |
| ADR-0005 | PostgreSQL RLS + restricted runtime role for tenant isolation                                                               | 2026-10-26 |
| ADR-0006 | Append-only inventory ledger, exactly-once consumption, configurable consumption point                                      | 2026-10-26 |
| ADR-0007 | Immutable published menu/recipe versions pinned by orders                                                                   | 2026-10-26 |
| ADR-0008 | Transactional outbox with store sequences; NOTIFY → SSE live fan-out                                                        | 2026-10-26 |
| ADR-0009 | Interim staff auth: argon2id + JWT, roles reloaded per request                                                              | 2026-10-26 |
| ADR-0010 | Payments separate from orders; token-only sandbox provider                                                                  | 2026-10-26 |
| D-001    | Cross-tenant / out-of-scope restaurant access returns 404, not 403                                                          | 2026-10-26 |
| D-002    | Kitchen "bump from queue" passes through `in_progress` so `task_started` consumption is never skipped                       | 2026-10-26 |
| D-003    | Second handoff of a completed order is a 409 conflict (not a silent success) to surface double-handoffs                     | 2026-10-26 |
| D-004    | Live-event outage does not fail readiness; screens fall back to polling                                                     | 2026-10-26 |
| ADR-0011 | Waste separates physical movement from financial classification; remakes consume under a distinct source key                | 2026-10-26 |
| D-006    | Waste physically deducts at recording time even when pending approval; rejection appends corrections                        | 2026-10-26 |
| D-007    | Integration test files run in shuffled order to expose cross-file state dependencies                                        | 2026-10-26 |
| D-008    | Cash rounding is stored on the payment (cash_rounding_cents); order total and GST are never changed by tender type          | 2026-10-27 |
| D-009    | POS order responses include the guest tracking token so receipts can carry a tracking link                                  | 2026-10-27 |
| D-010    | Public guest payments are card-token only; cash is accepted only on authenticated staff routes                              | 2026-10-27 |
| D-011    | Idempotency scopes include the surface and restaurant whenever a replay precedes an authorisation re-check                  | 2026-10-27 |
| D-012    | POS keeps the payment idempotency key across network/5xx failures; only definitive 4xx responses rotate it                  | 2026-10-27 |
| ADR-0012 | Discounts with self-approval limits; manager overrides bound to the exact discount                                          | 2026-10-27 |
| D-013    | Password-guessing budget is per account (IP-independent), counts failures only, shared by sign-in and overrides             | 2026-10-27 |
| D-014    | A fully discounted order is accepted immediately (no payment row); stock is consumed as usual                               | 2026-10-27 |
| ADR-0013 | Journal fed by an RLS-preserving in-process event dispatcher; revenue at handover, deposits before                          | 2026-10-27 |
| D-015    | Each delivery attempt holds the event lock end to end; failures are recorded in the same transaction                        | 2026-10-27 |
| D-016    | Journal lines may only be inserted by the transaction that created their entry                                              | 2026-10-27 |
| ADR-0014 | Refunds: append-only, treatment fixed at creation, cumulative GST share, no stock effect                                    | 2026-10-27 |
| D-017    | Refunds record refunded-before under the payment lock; cash back is cumulative and capped at cash taken                     | 2026-10-27 |
| D-018    | No client-side DB query timeout (node-postgres would pool the dead socket); TCP keepalive + connection timeout instead      | 2026-10-27 |
| ADR-0015 | Cash drawers: cash tied to the actor's own session, expected cash derived from records, blind count, second-person approval | 2026-10-30 |
| D-019    | "Cash needs an open session" is an INSERT trigger, not a NOT VALID CHECK (re-checked on UPDATE, would block legacy refunds) | 2026-10-30 |
| D-020    | Available-cash 422 only for actors who can see expected cash; a blind cashier's over-removal surfaces as count variance     | 2026-10-30 |
| D-005    | Demo seed uses one shared dev password for all synthetic accounts (local only)                                              | 2026-10-26 |
