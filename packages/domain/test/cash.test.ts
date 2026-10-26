import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cashPayableCents, settleCash } from '../src/cash.ts';
import { DomainError } from '../src/errors.ts';

describe('settleCash', () => {
  it('rounds Australian cash totals to the nearest 5c', () => {
    expect(settleCash(1391, 2000, 5)).toMatchObject({
      payableCents: 1390,
      roundingCents: -1,
      changeCents: 610,
    });
    expect(settleCash(1392, 2000, 5)).toMatchObject({ payableCents: 1390, roundingCents: -2 });
    expect(settleCash(1393, 2000, 5)).toMatchObject({ payableCents: 1395, roundingCents: 2 });
    expect(settleCash(1394, 2000, 5)).toMatchObject({ payableCents: 1395, roundingCents: 1 });
    expect(settleCash(1397, 1400, 5)).toMatchObject({ payableCents: 1395, changeCents: 5 });
    expect(settleCash(1398, 1400, 5)).toMatchObject({ payableCents: 1400, changeCents: 0 });
  });

  it('does not round when the increment is 1', () => {
    expect(settleCash(1393, 1393, 1)).toMatchObject({
      payableCents: 1393,
      roundingCents: 0,
      changeCents: 0,
    });
  });

  it('rejects insufficient tender with the amount due', () => {
    try {
      settleCash(1393, 1390, 5);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe('INSUFFICIENT_TENDER');
      expect((e as DomainError).details).toMatchObject({ payableCents: 1395 });
    }
  });

  it('always balances: tendered = total + rounding + change, rounding within half an increment', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.constantFrom(1, 5, 10, 50, 100),
        (total, extra, inc) => {
          const payable = Math.round(total / inc) * inc + inc; // always enough
          const s = settleCash(total, payable + extra, inc);
          expect(s.tenderedCents).toBe(total + s.roundingCents + s.changeCents);
          expect(s.payableCents % inc).toBe(0);
          expect(Math.abs(s.roundingCents) * 2).toBeLessThanOrEqual(inc);
          expect(s.changeCents).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe('cashPayableCents', () => {
  it('matches the payable used when settling', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.constantFrom(1, 5, 10, 100),
        (total, inc) => {
          const due = cashPayableCents(total, inc);
          expect(settleCash(total, due, inc).changeCents).toBe(0);
        },
      ),
    );
    expect(cashPayableCents(1212, 5)).toBe(1210);
    expect(cashPayableCents(1213, 5)).toBe(1215);
  });
});
