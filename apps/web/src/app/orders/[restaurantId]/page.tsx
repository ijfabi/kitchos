'use client';

import type { OrderView } from '@kitchos/contracts';
import { itemRefundCents } from '@kitchos/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { PreparedWaste, type WasteChoice } from '@/components/order/prepared-waste';
import { StaffGate } from '@/components/staff-gate';
import { Badge, Button, Card, EmptyState, Logo, Spinner } from '@/components/ui';
import { api, ApiError, get, newIdempotencyKey } from '@/lib/api';
import { dollarsToCents, FULFILMENT_LABEL, money, ORDER_STATUS_LABEL } from '@/lib/format';
import type { StaffSession } from '@/lib/session';

const REASONS = [
  ['quality', 'Quality'],
  ['order_error', 'Order error'],
  ['customer_complaint', 'Customer complaint'],
  ['cancelled_order', 'Cancelled order'],
  ['duplicate_charge', 'Duplicate charge'],
  ['other', 'Other'],
] as const;

export default function OrdersPage() {
  return <StaffGate>{(session) => <Orders session={session} />}</StaffGate>;
}

function Orders({ session }: { session: StaffSession }) {
  const { restaurantId } = useParams<{ restaurantId: string }>();
  const token = session.accessToken;
  const restaurant = session.me.restaurants.find((r) => r.id === restaurantId);
  const canRefund = restaurant?.permissions.includes('payments.refund') ?? false;
  const orders = useQuery({
    queryKey: ['history', restaurantId],
    queryFn: ({ signal }) =>
      get<OrderView[]>(
        `/v1/restaurants/${restaurantId}/orders?status=completed,cancelled&limit=50`,
        token,
        signal,
      ),
  });

  return (
    <div className="min-h-dvh">
      <header className="flex items-center gap-3 border-b border-line bg-paper px-4 py-3">
        <Link
          href="/staff"
          className="rounded-md p-2 text-ink-muted hover:bg-canvas"
          aria-label="Back to workspaces"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <Logo />
        <div>
          <h1 className="font-bold leading-tight">Orders &amp; refunds</h1>
          <p className="text-xs text-ink-muted">
            {restaurant?.name} · handed over and cancelled orders
          </p>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-3 p-4">
        {orders.isPending ? (
          <Spinner label="Loading orders" />
        ) : orders.isError ? (
          <EmptyState title="Cannot load orders" hint={orders.error.message} />
        ) : orders.data.length === 0 ? (
          <EmptyState title="No finished orders yet" />
        ) : (
          orders.data.map((o) => (
            <OrderRow
              key={o.id}
              order={o}
              restaurantId={restaurantId}
              token={token}
              canRefund={canRefund}
            />
          ))
        )}
      </main>
    </div>
  );
}

