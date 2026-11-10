import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lineGstCents, refundPostings } from '../src/postings.ts';

describe('GST per line (refunds by item)', () => {
  it('a GST-free line carries none; taxable lines share the order GST exactly', () => {
    // Burger 1100 (taxable), water 400 (GST-free): the order's 100 GST is all the burger's.
    expect(
      lineGstCents(100, [
        { netCents: 1100, taxable: true },
        { netCents: 400, taxable: false },
      ]),
    ).toEqual([100, 0]);
    expect(
      lineGstCents(101, [
        { netCents: 500, taxable: true },
        { netCents: 500, taxable: true },
        { netCents: 500, taxable: true },
      ]).reduce((a, b) => a + b, 0),
    ).toBe(101);
    expect(lineGstCents(0, [{ netCents: 500, taxable: true }])).toEqual([0]);
    expect(lineGstCents(0, [{ netCents: 500, taxable: false }])).toEqual([0]);
  });

  it('a refund posts the GST fixed for it, within the refund', () => {
    const net = (key: string, ps: ReturnType<typeof refundPostings>) =>
      ps.filter((p) => p.account === key).reduce((s, p) => s + p.debitCents - p.creditCents, 0);
    const base = {
      method: 'card' as const,
      treatment: 'sales_return' as const,
      amountCents: 400,
      cashRoundingCents: 0,
      orderTotalCents: 1500,
      orderTaxCents: 100,
      previouslyRefundedCents: 0,
    };
    // The proportional rule would take 27 of GST back for the water; the fixed figure takes none.
    expect(net('gst_payable', refundPostings(base))).toBe(27);
    expect(net('gst_payable', refundPostings({ ...base, gstCents: 0 }))).toBe(0);
    expect(net('sales_returns', refundPostings({ ...base, gstCents: 0 }))).toBe(400);
    expect(() => refundPostings({ ...base, gstCents: 401 })).toThrow();
  });

  it('property: line GST sums to the order GST, and GST-free lines get none', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(
          fc.record({ netCents: fc.integer({ min: 0, max: 100_000 }), taxable: fc.boolean() }),
          { minLength: 1, maxLength: 20 },
        ),
        (tax, lines) => {
          const gst = lineGstCents(tax, lines);
          const taxableNet = lines.reduce((s, l) => s + (l.taxable ? l.netCents : 0), 0);
          lines.forEach((l, i) => {
            if (!l.taxable) expect(gst[i]).toBe(0);
          });
          expect(gst.reduce((a, b) => a + b, 0)).toBe(taxableNet > 0 ? tax : 0);
        },
      ),
    );
  });
});
