import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { withTenant, type Database, type Tx } from '@kitchos/database';
import type { FoodCostReport } from '@kitchos/contracts';
import { foodCost, itemRefundCents } from '@kitchos/domain';
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
    const { rows, sold } = await withTenant(this.db, p, async (tx) => ({
      rows: (
        await sql<{
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
         order by days.d`.execute(tx)
      ).rows,
      sold: await this.soldRecipeCost(tx, restaurantId, q.from, q.to),
    }));
    const days = rows.map((r) => ({
      businessDate: r.day,
      closed: r.closed,
      ...foodCost({
        netSalesCents: num(r.sales),
        cogsCents: num(r.cogs),
        wasteCents: num(r.waste),
        stockVarianceCents: num(r.variance),
        soldRecipeCents: sold.get(r.day) ?? 0,
      }),
    }));
    const sum = (
      k: 'netSalesCents' | 'cogsCents' | 'wasteCents' | 'stockVarianceCents' | 'soldRecipeCents',
    ) => days.reduce((s, d) => s + d[k], 0);
    return {
      from: q.from,
      to: q.to,
      days,
      totals: foodCost({
        netSalesCents: sum('netSalesCents'),
        cogsCents: sum('cogsCents'),
        wasteCents: sum('wasteCents'),
        stockVarianceCents: sum('stockVarianceCents'),
        soldRecipeCents: sum('soldRecipeCents'),
      }),
    };
  }

  /**
   * Recipe cost of sales per business day: the value sold lines were consumed at (remakes left
   * out: they are waste's replacement, not the sale), less items refunded by item. Dated by the
   * journal's own sale and refund entries, so it lands on the same day as their revenue, including
   * entries moved late from a closed day (ADR-0017), and counts nothing not yet posted. A refund
   * takes its exact cumulative share of the line's consumed value, like its money
   * (itemRefundCents), so a fully refunded line nets to zero. Lines consumed before valuation
   * existed have no value and count as zero.
   */
  private async soldRecipeCost(
    tx: Tx,
    restaurantId: string,
    from: string,
    to: string,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const add = (day: string, cents: number) => out.set(day, (out.get(day) ?? 0) + cents);
    const { rows: sales } = await sql<{ d: string; v: string }>`
      select e.business_date::text as d, coalesce(-sum(m.value_cents), 0)::text as v
        from journal_entries e
        join order_lines l on l.order_id = e.source_id
        join stock_movements m on m.source_type = 'order_line' and m.source_id = l.id
                              and m.source_key = '' and m.movement_type = 'production_consumption'
                              and m.value_cents is not null
       where e.restaurant_id = ${restaurantId}::uuid
         and e.entry_type = 'sale_recognition' and e.source_type = 'order'
         and e.business_date between ${from}::date and ${to}::date
       group by 1`.execute(tx);
    for (const r of sales) add(r.d, num(r.v));
    const { rows: returns } = await sql<{
      d: string;
      quantity: number;
      before: number;
      line_quantity: number;
      v: string;
    }>`
      with posted as (
        select e.business_date, e.source_id as refund_id
          from journal_entries e
         where e.restaurant_id = ${restaurantId}::uuid
           and e.entry_type = 'refund' and e.source_type = 'refund'
           and e.business_date between ${from}::date and ${to}::date),
      history as (
        -- Every item refund of the lines refunded in the range, with what came before each.
        select rl.refund_id, rl.order_line_id, rl.quantity,
               coalesce(sum(rl.quantity) over (
                 partition by rl.order_line_id order by f.created_at, f.id
                 rows between unbounded preceding and 1 preceding), 0)::int as before
          from refund_lines rl
          join refunds f on f.id = rl.refund_id
         where f.treatment = 'sales_return'
           and rl.order_line_id in (select r2.order_line_id from refund_lines r2
                                      join posted on posted.refund_id = r2.refund_id))
      select p.business_date::text as d, h.quantity, h.before, l.quantity as line_quantity,
             (select coalesce(-sum(m.value_cents), 0)
                from order_lines x
                join stock_movements m on m.source_type = 'order_line' and m.source_id = x.id
                                      and m.source_key = ''
                                      and m.movement_type = 'production_consumption'
                                      and m.value_cents is not null
               where x.order_id = l.order_id and (x.id = l.id or x.parent_line_id = l.id))::text as v
        from posted p
        join history h on h.refund_id = p.refund_id
        join order_lines l on l.id = h.order_line_id`.execute(tx);
    for (const r of returns) {
      add(r.d, -itemRefundCents(num(r.v), r.line_quantity, r.before, r.quantity));
    }
    return out;
  }
}
