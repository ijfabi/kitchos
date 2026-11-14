import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type Database, type Tx } from '@kitchos/database';
import type {
  FailedEventView,
  DayCloseIssue,
  DayCloseTotals,
  DayCloseView,
  DayDrawerResult,
} from '@kitchos/contracts';
import { sql } from 'kysely';
import { appendEvents } from '../events/outbox.ts';
import { audit } from '../infra/audit.ts';
import { ApiException, notFound } from '../infra/http-errors.ts';
import { DB } from '../infra/tokens.ts';
import { LedgerConsumer } from './ledger.consumer.ts';
import { ReconciliationService } from './reconciliation.service.ts';

const num = (v: unknown) => Number(v ?? 0);

/**
 * Business-day close (ADR-0017). A day closes once it has ended, every drawer
 * session up to it is closed, and the journal is complete and reconciled. The
 * close stores an immutable snapshot, and the database then refuses journal
 * entries dated to that day. Corrections post on the day they are made.
 */
@Injectable()
export class DayCloseService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    @Inject(LedgerConsumer) private readonly ledger: LedgerConsumer,
  ) {}

  /** What closing would record, or what was recorded if the day is closed. */
  async view(
    ctx: { orgId: string; restaurantId: string; userId: string },
    day: string,
  ): Promise<DayCloseView> {
    return withTenant(this.db, ctx, async (tx) => {
      const stored = await this.stored(tx, ctx.restaurantId, day);
      if (stored) return stored;
      // Managers see live figures at any time, their own till open or not (R-028, product
      // decision). A drawer's row stays empty until counted, but a manager running a till can
      // work its expected cash out from these totals: their own count is not blind (accepted).
      return this.preview(tx, ctx.restaurantId, day);
    });
  }

  async failedEvents(ctx: { orgId: string; restaurantId: string }): Promise<FailedEventView[]> {
    return withTenant(this.db, ctx, (tx) => this.deadLetters(tx, ctx.restaurantId));
  }

  /** Puts a dead-lettered event back in the ledger's queue; the dispatcher then tries it afresh. */
  async retryEvent(
    ctx: { orgId: string; restaurantId: string; userId: string },
    eventId: string,
  ): Promise<FailedEventView[]> {
    return withTenant(this.db, ctx, async (tx) => {
      const dead = (await this.deadLetters(tx, ctx.restaurantId)).find(
        (e) => e.eventId === eventId,
      );
      if (!dead) throw notFound('Failed event');
      const removed = await tx
        .deleteFrom('event_consumer_failures')
        .where('consumer', '=', this.ledger.name)
        .where('event_id', '=', eventId)
        .where('dead_at', 'is not', null)
        .executeTakeFirst();
      if (removed.numDeletedRows === 0n) throw notFound('Failed event');
      await audit(tx, {
        orgId: ctx.orgId,
        restaurantId: ctx.restaurantId,
        actorUserId: ctx.userId,
        action: 'ledger.retry_event',
        entityType: 'outbox_event',
        entityId: eventId,
        data: { eventType: dead.eventType, attempts: dead.attempts, lastError: dead.lastError },
      });
      return this.deadLetters(tx, ctx.restaurantId);
    });
  }

  private async deadLetters(tx: Tx, restaurantId: string): Promise<FailedEventView[]> {
    const rows = await tx
      .selectFrom('event_consumer_failures as f')
      .innerJoin('outbox_events as o', 'o.id', 'f.event_id')
      .select(['o.id', 'o.event_type', 'o.occurred_at', 'f.attempts', 'f.last_error'])
      .where('f.consumer', '=', this.ledger.name)
      .where('f.dead_at', 'is not', null)
      .where('o.restaurant_id', '=', restaurantId)
      .orderBy('o.occurred_at')
      .execute();
    return rows.map((r) => ({
      eventId: r.id,
      eventType: r.event_type,
      occurredAt: r.occurred_at.toISOString(),
      attempts: r.attempts,
      lastError: r.last_error,
    }));
  }

  async close(
    ctx: { orgId: string; restaurantId: string; userId: string },
    day: string,
    notes: string | undefined,
  ): Promise<DayCloseView> {
    return withTenant(this.db, ctx, async (tx) => {
      // Waits for entries being posted to this day; later ones then see the close.
      await sql`select pg_advisory_xact_lock(app.business_day_lock_key(${ctx.restaurantId}::uuid, ${day}::date))`.execute(
        tx,
      );
      if (await this.stored(tx, ctx.restaurantId, day)) {
        throw new ApiException(409, 'DAY_ALREADY_CLOSED', `Business day ${day} is already closed`);
      }
      const p = await this.preview(tx, ctx.restaurantId, day);
      if (p.blockers.length > 0) {
        throw new ApiException(409, 'DAY_NOT_READY', `Business day ${day} cannot be closed yet`, {
          blockers: p.blockers,
        });
      }
      const row = await tx
        .insertInto('business_day_closes')
        .values({
          org_id: ctx.orgId,
          restaurant_id: ctx.restaurantId,
          business_date: day,
          closed_by: ctx.userId,
          notes: notes ?? null,
          totals: JSON.stringify(p.totals),
          drawers: JSON.stringify(p.drawers),
          warnings: JSON.stringify(p.warnings),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await audit(tx, {
        orgId: ctx.orgId,
        restaurantId: ctx.restaurantId,
        actorUserId: ctx.userId,
        action: 'business_day.close',
        entityType: 'business_day_close',
        entityId: row.id,
        ...(notes ? { reason: notes } : {}),
        data: { businessDate: day, warnings: p.warnings.map((w) => w.code) },
      });
      await appendEvents(tx, [
        {
          orgId: ctx.orgId,
          restaurantId: ctx.restaurantId,
          aggregateType: 'business_day',
          aggregateId: row.id,
          aggregateVersion: 1,
          eventType: 'business_day.closed',
          payload: { businessDate: day },
        },
      ]);
      return (await this.stored(tx, ctx.restaurantId, day))!;
    });
  }

  private async stored(tx: Tx, restaurantId: string, day: string): Promise<DayCloseView | null> {
    const c = await tx
      .selectFrom('business_day_closes as c')
      .innerJoin('users as u', 'u.id', 'c.closed_by')
      .select(['c.closed_at', 'c.notes', 'c.totals', 'c.drawers', 'c.warnings', 'u.display_name'])
      .where('c.restaurant_id', '=', restaurantId)
      .where('c.business_date', '=', day)
      .executeTakeFirst();
    if (!c) return null;
    return {
      businessDate: day,
      currentBusinessDate: await this.today(tx, restaurantId),
      status: 'closed',
      blockers: [],
      warnings: c.warnings as DayCloseIssue[],
      totals: c.totals as DayCloseTotals,
      drawers: c.drawers as DayDrawerResult[],
      closedBy: c.display_name,
      closedAt: c.closed_at.toISOString(),
      notes: c.notes,
    };
  }

  private async preview(tx: Tx, restaurantId: string, day: string): Promise<DayCloseView> {
    const today = await this.today(tx, restaurantId);
    const drawers = await this.drawers(tx, restaurantId, day);
    const rec = await this.reconciliation.forDay(tx, restaurantId, day);
    const blockers: DayCloseIssue[] = [];
    const issue = (code: string, message: string) => blockers.push({ code, message });
    if (day >= today) {
      issue('DAY_NOT_ENDED', 'This business day has not ended yet');
    } else if (day >= (await this.settledDay(tx, restaurantId))) {
      // Transactions that began before the cutoff are dated to this day and may not have committed.
      issue('DAY_SETTLING', 'This business day only just ended. Try again in a few minutes.');
    }
    const open = drawers.filter((d) => d.status === 'open');
    if (open.length > 0) {
      issue(
        'DRAWERS_OPEN',
        `Still to be counted: ${open.map((d) => `${d.drawerName} (${d.openedBy})`).join(', ')}`,
      );
    }
    const pending = drawers.filter((d) => d.status === 'pending_approval');
    if (pending.length > 0) {
      issue(
        'VARIANCE_PENDING',
        `Variance awaiting approval: ${pending.map((d) => d.drawerName).join(', ')}`,
      );
    }
    if (rec.pendingEvents > 0) {
      issue('LEDGER_BEHIND', `${rec.pendingEvents} event(s) still to be posted to the books`);
    }
    if (rec.deadLetteredEvents > 0) {
      issue('LEDGER_FAILED', `${rec.deadLetteredEvents} event(s) failed to post to the books`);
    } else if (!rec.reconciled && rec.pendingEvents === 0) {
      issue('NOT_RECONCILED', 'The books do not reconcile to sales, payments and stock');
    }
    return {
      businessDate: day,
      currentBusinessDate: today,
      status: 'open',
      blockers,
      warnings: await this.warnings(tx, restaurantId, day),
      totals: await this.totals(tx, restaurantId, day),
      drawers,
      closedBy: null,
      closedAt: null,
      notes: null,
    };
  }

  /** The business day as it was a few minutes ago: anything earlier has fully ended. */
  private async settledDay(tx: Tx, restaurantId: string): Promise<string> {
    const { rows } = await sql<{ d: string }>`
      select app.business_date(${restaurantId}::uuid, now() - interval '5 minutes')::text as d`.execute(
      tx,
    );
    return rows[0]!.d;
  }

  private async today(tx: Tx, restaurantId: string): Promise<string> {
    const { rows } = await sql<{ d: string }>`
      select app.business_date(${restaurantId}::uuid, now())::text as d`.execute(tx);
    return rows[0]!.d;
  }

  /** The day's sessions, plus any older session still not closed (it holds up this day too). */
  private async drawers(tx: Tx, restaurantId: string, day: string): Promise<DayDrawerResult[]> {
    const rows = await tx
      .selectFrom('drawer_sessions as s')
      .innerJoin('cash_drawers as d', 'd.id', 's.drawer_id')
      .innerJoin('users as u', 'u.id', 's.opened_by')
      .select([
        's.id',
        'd.name',
        'u.display_name',
        's.status',
        's.opening_float_cents',
        's.counted_cents',
        's.expected_cents',
        's.variance_cents',
      ])
      .where('s.restaurant_id', '=', restaurantId)
      .where((w) =>
        w.or([
          w('s.business_date', '=', day),
          w.and([w('s.business_date', '<', day), w('s.status', '<>', 'closed')]),
        ]),
      )
      .orderBy('s.opened_at')
      .execute();
    // Figures come from the count's snapshot, so an open session stays blind here too.
    return rows.map((r) => ({
      sessionId: r.id,
      drawerName: r.name,
      openedBy: r.display_name,
      status: r.status as DayDrawerResult['status'],
      openingFloatCents: r.opening_float_cents,
      expectedCents: r.expected_cents,
      countedCents: r.counted_cents,
      varianceCents: r.variance_cents,
    }));
  }

  private async warnings(tx: Tx, restaurantId: string, day: string): Promise<DayCloseIssue[]> {
    const out: DayCloseIssue[] = [];
    const waste = await tx
      .selectFrom('waste_records')
      .select((x) => x.fn.countAll<string>().as('n'))
      .where('restaurant_id', '=', restaurantId)
      .where('business_date', '=', day)
      .where('status', '=', 'pending_approval')
      .executeTakeFirstOrThrow();
    if (num(waste.n) > 0) {
      out.push({
        code: 'WASTE_PENDING',
        message: `${num(waste.n)} waste record(s) still need review. A rejection will post on the day it is made.`,
      });
    }
    const orders = await tx
      .selectFrom('orders')
      .select((x) => x.fn.countAll<string>().as('n'))
      .where('restaurant_id', '=', restaurantId)
      .where('business_date', '=', day)
      .where('status', 'in', ['pending_payment', 'accepted', 'in_preparation', 'ready'])
      .executeTakeFirstOrThrow();
    if (num(orders.n) > 0) {
      out.push({
        code: 'ORDERS_UNFINISHED',
        message: `${num(orders.n)} order(s) from this day are unfinished. They post on the day they finish.`,
      });
    }
    const late = await tx
      .selectFrom('journal_entries')
      .select((x) => x.fn.countAll<string>().as('n'))
      .where('restaurant_id', '=', restaurantId)
      .where('business_date', '=', day)
      .where('posted_late_from', 'is not', null)
      .executeTakeFirstOrThrow();
    if (num(late.n) > 0) {
      out.push({
        code: 'LATE_ENTRIES',
        message: `${num(late.n)} journal entries arrived after their own day closed and are included here.`,
      });
    }
    return out;
  }

  private async totals(tx: Tx, restaurantId: string, day: string): Promise<DayCloseTotals> {
    const accounts = await tx
      .selectFrom('journal_lines as l')
      .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select([
        'a.system_key',
        (x) => x.fn.sum<number>(sql`l.credit_cents - l.debit_cents`).as('net'),
      ])
      .where('e.restaurant_id', '=', restaurantId)
      .where('e.business_date', '=', day)
      .groupBy('a.system_key')
      .execute();
    const credit = (key: string) => num(accounts.find((a) => a.system_key === key)?.net);
    const payments = await tx
      .selectFrom('payments')
      .select([
        'method',
        (x) => x.fn.sum<number>('amount_cents').as('cents'),
        (x) => x.fn.sum<number>('cash_rounding_cents').as('rounding'),
      ])
      .where('restaurant_id', '=', restaurantId)
      .where('captured_at', 'is not', null)
      .where(sql<boolean>`app.business_date(restaurant_id, captured_at) = ${day}::date`)
      .groupBy('method')
      .execute();
    const taken = (method: string) => num(payments.find((p) => p.method === method)?.cents);
    const cash = payments.find((p) => p.method === 'cash');
    const refunds = await tx
      .selectFrom('refunds')
      .select([
        sql<number>`coalesce(sum(amount_cents), 0)`.as('cents'),
        sql<number>`coalesce(sum(amount_cents + cash_rounding_cents) filter (where method = 'cash'), 0)`.as(
          'cash',
        ),
      ])
      .where('restaurant_id', '=', restaurantId)
      .where(sql<boolean>`app.business_date(restaurant_id, created_at) = ${day}::date`)
      .executeTakeFirstOrThrow();
    return {
      netSalesCents: credit('sales_revenue') + credit('sales_discounts') + credit('sales_returns'),
      gstCents: credit('gst_payable'),
      cashTakenCents: taken('cash') + num(cash?.rounding),
      cardTakenCents: taken('card'),
      cashRoundingCents: credit('cash_rounding'),
      refundsCents: num(refunds.cents),
      cashRefundsCents: num(refunds.cash),
      cogsCents: -credit('cogs'),
      wasteCents: -credit('waste_expense'),
      stockVarianceCents: -credit('stock_variance'),
      transferShortageCents: -credit('transfer_shortage'),
      cashOverShortCents: -credit('cash_over_short'),
      pettyCashCents: -credit('petty_cash'),
    };
  }
}
