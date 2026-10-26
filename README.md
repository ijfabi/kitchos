# KitchOS

**Order. Operate. Optimise.** — The Intelligent Restaurant Operating System.

KitchOS is a multi-tenant, event-driven restaurant platform under active development. It is
being built as working vertical slices on real PostgreSQL persistence, with database-enforced
invariants and automated tests that verify persisted state.

> **Status:** Foundation + first vertical slice (customer order → payment → kitchen stations →
> exactly-once ingredient consumption → pickup). Many areas in the brief are not started yet;
> see [`docs/FEATURE_MATRIX.md`](docs/FEATURE_MATRIX.md) for an honest status of each capability.

## What works today

- Three seeded demo restaurants (Central, Drive, Express) with different menus, recipes,
  stations, stock and staff, plus a second tenant used to prove isolation.
- Guest ordering with server-side pricing (GST-inclusive), modifiers and combo meals.
- Idempotent order placement with stock reservation that cannot oversell under concurrency.
- Sandbox card payments (token-only; card numbers are rejected by the API contract).
- Station routing of every line (including meal components) to kitchen tasks; versioned,
  idempotent start/complete commands; live updates over SSE.
- Ingredient consumption recorded **exactly once** in an append-only ledger at a per-recipe
  configurable point (on acceptance, on task start, or on completion).
- Tenant isolation enforced by PostgreSQL row-level security for a restricted runtime role.

## Quick start

Prerequisites: Node 22.12+ (24 recommended), pnpm 10, Docker.

```bash
pnpm install
cp .env.example .env
pnpm db:up          # PostgreSQL 18 (:55432) + Redis 8 (:56379)
pnpm db:migrate
pnpm db:seed
pnpm --filter @kitchos/api dev     # http://localhost:4000
pnpm --filter @kitchos/web dev     # http://localhost:3100
```

Demo staff accounts (synthetic, local only) use the password `kitchos-demo-pass`, for example
`manager@central.kitchos.test`, `crew1@central.kitchos.test`, `admin@kitchos.test`.

## Tests

```bash
pnpm --filter @kitchos/domain test   # unit + property-based tests
pnpm --filter @kitchos/api test      # integration tests against a throwaway PostgreSQL 18 container
pnpm test:e2e                        # Playwright journey through the real UI (uses the local seeded DB)
```

## Repository layout

```
apps/api            NestJS modular monolith (auth, catalog, ordering, kitchen, inventory, events)
apps/web            Next.js surfaces (customer ordering, kitchen display, expo, pickup)
packages/domain     Pure business rules: money, pricing, recipes, state machines
packages/contracts  Zod wire contracts shared by API and web
packages/database   SQL migrations, Kysely client + generated types, demo seed
infrastructure      Docker Compose (Terraform planned)
docs                Architecture, ADRs, plan, progress, risks, compliance, security, testing
```

## Documentation

- [Architecture overview](docs/architecture/overview.md) · [ADRs](docs/adr/) ·
  [Implementation plan](docs/IMPLEMENTATION_PLAN.md) · [Progress](docs/PROGRESS.md) ·
  [Risks](docs/RISKS.md) · [Compliance assumptions](docs/compliance/assumptions.md) ·
  [Threat model](docs/security/threat-model.md) · [Testing strategy](docs/testing/strategy.md)

## Disclaimer

KitchOS uses synthetic data and a sandbox payment provider. It is not certified for PCI DSS,
tax, payroll, workplace or food-safety compliance; see the compliance assumptions document.
Performance figures will only be published with reproducible benchmark reports.
