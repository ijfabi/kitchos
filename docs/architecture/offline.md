# Offline operation: design intent and current limits

**KitchOS cannot operate offline today.** Every screen needs the cloud API, and the API needs
PostgreSQL. If a restaurant loses its connection, it cannot take orders, run the kitchen display or
record cash through KitchOS until the connection returns (R-006).

This document records what the intended design is, which parts of the current code were built with
it in mind, and what is missing.

## Intended design (ADR-0001, Phase 6)

ADR-0001 plans two planes: a cloud control plane for configuration, reporting and consolidated
finance, and a restaurant execution plane for orders, the kitchen and local stock. A store-edge
runtime would be the single operational writer for its restaurant, keep trading through a WAN
outage, and synchronise with the cloud through the outbox and inbox using store-scoped sequences.
The language and local storage for that runtime are not decided: ADR-0001 mentions Go, and the
implementation plan lists local PostgreSQL or SQLite with a single writer. None of it has been built.

## What already exists that the design relies on

| Building block                          | Where                                                        | Why it matters for sync                                                |
| --------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Per-restaurant, gap-free event sequence | `outbox_events.store_sequence`, `restaurant_event_sequences` | A receiver can detect gaps and replay from a cursor                    |
| Consumer inbox                          | `inbox_events (consumer, event_id)`                          | Delivering the same event twice has no effect                          |
| Idempotency keys on every command       | `idempotency_keys`, `Idempotency-Key` header                 | A command retried after a lost response is replayed, not repeated      |
| Unique source on every stock movement   | `stock_movements_source_unique`                              | Replayed consumption or waste cannot deduct stock twice                |
| Client-side attempt keys                | `apps/web/src/lib/attempt-key.ts`                            | The web keeps the same key after a network failure, so a retry replays |
| UUIDv7 keys created by the server       | All tables                                                   | Ids sort by time; client-generated ids would be the next step          |

These were built for correctness under retries and concurrency, and they are tested for that.
They have not been tested as a synchronisation mechanism, because no second writer exists.

## What the web app does when the connection drops

- Live screens show a connection status (`connecting`, `live`, `reconnecting`, `offline`) and keep
  polling on a timer, so they recover by themselves when the API is reachable again.
- A command that fails with a network error or a 5xx shows a warning that it may already have been
  recorded, and keeps its idempotency key so that retrying the same request cannot record it twice.
- Nothing is queued locally. There is no service worker, IndexedDB store or offline cache. The
  staff session lives in `sessionStorage` for one tab.

## What is missing

- The store-edge runtime itself, and a decision on its stack.
- A sync protocol: cursors per restaurant, conflict detection for data both planes can change
  (menus, prices, stock counts), replay protection across planes, and dead letters.
- Rules for which operations are allowed while offline (for example card payments, which need the
  provider) and how cash, shifts and day close behave across an outage.
- Fault-injection tests: killing processes mid-transaction, WAN loss, duplicated and reordered
  events.

## Limitations to keep in mind

- `published_at` on the outbox is never set and there is no relay to any external consumer (R-002).
- Because everything is online, every write is immediately consistent. A store edge would make
  some reads eventually consistent, which several current features (blind counts, day close
  readiness) assume they are not. Those features will need revisiting when Phase 6 starts.
