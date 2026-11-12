# ADR-0018: Shifts and shift close

- Status: Accepted (2026-11-12)

## Context

A drawer session is one cashier on one drawer (ADR-0015), and a business day closes once for the
whole restaurant (ADR-0017). Between the two there was nothing. A supervisor handing over at 3 pm
could not see, or sign off, what happened on their watch: every till counted, each person's sales,
discounts and refunds, and the cash result across all drawers.

## Decision

- **A shift is a period of trading under one person in charge**, at one restaurant, across several
  drawers and people. `shifts` has at most one open row per restaurant (partial unique index;
  racing opens get 409 `SHIFT_ALREADY_OPEN`). Opening and closing need `shift.run`, held by shift
  supervisors and managers. Anyone with it may close the open shift. Handover is usually done by
  the incoming person, and `closed_by` records who did it.
- **Shifts are optional.** A restaurant that never opens one trades exactly as before, and day close
  does not depend on shifts.
- **Rows are stamped with their shift, not dated into it.** Orders, payments, refunds, discounts and
  drawer sessions get `shift_id` from a `BEFORE INSERT` trigger. The stamp is the restaurant's open
  shift at the moment the row is written, or none, whatever the writer passes. A stamp never
  changes, with one exception: when a shift opens, it takes in every running drawer session that has
  none, including one awaiting approval, so nothing still on the floor escapes. Both rules are
  enforced by triggers.
  - A first design used time windows (opening to close). Review and testing showed why that fails:
    a payment whose transaction began before the close but committed after it is timestamped inside
    the window, yet missing from the frozen snapshot. Opens and closes could also overlap. Stamping
    removes both.
- **Serialisation.** A per-restaurant advisory lock (`app.shift_lock_key`) is:
  - held exclusively by shift open and close;
  - held shared, until commit, by every stamped insert (in the trigger).

  So a close waits for every row already stamped with its shift, and sees it. A row written after
  the close finds no open shift. Paths that also lock a drawer session take the shared lock before
  the session (`resolveCashSession`; drawer open takes it after the drawer row). A shift opening
  holds the lock while it updates the sessions it takes in, so the other order would deadlock. Lock
  order: order → payment → shift lock → drawer session → stock → event sequence. A count or an
  approval never takes the shift lock.

- **A shift closes only when its cash is settled.** The close is refused (409 `SHIFT_NOT_READY`,
  with blockers) while any of its drawers is uncounted (`DRAWERS_OPEN`) or has a variance awaiting
  approval (`VARIANCE_PENDING`). Unfinished orders are only a warning.
- **The snapshot is immutable.** At the close, the shift stores its summary (`summary` jsonb). From
  then on a trigger refuses any update, and shifts are never deleted. A closed shift is always shown
  from its snapshot.
- **What the summary holds.** Figures are operational, from the stamped rows; the books stay per
  business day (ADR-0016/0017).
  - Drawers: each session's count snapshot (float, expected, counted, variance, approver).
  - Totals:
    - orders placed and cancelled;
    - card and cash captured (cash with rounding);
    - refunds and cash refunds;
    - discounts and comps;
    - Σ drawer variance.
  - People: everyone who placed orders, applied discounts or made refunds under the shift, or ran one
    of its drawers. For each: orders, sales (paid and not cancelled), discounts, refunds, and drawer
    variance.
- **Blind counts hold on this screen.** Drawers show expected cash only from their count snapshot.
  While any drawer of the shift is uncounted, the cash totals, the variance and each person's sales
  are withheld (null). A supervisor working a till could otherwise subtract card takings from their
  own sales to find their drawer's expected cash.

## Consequences

- Tills are changed at handover: every drawer of a shift is counted before it closes. A cashier
  working across a handover counts and opens a new session.
- Trade recorded while no shift is open belongs to no shift. That includes trade on a drawer
  opened between shifts, until the next shift takes the drawer in. So a taken-in drawer's expected
  cash can include sales that are not in that shift's cash total.
- A row is in the shift that was open when it was written, which can differ by moments from when
  the customer was served. That is the only way to make a frozen snapshot complete.
- Every order, payment, refund and discount insert takes a shared advisory lock. A shift open or
  close briefly holds back those writes at that restaurant, for milliseconds in practice.
- Shift figures do not reconcile to the journal by design: the journal dates by business day and
  completion (ADR-0016).
- There is no reopen. A mistake in a closed shift is corrected where it happened (a refund, a
  count adjustment), and the correction shows in the shift during which it was made.
- Crew can already read order totals and payment methods from the order list (`orders.view`), so
  a cashier who wants to can estimate their own expected cash (R-040). This screen adds nothing to
  that, but blind counting is only as strong as the weakest view.
