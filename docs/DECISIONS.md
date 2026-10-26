# Decision log

Architecture decisions are recorded as ADRs in `docs/adr/`. Smaller decisions are logged here.

| #        | Decision                                                                                                           | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------ | ---------- |
| ADR-0001 | Modular monolith first; two-plane (cloud + restaurant) architecture                                                | 2026-10-26 |
| ADR-0002 | pnpm + Turborepo monorepo, ESM, TS 5.9 pinned, explicit DI tokens, single Next.js app                              | 2026-10-26 |
| ADR-0003 | Kysely + SQL migrations instead of Prisma                                                                          | 2026-10-26 |
| ADR-0004 | Integer cents; milli-unit quantities; bigint division with explicit rounding                                       | 2026-10-26 |
| ADR-0005 | PostgreSQL RLS + restricted runtime role for tenant isolation                                                      | 2026-10-26 |
| ADR-0006 | Append-only inventory ledger, exactly-once consumption, configurable consumption point                             | 2026-10-26 |
| ADR-0007 | Immutable published menu/recipe versions pinned by orders                                                          | 2026-10-26 |
| ADR-0008 | Transactional outbox with store sequences; NOTIFY → SSE live fan-out                                               | 2026-10-26 |
| ADR-0009 | Interim staff auth: argon2id + JWT, roles reloaded per request                                                     | 2026-10-26 |
| ADR-0010 | Payments separate from orders; token-only sandbox provider                                                         | 2026-10-26 |
| D-001    | Cross-tenant / out-of-scope restaurant access returns 404, not 403                                                 | 2026-10-26 |
| D-002    | Kitchen "bump from queue" passes through `in_progress` so `task_started` consumption is never skipped              | 2026-10-26 |
| D-003    | Second handoff of a completed order is a 409 conflict (not a silent success) to surface double-handoffs            | 2026-10-26 |
| D-004    | Live-event outage does not fail readiness; screens fall back to polling                                            | 2026-10-26 |
| ADR-0011 | Waste separates physical movement from financial classification; remakes consume under a distinct source key       | 2026-10-26 |
| D-006    | Waste physically deducts at recording time even when pending approval; rejection appends corrections               | 2026-10-26 |
| D-007    | Integration test files run in shuffled order to expose cross-file state dependencies                               | 2026-10-26 |
| D-008    | Cash rounding is stored on the payment (cash_rounding_cents); order total and GST are never changed by tender type | 2026-10-27 |
| D-009    | POS order responses include the guest tracking token so receipts can carry a tracking link                         | 2026-10-27 |
| D-010    | Public guest payments are card-token only; cash is accepted only on authenticated staff routes                     | 2026-10-27 |
| D-011    | Idempotency scopes include the surface and restaurant whenever a replay precedes an authorisation re-check         | 2026-10-27 |
| D-012    | POS keeps the payment idempotency key across network/5xx failures; only definitive 4xx responses rotate it         | 2026-10-27 |
| D-005    | Demo seed uses one shared dev password for all synthetic accounts (local only)                                     | 2026-10-26 |
