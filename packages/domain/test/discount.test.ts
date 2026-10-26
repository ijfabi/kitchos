import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyDiscount, discountBasisPoints } from '../src/discount.ts';
import { inclusiveTax } from '../src/money.ts';

describe('applyDiscount', () => {
  it('applies a percentage discount and recomputes GST on the discounted total', () => {
    const r = applyDiscount(
      [{ lineTotalCents: 1390, taxable: true }],
      { kind: 'percent', basisPoints: 1000 },
      1000,
    );
    expect(r).toMatchObject({ discountCents: 139, totalCents: 1251, taxCents: 114 }); // 1251/11 = 113.7
  });

  it('only GST on taxable lines counts after allocation (mixed GST-free order)', () => {
    // $11.00 taxable + $9.00 GST-free, $5.00 off: allocated 2.75 / 2.25.
    const r = applyDiscount(
      [
        { lineTotalCents: 1100, taxable: true },
        { lineTotalCents: 900, taxable: false },
      ],
      { kind: 'amount', cents: 500 },
      1000,
    );
    expect(r.lineDiscounts).toEqual([275, 225]);
    expect(r.totalCents).toBe(1500);
    expect(r.taxCents).toBe(75); // (1100 - 275) / 11
  });

  it('allows a 100% (complimentary) discount and rejects discounts beyond the subtotal', () => {
    expect(
      applyDiscount(
        [{ lineTotalCents: 450, taxable: true }],
        { kind: 'percent', basisPoints: 10_000 },
        1000,
      ),
    ).toMatchObject({
      totalCents: 0,
      taxCents: 0,
    });
    expect(() =>
      applyDiscount([{ lineTotalCents: 450, taxable: true }], { kind: 'amount', cents: 451 }, 1000),
    ).toThrow(/exceed/);
    expect(() =>
      applyDiscount(
        [{ lineTotalCents: 450, taxable: true }],
        { kind: 'percent', basisPoints: 0 },
        1000,
      ),
    ).toThrow();
    expect(() =>
      applyDiscount(
        [{ lineTotalCents: 450, taxable: true }],
        { kind: 'percent', basisPoints: 10_001 },
        1000,
      ),
    ).toThrow();
    expect(() =>
      applyDiscount(
        [{ lineTotalCents: 5, taxable: true }],
        { kind: 'percent', basisPoints: 1 },
        1000,
      ),
    ).toThrow(/zero/);
  });

  it('allocations sum exactly, never exceed a line, and GST never exceeds the untaxed figure', () => {
    fc.assert(
      fc.property(
        fc
          .array(
            fc.record({
              lineTotalCents: fc.integer({ min: 0, max: 100_000 }),
              taxable: fc.boolean(),
            }),
            { minLength: 1, maxLength: 12 },
          )
          .filter((ls) => ls.some((l) => l.lineTotalCents > 0)),
        fc.integer({ min: 1, max: 10_000 }),
        (lines, bp) => {
          const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
          if (Math.round((subtotal * bp) / 10_000) < 1) return; // rounds to zero: rejected, covered above
          const r = applyDiscount(lines, { kind: 'percent', basisPoints: bp }, 1000);
          expect(r.lineDiscounts.reduce((a, b) => a + b, 0)).toBe(r.discountCents);
          r.lineDiscounts.forEach((d, i) => {
            expect(d).toBeGreaterThanOrEqual(0);
            expect(d).toBeLessThanOrEqual(lines[i]!.lineTotalCents);
          });
          expect(r.totalCents).toBe(subtotal - r.discountCents);
          const taxableBefore = lines
            .filter((l) => l.taxable)
            .reduce((s, l) => s + l.lineTotalCents, 0);
          expect(r.taxCents).toBeLessThanOrEqual(inclusiveTax(taxableBefore, 1000));
          expect(r.taxCents).toBeLessThanOrEqual(r.totalCents);
        },
      ),
    );
  });

  it('reports effective basis points rounded up for policy checks', () => {
    expect(discountBasisPoints(139, 1390)).toBe(1000);
    expect(discountBasisPoints(140, 1390)).toBe(1008);
    expect(discountBasisPoints(1, 3)).toBe(3334);
  });
});
