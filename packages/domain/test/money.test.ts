import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocate, divRoundHalfUp, formatAud, inclusiveTax } from '../src/money.ts';
import { formatDecimalQty, parseDecimalQty } from '../src/quantity.ts';

describe('money', () => {
  it('computes Australian GST as 1/11 of a GST-inclusive amount', () => {
    expect(inclusiveTax(1100, 1000)).toBe(100);
    expect(inclusiveTax(1250, 1000)).toBe(114); // 113.636... -> 114
    expect(inclusiveTax(0, 1000)).toBe(0);
  });

  it('rounds half away from zero exactly', () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
  });

  it('allocation parts always sum to the original amount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        fc
          .array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 10 })
          .filter((w) => w.some((x) => x > 0)),
        (amount, weights) => {
          const parts = allocate(amount, weights);
          expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
          parts.forEach((p) => expect(Number.isSafeInteger(p)).toBe(true));
        },
      ),
    );
  });

  it('GST is never more than the amount and is monotonic', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), (amount) => {
        const tax = inclusiveTax(amount, 1000);
        expect(tax).toBeLessThanOrEqual(amount);
        expect(inclusiveTax(amount + 1, 1000)).toBeGreaterThanOrEqual(tax);
      }),
    );
  });

  it('formats AUD', () => {
    expect(formatAud(123456)).toBe('$1,234.56');
    expect(formatAud(-5)).toBe('-$0.05');
  });

  it('rejects non-integer cents', () => {
    expect(() => inclusiveTax(10.5, 1000)).toThrow(/safe integer/);
  });
});

describe('quantity', () => {
  it('round-trips decimal quantities exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }), (m) => {
        expect(parseDecimalQty(formatDecimalQty(m))).toBe(m);
      }),
    );
    expect(parseDecimalQty('12.5')).toBe(12500);
    expect(parseDecimalQty('-0.25')).toBe(-250);
    expect(() => parseDecimalQty('1.2345')).toThrow();
  });
});
