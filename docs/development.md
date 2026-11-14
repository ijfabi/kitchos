# Development environment

## Prerequisites

- Node.js 22.12 or later (CI uses 24)
- pnpm 10 (the exact version is pinned in `package.json` as `packageManager`)
- Docker, for the local databases and for the integration tests (Testcontainers)

## First run

```bash
pnpm install
cp .env.example .env
pnpm db:up          # PostgreSQL 18 on :55432, Redis 8 on :56379
pnpm db:migrate     # applies packages/database/migrations in order, with checksums
pnpm db:seed        # demo tenant, three restaurants, menus, stock, staff; plus a rival tenant
pnpm --filter @kitchos/api dev     # http://localhost:4000 (tsx watch)
pnpm --filter @kitchos/web dev     # http://localhost:3100
```

`pnpm db:up` also runs `infrastructure/docker/postgres/init/01-roles.sql`, which creates the
restricted `kitchos_app` role the API connects as. Migrations and the seed use the owner role from
`DATABASE_OWNER_URL`.

`pnpm db:reset` drops, migrates and seeds again. It is for local use only and destroys local data.

## Configuration

| Variable                     | Used by          | Notes                                                                                   |
| ---------------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| `DATABASE_OWNER_URL`         | Migrations, seed | Table owner                                                                             |
| `DATABASE_URL`               | API              | Runtime role, RLS enforced                                                              |
| `AUTH_JWT_SECRET`            | API              | At least 32 characters; the API refuses to start otherwise                              |
| `API_PORT`                   | API              | Default 4000                                                                            |
| `CORS_ORIGINS`               | API              | Comma separated; default `http://localhost:3100`                                        |
| `LOG_LEVEL`, `NODE_ENV`      | API              | Optional                                                                                |
| `EVENT_DISPATCH_INTERVAL_MS` | API              | Ledger dispatcher interval, default 2000; 0 disables the loop (tests drive it directly) |
| `NEXT_PUBLIC_API_URL`        | Web              | Where the browser calls the API                                                         |
| `REDIS_URL`                  | Nothing yet      | Present in `.env.example`; no code reads it                                             |

The API validates its configuration with Zod at start-up (`apps/api/src/config.ts`).

## Demo accounts

All seeded accounts use the password `kitchos-demo-pass`. They are synthetic and local only.

| Account                           | Role                                           |
| --------------------------------- | ---------------------------------------------- |
| `admin@kitchos.test`              | Head office administrator (whole organisation) |
| `manager@central.kitchos.test`    | Restaurant manager, Central                    |
| `supervisor@central.kitchos.test` | Shift supervisor, Central                      |
| `crew1@central.kitchos.test`      | Crew, Central                                  |
| `manager@express.kitchos.test`    | Restaurant manager, Express                    |
| `manager@drive.kitchos.test`      | Restaurant manager and franchise owner, Drive  |
| `area.cbd@kitchos.test`           | Area manager, Sydney CBD region                |
| `inventory@kitchos.test`          | Inventory controller                           |
| `auditor@kitchos.test`            | Auditor (read only)                            |
| `manager@rival.test`              | Manager in the second tenant                   |

## Everyday commands

```bash
pnpm lint && pnpm format:check && pnpm typecheck
pnpm --filter @kitchos/domain test
pnpm --filter @kitchos/api test               # starts its own PostgreSQL 18 container
pnpm test:e2e                                 # needs the local database migrated and seeded
pnpm --filter @kitchos/database codegen       # after adding a migration
```

## Working rules

The non-negotiable rules are in [CLAUDE.md](../CLAUDE.md). The ones that most often matter:

- New schema goes in a new migration. Never edit an applied one; the runner refuses changed files.
- After a migration, regenerate the Kysely types and commit them. CI checks they match.
- Grant the runtime role only what it needs, in the migration.
- Money is integer cents and quantities are decimal strings; never use floats for either.
- Tenant work runs inside `withTenant`. Client-supplied tenant ids and prices are never trusted.
- Lock in the documented order, and append outbox events last.
- A feature is not done until it is persisted, enforced by the server, tested against persisted
  state, and recorded in `FEATURE_MATRIX.md` and `PROGRESS.md`.

## Platform notes

The project is developed on Windows with Git Bash and in Linux CI. Files are UTF-8 without a byte
order mark and use LF line endings (`.gitattributes`, `.editorconfig`).
