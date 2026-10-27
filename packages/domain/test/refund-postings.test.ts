import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { refundGstShare, refundPostings, type Posting } from '../src/postings.ts';

const side = (ps: Posting[]) =>
  Object.fromEntries(ps.map((p) => [p.account, p.debitCents || -p.creditCents]));

describe('refund postings', () => {
  it('a cancelled paid order returns the deposit to the card', () => {
    expect(
      side(
        refundPostings({
          method: 'card',
          treatment: 'deposit_release',
          amountCents: 1290,
          cashRoundingCents: 0,
          orderTotalCents: 1290,
          orderTaxCents: 117,
          previouslyRefundedCents: 0,
        }),
      ),
    ).toEqual({ customer_deposits: 1290, card_clearing: -1290 });
  });

  it('a full refund after handover is a sales return with exactly the order GST', () => {
    expect(
      side(
        refundPostings({
          method: 'card',
          treatment: 'sales_return',
          amountCents: 1290,
          cashRoundingCents: 0,
          orderTotalCents: 1290,
          orderTaxCents: 117,
          previouslyRefundedCents: 0,
        }),
      ),
    ).toEqual({ sales_returns: 1173, gst_payable: 117, card_clearing: -1290 });
  });

  it('cash refunds pay out the rounded amount and book the rounding', () => {
    // 1161 refunded, 1160 handed back (rounded down 1c): rounding is income again.
    expect(
      side(
        refundPostings({
          method: 'cash',
          treatment: 'sales_return',
          amountCents: 1161,
          cashRoundingCents: -1,
          orderTotalCents: 1161,
          orderTaxCents: 106,
          previouslyRefundedCents: 0,
        }),
      ),
    ).toEqual({ sales_returns: 1055, gst_payable: 106, cash_on_hand: -1160, cash_rounding: -1 });
  });

  it('rejects refunds beyond the order total', () => {
    expect(() =>
      refundPostings({
        method: 'card',
        treatment: 'sales_return',
        amountCents: 500,
        cashRoundingCents: 0,
        orderTotalCents: 1290,
        orderTaxCents: 117,
        previouslyRefundedCents: 800,
      }),
    ).toThrow(/exceed/);
  });

  it('GST shares of any sequence of partial refunds sum to the order GST and never exceed it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200_000 }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 8 }),
        (total, weights) => {
          const tax = Math.round(total / 11);
          // Split the total into positive parts proportional to the weights.
          const sum = weights.reduce((a, b) => a + b, 0);
          const parts: number[] = [];
          let left = total;
          weights.forEach((w, i) => {
            const part =
              i === weights.length - 1
                ? left
                : Math.min(left, Math.max(0, Math.floor((total * w) / sum)));
            parts.push(part);
            left -= part;
          });
          let refunded = 0;
          let gst = 0;
          for (const amount of parts.filter((p) => p > 0)) {
            const share = refundGstShare({
              amountCents: amount,
              orderTotalCents: total,
              orderTaxCents: tax,
              previouslyRefundedCents: refunded,
            });
            expect(share).toBeGreaterThanOrEqual(0);
            expect(share).toBeLessThanOrEqual(amount);
            gst += share;
            refunded += amount;
            expect(gst).toBeLessThanOrEqual(tax);
          }
          expect(refunded).toBe(total);
          expect(gst).toBe(tax);
        },
      ),
    );
  });
});
