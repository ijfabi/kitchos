'use client';

import type { CurrentShift, ShiftView } from '@kitchos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { StaffGate } from '@/components/staff-gate';
import { Badge, Button, Card, EmptyState, Logo, Spinner } from '@/components/ui';
import { api, get } from '@/lib/api';
import { money } from '@/lib/format';
import type { StaffSession } from '@/lib/session';

export default function ShiftPage() {
  return <StaffGate>{(session) => <Shifts session={session} />}</StaffGate>;
}

function Shifts({ session }: { session: StaffSession }) {
  const { restaurantId } = useParams<{ restaurantId: string }>();
  const token = session.accessToken;
  const restaurant = session.me.restaurants.find((r) => r.id === restaurantId);
  const qc = useQueryClient();
  const base = `/v1/restaurants/${restaurantId}/shifts`;
  const current = useQuery({
    queryKey: ['shift', restaurantId],
    queryFn: ({ signal }) => get<CurrentShift>(`${base}/current`, token, signal),
    refetchInterval: 15_000,
  });
  const today = useQuery({
    queryKey: ['shifts', restaurantId],
    queryFn: ({ signal }) => get<ShiftView[]>(base, token, signal),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['shift', restaurantId] });
    void qc.invalidateQueries({ queryKey: ['shifts', restaurantId] });
  };
  const open = useMutation({
    mutationFn: () => api<ShiftView>(base, { method: 'POST', token }),
    onSettled: refresh,
  });
  const earlier = today.data?.filter((s) => s.status === 'closed') ?? [];

  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-paper px-4 py-3">
        <Link
          href="/staff"
          className="rounded-md p-2 text-ink-muted hover:bg-canvas"
          aria-label="Back to workspaces"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <Logo />
        <div className="mr-auto">
          <h1 className="font-bold leading-tight">Shift</h1>
          <p className="text-xs text-ink-muted">{restaurant?.name}</p>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 p-4">
        {current.isError ? (
          <EmptyState title="Cannot load the shift" hint={current.error.message} />
        ) : current.isPending ? (
          <Spinner label="Loading the shift" />
        ) : current.data.shift ? (
          <Shift
            key={current.data.shift.id}
            shift={current.data.shift}
            base={base}
            token={token}
            onClosed={refresh}
          />
        ) : (
          <Card className="p-4">
            <h2 className="font-bold">No shift is open</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Opening a shift puts you in charge. Drawers already running join it, and it closes
              once every one of them is counted.
            </p>
            <Button className="mt-3" loading={open.isPending} onClick={() => open.mutate()}>
              Open a shift
            </Button>
            {open.isError && (
              <p role="alert" className="mt-2 text-sm text-danger">
                {open.error.message}
              </p>
            )}
          </Card>
        )}
        {earlier.length > 0 && (
          <section aria-label="Earlier shifts today" className="space-y-4">
            <h2 className="font-bold">Earlier today</h2>
            {earlier.map((s) => (
              <Shift key={s.id} shift={s} base={base} token={token} onClosed={refresh} />
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

function Shift({
  shift: s,
  base,
  token,
  onClosed,
}: {
  shift: ShiftView;
  base: string;
  token: string;
  onClosed: () => void;
}) {
  const [notes, setNotes] = useState('');
  const close = useMutation({
    mutationFn: () =>
      api<ShiftView>(`${base}/${s.id}/close`, {
        method: 'POST',
        token,
        body: notes.trim() ? { notes: notes.trim() } : {},
      }),
    // Either way the server's answer is what to show: it closed, or a blocker appeared.
    onSettled: onClosed,
  });
  const closed = s.status === 'closed';
  const t = s.totals;
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });

  return (
    <section aria-label={closed ? `Shift closed at ${time(s.closedAt!)}` : 'Current shift'}>
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">
            {time(s.openedAt)}
            {closed ? ` – ${time(s.closedAt!)}` : ' – now'} · {s.openedBy}
          </h2>
          <span data-testid="shift-status">
            <Badge tone={closed ? 'ok' : 'warn'}>{closed ? 'Closed' : 'Open'}</Badge>
          </span>
        </div>
        {closed && (
          <p className="mt-1 text-sm text-ink-muted">
            Closed by {s.closedBy}
            {s.notes && ` · ${s.notes}`}
          </p>
        )}
        {s.blockers.length > 0 && (
          <div data-testid="shift-blockers" className="mt-3">
            <h3 className="font-semibold">Before this shift can close</h3>
            <ul className="mt-1 list-disc pl-5 text-sm text-danger">
              {s.blockers.map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          </div>
        )}
        {s.warnings.length > 0 && (
          <ul className="mt-3 list-disc pl-5 text-sm text-warn">
            {s.warnings.map((w) => (
              <li key={w.code}>{w.message}</li>
            ))}
          </ul>
        )}
        {!closed && (
          <form
            aria-label="Close the shift"
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (s.blockers.length === 0 && !close.isPending) close.mutate();
            }}
          >
            <input
              aria-label="Handover notes"
              placeholder="Handover notes (optional)"
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="h-10 min-w-0 flex-1 rounded-lg border border-line px-3 text-sm"
            />
            <Button type="submit" loading={close.isPending} disabled={s.blockers.length > 0}>
              Close shift
            </Button>
            {close.isError && (
              <p role="alert" className="w-full text-sm text-danger">
                {close.error.message}
              </p>
            )}
          </form>
        )}
        <dl className="mt-4 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2" data-testid="shift-totals">
          <Row k="Orders placed" v={String(t.ordersPlaced)} />
          <Row k="Cancelled" v={String(t.ordersCancelled)} />
          <Row k="Card taken" v={money(t.cardTakenCents)} />
          <Row k="Cash taken" v={blind(t.cashTakenCents)} testId="shift-cash" />
          <Row k="Refunds" v={money(t.refundsCents)} />
          <Row k="Cash refunded" v={blind(t.cashRefundsCents)} />
          <Row k="Discounts and comps" v={money(t.discountsCents)} />
          <Row k="Cash short (−) / over" v={blind(t.cashVarianceCents)} />
        </dl>
        {t.cashTakenCents === null && (
          <p className="mt-2 text-xs text-ink-muted">
            Cash figures and each person’s sales show once every drawer is counted, so tills are
            still counted blind.
          </p>
        )}
      </Card>

      <h3 className="mb-2 mt-4 font-semibold">Drawers</h3>
      {s.drawers.length === 0 ? (
        <EmptyState className="py-6" title="No drawers in this shift" />
      ) : (
        <ul className="space-y-2">
          {s.drawers.map((d) => (
            <li key={d.sessionId} data-testid="shift-drawer">
              <Card className="p-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <p className="font-semibold">
                    {d.drawerName} · {d.cashier}
                  </p>
                  <Badge tone={d.status === 'closed' ? 'ok' : 'warn'}>
                    {d.status === 'closed'
                      ? 'Closed'
                      : d.status === 'open'
                        ? 'Not counted'
                        : 'Needs approval'}
                  </Badge>
                </div>
                {d.expectedCents !== null && d.countedCents !== null && (
                  <p className="text-ink-muted">
                    Expected {money(d.expectedCents)} · counted {money(d.countedCents)} · variance{' '}
                    <span
                      className={clsx(
                        'font-semibold',
                        d.varianceCents === 0 ? 'text-ok' : 'text-danger',
                      )}
                    >
                      {money(d.varianceCents ?? 0)}
                    </span>
                    {d.approvedBy && ` · approved by ${d.approvedBy}`}
                  </p>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mb-2 mt-4 font-semibold">People</h3>
      {s.people.length === 0 ? (
        <EmptyState className="py-6" title="Nobody has traded in this shift yet" />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <caption className="sr-only">Each person’s part in the shift</caption>
            <thead>
              <tr className="text-left text-ink-muted">
                <th scope="col" className="px-3 py-2 font-medium">
                  Person
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Orders
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Sales
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Discounts
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Refunds
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Drawer variance
                </th>
              </tr>
            </thead>
            <tbody>
              {s.people.map((p) => (
                <tr
                  key={p.userId}
                  className="border-t border-line"
                  data-testid="shift-person"
                  data-person={p.name}
                >
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    {p.name}
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums">{p.ordersPlaced}</td>
                  <td className="px-3 py-2 text-right tabular-nums" data-testid="person-sales">
                    {blind(p.salesCents)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(p.discountsCents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(p.refundsCents)}</td>
                  <td
                    className={clsx(
                      'px-3 py-2 text-right tabular-nums',
                      (p.cashVarianceCents ?? 0) !== 0 && 'text-danger',
                    )}
                  >
                    {p.cashVarianceCents === null ? '—' : money(p.cashVarianceCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}

/** A figure hidden until every drawer is counted. */
function blind(cents: number | null): string {
  return cents === null ? 'After counts' : money(cents);
}

function Row({ k, v, testId }: { k: string; v: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-ink-muted">{k}</dt>
      <dd className="tabular-nums" data-testid={testId}>
        {v}
      </dd>
    </div>
  );
}
