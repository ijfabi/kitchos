import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type Database } from '@kitchos/database';
import type { OrderView } from '@kitchos/contracts';
import {
  cashPayableCents,
  DomainError,
  paymentStateMachine,
  type PaymentStatus,
} from '@kitchos/domain';
import { appendEvents } from '../events/outbox.ts';
import { audit } from '../infra/audit.ts';
import { ApiException, notFound } from '../infra/http-errors.ts';
import { idempotent, type IdempotentResult } from '../infra/idempotency.ts';
import { DB } from '../infra/tokens.ts';
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
  amountCents?: number | undefined;
  reason: string;
  note?: string | undefined;
}

/**
 * Refunds against a captured payment. A refund is allowed once the order is
 * finished â€” handed over (a sales return) or cancelled (returning the
 * deposit) â€” and never restores stock. The payment's refunded amount can never
 * exceed what was captured; concurrent refunds serialise on the order and
 * payment rows (order first, per the lock-order convention).
 */
@Injectable()
export class RefundsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  async refund(
    ctx: { orgId: string; restaurantId: string; userId: string },
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
            .select(['o.id', 'o.status', 'o.total_cents', 'r.cash_rounding_increment_cents'])
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
          const amount = input.amountCents ?? remaining;
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
          const treatment = order.status === 'completed' ? 'sales_return' : 'deposit_release';
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
              treatment,
              reason: input.reason,
              note: input.note ?? null,
              provider_reference:
                payment.method === 'card' ? `sbx_rf_${crypto.randomUUID()}` : null,
              requested_by: ctx.userId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();

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
              },
            },
          ]);
          return { status: 201, body: await this.orders.view(tx, orderId) };
        },
      ),
    );
  }
}
