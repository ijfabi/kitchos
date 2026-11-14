# Progress log

## Milestone 19: Stock transfers between restaurants (2026-11-14)

### Implemented (design decision: ADR-0019)

- **Dispatch and receipt:** the sender records what it sends (`transfer_out` at its default
  location). The receiver then records, once, what arrived for every line, from nothing up to what
  was sent (`transfer_in`). Anything less is a shortage, and more than was sent is refused.
  - Endpoints under `/v1/restaurants/:id/inventory/transfers`: list (incoming or outgoing), get,
    dispatch and receive; `…/inventory/transfer-destinations` lists the other active restaurants of the organisation.
  - Both sides need `inventory.adjust` at their own restaurant only. A transfer is visible only to
    the two restaurants on it.
  - Under the `block` shortage policy a dispatch may not take stock below what is reserved.
- **Valuation:** a `transfer_in` is valued by the stock-ledger trigger at the unit cost of the same
  item's dispatch, so arrival moves exactly the value that left, whatever the standard cost did.
- **Journal:** new accounts 1210 Stock in transit and 5300 Transfer shortage. The sender posts Dr
  Stock in transit / Cr Inventory; the receiver posts Dr Inventory and Dr Transfer shortage / Cr
  Stock in transit. Both restaurants' Inventory still reconciles to their stock ledgers by day, and
  day close shows `transferShortageCents`.
- **Database:** migration `0013_stock_transfers` (tables, RLS, column-level grants, triggers that
  allow only one change, from in transit to received, and no deletes). Migration
  `0014_stock_transfer_receipt_guard` was added after review: the triggers now also refuse a
  received transfer with an unrecorded line, and any line recorded after receipt.
- **Screen:** a Transfers tab on the inventory screen to send stock and receive what arrives.

### Independent review and testing (subagents)

The reviewer read the migration, service, controller, valuation trigger, poster, ledger and day
close end to end. It found no critical, high or medium defects. The low findings:

- **Fixed:** the database did not itself keep a receipt whole (migration 0014, above). The new test
  was mutation-checked: removing either new trigger clause makes it fail.
- **Fixed:** the receiver's single Stock in transit credit kept the memo "Stock received by
  transfer" even when it included the shortage. It now reads "Transfer cleared: received and
  short" (domain test added).
- **Recorded as R-042:** the transfer list loads each transfer with three queries.
- **Already recorded as R-041:** no cancel or return, and nothing reports transfers left in
  transit.

The tester added `stock-transfers-interactions.test.ts` (7 tests, all pass; no product defect).
Each test checks persisted rows, journal lines and balances:

- day close at the sender while goods are in transit, and at the receiver before the receipt;
- a receipt that lands after the receiver's day closed posts to the next open day, flagged late;
- transfers are not cost of sales in the food cost or menu item reports;
- dispatch racing a stock count and a waste record on the same items (4 rounds, no deadlock);
- dispatch racing order reservations under the block policy (4 rounds, never oversold);
- attribution, audit rows and event versions;
- every trial balance stays balanced, and org-wide Stock in transit equals the open dispatches.

Not tested: a receipt that truly commits across midnight (simulated by backdating), restaurants in
different time zones, and a transfer in transit when either restaurant is deactivated.

### Tests executed (14 November 2026, Windows 11, Docker Desktop)

| Suite                      | Result                                                            |
| -------------------------- | ----------------------------------------------------------------- |
| `@kitchos/domain`          | 63/63 passed                                                      |
| `@kitchos/api` integration | 507/507 passed (33 files, shuffled, seed `1794652460414`)         |
| Transfer suites alone      | 8 + 17 + 7 passed                                                 |
| Playwright (15 journeys)   | 12 passed, 3 failed on reused local data (below); transfer passed |
| ESLint / Prettier / tsc    | clean                                                             |

The three Playwright failures (the waste journey in `inventory.spec.ts`, and the order and refund
journeys in `order-journey.spec.ts`) each found two orders with the same daily number. The local
database held journey orders from 12 November, for example a cancelled `#1` beside the new `#1`. They
do not touch transfer code. They were not rerun on a fresh database before this commit, because
`pnpm db:reset` erases the local data; that rerun follows the commit. `next build` was not run this time.

### Not done

- Cancel and return of a transfer, an open-transfer report and a check of the transit balance
  against open dispatches (R-041).
- Transfer shortages in actual food cost (ADR-0019).

## Milestone 18: Shifts and shift close across drawers and people (2026-11-12)

### Implemented (design decision: ADR-0018)

- **Shifts:** a period of trading under one person in charge, across several drawers and cashiers.
  - At most one shift is open per restaurant.
  - Opening and closing need the new `shift.run` permission (shift supervisors and managers).
  - Endpoints: `GET/POST /v1/restaurants/:id/shifts`, `GET …/shifts/current`, `GET …/shifts/:id`,
    `POST …/shifts/:id/close`.
  - Shifts are optional; day close does not depend on them.
- **Stamping:** migration `0012_shifts` stamps orders, payments, refunds, discounts and drawer
  sessions with the open shift by trigger, under a shared advisory lock held until commit.
  - A stamp never changes, except that a shift opening takes in running drawer sessions that have
    none.
  - A close waits for every row stamped with its shift, and a later row finds no open shift.
- **Close:** refused with `SHIFT_NOT_READY` until every one of the shift's drawers is counted and any
  variance approved. It then stores an immutable snapshot (trigger) of:
  - each drawer's count;
  - per person: orders, sales, discounts, refunds, drawer variance;
  - totals: orders, cancellations, card and cash, refunds, discounts, Σ variance.
- **Blind counts:** cash totals, the variance and each person's sales stay hidden until every drawer
  is counted. Otherwise a supervisor working a till could work out its expected cash.
- **Screen:** `/shift/:restaurantId` lets a supervisor open a shift, see blockers, drawers, people and
  totals, close with handover notes, and see earlier shifts. It is linked from the workspace picker.

### Independent review and testing (subagents)

The first design dated rows into a shift by time window. Both subagents found the same defect, and
the tester reproduced it. A card payment whose transaction began before the close and committed after
it was timestamped inside the closed shift, yet missing from its frozen snapshot (1190c expected, 0
recorded). The reviewer also found that a shift open waiting behind a close could start before the
close's time, so two shifts overlapped.

Both were fixed by stamping, as above. The tester's race test was rewritten for that rule and now
proves both sides:

- a payment already written when the close starts is waited for and counted;
- a payment written after the close belongs to no closed shift.

Also from the review:

- **Fixed:** the database now refuses a drawer joining a closed shift or one at another restaurant.
- **Fixed:** a shift that closes after the cutoff is listed on the day it closed.
- **Documented:** a taken-in drawer's expected cash can include sales from before the shift.
- **Recorded as R-040:** crew can already estimate expected cash from the order list. This predates
  shifts.

The tester's other scenarios held against source rows:

- access, from crew up to another org;
- the runtime role cannot edit or delete a closed shift, or move a row's shift;
- racing opens, 6 rounds of 3;
- drawer open against shift open, and close against drawer open, count and approval, 6 rounds each;
- a drawer awaiting approval, taken in by the next shift;
- a multi-crew shift with cash rounding and refunds;
- the snapshot unchanged after later trade;
- consecutive shifts, with no payment in both.

### Findings

