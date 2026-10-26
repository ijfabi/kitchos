import { cents, divRoundHalfUp, type Cents } from './money.ts';

/** Parses a non-negative decimal string into an integer scaled by 10^scale, exactly. */
export function parseScaled(text: string, scale: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`Invalid decimal "${text}"`);
  const [, whole, frac = ''] = m;
  if (frac.length > scale) {
    if (/[^0]/.test(frac.slice(scale)))
      throw new Error(`"${text}" has more than ${scale} decimal places`);
  }
  return (
    BigInt(whole!) * 10n ** BigInt(scale) + BigInt(frac.slice(0, scale).padEnd(scale, '0') || '0')
  );
}

/**
 * Extended cost in cents of `quantityMilli` thousandths of a base unit at
 * `unitCost` cents per base unit (decimal string, up to 6 dp), rounded half up.
 * Sign follows the quantity (variances can be negative).
 */
export function extendedCostCents(quantityMilli: number, unitCost: string): Cents {
  if (!Number.isSafeInteger(quantityMilli)) throw new Error(`Invalid quantity ${quantityMilli}`);
  const microCents = parseScaled(unitCost, 6);
  return cents(Number(divRoundHalfUp(BigInt(quantityMilli) * microCents, 1_000_000_000n)));
}
