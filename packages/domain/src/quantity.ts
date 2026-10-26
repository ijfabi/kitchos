/**
 * Inventory quantities are integers in thousandths of the item's base unit
 * ("milli-units"): 15 g of sauce with base unit `g` is 15000; one bun with base
 * unit `each` is 1000. PostgreSQL stores them as numeric(18,3); conversion is
 * exact string manipulation, never parseFloat.
 */
export type MilliQty = number & { readonly __brand: 'MilliQty' };

export const BASE_UNITS = ['each', 'g', 'ml'] as const;
export type BaseUnit = (typeof BASE_UNITS)[number];

export function milli(value: number): MilliQty {
  if (!Number.isSafeInteger(value)) throw new Error(`Quantity ${value} is not a safe integer`);
  return value as MilliQty;
}

/** "12.5" | "-0.250" | "3" -> milli-units. Rejects more than 3 decimal places. */
export function parseDecimalQty(text: string): MilliQty {
  const m = /^(-)?(\d+)(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (!m) throw new Error(`Invalid decimal quantity "${text}"`);
  const [, neg, whole, frac = ''] = m;
  const value = Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
  return milli(neg ? -value : value);
}

export function formatDecimalQty(value: number): string {
  const v = milli(value);
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  return `${sign}${Math.trunc(abs / 1000)}.${String(abs % 1000).padStart(3, '0')}`;
}