- Mutation checks: 7 mutants, all killed:
  - no shared lock when a drawer opens (before stamping);
  - no adoption;
  - not blind;
  - blockers ignored;
  - the trigger takes no lock;
  - the cash path locks its session before the shift lock (a deadlock order);
  - no stamping.
- The tester's first race test only appeared to wait. The owner connection cannot read the app
  role's queries in `pg_stat_activity`, and a supertest request is not sent until awaited, so its
  loop always timed out. It now polls `pg_locks` and fires the requests.

### Tests executed

| Suite                      | Result                                         |
| -------------------------- | ---------------------------------------------- |
| `@kitchos/domain`          | 61/61 passed                                   |
| `@kitchos/api` integration | 475/475 passed (shuffled; 30 files); see below |
| Playwright (14 journeys)   | 14/14 passed                                   |
| ESLint / Prettier / tsc    | clean                                          |
| `next build`               | succeeded                                      |

Full-suite runs, in order:

1. A failure in `security.test.ts`: it pinned the admin's restaurants at 3, and the new shift tests
   add restaurants to the seeded org. It now compares against the org's restaurants in the database.
2. An intermittent failure in `day-close.test.ts`: "a close waits for an entry being posted" settled
   within its 750 ms window. That run also reported 29 files instead of 30. It did not reproduce:
   - replaying the same shuffle seed passed 475/475;
   - the file alone passed twice;
   - it passed after the shift files.

   Day close writes nothing that is stamped with a shift. Recorded as an unexplained flake.

3. One clean run: 475/475.
4. A second run was stopped by the host for low memory. Before that, one day-close adversarial test
   had stalled for 27 minutes. That file passed alone (61/61, 19 s). The full run was not repeated.

### Not done

- Settling a shift's cash into the safe as a single handover entry (the books stay per drawer
  and day).
- A shift report export, and shift targets or labour figures.

## Milestone 17: Food cost per menu item and category (2026-11-12)

### Implemented

- **Report:** `GET /v1/restaurants/:id/reports/menu-items?from&to` (`reports.view`, at most 92
  days). Each menu item (a meal is one row, costed with its components) and each category shows:
  - units sold;
  - net sales (ex GST, after discounts);
  - recipe cost;
  - recipe cost as a share of net sales;
  - gross profit.
- **How it is dated:** like the food cost report, by the journal's sale and refund entries. Refunds
  by item take back their units, their stored amount less GST, and their exact cumulative share of
  recipe cost.
- **Refunds by amount:** they name no items, so they are shown apart (R-038). The totals are items
  less refunds by amount. They equal the food cost report's net sales and recipe cost of sales to
  the cent.
- **Naming (D-024):** a product is one row, named and placed in a category by its newest sale.
- **Screen:** a "By menu item" table under the food cost report, grouped by category, with negative
  gross profit in red.
- No schema change.

### Recovery before work

The repository's `.git/config` was all null bytes, so git could not run. It was rebuilt from
`FETCH_HEAD`: origin `github.com/ijfabi/kitchos`, with `main` tracking it. The corrupt copy was
kept outside the repo. This slice was already partly written but uncommitted and unverified; it was
completed and verified here.

### Independent review and testing (subagents)

- **Review:** the totals reconcile in every case examined:
  - discounts and comps;
  - GST-free lines;
  - cash rounding;
  - meals;
  - refunds of every kind;
  - late entries.

  One real defect: a row's name and category came from whichever line was read first, with no
  ordering. A product renamed or moved between menu versions could change label between refreshes.
  Fixed by D-024, with a test (mutation-checked).

- **Tester:** wrote `menu-item-report-adversarial.test.ts` in a throwaway organisation. Expected
  figures are rebuilt from source rows, with their own GST split and rounding. It covers:
  - percent and amount discounts across lines, and a comp;
  - GST-free water and meals;
  - a cash sale with rounding from a drawer;
  - refunds by item one unit at a time, across days (including a refund-only day with negative
    units);
  - refunds by amount;
  - a remake;
  - cancellation with a deposit refund;
  - all 15 sub-ranges of five days;
  - tenant and restaurant isolation.

  Every invariant held. It hit the same naming defect, assuming sales split by the category they
  were sold under. The test now asserts D-024 instead.

- **Fix during review:** the first version grouped sold lines by order in O(orders × lines). It now
  uses a map.

### Tests executed

| Suite                      | Result                                  |
| -------------------------- | --------------------------------------- |
| `@kitchos/domain`          | 61/61 passed                            |
| `@kitchos/api` integration | 455/455 passed (×2, shuffled; 28 files) |
| Playwright (13 journeys)   | 13/13 passed                            |
| ESLint / Prettier / tsc    | clean                                   |
| `next build`               | succeeded                               |

### Not done

- CSV/PDF export of reports.
- Food cost per category as a menu's categories stood at the time of sale (D-024 chose the newest).

## Milestone 16: Recipe cost of sales (theoretical food cost) (2026-11-10)

### Implemented

- **Recipe cost of sales:** the food cost report now shows, per business day and in total, the
  recipe cost of sales. That is the cost the sold lines were consumed at (remakes excluded), less items
  refunded by item, each taking its exact cumulative share.
- **Two new figures:** its share of net sales (theoretical food cost), and unsold production (COGS less
  recipe cost of sales).
- **Screen:** a Recipe food cost stat beside Actual, and columns for food produced, recipe cost of sales
  and unsold production. No schema change. Resolves R-031 (D-023).

### Independent review and testing (subagents)

Both found the same design defect, and the tester proved it. Recipe cost of sales was dated from
hand-over and refund times, while revenue and COGS come from the journal. So:

1. a sale posted late from a closed day changed that closed day (50c to 87c in the test), while its
   revenue moved to the next open day;
2. an undispatched sale showed recipe cost with no revenue behind it.

It is now read from the journal's own sale and refund entries, in the same transaction as the rest of
the report. That also fixed two queries the reviewer measured scanning every consumption movement and
every refund in the restaurant's history; they now use the journal's date index and look lines up per
order.

Also fixed: the labels claimed comps are unsold production (they count in recipe cost of sales at zero
revenue), and they did not say unsold production goes negative on the day food cooked earlier is sold.
The food produced column is back.

The tester's other 30 scenarios held against figures computed from source rows. They covered:

- a clean day where recipe cost of sales equals COGS;
- consumption at acceptance, at task start and at completion;
- cooked on one day and sold on the next;
- meals, comps and discounts;
- refunds by item one unit at a time, across days and before the range;
- refunds by amount, cancellations and remakes;
- a 92-day range, tenant isolation and RLS.

### Findings

- Mutation checks: 4 mutants, all killed. They covered remakes counted as sold, refunds by item
  ignored, refund history ignored, and meal components left out of a refund's value.
- One older test pinned that a refund by amount does not reduce recipe cost of sales; that is the
  design (it names no items), now stated in the test and on the screen.

### Tests executed

| Suite                      | Result                                  |
| -------------------------- | --------------------------------------- |
| `@kitchos/domain`          | 61/61 passed                            |
| `@kitchos/api` integration | 441/441 passed (×2, shuffled; 26 files) |
| Playwright (13 journeys)   | 13/13 passed                            |
| ESLint / Prettier / tsc    | clean                                   |
| `next build`               | succeeded                               |

### Not done

- Food cost per menu item or category.

## Milestone 15: Refunds by item, and live figures for managers (2026-11-10)

