import { DomainError } from './errors.ts';
import { allocate, assertCents, cents, divRoundHalfUp, inclusiveTax, type Cents } from './money.ts';

export type DiscountSpec =
  | { readonly kind: 'percent'; /** basis points, 10000 = 100% */ readonly basisPoints: number }
  | { readonly kind: 'amount'; readonly cents: number };

export interface DiscountableLine {
  readonly lineTotalCents: number;
  readonly taxable: boolean;
}

export interface DiscountResult {
  readonly discountCents: Cents;
  /** Discount allocated to each input line (same order); sums exactly to discountCents. */
  readonly lineDiscounts: readonly Cents[];
  readonly totalCents: Cents;
  /** GST contained in the discounted taxable lines. */
  readonly taxCents: Cents;
}

/**
 * Applies an order-level discount to GST-inclusive lines. The discount is
 * allocated across lines in proportion to their totals (largest remainder,
 * so parts sum exactly) and GST is recomputed on the discounted taxable
 * portion only — a discount on a mixed order never over- or under-states GST.
 */
export function applyDiscount(
  lines: readonly DiscountableLine[],
  spec: DiscountSpec,
  taxRateBasisPoints: number,
): DiscountResult {
  if (lines.length === 0) throw new DomainError('INVALID_QUANTITY', 'Order has no lines');
  lines.forEach((l) => assertCents(l.lineTotalCents));
  const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  assertCents(subtotal);

  let discount: number;
  if (spec.kind === 'percent') {
    if (
      !Number.isSafeInteger(spec.basisPoints) ||
      spec.basisPoints < 1 ||
      spec.basisPoints > 10_000
    ) {
      throw new DomainError('DISCOUNT_INVALID', 'Percentage must be between 0.01% and 100%');
    }
    discount = Number(divRoundHalfUp(BigInt(subtotal) * BigInt(spec.basisPoints), 10_000n));
  } else {
    assertCents(spec.cents);
    if (spec.cents < 1) throw new DomainError('DISCOUNT_INVALID', 'Discount must be positive');
    if (spec.cents > subtotal) {
      throw new DomainError('DISCOUNT_INVALID', 'Discount cannot exceed the order subtotal', {
        subtotalCents: subtotal,
      });
    }
    discount = spec.cents;
  }
  if (discount < 1) throw new DomainError('DISCOUNT_INVALID', 'Discount rounds to zero');

  const lineDiscounts =
    subtotal > 0
      ? allocate(
          discount,
          lines.map((l) => l.lineTotalCents),
        )
      : lines.map(() => cents(0));
  const taxableAfter = lines.reduce(
    (s, l, i) => (l.taxable ? s + l.lineTotalCents - lineDiscounts[i]! : s),
    0,
  );
  return {
    discountCents: cents(discount),
    lineDiscounts,
    totalCents: cents(subtotal - discount),
    taxCents: inclusiveTax(taxableAfter, taxRateBasisPoints),
  };
}

/** Effective discount rate in basis points (rounded up), for approval policy checks. */
export function discountBasisPoints(discountCents: number, subtotalCents: number): number {
  if (subtotalCents <= 0) return 0;
  const bp = (BigInt(discountCents) * 10_000n + BigInt(subtotalCents) - 1n) / BigInt(subtotalCents);
  return Number(bp);
}
