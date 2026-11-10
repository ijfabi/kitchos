import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type Database, type Tx } from '@kitchos/database';
import { sql } from 'kysely';
import type { OrderView } from '@kitchos/contracts';
import {
  itemRefundCents,
  lineGstCents,
  refundGstShare,
  cashPayableCents,
  DomainError,
  expectedDrawerCash,
  paymentStateMachine,
  type PaymentStatus,
} from '@kitchos/domain';
import { drawerFacts, resolveCashSession } from '../cash/cash-drawer.service.ts';
import { appendEvents } from '../events/outbox.ts';
import { audit } from '../infra/audit.ts';
import { ApiException, notFound } from '../infra/http-errors.ts';
import { idempotent, type IdempotentResult } from '../infra/idempotency.ts';
import type { Permission } from '../auth/permissions.ts';
import { DB } from '../infra/tokens.ts';
import { StockOperationsService } from '../inventory/stock-operations.service.ts';
import { OrdersService } from './orders.service.ts';

/**
 * Cash to hand back for a refund of `amount` after `before` has already been
 * refunded: the cumulative cash due for (before + amount) minus that for
 * `before`. Cumulative cash is the total rounded to the increment, capped at
 * the cash the customer actually paid, and exactly that at full refund.
 */
export function cashToReturn(
  payment: { amount_cents: number; cash_rounding_cents: number },
  increment: number,
  before: number,
  amount: number,
): number {
  const cashPaid = payment.amount_cents + payment.cash_rounding_cents;
  const cumulative = (refunded: number) =>
    refunded >= payment.amount_cents
      ? cashPaid
      : Math.min(cashPayableCents(refunded, increment), cashPaid);
  return cumulative(before + amount) - cumulative(before);
}

export interface RefundInput {
  items?: readonly { orderLineId: string; quantity: number }[] | undefined;
  expectedAmountCents?: number | undefined;
  amountCents?: number | undefined;
  reason: string;
  note?: string | undefined;
  drawerSessionId?: string | undefined;
  waste?: readonly { orderLineId: string; quantity: number }[] | undefined;
  preparedVersion?: string | undefined;
}

/** The waste reason that matches a refund reason. */
const WASTE_REASON = {
  quality: 'poor_quality',
  order_error: 'incorrect_order',
  customer_complaint: 'poor_quality',
  cancelled_order: 'cancelled_prepared_order',
  duplicate_charge: 'other',
  other: 'other',
} as const;

/**
 * Refunds against a captured payment. A refund is allowed once the order is
 * finished — handed over (a sales return) or cancelled (returning the
 * deposit) — and never restores stock. The payment's refunded amount can never
 * exceed what was captured; concurrent refunds serialise on the order and
 * payment rows (order first, per the lock-order convention).
 */
