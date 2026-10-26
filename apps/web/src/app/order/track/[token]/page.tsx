'use client';

import type { OrderView } from '@kitchos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, ChefHat, CreditCard, PackageCheck, Receipt } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { Badge, Button, Card, ErrorState, Logo, Spinner } from '@/components/ui';
import { api, get, newIdempotencyKey } from '@/lib/api';
import { FULFILMENT_LABEL, money, ORDER_STATUS_LABEL } from '@/lib/format';

const STEPS = [
  { status: 'accepted', label: 'Received', icon: Receipt },
  { status: 'in_preparation', label: 'Preparing', icon: ChefHat },
  { status: 'ready', label: 'Ready', icon: PackageCheck },
  { status: 'completed', label: 'Collected', icon: Check },
] as const;
const ORDER: Record<string, number> = {
  pending_payment: -1,
  accepted: 0,
  in_preparation: 1,
  ready: 2,
  completed: 3,
};

export default function TrackOrderPage() {
  const { token } = useParams<{ token: string }>();
  const qc = useQueryClient();
  const order = useQuery({
    queryKey: ['public-order', token],
    queryFn: ({ signal }) => get<OrderView>(`/v1/public/orders/${token}`, null, signal),
    refetchInterval: (q) =>
      q.state.data && ['completed', 'cancelled'].includes(q.state.data.status) ? false : 3_000,
  });
  const retryKey = useMemo(() => newIdempotencyKey(), [order.data?.payment?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = useMutation({
    mutationFn: (paymentToken: string) =>
      api<OrderView>(`/v1/public/orders/${token}/payments`, {
        method: 'POST',
        idempotencyKey: `${retryKey}-${paymentToken}`,
        body: { method: 'card', paymentToken },
        acceptStatuses: [402],
      }),
    onSuccess: (res) => qc.setQueryData(['public-order', token], res.data),
  });

  if (order.isPending) return <Spinner label="Finding your order" />;
  if (order.isError)
    return (
      <div className="p-6">
        <ErrorState message={order.error.message} onRetry={() => void order.refetch()} />
      </div>
    );
  const o = order.data;
  const step = ORDER[o.status] ?? -1;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <Link href="/" aria-label="KitchOS home">
        <Logo />
      </Link>
      <Card className="mt-6 overflow-hidden">
        <div
          className={clsx(
            'p-6 text-center',
            o.status === 'ready' || o.status === 'completed'
              ? 'bg-ok-soft'
              : o.status === 'cancelled'
                ? 'bg-danger-soft'
                : 'bg-brand-soft',
          )}
        >
          <p className="text-sm font-medium text-ink-muted">
            {o.restaurantName} · {FULFILMENT_LABEL[o.fulfilmentType]}
          </p>
          <p className="mt-1 text-sm">Order number</p>
          <p className="text-6xl font-black tracking-tight" aria-live="polite">
            {o.orderNumber}
          </p>
          <p className="mt-2 text-lg font-semibold" aria-live="polite" data-testid="order-status">
            {ORDER_STATUS_LABEL[o.status]}
          </p>
          {o.customerName && <p className="text-sm text-ink-muted">for {o.customerName}</p>}
        </div>

        {o.status !== 'cancelled' && o.status !== 'pending_payment' && (
          <ol className="grid grid-cols-4 border-y border-line" aria-label="Order progress">
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              const done = step >= i;
              return (
                <li
                  key={s.status}
                  className={clsx(
                    'flex flex-col items-center gap-1 py-4 text-xs font-medium',
                    done ? 'text-ok' : 'text-ink-subtle',
                  )}
                  aria-current={step === i ? 'step' : undefined}
                >
                  <Icon className="size-5" aria-hidden />
                  {s.label}
                </li>
              );
            })}
          </ol>
        )}

        {o.status === 'pending_payment' && (
          <div className="space-y-3 border-y border-line p-5">
            <p className="flex items-center gap-2 font-semibold">
              <CreditCard className="size-5" aria-hidden /> Payment needed
            </p>
            {o.payment?.status === 'failed' && (
              <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">
                Your card was declined ({o.payment.failureReason?.replace(/_/g, ' ')}). Nothing has
                been charged and your order is on hold.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button loading={retry.isPending} onClick={() => retry.mutate('tok_sandbox_approve')}>
                Pay with Visa 4242 (sandbox)
              </Button>
              <Button
                variant="secondary"
                loading={retry.isPending}
                onClick={() => retry.mutate('tok_sandbox_mastercard')}
              >
                Mastercard 4444 (sandbox)
              </Button>
            </div>
            {retry.isError && <p className="text-sm text-danger">{retry.error.message}</p>}
          </div>
        )}

        <div className="p-5">
          <h2 className="mb-2 font-semibold">Items</h2>
          <ul className="divide-y divide-line text-sm">
            {o.lines.map((l) => (
              <li key={l.id} className="flex justify-between gap-3 py-2">
                <div>
                  <p className="font-medium">
                    {l.quantity} × {l.name}
                  </p>
                  {[
                    ...l.modifiers.map((m) => m.name),
                    ...l.components.flatMap((c) => c.modifiers.map((m) => `${c.name}: ${m.name}`)),
                  ].length > 0 && (
                    <p className="text-xs text-ink-muted">
                      {[
                        ...l.modifiers.map((m) => m.name),
                        ...l.components.flatMap((c) =>
                          c.modifiers.map((m) => `${c.name}: ${m.name}`),
                        ),
                      ].join(', ')}
                    </p>
                  )}
                </div>
                <span>{money(l.lineTotalCents)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
            <div className="flex justify-between font-semibold">
              <dt>Total</dt>
              <dd>{money(o.totalCents)}</dd>
            </div>
            <div className="flex justify-between text-ink-muted">
              <dt>Includes GST</dt>
              <dd>{money(o.taxCents)}</dd>
            </div>
            {o.payment && (
              <div className="flex justify-between text-ink-muted">
                <dt>Payment</dt>
                <dd className="flex items-center gap-2">
                  {o.payment.cardBrand} •••• {o.payment.cardLast4}
                  <Badge
                    tone={
                      o.payment.status === 'captured'
                        ? 'ok'
                        : o.payment.status === 'failed'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {o.payment.status}
                  </Badge>
                </dd>
              </div>
            )}
          </dl>
          <p className="mt-4 text-xs text-ink-subtle">
            Placed {new Date(o.placedAt).toLocaleString('en-AU')}. This page updates automatically.
          </p>
        </div>
      </Card>
    </div>
  );
}
