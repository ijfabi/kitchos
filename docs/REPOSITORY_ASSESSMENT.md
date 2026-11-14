# Repository assessment

Assessed on 14 November 2026 from the code, migrations, tests, CI configuration and Git history on
`main` (latest commit `d9d83ff`, Milestone 18) plus the uncommitted Milestone 19 work in the
working tree. Every status below was checked against source files, not inferred from folder or
interface names.

## 1. Architecture inventory

### Applications and packages

| Path                 | What it is                                                                             | Evidence                                                  |
| -------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/api`           | NestJS 12 modular monolith, ESM, explicit `@Inject` tokens, Kysely on `pg`             | `apps/api/src/app.module.ts`, `apps/api/package.json`     |
| `apps/web`           | Next.js 16 app (React 19, TanStack Query 5, Tailwind 4); every surface calls the API   | `apps/web/src/app/*`, `apps/web/src/lib/api.ts`           |
| `packages/domain`    | Pure rules: money, quantities, pricing, recipes, state machines, journal posting rules | `packages/domain/src/*.ts`, 63 unit and property tests    |
| `packages/contracts` | Zod request and response schemas shared by API and web                                 | `packages/contracts/src/index.ts`                         |
| `packages/database`  | Numbered SQL migrations with checksums, Kysely client, generated types, demo seed      | `packages/database/migrations/0001` to `0014`, `src/seed` |
| `infrastructure`     | Docker Compose for local PostgreSQL 18 and Redis 8 only                                | `infrastructure/docker/compose.yaml`                      |
| `tests/e2e`          | Playwright journeys through the real UI, API and database                              | 10 spec files                                             |
| `.github/workflows`  | One CI workflow: quality, integration, schema drift, audit, end-to-end                 | `.github/workflows/ci.yml`                                |

### API modules (bounded contexts)

| Module (`apps/api/src`) | Responsibility                                                                   | Routes under `/v1`                                                          |
| ----------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `auth`                  | Password login (argon2id), HS256 JWT (8 hours), role and scope resolution        | `auth/login`, `me`                                                          |
| `catalog`               | Published menus, recipes, modifiers, availability                                | `public/restaurants`, `public/restaurants/:slug/menu`                       |
| `ordering`              | Pricing, orders, payments (sandbox), discounts, overrides, cancellation, refunds | `public/...orders`, `restaurants/:id/orders/*`, `restaurants/:id/overrides` |
| `kitchen`               | Station routing, kitchen tasks and their commands                                | `restaurants/:id/kitchen/*`                                                 |
| `inventory`             | Stock ledger, balances, reservations, waste, receipts, counts, transfers         | `restaurants/:id/inventory/*`                                               |
| `cash`                  | Cash drawers, till sessions, blind counts, shifts                                | `restaurants/:id/cash/*`, `restaurants/:id/shifts/*`                        |
| `accounting`            | Journal, posting consumer, reconciliation, day close, food cost and item reports | `restaurants/:id/accounting/*`, `.../days/:date/*`, `.../reports/*`         |
| `events`                | Transactional outbox, in-process dispatcher, LISTEN/NOTIFY to server-sent events | `restaurants/:id/live` (SSE)                                                |
| `health`                | Liveness, readiness, Prometheus metrics                                          | `/health/live`, `/health/ready`, `/metrics`                                 |

### Web surfaces (`apps/web/src/app`)

`/order/[slug]` and `/order/track` (customer), `/pickup/[slug]`, `/staff` (workspace picker),
`/pos`, `/kitchen`, `/expo`, `/orders`, `/inventory`, `/cash`, `/shift`, `/close`, `/accounting`
(Books screen) and `/reports`, each per restaurant.

### Database

59 tables over 13 migrations, all tenant tables under row-level security. See
[architecture/database.md](architecture/database.md).

## 2. Feature implementation summary

The authoritative, evidence-backed list is [FEATURE_MATRIX.md](FEATURE_MATRIX.md). In short:

| Area named in the review brief         | Status                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and authorisation       | Implemented: password + JWT, scoped RBAC, RLS. MFA, OIDC, device identity and staff PINs are not started.                                                                       |
| Inventory and wastage                  | Implemented: ledger, reservations, waste, receipts, counts, valuation. Transfers are implemented (Milestone 19). Lots, expiry, unit conversions and purchasing are not started. |
| Staff attendance and rostering         | Not started. No tables, routes or UI exist. `payroll_administrator` is only an allowed role value (migration 0001), with no permissions in `permissions.ts`.                    |
| Kitchen and POS workflows              | Implemented for the core flows. Coupons, line discounts, receipt printing, kitchen batching and recall are not started.                                                         |
| Financial accounting and shift closing | Implemented: journal, postings, reconciliation, drawers, shifts, day close, food cost reports.                                                                                  |
| Offline processing and synchronisation | Not started. The schema has a per-store event sequence and an inbox table for a future store edge; nothing syncs.                                                               |
| Infrastructure and deployment          | Local Docker Compose and CI only. No container image, Terraform or hosted environment exists.                                                                                   |
| Performance                            | No benchmark has been run. No figures are published.                                                                                                                            |

## 3. Discrepancies found in existing documentation

| Document                               | Says                                                                                     | Code shows                                                                                                                                       | Correction                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `README.md`                            | Status is "Foundation + first vertical slice"; web is customer, kitchen, expo and pickup | 18 committed milestones including POS, cash, journal, day close and reports                                                                      | README rewritten                                                                                               |
| `docs/architecture/overview.md`        | Seven bounded contexts                                                                   | Also `cash` and `accounting`, with shifts, journal and reports                                                                                   | Context table updated                                                                                          |
| `docs/testing/strategy.md`             | Playwright "CI job pending"                                                              | `ci.yml` has an `e2e` job running every journey                                                                                                  | Updated                                                                                                        |
| `docs/reliability/slo.md`              | Duplicate financial postings measured in "Phase 3"                                       | Journal uniqueness per source and entry type plus the consumer inbox, tested                                                                     | Updated                                                                                                        |
| `docs/FEATURE_MATRIX.md`               | Audit log "Partial (cancellations)"                                                      | `audit()` is written for 18 actions (cancellations, discounts, refunds, drawers, shifts, receipts, counts, waste, transfers, day close, retries) | Proposed wording: "Written for 18 actions; no viewer, not every write audited". Left unchanged for your review |
| `.env.example`, Compose                | Provide `REDIS_URL` and a Redis container                                                | No code reads `REDIS_URL`; the rate limiter is in-process (R-007)                                                                                | Documented as provisioned but unused                                                                           |
| `docs/security/threat-model.md`        | Titled "initial, Phase 0/1 scope"                                                        | Cash, refunds, day close and transfers have controls not listed                                                                                  | Flagged for a later revision; not rewritten here                                                               |
| Several existing docs and ADR headings | Use em dashes in prose                                                                   | Conflicts with the documentation style now required                                                                                              | Flagged; existing user-authored text left as is                                                                |

## 4. Documentation gap analysis

| Topic requested                      | Before this review                       | Now                                                        |
| ------------------------------------ | ---------------------------------------- | ---------------------------------------------------------- |
| Overview and motivation              | Stale README                             | `README.md`                                                |
| Implemented, in development, planned | Feature matrix and plan, README stale    | `README.md`, `FEATURE_MATRIX.md`, `IMPLEMENTATION_PLAN.md` |
| Technology stack                     | Spread across ADR-0002 and package files | `README.md`                                                |
| System architecture                  | Overview, partly outdated                | `architecture/overview.md` (updated)                       |
| Database architecture                | Only in migrations and ADRs              | `architecture/database.md` (new)                           |
| Event-driven workflows               | ADR-0008, ADR-0013                       | `architecture/events.md` (new)                             |
| Inventory and financial correctness  | Spread over ADR-0006, 0011, 0013 to 0019 | `architecture/correctness.md` (new)                        |
| Offline-first design                 | One risk line (R-006)                    | `architecture/offline.md` (new)                            |
| Authentication and security          | ADR-0005, ADR-0009, threat model         | `security/authentication.md` (new)                         |
| Development setup                    | README quick start                       | `development.md` (new)                                     |
| Testing and QA                       | Strategy, partly outdated                | `testing/strategy.md` (updated)                            |
| Performance benchmarks               | Empty folder                             | `performance/README.md` (new, states none measured)        |
| Deployment architecture              | One paragraph of plans                   | `operations/deployment.md` (new)                           |
| Decisions and trade-offs             | 19 ADRs and an index                     | Unchanged; linked from README                              |
| Known issues and future work         | `RISKS.md`, plan                         | Linked from README                                         |

Every engineering decision that shapes the implemented code already has an ADR (0001 to 0019).
No new ADR was needed for this documentation pass.

## 5. Diagrams

All diagrams are Mermaid and were drawn from code and configuration:

| Diagram                                        | Source of truth                                        | Location                      |
| ---------------------------------------------- | ------------------------------------------------------ | ----------------------------- |
| Current system context                         | `compose.yaml`, `config.ts`, `apps/web/src/lib/api.ts` | `architecture/overview.md`    |
| Module dependencies                            | `app.module.ts`, imports                               | `architecture/overview.md`    |
| Order, payment and kitchen task state machines | `packages/domain/src/state-machine.ts`                 | `architecture/overview.md`    |
| Core entity relationships                      | Foreign keys in migrations `0001` to `0014`            | `architecture/database.md`    |
| Outbox, dispatcher and live events             | `events/*.ts`, `ledger.consumer.ts`                    | `architecture/events.md`      |
| Stock transfer sequence                        | `stock-transfer.service.ts`, poster                    | `architecture/correctness.md` |
| CI pipeline                                    | `.github/workflows/ci.yml`                             | `testing/strategy.md`         |

## 6. Work in progress at the time of assessment

Milestone 19 (stock transfers between restaurants, ADR-0019, migrations 0013 and 0014) is in the
working tree, not committed. Its tests pass: 8 in `stock-transfers.test.ts`, 17 in the adversarial
file and 7 in `stock-transfers-interactions.test.ts`. The full API suite (507 tests) and the
transfer Playwright journey pass with it. It was committed
after this assessment as Milestone 19.
