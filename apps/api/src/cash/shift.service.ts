import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type Database, type Tx } from '@kitchos/database';
import type {
  DayCloseIssue,
  ShiftDrawer,
  ShiftPerson,
  ShiftTotals,
  ShiftView,
} from '@kitchos/contracts';
import { sql } from 'kysely';
import { audit } from '../infra/audit.ts';
import { ApiException, notFound } from '../infra/http-errors.ts';
import { DB } from '../infra/tokens.ts';

const num = (v: unknown) => Number(v ?? 0);

export interface ShiftContext {
  orgId: string;
  restaurantId: string;
  userId: string;
}

interface Summary {
  totals: ShiftTotals;
  drawers: ShiftDrawer[];
  people: ShiftPerson[];
  warnings: DayCloseIssue[];
}

/**
 * Serialises shift changes (exclusive) with rows being stamped with a shift
 * (shared, by trigger, until commit): a close sees every row stamped with its
 * shift, and a row written after it finds no open shift. Paths that lock a
 * drawer session take it shared before the session.
 */
export async function lockShifts(
  tx: Tx,
  restaurantId: string,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  await (
    mode === 'shared'
      ? sql`select pg_advisory_xact_lock_shared(app.shift_lock_key(${restaurantId}::uuid))`
      : sql`select pg_advisory_xact_lock(app.shift_lock_key(${restaurantId}::uuid))`
  ).execute(tx);
}

/** The restaurant's open shift, if any. */
async function openShiftId(tx: Tx, restaurantId: string): Promise<string | null> {
  const s = await tx
    .selectFrom('shifts')
    .select('id')
    .where('restaurant_id', '=', restaurantId)
    .where('status', '=', 'open')
    .executeTakeFirst();
  return s?.id ?? null;
}

/**
 * Shifts (ADR-0018): a period of trading under one person in charge, across
 * several drawers and cashiers. A shift closes only when all of its drawers are
 * counted and any variance approved, and then keeps an immutable snapshot of
 * what happened during it. Its figures are operational; the books stay per
 * business day.
 */
@Injectable()
export class ShiftService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async open(ctx: ShiftContext): Promise<ShiftView> {
    return withTenant(this.db, ctx, async (tx) => {
      await lockShifts(tx, ctx.restaurantId, 'exclusive');
      if (await openShiftId(tx, ctx.restaurantId)) {
        throw new ApiException(409, 'SHIFT_ALREADY_OPEN', 'Close the current shift first');
      }
      const shift = await tx
        .insertInto('shifts')
        .values({
          org_id: ctx.orgId,
          restaurant_id: ctx.restaurantId,
          opened_by: ctx.userId,
          business_date: sql<string>`app.business_date(${ctx.restaurantId}::uuid, now())`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      // Drawers already running (opened between shifts) are this shift's to close.
      const adopted = await tx
        .updateTable('drawer_sessions')
        .set({ shift_id: shift.id })
        .where('restaurant_id', '=', ctx.restaurantId)
        .where('shift_id', 'is', null)
        .where('status', '<>', 'closed')
        .returning('id')
        .execute();
      await audit(tx, {
        orgId: ctx.orgId,
        restaurantId: ctx.restaurantId,
        actorUserId: ctx.userId,
        action: 'shift.open',
        entityType: 'shift',
        entityId: shift.id,
        data: { adoptedSessions: adopted.map((a) => a.id) },
      });
      return this.render(tx, ctx.restaurantId, shift.id);
    });
  }

  async close(ctx: ShiftContext, shiftId: string, notes: string | undefined): Promise<ShiftView> {
    return withTenant(this.db, ctx, async (tx) => {
      // Waits for rows being stamped with this shift; later ones find it closed.
      await lockShifts(tx, ctx.restaurantId, 'exclusive');
      const s = await tx
        .selectFrom('shifts')
        .select(['id', 'status', 'version'])
        .where('id', '=', shiftId)
        .where('restaurant_id', '=', ctx.restaurantId)
        .forUpdate()
        .executeTakeFirst();
      if (!s) throw notFound('Shift');
      if (s.status !== 'open') {
        throw new ApiException(409, 'SHIFT_ALREADY_CLOSED', 'That shift is already closed');
      }
      const summary = await this.summary(tx, shiftId);
      const blockers = this.blockers(summary.drawers);
      if (blockers.length > 0) {
        throw new ApiException(409, 'SHIFT_NOT_READY', 'The shift cannot be closed yet', {
          blockers,
        });
      }
      const updated = await tx
        .updateTable('shifts')
        .set({
          status: 'closed',
          closed_by: ctx.userId,
          closed_at: sql`now()`,
          notes: notes ?? null,
          summary: JSON.stringify(summary),
          version: s.version + 1,
        })
        .where('id', '=', shiftId)
        .where('version', '=', s.version)
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) {
        throw new ApiException(409, 'CONCURRENT_MODIFICATION', 'The shift changed concurrently');
      }
      await audit(tx, {
        orgId: ctx.orgId,
        restaurantId: ctx.restaurantId,
        actorUserId: ctx.userId,
        action: 'shift.close',
        entityType: 'shift',
        entityId: shiftId,
        ...(notes ? { reason: notes } : {}),
        data: {
          cashVarianceCents: summary.totals.cashVarianceCents,
          warnings: summary.warnings.map((w) => w.code),
        },
      });
      return this.render(tx, ctx.restaurantId, shiftId);
    });
  }

