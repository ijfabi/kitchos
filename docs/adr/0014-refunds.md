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
- Refunds never restore stock. A refund can record the order's prepared food as waste (ADR-0011),
  which moves its cost from COGS to Waste without moving stock.
- **Refunds by item** (Milestone 15, product decision): a refund names order lines (an item or a
  whole meal) and how many. The server prices them as a cumulative share of each line's net (after
  discount), the last unit taking the rest, so a line refunded in parts returns exactly its net; it
  records them in append-only `refund_lines` and refuses more than is left. The GST returned is the
  lines' own share of the order's GST (none for a GST-free item), fixed on the refund and posted from
  there. The screen sends the amount it showed (`expectedAmountCents`), refused with 409 if the price
  has changed. A duplicate charge is refunded by amount, not by item.
- **Refunds by amount** remain for money-only cases. Their GST is the proportional share, capped at
  the GST not yet returned, with the last refund taking exactly the rest.

## Consequences

- No refund approval workflow (manager override for crew) yet; refunds need the permission on
  the signed-in user.
- Gift cards and split tender are not supported; card refunds go back to the sandbox card.
