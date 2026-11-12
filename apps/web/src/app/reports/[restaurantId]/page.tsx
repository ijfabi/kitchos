'use client';

import type { FoodCostReport, MenuItemReport } from '@kitchos/contracts';
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
          <>
            <Report data={report.data} />
            {range && (
              <ByMenuItem
                restaurantId={restaurantId}
                token={token}
                from={range.from}
                to={range.to}
              />
            )}
          </>
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

/** Food cost per menu item and category, for the same range. */
function ByMenuItem({
  restaurantId,
  token,
  from,
  to,
}: {
  restaurantId: string;
  token: string;
  from: string;
  to: string;
}) {
  const report = useQuery({
    queryKey: ['menu-items', restaurantId, from, to],
    queryFn: ({ signal }) =>
      get<MenuItemReport>(
        `/v1/restaurants/${restaurantId}/reports/menu-items?from=${from}&to=${to}`,
        token,
        signal,
      ),
    refetchInterval: 60_000,
  });
  if (report.isPending) return <Spinner label="Loading menu items" />;
  if (report.isError) {
    return <EmptyState title="Cannot load menu items" hint={report.error.message} />;
  }
  const r = report.data;
  return (
    <section aria-label="By menu item">
      <h2 className="mb-2 font-bold">By menu item</h2>
      {r.items.length === 0 ? (
        <EmptyState className="py-6" title="Nothing sold in this range" />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <caption className="sr-only">Food cost by menu item</caption>
            <thead>
              <tr className="text-left text-ink-muted">
                <th scope="col" className="px-3 py-2 font-medium">
                  Item
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Sold
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Net sales
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Recipe cost
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Recipe %
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Gross profit
                </th>
              </tr>
            </thead>
            {r.categories.map((c) => (
              <tbody key={c.category}>
                <tr
                  className="border-t border-line bg-canvas font-semibold"
                  data-testid="category-row"
                >
                  <th scope="row" className="px-3 py-2 text-left">
                    {c.category}
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums">{c.unitsSold}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(c.netSalesCents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(c.recipeCostCents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{percent(c.recipeCostBps)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(c.grossProfitCents)}</td>
                </tr>
                {r.items
                  .filter((i) => i.category === c.category)
                  .map((i) => (
                    <tr
                      key={i.productId}
                      className="border-t border-line"
                      data-testid="item-row"
                      data-item={i.name}
                    >
                      <th scope="row" className="px-3 py-2 pl-6 text-left font-normal">
                        {i.name}
                      </th>
                      <td className="px-3 py-2 text-right tabular-nums" data-testid="item-sold">
                        {i.unitsSold}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(i.netSalesCents)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(i.recipeCostCents)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {percent(i.recipeCostBps)}
                      </td>
                      <td
                        className={clsx(
                          'px-3 py-2 text-right tabular-nums',
                          i.grossProfitCents < 0 && 'text-danger',
                        )}
                      >
                        {money(i.grossProfitCents)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            ))}
          </table>
        </Card>
      )}
      <p className="mt-2 text-xs text-ink-muted">
        Net sales are ex GST and after discounts, less items refunded.{' '}
        {r.refundsByAmountCents !== 0 &&
          `Refunds by amount (${money(r.refundsByAmountCents)} ex GST) name no items, so they are not in any row. `}
        Total net sales {money(r.totals.netSalesCents)}, the same as the daily figures above.
      </p>
    </section>
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
