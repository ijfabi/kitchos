'use client';

import type { OrderView } from '@kitchos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowLeft, Ban, HandPlatter } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { PreparedWaste, type WasteChoice } from '@/components/order/prepared-waste';
import { StaffGate } from '@/components/staff-gate';
import { Badge, Button, Card, EmptyState, Logo, Spinner } from '@/components/ui';
import { api, ApiError, get } from '@/lib/api';
import { FULFILMENT_LABEL, money, ORDER_STATUS_LABEL } from '@/lib/format';
import { useLiveEvents } from '@/lib/live';
import type { StaffSession } from '@/lib/session';

export default function ExpoPage() {
  return <StaffGate>{(session) => <Expo session={session} />}</StaffGate>;
}

function Expo({ session }: { session: StaffSession }) {
  const { restaurantId } = useParams<{ restaurantId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const token = session.accessToken;
  const restaurant = session.me.restaurants.find((r) => r.id === restaurantId);
  const can = (p: string) => restaurant?.permissions.includes(p) ?? false;

  const orders = useQuery({
    queryKey: ['orders', restaurantId],
    queryFn: ({ signal }) =>
      get<OrderView[]>(
        `/v1/restaurants/${restaurantId}/orders?status=accepted,in_preparation,ready`,
        token,
        signal,
      ),
    refetchInterval: 10_000,
  });
  useLiveEvents(restaurantId, token, () => {
    void qc.invalidateQueries({ queryKey: ['orders', restaurantId] });
    void qc.invalidateQueries({ queryKey: ['prepared-items', restaurantId] });
  });

  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [waste, setWaste] = useState<WasteChoice | null>(null);
  const onWaste = useCallback((w: WasteChoice | null) => setWaste(w), []);
  const onError = (err: Error) => {
    if (err instanceof ApiError && err.status === 401) router.replace('/staff');
    setError(err.message);
  };
  const handoff = useMutation({
    mutationFn: (orderId: string) =>
      api<OrderView>(`/v1/restaurants/${restaurantId}/orders/${orderId}/handoff`, {
        method: 'POST',
        token,
      }),
    onSuccess: () => setError(null),
    onError,
    onSettled: () => qc.invalidateQueries({ queryKey: ['orders', restaurantId] }),
  });
  const cancel = useMutation({
    mutationFn: ({
      orderId,
      reason,
      waste,
    }: {
      orderId: string;
      reason: string;
      waste: WasteChoice | null;
    }) =>
      api<OrderView>(`/v1/restaurants/${restaurantId}/orders/${orderId}/cancel`, {
        method: 'POST',
        token,
        body: waste ? { reason, ...waste } : { reason },
      }),
    onSuccess: () => {
      setError(null);
      setCancelling(null);
    },
    onError,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['orders', restaurantId] });
      void qc.invalidateQueries({ queryKey: ['prepared-items', restaurantId] });
    },
  });

  const all = orders.data ?? [];
  const columns = [
    {
      title: 'In the kitchen',
      items: all.filter((o) => o.status !== 'ready'),
      tone: 'info' as const,
    },
    {
      title: 'Ready for handoff',
      items: all.filter((o) => o.status === 'ready'),
      tone: 'ok' as const,
    },
  ];

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
        <div className="mr-auto">
          <h1 className="font-bold leading-tight">Expo & handoff</h1>
          <p className="text-xs text-ink-muted">{restaurant?.name}</p>
        </div>
      </header>
      {error && (
        <p
          role="alert"
          className="mx-4 mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}
      {orders.isPending ? (
        <Spinner label="Loading orders" />
      ) : (
        <main className="grid gap-4 p-4 lg:grid-cols-2">
          {columns.map((col) => (
            <section key={col.title} aria-labelledby={col.title}>
              <h2 id={col.title} className="mb-3 flex items-center gap-2 font-bold">
                {col.title} <Badge tone={col.tone}>{col.items.length}</Badge>
              </h2>
              {col.items.length === 0 ? (
                <Card>
                  <EmptyState title="No orders" />
                </Card>
              ) : (
                <ul className="space-y-3">
                  {col.items.map((o) => (
                    <li key={o.id}>
                      <Card className={clsx('p-4', o.status === 'ready' && 'border-ok/40')}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-2xl font-black tabular-nums">#{o.orderNumber}</p>
                            <p className="text-sm text-ink-muted">
                              {FULFILMENT_LABEL[o.fulfilmentType]} · {o.customerName ?? 'Guest'} ·{' '}
                              {money(o.totalCents)}
                            </p>
                          </div>
                          <Badge tone={o.status === 'ready' ? 'ok' : 'info'}>
                            {ORDER_STATUS_LABEL[o.status]}
                          </Badge>
                        </div>
                        <ul className="mt-3 space-y-1 text-sm">
                          {o.tasks.map((t) => (
                            <li key={t.id} className="flex items-center justify-between gap-2">
                              <span
                                className={clsx(
                                  t.status === 'done' && 'text-ink-subtle line-through',
                                  t.status === 'cancelled' && 'text-danger line-through',
                                )}
                              >
                                {t.label}
                              </span>
                              <span className="text-xs text-ink-subtle">
                                {t.stationName} · {t.status.replace('_', ' ')}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <div className="mt-4 flex flex-wrap gap-2">
                          {o.status === 'ready' && can('orders.handoff') && (
                            <Button
                              size="lg"
                              loading={handoff.isPending && handoff.variables === o.id}
                              onClick={() => handoff.mutate(o.id)}
                            >
                              <HandPlatter className="size-4" aria-hidden /> Hand off
                            </Button>
                          )}
                          {can('orders.cancel') && (
                            <Button
                              variant="secondary"
                              size="lg"
                              disabled={cancelling === o.id}
                              onClick={() => {
                                setCancelling(o.id);
                                setCancelReason('');
                                setWaste(null);
                              }}
                            >
                              <Ban className="size-4" aria-hidden /> Cancel
                            </Button>
                          )}
                        </div>
                        {cancelling === o.id && (
                          <form
                            aria-label={`Cancel order ${o.orderNumber}`}
                            className="mt-3 space-y-2"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (cancelReason.trim().length >= 3 && waste && !cancel.isPending) {
                                cancel.mutate({
                                  orderId: o.id,
                                  reason: cancelReason.trim(),
                                  waste,
                                });
                              }
                            }}
                          >
                            <input
                              aria-label="Cancel reason"
                              placeholder="Why is it cancelled?"
                              maxLength={500}
                              value={cancelReason}
                              onChange={(e) => setCancelReason(e.target.value)}
                              className="h-10 w-full rounded-lg border border-line px-3 text-sm"
                            />
                            <PreparedWaste
                              restaurantId={restaurantId}
                              orderId={o.id}
                              token={token}
                              defaultAll
                              onChange={onWaste}
                            />
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                variant="ghost"
                                onClick={() => setCancelling(null)}
                              >
                                Keep order
                              </Button>
                              <Button
                                type="submit"
                                variant="danger"
                                loading={cancel.isPending}
                                disabled={cancelReason.trim().length < 3 || !waste}
                              >
                                Cancel order
                              </Button>
                            </div>
                          </form>
                        )}
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </main>
      )}
    </div>
  );
}
