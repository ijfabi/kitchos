'use client';

import type {
  GoodsReceiptRequest,
  GoodsReceiptView,
  StockBalanceView,
  StockCountRequest,
  StockCountView,
  StockMovementView,
} from '@kitchos/contracts';
import { formatDecimalQty, parseDecimalQty } from '@kitchos/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useState } from 'react';
import { Button, Card, EmptyState, Spinner } from '@/components/ui';
import { api, get } from '@/lib/api';
import { OUTCOME_UNKNOWN_HINT, outcomeUnknown, useAttemptKey } from '@/lib/attempt-key';
import { isPositiveQuantity, isQuantity, money, trimQuantity } from '@/lib/format';
import { inputClass } from './fields';

interface Props {
  restaurantId: string;
  token: string;
}

const useBalances = ({ restaurantId, token }: Props) =>
  useQuery({
    queryKey: ['balances', restaurantId],
    queryFn: ({ signal }) =>
      get<StockBalanceView[]>(`/v1/restaurants/${restaurantId}/inventory/balances`, token, signal),
  });

const MOVEMENT_LABEL: Record<string, string> = {
  receipt: 'Received',
  production_consumption: 'Used in production',
  waste_raw: 'Waste',
  waste_prepared: 'Waste',
  count_adjustment: 'Count adjustment',
  transfer_out: 'Sent to another restaurant',
  transfer_in: 'Received by transfer',
  correction: 'Correction',
};

