# ADR-0016: Inventory valuation in the journal

- Status: Accepted (2026-10-30)

## Context

The journal recorded money (payments, sales, refunds, drawers), but stock had no financial
side. Food cost, waste expense and shrinkage were only in operational reports, so the books
could not show gross margin, and nothing proved that the stock ledger and the accounts agreed.
ADR-0011 already separated physical waste from its financial classification, and standard cost
exists (`inventory_items.standard_unit_cost`, cents per base unit).

## Decision

- **Every stock movement carries its value, fixed when it is recorded.** A `BEFORE INSERT`
  trigger on `stock_movements` sets `unit_cost` (the item's standard cost at that moment) and
  `value_cents = round(quantity_delta × unit_cost)` (signed, half away from zero, matching
  `extendedCostCents`). Writers cannot supply or alter it, and later standard-cost changes do
  not revalue history. Rows recorded before this migration keep NULL values; they are outside
  the journal (their historical value is unknown, and is not guessed at today's cost).
- **Posting is event-driven, one journal entry per event.** Each stock operation is posted from
  the event its own transaction emitted, using the recorded movement values. Adding events to
  the inventory paths would break the lock-order rule (event sequence last), so no new events
  are emitted from them:

  | Event                                 | Entry            | Postings                                                                                                                       |
  | ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
  | `order.accepted`                      | `cogs` (order)   | Dr COGS / Cr Inventory for lines consumed at acceptance                                                                        |
  | `kitchen.task.started` / `.completed` | `cogs` (line)    | the same for the task's line, only if that event is its consumption point                                                      |
  | `inventory.waste_recorded`            | `waste`          | deducted now: Dr Waste / Cr Inventory; already consumed: Dr Waste / Cr COGS (reclassification); remake: Dr COGS / Cr Inventory |
  | `inventory.waste_rejected`            | `waste_reversal` | restored stock back to Inventory, reclassification back to COGS (the remake stands)                                            |
  | `inventory.goods_received`            | `goods_receipt`  | Dr Inventory / Cr Goods received not invoiced                                                                                  |
  | `inventory.counted`                   | `stock_count`    | shrinkage Dr Stock count variance / Cr Inventory (a gain the reverse)                                                          |
  | `inventory.opening_stock` (seed)      | `opening_stock`  | Dr Inventory / Cr Opening balance equity                                                                                       |

  A line has exactly one consumption point and is consumed exactly once, so each line's cost
  lands in exactly one entry. Journal uniqueness per (source, entry type) plus the consumer
  inbox make redelivery a no-op.

- **Corrections reverse at the original value.** A `correction` movement whose `source_key`
  names the movement it reverses (e.g. a rejected waste record) copies that movement's unit cost,
  so a rejection exactly undoes the waste even if the standard cost changed in between.
- **Cutover.** The migration marks every pre-existing event of the newly consumed types as
  handled by the ledger: they concern unvalued movements, and replaying the whole history would
  only create backlog. Separately, a waste record that touches any unvalued movement (its own
  movements, or the consumption of the line it wastes) posts nothing. Otherwise its
  reclassification would credit COGS for cost that was never debited.
- **Reconciliation.** For each business day, Σ `value_cents` of valued movements must equal
  the journal's net change in Inventory. This is part of `reconciled`. It is an aggregate check:
  a missed posting and an equal double posting on the same day would cancel out. Double posting
  is prevented structurally (journal uniqueness per source and entry type, plus the consumer
  inbox).
- **Accounts added to the default chart:**
  - Goods received not invoiced (2300, liability)
  - Opening balance equity (3000)
  - Stock count variance (5200)

## Consequences

- Receipts are valued at standard cost. The supplier price on a receipt line is stored but not
  posted; purchase price variance and the payable belong to invoice matching (Phase 5).
- Waste reclassification of already-consumed food (since Milestone 14) takes its share of what
  the line's consumption, remakes included, was valued at, and the last portion takes exactly what
  is left. So a line's COGS nets to zero once all of it is wasted, across standard cost changes and
  partial wastes. A remake is a new portion, valued at the cost on the day it is made.
- Any code that writes stock movements outside the application must also emit the matching
  event, as the test fixture does. Otherwise the movement is valued but never posted, and the
  day does not reconcile, which is by design.
- Moving-average or FIFO costing can replace the trigger's cost source without changing the
  posting model.
