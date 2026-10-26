# ADR-0005: Tenant isolation with PostgreSQL row-level security

- Status: Accepted (2026-10-26)

## Decision

1. Every tenant-owned table carries `org_id` and an RLS policy
   `org_id = app.current_org()` (USING and WITH CHECK).
2. The API connects as **`kitchos_app`**, which owns no tables and lacks `BYPASSRLS`. Migrations
   run as `kitchos_owner`. Grants are least-privilege: append-only tables get `SELECT, INSERT`
   only; `stock_balances.on_hand` is not updatable by the app at all.
3. Every request runs inside `withTenant(db, { orgId }, fn)`, which executes
   `set_config('app.org_id', $1, true)` (transaction-local, so pooled connections cannot leak a
   tenant). If unset, policies match nothing.
4. The tenant is **never taken from the client**: staff tenant comes from a signed JWT and the
   user row; public flows derive it from the restaurant slug or an unguessable order token via
   narrow `SECURITY DEFINER` lookup functions.
5. Within a tenant, restaurant-level access is enforced in the API: role assignments are scoped
   to organisation / brand / region / restaurant and resolved against the target restaurant on
   every request. Cross-tenant or out-of-scope restaurants return **404** (not 403) so existence
   is not disclosed.
6. Composite foreign keys `(org_id, id)` prevent a row in one tenant referencing another tenant's
   parent even via the owner role.

## Consequences

- Defence in depth: an application bug that forgets a `WHERE org_id` cannot read another tenant.
- Background workers that process all tenants (outbox relay) need an explicit design — either
  per-tenant iteration or a dedicated worker role with audited `BYPASSRLS` (open question,
  RISKS R-004).
