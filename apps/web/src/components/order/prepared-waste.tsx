'use client';

import type { PreparedItemsView } from '@kitchos/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get } from '@/lib/api';

export type WasteEntry = { orderLineId: string; quantity: number };
/** What to send with a cancel or refund: the whole list, and the version of the list it was chosen from. */
export type WasteChoice = { waste: WasteEntry[]; preparedVersion: string };

export const preparedItemsKey = (restaurantId: string, orderId: string) => [
  'prepared-items',
  restaurantId,
  orderId,
];

/**
 * The food already made for an order, with how many portions of each to record
 * as waste. Starts at all of them or none; staff adjust. Reports the whole list
 * with the version it came from (the server refuses it if the kitchen has
 * prepared more since), or null while loading.
 */
export function PreparedWaste({
  restaurantId,
  orderId,
  token,
  defaultAll,
  onChange,
}: {
  restaurantId: string;
  orderId: string;
  token: string;
  defaultAll: boolean;
  onChange: (choice: WasteChoice | null) => void;
}) {
  const items = useQuery({
    queryKey: preparedItemsKey(restaurantId, orderId),
    queryFn: ({ signal }) =>
      get<PreparedItemsView>(
        `/v1/restaurants/${restaurantId}/orders/${orderId}/prepared-items`,
        token,
        signal,
      ),
    // The kitchen may prepare more while this is open.
    refetchInterval: 5_000,
  });
  const [counts, setCounts] = useState<Record<string, number>>({});
  const version = items.data?.version;

  // A new list (or a change of default, e.g. the refund reason) resets every line to the default.
  useEffect(() => {
    if (!items.data) return;
    setCounts(
      Object.fromEntries(
        items.data.items.map((i) => [i.orderLineId, defaultAll ? i.remaining : 0]),
      ),
    );
    // Reset only when the list itself changes, not on every refetch of the same list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, defaultAll]);

  useEffect(() => {
    if (!items.data) {
      onChange(null);
      return;
    }
    onChange({
      preparedVersion: items.data.version,
      waste: items.data.items.map((i) => ({
        orderLineId: i.orderLineId,
        quantity: counts[i.orderLineId] ?? 0,
      })),
    });
  }, [items.data, counts, onChange]);

  if (items.isPending) return <p className="text-sm text-ink-muted">Checking prepared food…</p>;
  if (items.isError) {
    return (
      <p role="alert" className="text-sm text-danger">
        Could not load the prepared food: {items.error.message}
      </p>
    );
  }
  const open = items.data.items.filter((i) => i.remaining > 0);
  if (open.length === 0) return null;
  return (
    <fieldset className="rounded-lg border border-line p-3 text-sm" data-testid="prepared-waste">
      <legend className="px-1 font-semibold">Food to record as waste</legend>
      <ul className="space-y-1">
        {open.map((i) => (
          <li key={i.orderLineId} className="flex items-center justify-between gap-3">
            <label htmlFor={`waste-${i.orderLineId}`}>{i.name}</label>
            <span className="flex items-center gap-2">
              <input
                id={`waste-${i.orderLineId}`}
                type="number"
                min={0}
                max={i.remaining}
                step={1}
                value={counts[i.orderLineId] ?? 0}
                onChange={(e) => {
                  const n = Math.trunc(Number(e.target.value));
                  const v = Number.isFinite(n) ? Math.min(Math.max(n, 0), i.remaining) : 0;
                  setCounts((c) => ({ ...c, [i.orderLineId]: v }));
                }}
                className="h-9 w-16 rounded-lg border border-line px-2 text-right"
              />
              <span className="text-ink-muted">of {i.remaining}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-ink-muted">
        Lower a count only for food that was not thrown away. Food passed to another order is still
        counted as used by that order too, so record it as waste here.
      </p>
    </fieldset>
  );
}
