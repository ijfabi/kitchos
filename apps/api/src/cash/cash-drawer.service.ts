import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type Database, type Tx } from '@kitchos/database';
import type { DrawerSessionView, DrawerView } from '@kitchos/contracts';
import { expectedDrawerCash, type DrawerFacts } from '@kitchos/domain';
import { sql } from 'kysely';
import type { Permission } from '../auth/permissions.ts';
import { appendEvents } from '../events/outbox.ts';
import { audit } from '../infra/audit.ts';
import { ApiException, forbidden, notFound } from '../infra/http-errors.ts';
import { idempotent, type IdempotentResult } from '../infra/idempotency.ts';
import { DB } from '../infra/tokens.ts';

export interface CashContext {
  orgId: string;
  restaurantId: string;
  userId: string;
  permissions: Set<Permission>;
}

const num = (v: unknown) => Number(v ?? 0);

/** Facts that determine a session's expected cash, read from the source records. */
export async function drawerFacts(tx: Tx, sessionId: string): Promise<DrawerFacts> {
  const s = await tx
    .selectFrom('drawer_sessions')
    .select('opening_float_cents')
    .where('id', '=', sessionId)
    .executeTakeFirstOrThrow();
  const sales = await tx
    .selectFrom('payments')
    .select(sql<number>`coalesce(sum(amount_cents + cash_rounding_cents), 0)`.as('cents'))
    .where('drawer_session_id', '=', sessionId)
    .where('method', '=', 'cash')
    .where('status', 'in', ['captured', 'partially_refunded', 'refunded'])
    .executeTakeFirstOrThrow();
  const refunds = await tx
    .selectFrom('refunds')
    .select(sql<number>`coalesce(sum(amount_cents + cash_rounding_cents), 0)`.as('cents'))
    .where('drawer_session_id', '=', sessionId)
    .where('method', '=', 'cash')
    .executeTakeFirstOrThrow();
  const moves = await tx
    .selectFrom('drawer_movements')
    .select(['kind', sql<number>`sum(amount_cents)`.as('cents')])
    .where('session_id', '=', sessionId)
    .groupBy('kind')
    .execute();
  const move = (k: string) => num(moves.find((m) => m.kind === k)?.cents);
  return {
    openingFloatCents: s.opening_float_cents,
    cashSalesCents: num(sales.cents),
    cashRefundsCents: num(refunds.cents),
    paidInsCents: move('paid_in'),
    paidOutsCents: move('paid_out'),
    safeDropsCents: move('safe_drop'),
  };
}

/**
 * The drawer session a cash payment or refund belongs to: an explicit session
 * or the acting user's own open session at the restaurant. Cash is
 * accountable to one person and one drawer, so only the session's own cashier
 * may put cash through it. The row is locked FOR SHARE so a concurrent count
 * (FOR UPDATE) cannot close the session underneath a payment. Cash leaving the
 * drawer (refunds) takes FOR UPDATE instead, so two refunds through the same
 * drawer cannot both pass the available-cash check.
 */
export async function resolveCashSession(
  tx: Tx,
  args: {
    restaurantId: string;
    userId: string;
    explicitId?: string | undefined;
    lock?: 'share' | 'update';
  },
): Promise<string> {
  let q = tx
    .selectFrom('drawer_sessions')
    .select(['id', 'opened_by', 'status'])
    .where('restaurant_id', '=', args.restaurantId);
  q = args.explicitId
    ? q.where('id', '=', args.explicitId)
    : q.where('opened_by', '=', args.userId).where('status', '=', 'open');
  const s = await (args.lock === 'update' ? q.forUpdate() : q.forShare()).executeTakeFirst();
  if (!s) {
    throw new ApiException(
      409,
      'DRAWER_SESSION_REQUIRED',
      'Open a cash drawer before taking or refunding cash',
    );
  }
  if (s.status !== 'open')
    throw new ApiException(409, 'DRAWER_SESSION_CLOSED', 'That drawer session is closed');
  if (s.opened_by !== args.userId) {
    throw forbidden('Cash can only go through your own drawer session');
  }
  return s.id;
}

