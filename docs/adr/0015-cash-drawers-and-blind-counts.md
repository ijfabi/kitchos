# ADR-0015: Cash drawers, till sessions and blind counts

- Status: Accepted (2026-10-30)

## Context

Until now any user with `orders.create` could take cash, and nothing tied cash to a person or a
drawer (RISKS R-012). Restaurants need to know, per drawer and per shift, how much cash should be
there, who was accountable for it, and whether the count matched, with shortages visible to
someone other than the cashier.

## Decision

- **Drawers and sessions.** `cash_drawers` belong to a restaurant. A `drawer_sessions` row is one
  cashier's shift on one drawer: `open → (counted) → closed`, or `open → pending_approval → closed`
  when the variance is over the limit. Partial unique indexes allow **one active session per
  drawer** and **one per person per restaurant**, so racing opens get a 409 (`DRAWER_IN_USE`,
  `ALREADY_HAVE_DRAWER`).
- **Cash is accountable to one person.** A cash payment or cash refund must name a drawer session:
  the acting user's own open session at that restaurant, or an explicit one that is open, in the
  same restaurant and opened by the actor. Otherwise 409 `DRAWER_SESSION_REQUIRED` /
  `DRAWER_SESSION_CLOSED`, or 403. A database trigger enforces the same on INSERT into
  `payments`, `refunds` and `drawer_movements` (cash needs a session; the session must be open and
  in the same restaurant). It is a trigger, not a `NOT VALID` CHECK, because Postgres re-checks such
  a constraint on every UPDATE, which would block refunds of cash payments taken before drawers
  existed.
- **Expected cash is always derived from source records**: float + cash sales (amount + rounding)
  − cash refunds (amount + rounding) + paid-ins − paid-outs − safe drops (`expectedDrawerCash`).
  It is never stored except as the snapshot taken at the count.
- **Locking.** Payments lock the session `FOR SHARE`, both in the service and in the trigger.
  Cash leaving the drawer (refunds, movements) and the count take `FOR UPDATE`. A count therefore
  waits for in-flight payments and sees them, and a payment that waited on a count is refused.
  Lock order: order → payment → drawer session → kitchen tasks / stock → event sequence.
- **Movements** (`paid_in`, `paid_out`, `safe_drop`) are append-only, idempotent, and recorded by
  the drawer's cashier or someone with `cash.manage`. Paid-outs require `cash.manage`.
- **Blind counting.** While a session is open, expected cash is shown only to someone with
  `cash.manage` who is **not** the drawer's cashier. A supervisor working a till counts blind like
  anyone else. The counter sees expected cash and the variance only in the count response.
  Removing more cash than expected is refused (422 `INSUFFICIENT_DRAWER_CASH`) only for actors who
  can see expected cash. For a blind cashier that 422 would let them binary-search the hidden
  figure, so their over-removal shows up as a variance at the count instead. Cash refunds always
  check (the amount is bounded by a real order). An idempotent replay is re-rendered for the
  caller, never returned as the original actor's view.
- **Variance approval.** If |variance| exceeds `restaurants.cash_variance_threshold_cents`
  (default 500c), the session waits in `pending_approval` until someone with `cash.manage` who
  neither ran nor counted the drawer approves it with notes. A CHECK constraint enforces the same
  rule in the database. A pending session blocks its cashier from opening another drawer.
- **Journal** (via the ledger consumer, exactly once per event):
  - `drawer.opened`: Dr Cash on hand / Cr Cash in safe (float).
  - `drawer.movement_recorded`: paid-in Dr Cash on hand / Cr Cash in safe; safe drop the
    reverse; paid-out Dr Petty cash expense / Cr Cash on hand.
  - `drawer.closed` (at the count, or at approval): Dr Cash in safe (counted) and Cr Cash on hand
    (expected), with the difference to Cash over/short.
  - Each closed session's cash-on-hand therefore nets to zero.

## Consequences

- Restaurants need drawers before they can take cash. Drawers are seeded; there is no drawer
  admin API yet.
- A session that crosses midnight posts its float and close at the opening business date, while
  its sales post at their own dates. The total balances, but cash on hand per business date does
  not net to zero for such sessions (acceptable until shift and business-day close).
- Approval is not idempotent: a retry after success returns 409 `INVALID_STATE_TRANSITION`, and
  the UI refetches.
- A drawer count is not yet a shift or business-day close; those follow.
