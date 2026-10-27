# ADR-0014: Refunds and payment reversal

- Status: Accepted (2026-10-27)

## Context

Customers are refunded after a cancellation (money taken, nothing handed over) or after
handover (quality, order errors). Refunds must never exceed what was captured, must not restore
stock (invariant 11), and must post correctly whether or not revenue was already recognised.

## Decision

- A refund is an append-only `refunds` row against a captured payment, created by
  `POST /orders/:id/refunds` (`payments.refund`, supervisor and above), idempotent per
  restaurant and order. Partial refunds are allowed; `payments.refunded_cents` is maintained in
  the same transaction and constrained to `≤ amount_cents`; the payment moves
  `captured → partially_refunded → refunded` through the payment state machine. The order row
  and then the payment row are locked, so concurrent refunds serialise.
- Refunds are allowed only once an order is finished: **completed** (handed over) or
  **cancelled**. The accounting **treatment is fixed at creation**:
  - `deposit_release` (cancelled): Dr Customer deposits / Cr Card clearing or Cash — clears the
    liability left by a cancelled paid order (RISKS R-016);
  - `sales_return` (completed): Dr Sales returns (ex GST) + Dr GST payable / Cr Card clearing or
    Cash. The GST share is computed **cumulatively** (GST of refunded-so-far-including-this minus
    GST of refunded-before), so any sequence of partial refunds returns exactly the order's GST
    at full refund and never more.
- Cash refunds hand back the amount rounded to the restaurant's cash increment; the difference
  is booked to Cash rounding, mirroring payments.
- Refunds have no inventory effect. Restocking or waste of returned food, if any, is a separate
  inventory operation.

## Consequences

- No refund approval workflow (manager override for crew) yet; refunds need the permission on
  the signed-in user.
- Gift cards and split tender are not supported; card refunds go back to the sandbox card.
