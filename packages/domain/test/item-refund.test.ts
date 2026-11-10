import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { itemRefundCents } from '../src/item-refund.ts';

describe('item refunds', () => {
  it('refunds a unit share, rounded half up, and the last unit takes the rest', () => {
    // 3 burgers for 1000c: 333.33 each.
    expect(itemRefundCents(1000, 3, 0, 1)).toBe(333);
    expect(itemRefundCents(1000, 3, 1, 1)).toBe(334); // 667 - 333
    expect(itemRefundCents(1000, 3, 2, 1)).toBe(333); // the rest
    expect(itemRefundCents(1000, 3, 0, 3)).toBe(1000);
    expect(itemRefundCents(790, 1, 0, 1)).toBe(790);
    expect(itemRefundCents(0, 2, 0, 1)).toBe(0); // a comped line refunds nothing
  });

  it('refuses more units than the line has left', () => {
    expect(() => itemRefundCents(1000, 3, 2, 2)).toThrow();
    expect(() => itemRefundCents(1000, 0, 0, 0)).toThrow();
    expect(() => itemRefundCents(-1, 1, 0, 1)).toThrow();
    expect(() => itemRefundCents(10.5, 1, 0, 1)).toThrow();
  });

  it('property: any split of a line refunds exactly its net amount, each part within a cent of its share', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc
          .integer({ min: 1, max: 50 })
          .chain((q) =>
            fc.tuple(fc.constant(q), fc.array(fc.integer({ min: 1, max: q }), { maxLength: 60 })),
          ),
        (net, [quantity, steps]) => {
          let before = 0;
          let total = 0;
          for (const step of steps) {
            const count = Math.min(step, quantity - before);
            if (count === 0) break;
            const part = itemRefundCents(net, quantity, before, count);
            // |part * quantity - count * net| <= quantity, in exact integers.
            const err = BigInt(part) * BigInt(quantity) - BigInt(count) * BigInt(net);
            expect((err < 0n ? -err : err) <= BigInt(quantity)).toBe(true);
            total += part;
            before += count;
          }
          if (before < quantity) total += itemRefundCents(net, quantity, before, quantity - before);
          expect(total).toBe(net);
        },
      ),
    );
  });
});