@Injectable()
export class RefundsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(StockOperationsService) private readonly stockOps: StockOperationsService,
  ) {}

  async refund(
    ctx: { orgId: string; restaurantId: string; userId: string; permissions: Set<Permission> },
    orderId: string,
    input: RefundInput,
    idempotencyKey: string,
  ): Promise<IdempotentResult<OrderView>> {
    return withTenant(this.db, { orgId: ctx.orgId }, (tx) =>
      idempotent(
        tx,
        ctx.orgId,
        `orders.refund:${ctx.restaurantId}:${orderId}`,
        idempotencyKey,
        input,
        async () => {
          const order = await tx
            .selectFrom('orders as o')
            .innerJoin('restaurants as r', 'r.id', 'o.restaurant_id')
            .select([
              'o.id',
              'o.status',
              'o.order_number',
              'o.total_cents',
              'o.tax_cents',
              'r.cash_rounding_increment_cents',
            ])
            .where('o.id', '=', orderId)
            .where('o.restaurant_id', '=', ctx.restaurantId)
            .forUpdate('o')
            .executeTakeFirst();
          if (!order) throw notFound('Order');
          if (order.status !== 'completed' && order.status !== 'cancelled') {
            throw new ApiException(
              409,
              'REFUND_NOT_ALLOWED',
              order.status === 'pending_payment'
                ? 'Nothing has been paid on this order'
                : 'Cancel the order or hand it over before refunding',
            );
          }
          const payment = await tx
            .selectFrom('payments')
            .select([
              'id',
              'method',
              'status',
              'amount_cents',
              'refunded_cents',
              'cash_rounding_cents',
              'version',
            ])
            .where('order_id', '=', orderId)
            .where('status', 'in', ['captured', 'partially_refunded', 'refunded'])
            .forUpdate()
            .executeTakeFirst();
          if (!payment)
            throw new ApiException(
              409,
              'NO_REFUNDABLE_PAYMENT',
              'This order has no captured payment',
            );
          if (payment.method !== 'card' && payment.method !== 'cash') {
            throw new ApiException(
              409,
              'REFUND_METHOD_UNSUPPORTED',
              `Refunds for ${payment.method} are not supported`,
            );
          }
          const remaining = payment.amount_cents - payment.refunded_cents;
          if (remaining === 0)
            throw new ApiException(409, 'ALREADY_REFUNDED', 'This payment has been fully refunded');
          // A refund by item returns those items' net price; the order lock serialises it.
          const items = input.items
            ? await this.priceItems(tx, orderId, order.tax_cents, input.items)
            : null;
          if (items && items.amountCents === 0) {
            throw new ApiException(422, 'NOTHING_TO_REFUND', 'Those items cost nothing to refund');
          }
          if (
            items &&
            input.expectedAmountCents !== undefined &&
            input.expectedAmountCents !== items.amountCents
          ) {
            throw new ApiException(
              409,
              'REFUND_AMOUNT_CHANGED',
              'The refund for those items has changed since you looked: check it and try again',
              { amountCents: items.amountCents },
            );
          }
          const amount = items?.amountCents ?? input.amountCents ?? remaining;
          if (amount > remaining) {
            throw new ApiException(
              422,
              'REFUND_EXCEEDS_PAYMENT',
              `At most ${remaining} cents can be refunded`,
              {
                refundableCents: remaining,
              },
            );
          }

          const refunded = payment.refunded_cents + amount;
          const nextStatus: PaymentStatus =
            refunded === payment.amount_cents ? 'refunded' : 'partially_refunded';
          paymentStateMachine.assertTransition(payment.status as PaymentStatus, nextStatus);
          const updated = await tx
            .updateTable('payments')
            .set({ status: nextStatus, refunded_cents: refunded, version: payment.version + 1 })
            .where('id', '=', payment.id)
            .where('version', '=', payment.version)
            .returning('version')
            .executeTakeFirst();
          if (!updated)
            throw new DomainError('CONCURRENT_MODIFICATION', 'Payment changed concurrently');

          // Cash is rounded on the running total and capped at the cash actually
          // taken, so a series of partial refunds can never hand back more than
          // the customer paid, and a full refund returns exactly that.
          const cashRounding =
            payment.method === 'cash'
              ? cashToReturn(
                  payment,
                  order.cash_rounding_increment_cents,
                  payment.refunded_cents,
                  amount,
                ) - amount
              : 0;
          // Cash refunds come out of the refunder's own open drawer, which must hold enough cash.
          let drawerSessionId: string | null = null;
          if (payment.method === 'cash') {
            drawerSessionId = await resolveCashSession(tx, {
              restaurantId: ctx.restaurantId,
              userId: ctx.userId,
              explicitId: input.drawerSessionId,
              lock: 'update',
            });
            const available = expectedDrawerCash(await drawerFacts(tx, drawerSessionId));
            if (amount + cashRounding > available) {
              throw new ApiException(
                422,
                'INSUFFICIENT_DRAWER_CASH',
                'Your drawer does not hold enough cash for this refund',
              );
            }
          }
          const treatment = order.status === 'completed' ? 'sales_return' : 'deposit_release';
          // The GST it returns, fixed now: the items' own GST, or for an amount a share of the
          // order's GST that never takes more than is left and takes exactly the rest at the end.
          let gstCents: number | null = null;
          if (treatment === 'sales_return') {
            if (items) {
              gstCents = items.gstCents;
            } else {
              const prior = await tx
                .selectFrom('refunds')
                .select(sql<string>`coalesce(sum(gst_cents), 0)`.as('g'))
                .where('order_id', '=', orderId)
                .executeTakeFirstOrThrow();
              const left = order.tax_cents - Number(prior.g);
              const share = refundGstShare({
                amountCents: amount,
                orderTotalCents: order.total_cents,
                orderTaxCents: order.tax_cents,
                previouslyRefundedCents: payment.refunded_cents,
              });
              gstCents =
                payment.refunded_cents + amount === payment.amount_cents
                  ? left
                  : Math.max(0, Math.min(share, left));
              gstCents = Math.min(gstCents, amount);
            }
          }
          const refund = await tx
            .insertInto('refunds')
            .values({
              org_id: ctx.orgId,
              restaurant_id: ctx.restaurantId,
              order_id: orderId,
              payment_id: payment.id,
              method: payment.method,
              amount_cents: amount,
              refunded_before_cents: payment.refunded_cents,
              cash_rounding_cents: cashRounding,
              drawer_session_id: drawerSessionId,
              treatment,
              gst_cents: gstCents,
              reason: input.reason,
              note: input.note ?? null,
              provider_reference:
                payment.method === 'card' ? `sbx_rf_${crypto.randomUUID()}` : null,
              requested_by: ctx.userId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          if (items) {
            await tx
              .insertInto('refund_lines')
              .values(
                items.lines.map((l) => ({
                  org_id: ctx.orgId,
                  refund_id: refund.id,
                  order_line_id: l.orderLineId,
                  quantity: l.quantity,
                  amount_cents: l.amountCents,
                  gst_cents: l.gstCents,
                })),
              )
              .execute();
          }

          // Refunded items are waste (ADR-0011); a refund by amount records only what staff enter.
          const reason = input.reason as keyof typeof WASTE_REASON;
          const wasteRecordIds = await this.stockOps.wastePreparedFood(tx, ctx, {
            orderId,
            defaultAll: false,
            overrides:
              input.waste ?? (items ? await this.itemsWaste(tx, orderId, items.lines) : undefined),
            preparedVersion: input.preparedVersion,
            reason: WASTE_REASON[reason],
            notes: `Order #${order.order_number} refunded: ${input.note ?? reason.replace(/_/g, ' ')}`,
          });

          await audit(tx, {
            orgId: ctx.orgId,
            restaurantId: ctx.restaurantId,
            actorUserId: ctx.userId,
            action: 'payment.refund',
            entityType: 'refund',
            entityId: refund.id,
            reason: input.reason,
            data: {
              orderId,
              paymentId: payment.id,
              amountCents: amount,
              treatment,
              method: payment.method,
              items: items?.lines ?? null,
              wasteRecordIds,
            },
          });
          await appendEvents(tx, [
            {
              orgId: ctx.orgId,
              restaurantId: ctx.restaurantId,
              aggregateType: 'refund',
              aggregateId: refund.id,
              aggregateVersion: 1,
              eventType: 'payment.refunded',
              payload: {
                orderId,
                paymentId: payment.id,
                amountCents: amount,
                treatment,
                paymentVersion: updated.version,
                items: items?.lines ?? null,
                wasteRecordIds,
              },
            },
          ]);
          return { status: 201, body: await this.orders.view(tx, orderId) };
        },
      ),
    );
  }

  /**
   * Prices a refund by item: each line's share of its net (after discount) amount, cumulative
   * over earlier item refunds, so a line refunded in parts returns exactly its net amount.
   */
  private async priceItems(
    tx: Tx,
    orderId: string,
    orderTaxCents: number,
    wanted: readonly { orderLineId: string; quantity: number }[],
  ) {
    const lines = await tx
      .selectFrom('order_lines as l')
      .select([
        'l.id',
        'l.name',
        'l.quantity',
        'l.line_total_cents',
        'l.discount_cents',
        'l.taxable',
        (eb) =>
          eb
            .selectFrom('refund_lines as r')
            .select(sql<string>`coalesce(sum(r.quantity), 0)`.as('n'))
            .whereRef('r.order_line_id', '=', 'l.id')
            .as('refunded'),
      ])
      .where('l.order_id', '=', orderId)
      .where('l.parent_line_id', 'is', null) // an item, or a whole meal
      .orderBy('l.line_no')
      .execute();
    // Each line's share of the order's GST, so a GST-free item returns none.
    const gst = lineGstCents(
      orderTaxCents,
      lines.map((l) => ({ netCents: l.line_total_cents - l.discount_cents, taxable: l.taxable })),
    );
    const out: { orderLineId: string; quantity: number; amountCents: number; gstCents: number }[] =
      [];
    for (const w of wanted) {
      const line = lines.find((l) => l.id === w.orderLineId);
      if (!line)
        throw new ApiException(422, 'REFUND_LINE_INVALID', 'That item is not on this order');
      const before = Number(line.refunded ?? 0);
      if (before + w.quantity > line.quantity) {
        throw new ApiException(
          422,
          'REFUND_EXCEEDS_LINE',
          `Only ${line.quantity - before} of ${line.name} can still be refunded`,
        );
      }
      out.push({
        orderLineId: line.id,
        quantity: w.quantity,
        amountCents: itemRefundCents(
          line.line_total_cents - line.discount_cents,
          line.quantity,
          before,
          w.quantity,
        ),
        gstCents: itemRefundCents(gst[lines.indexOf(line)]!, line.quantity, before, w.quantity),
      });
    }
    return {
      lines: out,
      amountCents: out.reduce((s, l) => s + l.amountCents, 0),
      gstCents: out.reduce((s, l) => s + l.gstCents, 0),
    };
  }

  /** The prepared food of refunded items: the item itself, or a meal's components. */
  private async itemsWaste(
    tx: Tx,
    orderId: string,
    refunded: readonly { orderLineId: string; quantity: number }[],
  ): Promise<{ orderLineId: string; quantity: number }[]> {
    const lines = await tx
      .selectFrom('order_lines')
      .select(['id', 'kind', 'quantity', 'parent_line_id'])
      .where('order_id', '=', orderId)
      .execute();
    const prepared = new Map(
      (await this.stockOps.preparedLines(tx, orderId)).map((p) => [p.orderLineId, p.remaining]),
    );
    const out = new Map<string, number>();
    for (const r of refunded) {
      const line = lines.find((l) => l.id === r.orderLineId)!;
      const targets =
        line.kind === 'combo'
          ? lines
              .filter((c) => c.parent_line_id === line.id)
              .map((c) => ({ id: c.id, portions: (c.quantity / line.quantity) * r.quantity }))
          : [{ id: line.id, portions: r.quantity }];
      for (const t of targets) {
        const left = prepared.get(t.id);
        if (left === undefined || left === 0) continue; // not made, or already recorded
        out.set(t.id, Math.min(t.portions, left));
      }
    }
    return [...out].map(([orderLineId, quantity]) => ({ orderLineId, quantity }));
  }
}
