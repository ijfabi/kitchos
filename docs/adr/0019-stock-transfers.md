# ADR-0019: Stock transfers between restaurants

- Status: Accepted (2026-11-14)

## Context

Restaurants of one organisation lend each other stock (a store short of buns before the weekend).
Until now the only way to record that was a negative count at one store and a receipt at the other,
which misstated both as shrinkage and a supplier delivery, and moved no value between them.

## Decision

- **Two steps: dispatch, then receipt.** The sender records what it sends (`stock_transfers`,
  `stock_transfer_lines`, `transfer_out` movements at its default location). The goods are then in
  transit. The receiver records, once, what actually arrived for every line, from nothing up to
  what was sent (`transfer_in` movements at its default location). Anything less is a shortage.
  Arriving more than was sent is refused; extra stock is a count matter.
- **Who.** Sending needs `inventory.adjust` at the sender, receiving needs it at the receiver.
  Neither needs access to the other restaurant. Only the receiver can receive, and a transfer is
  visible only to the two restaurants on it. Destinations are the other active restaurants of the
  organisation; anyone who can send sees their names.
- **Shortage policy.** Under `block`, a dispatch may not take a balance below what is reserved
  (checked on the balance rows the movements locked). Under `allow_negative` it goes through.
- **Valuation.** A dispatch is valued like any movement (ADR-0016). A `transfer_in` is valued by
  the stock-ledger trigger at the unit cost of the same item's dispatch, never at today's cost, so
  arrival moves exactly the value that left. A `transfer_in` with no valued dispatch is refused.
- **Journal.**

  | Event                           | Restaurant | Entry          | Postings                                                                                                 |
  | ------------------------------- | ---------- | -------------- | -------------------------------------------------------------------------------------------------------- |
  | `inventory.transfer_dispatched` | sender     | `transfer_out` | Dr Stock in transit / Cr Inventory                                                                       |
  | `inventory.transfer_received`   | receiver   | `transfer_in`  | Dr Inventory (what arrived) + Dr Transfer shortage (the rest) / Cr Stock in transit (the whole dispatch) |

  New accounts: 1210 Stock in transit (asset), 5300 Transfer shortage (expense). Both restaurants'
  Inventory still reconciles to their stock ledgers per business day.

- **Immutability.** A transfer changes once, from in transit to received; its lines get their
  received quantity once. Triggers refuse anything else and any delete. The runtime role can update
  only those columns. Since migration 0014 the triggers also keep a receipt whole: a transfer
  becomes received only when every line records what arrived, and no line changes after.
- **Lock order:** transfer row → stock balances (ascending item) → event sequence. Dispatch and
  receipt each lock only their own restaurant's balances and event sequence.

## Consequences

- **Stock in transit nets to zero across the organisation, not per restaurant.** It is debited at
  the sender and credited at the receiver, so a single restaurant's trial balance shows a standing
  debit (sender) or credit (receiver). It behaves as an inter-store account that eliminates on
  consolidation. A per-restaurant clearing pair would avoid this; not built.
- **The receiver bears the shortage.** Loss on the road lands on the receiver's books on the day
  it records the arrival. The day-close summary shows it (`transferShortageCents`; absent on days
  closed before this change). The food cost report does not yet include it in actual food cost.
- **No cancel or return.** A transfer sent to the wrong store is received there and sent back. A
  transfer never received stays in transit indefinitely, and nothing yet reports open transfers
  beyond the receiver's Arriving list (no ageing, no close-readiness warning, no check that the
  transit balance equals open dispatches).
- **No lots or expiry on transfers.** Lot traceability is a later milestone.
- Locations are tied to their restaurants by the service, not by a database constraint.
