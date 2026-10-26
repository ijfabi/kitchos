import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type Database, type Tx } from '@kitchos/database';
import type { OrderView, OverrideResponse } from '@kitchos/contracts';
import {
  applyDiscount,
  DomainError,
  discountBasisPoints,
  type DiscountSpec,
} from '@kitchos/domain';
import { sql } from 'kysely';
import { AuthService } from '../auth/auth.service.ts';
import { permissionsAt, type Permission } from '../auth/permissions.ts';
import { appendEvents, type DomainEventInput } from '../events/outbox.ts';
import { audit } from '../infra/audit.ts';
import { ApiException, forbidden, notFound } from '../infra/http-errors.ts';
import { idempotent, type IdempotentResult } from '../infra/idempotency.ts';
import { DB } from '../infra/tokens.ts';
import { OrdersService } from './orders.service.ts';

const OVERRIDE_TTL_SECONDS = 120;

export interface DiscountContext {
  orgId: string;
  restaurantId: string;
  userId: string;
  permissions: Set<Permission>;
}

export interface DiscountInput {
  kind: 'percent' | 'amount';
  value: number;
  reason: string;
  note?: string | undefined;
  overrideToken?: string | undefined;
}

export interface OverrideContext {
  orgId: string;
  restaurantId: string;
  requesterId: string;
}

export interface OverrideInput {
  email: string;
  password: string;
  action: 'order.discount';
  orderId: string;
  discount: { kind: 'percent' | 'amount'; value: number; reason: string };
}

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

const toSpec = (d: { kind: 'percent' | 'amount'; value: number }): DiscountSpec =>
  d.kind === 'percent'
    ? { kind: 'percent', basisPoints: d.value }
    : { kind: 'amount', cents: d.value };

/**
 * Order discounts with a self-approval policy and terminal manager overrides.
 *
 * Crew may apply discounts within the restaurant's self-approval limits. Above
 * them (or for any complimentary order) the requester needs `discount.approve`
 * or a manager override: the approver re-authenticates at the terminal and
 * receives a single-use secret bound to this restaurant, action, order and
 * requesting user, valid for two minutes. Every grant and use is audited.
 */
