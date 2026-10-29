'use client';

import type { DrawerSessionView } from '@kitchos/contracts';
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

export default function CashPage() {
  return <StaffGate>{(session) => <Cash session={session} />}</StaffGate>;
}

const STATUS = {
  open: ['Open', 'info'],
  pending_approval: ['Needs approval', 'warn'],
  closed: ['Closed', 'ok'],
} as const;

const MOVE_LABEL: Record<string, string> = {
  paid_in: 'Paid in',
  paid_out: 'Paid out',
  safe_drop: 'Safe drop',
};

function Cash({ session }: { session: StaffSession }) {
  const { restaurantId } = useParams<{ restaurantId: string }>();
  const token = session.accessToken;
  const restaurant = session.me.restaurants.find((r) => r.id === restaurantId);
  const sessions = useQuery({
    queryKey: ['drawer-sessions', restaurantId],
    queryFn: ({ signal }) =>
      get<DrawerSessionView[]>(`/v1/restaurants/${restaurantId}/cash/sessions`, token, signal),
    refetchInterval: 15_000,
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
          <h1 className="font-bold leading-tight">Cash drawers</h1>
          <p className="text-xs text-ink-muted">
            {restaurant?.name} · today&apos;s drawers and anything still open or awaiting approval
          </p>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-3 p-4">
        {sessions.isPending ? (
          <Spinner label="Loading drawers" />
        ) : sessions.isError ? (
          <EmptyState title="Cannot load drawers" hint={sessions.error.message} />
        ) : sessions.data.length === 0 ? (
          <EmptyState title="No drawer sessions today" />
        ) : (
          sessions.data.map((s) => (
            <SessionCard
              key={s.id}
              s={s}
              restaurantId={restaurantId}
              token={token}
              isMe={s.openedById === session.me.user.id}
            />
          ))
        )}
      </main>
    </div>
  );
}

function SessionCard({
  s,
  restaurantId,
  token,
  isMe,
}: {
  s: DrawerSessionView;
  restaurantId: string;
  token: string;
  isMe: boolean;
}) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState('');
  const approve = useMutation({
    mutationFn: () =>
      api<DrawerSessionView>(`/v1/restaurants/${restaurantId}/cash/sessions/${s.id}/approve`, {
        method: 'POST',
        token,
        body: { notes: notes.trim() },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['drawer-sessions', restaurantId] }),
  });
  const [label, tone] = STATUS[s.status];
  const e = s.expected;

  return (
    <div data-testid="drawer-session" data-drawer={s.drawerName}>
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-lg font-bold">{s.drawerName}</p>
            <p className="text-sm text-ink-muted">
              {s.openedBy} · opened {new Date(s.openedAt).toLocaleTimeString('en-AU')} ·{' '}
              {s.businessDate}
            </p>
          </div>
          <Badge tone={tone}>{label}</Badge>
        </div>
        {e && (
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <Row k="Float" v={s.openingFloatCents} />
            <Row k="Cash sales" v={e.cashSalesCents} />
            <Row k="Cash refunds" v={-e.cashRefundsCents} />
            <Row k="Paid in" v={e.paidInsCents} />
            <Row k="Paid out" v={-e.paidOutsCents} />
            <Row k="Safe drops" v={-e.safeDropsCents} />
            <Row k="Expected" v={e.expectedCents} strong />
            {s.countedCents !== null && <Row k="Counted" v={s.countedCents} strong />}
            {s.varianceCents !== null && (
              <div className="flex justify-between">
                <dt className="text-ink-muted">Variance</dt>
                <dd
                  className={clsx(
                    'font-bold tabular-nums',
                    s.varianceCents === 0 ? 'text-ok' : 'text-danger',
                  )}
                  data-testid="variance"
                >
                  {money(s.varianceCents)}
                </dd>
              </div>
            )}
          </dl>
        )}
        {s.movements.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-ink-muted">
            {s.movements.map((m) => (
              <li key={m.id}>
                {MOVE_LABEL[m.kind] ?? m.kind} {money(m.amountCents)} · {m.reason} · {m.recordedBy}
              </li>
            ))}
          </ul>
        )}
        {(s.countedBy || s.approvedBy) && (
          <p className="mt-2 text-xs text-ink-muted">
            {s.countedBy && `Counted by ${s.countedBy}`}
            {s.approvedBy && ` · variance approved by ${s.approvedBy}`}
          </p>
        )}
        {s.status === 'pending_approval' &&
          (isMe ? (
            <p className="mt-3 text-sm text-ink-muted">
              Another manager must approve your own drawer&apos;s variance.
            </p>
          ) : (
            <form
              className="mt-3 flex flex-wrap gap-2"
              aria-label={`Approve ${s.drawerName}`}
              onSubmit={(ev) => {
                ev.preventDefault();
                if (notes.trim().length >= 3 && !approve.isPending) approve.mutate();
              }}
            >
              <input
                aria-label="Approval notes"
                placeholder="What was checked (e.g. recounted with cashier)"
                value={notes}
                onChange={(ev) => setNotes(ev.target.value)}
                maxLength={500}
                className="h-10 min-w-0 flex-1 rounded-lg border border-line px-3 text-sm"
              />
              <Button type="submit" loading={approve.isPending} disabled={notes.trim().length < 3}>
                Approve variance
              </Button>
              {approve.isError && (
                <p role="alert" className="w-full text-sm text-danger">
                  {approve.error.message}
                </p>
              )}
            </form>
          ))}
      </Card>
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: number; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-ink-muted">{k}</dt>
      <dd className={clsx('tabular-nums', strong && 'font-bold')}>{money(v)}</dd>
    </div>
  );
}
