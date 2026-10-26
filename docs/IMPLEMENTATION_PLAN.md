# KitchOS implementation plan

Each milestone ends with working, verified functionality (real persistence, tests, docs). Status
key: ✅ done · 🟡 in progress / partial · ⬜ not started.

## Phase 0 — Foundation 🟡

| Item                                                           | Status |
| -------------------------------------------------------------- | ------ |
| Monorepo (pnpm, Turborepo, strict TS, ESLint, Prettier)        | ✅     |
| Docker Compose: PostgreSQL 18 + Redis 8                        | ✅     |
| SQL migrations with checksums; RLS; least-privilege app role   | ✅     |
| Tenancy hierarchy schema (org → brand → region → restaurant …) | ✅     |
| Staff auth (argon2id, JWT), scoped RBAC/ABAC guard             | ✅     |
| Structured logging (pino), request ids, Prometheus `/metrics`  | ✅     |
| Health/readiness endpoints                                     | ✅     |
| Seed: 3 demo restaurants + isolation-test tenant               | ✅     |
| ADRs 0001–0010, architecture overview                          | ✅     |
| GitHub Actions CI (lint, typecheck, unit, integration)         | ✅     |
| OpenTelemetry tracing (OTLP exporter, opt-in)                  | ⬜     |
| Terraform reference stack (plan only, no apply)                | ⬜     |
| API container image + production build (tsup)                  | ⬜     |

## Phase 1 — Core order processing 🟡

| Item                                                                        | Status |
| --------------------------------------------------------------------------- | ------ |
| Versioned menus/recipes, modifiers, combos, availability                    | ✅     |
| Server-side pricing with GST, idempotent order placement                    | ✅     |
| Sandbox card payments, payment state machine                                | ✅     |
| Station routing, kitchen tasks, versioned idempotent task commands          | ✅     |
| Live updates (LISTEN/NOTIFY → SSE)                                          | ✅     |
| Handoff, cancellation (with manager rule after production)                  | ✅     |
| Customer web ordering UI (menu, customise, cart, checkout, tracking)        | 🟡     |
| Kitchen display + expo + pickup board UI                                    | 🟡     |
| POS (staff order entry, cash, parked orders, discounts, overrides, refunds) | ⬜     |
| Playwright E2E for the customer → kitchen → pickup journey                  | ⬜     |

## Phase 2 — Inventory 🟡

Done: append-only ledger, balance projection, reservations, configurable consumption point,
exactly-once consumption, shortage policies, reconciliation query.
Next: goods receiving, physical counts & adjustments (approval), waste registration UI + waste
classification without double deduction, unit conversions, valuation (moving average), lots &
expiry, inventory API for managers, low-stock alerts, theoretical vs actual usage report.

## Phase 3 — Finance and management ⬜

Double-entry journal (immutable, balanced, reversals), posting rules from outbox events via an
idempotent consumer, refunds and payment reversal, cash drawers and till sessions, shift and
business-day close with blind counts, reports + PDF/CSV export, manager dashboards on real data.

## Phase 4 — Restaurant operations ⬜

Kiosk (device auth, idle reset, i18n), drive-thru lanes and simulator, beverage/dessert/expo
flows, time & attendance (clock on/off, breaks, offline punches), rostering, payroll simulation.

## Phase 5 — Supply chain and safety ⬜

Suppliers, purchase orders and approvals, partial receipts, invoice matching, transfers,
replenishment recommendations, lots/traceability, recalls, temperature logs, checklists.

## Phase 6 — Distributed reliability ⬜

Store-edge runtime (local PostgreSQL/SQLite, single writer), outbox relay and sync engine,
cursors, conflict detection, replay protection, dead letters, fault-injection tests.

## Phase 7 — Enterprise expansion ⬜

Head-office rollouts, multi-store reporting, signage, campaigns, loyalty ledger, maintenance.

## Phase 8 — Intelligent operations ⬜

Digital twin on real APIs (seeded scenarios), forecasting with explicit baselines and evaluation.

## Phase 9 — Hardening ⬜

Security review (OWASP ASVS L2 checklist), k6 load tests with documented hardware/workload,
reliability drills, deployment docs, measured benchmark report.

## Immediate next tasks

1. Finish customer web + KDS/expo/pickup UI against the live API; Playwright journey test.
2. POS order entry with cash tender and staff-authenticated order creation.
3. Waste registration (raw vs prepared) honouring the no-double-deduction invariant.
4. Goods receipt + physical count endpoints with manager approval thresholds.
5. Outbox relay worker + first idempotent consumer (journal postings).
