import { DomainError } from './errors.ts';

/**
 * Money is always an integer number of minor units (cents). JavaScript numbers
 * represent integers exactly up to 2^53, so integer add/subtract/multiply is
 * exact provided every result is checked with `assertCents`. Any operation that
 * divides goes through bigint arithmetic with explicit rounding — never through
 * floating-point division. See docs/adr/0004-money-and-quantities.md.
 */
export type Cents = number & { readonly __brand: 'Cents' };

export function cents(value: number): Cents {
  assertCents(value);
  return value as Cents;
}

export function assertCents(value: number): asserts value is Cents {
  if (!Number.isSafeInteger(value)) {
    throw new DomainError('AMOUNT_OUT_OF_RANGE', `Amount ${value} is not a safe integer of cents`);
  }
}

export function addCents(...values: number[]): Cents {
  let total = 0;
  for (const v of values) {
    assertCents(v);
    total += v;
    assertCents(total);
  }
  return total as Cents;
}

export function mulCents(value: number, factor: number): Cents {
  assertCents(value);
  if (!Number.isSafeInteger(factor)) throw new Error(`Factor ${factor} must be an integer`);
  return cents(value * factor);
}

/** Integer division rounding half away from zero, computed exactly in bigint. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('Division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return negative ? -q : q;
}

/**
 * Tax contained in a tax-inclusive amount. `rateBasisPoints` of 1000 = 10%
 * (Australian GST), giving amount × 1000 / 11000 = amount / 11.
 */
export function inclusiveTax(amount: number, rateBasisPoints: number): Cents {
  assertCents(amount);
  if (!Number.isSafeInteger(rateBasisPoints) || rateBasisPoints < 0) {
    throw new Error(`Invalid tax rate ${rateBasisPoints}`);
  }
  const tax = divRoundHalfUp(
    BigInt(amount) * BigInt(rateBasisPoints),
    10_000n + BigInt(rateBasisPoints),
  );
  return cents(Number(tax));
}

/**
 * Split `amount` across weights so the parts always sum exactly to `amount`
 * (largest-remainder method). Used for splitting discounts and payments.
 */
export function allocate(amount: number, weights: readonly number[]): Cents[] {
  assertCents(amount);
  if (weights.length === 0) throw new Error('allocate requires at least one weight');
  const w = weights.map((x) => {
    if (!Number.isSafeInteger(x) || x < 0) throw new Error(`Invalid weight ${x}`);
    return BigInt(x);
  });
  const totalWeight = w.reduce((a, b) => a + b, 0n);
  if (totalWeight === 0n) throw new Error('allocate requires a positive total weight');
  const a = BigInt(amount);
  const sign = a < 0n ? -1n : 1n;
  const abs = a * sign;
  const parts = w.map((wi) => (abs * wi) / totalWeight);
  const remainders = w.map((wi, i) => ({ i, r: (abs * wi) % totalWeight }));
  let leftover = abs - parts.reduce((x, y) => x + y, 0n);
  remainders.sort((x, y) => (y.r === x.r ? x.i - y.i : y.r > x.r ? 1 : -1));
  for (const { i } of remainders) {
    if (leftover === 0n) break;
    parts[i] = (parts[i] ?? 0n) + 1n;
    leftover -= 1n;
  }
  return parts.map((p) => cents(Number(p * sign)));
}

export function formatAud(amount: number): string {
  assertCents(amount);
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const dollars = Math.trunc(abs / 100).toLocaleString('en-AU');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}
