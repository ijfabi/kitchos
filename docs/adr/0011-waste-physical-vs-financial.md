# ADR-0011: Waste separates physical movement from financial classification

- Status: Accepted (2026-10-26)

## Context

A cooked burger whose ingredients were consumed at `task_started` and is then dropped must be
recorded as waste, but deducting its ingredients again would double-count (invariant 12). Yet a
burger dropped _before_ its consumption point, or the replacement made after a drop, are real
physical usage that must reach the ledger.

## Decision

Every waste record stores per-ingredient lines with a **treatment**:

| Situation                                           | Physical ledger                                                      | Treatment          |
| --------------------------------------------------- | -------------------------------------------------------------------- | ------------------ |
| Raw ingredient spoiled/expired/dropped              | `waste_raw` movement now                                             | `deducted_now`     |
| Prepared item for an order line already consumed    | **none**                                                             | `already_consumed` |
| Prepared item for an order line not yet consumed    | `waste_prepared` movement now; the line consumes normally later      | `deducted_now`     |
| Prepared item not tied to an order (overproduction) | `waste_prepared` from the recipe pinned on the current menu          | `deducted_now`     |
| Remake of an already-consumed line                  | extra `production_consumption` with `source_key = remake:<waste id>` | (consumption)      |

- Portion quantities come from the line's immutable `order_line_ingredients` snapshot, so the
  waste reflects exactly what was made (modifiers included).
- **Cost** is computed at standard cost (`inventory_items.standard_unit_cost`, exact decimal
  arithmetic, ADR-0004). Reports split total waste cost into _reclassified from consumption_
  (already inside COGS — move it, do not add it) and _deducted directly_. This is what lets the
  shift report show waste without double-counting it against food cost.
- Records above the restaurant's `waste_approval_threshold_cents` are `pending_approval`; the
  physical loss is still recorded immediately (it happened). Approval requires `waste.approve`
  and a reviewer other than the recorder. **Rejection** (e.g. mis-keyed quantity) appends
  `correction` movements reversing what the record deducted (`source_type = waste_reversal`,
  `source_key = original movement id`), never editing or deleting history. Remake consumption is
  not reversed — the replacement was physically made.
- Waste requests are idempotent (`Idempotency-Key`), and each movement's source key makes a
  replay a no-op.
- **Waste of an order line is capped cumulatively, under the order lock** (added in Milestone 10).
  Once consumed, a line can lose its quantity plus portions actually remade; before then, only its
  quantity. Rejected records give their quantity back; remakes stand even if rejected. `remake` is
  stored true only when a fresh portion was consumed.
- **Cancellations and refunds record prepared food as waste** (added in Milestone 14, decisions
  by the product owner). Cancelling an order records every prepared (consumed) portion not yet
  wasted, reason `cancelled_prepared_order`, in the cancel's transaction. A refund by item
  (Milestone 15) records the refunded items' food, a meal's components included; a replaced item
  is recorded as waste with a remake. A refund by amount records only what staff enter.
  Staff can adjust: a `waste` list in the request is then the whole answer, and `preparedVersion`
  (from `GET …/orders/:id/prepared-items`) refuses the request with 409 if the kitchen prepared or
  wasted more since it was chosen. Food not yet consumed is released, not wasted.
- **Waste of consumed food is costed at its consumption cost**, the unit cost fixed on the line's
  consumption movements, so the reclassification reverses exactly what went into COGS.

## Consequences

- Standard costing is an interim valuation; moving-average or FIFO lot costing will replace the
  unit cost source without changing the treatment model.
- Batch-produced items (e.g. pre-cooked fries held in a bin) will need `batch_production`
  movements so that overproduction waste can be `already_consumed` too (Phase 2 follow-up).