### Implemented (decisions by the product owner)

- **Refunds by item:** a refund refunds the whole price of specific items, and they count as waste.
  - The server prices each line as a cumulative share of its net (after discount), the last unit
    taking the rest (`itemRefundCents`, property-tested), and refuses more than is left on a line.
  - Migration `0011_item_refunds` adds append-only `refund_lines`.
  - A meal's components are the waste; food already recorded (for example on cancel) is not recorded
    again.
- **GST per line:** each line carries its share of the order's GST, and GST-free lines carry none
  (`lineGstCents`). An item refund returns its own share, stored on the refund and posted from there.
  A refund by amount keeps the proportional share, capped at what is left and exact at the end.
  Resolves R-019 for refunds by item.
- **Replace:** records the item as waste with a remake (a fresh portion). It keeps one idempotency key
  per item until a definite answer, and says when the waste needs approval.
- **Refunds by amount** stay for money-only cases, such as duplicate charges, which cannot be refunded
  by item. They record waste only if staff enter it.
- **Refund screen:** by item is the default, showing the server's exact amount. The amount it showed
  is sent along, and refused with 409 if the price has changed.
- **R-028 (accepted):** department managers see live figures at any time. Consequence: a manager's own
  till is not blind, but a different person still approves their variance.
- R-035 is resolved by the decision above.

### Independent review and testing (subagents)

Both found the same defect, which the tester reproduced: a refund by item took GST in proportion to
the whole order. For a GST-free water on an order with a taxable burger, it returned 21c of GST
(expected 0), and the burger then returned 79 (expected 100). It was latent, since no seeded item is
GST-free. Fixed with per-line GST, as above.

Also from the review:

- Replace used a new key per click, so a retry after a lost response could remake twice.
- Replace showed for fully refunded items.
- The screen could show one amount and send another after a retry.
- Duplicate charges could be refunded by item.
- The docs were stale.

Accepted as risks: R-036 (mixing refunds by amount and by item) and R-037 (the refund line to order tie
is enforced in the service only).

The tester's other 15 scenarios held. They covered:

- units refunded one at a time summing exactly to the net;
- percent and amount discounts, comps, and cash rounding with an earlier refund by amount;
- races (item against item, item against amount, item against cancel);
- meals ×2 and component lines refused;
- idempotency and access;
- books reconciling per tender and per entry.

### Findings

- Every test that relied on Milestone 14's reason-based waste default moved to refunds by item. My
  first Milestone 15 version left the screen still able to hide totals; that branch is removed.
- Mutation checks: 5 mutants, all killed. They covered item GST from the proportional rule, the
  discount ignored in the item price, a stale amount accepted, no per-line limit, and refund lines
  not recorded.
- Milestone 14's final verification (blocked by Docker earlier) was completed first: 387/387 (×2),
  E2E 12/12, build, and all 6 mutants killed.

### Tests executed

| Suite                           | Result                                  |
| ------------------------------- | --------------------------------------- |
| `@kitchos/domain`               | 60/60 passed                            |
| `@kitchos/api` integration      | 407/407 passed (×2, shuffled; 25 files) |
| Playwright (13 journeys, 1 new) | 13/13 passed                            |
| ESLint / Prettier / tsc         | clean                                   |
| `next build`                    | succeeded                               |

### Not done

- Replace does not send a kitchen ticket, and meals cannot be replaced as a whole.
- R-036 and R-037.

## Milestone 14: Prepared food recorded as waste on cancel and refund (2026-11-10, verified 2026-11-10)

### Implemented (decisions by the product owner)

- **Cancel:** records every prepared (consumed) portion not yet wasted as waste, reason
  `cancelled_prepared_order`, in the cancel's transaction. The manager can lower the counts.
- **Refund:** by reason. `quality` and `order_error` default to all remaining portions; other reasons
  to none; staff can adjust.
- **Adjusting:** a `waste` list in the request is the whole answer. `preparedVersion` from the new
  `GET …/orders/:id/prepared-items` gets 409 `PREPARED_ITEMS_CHANGED` if the kitchen prepared or
  wasted more since. Food not yet consumed is released, not wasted.
- **Costing:** waste of consumed food takes its share of the line's consumption value (remakes
  included), and the last portion takes the remainder, so a fully wasted line's COGS nets to exactly
  zero. This resolves R-032 and R-024; ADR-0011, ADR-0014 and ADR-0016 are updated.
- **Screens:** the expo cancel button opens a panel with the reason and prefilled counts (it used to be
  a browser prompt). The refund form shows the same counts.

### Independent review and testing (subagents)

Review findings fixed:

1. A cancel chosen from a stale prepared list silently left out food cooked meanwhile. Fixed with
   `preparedVersion`, and the list now refreshes on live events.
2. The refund form could refund twice after a lost response, because the body changed and the key
   rotated. The body is now frozen with its key, and the key is not rotated on key-reuse errors.
3. After a rejected remake, the default cancel or refund failed with 422 (capped by the line quantity).
4. Waste was costed at today's standard cost, leaving COGS non-zero after a cost change.
5. The hint suggested lowering counts for food passed to another order, which deducts stock twice. It
   now advises recording it (R-034).
6. Stale counts after a refund; the cancel audit now names the waste it created.

The adversarial tester ran 22 scenarios across meals consumed at three points, races (cancel against
waste, refunds and task changes), remakes, approval thresholds, idempotency, cost changes and access.
20 held. It found **2 defects**, both fixed: a remade portion was reclassified at the first portion's
cost, and partial wastes left rounding cents in COGS. Both now net to exactly zero.

### Findings

- My first auto-waste version broke four older tests, which recorded cancelled food by hand. They now
  cancel with a zero count for that line, which also exercises manual entry. Three more pinned the old
  costing (ADR-0016 used to accept a COGS residue); they now assert it nets exactly.
- The API first treated a waste list as overriding only the lines it named, so an empty list could not
  mean "none". A given list is now the whole answer.
- Mutation checks:
  - Killed: costing at today's standard cost, capping consumed lines by line quantity, accepting a
    stale list, no remainder for the last portion, and remakes left out of consumed value.
  - Also killed, on a clean rerun: "rejected waste counted as wasted". Its first run had broken the
    file and proved nothing. All 6 are now killed.
- Docker Desktop stopped during the first final run. The full suite, E2E and the build were rerun
  once it was back.

### Tests executed

| Suite                                 | Result                                  |
| ------------------------------------- | --------------------------------------- |
| `@kitchos/domain`                     | 54/54 passed (no domain change since)   |
| `@kitchos/api` full suite, final code | 387/387 passed (×2, shuffled; 24 files) |
| Playwright (12 journeys, 1 new)       | 12/12 passed                            |
| ESLint / Prettier / tsc               | clean on the final code                 |
| `next build`                          | succeeded                               |

### Not done

- R-035: a small partial refund for quality wastes every portion by default; awaiting a product
  decision (full refunds only?).
- R-034: no transfer of prepared food between orders.

## Milestone 13: Reconciliation per tender and per entry (2026-11-10)

### Implemented

- Reconciliation, and therefore business-day close, now also requires, for the day:
  - card payments less card refunds = net change in Card clearing from receipts and refunds;
  - cash taken less cash refunded, with rounding = net change in Cash on hand from them;
  - cash rounding on payments less refunds = the journal's Cash rounding from them;
  - every receipt and refund entry belongs to exactly one payment or refund of that amount and day.
    Entries moved late from a closed day are matched against the day they came from.
