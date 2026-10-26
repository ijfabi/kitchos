# Decision log

Architecture decisions are recorded as ADRs in `docs/adr/`. Smaller decisions are logged here.

| #        | Decision                                                                                                | Date       |
| -------- | ------------------------------------------------------------------------------------------------------- | ---------- |
| ADR-0001 | Modular monolith first; two-plane (cloud + restaurant) architecture                                     | 2026-10-26 |
| ADR-0002 | pnpm + Turborepo monorepo, ESM, TS 5.9 pinned, explicit DI tokens, single Next.js app                   | 2026-10-26 |
| ADR-0003 | Kysely + SQL migrations instead of Prisma                                                               | 2026-10-26 |
| ADR-0004 | Integer cents; milli-unit quantities; bigint division with explicit rounding                            | 2026-10-26 |
| ADR-0005 | PostgreSQL RLS + restricted runtime role for tenant isolation                                           | 2026-10-26 |
| ADR-0006 | Append-only inventory ledger, exactly-once consumption, configurable consumption point                  | 2026-10-26 |
| ADR-0007 | Immutable published menu/recipe versions pinned by orders                                               | 2026-10-26 |
| ADR-0008 | Transactional outbox with store sequences; NOTIFY → SSE live fan-out                                    | 2026-10-26 |
| ADR-0009 | Interim staff auth: argon2id + JWT, roles reloaded per request                                          | 2026-10-26 |
| ADR-0010 | Payments separate from orders; token-only sandbox provider                                              | 2026-10-26 |
| D-001    | Cross-tenant / out-of-scope restaurant access returns 404, not 403                                      | 2026-10-26 |
| D-002    | Kitchen "bump from queue" passes through `in_progress` so `task_started` consumption is never skipped   | 2026-10-26 |
| D-003    | Second handoff of a completed order is a 409 conflict (not a silent success) to surface double-handoffs | 2026-10-26 |
| D-004    | Live-event outage does not fail readiness; screens fall back to polling                                 | 2026-10-26 |
| D-005    | Demo seed uses one shared dev password for all synthetic accounts (local only)                          | 2026-10-26 |
