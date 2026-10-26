# ADR-0002: Monorepo and toolchain choices

- Status: Accepted (2026-10-26)

## Decision

- **pnpm workspaces + Turborepo.** Internal packages (`@kitchos/domain`, `contracts`, `database`)
  export TypeScript source directly (`"exports": "./src/index.ts"`) and are consumed by tsx,
  Vitest and bundlers. No per-package build step during development.
- **ESM everywhere** (`"type": "module"`, `NodeNext`, explicit `.ts` import extensions). NestJS 12
  ships as ESM.
- **TypeScript 5.9.3, pinned**, although 7.0 (native compiler) is the current `latest`:
  typescript-eslint 8.72 supports `<6.1.0` only. Revisit when the lint toolchain supports TS 7.
- **No `emitDecoratorMetadata`.** Nest providers are injected with explicit `@Inject(Token)`.
  This lets tsx/esbuild (dev) and Vitest run the API without SWC/tsc emit, and removes a class of
  runtime-only DI failures. Validation uses Zod pipes, not class-validator.
- **Vitest** for unit and integration tests; **Testcontainers** (PostgreSQL 18) for integration.
- **Single Next.js web app** with per-surface routes (`/order`, `/kitchen`, `/expo`, `/pickup`, …)
  rather than ten separate apps, until deployment or performance needs justify splitting.

## Versions validated on 2026-10-26

Node 24.22, pnpm 10.34, NestJS 12.2, Kysely 0.29, pg 8.23, Zod 4.6, Vitest 5.0, PostgreSQL 18,
Next.js 16.4, React 19.3, Tailwind 4.3, TanStack Query 5.105.
