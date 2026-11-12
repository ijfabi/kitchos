# ADR-0017: Business-day close

- Status: Accepted (2026-11-02)

## Context

Nothing marked a trading day as finished. Reports could change after the fact, and drawers could
stay open indefinitely with no one required to notice. A restaurant needs a point at which a day's
cash and books are checked and its figures fixed.

## Decision

- **A day closes only when it is safe to.** `POST /v1/restaurants/:id/days/:date/close`
  (`day.close`, managers) refuses with 409 `DAY_NOT_READY` and the list of blockers unless:
  - the day has ended (`DAY_NOT_ENDED`), and ended at least 5 minutes ago (`DAY_SETTLING`), so
    transactions that began before the cutoff, and are dated to that day, have finished;
  - every drawer session up to that day is counted (`DRAWERS_OPEN`) and any variance approved
    (`VARIANCE_PENDING`);
  - the ledger has posted everything for the day (`LEDGER_BEHIND`), nothing has failed
    (`LEDGER_FAILED`), and the day reconciles (`NOT_RECONCILED`).
- **Events are counted against the day they post to, not the day they occurred.** A drawer's later
  movements and its close post to the day it opened, so a till counted after the cutoff still holds
  the day it belongs to.
- **Reconciliation now covers drawers:** Σ variance of drawers closed for the day must equal the
  journal's Cash over/short.
- **Each tender and each entry is reconciled** (added in Milestone 13, resolving R-030): card and cash
  separately (cash with its rounding), cash rounding itself, and every receipt and refund entry
  against exactly one payment or refund of that amount and day. Totals alone let a missing receipt
  and a duplicate one, or an error in one tender offset by another, cancel out. Entries moved late
  from a closed day are matched against the day they came from.
- **The snapshot is immutable.** `business_day_closes` stores totals, drawer results and warnings as
  they were at the close, and is append-only. A closed day's view always shows that snapshot.
  Unfinished orders and unreviewed waste are warnings, not blockers, because they post on the day
  they finish.
- **Closing is final, and a closed day takes no more entries.** There is no reopen: corrections post
  on the day they are made. An entry dated to a closed day moves to the first open day from today and
  records where it came from in `journal_entries.posted_late_from`. Reconciliation leaves such entries
  out of that day's comparison, since their source is dated to the closed day, and the day view warns
  about them. This is done by a trigger so it holds for every writer. The checks above make it rare;
  it exists so that a real fact can never become a permanent dead letter.
- **Posting and closing are serialised** by a per-restaurant, per-day advisory lock: entries hold it
  shared until they commit, the close holds it exclusively while it checks the day. Lock order adds
  it before everything the close reads; the dispatcher takes it last, inside its savepoint.
- **Dead letters can be retried** (`POST …/accounting/failed-events/:id/retry`, `day.close`, audited),
  and the close page lists them. Without this a failed event would leave its day unclosable.
- **Blind counts stay blind for the drawer row:** it shows expected cash only once counted. Live
  totals are shown to managers at any time (product decision, Milestone 15, R-028), so a manager
  running a till can work out its expected cash; a different person still approves their variance.
- **Drawer administration:** `cash.admin` (managers) can add drawers and retire or reactivate them.
  Retiring keeps history, and is refused while a session is unfinished. Opening a session takes the
  drawer's row `FOR SHARE` and retiring takes it `FOR UPDATE`, so neither can slip past the other.

## Consequences

- A manager cannot close tonight's trade until the cutoff (04:00 by default) plus 5 minutes.
  Closing earlier would need the business date to roll at the close, which every date calculation
  would have to learn; deferred until there is a need.
- A drawer session is one cashier on one drawer. Shifts across several drawers and people, and their
  close, were added later by ADR-0018; day close does not depend on them.
- Moving a restaurant's cutoff or timezone can make a closed day current again. There is no API for
  this today. Entries then post to the next open day, so nothing is lost (R-029).
- A session that crosses midnight still posts its float and close to its opening day while its sales
  post to their own days (R-021). The day close now shows each drawer's result, and each session nets
  to zero overall.