- Books shows the new rows. No schema change. Resolves R-030 (ADR-0017 updated).

### Independent review and testing (subagents)

- The reviewer found no case where a correct day fails to reconcile, so nothing newly blocks day close.
  Each item is dated the same way on both sides: payments by capture, refunds by creation, including
  across the cutoff. A refund always uses its payment's tender.
- The adversarial tester could not make an honest day fail either. It tried two trading days with three
  drawers, rounding both ways, discounts, a comp, declined cards, cancellations, refunds a cent at a
  time, cutoff edges and late entries. It found **three corrupted journals that still reconciled**, all
  now caught:
  1. cash rounding posted to the wrong account;
  2. a missing receipt offset by a duplicate one of the same tender;
  3. a stray receipt moved late from a closed day, which no day checked.
- From the review: tests now pin that late receipts and refunds stay out of today's totals, assert every
  field in the per-tender cases, and no longer claim more than they check.

### Findings

- My first per-tender test swapped money between card and cash, which trips both checks, so removing
  either check survived. One test per check now changes only that check's figure.
- My first refund test asserted a non-zero cash net, which a full cash refund correctly makes zero. It
  failed on unchanged code, which made a round of mutation results meaningless, so they were rerun.
- A "payment without a receipt" count was removed as redundant. Hiding a missing receipt needs an orphan
  entry or a wrong amount, both counted, and the totals catch it otherwise; no test could fail without it.
- Mutation checks: 12 mutants, all killed (after adding isolating tests for 6 that first survived).

### Tests executed

| Suite                                | Result                                  |
| ------------------------------------ | --------------------------------------- |
| `@kitchos/domain`                    | 54/54 passed                            |
| `@kitchos/api` integration           | 354/354 passed (×2, shuffled; 22 files) |
| Playwright (11 journeys)             | 11/11 passed                            |
| ESLint / Prettier / tsc (5 packages) | clean                                   |
| `next build`                         | succeeded                               |

### Not done

- R-028: who may see live cash figures while their own till is open (journal, trial balance). This is a
  permission policy decision, left open.
- Source matching for drawer entries (R-033).

## Milestone 12: Food cost and gross profit report (2026-11-10)

### Implemented

- `GET /v1/restaurants/:id/reports/food-cost?from&to` (`reports.view`, up to 92 days). Per business
  day, and in total: net sales, cost of food produced (COGS), waste, stock count shortfall, actual food
  cost, gross profit, and their shares of net sales. Each day says whether it is closed.
- Figures come from the journal by business day, so they agree with day close, including entries
  moved late from a closed day. Totals are summed, not averaged.
- Domain `foodCost`: exact integers, shares in basis points rounded half away from zero, no share
  without positive sales. Property-tested.
- Food cost screen (`/reports/:id`) with date range, closed/open day badges, and a note on what each
  figure includes. No schema change. Decision D-022.

### Independent review and testing (subagents)

The adversarial tester found **no calculation defects**. 41 scenarios, each checked against source rows
rather than the journal, all held. They covered:

- a realistic day: card and cash sales with rounding, a discount, a comp, a meal, a refund, cancel after
  preparation, waste reclassification, a remake, raw waste and its rejection, and counts both ways;
- refund-only and waste-only days;
- half-basis-point boundaries, a late entry from a closed day, Sydney DST days and the 92-day limit;
- every role, other restaurants and tenants, and RLS.

Both found that some labels promised more than the figures mean. Fixed:

1. "Recipe cost" was COGS, which also holds food later cancelled, comped or refunded, dated by when it
   was made. Now "Cost of food produced" (`cogsBps`, not `theoreticalFoodCostBps`), with the screen
   saying so.
2. "Gross margin" was a cents amount; now `grossProfitCents`, plus a real `grossMarginBps`.
3. "Count variance" is now "Count shortfall", noting that negative means a count found more.
4. Rounding is documented as half away from zero, which is what it does.
5. Days are built from integer offsets, so no session time zone can shift a date.
6. Tests: the "summed, not averaged" test now uses two days with different ratios (it could not fail
   before). The E2E now compares with sign and the same formatting, after a reload, because the dev
   API posts in the background. The table gained a caption, column and row headers, and a client-side
   range check.

Accepted, not fixed: R-031 and R-032.

### Findings

- My first fixture for the totals test credited Inventory with no stock movement. The global "Inventory
  = stock ledger" test caught it in the full suite. It now balances against Card clearing.
- Mutation checks: 6 mutants, all killed. They covered returns left out of sales, count shortfall left
  out of actual cost, a share of zero sales, late entries left out, and totals averaged.

### Tests executed

| Suite                                | Result                                  |
| ------------------------------------ | --------------------------------------- |
| `@kitchos/domain`                    | 54/54 passed                            |
| `@kitchos/api` integration           | 325/325 passed (×2, shuffled; 21 files) |
| Playwright (11 journeys)             | 11/11 passed (1 new)                    |
| ESLint / Prettier / tsc (5 packages) | clean                                   |
| `next build`                         | succeeded                               |

### Not done

- Theoretical (recipe) cost of what was sold, from the order lines of completed orders net of returns,
  with unsold production shown separately.
- Discounts and comps as their own column; per-item or per-category breakdown; export.

## Milestone 11: Business-day close and drawer admin (2026-11-03, verified 2026-11-10)

### Implemented

- Migration `0010_business_day_close`: append-only `business_day_closes`, a trigger moving entries
  dated to a closed day to the first open day (`journal_entries.posted_late_from`), a per-day advisory
  lock serialising posting and closing, and drawer admin grants.
- API: `GET/POST /v1/restaurants/:id/days/:date[/close]`, `accounting/failed-events` with retry,
  `cash/drawers` add, list all, retire and reactivate. New permissions `day.close` and `cash.admin`.
- Reconciliation is now its own service, also compares drawer variance to Cash over/short, and
  counts drawer events against the day they post to. Resolves R-017.
- UI: Day close screen (blockers, warnings, totals, drawers, failed postings), Manage drawers panel.
- ADR-0017.

### Independent review and testing (subagents)

Both found the same high-severity design defect in the first version, and the tester reproduced it:

1. **A close could strand a drawer's entries.** A till counted after the cutoff posts to the day it
   opened, but the backlog check went by when the event occurred, so that day could close first. Both
   entries dead-lettered, cash on hand stayed at 11,100 instead of 0, and the next day could never
   close. Events are now counted against the day they post to.

Also fixed:

2. Events reaching a closed day were lost as permanent dead letters; they now move to the first open
   day, flagged. A 5-minute settling window after the cutoff makes this rare.
3. Dead letters had no recovery (R-017): now an audited retry, listed on the close page.
4. A manager running a till could derive its blind expected cash from the day's totals. They are now
   withheld from that person. The journal and trial balance still allow an estimate (R-028).
5. Snapshot cash figures left out rounding; added cash rounding and cash refunds.
6. Year 0000 returned 500; now 400.

Accepted as risks: R-027, R-028, R-029 and R-030 (R-030 resolved in Milestone 13).

### Findings

- The intermittent `reconciled: false` from Milestone 10 is explained. The test made one dispatcher
  pass, which handles one batch, so it failed whenever other files had left more events than that
  (`pendingEvents: 7`, no money difference). It now drains the queue. Not a ledger defect.