/**
 * Blind counting: expected cash is visible while a session is open only to
 * someone who may manage cash and is not the drawer's own cashier — a
 * supervisor working a till counts it blind like anyone else.
 */
function seesExpected(s: { opened_by: string }, ctx: CashContext): boolean {
  return ctx.permissions.has('cash.manage') && s.opened_by !== ctx.userId;
}

/**
 * Cash drawers and till sessions: open with a float, record paid-ins,
 * paid-outs and safe drops, then close with a blind count. Expected cash is
 * always derived from the source records; a variance above the restaurant
 * threshold needs approval by a different person with `cash.manage`.
 */
@Injectable()
export class CashDrawerService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async listDrawers(ctx: { orgId: string; restaurantId: string }): Promise<DrawerView[]> {
    return withTenant(this.db, ctx, async (tx) => {
      const rows = await tx
        .selectFrom('cash_drawers as d')
        .leftJoin('drawer_sessions as s', (j) =>
          j.onRef('s.drawer_id', '=', 'd.id').on('s.status', '<>', 'closed'),
        )
        .leftJoin('users as u', 'u.id', 's.opened_by')
        .select([
          'd.id',
          'd.code',
          'd.name',
          's.id as session_id',
          's.status',
          's.opened_by',
          'u.display_name',
        ])
        .where('d.restaurant_id', '=', ctx.restaurantId)
        .where('d.active', '=', true)
        .orderBy('d.code')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        activeSession: r.session_id
          ? {
              id: r.session_id,
              status: r.status!,
              openedBy: r.display_name!,
              openedById: r.opened_by!,
            }
          : null,
      }));
    });
  }

  async open(
    ctx: CashContext,
    drawerId: string,
    openingFloatCents: number,
  ): Promise<DrawerSessionView> {
    return withTenant(this.db, ctx, async (tx) => {
      const drawer = await tx
        .selectFrom('cash_drawers')
        .select(['id', 'active'])
        .where('id', '=', drawerId)
        .where('restaurant_id', '=', ctx.restaurantId)
        .executeTakeFirst();
      if (!drawer || !drawer.active) throw notFound('Cash drawer');
      const alreadyMine = () =>
        tx
          .selectFrom('drawer_sessions')
          .select('id')
          .where('restaurant_id', '=', ctx.restaurantId)
          .where('opened_by', '=', ctx.userId)
          .where('status', '<>', 'closed')
          .executeTakeFirst();
      const haveOne = () =>
        new ApiException(409, 'ALREADY_HAVE_DRAWER', 'Close your current drawer session first');
      if (await alreadyMine()) throw haveOne();
      // Partial unique indexes (one active session per drawer, one per person)
      // serialise racing opens; whichever loses gets the matching 409.
      const session = await tx
        .insertInto('drawer_sessions')
        .values({
          org_id: ctx.orgId,
          restaurant_id: ctx.restaurantId,
          drawer_id: drawerId,
          opened_by: ctx.userId,
          opening_float_cents: openingFloatCents,
          business_date: sql<string>`app.business_date(${ctx.restaurantId}::uuid, now())`,
        })
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!session) {
        if (await alreadyMine()) throw haveOne();
        throw new ApiException(409, 'DRAWER_IN_USE', 'That drawer already has an open session');
      }
      await audit(tx, {
        orgId: ctx.orgId,
        restaurantId: ctx.restaurantId,
        actorUserId: ctx.userId,
        action: 'drawer.open',
        entityType: 'drawer_session',
        entityId: session.id,
        data: { drawerId, openingFloatCents },
      });
      await appendEvents(tx, [
        {
          orgId: ctx.orgId,
          restaurantId: ctx.restaurantId,
          aggregateType: 'drawer',
          aggregateId: session.id,
          aggregateVersion: 1,
          eventType: 'drawer.opened',
          payload: { drawerId, openingFloatCents },
        },
      ]);
      return this.view(tx, session.id, ctx);
    });
  }

  async recordMovement(
    ctx: CashContext,
    sessionId: string,
    input: { kind: 'paid_in' | 'paid_out' | 'safe_drop'; amountCents: number; reason: string },
    idempotencyKey: string,
  ): Promise<IdempotentResult<DrawerSessionView>> {
    return withTenant(this.db, ctx, async (tx) => {
      const result = await idempotent(
        tx,
        ctx.orgId,
        `drawer.movement:${ctx.restaurantId}:${sessionId}`,
        idempotencyKey,
        input,
        async () => {
          const s = await this.lockOpenSession(tx, ctx, sessionId);
          if (input.kind === 'paid_out' && !ctx.permissions.has('cash.manage')) {
            throw forbidden('Paid-outs need a supervisor or manager');
          }
          if (s.opened_by !== ctx.userId && !ctx.permissions.has('cash.manage')) {
            throw forbidden('Only the drawer’s cashier or a manager can move its cash');
          }
          // Only someone who may see expected cash gets the available-cash check:
          // for a blind cashier its 422 would let them probe the hidden figure.
          // Their over-removal still shows up as a variance at the count.
          if (input.kind !== 'paid_in' && seesExpected(s, ctx)) {
            const available = expectedDrawerCash(await drawerFacts(tx, sessionId));
            if (input.amountCents > available) {
              throw new ApiException(
                422,
                'INSUFFICIENT_DRAWER_CASH',
                'The drawer does not hold that much cash',
              );
            }
          }
          const movement = await tx
            .insertInto('drawer_movements')
            .values({
              org_id: ctx.orgId,
              session_id: sessionId,
              kind: input.kind,
              amount_cents: input.amountCents,
              reason: input.reason,
              recorded_by: ctx.userId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await audit(tx, {
            orgId: ctx.orgId,
            restaurantId: ctx.restaurantId,
            actorUserId: ctx.userId,
            action: `drawer.${input.kind}`,
            entityType: 'drawer_session',
            entityId: sessionId,
            reason: input.reason,
            data: { movementId: movement.id, amountCents: input.amountCents },
          });
          await appendEvents(tx, [
            {
              orgId: ctx.orgId,
              restaurantId: ctx.restaurantId,
              aggregateType: 'drawer',
              aggregateId: movement.id,
              aggregateVersion: 1,
              eventType: 'drawer.movement_recorded',
              payload: { sessionId, kind: input.kind, amountCents: input.amountCents },
            },
          ]);
          return { status: 201, body: await this.view(tx, sessionId, ctx) };
        },
      );
      // A replay returns the stored response, which was rendered for the original
      // actor (maybe a manager who could see expected cash): re-render for this caller.
      return result.replayed ? { ...result, body: await this.view(tx, sessionId, ctx) } : result;
    });
  }

  /**
   * Blind count. The cashier (or a manager) states the counted cash; expected
   * cash is computed from the records under the session lock and the variance
   * is revealed only in the response. Within the threshold the session closes;
   * beyond it, it waits for approval.
   */
  async count(
    ctx: CashContext,
    sessionId: string,
    input: { countedCents: number; notes?: string | undefined },
    idempotencyKey: string,
  ): Promise<IdempotentResult<DrawerSessionView>> {
    return withTenant(this.db, ctx, (tx) =>
      idempotent(
        tx,
        ctx.orgId,
        `drawer.count:${ctx.restaurantId}:${sessionId}`,
        idempotencyKey,
        input,
        async () => {
          const s = await this.lockOpenSession(tx, ctx, sessionId);
          if (s.opened_by !== ctx.userId && !ctx.permissions.has('cash.manage')) {
            throw forbidden('Only the drawer’s cashier or a manager can count it');
          }
          const expected = expectedDrawerCash(await drawerFacts(tx, sessionId));
          const variance = input.countedCents - expected;
          const { cash_variance_threshold_cents: threshold } = await tx
            .selectFrom('restaurants')
            .select('cash_variance_threshold_cents')
            .where('id', '=', ctx.restaurantId)
            .executeTakeFirstOrThrow();
          const needsApproval = Math.abs(variance) > threshold;
          await tx
            .updateTable('drawer_sessions')
            .set({
              status: needsApproval ? 'pending_approval' : 'closed',
              counted_by: ctx.userId,
              counted_at: sql`now()`,
              counted_cents: input.countedCents,
              expected_cents: expected,
              variance_cents: variance,
              closed_at: needsApproval ? null : sql`now()`,
              close_notes: input.notes ?? null,
              version: s.version + 1,
            })
            .where('id', '=', sessionId)
            .where('version', '=', s.version)
            .execute();
          await audit(tx, {
            orgId: ctx.orgId,
            restaurantId: ctx.restaurantId,
            actorUserId: ctx.userId,
            action: 'drawer.count',
            entityType: 'drawer_session',
            entityId: sessionId,
            reason: input.notes ?? null,
            data: {
              countedCents: input.countedCents,
              expectedCents: expected,
              varianceCents: variance,
              needsApproval,
            },
          });
          if (!needsApproval)
            await appendEvents(tx, [this.closedEvent(ctx, sessionId, s.version + 1)]);
          return {
            status: 200,
            body: await this.view(tx, sessionId, { ...ctx, revealExpected: true }),
          };
        },
      ),
    );
  }

  async approve(ctx: CashContext, sessionId: string, notes: string): Promise<DrawerSessionView> {
    return withTenant(this.db, ctx, async (tx) => {
      const s = await tx
        .selectFrom('drawer_sessions')
        .select(['id', 'status', 'counted_by', 'opened_by', 'version'])
        .where('id', '=', sessionId)
        .where('restaurant_id', '=', ctx.restaurantId)
        .forUpdate()
        .executeTakeFirst();
      if (!s) throw notFound('Drawer session');
      if (s.status !== 'pending_approval') {
        throw new ApiException(409, 'INVALID_STATE_TRANSITION', `Drawer session is ${s.status}`);
      }
      if (s.counted_by === ctx.userId || s.opened_by === ctx.userId)
        throw forbidden(
          'A variance must be approved by someone who neither ran nor counted the drawer',
        );
      await tx
        .updateTable('drawer_sessions')
        .set({
          status: 'closed',
          approved_by: ctx.userId,
          closed_at: sql`now()`,
          version: s.version + 1,
        })
        .where('id', '=', sessionId)
        .where('version', '=', s.version)
        .execute();
      await audit(tx, {
        orgId: ctx.orgId,
        restaurantId: ctx.restaurantId,
        actorUserId: ctx.userId,
        action: 'drawer.approve_variance',
        entityType: 'drawer_session',
        entityId: sessionId,
        reason: notes,
      });
      await appendEvents(tx, [this.closedEvent(ctx, sessionId, s.version + 1)]);
      return this.view(tx, sessionId, { ...ctx, revealExpected: true });
    });
  }

  async get(ctx: CashContext, sessionId: string): Promise<DrawerSessionView> {
    return withTenant(this.db, ctx, async (tx) => {
      const s = await tx
        .selectFrom('drawer_sessions')
        .select('id')
        .where('id', '=', sessionId)
        .where('restaurant_id', '=', ctx.restaurantId)
        .executeTakeFirst();
      if (!s) throw notFound('Drawer session');
      return this.view(tx, sessionId, ctx);
    });
  }

  /**
   * Sessions of one business day (default: today's), plus any session from an
   * earlier day that is still open or awaiting approval so it cannot be missed.
   */
  async list(ctx: CashContext, businessDate?: string): Promise<DrawerSessionView[]> {
    return withTenant(this.db, ctx, async (tx) => {
      const day = businessDate ?? sql<string>`app.business_date(${ctx.restaurantId}::uuid, now())`;
      const ids = await tx
        .selectFrom('drawer_sessions')
        .select('id')
        .where('restaurant_id', '=', ctx.restaurantId)
        .where((w) => w.or([w('business_date', '=', day), w('status', '<>', 'closed')]))
        .orderBy('opened_at')
        .execute();
      const out: DrawerSessionView[] = [];
      for (const { id } of ids) out.push(await this.view(tx, id, ctx));
      return out;
    });
  }

  private closedEvent(ctx: CashContext, sessionId: string, version: number) {
    return {
      orgId: ctx.orgId,
      restaurantId: ctx.restaurantId,
      aggregateType: 'drawer' as const,
      aggregateId: sessionId,
      aggregateVersion: version,
      eventType: 'drawer.closed',
      payload: {},
    };
  }

  private async lockOpenSession(tx: Tx, ctx: CashContext, sessionId: string) {
    const s = await tx
      .selectFrom('drawer_sessions')
      .select(['id', 'status', 'opened_by', 'version'])
      .where('id', '=', sessionId)
      .where('restaurant_id', '=', ctx.restaurantId)
      .forUpdate()
      .executeTakeFirst();
    if (!s) throw notFound('Drawer session');
    if (s.status !== 'open')
      throw new ApiException(409, 'DRAWER_SESSION_CLOSED', 'That drawer session is not open');
    return s;
  }

  private async view(
    tx: Tx,
    sessionId: string,
    ctx: CashContext & { revealExpected?: boolean },
  ): Promise<DrawerSessionView> {
    const s = await tx
      .selectFrom('drawer_sessions as s')
      .innerJoin('cash_drawers as d', 'd.id', 's.drawer_id')
      .innerJoin('users as o', 'o.id', 's.opened_by')
      .leftJoin('users as c', 'c.id', 's.counted_by')
      .leftJoin('users as a', 'a.id', 's.approved_by')
      .select([
        's.id',
        's.drawer_id',
        'd.name as drawer_name',
        's.status',
        's.opened_by',
        'o.display_name as opened_by_name',
        's.opened_at',
        's.business_date',
        's.opening_float_cents',
        's.counted_cents',
        's.variance_cents',
        's.closed_at',
        'c.display_name as counted_by_name',
        'a.display_name as approved_by_name',
      ])
      .where('s.id', '=', sessionId)
      .executeTakeFirstOrThrow();
    const movements = await tx
      .selectFrom('drawer_movements as m')
      .innerJoin('users as u', 'u.id', 'm.recorded_by')
      .select(['m.id', 'm.kind', 'm.amount_cents', 'm.reason', 'm.created_at', 'u.display_name'])
      .where('m.session_id', '=', sessionId)
      .orderBy('m.id')
      .execute();
    // Blind count: the expected figure stays hidden from the cashier until they have counted.
    const reveal = s.status !== 'open' || ctx.revealExpected === true || seesExpected(s, ctx);
    const facts = reveal ? await drawerFacts(tx, sessionId) : null;
    return {
      id: s.id,
      drawerId: s.drawer_id,
      drawerName: s.drawer_name,
      status: s.status as DrawerSessionView['status'],
      openedBy: s.opened_by_name,
      openedById: s.opened_by,
      openedAt: s.opened_at.toISOString(),
      businessDate: s.business_date,
      openingFloatCents: s.opening_float_cents,
      expected: facts
        ? {
            cashSalesCents: facts.cashSalesCents,
            cashRefundsCents: facts.cashRefundsCents,
            paidInsCents: facts.paidInsCents,
            paidOutsCents: facts.paidOutsCents,
            safeDropsCents: facts.safeDropsCents,
            expectedCents: expectedDrawerCash(facts),
          }
        : null,
      countedCents: s.counted_cents,
      varianceCents: s.variance_cents,
      countedBy: s.counted_by_name,
      approvedBy: s.approved_by_name,
      closedAt: s.closed_at?.toISOString() ?? null,
      movements: movements.map((m) => ({
        id: m.id,
        kind: m.kind,
        amountCents: m.amount_cents,
        reason: m.reason,
        recordedBy: m.display_name,
        createdAt: m.created_at.toISOString(),
      })),
    };
  }
}
