# ADR-0001: Modular monolith first, two-plane architecture

- Status: Accepted (2026-10-26)

## Context

KitchOS spans ordering, kitchen, inventory, finance, workforce and more. Microservices from day
one would multiply deployment, consistency and observability cost before the domain boundaries
are proven. Restaurants must also keep trading through WAN outages.

## Decision

- Build the cloud backend as a **NestJS modular monolith** with one folder per bounded context
  and explicit service interfaces between them. Cross-context side effects that must be atomic
  (e.g. accepting an order creates kitchen tasks and consumes stock) happen in one PostgreSQL
  transaction; looser integrations go through the transactional outbox (ADR-0008).
- Architect for **two planes**: a cloud control plane (configuration, analytics, consolidated
  finance) and a restaurant execution plane (orders, kitchen, local inventory). A store-edge
  runtime (Phase 6) becomes the single operational writer per restaurant and syncs via
  outbox/inbox with store-scoped sequences.
- Extract a service only when isolation, independent scaling or reliability requires it, with an
  ADR.

## Consequences

- Simple local development and strong transactional guarantees now.
- Module boundaries must be policed in review (no reaching into another context's tables
  without going through its service), until/unless lint rules enforce it.
- Go for the store edge is deferred until Phase 6 justifies it (Go is not yet installed in the
  development environment).
