# ADR-0006: Append-only inventory ledger with exactly-once consumption

- Status: Accepted (2026-10-26)

## Decision

- **`stock_movements`** is the source of truth: one immutable row per physical fact (receipt,
  production consumption, raw waste, transfer, count adjustment, …) with item, signed quantity,
  location, actor, occurred/recorded time and business date. Sign is constrained per type.
- **`stock_balances`** is a projection maintained by an `AFTER INSERT` trigger (`SECURITY DEFINER`)
  in the same transaction. Reconcilable at any time: `on_hand = Σ quantity_delta`.
- **Exactly-once:** every movement names its cause (`source_type`, `source_id`, `source_key`). The
  unique constraint over `(org, source, item, movement_type)` makes replays — duplicate events,
  double taps, retried requests — inserts that do nothing. Consumption for an order line uses
  `source_type = 'order_line'`, `source_id = order_lines.id`.
- **Consumption point is configurable per recipe version**: `order_accepted`, `task_started` or
  `task_completed`. Order submission, payment and physical consumption are distinct events.
- **Reservations** are taken at order placement (`stock_reservations`, `stock_balances.reserved`)
  and closed as `consumed` or `released`. Shortage policy per restaurant: `block` rejects orders
  when `on_hand − reserved` is insufficient; `allow_negative` accepts and lets on-hand go negative.
  **Movements are never dropped** for lack of stock.
- **Lock order:** balances are locked in ascending `inventory_item_id`; commands lock order → task →
  balances → event sequence.
- **Cancellation after consumption does not return stock** (invariant 11). The `order.cancelled`
  event carries `consumedLineIds` so the waste module (Phase 2) can classify the loss financially
  without a second physical deduction (invariant 12).

## Consequences

- Valuation (moving average / FIFO lots) and lot-level traceability are additive: future columns
  on movements and a `stock_lots` table, without changing the ledger semantics.
