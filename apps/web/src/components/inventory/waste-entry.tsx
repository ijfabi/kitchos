'use client';

import type {
  MenuResponse,
  OrderView,
  RecordWasteRequest,
  StationView,
  WasteItemView,
  WasteRecordView,
} from '@kitchos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Button, Card, EmptyState, Spinner } from '@/components/ui';
import { api, get } from '@/lib/api';
import { OUTCOME_UNKNOWN_HINT, outcomeUnknown, useAttemptKey } from '@/lib/attempt-key';
import { isPositiveQuantity } from '@/lib/format';
import { inputClass, WASTE_REASON_LABEL, WasteSummaryLine } from './fields';

type Mode = 'ingredient' | 'prepared' | 'order';

const MODES: [Mode, string][] = [
  ['ingredient', 'Ingredient'],
  ['prepared', 'Prepared food'],
  ['order', 'From an order'],
];

interface Props {
  restaurantId: string;
  slug: string;
  token: string;
  permissions: string[];
}

export function WasteEntry({ restaurantId, slug, token, permissions }: Props) {
  const qc = useQueryClient();
  const base = `/v1/restaurants/${restaurantId}`;
  const [mode, setMode] = useState<Mode>('ingredient');
  const [itemId, setItemId] = useState('');
  const [menuItemId, setMenuItemId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [lineId, setLineId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [remake, setRemake] = useState(false);
  const [reason, setReason] = useState<RecordWasteRequest['reason'] | ''>('');
  const [stationId, setStationId] = useState('');
  const [notes, setNotes] = useState('');
  const attempt = useAttemptKey();

  const items = useQuery({
    queryKey: ['waste-items', restaurantId],
    queryFn: ({ signal }) => get<WasteItemView[]>(`${base}/inventory/waste-items`, token, signal),
  });
  const menu = useQuery({
    queryKey: ['menu', slug],
    queryFn: ({ signal }) => get<MenuResponse>(`/v1/public/restaurants/${slug}/menu`, null, signal),
    enabled: mode === 'prepared',
  });
  const orders = useQuery({
    queryKey: ['waste-orders', restaurantId],
    queryFn: ({ signal }) =>
      get<OrderView[]>(
        // Cancelled too: food cooked for a cancelled order is waste already consumed.
        `${base}/orders?status=accepted,in_preparation,ready,completed,cancelled&limit=100`,
        token,
        signal,
      ),
    enabled: mode === 'order' && permissions.includes('orders.view'),
  });
  const stations = useQuery({
    queryKey: ['stations', restaurantId],
    queryFn: ({ signal }) => get<StationView[]>(`${base}/kitchen/stations`, token, signal),
    enabled: permissions.includes('kitchen.view'),
  });
  const mine = useQuery({
    queryKey: ['my-waste', restaurantId],
    queryFn: ({ signal }) => get<WasteRecordView[]>(`${base}/inventory/waste/mine`, token, signal),
  });

  const selectedItem = items.data?.find((i) => i.inventoryItemId === itemId);
  const selectedOrder = orders.data?.find((o) => o.id === orderId);
  // A meal's parent line has no recipe of its own: waste is recorded per component.
  const lines = useMemo(
    () =>
      selectedOrder?.lines.flatMap((l) =>
        l.kind === 'combo'
          ? l.components.map((c) => ({
              id: c.id,
              name: `${c.name} (${l.name})`,
              quantity: c.quantity,
            }))
          : [{ id: l.id, name: l.name, quantity: l.quantity }],
      ) ?? [],
    [selectedOrder],
  );
  const selectedLine = lines.find((l) => l.id === lineId);

  const wholeQty = /^\d{1,3}$/.test(quantity) ? Number(quantity) : 0;
  const quantityOk =
    mode === 'ingredient'
      ? isPositiveQuantity(quantity)
      : wholeQty >= 1 &&
        wholeQty <= 100 &&
        (mode !== 'order' || !selectedLine || wholeQty <= selectedLine.quantity);
  const targetOk =
    mode === 'ingredient' ? !!itemId : mode === 'prepared' ? !!menuItemId : !!selectedLine;
  const valid = quantityOk && targetOk && reason !== '';

  const buildBody = (): RecordWasteRequest => {
    const common = {
      reason: reason as RecordWasteRequest['reason'],
      ...(stationId ? { stationId } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    if (mode === 'ingredient') {
      return {
        kind: 'raw_ingredient',
        inventoryItemId: itemId,
        quantity: quantity.trim(),
        ...common,
      };
    }
    if (mode === 'prepared') {
      return { kind: 'prepared_item', menuItemId, quantity: wholeQty, ...common };
    }
    return { kind: 'prepared_item', orderLineId: lineId, quantity: wholeQty, remake, ...common };
  };

  const record = useMutation({
    mutationFn: async (body: RecordWasteRequest) =>
      (
        await api<WasteRecordView>(`${base}/inventory/waste`, {
          method: 'POST',
          token,
          body,
          idempotencyKey: attempt.keyFor(body),
        })
      ).data,
    onSuccess: () => {
      attempt.settle();
      setQuantity('');
      setNotes('');
      setRemake(false);
      setReason('');
      setItemId('');
      setMenuItemId('');
      setLineId('');
      void qc.invalidateQueries({ queryKey: ['my-waste', restaurantId] });
      void qc.invalidateQueries({ queryKey: ['waste', restaurantId] });
      void qc.invalidateQueries({ queryKey: ['balances', restaurantId] });
    },
    onError: (err) => attempt.settle(err),
  });

  const switchMode = (m: Mode) => {
    setMode(m);
    setQuantity('');
    setRemake(false);
    record.reset();
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="font-bold">Record waste</h2>
        <div role="group" aria-label="What was wasted" className="mt-3 flex flex-wrap gap-2">
          {MODES.filter(([m]) => m !== 'order' || permissions.includes('orders.view')).map(
            ([m, label]) => (
              <Button
                key={m}
                size="sm"
                type="button"
                variant={mode === m ? 'primary' : 'secondary'}
                aria-pressed={mode === m}
                onClick={() => switchMode(m)}
              >
                {label}
              </Button>
            ),
          )}
        </div>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          aria-label="Record waste"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !record.isPending) record.mutate(buildBody());
          }}
        >
          {mode === 'ingredient' && (
            <label className="block text-sm sm:col-span-2">
              <span className="font-medium">Ingredient</span>
              <select
                className={inputClass}
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
              >
                <option value="">Choose an ingredient</option>
                {items.data?.map((i) => (
                  <option key={i.inventoryItemId} value={i.inventoryItemId}>
                    {i.name} ({i.baseUnit})
                  </option>
                ))}
              </select>
            </label>
          )}
          {mode === 'prepared' && (
            <label className="block text-sm sm:col-span-2">
              <span className="font-medium">Menu item</span>
              <select
                className={inputClass}
                value={menuItemId}
                onChange={(e) => setMenuItemId(e.target.value)}
              >
                <option value="">Choose a menu item</option>
                {/* A meal has no recipe of its own: waste each component separately. */}
                {menu.data?.items
                  .filter((i) => i.kind === 'item')
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {mode === 'order' && (
            <>
              <label className="block text-sm">
                <span className="font-medium">Order</span>
                <select
                  className={inputClass}
                  value={orderId}
                  onChange={(e) => {
                    setOrderId(e.target.value);
                    setLineId('');
                  }}
                >
                  <option value="">Choose an order</option>
                  {orders.data?.map((o) => (
                    <option key={o.id} value={o.id}>
                      #{o.orderNumber}
                      {o.customerName ? ` · ${o.customerName}` : ''}
                      {o.status === 'cancelled' ? ' · Cancelled' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="font-medium">Item on the order</span>
                <select
                  className={inputClass}
                  value={lineId}
                  disabled={!selectedOrder}
                  onChange={(e) => setLineId(e.target.value)}
                >
                  <option value="">Choose an item</option>
                  {lines.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.quantity} × {l.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label className="block text-sm">
            <span className="font-medium">
              {mode === 'ingredient'
                ? `Quantity${selectedItem ? ` (${selectedItem.baseUnit})` : ''}`
                : 'Portions'}
            </span>
            <input
              inputMode={mode === 'ingredient' ? 'decimal' : 'numeric'}
              className={inputClass}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Reason</span>
            <select
              className={inputClass}
              value={reason}
              onChange={(e) => setReason(e.target.value as RecordWasteRequest['reason'])}
            >
              <option value="">Choose a reason</option>
              {Object.entries(WASTE_REASON_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {stations.data && (
            <label className="block text-sm">
              <span className="font-medium">Station (optional)</span>
              <select
                className={inputClass}
                value={stationId}
                onChange={(e) => setStationId(e.target.value)}
              >
                <option value="">Not station-specific</option>
                {stations.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-sm">
            <span className="font-medium">Notes (optional)</span>
            <input
              className={inputClass}
              maxLength={1000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          {mode === 'order' && (
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                className="size-5"
                checked={remake}
                onChange={(e) => setRemake(e.target.checked)}
              />
              Already remade: also take a fresh portion from stock (this does not send a ticket to
              the kitchen)
            </label>
          )}
          {mode === 'prepared' && (
            <p className="text-sm text-ink-muted sm:col-span-2">
              For food not made for an order, such as overproduction. This takes the ingredients
              from stock again, so use &quot;From an order&quot; for anything made for an order,
              including cancelled ones.
            </p>
          )}
          {[items, menu, orders].some((q) => q.isError) && (
            <p role="alert" className="text-sm text-danger sm:col-span-2">
              Could not load the list to choose from. Check your connection and reopen this page.
            </p>
          )}
          {record.isError && outcomeUnknown(record.error) && (
            <p role="alert" className="text-sm font-medium text-danger sm:col-span-2">
              {OUTCOME_UNKNOWN_HINT}
            </p>
          )}
          {record.isError && (
            <p
              role="alert"
              className="rounded-lg bg-danger-soft p-3 text-sm text-danger sm:col-span-2"
            >
              {record.error.message}
            </p>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" size="lg" loading={record.isPending} disabled={!valid}>
              Record waste
            </Button>
          </div>
        </form>
        {record.isSuccess && (
          <div
            role="status"
            data-testid="waste-result"
            className="mt-3 rounded-lg bg-canvas p-3 text-sm"
          >
            <WasteSummaryLine w={record.data} />
            {record.data.status === 'pending_approval' && (
              <p className="mt-1 font-medium">
                Above the approval limit: a manager needs to review this.
              </p>
            )}
          </div>
        )}
      </Card>

      <section aria-label="Your recent waste">
        <h2 className="mb-2 font-bold">Your recent waste</h2>
        {mine.isPending ? (
          <Spinner label="Loading your waste" />
        ) : mine.isError ? (
          <EmptyState title="Cannot load your waste" hint={mine.error.message} />
        ) : mine.data.length === 0 ? (
          <EmptyState title="Nothing recorded yet" />
        ) : (
          <ul className="space-y-2">
            {mine.data.map((w) => (
              <li key={w.id} data-testid="my-waste">
                <Card className="p-3">
                  <WasteSummaryLine w={w} />
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
