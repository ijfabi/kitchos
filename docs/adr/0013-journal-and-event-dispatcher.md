# ADR-0013: Double-entry journal fed by an RLS-preserving event dispatcher

- Status: Accepted (2026-10-27). Resolves RISKS R-004 for in-process consumers.

## Context

Finance must be derived from operational facts without coupling the order flow to accounting,
and a background worker must process every tenant's events without weakening tenant
isolation. Payment collection must not be treated as revenue.

## Decision

### Event dispatch (no RLS bypass)

- A narrow `SECURITY DEFINER` function, `app.orgs_with_pending_events(consumer, types)`, returns
  only the **ids** of tenants with unprocessed events for a consumer. It is the worker's single
  cross-tenant read; no role has `BYPASSRLS`.
- For each tenant the dispatcher runs inside `withTenant` (RLS enforced). Each event is handled in
  its own transaction: lock the outbox row `FOR UPDATE SKIP LOCKED` (parallel workers skip it),
  claim it in `inbox_events (consumer, event_id)`, run the handler. Claim and effect commit or
  roll back together, so delivery is at-least-once and processing is exactly-once per consumer.
- Failures are recorded in `event_consumer_failures` with exponential backoff (5 s doubling, max
  1 h) and are dead-lettered after 5 attempts. A failing event never blocks later events.
- The dispatcher runs in-process on an interval (`EVENT_DISPATCH_INTERVAL_MS`, default 2 s; 0 in
  tests, which call `runOnce()`). A separate worker process and an external bus
  (EventBridge/SQS) remain options; `outbox_events.published_at` is reserved for the external
  relay.

### Journal

- `accounts` (per-tenant chart; posting rules use stable `system_key`s), `journal_entries`,
  `journal_lines`, `accounting_periods`. Entries and lines are append-only; corrections will be
  reversing entries. A deferred constraint trigger rejects any entry that does not balance or
  has fewer than two lines; a trigger rejects postings dated in a closed period.
- One entry per `(source_type, source_id, entry_type)`: a replayed event cannot double-post even if
  the inbox claim were lost.
- **Posting rules** (pure functions in `@kitchos/domain/postings`, property-tested):
  - `payment.captured` → Dr Card clearing or Cash on hand (amount + cash rounding),
    Cr Customer deposits (amount), ± Cash rounding.
  - `order.completed` (handover) → Dr Customer deposits (total) + Dr Discounts allowed (discount
    ex GST) = Cr Sales revenue (gross ex GST) + Cr GST payable (GST on the discounted total).
    Net revenue equals total − GST exactly; discounts stay visible as contra-revenue.
- Facts are re-read from the authoritative tables, never trusted from event payloads.
- A reconciliation view compares, per restaurant and business day, handed-over orders (net and
  GST) and captured payments with the posted journal, and reports the consumer backlog and dead
  letters.

## Consequences

- An order paid then cancelled leaves its deposit as a liability until a refund is posted
  (Phase 3 refunds).
- Inventory valuation (COGS, waste expense) is not yet posted; accounts exist for the next slice.
- The journal is operational; statutory reporting needs specialist review (compliance A-11).
