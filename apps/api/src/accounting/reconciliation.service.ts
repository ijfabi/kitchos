import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@kitchos/database';
import type { LedgerReconciliation } from '@kitchos/contracts';
import { sql } from 'kysely';
import { LedgerConsumer } from './ledger.consumer.ts';

const num = (v: unknown) => Number(v ?? 0);

/**
 * Reconciles the journal with its sources for one business day: net sales
 * and GST of handed-over orders vs posted sale entries, and captured
 * payments vs posted receipts, plus the ledger consumer's backlog.
 */
@Injectable()
export class ReconciliationService {
  constructor(@Inject(LedgerConsumer) private readonly ledger: LedgerConsumer) {}

  async forDay(tx: Tx, restaurantId: string, day: string): Promise<LedgerReconciliation> {
    const orders = await tx
      .selectFrom('orders')
      .select([
        (x) =>
          x.fn.coalesce(x.fn.sum<number>(sql`total_cents - tax_cents`), sql<number>`0`).as('net'),
        (x) => x.fn.coalesce(x.fn.sum<number>('tax_cents'), sql<number>`0`).as('gst'),
      ])
      .where('restaurant_id', '=', restaurantId)
      .where('status', '=', 'completed')
      .where(sql<boolean>`app.business_date(restaurant_id, completed_at) = ${day}::date`)
      .executeTakeFirstOrThrow();
    // Per tender: what each method moved, including cash rounding, as the drawers count it.
    const payments = await tx
      .selectFrom('payments')
      .select([
        sql<string>`coalesce(sum(amount_cents), 0)`.as('cents'),
        sql<string>`coalesce(sum(amount_cents) filter (where method = 'card'), 0)`.as('card'),
        sql<string>`coalesce(sum(amount_cents + cash_rounding_cents) filter (where method = 'cash'), 0)`.as(
          'cash',
        ),
        sql<string>`coalesce(sum(cash_rounding_cents), 0)`.as('rounding'),
      ])
      .where('restaurant_id', '=', restaurantId)
      .where('captured_at', 'is not', null)
      .where(sql<boolean>`app.business_date(restaurant_id, captured_at) = ${day}::date`)
      .executeTakeFirstOrThrow();
    const net = await this.sumByKey(tx, restaurantId, day, 'sale_recognition');
    const receipts = await this.sumByKey(tx, restaurantId, day, 'payment_receipt');
    const refundEntries = await this.sumByKey(tx, restaurantId, day, 'refund');
    const refunds = await tx
      .selectFrom('refunds')
      .select([
        sql<string>`coalesce(sum(amount_cents), 0)`.as('cents'),
        sql<string>`coalesce(sum(amount_cents) filter (where method = 'card'), 0)`.as('card'),
        sql<string>`coalesce(sum(amount_cents + cash_rounding_cents) filter (where method = 'cash'), 0)`.as(
          'cash',
        ),
        sql<string>`coalesce(sum(cash_rounding_cents), 0)`.as('rounding'),
      ])
      .where('restaurant_id', '=', restaurantId)
      .where(sql<boolean>`app.business_date(restaurant_id, created_at) = ${day}::date`)
      .executeTakeFirstOrThrow();
    // Inventory sub-ledger: movements recorded before valuation (no value) are outside the journal.
    const stock = await tx
      .selectFrom('stock_movements')
      .select((x) => x.fn.coalesce(x.fn.sum<number>('value_cents'), sql<number>`0`).as('cents'))
      .where('restaurant_id', '=', restaurantId)
      .where('business_date', '=', day)
      .where('value_cents', 'is not', null)
      .executeTakeFirstOrThrow();
    const inventory = await tx
      .selectFrom('journal_lines as l')
      .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select((x) =>
        x.fn
          .coalesce(x.fn.sum<number>(sql`l.debit_cents - l.credit_cents`), sql<number>`0`)
          .as('net'),
      )
      .where('e.restaurant_id', '=', restaurantId)
      .where('e.business_date', '=', day)
      .where('a.system_key', '=', 'inventory')
      .where('e.posted_late_from', 'is', null)
      .executeTakeFirstOrThrow();
    const drawers = await tx
      .selectFrom('drawer_sessions')
      .select((x) => x.fn.coalesce(x.fn.sum<number>('variance_cents'), sql<number>`0`).as('cents'))
      .where('restaurant_id', '=', restaurantId)
      .where('business_date', '=', day)
      .where('status', '=', 'closed')
      .executeTakeFirstOrThrow();
    const drawerCloses = await this.sumByKey(tx, restaurantId, day, 'drawer_close');
    const unmatched = await this.unmatched(tx, restaurantId, day);
    const backlog = await tx
      .selectFrom('outbox_events as o')
      .leftJoin('inbox_events as i', (j) =>
        j.onRef('i.event_id', '=', 'o.id').on('i.consumer', '=', this.ledger.name),
      )
      .leftJoin('event_consumer_failures as f', (j) =>
        j.onRef('f.event_id', '=', 'o.id').on('f.consumer', '=', this.ledger.name),
      )
      .select([
        (x) =>
          x.fn
            .count<string>('o.id')
            .filterWhere((w) => w.and([w('i.event_id', 'is', null), w('f.dead_at', 'is', null)]))
            .as('pending'),
        (x) => x.fn.count<string>('o.id').filterWhere('f.dead_at', 'is not', null).as('dead'),
      ])
      .where('o.restaurant_id', '=', restaurantId)
      .where('o.event_type', 'in', [...this.ledger.eventTypes])
      // Events that post to this business day. A drawer's later movements and its
      // close post to the day it opened, whenever they occurred.
      .where(
        sql<boolean>`coalesce(
          case o.event_type
            when 'drawer.closed' then
              (select s.business_date from drawer_sessions s where s.id = o.aggregate_id)
            when 'drawer.movement_recorded' then
              (select s.business_date from drawer_movements m
                 join drawer_sessions s on s.id = m.session_id where m.id = o.aggregate_id)
          end,
          app.business_date(o.restaurant_id, o.occurred_at)) = ${day}::date`,
      )
      .executeTakeFirstOrThrow();

    const result = {
      businessDate: day,
      completedOrdersNetCents: num(orders.net),
      journalNetSalesCents: (net.get('sales_revenue') ?? 0) + (net.get('sales_discounts') ?? 0),
      capturedPaymentsCents: num(payments.cents),
      journalReceiptsCents: receipts.get('customer_deposits') ?? 0,
      completedOrdersGstCents: num(orders.gst),
      journalGstCents: net.get('gst_payable') ?? 0,
      refundsCents: num(refunds.cents),
      // Refund entries debit deposits (cancelled orders) or returns + GST (handed-over orders).
      journalRefundsCents: -(
        (refundEntries.get('customer_deposits') ?? 0) +
        (refundEntries.get('sales_returns') ?? 0) +
        (refundEntries.get('gst_payable') ?? 0)
      ),
      stockMovementsValueCents: num(stock.cents),
      journalInventoryCents: num(inventory.net),
      // Both tenders credit Customer deposits, so the totals above cannot tell them apart.
      cardNetCents: num(payments.card) - num(refunds.card),
      journalCardClearingCents: -(
        (receipts.get('card_clearing') ?? 0) + (refundEntries.get('card_clearing') ?? 0)
      ),
      cashNetCents: num(payments.cash) - num(refunds.cash),
      journalCashOnHandCents: -(
        (receipts.get('cash_on_hand') ?? 0) + (refundEntries.get('cash_on_hand') ?? 0)
      ),
      cashRoundingCents: num(payments.rounding) - num(refunds.rounding),
      journalCashRoundingCents:
        (receipts.get('cash_rounding') ?? 0) + (refundEntries.get('cash_rounding') ?? 0),
      unmatchedReceipts: unmatched.receipts,
      unmatchedRefunds: unmatched.refunds,
      drawerVarianceCents: num(drawers.cents),
      // Over/short is credited when a drawer is over, as its variance is positive.
      journalCashOverShortCents: drawerCloses.get('cash_over_short') ?? 0,
      pendingEvents: num(backlog.pending),
      deadLetteredEvents: num(backlog.dead),
    };
    return {
      ...result,
      reconciled:
        result.completedOrdersNetCents === result.journalNetSalesCents &&
        result.capturedPaymentsCents === result.journalReceiptsCents &&
        result.completedOrdersGstCents === result.journalGstCents &&
        result.refundsCents === result.journalRefundsCents &&
        result.stockMovementsValueCents === result.journalInventoryCents &&
        result.cardNetCents === result.journalCardClearingCents &&
        result.cashNetCents === result.journalCashOnHandCents &&
        result.cashRoundingCents === result.journalCashRoundingCents &&
        result.unmatchedReceipts === 0 &&
        result.unmatchedRefunds === 0 &&
        result.drawerVarianceCents === result.journalCashOverShortCents &&
        result.pendingEvents === 0 &&
        result.deadLetteredEvents === 0,
    };
  }

