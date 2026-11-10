import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  consumptionPostings,
  countPostings,
  receiptPostings,
  wastePostings,
  wasteReversalPostings,
} from '../src/inventory-postings.ts';
import type { Posting } from '../src/postings.ts';

const net = (ps: Posting[], account: string) =>
  ps.filter((p) => p.account === account).reduce((s, p) => s + p.debitCents - p.creditCents, 0);
const shape = (ps: Posting[]) => ps.map((p) => [p.account, p.debitCents - p.creditCents]);

describe('inventory postings', () => {
  it('consumption moves value from inventory to COGS', () => {
    expect(shape(consumptionPostings(-412))).toEqual([
      ['inventory', -412],
      ['cogs', 412],
    ]);
    expect(consumptionPostings(0)).toEqual([]);
    expect(() => consumptionPostings(5)).toThrow(/cannot add stock/);
  });

  it('receipts accrue a supplier liability; opening stock goes to equity', () => {
    expect(shape(receiptPostings(10_000, 'supplier'))).toEqual([
      ['inventory', 10_000],
      ['goods_received_not_invoiced', -10_000],
    ]);
    expect(shape(receiptPostings(10_000, 'opening'))).toEqual([
      ['inventory', 10_000],
      ['opening_balance_equity', -10_000],
    ]);
    expect(() => receiptPostings(-1, 'supplier')).toThrow(/cannot remove stock/);
  });

  it('count shrinkage is an expense; a count gain reduces it', () => {
    expect(shape(countPostings(-250))).toEqual([
      ['inventory', -250],
      ['stock_variance', 250],
    ]);
    expect(shape(countPostings(90))).toEqual([
      ['inventory', 90],
      ['stock_variance', -90],
    ]);
  });

  it('waste of already-consumed food is reclassified out of COGS, never added twice', () => {
    // Burger dropped after its ingredients were consumed, then remade.
    const p = wastePostings({
      deductedDeltaCents: 0,
      reclassifiedCents: 300,
      remakeDeltaCents: -300,
    });
    expect(net(p, 'waste_expense')).toBe(300);
    expect(net(p, 'cogs')).toBe(0); // reclass out, remake in
    expect(net(p, 'inventory')).toBe(-300); // only the remake left the shelf
    // Raw spoilage: straight from inventory to waste.
    expect(
      shape(wastePostings({ deductedDeltaCents: -120, reclassifiedCents: 0, remakeDeltaCents: 0 })),
    ).toEqual([
      ['inventory', -120],
      ['waste_expense', 120],
    ]);
  });

  it('a rejected waste record exactly reverses it, except the remake', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000 }),
        fc.integer({ min: 0, max: 50_000 }),
        fc.integer({ min: 0, max: 50_000 }),
        (deducted, reclassified, remake) => {
          const all = [
            ...wastePostings({
              deductedDeltaCents: -deducted,
              reclassifiedCents: reclassified,
              remakeDeltaCents: -remake,
            }),
            ...wasteReversalPostings({
              restoredDeltaCents: deducted,
              reclassifiedCents: reclassified,
            }),
          ];
          expect(net(all, 'waste_expense')).toBe(0);
          expect(net(all, 'inventory')).toBe(0 - remake); // not -remake: -0 !== 0 for Object.is
          expect(net(all, 'cogs')).toBe(remake);
        },
      ),
    );
  });

  it('inventory always moves by exactly the stock-ledger value, and every entry balances', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant('consume'), v: fc.integer({ min: -9_999, max: 0 }) }),
            fc.record({ op: fc.constant('receive'), v: fc.integer({ min: 0, max: 99_999 }) }),
            fc.record({ op: fc.constant('count'), v: fc.integer({ min: -5_000, max: 5_000 }) }),
            fc.record({ op: fc.constant('waste'), v: fc.integer({ min: -5_000, max: 0 }) }),
          ),
          { maxLength: 20 },
        ),
        (ops) => {
          let ledger = 0;
          let journal = 0;
          for (const { op, v } of ops) {
            ledger += v;
            const p =
              op === 'consume'
                ? consumptionPostings(v)
                : op === 'receive'
                  ? receiptPostings(v, 'supplier')
                  : op === 'count'
                    ? countPostings(v)
                    : wastePostings({
                        deductedDeltaCents: v,
                        reclassifiedCents: 0,
                        remakeDeltaCents: 0,
                      });
            const debits = p.reduce((s, x) => s + x.debitCents, 0);
            expect(debits).toBe(p.reduce((s, x) => s + x.creditCents, 0));
            journal += net(p, 'inventory');
          }
          expect(journal).toBe(ledger);
        },
      ),
    );
  });
});
