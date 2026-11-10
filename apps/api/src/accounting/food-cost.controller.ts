import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { withTenant, type Database } from '@kitchos/database';
import type { FoodCostReport } from '@kitchos/contracts';
import { foodCost } from '@kitchos/domain';
import { sql } from 'kysely';
import { z } from 'zod';
import { Principal, RequirePermission, StaffAuthGuard } from '../auth/auth.guard.ts';
import type { StaffPrincipal } from '../auth/auth.service.ts';
import { DB } from '../infra/tokens.ts';
import { BusinessDay, UuidParam, ZodPipe } from '../infra/zod.ts';

const MAX_DAYS = 92;
const Range = z
  .object({ from: BusinessDay, to: BusinessDay })
  .refine((q) => q.from <= q.to, 'from must not be after to')
  .refine(
    (q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_DAYS,
    `At most ${MAX_DAYS} days at a time`,
  );

const num = (v: unknown) => Number(v ?? 0);

/**
 * Food cost and gross profit per business day, from the journal (ADR-0016
 * postings). Days are reported as the books hold them, including entries that
 * arrived late from a closed day (ADR-0017), so the figures agree with day close.
 */
@Controller('v1/restaurants/:restaurantId/reports/food-cost')
@UseGuards(StaffAuthGuard)
export class FoodCostController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  @RequirePermission('reports.view')
  async report(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Query(new ZodPipe(Range)) q: z.output<typeof Range>,
    @Principal() p: StaffPrincipal,
  ): Promise<FoodCostReport> {
    const { rows } = await withTenant(this.db, p, (tx) =>
      sql<{
        day: string;
        closed: boolean;
        sales: string;
        cogs: string;
        waste: string;
        variance: string;
      }>`
        with lines as (
          select e.business_date, a.system_key, l.debit_cents - l.credit_cents as net
            from journal_entries e
            join journal_lines l on l.entry_id = e.id
            join accounts a on a.id = l.account_id
           where e.restaurant_id = ${restaurantId}::uuid
             and e.business_date between ${q.from}::date and ${q.to}::date
             and a.system_key in ('sales_revenue', 'sales_discounts', 'sales_returns',
                                  'cogs', 'waste_expense', 'stock_variance'))
        select d::text as day,
               exists (select 1 from business_day_closes c
                        where c.restaurant_id = ${restaurantId}::uuid
                          and c.business_date = d) as closed,
               coalesce(-sum(net) filter (where system_key in
                 ('sales_revenue', 'sales_discounts', 'sales_returns')), 0)::text as sales,
               coalesce(sum(net) filter (where system_key = 'cogs'), 0)::text as cogs,
               coalesce(sum(net) filter (where system_key = 'waste_expense'), 0)::text as waste,
               coalesce(sum(net) filter (where system_key = 'stock_variance'), 0)::text as variance
          from (select ${q.from}::date + i as d
                  from generate_series(0, ${q.to}::date - ${q.from}::date) i) days
          left join lines on lines.business_date = days.d
         group by days.d
         order by days.d`.execute(tx),
    );
    const days = rows.map((r) => ({
      businessDate: r.day,
      closed: r.closed,
      ...foodCost({
        netSalesCents: num(r.sales),
        cogsCents: num(r.cogs),
        wasteCents: num(r.waste),
        stockVarianceCents: num(r.variance),
      }),
    }));
    const sum = (k: 'netSalesCents' | 'cogsCents' | 'wasteCents' | 'stockVarianceCents') =>
      days.reduce((s, d) => s + d[k], 0);
    return {
      from: q.from,
      to: q.to,
      days,
      totals: foodCost({
        netSalesCents: sum('netSalesCents'),
        cogsCents: sum('cogsCents'),
        wasteCents: sum('wasteCents'),
        stockVarianceCents: sum('stockVarianceCents'),
      }),
    };
  }
}