function OrderRow({
  order,
  restaurantId,
  token,
  canRefund,
}: {
  order: OrderView;
  restaurantId: string;
  token: string;
  canRefund: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const refundable =
    order.payment && order.payment.status !== 'failed'
      ? order.payment.amountCents - order.payment.refundedCents
      : 0;
  // Refunds are by item: the whole price of the items, which then count as waste. By amount is for
  // money-only cases such as a duplicate charge.
  const [mode, setMode] = useState<'items' | 'amount'>('items');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<(typeof REASONS)[number][0]>('quality');
  const [waste, setWaste] = useState<WasteChoice | null>(null);
  const onWaste = useCallback((w: WasteChoice | null) => setWaste(w), []);
  // One key per refund attempt, with the exact body it was first sent with. A retry after a
  // lost response resends both unchanged, even if the form has changed since, so the server
  // replays the original refund instead of making a second one.
  const attempt = useRef<{ key: string; body: object } | null>(null);

  const items = order.lines
    .filter((l) => (counts[l.id] ?? 0) > 0)
    .map((l) => ({ orderLineId: l.id, quantity: counts[l.id]! }));
  // What the server will charge back: the same exact rule, shown before sending.
  const itemsCents = order.lines.reduce((sum, l) => {
    const n = counts[l.id] ?? 0;
    return n > 0 ? sum + itemRefundCents(l.netCents, l.quantity, l.refundedQuantity, n) : sum;
  }, 0);
  const parsed = amount.trim() === '' ? refundable : dollarsToCents(amount);
  const valid =
    mode === 'items'
      ? items.length > 0 && itemsCents > 0 && itemsCents <= refundable
      : parsed !== null && parsed > 0 && parsed <= refundable && waste !== null;
  const shown = mode === 'items' ? itemsCents : (parsed ?? 0);

  const refund = useMutation({
    mutationFn: () => {
      attempt.current ??= {
        key: newIdempotencyKey(),
        body:
          mode === 'items'
            ? // The amount shown: the server refuses it if the price has changed since.
              { reason, items, expectedAmountCents: itemsCents }
            : {
                // Blank amount: the server refunds whatever is still refundable (never a stale figure).
                ...(amount.trim() === '' ? {} : { amountCents: parsed }),
                reason,
                ...(waste ?? {}),
              },
      };
      return api<OrderView>(`/v1/restaurants/${restaurantId}/orders/${order.id}/refunds`, {
        method: 'POST',
        token,
        idempotencyKey: attempt.current.key,
        body: attempt.current.body,
      });
    },
    onSuccess: () => {
      attempt.current = null;
      setOpen(false);
      setAmount('');
      setCounts({});
      void qc.invalidateQueries({ queryKey: ['history', restaurantId] });
    },
    onError: (err) => {
      // A definite refusal ends the attempt; the next one is new. Not for a key still in use or
      // reused, where the first request may well have gone through.
      const definite =
        err instanceof ApiError &&
        err.status >= 400 &&
        err.status < 500 &&
        err.code !== 'IDEMPOTENCY_KEY_REUSED' &&
        err.code !== 'IDEMPOTENT_REQUEST_IN_PROGRESS';
      if (definite) {
        attempt.current = null;
        // The list may be stale (e.g. someone else refunded meanwhile): refresh it.
        void qc.invalidateQueries({ queryKey: ['history', restaurantId] });
      }
    },
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: ['prepared-items', restaurantId, order.id] }),
  });

  // Replacing an item: the original counts as waste and a fresh portion is made (a remake).
  // One key per item until a definite answer, so a retry after a lost response cannot remake twice.
  const replaceKeys = useRef(new Map<string, string>());
  const replace = useMutation({
    mutationFn: ({ lineId }: { lineId: string }) => {
      if (!replaceKeys.current.has(lineId)) replaceKeys.current.set(lineId, newIdempotencyKey());
      return api<{ status: string }>(`/v1/restaurants/${restaurantId}/inventory/waste`, {
        method: 'POST',
        token,
        idempotencyKey: replaceKeys.current.get(lineId)!,
        body: {
          kind: 'prepared_item',
          orderLineId: lineId,
          quantity: 1,
          remake: true,
          reason: 'poor_quality',
        },
      });
    },
    onSuccess: (_res, { lineId }) => replaceKeys.current.delete(lineId),
    onError: (err, { lineId }) => {
      const definite =
        err instanceof ApiError &&
        err.status >= 400 &&
        err.status < 500 &&
        err.code !== 'IDEMPOTENCY_KEY_REUSED' &&
        err.code !== 'IDEMPOTENT_REQUEST_IN_PROGRESS';
      if (definite) replaceKeys.current.delete(lineId);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['history', restaurantId] });
      void qc.invalidateQueries({ queryKey: ['prepared-items', restaurantId, order.id] });
    },
  });

  return (
    <div data-testid="order-card" data-order-id={order.id} data-order-number={order.orderNumber}>
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xl font-black tabular-nums">#{order.orderNumber}</p>
            <p className="text-sm text-ink-muted">
              {FULFILMENT_LABEL[order.fulfilmentType]} · {order.customerName ?? 'Guest'} ·{' '}
              {money(order.totalCents)}
            </p>
          </div>
          <div className="flex flex-wrap gap-1">
            <Badge tone={order.status === 'completed' ? 'ok' : 'danger'}>
              {ORDER_STATUS_LABEL[order.status]}
            </Badge>
            {order.payment && order.payment.refundedCents > 0 && (
              <Badge tone="warn">Refunded {money(order.payment.refundedCents)}</Badge>
            )}
          </div>
        </div>
        {order.refunds.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-ink-muted">
            {order.refunds.map((r) => (
              <li key={r.id}>
                {money(r.amountCents)} {r.method} refund ({r.reason.replace(/_/g, ' ')}) by{' '}
                {r.requestedBy} ·{' '}
                {r.treatment === 'sales_return' ? 'sales return' : 'deposit returned'}
                {r.items.length > 0 &&
                  ` · ${r.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}`}
                {r.cashReturnedCents !== null &&
                  r.cashReturnedCents !== r.amountCents &&
                  ` · ${money(r.cashReturnedCents)} cash handed back`}
              </li>
            ))}
          </ul>
        )}
        {canRefund && refundable > 0 && !open && (
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setOpen(true)}>
            <Undo2 className="size-4" aria-hidden /> Refund
          </Button>
        )}
        {open && (
          <form
            className="mt-3 space-y-2"
            aria-label={`Refund order ${order.orderNumber}`}
            onSubmit={(e) => {
              e.preventDefault();
              if (valid && !refund.isPending) refund.mutate();
            }}
          >
            <div role="group" aria-label="Refund by" className="flex gap-2">
              {(
                [
                  ['items', 'By item'],
                  ['amount', 'By amount'],
                ] as const
              ).map(([m, label]) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={mode === m ? 'primary' : 'secondary'}
                  aria-pressed={mode === m}
                  onClick={() => {
                    setMode(m);
                    attempt.current = null;
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
            {mode === 'items' ? (
              <fieldset className="rounded-lg border border-line p-3 text-sm">
                <legend className="px-1 font-semibold">
                  Items to refund (they count as waste)
                </legend>
                <ul className="space-y-1">
                  {order.lines.map((l) => {
                    const left = l.quantity - l.refundedQuantity;
                    return (
                      <li key={l.id} className="flex flex-wrap items-center justify-between gap-2">
                        <label htmlFor={`refund-${l.id}`}>
                          {l.name}{' '}
                          <span className="text-ink-muted">
                            ({left} of {l.quantity} left)
                          </span>
                        </label>
                        <span className="flex items-center gap-2">
                          <input
                            id={`refund-${l.id}`}
                            type="number"
                            min={0}
                            max={left}
                            step={1}
                            disabled={left === 0}
                            value={counts[l.id] ?? 0}
                            onChange={(e) => {
                              const n = Math.trunc(Number(e.target.value));
                              const v = Number.isFinite(n) ? Math.min(Math.max(n, 0), left) : 0;
                              setCounts((c) => ({ ...c, [l.id]: v }));
                            }}
                            className="h-9 w-16 rounded-lg border border-line px-2 text-right"
                          />
                          {order.status === 'completed' && l.kind === 'item' && left > 0 && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              loading={replace.isPending && replace.variables?.lineId === l.id}
                              onClick={() => replace.mutate({ lineId: l.id })}
                            >
                              <RefreshCw className="size-4" aria-hidden /> Replace
                            </Button>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            ) : (
              <>
                <input
                  inputMode="decimal"
                  aria-label="Refund amount"
                  placeholder={`${money(refundable)} (all)`}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="h-10 w-full rounded-lg border border-line px-3 text-sm"
                />
                <PreparedWaste
                  restaurantId={restaurantId}
                  orderId={order.id}
                  token={token}
                  defaultAll={false}
                  onChange={onWaste}
                />
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Refund reason"
                value={reason}
                onChange={(e) => setReason(e.target.value as typeof reason)}
                className="h-10 rounded-lg border border-line bg-paper px-3 text-sm"
              >
                {REASONS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="danger" loading={refund.isPending} disabled={!valid}>
                Refund {valid ? money(shown) : ''}
              </Button>
            </div>
            {(refund.isError || replace.isError) && (
              <p role="alert" className="text-sm text-danger">
                {(refund.error ?? replace.error)?.message}
              </p>
            )}
            {replace.isSuccess && (
              <p role="status" className="text-sm text-ink-muted">
                Recorded as waste, and a fresh one made. This does not send a kitchen ticket.
                {replace.data.data.status === 'pending_approval' &&
                  ' The waste is above the limit, so a manager needs to approve it.'}
              </p>
            )}
            {mode === 'items' && itemsCents > refundable && (
              <p role="alert" className="text-sm text-danger">
                Those items come to {money(itemsCents)}, but only {money(refundable)} is left to
                refund on this payment (part was refunded by amount).
              </p>
            )}
          </form>
        )}
      </Card>
    </div>
  );
}
