'use client';

import type { JournalEntryView, LedgerReconciliation, TrialBalance } from '@kitchos/contracts';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowLeft, CheckCircle2, CircleAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { StaffGate } from '@/components/staff-gate';
import { Badge, Card, EmptyState, Logo, Spinner } from '@/components/ui';
import { get } from '@/lib/api';
import { money } from '@/lib/format';
import type { StaffSession } from '@/lib/session';

export default function BooksPage() {
  return <StaffGate>{(session) => <Books session={session} />}</StaffGate>;
}

const ENTRY_LABEL: Record<string, string> = {
  payment_receipt: 'Payment received',
  sale_recognition: 'Sale recognised',
  reversal: 'Reversal',
  adjustment: 'Adjustment',
};

function Books({ session }: { session: StaffSession }) {
  const { restaurantId } = useParams<{ restaurantId: string }>();
  const token = session.accessToken;
  const restaurant = session.me.restaurants.find((r) => r.id === restaurantId);
  const base = `/v1/restaurants/${restaurantId}/accounting`;
  // Business dates follow the restaurant's timezone and cutoff, not the browser's clock.
  const today = useQuery({
    queryKey: ['business-date', restaurantId],
    queryFn: ({ signal }) => get<{ businessDate: string }>(`${base}/business-date`, token, signal),
  });
  const [picked, setDay] = useState<string | null>(null);
  const day = picked ?? today.data?.businessDate ?? '';
  const enabled = day !== '';

  const rec = useQuery({
    queryKey: ['reconciliation', restaurantId, day],
    enabled,
    queryFn: ({ signal }) =>
      get<LedgerReconciliation>(`${base}/reconciliation?businessDate=${day}`, token, signal),
    refetchInterval: 5_000,
  });
  const tb = useQuery({
    queryKey: ['trial-balance', restaurantId, day],
    enabled,
    queryFn: ({ signal }) =>
      get<TrialBalance>(`${base}/trial-balance?from=${day}&to=${day}`, token, signal),
    refetchInterval: 5_000,
  });
  const journal = useQuery({
    queryKey: ['journal', restaurantId, day],
    enabled,
    queryFn: ({ signal }) =>
      get<JournalEntryView[]>(`${base}/journal?from=${day}&to=${day}&limit=50`, token, signal),
    refetchInterval: 5_000,
  });

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
          <h1 className="font-bold leading-tight">Books</h1>
          <p className="text-xs text-ink-muted">
            {restaurant?.name} · operational journal (not a statutory P&amp;L)
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          Business date
          <input
            type="date"
            value={day}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            className="h-10 rounded-lg border border-line px-2"
          />
        </label>
      </header>

      <main className="mx-auto grid max-w-6xl gap-4 p-4 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-3 font-bold">Reconciliation</h2>
            {rec.isPending ? (
              <Spinner />
            ) : rec.isError ? (
              <EmptyState title="Unavailable" hint={rec.error.message} />
            ) : (
              <>
                <p
                  className={clsx(
                    'mb-3 flex items-center gap-2 font-semibold',
                    rec.data.reconciled ? 'text-ok' : 'text-warn',
                  )}
                  data-testid="reconciliation-status"
                >
                  {rec.data.reconciled ? (
                    <CheckCircle2 className="size-5" aria-hidden />
                  ) : (
                    <CircleAlert className="size-5" aria-hidden />
                  )}
                  {rec.data.reconciled ? 'Reconciled' : 'Not reconciled'}
                </p>
                <dl className="space-y-1 text-sm">
                  {(
                    [
                      [
                        'Net sales (orders handed over)',
                        rec.data.completedOrdersNetCents,
                        rec.data.journalNetSalesCents,
                      ],
                      ['GST on sales', rec.data.completedOrdersGstCents, rec.data.journalGstCents],
                      [
                        'Payments captured',
                        rec.data.capturedPaymentsCents,
                        rec.data.journalReceiptsCents,
                      ],
                    ] as const
                  ).map(([label, source, posted]) => (
                    <div key={label} className="flex justify-between gap-2">
                      <dt className="text-ink-muted">{label}</dt>
                      <dd
                        className={clsx(
                          'tabular-nums',
                          source !== posted && 'font-semibold text-danger',
                        )}
                      >
                        {money(posted)}
                        {source !== posted && ` / ${money(source)}`}
                      </dd>
                    </div>
                  ))}
                  <div className="flex justify-between gap-2 pt-1">
                    <dt className="text-ink-muted">Events awaiting posting</dt>
                    <dd>{rec.data.pendingEvents}</dd>
                  </div>
                  {rec.data.deadLetteredEvents > 0 && (
                    <div className="flex justify-between gap-2 text-danger">
                      <dt>Failed events (dead-lettered)</dt>
                      <dd>{rec.data.deadLetteredEvents}</dd>
                    </div>
                  )}
                </dl>
              </>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-bold">Trial balance · day activity</h2>
              {tb.data && (
                <Badge tone={tb.data.balanced ? 'ok' : 'danger'} className="">
                  <span data-testid="trial-balance-status">
                    {tb.data.balanced ? 'Balanced' : 'Out of balance'}
                  </span>
                </Badge>
              )}
            </div>
            {tb.isPending ? (
              <Spinner />
            ) : tb.isError ? (
              <EmptyState title="Unavailable" hint={tb.error.message} />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-ink-subtle">
                    <th className="py-1 font-medium">Account</th>
                    <th className="py-1 text-right font-medium">Debit</th>
                    <th className="py-1 text-right font-medium">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {tb.data.accounts
                    .filter((a) => a.debitCents || a.creditCents)
                    .map((a) => (
                      <tr key={a.code}>
                        <td className="py-1.5">
                          <span className="text-ink-subtle">{a.code}</span> {a.name}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {a.debitCents ? money(a.debitCents) : ''}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {a.creditCents ? money(a.creditCents) : ''}
                        </td>
                      </tr>
                    ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-ink font-semibold">
                    <td className="py-1.5">Total</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {money(tb.data.totalDebitCents)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {money(tb.data.totalCreditCents)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </Card>
        </div>

        <Card className="p-4">
          <h2 className="mb-3 font-bold">Journal</h2>
          {journal.isPending ? (
            <Spinner />
          ) : journal.isError ? (
            <EmptyState title="Unavailable" hint={journal.error.message} />
          ) : journal.data.length === 0 ? (
            <EmptyState title="No entries for this business date" />
          ) : (
            <ul className="space-y-3">
              {journal.data.map((e) => (
                <li key={e.id} className="rounded-lg border border-line p-3">
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-semibold">{e.description}</span>
                    <span className="text-xs text-ink-subtle">
                      {ENTRY_LABEL[e.entryType] ?? e.entryType} ·{' '}
                      {new Date(e.postedAt).toLocaleTimeString('en-AU')}
                    </span>
                  </div>
                  <table className="w-full text-sm">
                    <tbody>
                      {e.lines.map((l, i) => (
                        <tr key={i}>
                          <td className={clsx('py-0.5', l.creditCents > 0 && 'pl-6')}>
                            {l.accountCode} {l.accountName}
                          </td>
                          <td className="w-28 py-0.5 text-right tabular-nums">
                            {l.debitCents ? money(l.debitCents) : ''}
                          </td>
                          <td className="w-28 py-0.5 text-right tabular-nums">
                            {l.creditCents ? money(l.creditCents) : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </main>
    </div>
  );
}
