import { DomainError } from './errors.ts';
import { assertCents, cents, type Cents } from './money.ts';
import { assertBalanced, type Posting } from './postings.ts';

/** Everything that moved cash in or out of one drawer session. All amounts are cash actually handled. */
export interface DrawerFacts {
  readonly openingFloatCents: number;
  /** Σ cash taken for sales (amount + cash rounding = tendered − change). */
  readonly cashSalesCents: number;
  /** Σ cash handed back for refunds (amount + cash rounding). */
  readonly cashRefundsCents: number;
  readonly paidInsCents: number;
  readonly paidOutsCents: number;
  readonly safeDropsCents: number;
}

/** Cash that should be in the drawer. */
export function expectedDrawerCash(f: DrawerFacts): Cents {
  const parts = [
    f.openingFloatCents,
    f.cashSalesCents,
    f.cashRefundsCents,
    f.paidInsCents,
    f.paidOutsCents,
    f.safeDropsCents,
  ];
  parts.forEach((p) => {
    assertCents(p);
    if (p < 0) throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Drawer amounts must not be negative');
  });
  return cents(
    f.openingFloatCents +
      f.cashSalesCents -
      f.cashRefundsCents +
      f.paidInsCents -
      f.paidOutsCents -
      f.safeDropsCents,
  );
}

const debit = (account: Posting['account'], amount: number, memo: string): Posting => ({
  account,
  debitCents: cents(amount),
  creditCents: cents(0),
  memo,
});
const credit = (account: Posting['account'], amount: number, memo: string): Posting => ({
  account,
  debitCents: cents(0),
  creditCents: cents(amount),
  memo,
});

/** Opening float moved from the safe into the drawer. Empty when the float is zero. */
export function drawerFloatPostings(floatCents: number): Posting[] {
  assertCents(floatCents);
  if (floatCents <= 0) return [];
  const p = [
    debit('cash_on_hand', floatCents, 'Opening float'),
    credit('cash_in_safe', floatCents, 'Float issued'),
  ];
  assertBalanced(p);
  return p;
}

/**
 *   paid_in:   cash added from the safe     Dr Cash on hand / Cr Cash in safe
 *   paid_out:  petty expense paid in cash   Dr Petty cash   / Cr Cash on hand
 *   safe_drop: cash moved to the safe       Dr Cash in safe / Cr Cash on hand
 */
export function drawerMovementPostings(
  kind: 'paid_in' | 'paid_out' | 'safe_drop',
  amountCents: number,
): Posting[] {
  assertCents(amountCents);
  if (amountCents <= 0) throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Amount must be positive');
  const p =
    kind === 'paid_in'
      ? [
          debit('cash_on_hand', amountCents, 'Paid in'),
          credit('cash_in_safe', amountCents, 'Paid in'),
        ]
      : kind === 'paid_out'
        ? [
            debit('petty_cash', amountCents, 'Paid out'),
            credit('cash_on_hand', amountCents, 'Paid out'),
          ]
        : [
            debit('cash_in_safe', amountCents, 'Safe drop'),
            credit('cash_on_hand', amountCents, 'Safe drop'),
          ];
  assertBalanced(p);
  return p;
}

/**
 * Closing a drawer: the counted cash goes to the safe and the difference from
 * the expected amount is cash over/short. Afterwards the drawer's cash-on-hand
 * balance for the session is exactly zero.
 *   Dr Cash in safe (counted) ± Cash over/short (variance) / Cr Cash on hand (expected)
 */
export function drawerClosePostings(countedCents: number, expectedCents: number): Posting[] {
  assertCents(countedCents);
  assertCents(expectedCents);
  if (countedCents < 0)
    throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Counted cash cannot be negative');
  const variance = countedCents - expectedCents;
  const lines: Posting[] = [];
  if (countedCents > 0) lines.push(debit('cash_in_safe', countedCents, 'Drawer counted to safe'));
  if (variance < 0) lines.push(debit('cash_over_short', -variance, 'Drawer short'));
  if (variance > 0) lines.push(credit('cash_over_short', variance, 'Drawer over'));
  if (expectedCents > 0) lines.push(credit('cash_on_hand', expectedCents, 'Drawer closed'));
  if (expectedCents < 0) lines.push(debit('cash_on_hand', -expectedCents, 'Drawer closed'));
  if (lines.length === 0) return [];
  assertBalanced(lines);
  return lines;
}