@Injectable()
export class DiscountsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  async createOverride(ctx: OverrideContext, input: OverrideInput): Promise<OverrideResponse> {
    try {
      return await this.grantOverride(ctx, input);
    } catch (err) {
      // Failed approvals are security-relevant: record who tried, for whom and why.
      if (err instanceof ApiException && (err.status === 401 || err.status === 403)) {
        await withTenant(this.db, { orgId: ctx.orgId }, (tx) =>
          audit(tx, {
            orgId: ctx.orgId,
            restaurantId: ctx.restaurantId,
            actorUserId: ctx.requesterId,
            action: 'override.denied',
            entityType: 'order',
            entityId: input.orderId,
            reason: err.code,
            data: {
              action: input.action,
              approverEmail: input.email.trim().toLowerCase(),
              discount: input.discount,
            },
          }),
        ).catch(() => undefined);
      }
      throw err;
    }
  }

  private async grantOverride(
    ctx: OverrideContext,
    input: OverrideInput,
  ): Promise<OverrideResponse> {
    const approver = await this.auth.verifyCredentials(input.email, input.password);
    // A valid account in another tenant is indistinguishable from bad credentials.
    if (approver.orgId !== ctx.orgId) {
      throw new ApiException(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    if (approver.userId === ctx.requesterId) {
      throw forbidden('An override must be approved by someone else');
    }
    return withTenant(this.db, { orgId: ctx.orgId }, async (tx) => {
      const restaurant = await this.auth.loadRestaurantScope(tx, ctx.restaurantId);
      if (!restaurant) throw notFound('Restaurant');
      if (!permissionsAt(approver.assignments, restaurant).has('discount.approve')) {
        throw forbidden(`${approver.displayName} cannot approve discounts at this restaurant`);
      }
      const order = await tx
        .selectFrom('orders')
        .select(['id', 'status', 'tax_rate_bp'])
        .where('id', '=', input.orderId)
        .where('restaurant_id', '=', ctx.restaurantId)
        .executeTakeFirst();
      if (!order) throw notFound('Order');
      if (order.status !== 'pending_payment') {
        throw new ApiException(409, 'ORDER_NOT_AWAITING_PAYMENT', `Order is ${order.status}`);
      }
      // The approver authorises a specific amount, computed exactly as the discount will be.
      const { discountCents } = applyDiscount(
        await this.discountableLines(tx, order.id),
        toSpec(input.discount),
        order.tax_rate_bp,
      );
      const secret = randomBytes(32).toString('hex');
      const row = await tx
        .insertInto('manager_overrides')
        .values({
          org_id: ctx.orgId,
          restaurant_id: ctx.restaurantId,
          action: input.action,
          order_id: order.id,
          approver_user_id: approver.userId,
          requested_by: ctx.requesterId,
          discount_kind: input.discount.kind,
          discount_value: input.discount.value,
          discount_reason: input.discount.reason,
          discount_cents: discountCents,
          secret_hash: hashSecret(secret),
          expires_at: sql<Date>`now() + make_interval(secs => ${OVERRIDE_TTL_SECONDS})`,
        })
        .returning(['id', 'expires_at'])
        .executeTakeFirstOrThrow();
      await audit(tx, {
        orgId: ctx.orgId,
        restaurantId: ctx.restaurantId,
        actorUserId: approver.userId,
        action: 'override.granted',
        entityType: 'manager_override',
        entityId: row.id,
        data: {
          action: input.action,
          orderId: order.id,
          requestedBy: ctx.requesterId,
          discount: input.discount,
          discountCents,
        },
      });
      return {
        overrideToken: secret,
        expiresAt: row.expires_at.toISOString(),
        approverName: approver.displayName,
        discountCents,
      };
    });
  }

  private discountableLines(tx: Tx, orderId: string) {
    return tx
      .selectFrom('order_lines')
      .select(['id', 'line_total_cents as lineTotalCents', 'taxable'])
      .where('order_id', '=', orderId)
      .where('kind', 'in', ['item', 'combo'])
      .orderBy('line_no')
      .orderBy('id')
      .execute();
  }

  async applyDiscount(
    ctx: DiscountContext,
    orderId: string,
    input: DiscountInput,
    idempotencyKey: string,
  ): Promise<IdempotentResult<OrderView>> {
    return withTenant(this.db, { orgId: ctx.orgId }, (tx) =>
      idempotent(
        tx,
        ctx.orgId,
        `orders.discount:${ctx.restaurantId}:${orderId}`,
        idempotencyKey,
        input,
        async () => {
          const order = await tx
            .selectFrom('orders as o')
            .innerJoin('restaurants as r', 'r.id', 'o.restaurant_id')
            .select([
              'o.id',
              'o.status',
              'o.version',
              'o.subtotal_cents',
              'o.tax_rate_bp',
              'r.discount_self_approval_bp',
              'r.discount_self_approval_cents',
            ])
            .where('o.id', '=', orderId)
            .where('o.restaurant_id', '=', ctx.restaurantId)
            .forUpdate('o')
            .executeTakeFirst();
          if (!order) throw notFound('Order');
          if (order.status !== 'pending_payment') {
            throw new ApiException(
              409,
              'ORDER_NOT_AWAITING_PAYMENT',
              `Discounts apply only before payment; order is ${order.status}`,
            );
          }
          const existing = await tx
            .selectFrom('order_discounts')
            .select('id')
            .where('order_id', '=', orderId)
            .executeTakeFirst();
          if (existing)
            throw new ApiException(
              409,
              'DISCOUNT_ALREADY_APPLIED',
              'This order already has a discount',
            );

          const lines = await this.discountableLines(tx, orderId);
          const result = applyDiscount(lines, toSpec(input), order.tax_rate_bp);

          const effectiveBp = discountBasisPoints(result.discountCents, order.subtotal_cents);
          const needsApproval =
            input.reason === 'complimentary' ||
            effectiveBp > order.discount_self_approval_bp ||
            result.discountCents > order.discount_self_approval_cents;

          let approvedBy = ctx.userId;
          let overrideId: string | null = null;
          if (needsApproval && !ctx.permissions.has('discount.approve')) {
            if (!input.overrideToken) {
              throw new ApiException(
                403,
                'OVERRIDE_REQUIRED',
                'A manager must approve this discount',
                {
                  discountCents: result.discountCents,
                  effectiveBasisPoints: effectiveBp,
                  limitBasisPoints: order.discount_self_approval_bp,
                  limitCents: order.discount_self_approval_cents,
                },
              );
            }
            const consumed = await tx
              .updateTable('manager_overrides')
              .set({ consumed_at: sql`now()` })
              .where('secret_hash', '=', hashSecret(input.overrideToken))
              .where('restaurant_id', '=', ctx.restaurantId)
              .where('order_id', '=', orderId)
              .where('action', '=', 'order.discount')
              .where('requested_by', '=', ctx.userId)
              // Only the exact discount the approver was shown and authorised.
              .where('discount_kind', '=', input.kind)
              .where('discount_value', '=', input.value)
              .where('discount_reason', '=', input.reason)
              .where('consumed_at', 'is', null)
              .where('expires_at', '>', sql<Date>`now()`)
              .returning(['id', 'approver_user_id'])
              .executeTakeFirst();
            if (!consumed) {
              throw new ApiException(
                403,
                'OVERRIDE_INVALID',
                'The manager override is invalid, expired or already used',
              );
            }
            approvedBy = consumed.approver_user_id;
            overrideId = consumed.id;
          }

          const updated = await tx
            .updateTable('orders')
            .set({
              discount_cents: result.discountCents,
              total_cents: result.totalCents,
              tax_cents: result.taxCents,
              version: order.version + 1,
            })
            .where('id', '=', orderId)
            .where('version', '=', order.version)
            .returning('version')
            .executeTakeFirst();
          if (!updated)
            throw new DomainError('CONCURRENT_MODIFICATION', 'Order changed concurrently');
          for (const [i, line] of lines.entries()) {
            const share = result.lineDiscounts[i]!;
            if (share > 0) {
              await tx
                .updateTable('order_lines')
                .set({ discount_cents: share })
                .where('id', '=', line.id)
                .execute();
            }
          }
          await tx
            .insertInto('order_discounts')
            .values({
              org_id: ctx.orgId,
              order_id: orderId,
              kind: input.kind,
              value: input.value,
              amount_cents: result.discountCents,
              reason: input.reason,
              note: input.note ?? null,
              applied_by: ctx.userId,
              approved_by: approvedBy,
              override_id: overrideId,
            })
            .execute();
          await audit(tx, {
            orgId: ctx.orgId,
            restaurantId: ctx.restaurantId,
            actorUserId: ctx.userId,
            action: 'order.discount',
            entityType: 'order',
            entityId: orderId,
            reason: input.reason,
            data: {
              kind: input.kind,
              value: input.value,
              discountCents: result.discountCents,
              approvedBy,
              overrideId,
              selfApproved: overrideId === null,
              requiredApproval: needsApproval,
            },
          });

          const events: DomainEventInput[] = [
            {
              orgId: ctx.orgId,
              restaurantId: ctx.restaurantId,
              aggregateType: 'order',
              aggregateId: orderId,
              aggregateVersion: updated.version,
              eventType: 'order.discounted',
              payload: {
                discountCents: result.discountCents,
                reason: input.reason,
                totalCents: result.totalCents,
                approvedBy,
                overrideId,
              },
            },
          ];
          // Nothing left to pay (e.g. complimentary): release to the kitchen now.
          if (result.totalCents === 0) {
            events.push(
              ...(await this.orders.accept(tx, {
                orgId: ctx.orgId,
                restaurantId: ctx.restaurantId,
                orderId,
                version: updated.version,
                actor: { userId: ctx.userId },
              })),
            );
          }
          await appendEvents(tx, events);
          return { status: 200, body: await this.orders.view(tx, orderId) };
        },
      ),
    );
  }
}
