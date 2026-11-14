'use client';

import type { DayCloseView, FailedEventView } from '@kitchos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { StaffGate } from '@/components/staff-gate';
import { Badge, Button, Card, EmptyState, Logo, Spinner } from '@/components/ui';
import { api, get } from '@/lib/api';
import { money } from '@/lib/format';
import type { StaffSession } from '@/lib/session';

export default function ClosePage() {
  return <StaffGate>{(session) => <Close session={session} />}</StaffGate>;
}

/** The day before a business date, on the calendar: no timezone involved. */
function previousDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function Close({ session }: { session: StaffSession }) {
  const { restaurantId } = useParams<{ restaurantId: string }>();
  const token = session.accessToken;
  const restaurant = session.me.restaurants.find((r) => r.id === restaurantId);
  const canClose = restaurant?.permissions.includes('day.close') ?? false;
  const [day, setDay] = useState<string | null>(null);

  const today = useQuery({
    queryKey: ['business-date', restaurantId],
    queryFn: ({ signal }) =>
      get<{ businessDate: string }>(
        `/v1/restaurants/${restaurantId}/accounting/business-date`,
        token,
        signal,
      ),
  });
  // Only a day that has ended can close, so start on yesterday.
  useEffect(() => {
    if (today.data && day === null) setDay(previousDay(today.data.businessDate));
  }, [today.data, day]);

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
          <h1 className="font-bold leading-tight">Day close</h1>
          <p className="text-xs text-ink-muted">{restaurant?.name}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span>Business day</span>
          <input
            type="date"
            value={day ?? ''}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            className="h-10 rounded-lg border border-line px-2"
          />
        </label>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 p-4">
        {today.isError ? (
          <EmptyState title="Cannot load the business day" hint={today.error.message} />
        ) : day === null ? (
          <Spinner />
        ) : (
          <Day key={day} day={day} restaurantId={restaurantId} token={token} canClose={canClose} />
        )}
      </main>
    </div>
  );
}

