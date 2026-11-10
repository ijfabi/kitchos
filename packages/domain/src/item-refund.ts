import { assertCents, divRoundHalfUp } from './money.ts';

/**
 * Cents to refund for `count` units of an order line whose `quantity` units
 * cost `netCents` in all (after discount), when `before` units were already
 * refunded. Cumulative, so refunding a line a unit at a time returns exactly
 * its net amount, never a cent more or less.
 */
export function itemRefundCents(
  netCents: number,
  quantity: number,
  before: number,
  count: number,
): number {
  assertCents(netCents);
  for (const n of [quantity, before, count]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid quantity ${n}`);
  }
  if (netCents < 0) throw new Error('Line net must not be negative');
  if (quantity === 0 || before + count > quantity) {
    throw new Error(`Cannot refund ${count} more of ${quantity} after ${before}`);
  }
  const upTo = (n: number) =>
    n === quantity
      ? netCents
      : Number(divRoundHalfUp(BigInt(n) * BigInt(netCents), BigInt(quantity)));
  return upTo(before + count) - upTo(before);
}
