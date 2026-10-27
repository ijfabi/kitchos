import { DomainError } from './errors.ts';
import { assertCents, cents, inclusiveTax, type Cents } from './money.ts';

/** Accounts referenced by posting rules (resolved per tenant via accounts.system_key). */
export type SystemAccount =
  | 'cash_on_hand'
  | 'card_clearing'
  | 'customer_deposits'
  | 'gst_payable'
  | 'sales_revenue'
  | 'sales_discounts'
  | 'cash_rounding';

export interface Posting {
  readonly account: SystemAccount;
  readonly debitCents: Cents;
  readonly creditCents: Cents;
  readonly memo: string;
}

const debit = (account: SystemAccount, amount: number, memo: string): Posting => ({
  account,
  debitCents: cents(amount),
  creditCents: cents(0),
  memo,
});
const credit = (account: SystemAccount, amount: number, memo: string): Posting => ({
  account,
  debitCents: cents(0),
  creditCents: cents(amount),
  memo,
});

/** Drops zero lines and turns negative amounts into the opposite side. */
function normalise(postings: Posting[]): Posting[] {
  return postings
    .map((p) => {
      const net = p.debitCents - p.creditCents;
      if (net === 0) return null;
      return net > 0 ? debit(p.account, net, p.memo) : credit(p.account, -net, p.memo);
    })
    .filter((p): p is Posting => p !== null);
}

export function assertBalanced(postings: readonly Posting[]): void {
  const d = postings.reduce((s, p) => s + p.debitCents, 0);
  const c = postings.reduce((s, p) => s + p.creditCents, 0);
  if (postings.length < 2 || d !== c || d === 0) {
    throw new DomainError(
      'UNBALANCED_JOURNAL',
      `Journal does not balance: debits ${d}, credits ${c}`,
      {
        debitCents: d,
        creditCents: c,
        lines: postings.length,
      },
    );
  }
}

export interface PaymentFacts {
  readonly method: 'cash' | 'card';
  /** Amount applied to the order (the order total at capture). */
  readonly amountCents: number;
  /** Cash only: payable − total (negative when rounded down). */
  readonly cashRoundingCents: number;
}

/**
 * Money received before the goods are handed over is a liability (customer
 * deposit), not revenue: collecting payment is not earning it.
 *   card: Dr Card clearing / Cr Customer deposits
 *   cash: Dr Cash on hand (amount + rounding) / Cr Customer deposits, ± Cash rounding
 */
export function paymentReceiptPostings(f: PaymentFacts): Posting[] {
  assertCents(f.amountCents);
  assertCents(f.cashRoundingCents);
  if (f.amountCents <= 0)
    throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Payment amount must be positive');
  const postings =
    f.method === 'card'
      ? [
          debit('card_clearing', f.amountCents, 'Card payment'),
          credit('customer_deposits', f.amountCents, 'Order paid'),
        ]
      : [
          debit('cash_on_hand', f.amountCents + f.cashRoundingCents, 'Cash received'),
          credit('customer_deposits', f.amountCents, 'Order paid'),
          credit('cash_rounding', f.cashRoundingCents, 'Cash rounding'),
        ];
  const result = normalise(postings);
  assertBalanced(result);
  return result;
}

export interface SaleFacts {
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly totalCents: number;
  /** GST in the (discounted) order total. */
  readonly taxCents: number;
  /** Sum of undiscounted taxable line totals (GST-inclusive). */
  readonly taxableSubtotalCents: number;
  readonly taxRateBasisPoints: number;
}

/**
 * Revenue is recognised when the order is handed over:
 *   Dr Customer deposits (total) + Dr Discounts allowed (discount ex GST)
 *   = Cr Sales revenue (gross ex GST) + Cr GST payable (GST on the discounted total)
 * where gross ex GST = subtotal − GST on the undiscounted taxable subtotal, and
 * discount ex GST = discount − (that gross GST − final GST). Net revenue is then
 * exactly total − GST, and discounts stay visible as contra-revenue.
 */
export function saleRecognitionPostings(f: SaleFacts): Posting[] {
  for (const v of [
    f.subtotalCents,
    f.discountCents,
    f.totalCents,
    f.taxCents,
    f.taxableSubtotalCents,
  ]) {
    assertCents(v);
    if (v < 0) throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Sale amounts must not be negative');
  }
  if (f.totalCents !== f.subtotalCents - f.discountCents) {
    throw new DomainError('UNBALANCED_JOURNAL', 'Order total must equal subtotal minus discount');
  }
  const grossTax = inclusiveTax(f.taxableSubtotalCents, f.taxRateBasisPoints);
  const grossExTax = f.subtotalCents - grossTax;
  const discountExTax = f.discountCents - (grossTax - f.taxCents);
  const result = normalise([
    debit('customer_deposits', f.totalCents, 'Order handed over'),
    debit('sales_discounts', discountExTax, 'Discount (ex GST)'),
    credit('sales_revenue', grossExTax, 'Sales (ex GST)'),
    credit('gst_payable', f.taxCents, 'GST collected'),
  ]);
  assertBalanced(result);
  return result;
}
