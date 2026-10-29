import { DomainError } from './errors.ts';
import { assertCents, cents, divRoundHalfUp, inclusiveTax, type Cents } from './money.ts';

/** Accounts referenced by posting rules (resolved per tenant via accounts.system_key). */
export type SystemAccount =
  | 'cash_on_hand'
  | 'card_clearing'
  | 'customer_deposits'
  | 'gst_payable'
  | 'sales_revenue'
  | 'sales_discounts'
  | 'sales_returns'
  | 'cash_rounding'
  | 'cash_in_safe'
  | 'cash_over_short'
  | 'petty_cash';

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

export interface RefundFacts {
  readonly method: 'cash' | 'card';
  readonly treatment: 'deposit_release' | 'sales_return';
  /** Amount refunded against the order in this refund. */
  readonly amountCents: number;
  /** Cash only: cash handed back − amount (rounding to the restaurant increment). */
  readonly cashRoundingCents: number;
  /** Order total and the GST it contains (for the sales-return GST share). */
  readonly orderTotalCents: number;
  readonly orderTaxCents: number;
  /** Amount already refunded on this order before this refund. */
  readonly previouslyRefundedCents: number;
}

/**
 * GST contained in a refund, computed cumulatively so that the shares of any
 * sequence of partial refunds sum to exactly the order's GST at full refund
 * and never exceed it.
 */
export function refundGstShare(
  f: Pick<
    RefundFacts,
    'amountCents' | 'orderTotalCents' | 'orderTaxCents' | 'previouslyRefundedCents'
  >,
): Cents {
  if (f.orderTotalCents <= 0) return cents(0);
  const share = (refunded: number) =>
    Number(divRoundHalfUp(BigInt(refunded) * BigInt(f.orderTaxCents), BigInt(f.orderTotalCents)));
  return cents(share(f.previouslyRefundedCents + f.amountCents) - share(f.previouslyRefundedCents));
}

/**
 * Refund postings. The money side mirrors the original receipt (card clearing,
 * or cash on hand with rounding). The other side depends on the treatment:
 *   deposit_release: Dr Customer deposits — the order was never earned;
 *   sales_return:    Dr Sales returns (ex GST) + Dr GST payable (its share).
 * Stock is never restored by a refund.
 */
export function refundPostings(f: RefundFacts): Posting[] {
  for (const v of [f.amountCents, f.orderTotalCents, f.orderTaxCents, f.previouslyRefundedCents]) {
    assertCents(v);
    if (v < 0) throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Refund amounts must not be negative');
  }
  assertCents(f.cashRoundingCents);
  if (f.amountCents <= 0) throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Refund must be positive');
  if (f.previouslyRefundedCents + f.amountCents > f.orderTotalCents) {
    throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Refunds cannot exceed the order total');
  }
  const money: Posting[] =
    f.method === 'card'
      ? [credit('card_clearing', f.amountCents, 'Card refund')]
      : [
          credit('cash_on_hand', f.amountCents + f.cashRoundingCents, 'Cash refunded'),
          debit('cash_rounding', f.cashRoundingCents, 'Cash rounding'),
        ];
  let other: Posting[];
  if (f.treatment === 'deposit_release') {
    other = [debit('customer_deposits', f.amountCents, 'Deposit returned')];
  } else {
    const gst = refundGstShare(f);
    other = [
      debit('sales_returns', f.amountCents - gst, 'Sales return (ex GST)'),
      debit('gst_payable', gst, 'GST on return'),
    ];
  }
  const result = normalise([...other, ...money]);
  assertBalanced(result);
  return result;
}
