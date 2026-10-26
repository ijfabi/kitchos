# ADR-0012: Order discounts and terminal manager overrides

- Status: Accepted (2026-10-27)

## Context

POS staff need to discount orders (service recovery, price matches, staff meals, comps) without
giving every crew member unlimited power, and approvals must be attributable without a manager
logging the crew member out of the terminal.

## Decision

- **One discount per unpaid order**, percent (basis points) or amount (cents), with a reason
  code. Stored append-only in `order_discounts`; `orders.discount_cents/total_cents/tax_cents`
  are updated in the same transaction. Paid or accepted orders cannot be discounted (refunds
  are a separate, Phase 3 operation).
- **Exact allocation and GST.** The discount is allocated across top-level lines in proportion
  to their totals by largest remainder (`order_lines.discount_cents`, summing exactly), and GST
  is recomputed on the discounted taxable portion only, so mixed taxable/GST-free orders stay
  correct.
- **Self-approval policy** per restaurant: crew may apply discounts up to
  `discount_self_approval_bp` (10%) **and** `discount_self_approval_cents` ($5). Complimentary
  discounts always need authority. Users with `discount.approve` (supervisors and above) approve
  their own discounts directly; the audit records that approval was required.
- **Manager override** for everyone else: the approver re-authenticates on the terminal
  (`POST /overrides`, same password checks and rate limits as sign-in, uniform errors for other
  tenants). The API returns a 256-bit single-use secret, stores only its SHA-256, and binds it
  to restaurant, action, order, requesting user, a 2-minute expiry **and the exact discount**
  (kind, value, reason). The server computes the resulting amount when granting, returns it so
  the approver sees what they authorise, and records it in the audit. Using the override
  requires an identical discount — approval for 15% can never authorise a comp, and a different
  (even smaller) discount needs a new approval. Approver ≠ requester is a database CHECK.
  Consumption is a conditional UPDATE (unconsumed, unexpired, matching) inside the discount
  transaction, so a failed discount does not burn the override.
- **Credential throttling** is shared by sign-in and overrides: failed attempts count per
  account regardless of client IP, and per requesting user for overrides; successful checks do
  not count, so busy approvers are not locked out; all attempts count against a per-IP ceiling.
  Denied overrides are audited (`override.denied`) with the attempted approver and discount.
- **Zero-total orders** (100% comps) are accepted immediately and released to the kitchen with no
  payment row; stock is consumed exactly as for a paid order — the financial classification
  (comp/staff meal) lives on the discount, not the inventory ledger.

## Consequences

- No discount stacking, coupons or line-level discounts yet.
- The approver's authority is checked when the override is granted, not re-checked at the
  moment of use (two-minute window).
