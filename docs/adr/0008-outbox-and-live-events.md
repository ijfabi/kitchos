# ADR-0008: Transactional outbox, store sequencing and live fan-out

- Status: Accepted (2026-10-26); relay implementation pending

## Decision

- Every state-changing command appends domain events to `outbox_events` **in the same
  transaction**. Each event gets a gap-free `store_sequence` from `restaurant_event_sequences`
  (row lock until commit). Events are appended last in a command (lock-ordering convention).
- An `AFTER INSERT` trigger issues `pg_notify('kitchos_events', …)` with identifiers only.
  PostgreSQL delivers notifications only on commit. Each API replica holds one `LISTEN`
  connection and streams matching events to authorised SSE clients, which refetch state.
  Missed notifications cost latency, never correctness.
- `inbox_events (consumer, event_id)` exists for idempotent consumers.

## Not yet implemented

- The **outbox relay** (publishing to EventBridge/SQS or Redpanda, setting `published_at`) and the
  first asynchronous consumers (accounting postings, analytics projections). The per-store
  sequence serialises event production per restaurant — acceptable for one store's throughput,
  to be measured under load (Phase 9).
