import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyDiscount } from '../src/discount.ts';
import { inclusiveTax } from '../src/money.ts';
import { paymentReceiptPostings, saleRecognitionPostings, type Posting } from '../src/postings.ts';

const side = (ps: Posting[]) =>
  Object.fromEntries(ps.map((p) => [p.account, p.debitCents || -p.creditCents]));

describe('payment receipt postings', () => {
  it('card: deposit liability, not revenue', () => {
    expect(
      side(paymentReceiptPostings({ method: 'card', amountCents: 1390, cashRoundingCents: 0 })),
    ).toEqual({
      card_clearing: 1390,
      customer_deposits: -1390,
    });
  });

  it('cash rounded down records a rounding debit; rounded up a credit', () => {
    expect(
      side(paymentReceiptPostings({ method: 'cash', amountCents: 1161, cashRoundingCents: -1 })),
    ).toEqual({
      cash_on_hand: 1160,
      customer_deposits: -1161,
      cash_rounding: 1,
    });
    expect(
      side(paymentReceiptPostings({ method: 'cash', amountCents: 1213, cashRoundingCents: 2 })),
    ).toEqual({
      cash_on_hand: 1215,
      customer_deposits: -1213,
      cash_rounding: -2,
    });
  });
});

describe('sale recognition postings', () => {
  it('undiscounted sale: deposits release into revenue ex GST and GST payable', () => {
    expect(
      side(
        saleRecognitionPostings({
          subtotalCents: 1390,
          discountCents: 0,
          totalCents: 1390,
          taxCents: 126,
          taxableSubtotalCents: 1390,
          taxRateBasisPoints: 1000,
        }),
      ),
    ).toEqual({ customer_deposits: 1390, sales_revenue: -1264, gst_payable: -126 });
  });

  it('discounted sale shows the discount ex GST as contra-revenue', () => {
    // 1290 subtotal, 10% off -> 1161 total, GST 106; gross GST 117.
    expect(
      side(
        saleRecognitionPostings({
          subtotalCents: 1290,
          discountCents: 129,
          totalCents: 1161,
          taxCents: 106,
          taxableSubtotalCents: 1290,
          taxRateBasisPoints: 1000,
        }),
      ),
    ).toEqual({
      customer_deposits: 1161,
      sales_discounts: 118,
      sales_revenue: -1173,
      gst_payable: -106,
    });
  });

  it('a complimentary order recognises revenue fully offset by the discount', () => {
    expect(
      side(
        saleRecognitionPostings({
          subtotalCents: 1290,
          discountCents: 1290,
          totalCents: 0,
          taxCents: 0,
          taxableSubtotalCents: 1290,
          taxRateBasisPoints: 1000,
        }),
      ),
    ).toEqual({ sales_discounts: 1173, sales_revenue: -1173 });
  });

  it('always balances and nets to total − GST for any discounted mixed order', () => {
    fc.assert(
      fc.property(
        fc
          .array(
            fc.record({
              lineTotalCents: fc.integer({ min: 0, max: 50_000 }),
              taxable: fc.boolean(),
            }),
            {
              minLength: 1,
              maxLength: 8,
            },
          )
          .filter((ls) => ls.some((l) => l.lineTotalCents > 0)),
        fc.integer({ min: 0, max: 10_000 }),
        (lines, bp) => {
          const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
          const taxableSubtotal = lines
            .filter((l) => l.taxable)
            .reduce((s, l) => s + l.lineTotalCents, 0);
          let discount = 0;
          let total = subtotal;
          let tax = inclusiveTax(taxableSubtotal, 1000);
          if (bp > 0) {
            try {
              const r = applyDiscount(lines, { kind: 'percent', basisPoints: bp }, 1000);
              ({ discountCents: discount, totalCents: total, taxCents: tax } = r);
            } catch {
              return; // discount rounds to zero: not a valid discount
            }
          }
          const postings = saleRecognitionPostings({
            subtotalCents: subtotal,
            discountCents: discount,
            totalCents: total,
            taxCents: tax,
            taxableSubtotalCents: taxableSubtotal,
            taxRateBasisPoints: 1000,
          });
          const net = (acct: string) =>
            postings
              .filter((p) => p.account === acct)
              .reduce((s, p) => s + p.creditCents - p.debitCents, 0);
          expect(postings.reduce((s, p) => s + p.debitCents - p.creditCents, 0)).toBe(0);
          expect(net('sales_revenue') + net('sales_discounts')).toBe(total - tax);
          expect(net('gst_payable')).toBe(tax);
          postings.forEach((p) => expect(p.debitCents >= 0 && p.creditCents >= 0).toBe(true));
        },
      ),
    );
  });

  it('rejects inconsistent facts', () => {
    expect(() =>
      saleRecognitionPostings({
        subtotalCents: 1000,
        discountCents: 100,
        totalCents: 1000,
        taxCents: 91,
        taxableSubtotalCents: 1000,
        taxRateBasisPoints: 1000,
      }),
    ).toThrow(/subtotal minus discount/);
  });
});
