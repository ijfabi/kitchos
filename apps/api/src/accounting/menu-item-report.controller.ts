import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { withTenant, type Database, type Tx } from '@kitchos/database';
import type { MenuItemReport } from '@kitchos/contracts';
import { divRoundHalfUp, itemRefundCents, lineGstCents } from '@kitchos/domain';
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

interface Line {
  id: string;
  order_id: string;
  product_id: string;
  name: string;
  category: string;
  quantity: number;
  net: number;
  taxable: boolean;
  /** Consumption value of the line and its meal components (remakes excluded). */
  value: number;
  /** When its order was placed (epoch ms): the newest line names its item. */
  placedAt: number;
}

interface Row {
  productId: string;
  name: string;
  category: string;
  unitsSold: number;
  netSalesCents: number;
  recipeCostCents: number;
  placedAt: number;
}

/**
 * Food cost per menu item (meals as sold, their components included) over a range of business
 * days. Dated by the journal's sale and refund entries, like the food cost report, so the item
 * rows plus refunds by amount (which name no items) add up to its net sales exactly.
 */
@Controller('v1/restaurants/:restaurantId/reports/menu-items')
@UseGuards(StaffAuthGuard)
export class MenuItemReportController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  @RequirePermission('reports.view')
  async report(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Query(new ZodPipe(Range)) q: z.output<typeof Range>,
    @Principal() p: StaffPrincipal,
  ): Promise<MenuItemReport> {
    return withTenant(this.db, p, async (tx) => {
      const rows = new Map<string, Row>();
      const row = (l: Line) => {
        let r = rows.get(l.product_id);
        if (!r) {
          r = {
            productId: l.product_id,
            name: l.name,
            category: l.category,
            unitsSold: 0,
            netSalesCents: 0,
            recipeCostCents: 0,
            placedAt: l.placedAt,
          };
          rows.set(l.product_id, r);
        } else if (l.placedAt > r.placedAt) {
          // Renamed or moved in a later menu version: shown as currently sold.
          Object.assign(r, { name: l.name, category: l.category, placedAt: l.placedAt });
        }
        return r;
      };

      // Sales posted in the range: every item line of those orders, ex GST.
      const sold = await sql<{ order_id: string; tax: string }>`
        select e.source_id as order_id, o.tax_cents::text as tax
          from journal_entries e
          join orders o on o.id = e.source_id
         where e.restaurant_id = ${restaurantId}::uuid
           and e.entry_type = 'sale_recognition' and e.source_type = 'order'
           and e.business_date between ${q.from}::date and ${q.to}::date`.execute(tx);
      const byOrder = new Map<string, Line[]>();
      for (const l of await this.lines(tx, { orderIds: sold.rows.map((o) => o.order_id) })) {
        byOrder.set(l.order_id, [...(byOrder.get(l.order_id) ?? []), l]);
      }
      for (const o of sold.rows) {
        const lines = byOrder.get(o.order_id) ?? [];
        const gst = lineGstCents(
          num(o.tax),
          lines.map((l) => ({ netCents: l.net, taxable: l.taxable })),
        );
        lines.forEach((l, i) => {
          const r = row(l);
          r.unitsSold += l.quantity;
          r.netSalesCents += l.net - gst[i]!;
          r.recipeCostCents += l.value;
        });
      }

      // Refunds by item posted in the range take back their units, revenue and recipe cost.
      const refunded = await sql<{
        order_line_id: string;
        quantity: number;
        before: number;
        amount: string;
        gst: string;
      }>`
        with posted as (
          select e.source_id as refund_id
            from journal_entries e
           where e.restaurant_id = ${restaurantId}::uuid
             and e.entry_type = 'refund' and e.source_type = 'refund'
             and e.business_date between ${q.from}::date and ${q.to}::date),
        history as (
          select rl.refund_id, rl.order_line_id, rl.quantity, rl.amount_cents, rl.gst_cents,
                 coalesce(sum(rl.quantity) over (
                   partition by rl.order_line_id order by f.created_at, f.id
                   rows between unbounded preceding and 1 preceding), 0)::int as before
            from refund_lines rl
            join refunds f on f.id = rl.refund_id
           where f.treatment = 'sales_return'
             and rl.order_line_id in (select r2.order_line_id from refund_lines r2
                                        join posted on posted.refund_id = r2.refund_id))
        select h.order_line_id, h.quantity, h.before,
               h.amount_cents::text as amount, h.gst_cents::text as gst
          from history h
          join posted on posted.refund_id = h.refund_id`.execute(tx);
      const refundedLines = new Map(
        (await this.lines(tx, { lineIds: refunded.rows.map((r) => r.order_line_id) })).map((l) => [
          l.id,
          l,
        ]),
      );
      for (const f of refunded.rows) {
        const l = refundedLines.get(f.order_line_id)!;
        const r = row(l);
        r.unitsSold -= f.quantity;
        r.netSalesCents -= num(f.amount) - num(f.gst);
        r.recipeCostCents -= itemRefundCents(l.value, l.quantity, f.before, f.quantity);
      }

      // Refunds by amount name no items: shown apart, ex GST, as the journal posted them.
      const unallocated = await sql<{ cents: string }>`
        select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::text as cents
          from journal_entries e
          join journal_lines jl on jl.entry_id = e.id
          join accounts a on a.id = jl.account_id
         where e.restaurant_id = ${restaurantId}::uuid
           and e.entry_type = 'refund' and e.source_type = 'refund'
           and e.business_date between ${q.from}::date and ${q.to}::date
           and a.system_key = 'sales_returns'
           and not exists (select 1 from refund_lines rl where rl.refund_id = e.source_id)`.execute(
        tx,
      );

      const items = [...rows.values()]
        .map(({ placedAt: _, ...r }) => ({
          ...r,
          ...this.margin(r.netSalesCents, r.recipeCostCents),
        }))
        .sort(
          (a, b) =>
            a.category.localeCompare(b.category) ||
            b.netSalesCents - a.netSalesCents ||
            a.name.localeCompare(b.name),
        );
      const categories = [...new Set(items.map((i) => i.category))].map((category) => {
        const of = items.filter((i) => i.category === category);
        const net = of.reduce((s, i) => s + i.netSalesCents, 0);
        const cost = of.reduce((s, i) => s + i.recipeCostCents, 0);
        return {
          category,
          unitsSold: of.reduce((s, i) => s + i.unitsSold, 0),
          netSalesCents: net,
          recipeCostCents: cost,
          ...this.margin(net, cost),
        };
      });
      const refundsByAmountCents = num(unallocated.rows[0]!.cents);
      const itemNet = items.reduce((s, i) => s + i.netSalesCents, 0);
      const itemCost = items.reduce((s, i) => s + i.recipeCostCents, 0);
      return {
        from: q.from,
        to: q.to,
        items,
        categories,
        refundsByAmountCents,
        totals: {
          netSalesCents: itemNet - refundsByAmountCents,
          recipeCostCents: itemCost,
          ...this.margin(itemNet - refundsByAmountCents, itemCost),
        },
      };
    });
  }

  private margin(netSalesCents: number, recipeCostCents: number) {
    return {
      grossProfitCents: netSalesCents - recipeCostCents,
      recipeCostBps:
        netSalesCents > 0
          ? Number(divRoundHalfUp(BigInt(recipeCostCents) * 10_000n, BigInt(netSalesCents)))
          : null,
    };
  }

  /** Item lines (an item, or a whole meal) with their net price and consumed value. */
  private async lines(
    tx: Tx,
    by: { orderIds?: readonly string[]; lineIds?: readonly string[] },
  ): Promise<Line[]> {
    const ids = by.orderIds ?? by.lineIds ?? [];
    if (ids.length === 0) return [];
    const { rows } = await sql<{
      id: string;
      order_id: string;
      product_id: string;
      name: string;
      category: string | null;
      quantity: number;
      net: string;
      taxable: boolean;
      value: string;
      placed_at: string;
    }>`
      select l.id, l.order_id, l.product_id, l.name, mi.category, l.quantity,
             (l.line_total_cents - l.discount_cents)::text as net, l.taxable,
             (select coalesce(-sum(m.value_cents), 0)
                from order_lines x
                join stock_movements m on m.source_type = 'order_line' and m.source_id = x.id
                                      and m.source_key = ''
                                      and m.movement_type = 'production_consumption'
                                      and m.value_cents is not null
               where x.order_id = l.order_id and (x.id = l.id or x.parent_line_id = l.id))::text
               as value,
             (extract(epoch from o.placed_at) * 1000)::bigint::text as placed_at
        from order_lines l
        join orders o on o.id = l.order_id
        left join menu_items mi on mi.id = l.menu_item_id
       where l.parent_line_id is null
         and ${by.orderIds ? sql`l.order_id` : sql`l.id`} = any(${sql.val([...ids])}::uuid[])
       order by l.order_id, l.line_no`.execute(tx);
    return rows.map((r) => ({
      ...r,
      category: r.category ?? 'Other',
      net: num(r.net),
      value: num(r.value),
      placedAt: num(r.placed_at),
    }));
  }
}