  /** The open shift with its live figures, or null. */
  async current(ctx: ShiftContext): Promise<ShiftView | null> {
    return withTenant(this.db, ctx, async (tx) => {
      const id = await openShiftId(tx, ctx.restaurantId);
      return id ? this.render(tx, ctx.restaurantId, id) : null;
    });
  }

  async get(ctx: ShiftContext, shiftId: string): Promise<ShiftView> {
    return withTenant(this.db, ctx, (tx) => this.render(tx, ctx.restaurantId, shiftId));
  }

  /** Shifts opened or closed on a business day (default: today's), newest first. */
  async list(ctx: ShiftContext, businessDate?: string): Promise<ShiftView[]> {
    return withTenant(this.db, ctx, async (tx) => {
      const day = businessDate ?? sql<string>`app.business_date(${ctx.restaurantId}::uuid, now())`;
      const ids = await tx
        .selectFrom('shifts')
        .select('id')
        .where('restaurant_id', '=', ctx.restaurantId)
        .where((w) =>
          w.or([
            w('business_date', '=', day),
            // A shift that ran past the cutoff shows on the day it closed, too.
            w(sql`app.business_date(restaurant_id, closed_at)`, '=', day),
          ]),
        )
        .orderBy('opened_at', 'desc')
        .execute();
      const out: ShiftView[] = [];
      for (const { id } of ids) out.push(await this.render(tx, ctx.restaurantId, id));
      return out;
    });
  }

  private blockers(drawers: ShiftDrawer[]): DayCloseIssue[] {
    const out: DayCloseIssue[] = [];
    const open = drawers.filter((d) => d.status === 'open');
    if (open.length > 0) {
      out.push({
        code: 'DRAWERS_OPEN',
        message: `Still to be counted: ${open.map((d) => `${d.drawerName} (${d.cashier})`).join(', ')}`,
      });
    }
    const pending = drawers.filter((d) => d.status === 'pending_approval');
    if (pending.length > 0) {
      out.push({
        code: 'VARIANCE_PENDING',
        message: `Variance awaiting approval: ${pending.map((d) => d.drawerName).join(', ')}`,
      });
    }
    return out;
  }

  private async render(tx: Tx, restaurantId: string, shiftId: string): Promise<ShiftView> {
    const s = await tx
      .selectFrom('shifts as s')
      .innerJoin('users as o', 'o.id', 's.opened_by')
      .leftJoin('users as c', 'c.id', 's.closed_by')
      .select([
        's.id',
        's.status',
        's.business_date',
        's.opened_at',
        's.closed_at',
        's.notes',
        's.summary',
        'o.display_name as opened_by_name',
        'c.display_name as closed_by_name',
      ])
      .where('s.id', '=', shiftId)
      .where('s.restaurant_id', '=', restaurantId)
      .executeTakeFirst();
    if (!s) throw notFound('Shift');
    const closed = s.status === 'closed';
    // A closed shift shows what was recorded at its close, never a recomputation.
    const summary = closed ? (s.summary as unknown as Summary) : await this.summary(tx, shiftId);
    return {
      id: s.id,
      status: closed ? 'closed' : 'open',
      businessDate: s.business_date,
      openedBy: s.opened_by_name,
      openedAt: s.opened_at.toISOString(),
      closedBy: s.closed_by_name,
      closedAt: s.closed_at?.toISOString() ?? null,
      notes: s.notes,
      blockers: closed ? [] : this.blockers(summary.drawers),
      warnings: summary.warnings,
      totals: summary.totals,
      drawers: summary.drawers,
      people: summary.people,
    };
  }

