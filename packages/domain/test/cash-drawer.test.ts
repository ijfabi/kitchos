import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  drawerClosePostings,
  drawerFloatPostings,
  drawerMovementPostings,
  expectedDrawerCash,
} from '../src/cash-drawer.ts';
import type { Posting } from '../src/postings.ts';

const net = (ps: Posting[], account: string) =>
  ps.filter((p) => p.account === account).reduce((s, p) => s + p.debitCents - p.creditCents, 0);

describe('cash drawer', () => {
  it('expected cash = float + sales − refunds + paid in − paid out − safe drops', () => {
    expect(
      expectedDrawerCash({
        openingFloatCents: 20_000,
        cashSalesCents: 5_160,
        cashRefundsCents: 1_160,
        paidInsCents: 1_000,
        paidOutsCents: 500,
        safeDropsCents: 10_000,
      }),
    ).toBe(14_500);
  });

  it('a short drawer books the shortage; an over drawer books the overage', () => {
    expect(
      drawerClosePostings(9_950, 10_000).map((p) => [p.account, p.debitCents - p.creditCents]),
    ).toEqual([
      ['cash_in_safe', 9_950],
      ['cash_over_short', 50],
      ['cash_on_hand', -10_000],
    ]);
    expect(
      drawerClosePostings(10_020, 10_000).map((p) => [p.account, p.debitCents - p.creditCents]),
    ).toEqual([
      ['cash_in_safe', 10_020],
      ['cash_over_short', -20],
      ['cash_on_hand', -10_000],
    ]);
    expect(drawerClosePostings(0, 0)).toEqual([]);
  });

  it('over a whole session, cash on hand nets to zero and the safe receives float back plus takings', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.array(
          fc.record({
            kind: fc.constantFrom('paid_in', 'paid_out', 'safe_drop'),
            amount: fc.integer({ min: 1, max: 5_000 }),
          }),
          { maxLength: 6 },
        ),
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: -500, max: 500 }),
        (float, movements, sales, variance) => {
          const sum = (k: string) =>
            movements.filter((m) => m.kind === k).reduce((s, m) => s + m.amount, 0);
          const expected = expectedDrawerCash({
            openingFloatCents: float,
            cashSalesCents: sales,
            cashRefundsCents: 0,
            paidInsCents: sum('paid_in'),
            paidOutsCents: sum('paid_out'),
            safeDropsCents: sum('safe_drop'),
          });
          const counted = Math.max(0, expected + variance);
          // Sales enter the drawer via payment receipts (Dr cash on hand).
          const sale: Posting[] =
            sales > 0
              ? [
                  {
                    account: 'cash_on_hand',
                    debitCents: sales as never,
                    creditCents: 0 as never,
                    memo: 'sale',
                  },
                ]
              : [];
          const all = [
            ...drawerFloatPostings(float),
            ...sale,
            ...movements.flatMap((m) => drawerMovementPostings(m.kind, m.amount)),
            ...drawerClosePostings(counted, expected),
          ];
          expect(net(all, 'cash_on_hand')).toBe(0);
          expect(net(all, 'cash_over_short')).toBe(expected - counted);
        },
      ),
    );
  });
});