- Mutation checks, 11 mutants, all killed. On the first pass 4 survived, because the late-entry
  fallback hid a wrong backlog, so direct tests were added. One rerun printed no result during a
  low-memory stop; it was rerun on 2026-11-10 and killed.
- The E2E journeys and `next build` were first held back by low memory and run on 2026-11-10.

### Tests executed

| Suite                                | Result                                                               |
| ------------------------------------ | -------------------------------------------------------------------- |
| `@kitchos/domain`                    | not rerun (no domain change since Milestone 10: 49/49)               |
| `@kitchos/api` integration           | 278/278 passed (×5: the 2 seeds that failed earlier, 3 new shuffles) |
| Playwright (10 journeys)             | 10/10 passed (2 new)                                                 |
| ESLint / Prettier / tsc (5 packages) | clean                                                                |
| `next build`                         | succeeded                                                            |

### Not done

- A separate shift close across drawers or people (a drawer session is one cashier's shift).
- Closing before the cutoff; reopening a closed day (corrections post on the day they are made).
- A list of days still unclosed.

## Milestone 10: Inventory and waste UI (2026-11-02)

### Implemented

- New Inventory & waste screen (`/inventory/:id`), with sections shown by permission and enforced by
  the API:
  - Record waste (crew and up): an ingredient, prepared food, or an item on an order including
    cancelled orders and meal components, with reason, station, notes and remake.
  - Waste log (`inventory.view`): pending queue and recent records, approve and reject
    (`waste.approve`), today's summary by reason, station and person (`reports.view`).
  - Stock levels and recent movements (`inventory.view`).
  - Receive goods and stock count (`inventory.adjust`). A blank count line means "not counted".
- API: `GET inventory/waste-items` (names only, for crew), `GET inventory/waste/mine`, and
  `recordedById` on the waste view. No schema change.
- Quantities stay decimal strings or exact milli-units in the UI. Idempotency keys survive network
  and 5xx failures and rotate on a definitive answer or a changed body.

### Independent review and testing (subagents)

The reviewer and the adversarial tester independently found the same high-severity defect. It
predates the UI, which made it easy to reach:

1. **Waste of an order line was capped per request, not cumulatively, with no lock.** Crew could
   waste a consumed burger repeatedly: three times left that line's COGS at -408c and waste at 612c
   on 204c consumed, and the day still showed Reconciled. On an unconsumed line it removed real
   stock. Now capped cumulatively under the order lock (ADR-0011).

Also fixed:

2. Food cooked for a cancelled order could only be recorded as "Prepared food", deducting its
   ingredients twice, because the picker hid cancelled and older orders. The picker now includes
   them, and the prepared-food form warns about this.
3. Crew could wedge stock screens for a whole restaurant: ten huge wastes pushed a balance past the
   safe-integer range, so balances and counts returned 500. Movements taking a balance beyond
   8 × 10^12 units now get 422; ones bringing it back are allowed. The same check turns the numeric
   overflow 500 on receipts into a 422.
4. Pending approvals could drop off the queue behind 100 newer records (now their own query).
5. `remake` was stored true when no fresh portion was consumed.
6. Goods receipts had no audit entry.
7. An edit after a lost response could duplicate a record; the forms now warn when the outcome is
   unknown.
8. Smaller: the order mode showed an empty list without `orders.view`, failed picker queries looked
   empty, and a line with no ingredients is now refused with a 422.

Accepted and recorded as risks rather than fixed: R-024 (rounding when a line is wasted in parts,
pinned by a test), R-025 (crew see waste costs), R-026 (waste then normal consumption).

### Findings

- My first balance limit (10^12 units) broke an existing huge-receipt test, which caught it. It is
  now 8 × 10^12.
- In that same run, `redelivery posts nothing twice` reported `reconciled: false`. Explained in
  Milestone 11: a test that made one dispatcher pass, not a ledger defect.
- Mutation checks on the cap (3 mutants): removing the cap and counting rejected records were both
  killed. Removing the order lock **survived** the parallel race test, so a deterministic test now
  holds the order's row lock and asserts waste waits; that mutant is now killed.
- ESLint scanned the generated `playwright-report/`; it is now ignored.

### Tests executed

| Suite                                | Result                                  |
| ------------------------------------ | --------------------------------------- |
| `@kitchos/domain`                    | 49/49 passed                            |
| `@kitchos/api` integration           | 207/207 passed (×2, shuffled; 17 files) |
| Playwright (8 journeys)              | 8/8 passed                              |
| ESLint / Prettier / tsc (5 packages) | clean                                   |
| `next build`                         | succeeded                               |

### Not done

- Remake does not send a new ticket to the kitchen; it only records stock (the UI says so).
- Cancel-after-preparation does not record its waste automatically (done in Milestone 14).
- The waste summary shows today only. No search beyond the newest 100 orders in the order picker.
- No supplier unit cost on the receipt form (stored by the API but not posted, R-022).
- No Playwright coverage of remake, or of approving (as opposed to rejecting) waste.

## Milestone 9: Inventory valuation in the journal (2026-11-02)

### Implemented

- Migration `0009_inventory_valuation`:
  - `stock_movements.unit_cost` and `value_cents`, set only by a `BEFORE INSERT` trigger. Corrections
    that reverse a movement copy its cost.
  - Inventory journal entry types.
  - Accounts: Goods received not invoiced (2300), Opening balance equity (3000), Stock count
    variance (5200).
  - Cutover: earlier events of the newly consumed types are marked handled by the ledger.
- Domain: consumption, waste, waste reversal, receipt and count postings, with property tests.
- API: `InventoryValuationPoster` posts each stock operation from the event its own transaction
  emitted, using the recorded movement values. Covers COGS, waste (reclassification and remakes),
  waste reversal, goods receipts, count variance and opening stock.
- Reconciliation: each business day, Σ valued stock movements must equal the journal's net change
  in Inventory. This is part of `reconciled`.
- Seed: opening stock is posted to the journal.
- UI: Books labels the new entry types and shows the inventory reconciliation row.
- ADR-0016; adds R-022 and R-023.

### Independent review and testing

Defects found and fixed, each with a regression test:

1. A rejected waste record's correction used today's standard cost, leaving residue in Waste
   expense after a cost change. Corrections now use the original movement's cost.
2. Waste of a line consumed before valuation existed would credit COGS that was never debited. Such
   records now stay out of the journal.
3. The valuation trigger could be pointed at a forged cost table through a `TEMP` table (`pg_temp` is
   searched first). `search_path` is now pinned.
4. A reclassification-only waste reversal was dated by the dispatcher's clock, so a backlog across
   midnight put it on the wrong business day. It now uses the day the rejection was decided.

### Findings

- A valuation test asserted no failed events across the whole database, so it failed whenever
  `accounting.test.ts` (which dead-letters a poison event in another tenant) ran first. It now checks
  that the waste record's own event was claimed and did not fail.
- Mutation check of fix 4: dating the reversal with `now()` fails its regression test.

### Tests executed

| Suite                                | Result                                  |
| ------------------------------------ | --------------------------------------- |
| `@kitchos/domain`                    | 49/49 passed                            |
| `@kitchos/api` integration           | 169/169 passed (×2, shuffled; 16 files) |
| Playwright (6 journeys)              | 6/6 passed                              |
| ESLint / Prettier / tsc (5 packages) | clean                                   |
| `next build`                         | succeeded                               |

### Not done

- No Playwright journey exercises the new inventory postings or the reconciliation row with stock
  activity beyond the existing sales journeys.
- Purchase price variance and supplier invoices (R-022), moving-average or FIFO costing, food cost
  and gross margin report, inventory and waste UI.

## Milestone 8: Cash drawers, till sessions and blind counts (2026-10-30)

### Implemented

- Migration `0008_cash_drawers`:
  - Tables `cash_drawers`, `drawer_sessions` (count snapshot, approval, version) and append-only
    `drawer_movements`.
  - `payments`/`refunds.drawer_session_id`.
  - Partial unique indexes: one active session per drawer and per person.
  - Trigger `app.require_open_drawer_session`: cash needs an open session in the same restaurant.
  - `restaurants.cash_variance_threshold_cents` (default 500).
  - Drawer journal entry types.
  - Accounts: Cash in safe (1020), Cash over/short (6100), Petty cash (6200).
  - RLS and least-privilege grants.
  - Seeded drawers: 4 per demo restaurant (Express 2, Rival 1).
- Domain: `expectedDrawerCash`, plus float, movement and close postings. A property test checks
  that cash on hand nets to zero.
- API under `/v1/restaurants/:id/cash`:
  - Drawers: list, open.
  - Sessions: list (defaults to today's business date, plus anything still open or pending), get.
  - Movements and blind count (both idempotent), and variance approval.
  - New permissions: `cash.drawer` (crew) and `cash.manage` (supervisor and up).
- Cash payments and cash refunds now go through the actor's own open drawer session.
- The ledger consumer posts `drawer.opened`, `drawer.movement_recorded` and `drawer.closed`.
- UI:
  - POS drawer panel: open with a float, safe drop, paid in, paid out (managers), blind count and
    close. Cash is disabled without an open drawer.
  - New Cash drawers page (`/cash/:id`): expected, counted and variance per session, and variance
    approval.
  - Books labels the new entry types.
- ADR-0015; resolves R-012.

### Independent review and testing (subagents)

The reviewer and the adversarial tester found the same three defects, and the tester reproduced
them. All are fixed, with regression tests:

1. One person could open two drawers concurrently. Now a unique index, mapped to 409
   `ALREADY_HAVE_DRAWER`.
2. Replaying a manager's movement key returned the manager's view, including expected cash, to a
   blind cashier. Replays are now re-rendered for the caller.
3. Two concurrent cash refunds through one drawer both passed the available-cash check (FOR SHARE
   lock), and expected cash went to −880c. Refunds now lock the session FOR UPDATE.

Also fixed from the review:

- The `NOT VALID` cash ⇒ session CHECKs would have blocked refunds of pre-drawer cash payments
  (Postgres re-checks on UPDATE). Replaced by the INSERT trigger, with a regression test.
- The safe-drop 422 let a blind cashier binary-search expected cash. The check now applies only to
  actors who can see expected cash.
- A supervisor saw expected cash on their own till and could approve a variance on their own
  drawer when someone else counted it. Now their own till is blind, and the approver must be
  neither the cashier nor the counter (service and CHECK).

A mutation check showed that removing the payment's FOR SHARE lock went unnoticed by the
concurrent race test. A deterministic test now holds the count's row lock while a payment is in
flight.

The adversarial suite holds, 24 scenarios in all:

- Opens racing for the same drawer, and concurrent safe drops; exactly the affordable ones
  succeed.
- Idempotency abuse, and count replay after close.
- Racing counts and racing approvals, with exactly one close event and one journal entry.
- Threshold boundaries; blind-count leak checks on every endpoint.
- Cross-restaurant and cross-tenant session ids; RLS for the runtime role.
- Business-date listing; journal and trial-balance integrity.

### Tests executed

| Suite                                | Result                                                    |
| ------------------------------------ | --------------------------------------------------------- |
| `@kitchos/domain`                    | 43/43 passed                                              |
| `@kitchos/api` integration           | 141/141 passed (×2, shuffled; 14 files)                   |
| Mutation checks (cash drawer rules)  | 11 mutants, 10 killed; 1 survivor (409 code on open race) |
| Playwright (6 journeys)              | 6/6 passed                                                |
| ESLint / Prettier / tsc (5 packages) | clean                                                     |
| `next build`                         | succeeded                                                 |

The surviving mutant only changes which 409 code the loser of a same-person open race receives.
The invariant itself is covered deterministically at the database level.

### Not done

- No drawer admin API (drawers are seeded).
- Cash per business date does not net to zero for sessions that cross midnight (ADR-0015).
- Shift and business-day close, COGS/waste postings, split tender, gift cards.

## Milestone 7: Refunds and payment reversal (2026-10-27)

### Implemented

- Migration `0007_refunds`: `payments.refunded_cents` (CHECK ≤ amount), append-only `refunds`
  (method, amount, refunded-before, cash rounding, treatment, reason), `refund` journal entry
  type, Sales returns account (4200) in the default chart.
- Domain: `refundPostings` (deposit release vs sales return) and `refundGstShare` (cumulative, so
  partial refunds return exactly the order GST at full refund), property-tested.
- API: `POST /v1/restaurants/:id/orders/:orderId/refunds` (`payments.refund`, supervisor and up;
  idempotent; completed or cancelled orders only; order then payment locked; payment state
  machine; audit; `payment.refunded` event). Ledger consumer posts refunds; reconciliation now
  includes refunds. Order view lists refunds and the refunded amount.
- Orders & refunds screen; Playwright journey refunds part of a handed-over order and checks the
  books still reconcile.
- DB pool hardening: TCP keepalive and a pooled-connection timeout; keepalive on the LISTEN
  connection.
- ADR-0014; resolves R-016.

### Independent review and testing (subagents)

- **Both** the reviewer and the adversarial tester found the same defect, and the tester proved
  it: partial cash refunds were rounded independently, so 3c + 3c + 784c on a 790c cash payment
  handed back 795c. Fixed by recording `refunded_before_cents` under the payment lock and
  computing cash back cumulatively, capped at the cash actually taken (full refund returns
  exactly that); regression test kept and mutation-checked.
- Also fixed from the review: full cash refunds depended on the current rounding increment; GST
  ordering relied on uuidv7 time order (now uses the recorded refunded-before amount); the new
  client-side `query_timeout` would have returned dead sockets to the pool (removed; keepalive
  instead); the UI sent a possibly stale default amount.
- Adversarial suite (10 scenarios) otherwise held: 8 concurrent partial refunds, refunds racing
  handoff and cancel, idempotency abuse, discounted cash orders, comp orders, cross-tenant and
  permission checks, no stock effect, books reconcile.

### Findings

- An E2E run stalled for about an hour (environmental: the host paused); the rerun passed in
  31 s. It prompted the pool keepalive change. The screenshot from that run also exposed a
  vacuous E2E assertion (it matched a refund from an earlier run), now scoped to the refunded
  order's card.
- File shuffling exposed one more cross-file dependency (a global dead-letter count), now
  scoped to the restaurant under test.

### Tests executed

| Suite                                | Result                        |
| ------------------------------------ | ----------------------------- |
| `@kitchos/domain`                    | 40/40 passed                  |
| `@kitchos/api` integration           | 104/104 passed (×3, shuffled) |
| Playwright (5 journeys)              | 5/5 passed                    |
| ESLint / Prettier / tsc (5 packages) | clean                         |
| `next build`                         | succeeded                     |

### Not done

Refund approval for crew (R-018), line-level returns for mixed GST orders (R-019), split tender,
gift cards, till sessions, COGS/waste postings.

## Milestone 6: Double-entry journal fed by the event dispatcher (2026-10-27)

### Implemented

- Migration `0006_ledger`: per-tenant chart of accounts (stable system keys, default chart via
  `app.create_default_chart`), accounting periods, append-only `journal_entries` / `journal_lines`
  with a deferred constraint trigger that rejects unbalanced entries, a closed-period trigger,
  lines insertable only by the transaction that created their entry, one entry per
  (source, entry type); `event_consumer_failures`; `app.orgs_with_pending_events` (definer
  function returning tenant ids only, PUBLIC execute revoked); dispatcher index.
- Domain: `paymentReceiptPostings`, `saleRecognitionPostings` (deposits before handover; revenue,
  discounts ex GST and GST at handover; cash rounding), property-tested to balance and net to
  total − GST.
- API: `EventDispatcher` (per tenant inside `withTenant`; each attempt holds the outbox row lock,
  re-checks backoff, claims + handles inside a savepoint, forces deferred checks, records failures
  in the same transaction; exponential backoff; dead letter after 5 attempts; per-tenant error
  isolation), `LedgerConsumer`, `LedgerService`; accounting endpoints for business date,
  journal, trial balance and reconciliation.
- Books screen with reconciliation status, day-activity trial balance and journal; Playwright
  check that a real sale appears balanced and reconciled.
- ADR-0013 (resolves R-004).

### Independent review and testing (subagents)

- **Adversarial testing** (`accounting-adversarial.test.ts`, 11 scenarios incl. two app
  instances dispatching concurrently, replay storms, rounding, comps, cancel-after-payment,
  closed periods, tenant joins): **no ledger defects found**.
- **Code review** found and I fixed: lines could be appended to an already-posted entry (even
  in a closed period); multiple replicas could burn retry attempts and dead-letter early because
  the failure was recorded after the lock was released (both testers flagged this); the
  reconciliation backlog ignored the selected day and double-counted dead letters; one tenant's
  error could abort the pass for all; the definer function was executable by PUBLIC; no index for
  the dispatcher scan; inactive accounts with postings would drop out of the trial balance.
- Fixing the dispatcher surfaced a missing DELETE grant (clearing failure rows on success); the
  failure path recorded it correctly, which is how it was found.

### Tests executed

| Suite                                | Result                      |
| ------------------------------------ | --------------------------- |
| `@kitchos/domain`                    | 35/35 passed                |
| `@kitchos/api` integration           | 88/88 passed (×2, shuffled) |
| Playwright (4 journeys)              | 4/4 passed                  |
| ESLint / Prettier / tsc (5 packages) | clean                       |
| `next build`                         | succeeded                   |

### Not done

COGS/waste postings, refunds/reversals (deposits of cancelled paid orders remain: R-016), till
sessions, shift close, period-close UI, dead-letter requeue (R-017), external bus relay.
Migration 0006 was amended before ever being committed or deployed.

## Milestone 5: POS discounts and manager overrides (2026-10-27)

### Implemented

- Migration `0005_discounts_and_overrides`: per-restaurant self-approval limits, per-line
  `discount_cents`, append-only `order_discounts` (one per order), `manager_overrides` with hashed
  single-use secrets bound to restaurant, order, requester, expiry and the exact discount;
  approver ≠ requester enforced by CHECK; RLS and column-level grants.
- Domain: `applyDiscount` (percent/amount, largest-remainder allocation across lines, GST on the
  discounted taxable portion), `discountBasisPoints`, property-tested.
- API: `POST /v1/restaurants/:id/orders/:orderId/discount` (`discount.apply`) with the
  self-approval policy; `POST /v1/restaurants/:id/overrides` for terminal re-authentication;
  fully discounted orders are accepted straight to the kitchen; `order.discounted` event;
  audit for grants, denials and discounts. `CredentialThrottle` now shared by sign-in and
  overrides.
- POS UI: discount panel (percent/amount, reason), inline manager approval showing the amount,
  discount line on the ticket, comp completion screen.
- Permissions: `discount.apply` (crew and above), `discount.approve` (supervisor and above).
- ADR-0012.

### Independent review and testing (subagents)

Both the reviewer and the adversarial tester independently found the same **high-severity
defect**: an override was not bound to an amount, so a manager approving "15%" could be turned
into a 100% comp by the crew member (proved by a failing test). Fixed by binding the override
to the exact discount, computing and returning the approved amount at grant time, and auditing
it; regression tests kept and mutation-checked (removing the binding fails 2 tests).

Also fixed from their findings: the override endpoint added an extra password-guessing budget
and its per-account key included the (spoofable) client IP; successful checks counted towards
lockout; failed overrides were not audited; the discount panel generated a new idempotency key
per request (lost responses surfaced as errors), re-placed the ticket from a stale closure,
had a render-lagged double-submit guard and kept the approver's email in memory.

Not changed (recorded as risks): supervisors can comp without a second person (R-013);
account-level throttling enables temporary approver lockout (R-014).

### Tests executed

| Suite                                | Result                      |
| ------------------------------------ | --------------------------- |
| `@kitchos/domain`                    | 28/28 passed                |
| `@kitchos/api` integration           | 69/69 passed (×2, shuffled) |
| Playwright (3 journeys)              | 3/3 passed                  |
| ESLint / Prettier / tsc (5 packages) | clean                       |
| `next build`                         | succeeded                   |

### Notes

- Migration 0005 was amended before it was ever committed or deployed (local DB reset); applied,
  released migrations remain immutable.

## Milestone 4: POS core: staff order entry, cash tender, park / recall / void (2026-10-27)

### Implemented

- Migration `0004_pos_cash_payments`: per-restaurant `cash_rounding_increment_cents` (default 5c),
  payment `tendered_cents`, `change_cents`, `cash_rounding_cents`, `received_by`, with CHECK
  constraints enforcing `tendered = amount + rounding + change` for cash and no cash fields on
  card payments; method/provider consistency.
- Domain: `settleCash` / `cashPayableCents` (bigint, half-up to the increment, property-tested).
- API: `POST /v1/restaurants/:id/orders` (staff order entry, `orders.create`, attributed to the
  user, channel `pos` | `drive_thru`) and `POST …/orders/:orderId/payments` (cash or sandbox card,
  idempotent, restaurant-scoped). Public guest payments remain card-token only. Order view exposes
  `cashDueCents`; menu exposes the restaurant's cash rounding increment.
- POS UI (`/pos/:restaurantId`): touch product grid, modifier dialog, ticket, cash panel with
  cash-due display and quick tenders, change-due screen, sandbox card, park / recall / void.
- CI: new Playwright job running both journeys against a migrated, seeded PostgreSQL service.

### Independent review and testing (subagents)

- **Code review**: no critical/high defects; confirmed DB constraints, tenant scope, public-cash
  block and double-capture protection. Fixed its medium findings: the POS now keeps the payment
  idempotency key on network/5xx errors and, on `ORDER_NOT_AWAITING_PAYMENT`, refetches the order
  and shows the completed sale instead of inviting a second tender; the POS shows the rounded
  cash due and bases quick tenders on it. Also fixed: stale cash state on recall, Enter-key
  double submit guard, float-free tender formatting.
- **Adversarial testing** (`test/pos-adversarial.test.ts`, 12 scenarios): found a genuine defect:
  replaying a staff payment's idempotency key through **another restaurant's route** returned that
  restaurant's order (200) because the replay happened before the restaurant check. Fixed by
  scoping payment keys per surface and restaurant; the test is kept as a regression and
  mutation-checked (reverting the scope makes it fail).

### Tests executed

| Suite                                | Result                      |
| ------------------------------------ | --------------------------- |
| `@kitchos/domain`                    | 23/23 passed                |
| `@kitchos/api` integration           | 49/49 passed (×4, shuffled) |
| Playwright (customer journey, POS)   | 2/2 passed                  |
| ESLint / Prettier / tsc (5 packages) | clean                       |
| `next build`                         | succeeded                   |

### Findings

- File shuffling exposed another cross-file dependency (a count zeroed Central's coffee beans,
  now used by POS tests); the count test now restores stock after asserting.

### Not done (still open in this phase)

Discounts, coupons, manager overrides, staff/comp meals, receipt printing, refunds (need the
journal), till/drawer sessions, drive-thru order recall on the POS (list filters `pos`).

## Milestone 3: Waste, receiving and counts without double deduction (2026-10-26)

### Implemented

- Migration `0003_inventory_operations`: `waste_prepared` movement type, standard unit costs,
  per-restaurant approval thresholds, `waste_records` + append-only `waste_record_lines`
  (treatment per ingredient), append-only goods receipts and stock counts; RLS and
  least-privilege grants (only review columns of a waste record are updatable).
- `InventoryService.recordMovements`: the single locked, idempotent path for all ledger writes
  (consumption refactored onto it with no behaviour change: 21/21 still passing).
- Waste API: raw and prepared waste, order-line-linked waste using the immutable ingredient
  snapshot, remakes, overproduction waste from the pinned recipe, approval/rejection with
  segregation of duties and compensating corrections, list and summary (reason/station/
  employee, reclassified vs direct cost).
- Goods receipts (with lot/expiry capture) and physical counts (variance vs locked on-hand,
  approval above threshold).
- Domain: exact standard-cost valuation (`extendedCostCents`, bigint arithmetic, property test).
- ADR-0011.

### Tests executed

| Suite                                | Result                      |
| ------------------------------------ | --------------------------- |
| `@kitchos/domain`                    | 18/18 passed                |
| `@kitchos/api` integration           | 31/31 passed (×2, shuffled) |
| ESLint / Prettier / tsc (5 packages) | clean                       |

Mutation check: forcing prepared waste to always deduct makes 3 waste tests fail (invariant 12
test, remake test, summary split).

### Findings

- Integration tests had a hidden cross-file dependency (a count zeroed patties used by other
  files); exposed when Vitest reordered files. Fixed, and file order is now shuffled every run.
- A mutation edit using `//` silently broke compilation and reported "no tests", a reminder to
  confirm a mutation run actually executes tests before trusting it.

### Next

Inventory/waste UI for managers and crew; POS; outbox relay + journal postings.

## Milestone 2: Customer, kitchen, expo and pickup UI on the live API (2026-10-26)

### Implemented

- `apps/web` (Next.js 16, React 19, Tailwind 4, TanStack Query): restaurant picker; customer
  ordering with search, categories, allergen/energy info, modifier and meal customisation,
  cart, sandbox checkout and live order tracking with declined-payment retry; staff sign-in and
  workspace picker filtered by permissions; kitchen display per station with ageing timers,
  modifier call-outs, recipe notes, optimistic-concurrency commands, SSE live updates with
  polling fallback and a connection indicator; expo/handoff board; public pickup board.
- Playwright journey test driving the real UI end to end.

### Tests executed

| Suite                                  | Result       |
| -------------------------------------- | ------------ |
| `@kitchos/domain` unit + property      | 15/15 passed |
| `@kitchos/api` integration (PG 18)     | 21/21 passed |
| Playwright E2E (Chromium, local stack) | 1/1 passed   |
| ESLint / Prettier / tsc (5 packages)   | clean        |
| `next build` (production)              | succeeded    |

### Findings

- Port 3000 on the development machine is held by an unrelated Docker container; the web app
  now runs on **3100** (API CORS default updated).
- An early version of the E2E test passed vacuously: `getByText('Collected')` matched the
  progress-step label rather than the order status. Assertions now target the status element
  (`data-testid="order-status"`) and were re-verified.

### Remaining gaps

E2E not yet in CI; no POS; staff session in `sessionStorage` (device identity pending);
kitchen ageing thresholds are display constants, not per-restaurant configuration.

## Milestone 1: Foundation + first verified vertical slice (2026-10-26)

### Implemented

- Monorepo (pnpm/Turborepo, strict TypeScript 5.9, ESLint, Prettier), Docker Compose with
  PostgreSQL 18 and Redis 8, GitHub Actions CI (lint, format, typecheck, unit, integration,
  schema-drift, audit).
- Schema `0001_foundation` + `0002_runtime_grants`: tenancy hierarchy, identity, catalog with
  versioned menus/recipes, append-only stock ledger + trigger-maintained balances, reservations,
  orders/lines/modifiers/ingredient snapshots, payments, kitchen tasks, outbox with store
  sequences + NOTIFY, inbox, idempotency keys, audit log; RLS on all tenant tables; immutability
  and append-only triggers; least-privilege runtime role.
- Domain package: integer money with exact rounding, quantities, state machines (order, payment,
  kitchen task), server-side pricing with modifiers/combos/GST, recipe explosion.
- API (NestJS 12, ESM): staff login + scoped permissions; public menu; idempotent guest order
  placement with stock reservation; sandbox card payment; acceptance → station routing → kitchen
  tasks; start/complete with configurable consumption point and exactly-once ledger entries;
  ready/handoff; cancellation with manager rule after production; inventory balance/movement
  queries; SSE live events; health, readiness, Prometheus metrics, structured logs.
- Seed: KitchOS Central, Drive and Express with distinct menus, prices, stations, stock, staff,
  shortage policies; plus an isolation-test tenant (Rival Foods).

### Tests executed (local, Windows 11, Docker Desktop, Node 24.22)

| Suite                                   | Result       |
| --------------------------------------- | ------------ |
| `@kitchos/domain` unit + property tests | 15/15 passed |
| `@kitchos/api` integration (PG 18)      | 21/21 passed |
| ESLint / Prettier / tsc (4 packages)    | clean        |

Mutation check: removing the balance-row `FOR UPDATE` in `reserve()` makes the dedicated
concurrency test fail (6/6 reservations succeed against 2 units), so the test has teeth.

### Findings

- Order placement is already serialised per store by the order-number counter row lock; the
  balance row lock is still required for paths without a counter (consumption, future waste and
  transfers). Recorded as R-001.

### Remaining defects / gaps

See `RISKS.md` and `FEATURE_MATRIX.md`. Notably: no outbox relay, no MFA/OIDC, no offline edge,
UI in progress, no POS yet.

### Next work items

See "Immediate next tasks" in `IMPLEMENTATION_PLAN.md`.
