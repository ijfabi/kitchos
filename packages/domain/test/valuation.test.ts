import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { extendedCostCents, parseScaled } from '../src/valuation.ts';

describe('valuation', () => {
  it('values quantities at standard cost exactly', () => {
    expect(extendedCostCents(500_000, '0.8')).toBe(400); // 500 g lettuce at 0.8 c/g
    expect(extendedCostCents(1_000, '110')).toBe(110); // one patty
    expect(extendedCostCents(15_000, '1.2')).toBe(18); // 15 ml sauce
    expect(extendedCostCents(220_000, '0.17')).toBe(37); // 37.4 -> 37
    expect(extendedCostCents(-2_000, '45')).toBe(-90); // negative variance
    expect(extendedCostCents(1, '0.5')).toBe(0); // 0.0005 c rounds to 0
  });

  it('parses scaled decimals without floating point', () => {
    expect(parseScaled('0.17', 6)).toBe(170_000n);
    expect(parseScaled('12', 6)).toBe(12_000_000n);
    expect(parseScaled('1.2300000', 6)).toBe(1_230_000n);
    expect(() => parseScaled('1.0000001', 6)).toThrow();
    expect(() => parseScaled('-1', 6)).toThrow();
  });

  it('is additive within one cent per line (rounding is bounded)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 50_000_000 }),
        (a, b, microCost) => {
          const cost = `${Math.trunc(microCost / 1e6)}.${String(microCost % 1e6).padStart(6, '0')}`;
          const split = extendedCostCents(a, cost) + extendedCostCents(b, cost);
          const whole = extendedCostCents(a + b, cost);
          expect(Math.abs(split - whole)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});