function Day({
  day,
  restaurantId,
  token,
  canClose,
}: {
  day: string;
  restaurantId: string;
  token: string;
  canClose: boolean;
}) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState('');
  const key = ['day-close', restaurantId, day];
  const view = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      get<DayCloseView>(`/v1/restaurants/${restaurantId}/days/${day}`, token, signal),
    refetchInterval: 15_000,
  });
  const close = useMutation({
    mutationFn: () =>
      api<DayCloseView>(`/v1/restaurants/${restaurantId}/days/${day}/close`, {
        method: 'POST',
        token,
        body: notes.trim() ? { notes: notes.trim() } : {},
      }),
    // Either way the server's answer is what to show: it may have closed, or a blocker appeared.
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });

  if (view.isPending) return <Spinner label="Loading the day" />;
  if (view.isError) return <EmptyState title="Cannot load the day" hint={view.error.message} />;
  const v = view.data;
  const t = v.totals;
  const failed = v.blockers.some((b) => b.code === 'LEDGER_FAILED');
  const closed = v.status === 'closed';

  return (
    <>
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">{v.businessDate}</h2>
          <span data-testid="day-status">
            <Badge tone={closed ? 'ok' : 'warn'}>{closed ? 'Closed' : 'Open'}</Badge>
          </span>
        </div>
        {closed && (
          <p className="mt-1 text-sm text-ink-muted">
            Closed by {v.closedBy} · {new Date(v.closedAt!).toLocaleString('en-AU')}
            {v.notes && ` · ${v.notes}`}
          </p>
        )}
        {v.blockers.length > 0 && (
          <div data-testid="day-blockers" className="mt-3">
            <h3 className="font-semibold">Before this day can close</h3>
            <ul className="mt-1 list-disc pl-5 text-sm text-danger">
              {v.blockers.map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          </div>
        )}
        {v.warnings.length > 0 && (
          <div className="mt-3">
            <h3 className="font-semibold">Worth checking</h3>
            <ul className="mt-1 list-disc pl-5 text-sm text-warn">
              {v.warnings.map((w) => (
                <li key={w.code}>{w.message}</li>
              ))}
            </ul>
          </div>
        )}
        {!closed && canClose && (
          <form
            aria-label="Close the day"
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (v.blockers.length === 0 && !close.isPending) close.mutate();
            }}
          >
            <input
              aria-label="Close notes"
              placeholder="Notes (optional)"
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="h-10 min-w-0 flex-1 rounded-lg border border-line px-3 text-sm"
            />
            <Button type="submit" loading={close.isPending} disabled={v.blockers.length > 0}>
              Close this day
            </Button>
            <p className="w-full text-xs text-ink-muted">
              This cannot be undone. Later corrections post on the day they are made.
            </p>
            {close.isError && (
              <p role="alert" className="w-full text-sm text-danger">
                {close.error.message}
              </p>
            )}
          </form>
        )}
      </Card>

      {failed && <FailedEvents restaurantId={restaurantId} token={token} canRetry={canClose} />}

      <Card className="p-4">
        <h2 className="font-bold">Totals</h2>
        <dl className="mt-2 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2" data-testid="day-totals">
          <Row k="Net sales" v={t.netSalesCents} />
          <Row k="GST" v={t.gstCents} />
          <Row k="Cash taken" v={t.cashTakenCents} />
          <Row k="Card taken" v={t.cardTakenCents} />
          <Row k="Cash rounding" v={t.cashRoundingCents} />
          <Row k="Refunds" v={t.refundsCents} />
          <Row k="Cash refunded" v={t.cashRefundsCents} />
          <Row k="Cost of goods sold" v={t.cogsCents} />
          <Row k="Waste" v={t.wasteCents} />
          <Row k="Stock count variance" v={t.stockVarianceCents} />
          {t.transferShortageCents !== undefined && (
            <Row k="Transfer shortage" v={t.transferShortageCents} />
          )}
          <Row k="Cash short (over)" v={t.cashOverShortCents} />
          <Row k="Petty cash" v={t.pettyCashCents} />
        </dl>
      </Card>

      <section aria-label="Drawers">
        <h2 className="mb-2 font-bold">Drawers</h2>
        {v.drawers.length === 0 ? (
          <EmptyState className="py-6" title="No drawers were opened" />
        ) : (
          <ul className="space-y-2">
            {v.drawers.map((d) => (
              <li key={d.sessionId} data-testid="day-drawer">
                <Card className="p-3 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <p className="font-semibold">
                      {d.drawerName} · {d.openedBy}
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
                    </p>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Row({ k, v }: { k: string; v: number }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-ink-muted">{k}</dt>
      <dd className="tabular-nums">{money(v)}</dd>
    </div>
  );
}

function FailedEvents({
  restaurantId,
  token,
  canRetry,
}: {
  restaurantId: string;
  token: string;
  canRetry: boolean;
}) {
  const qc = useQueryClient();
  const base = `/v1/restaurants/${restaurantId}/accounting/failed-events`;
  const key = ['failed-events', restaurantId];
  const events = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => get<FailedEventView[]>(base, token, signal),
  });
  const retry = useMutation({
    mutationFn: (eventId: string) => api(`${base}/${eventId}/retry`, { method: 'POST', token }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['day-close', restaurantId] });
    },
  });
  return (
    <section aria-label="Failed postings">
      <Card className="p-4">
        <h2 className="font-bold">Failed postings</h2>
        <ul className="mt-2 divide-y divide-line text-sm">
          {events.data?.map((e) => (
            <li key={e.eventId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {e.eventType} · {new Date(e.occurredAt).toLocaleString('en-AU')}
                <span className="block text-xs text-ink-muted">{e.lastError}</span>
              </span>
              {canRetry && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate(e.eventId)}
                >
                  Retry
                </Button>
              )}
            </li>
          ))}
        </ul>
        {(events.isError || retry.isError) && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {(events.error ?? retry.error)?.message}
          </p>
        )}
      </Card>
    </section>
  );
}
