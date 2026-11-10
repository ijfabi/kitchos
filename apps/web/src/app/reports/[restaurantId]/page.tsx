'use client';

import type { FoodCostReport } from '@kitchos/contracts';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { StaffGate } from '@/components/staff-gate';
import { Badge, Card, EmptyState, Logo, Spinner } from '@/components/ui';
import { get } from '@/lib/api';
import { money, percent } from '@/lib/format';
import type { StaffSession } from '@/lib/session';

export default function ReportsPage() {
  return <StaffGate>{(session) => <FoodCost session={session} />}</StaffGate>;
}

/** Calendar arithmetic on business dates: no timezone involved. */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function FoodCost({ session }: { session: StaffSession }) {
  const { restaurantId } = useParams<{ restaurantId: string }>();
  const token = session.accessToken;
  const restaurant = session.me.restaurants.find((r) => r.id === restaurantId);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);

  const today = useQuery({
    queryKey: ['business-date', restaurantId],
    queryFn: ({ signal }) =>
      get<{ businessDate: string }>(
        `/v1/restaurants/${restaurantId}/accounting/business-date`,
        token,
        signal,
      ),
  });
  // The last seven business days, today included.
  useEffect(() => {
    if (today.data && range === null) {
      setRange({ from: addDays(today.data.businessDate, -6), to: today.data.businessDate });
    }
  }, [today.data, range]);

  const span =
    range === null ? 0 : (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1; // ISO dates parse as UTC
  const rangeOk = range !== null && span >= 1 && span <= 92;
  const report = useQuery({
    queryKey: ['food-cost', restaurantId, range?.from, range?.to],
    queryFn: ({ signal }) =>
      get<FoodCostReport>(
        `/v1/restaurants/${restaurantId}/reports/food-cost?from=${range!.from}&to=${range!.to}`,
        token,
        signal,
      ),
    enabled: rangeOk,
    refetchInterval: 60_000,
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
          <h1 className="font-bold leading-tight">Food cost</h1>
          <p className="text-xs text-ink-muted">{restaurant?.name} · from the books</p>
        </div>
        {range && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <span>From</span>
              <input
                type="date"
                value={range.from}
                onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })}
                className="h-10 rounded-lg border border-line px-2"
              />
            </label>
            <label className="flex items-center gap-2">
              <span>To</span>
              <input
                type="date"
                value={range.to}
                onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })}
                className="h-10 rounded-lg border border-line px-2"
              />
            </label>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-5xl space-y-4 p-4">
        {range && range.from > range.to ? (
          <EmptyState title="The start date is after the end date" />
        ) : range && !rangeOk ? (
          <EmptyState title="Choose at most 92 days" />
        ) : today.isError ? (
          <EmptyState title="Cannot load the business day" hint={today.error.message} />
        ) : report.isError ? (
          <EmptyState title="Cannot load the report" hint={report.error.message} />
        ) : !report.data ? (
          <Spinner label="Loading food cost" />
        ) : (
          <Report data={report.data} />
        )}
      </main>
    </div>
  );
}

function Report({ data }: { data: FoodCostReport }) {
  const t = data.totals;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-5" data-testid="food-cost-totals">
        <Stat label="Net sales" value={money(t.netSalesCents)} />
        <Stat label="Recipe food cost" value={percent(t.theoreticalFoodCostBps)} />
        <Stat label="Actual food cost" value={percent(t.actualFoodCostBps)} />
        <Stat label="Gross profit" value={money(t.grossProfitCents)} />
        <Stat label="Gross margin" value={percent(t.grossMarginBps)} />
      </div>
      <p className="text-xs text-ink-muted">
        Recipe cost of sales is what the recipes of the items sold should cost, on the day the sale
        posted, less items refunded by item (comps count at zero revenue). Food produced is
        everything made, on the day it was made. The difference, unsold production, is food
        cancelled or made one day and sold another, so it can be negative on a day: read it over a
        range. Actual food cost adds waste and stock count shortfalls (negative means a count found
        more). Open days can still change.
      </p>
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="sr-only">Food cost by business day</caption>
          <thead>
            <tr className="text-left text-ink-muted">
              <th scope="col" className="px-3 py-2 font-medium">
                Day
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Net sales
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Food produced
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Recipe cost of sales
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Unsold production
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Waste
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Count shortfall
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Actual %
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Gross profit
              </th>
            </tr>
          </thead>
          <tbody>
            {data.days.map((d) => (
              <tr
                key={d.businessDate}
                className="border-t border-line"
                data-testid="food-cost-day"
                data-day={d.businessDate}
              >
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {d.businessDate}{' '}
                  <Badge tone={d.closed ? 'ok' : 'neutral'}>{d.closed ? 'Closed' : 'Open'}</Badge>
                </th>
                <td className="px-3 py-2 text-right tabular-nums" data-testid="net-sales">
                  {money(d.netSalesCents)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{money(d.cogsCents)}</td>
                <td className="px-3 py-2 text-right tabular-nums" data-testid="sold-recipe">
                  {money(d.soldRecipeCents)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {money(d.unsoldProductionCents)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{money(d.wasteCents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(d.stockVarianceCents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {percent(d.actualFoodCostBps)}
                </td>
                <td
                  className={clsx(
                    'px-3 py-2 text-right tabular-nums',
                    d.grossProfitCents < 0 && 'text-danger',
                  )}
                >
                  {money(d.grossProfitCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="text-xl font-bold tabular-nums">{value}</p>
    </Card>
  );
}
