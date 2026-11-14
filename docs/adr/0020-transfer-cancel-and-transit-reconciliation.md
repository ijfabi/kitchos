# ADR-0020: Cancelling a transfer in transit, and reconciling Stock in transit

- Status: Accepted (2026-11-14)

## Context

ADR-0019 left two gaps (R-041). A transfer sent to the wrong store, or one that never left the
building, could not be undone: it had to be received at the other store and sent back, or left in
transit indefinitely. And nothing checked the Stock in transit account against the transfers that
should explain it, so a wrong or missing posting there went unnoticed.

## Decision

- **Cancel, by the sender, before receipt.** `POST …/inventory/transfers/:id/cancel` with a reason
  of 3 to 500 characters. It needs `inventory.adjust` at the sending restaurant; the receiver and
  any other restaurant get 404. A transfer is either received or cancelled, once: both paths lock
  the transfer row and require it to be in transit, so when they race exactly one wins and the
  other gets 409 (`TRANSFER_CANCELLED` or `TRANSFER_ALREADY_RECEIVED`).
- **Stock comes back as `return_to_stock`** at the location it left, for every line in full. The
  stock-ledger trigger values it at the unit cost of the same item's dispatch, never at today's
  standard cost, so a cancel returns exactly the value the dispatch took out.
- **Journal.** Event `inventory.transfer_cancelled` posts a `transfer_cancel` entry at the sender,
  on the cancel's business day: Dr Inventory / Cr Stock in transit. With the dispatch entry, the
  sender's Stock in transit for that transfer is zero.
- **Database.** Migration 0015 adds `cancelled` to the status, the cancel columns (who, when,
  business day, reason; all or none, by a check constraint), and a guard that allows only one
  change: in transit to received (every line recorded) or to cancelled (no line recorded). The
  runtime role may update only those columns.
- **Reconciling Stock in transit.** The daily reconciliation per restaurant gains a line. The
  expected change in Stock in transit that day is the value the restaurant dispatched, less the
  value returned by its cancels, less the dispatched value of transfers it received that day. It is
  compared with the journal's net change in the account, and the day only reconciles if they agree.
  As for Inventory, entries moved late from a closed day are left out of the day they land on.

## Consequences

- **A received transfer cannot be cancelled.** Sending stock back is a new transfer the other way,
  which the books record as such.
- **Cancelling is all or nothing.** There is no partial cancel; a part that never left is sent
  again as a smaller transfer after cancelling.
- **The sender decides alone.** The receiver cannot refuse a transfer. Recording that nothing
  arrived writes it off as a shortage at the receiver (ADR-0019), which is a different event: the
  goods were lost, not kept.
- **A cancel can be refused.** If returning the stock would take the sender's balance past the
  range the system can store (`QUANTITY_OUT_OF_RANGE`), the cancel is refused whole and nothing
  changes; the receiver can still receive the transfer.
- **Late cancels follow ADR-0017.** A cancel whose transaction commits after its day was closed
  posts to the first open day, flagged late. The closed day's live reconciliation then shows the
  return in its stock ledger but not in its journal (Inventory and Stock in transit, by the same
  amount), as it does for any late posting; the closed day's stored snapshot is unchanged.
- **Still open from R-041:** no ageing of transfers left in transit and no warning at day close.
  Stock in transit still nets to zero across the organisation, not per restaurant; the new check
  is per restaurant and per day, so it holds with that design.
