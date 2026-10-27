'use client';

import type { OrderView } from '@kitchos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
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
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<(typeof REASONS)[number][0]>('quality');
  // One key per refund attempt; kept across network errors so a retry never refunds twice.
  const key = useRef(newIdempotencyKey());
  const parsed = amount.trim() === '' ? refundable : dollarsToCents(amount);
  const valid = parsed !== null && parsed > 0 && parsed <= refundable;

  const refund = useMutation({
    mutationFn: () =>
      api<OrderView>(`/v1/restaurants/${restaurantId}/orders/${order.id}/refunds`, {
        method: 'POST',
        token,
        idempotencyKey: key.current,
        // Blank amount: let the server refund whatever is still refundable (never a stale figure).
        body: amount.trim() === '' ? { reason } : { amountCents: parsed, reason },
      }),
    onSuccess: () => {
      key.current = newIdempotencyKey();
      setOpen(false);
      setAmount('');
      void qc.invalidateQueries({ queryKey: ['history', restaurantId] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        key.current = newIdempotencyKey();
        // The list may be stale (e.g. someone else refunded meanwhile): refresh it.
        void qc.invalidateQueries({ queryKey: ['history', restaurantId] });
      }
    },
  });

  return (
    <div data-testid="order-card" data-order-number={order.orderNumber}>
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
            className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]"
            aria-label={`Refund order ${order.orderNumber}`}
            onSubmit={(e) => {
              e.preventDefault();
              if (valid && !refund.isPending) refund.mutate();
            }}
          >
            <input
              inputMode="decimal"
              aria-label="Refund amount"
              placeholder={`${money(refundable)} (all)`}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-10 rounded-lg border border-line px-3 text-sm"
            />
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
              Refund {valid ? money(parsed) : ''}
            </Button>
            {refund.isError && (
              <p role="alert" className="text-sm text-danger sm:col-span-4">
                {refund.error.message}
              </p>
            )}
          </form>
        )}
      </Card>
    </div>
  );
}
