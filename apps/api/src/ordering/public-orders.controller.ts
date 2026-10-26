import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { withTenant, type Database } from '@kitchos/database';
import {
  CreateOrderRequestSchema,
  PayOrderRequestSchema,
  type OrderView,
  type PayOrderRequest,
} from '@kitchos/contracts';
import type { Response } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { resolvePublicRestaurant } from '../catalog/menu.repository.ts';
import { SlugParam } from '../catalog/catalog.controller.ts';
import { requireIdempotencyKey } from '../infra/idempotency.ts';
import { DB } from '../infra/tokens.ts';
import { ZodPipe } from '../infra/zod.ts';
import { OrdersService } from './orders.service.ts';

const TokenParam = new ZodPipe(z.string().regex(/^[0-9a-f]{32}$/));

/**
 * Guest/customer ordering. The tenant is always derived server-side from the
 * restaurant slug or the unguessable order token, never from the client.
 */
@Controller('v1/public')
export class PublicOrdersController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  @Post('restaurants/:slug/orders')
  async place(
    @Param('slug', SlugParam) slug: string,
    @Body(new ZodPipe(CreateOrderRequestSchema)) body: z.output<typeof CreateOrderRequestSchema>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderView> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { restaurantId, orgId } = await resolvePublicRestaurant(this.db, slug);
    const result = await this.orders.placeOrder(
      {
        orgId,
        restaurantId,
        channel: 'web',
        fulfilmentType: body.fulfilmentType,
        customerName: body.customerName,
        lines: body.lines,
        actor: {},
      },
      key,
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get('orders/:token')
  get(@Param('token', TokenParam) token: string): Promise<OrderView> {
    return this.orders.getByPublicToken(token);
  }

  @Post('orders/:token/payments')
  async pay(
    @Param('token', TokenParam) token: string,
    @Body(new ZodPipe(PayOrderRequestSchema)) body: PayOrderRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderView> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { orderId, orgId } = await this.orders.resolvePublicToken(token);
    const result = await this.orders.payWithCard(
      { orgId, orderId, paymentToken: body.paymentToken, actor: {} },
      key,
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  /** Lightweight check used by the pickup screen; exposes no customer data. */
  @Get('restaurants/:slug/pickup-board')
  async pickupBoard(
    @Param('slug', SlugParam) slug: string,
  ): Promise<{ preparing: number[]; ready: number[] }> {
    const { restaurantId, orgId } = await resolvePublicRestaurant(this.db, slug);
    const rows = await withTenant(this.db, { orgId }, (tx) =>
      tx
        .selectFrom('orders')
        .select(['order_number', 'status'])
        .where('restaurant_id', '=', restaurantId)
        .where('status', 'in', ['accepted', 'in_preparation', 'ready'])
        .where(sql<boolean>`business_date = app.business_date(${restaurantId}::uuid, now())`)
        .orderBy('order_number')
        .execute(),
    );
    return {
      preparing: rows.filter((r) => r.status !== 'ready').map((r) => r.order_number),
      ready: rows.filter((r) => r.status === 'ready').map((r) => r.order_number),
    };
  }
}
