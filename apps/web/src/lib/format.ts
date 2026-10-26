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
