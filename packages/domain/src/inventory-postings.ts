import { DomainError } from './errors.ts';
import { assertCents, cents } from './money.ts';
import { assertBalanced, type Posting, type SystemAccount } from './postings.ts';

/**
 * Journal postings for inventory valuation (ADR-0016). Every amount is a
 * signed sum of stock-movement values in cents: negative when stock left the
 * shelf, positive when it came in. The Inventory account always moves by
 * exactly that sum, so the journal reconciles to the stock ledger.
 */

interface Leg {
  account: SystemAccount;
  /** Signed: positive = debit, negative = credit. */
  amount: number;
  memo: string;
}

/** Merges legs per account (first memo wins), drops zeros, and checks balance. */
function toPostings(legs: Leg[]): Posting[] {
  const byAccount = new Map<SystemAccount, Leg>();
  for (const l of legs) {
    assertCents(l.amount);
    const seen = byAccount.get(l.account);
    if (seen) seen.amount += l.amount;
    else byAccount.set(l.account, { ...l });
  }
  const out: Posting[] = [...byAccount.values()]
    .filter((l) => l.amount !== 0)
    .map((l) => ({
      account: l.account,
      debitCents: cents(l.amount > 0 ? l.amount : 0),
      creditCents: cents(l.amount < 0 ? -l.amount : 0),
      memo: l.memo,
    }));
  if (out.length === 0) return [];
  assertBalanced(out);
  return out;
}

/** Inventory moves by `inventoryDelta`; the opposite amount goes to `offset`. */
const moved = (inventoryDelta: number, offset: SystemAccount, memo: string): Leg[] => [
  { account: 'inventory', amount: inventoryDelta, memo },
  { account: offset, amount: -inventoryDelta, memo },
];

const nonPositive = (v: number, what: string) => {
  assertCents(v);
  if (v > 0) throw new DomainError('AMOUNT_OUT_OF_RANGE', `${what} cannot add stock`);
};
const nonNegative = (v: number, what: string) => {
  assertCents(v);
  if (v < 0) throw new DomainError('AMOUNT_OUT_OF_RANGE', `${what} cannot remove stock`);
};

/** Ingredients consumed in production: Dr COGS / Cr Inventory. */
export function consumptionPostings(inventoryDeltaCents: number): Posting[] {
  nonPositive(inventoryDeltaCents, 'Consumption');
  return toPostings(moved(inventoryDeltaCents, 'cogs', 'Ingredients consumed'));
}

/**
 * Stock received: Dr Inventory / Cr Goods received not invoiced (supplier
 * receipts) or Opening balance equity (opening stock). Valued at standard
 * cost; purchase price variance belongs to invoice matching (not built).
 */
export function receiptPostings(
  inventoryDeltaCents: number,
  source: 'supplier' | 'opening',
): Posting[] {
  nonNegative(inventoryDeltaCents, 'A receipt');
  return source === 'supplier'
    ? toPostings(moved(inventoryDeltaCents, 'goods_received_not_invoiced', 'Goods received'))
    : toPostings(moved(inventoryDeltaCents, 'opening_balance_equity', 'Opening stock'));
}

/** Physical count adjustments: shrinkage Dr Stock variance / Cr Inventory, a gain the reverse. */
export function countPostings(inventoryDeltaCents: number): Posting[] {
  assertCents(inventoryDeltaCents);
  return toPostings(moved(inventoryDeltaCents, 'stock_variance', 'Stock count adjustment'));
}

/**
 * A waste record (ADR-0011):
 * - stock deducted now (raw or not-yet-consumed prepared items):
 *   Dr Waste expense / Cr Inventory;
 * - waste of food already consumed into COGS is reclassified, not added:
 *   Dr Waste expense / Cr COGS;
 * - a remake consumes a fresh portion: Dr COGS / Cr Inventory.
 */
export function wastePostings(input: {
  deductedDeltaCents: number;
  reclassifiedCents: number;
  remakeDeltaCents: number;
}): Posting[] {
  nonPositive(input.deductedDeltaCents, 'Waste');
  nonPositive(input.remakeDeltaCents, 'A remake');
  nonNegative(input.reclassifiedCents, 'A reclassification');
  return toPostings([
    ...moved(input.deductedDeltaCents, 'waste_expense', 'Waste deducted from stock'),
    {
      account: 'waste_expense',
      amount: input.reclassifiedCents,
      memo: 'Waste deducted from stock',
    },
    { account: 'cogs', amount: -input.reclassifiedCents, memo: 'Reclassified to waste' },
    ...moved(input.remakeDeltaCents, 'cogs', 'Remake consumed'),
  ]);
}

/**
 * A rejected waste record is reversed: the restored stock goes back to
 * Inventory and the reclassification back to COGS. A remake is not reversed
 * (the replacement was physically made).
 */
export function wasteReversalPostings(input: {
  restoredDeltaCents: number;
  reclassifiedCents: number;
}): Posting[] {
  nonNegative(input.restoredDeltaCents, 'A waste reversal');
  nonNegative(input.reclassifiedCents, 'A reclassification');
  return toPostings([
    ...moved(input.restoredDeltaCents, 'waste_expense', 'Rejected waste reversed'),
    { account: 'cogs', amount: input.reclassifiedCents, memo: 'Reclassification reversed' },
    { account: 'waste_expense', amount: -input.reclassifiedCents, memo: 'Rejected waste reversed' },
  ]);
}