export function StockLevels(props: Props) {
  const { restaurantId, token } = props;
  const [filter, setFilter] = useState('');
  const balances = useBalances(props);
  const movements = useQuery({
    queryKey: ['movements', restaurantId],
    queryFn: ({ signal }) =>
      get<StockMovementView[]>(
        `/v1/restaurants/${restaurantId}/inventory/movements?limit=50`,
        token,
        signal,
      ),
  });
  if (balances.isPending) return <Spinner label="Loading stock" />;
  if (balances.isError)
    return <EmptyState title="Cannot load stock" hint={balances.error.message} />;
  const needle = filter.trim().toLowerCase();
  const rows = balances.data.filter(
    (b) => !needle || b.name.toLowerCase().includes(needle) || b.sku.toLowerCase().includes(needle),
  );
  return (
    <div className="space-y-5">
      <Card className="p-4">
        <label className="block text-sm">
          <span className="font-medium">Find an item</span>
          <input
            className={inputClass}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-muted">
                <th className="py-1 pr-3 font-medium">Item</th>
                <th className="py-1 pr-3 text-right font-medium">On hand</th>
                <th className="py-1 pr-3 text-right font-medium">Reserved</th>
                <th className="py-1 text-right font-medium">Available</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.inventoryItemId} className="border-t border-line" data-sku={b.sku}>
                  <td className="py-1.5 pr-3">
                    {b.name} <span className="text-ink-subtle">({b.baseUnit})</span>
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums" data-testid="on-hand">
                    {trimQuantity(b.onHand)}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {trimQuantity(b.reserved)}
                  </td>
                  <td
                    className={clsx(
                      'py-1.5 text-right tabular-nums',
                      b.available.startsWith('-') && 'font-bold text-danger',
                    )}
                  >
                    {trimQuantity(b.available)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <section aria-label="Recent movements">
        <h2 className="mb-2 font-bold">Recent movements</h2>
        {movements.isPending ? (
          <Spinner label="Loading movements" />
        ) : movements.isError ? (
          <EmptyState title="Cannot load movements" hint={movements.error.message} />
        ) : movements.data.length === 0 ? (
          <EmptyState className="py-6" title="No movements yet" />
        ) : (
          <Card className="divide-y divide-line">
            {movements.data.map((m) => (
              <div key={m.id} className="flex justify-between gap-3 px-3 py-1.5 text-sm">
                <span>
                  {m.name}{' '}
                  <span className="text-ink-muted">
                    · {MOVEMENT_LABEL[m.movementType] ?? m.movementType.replace(/_/g, ' ')} ·{' '}
                    {new Date(m.occurredAt).toLocaleString('en-AU')}
                  </span>
                </span>
                <span className="tabular-nums">{trimQuantity(m.quantityDelta)}</span>
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}

interface ReceiptLine {
  key: number;
  inventoryItemId: string;
  quantity: string;
  lotCode: string;
  expiresOn: string;
}

export function GoodsReceiptForm(props: Props) {
  const { restaurantId, token } = props;
  const qc = useQueryClient();
  const balances = useBalances(props);
  const [supplier, setSupplier] = useState('');
  const [reference, setReference] = useState('');
  const [nextKey, setNextKey] = useState(1);
  const blank = (key: number): ReceiptLine => ({
    key,
    inventoryItemId: '',
    quantity: '',
    lotCode: '',
    expiresOn: '',
  });
  const [lines, setLines] = useState<ReceiptLine[]>([blank(0)]);
  const attempt = useAttemptKey();

  const patch = (key: number, p: Partial<ReceiptLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const ids = lines.map((l) => l.inventoryItemId).filter(Boolean);
  const duplicated = new Set(ids).size !== ids.length;
  const valid =
    !duplicated &&
    lines.length > 0 &&
    lines.every((l) => l.inventoryItemId && isPositiveQuantity(l.quantity));

  const receive = useMutation({
    mutationFn: async (body: GoodsReceiptRequest) =>
      (
        await api<GoodsReceiptView>(`/v1/restaurants/${restaurantId}/inventory/receipts`, {
          method: 'POST',
          token,
          body,
          idempotencyKey: attempt.keyFor(body),
        })
      ).data,
    onSuccess: () => {
      attempt.settle();
      setSupplier('');
      setReference('');
      setLines([blank(nextKey)]);
      setNextKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: ['balances', restaurantId] });
      void qc.invalidateQueries({ queryKey: ['movements', restaurantId] });
    },
    onError: (err) => attempt.settle(err),
  });

  if (balances.isPending) return <Spinner label="Loading items" />;
  if (balances.isError)
    return <EmptyState title="Cannot load items" hint={balances.error.message} />;

  return (
    <Card className="p-4">
      <h2 className="font-bold">Receive goods</h2>
      <form
        aria-label="Receive goods"
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || receive.isPending) return;
          receive.mutate({
            ...(supplier.trim() ? { supplierName: supplier.trim() } : {}),
            ...(reference.trim() ? { reference: reference.trim() } : {}),
            lines: lines.map((l) => ({
              inventoryItemId: l.inventoryItemId,
              quantity: l.quantity.trim(),
              ...(l.lotCode.trim() ? { lotCode: l.lotCode.trim() } : {}),
              ...(l.expiresOn ? { expiresOn: l.expiresOn } : {}),
            })),
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">Supplier (optional)</span>
            <input
              className={inputClass}
              maxLength={120}
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Delivery reference (optional)</span>
            <input
              className={inputClass}
              maxLength={120}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
        </div>
        {lines.map((l, i) => {
          const unit = balances.data.find((b) => b.inventoryItemId === l.inventoryItemId)?.baseUnit;
          return (
            <fieldset
              key={l.key}
              aria-label={`Delivery line ${i + 1}`}
              className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-4"
            >
              <label className="block text-sm sm:col-span-4">
                <span className="font-medium">Item</span>
                <select
                  className={inputClass}
                  value={l.inventoryItemId}
                  onChange={(e) => patch(l.key, { inventoryItemId: e.target.value })}
                >
                  <option value="">Choose an item</option>
                  {balances.data.map((b) => (
                    <option key={b.inventoryItemId} value={b.inventoryItemId}>
                      {b.name} ({b.baseUnit})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="font-medium">Quantity{unit ? ` (${unit})` : ''}</span>
                <input
                  inputMode="decimal"
                  className={inputClass}
                  value={l.quantity}
                  onChange={(e) => patch(l.key, { quantity: e.target.value })}
                />
              </label>
              <label className="block text-sm">
                <span className="font-medium">Lot (optional)</span>
                <input
                  className={inputClass}
                  maxLength={64}
                  value={l.lotCode}
                  onChange={(e) => patch(l.key, { lotCode: e.target.value })}
                />
              </label>
              <label className="block text-sm">
                <span className="font-medium">Expires (optional)</span>
                <input
                  type="date"
                  className={inputClass}
                  value={l.expiresOn}
                  onChange={(e) => patch(l.key, { expiresOn: e.target.value })}
                />
              </label>
              <div className="flex items-end">
                {lines.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </fieldset>
          );
        })}
        {duplicated && (
          <p role="alert" className="text-sm text-danger">
            Each item can appear once on a delivery.
          </p>
        )}
        {receive.isError && outcomeUnknown(receive.error) && (
          <p role="alert" className="text-sm font-medium text-danger">
            {OUTCOME_UNKNOWN_HINT}
          </p>
        )}
        {receive.isError && (
          <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">
            {receive.error.message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={() => {
              setLines((ls) => [...ls, blank(nextKey)]);
              setNextKey((k) => k + 1);
            }}
          >
            Add another item
          </Button>
          <Button type="submit" size="lg" loading={receive.isPending} disabled={!valid}>
            Record delivery
          </Button>
        </div>
      </form>
      {receive.isSuccess && (
        <div
          role="status"
          data-testid="receipt-result"
          className="mt-3 rounded-lg bg-canvas p-3 text-sm"
        >
          <p className="font-semibold">Delivery recorded</p>
          <ul>
            {receive.data.lines.map((l) => (
              <li key={l.sku}>
                {trimQuantity(l.quantity)} × {l.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function StockCountForm(props: Props) {
  const { restaurantId, token } = props;
  const qc = useQueryClient();
  const balances = useBalances(props);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const attempt = useAttemptKey();

  // Blank means "not counted", never zero: it is left out of the request.
  const entered = Object.entries(counted).filter(([, v]) => v.trim() !== '');
  const valid = entered.length > 0 && entered.every(([, v]) => isQuantity(v));

  const submit = useMutation({
    mutationFn: async (body: StockCountRequest) =>
      (
        await api<StockCountView>(`/v1/restaurants/${restaurantId}/inventory/counts`, {
          method: 'POST',
          token,
          body,
          idempotencyKey: attempt.keyFor(body),
        })
      ).data,
    onSuccess: () => {
      attempt.settle();
      setCounted({});
      void qc.invalidateQueries({ queryKey: ['balances', restaurantId] });
      void qc.invalidateQueries({ queryKey: ['movements', restaurantId] });
    },
    onError: (err) => attempt.settle(err),
  });

  if (balances.isPending) return <Spinner label="Loading items" />;
  if (balances.isError)
    return <EmptyState title="Cannot load items" hint={balances.error.message} />;

  const needle = filter.trim().toLowerCase();
  const rows = balances.data.filter(
    (b) =>
      counted[b.inventoryItemId]?.trim() ||
      !needle ||
      b.name.toLowerCase().includes(needle) ||
      b.sku.toLowerCase().includes(needle),
  );

  return (
    <Card className="p-4">
      <h2 className="font-bold">Stock count</h2>
      <p className="text-sm text-ink-muted">
        Enter what you counted. Items left blank are not changed. The difference is worked out
        against stock on hand when you submit.
      </p>
      <label className="mt-3 block text-sm">
        <span className="font-medium">Find an item</span>
        <input className={inputClass} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      <form
        aria-label="Stock count"
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || submit.isPending) return;
          submit.mutate({
            lines: entered.map(([inventoryItemId, v]) => ({
              inventoryItemId,
              counted: v.trim(),
            })),
          });
        }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-muted">
                <th className="py-1 pr-3 font-medium">Item</th>
                <th className="py-1 pr-3 text-right font-medium">On hand</th>
                <th className="py-1 pr-3 font-medium">Counted</th>
                <th className="py-1 text-right font-medium">Difference</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const v = counted[b.inventoryItemId] ?? '';
                const ok = v.trim() !== '' && isQuantity(v);
                const diff = ok ? parseDecimalQty(v) - parseDecimalQty(b.onHand) : null;
                return (
                  <tr key={b.inventoryItemId} className="border-t border-line">
                    <td className="py-1.5 pr-3">
                      {b.name} <span className="text-ink-subtle">({b.baseUnit})</span>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {trimQuantity(b.onHand)}
                    </td>
                    <td className="py-1.5 pr-3">
                      <input
                        aria-label={`Counted ${b.name}`}
                        inputMode="decimal"
                        className="h-9 w-28 rounded-lg border border-line px-2 text-right"
                        value={v}
                        onChange={(e) =>
                          setCounted((c) => ({ ...c, [b.inventoryItemId]: e.target.value }))
                        }
                      />
                    </td>
                    <td
                      className={clsx(
                        'py-1.5 text-right tabular-nums',
                        diff !== null && diff !== 0 && 'font-semibold text-danger',
                      )}
                    >
                      {diff === null ? '' : trimQuantity(formatDecimalQty(diff))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {entered.length > 0 && !valid && (
          <p role="alert" className="mt-2 text-sm text-danger">
            Use numbers with up to 3 decimal places.
          </p>
        )}
        {submit.isError && outcomeUnknown(submit.error) && (
          <p role="alert" className="mt-2 text-sm font-medium text-danger">
            {OUTCOME_UNKNOWN_HINT}
          </p>
        )}
        {submit.isError && (
          <p role="alert" className="mt-2 rounded-lg bg-danger-soft p-3 text-sm text-danger">
            {submit.error.message}
          </p>
        )}
        <Button
          type="submit"
          size="lg"
          className="mt-3"
          loading={submit.isPending}
          disabled={!valid}
        >
          Submit count ({entered.length})
        </Button>
      </form>
      {submit.isSuccess && (
        <div
          role="status"
          data-testid="count-result"
          className="mt-3 rounded-lg bg-canvas p-3 text-sm"
        >
          <p className="font-semibold">
            Count recorded · net variance {money(submit.data.varianceCents)}
            {submit.data.approvedBy && ` · approved by ${submit.data.approvedBy}`}
          </p>
          <ul>
            {submit.data.lines.map((l) => (
              <li key={l.sku}>
                {l.name}: expected {trimQuantity(l.expected)}, counted {trimQuantity(l.counted)},
                variance {trimQuantity(l.variance)} ({money(l.varianceCents)})
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