  /**
   * What was recorded under the shift: every order, payment, refund, discount and drawer session
   * stamped with it (ADR-0018), so commit timing cannot move a row in or out. Drawers come from
   * their count snapshots, so
   * an uncounted drawer stays blind, and cash totals and each person's sales stay hidden until
   * every drawer is counted: otherwise a supervisor running a till could work out its expected
   * cash from them (their sales less card takings).
   */
  private async summary(tx: Tx, shiftId: string): Promise<Summary> {
    const sessions = await tx
      .selectFrom('drawer_sessions as s')
      .innerJoin('cash_drawers as d', 'd.id', 's.drawer_id')
      .innerJoin('users as u', 'u.id', 's.opened_by')
      .leftJoin('users as a', 'a.id', 's.approved_by')
      .select([
        's.id',
        's.opened_by',
        'd.name',
        'u.display_name',
        's.status',
        's.opening_float_cents',
        's.expected_cents',
        's.counted_cents',
        's.variance_cents',
        'a.display_name as approved_by_name',
      ])
      .where('s.shift_id', '=', shiftId)
      .orderBy('s.opened_at')
      .execute();
    const drawers: ShiftDrawer[] = sessions.map((r) => ({
      sessionId: r.id,
      drawerName: r.name,
      cashier: r.display_name,
      status: r.status as ShiftDrawer['status'],
      openingFloatCents: r.opening_float_cents,
      expectedCents: r.expected_cents,
      countedCents: r.counted_cents,
      varianceCents: r.variance_cents,
      approvedBy: r.approved_by_name,
    }));
    const allCounted = sessions.every((r) => r.status !== 'open');

    const orders = await tx
      .selectFrom('orders')
      .select([
        'created_by_user_id',
        sql<string>`count(*)`.as('placed'),
        sql<string>`count(*) filter (where status = 'cancelled')`.as('cancelled'),
        sql<string>`coalesce(sum(total_cents) filter (where status not in ('pending_payment', 'cancelled')), 0)`.as(
          'sales',
        ),
      ])
      .where('shift_id', '=', shiftId)
      .groupBy('created_by_user_id')
      .execute();
    const payments = await tx
      .selectFrom('payments')
      .select([
        sql<string>`coalesce(sum(amount_cents) filter (where method = 'card'), 0)`.as('card'),
        sql<string>`coalesce(sum(amount_cents + cash_rounding_cents) filter (where method = 'cash'), 0)`.as(
          'cash',
        ),
      ])
      .where('shift_id', '=', shiftId)
      .where('captured_at', 'is not', null)
      .executeTakeFirstOrThrow();
    const refunds = await tx
      .selectFrom('refunds')
      .select([
        'requested_by',
        sql<string>`coalesce(sum(amount_cents), 0)`.as('cents'),
        sql<string>`coalesce(sum(amount_cents + cash_rounding_cents) filter (where method = 'cash'), 0)`.as(
          'cash',
        ),
      ])
      .where('shift_id', '=', shiftId)
      .groupBy('requested_by')
      .execute();
    const discounts = await tx
      .selectFrom('order_discounts as od')
      .innerJoin('orders as o', 'o.id', 'od.order_id')
      .select(['od.applied_by', sql<string>`coalesce(sum(o.discount_cents), 0)`.as('cents')])
      .where('od.shift_id', '=', shiftId)
      .groupBy('od.applied_by')
      .execute();

    const variance = (rows: typeof sessions) =>
      rows.length > 0 && rows.every((r) => r.status !== 'open')
        ? rows.reduce((t, r) => t + num(r.variance_cents), 0)
        : null;
    const sum = <R>(rows: R[], f: (r: R) => unknown) => rows.reduce((t, r) => t + num(f(r)), 0);

    const ids = new Set<string>([
      ...orders.flatMap((o) => (o.created_by_user_id ? [o.created_by_user_id] : [])),
      ...refunds.map((r) => r.requested_by),
      ...discounts.map((d) => d.applied_by),
      ...sessions.map((r) => r.opened_by),
    ]);
    const names = new Map(
      ids.size === 0
        ? []
        : (
            await tx
              .selectFrom('users')
              .select(['id', 'display_name'])
              .where('id', 'in', [...ids])
              .execute()
          ).map((u) => [u.id, u.display_name]),
    );
    const people: ShiftPerson[] = [...ids]
      .map((id) => {
        const o = orders.find((r) => r.created_by_user_id === id);
        const theirs = sessions.filter((r) => r.opened_by === id);
        return {
          userId: id,
          name: names.get(id) ?? 'Unknown',
          ordersPlaced: num(o?.placed),
          salesCents: allCounted ? num(o?.sales) : null,
          discountsCents: num(discounts.find((d) => d.applied_by === id)?.cents),
          refundsCents: num(refunds.find((r) => r.requested_by === id)?.cents),
          cashVarianceCents: variance(theirs),
        };
      })
      .sort((a, b) => b.ordersPlaced - a.ordersPlaced || a.name.localeCompare(b.name));

    const warnings: DayCloseIssue[] = [];
    const unfinished = await tx
      .selectFrom('orders')
      .select(sql<string>`count(*)`.as('n'))
      .where('shift_id', '=', shiftId)
      .where('status', 'in', ['pending_payment', 'accepted', 'in_preparation', 'ready'])
      .executeTakeFirstOrThrow();
    if (num(unfinished.n) > 0) {
      warnings.push({
        code: 'ORDERS_UNFINISHED',
        message: `${num(unfinished.n)} order(s) placed during this shift are unfinished.`,
      });
    }

    return {
      totals: {
        ordersPlaced: sum(orders, (o) => o.placed),
        ordersCancelled: sum(orders, (o) => o.cancelled),
        cardTakenCents: num(payments.card),
        cashTakenCents: allCounted ? num(payments.cash) : null,
        cashRefundsCents: allCounted ? sum(refunds, (r) => r.cash) : null,
        refundsCents: sum(refunds, (r) => r.cents),
        discountsCents: sum(discounts, (d) => d.cents),
        cashVarianceCents: sessions.length === 0 ? 0 : variance(sessions),
      },
      drawers,
      people,
      warnings,
    };
  }
}
