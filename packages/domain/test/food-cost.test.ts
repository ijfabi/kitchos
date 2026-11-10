import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { foodCost } from '../src/food-cost.ts';

const cents = fc.integer({ min: -10_000_000, max: 10_000_000 });

describe('food cost', () => {
  it('adds waste and count variance to recipe cost, and takes it all from sales', () => {
    expect(
      foodCost({
        netSalesCents: 10_000,
        cogsCents: 2_800,
        wasteCents: 150,
        stockVarianceCents: 50,
      }),
    ).toEqual({
      netSalesCents: 10_000,
      cogsCents: 2_800,
      wasteCents: 150,
      stockVarianceCents: 50,
      actualFoodCostCents: 3_000,
      grossProfitCents: 7_000,
      cogsBps: 2_800,
      actualFoodCostBps: 3_000,
      grossMarginBps: 7_000,
    });
  });

  it('rounds shares half away from zero from exact integers', () => {
    // 1/3 = 3333.33 bps -> 3333; 2/3 = 6666.67 -> 6667; 1/8 = 1250 exactly; 1/16 = 625.
    const pct = (cost: number, sales: number) =>
      foodCost({ netSalesCents: sales, cogsCents: cost, wasteCents: 0, stockVarianceCents: 0 })
        .cogsBps;
    expect(pct(1, 3)).toBe(3_333);
    expect(pct(2, 3)).toBe(6_667);
    expect(pct(1, 8)).toBe(1_250);
    expect(pct(1, 20_000)).toBe(1); // 0.5 bps rounds up
    expect(pct(-1, 20_000)).toBe(-1); // half away from zero
  });

  it('has no percentage without positive sales', () => {
    for (const netSalesCents of [0, -500]) {
      const r = foodCost({ netSalesCents, cogsCents: 100, wasteCents: 10, stockVarianceCents: 0 });
      expect(r.cogsBps).toBeNull();
      expect(r.actualFoodCostBps).toBeNull();
      expect(r.grossProfitCents).toBe(netSalesCents - 110);
    }
  });

  it('refuses non-integer money', () => {
    expect(() =>
      foodCost({ netSalesCents: 100.5, cogsCents: 0, wasteCents: 0, stockVarianceCents: 0 }),
    ).toThrow();
  });

  it('property: margin + actual cost = sales; percentages within half a basis point', () => {
    fc.assert(
      fc.property(cents, cents, cents, cents, (s, c, w, v) => {
        const r = foodCost({
          netSalesCents: s,
          cogsCents: c,
          wasteCents: w,
          stockVarianceCents: v,
        });
        expect(r.grossProfitCents + r.actualFoodCostCents).toBe(s);
        if (s > 0) {
          // The two shares account for all of net sales, within the rounding of each.
          expect(Math.abs(r.grossMarginBps! + r.actualFoodCostBps! - 10_000)).toBeLessThanOrEqual(
            1,
          );
        } else {
          expect(r.grossMarginBps).toBeNull();
        }
        expect(r.actualFoodCostCents).toBe(c + w + v);
        if (s <= 0) {
          expect(r.actualFoodCostBps).toBeNull();
          return;
        }
        // |bps * sales - cost * 10000| <= sales / 2, checked in exact integers.
        const err = BigInt(r.actualFoodCostBps!) * BigInt(s) - BigInt(c + w + v) * 10_000n;
        expect((err < 0n ? -err : err) * 2n <= BigInt(s)).toBe(true);
      }),
    );
  });
});