  /**
   * Totals can hide errors that cancel out (a missing receipt and a duplicate one), so each
   * receipt and refund entry must belong to exactly one source of that amount and day. A missing
   * entry then cannot hide: offsetting it needs an orphan or a wrong amount, which this counts, and
   * the totals catch it otherwise. Entries moved late from a closed day are checked against the day
   * they came from; the totals leave them out.
   */
  private async unmatched(
    tx: Tx,
    restaurantId: string,
    day: string,
  ): Promise<{ receipts: number; refunds: number }> {
    const { rows } = await sql<{ receipts: string; refunds: string }>`
      with entries as (
        select e.entry_type, e.source_type, e.source_id,
               coalesce(e.posted_late_from, e.business_date) as source_day,
               coalesce(sum(l.credit_cents - l.debit_cents)
                 filter (where a.system_key = 'customer_deposits'), 0) as deposits,
               coalesce(sum(l.debit_cents - l.credit_cents)
                 filter (where a.system_key in ('customer_deposits', 'sales_returns', 'gst_payable')), 0)
                 as refunded
          from journal_entries e
          join journal_lines l on l.entry_id = e.id
          join accounts a on a.id = l.account_id
         where e.restaurant_id = ${restaurantId}::uuid and e.business_date = ${day}::date
           and e.entry_type in ('payment_receipt', 'refund')
         group by e.id)
      select
        (select count(*) from entries x
           left join payments p on x.source_type = 'payment' and p.id = x.source_id
                               and p.restaurant_id = ${restaurantId}::uuid and p.captured_at is not null
          where x.entry_type = 'payment_receipt'
            and (p.id is null or x.deposits <> p.amount_cents
                 or app.business_date(p.restaurant_id, p.captured_at) <> x.source_day)) as receipts,
        (select count(*) from entries x
           left join refunds f on x.source_type = 'refund' and f.id = x.source_id
                              and f.restaurant_id = ${restaurantId}::uuid
          where x.entry_type = 'refund'
            and (f.id is null or x.refunded <> f.amount_cents
                 or app.business_date(f.restaurant_id, f.created_at) <> x.source_day)) as refunds`.execute(
      tx,
    );
    return { receipts: num(rows[0]!.receipts), refunds: num(rows[0]!.refunds) };
  }

  /** Net credit (credit − debit) per system account for one entry type on one day. */
  private async sumByKey(
    tx: Tx,
    restaurantId: string,
    day: string,
    entryType: string,
  ): Promise<Map<string, number>> {
    const rows = await tx
      .selectFrom('journal_lines as l')
      .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select([
        'a.system_key',
        (x) => x.fn.sum<number>(sql`l.credit_cents - l.debit_cents`).as('net'),
      ])
      .where('e.restaurant_id', '=', restaurantId)
      .where('e.business_date', '=', day)
      .where('e.entry_type', '=', entryType)
      .where('e.posted_late_from', 'is', null)
      .groupBy('a.system_key')
      .execute();
    return new Map(rows.map((r) => [r.system_key ?? '', num(r.net)]));
  }
}
