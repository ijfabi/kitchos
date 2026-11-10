import { formatAud } from '@kitchos/domain';

export const money = (cents: number) => formatAud(cents);

export function elapsed(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function elapsedSeconds(fromIso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
}

export const FULFILMENT_LABEL: Record<string, string> = {
  dine_in: 'Dine in',
  takeaway: 'Takeaway',
  pickup: 'Pickup',
  drive_thru: 'Drive-thru',
  delivery: 'Delivery',
};

export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  accepted: 'Order received',
  in_preparation: 'Being prepared',
  ready: 'Ready for pickup',
  completed: 'Collected',
  cancelled: 'Cancelled',
};

/** 2834 basis points -> "28.34%", exactly; "n/a" when there is no share (no positive sales). */
export function percent(bps: number | null): string {
  if (bps === null) return 'n/a';
  const abs = Math.abs(bps);
  return `${bps < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`;
}

/** A quantity the API accepts: up to 3 decimals. Kept as text; never goes through a float. */
export const isQuantity = (text: string) => /^\d{1,12}(\.\d{1,3})?$/.test(text.trim());
export const isPositiveQuantity = (text: string) => isQuantity(text) && /[1-9]/.test(text);

/** "12.500" -> "12.5", without going through a float. */
export const trimQuantity = (text: string) =>
  text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;

/** Exact "12.5" / "12.50" / "12" -> cents; null when not a valid amount. Never uses floating point. */
export function dollarsToCents(text: string): number | null {
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
