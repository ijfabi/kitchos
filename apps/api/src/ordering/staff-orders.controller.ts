import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApplyDiscountRequestSchema,
  RefundRequestSchema,
  CancelOrderRequestSchema,
  OrderChannelSchema,
  OrderStatusSchema,
  StaffCreateOrderRequestSchema,
  StaffPaymentRequestSchema,
  type OrderView,
  type StaffPaymentRequest,
} from '@kitchos/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import {
  CurrentPermissions,
  Principal,
  RequirePermission,
  StaffAuthGuard,
} from '../auth/auth.guard.ts';
import type { StaffPrincipal } from '../auth/auth.service.ts';
import type { Permission } from '../auth/permissions.ts';
import { requireIdempotencyKey } from '../infra/idempotency.ts';
import { UuidParam, ZodPipe } from '../infra/zod.ts';
import { DiscountsService } from './discounts.service.ts';
import { RefundsService } from './refunds.service.ts';
import { OrdersService } from './orders.service.ts';

const ListQuery = z.object({
  status: z
    .string()
    .default('accepted,in_preparation,ready')
    .transform((s) => s.split(','))
    .pipe(z.array(OrderStatusSchema).min(1)),
  channel: OrderChannelSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('v1/restaurants/:restaurantId/orders')
@UseGuards(StaffAuthGuard)
export class StaffOrdersController {
  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(DiscountsService) private readonly discounts: DiscountsService,
    @Inject(RefundsService) private readonly refunds: RefundsService,
  ) {}

  /** Refund (part of) the captured payment of a handed-over or cancelled order. */
  @Post(':orderId/refunds')
  @RequirePermission('payments.refund')
  async refund(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('orderId', UuidParam) orderId: string,
    @Body(new ZodPipe(RefundRequestSchema)) body: z.output<typeof RefundRequestSchema>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Principal() p: StaffPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderView> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.refunds.refund(
      { orgId: p.orgId, restaurantId, userId: p.userId },
      orderId,
      body,
      key,
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  /** Apply a discount to an unpaid order (self-approved within limits, else needs approval). */
  @Post(':orderId/discount')
  @HttpCode(200)
  @RequirePermission('discount.apply')
  async discount(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('orderId', UuidParam) orderId: string,
    @Body(new ZodPipe(ApplyDiscountRequestSchema))
    body: z.output<typeof ApplyDiscountRequestSchema>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Principal() p: StaffPrincipal,
    @CurrentPermissions() permissions: Set<Permission>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderView> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.discounts.applyDiscount(
      { orgId: p.orgId, restaurantId, userId: p.userId, permissions },
      orderId,
      body,
      key,
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get()
  @RequirePermission('orders.view')
  list(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Query(new ZodPipe(ListQuery)) query: z.output<typeof ListQuery>,
    @Principal() p: StaffPrincipal,
  ): Promise<OrderView[]> {
    return this.orders.listForStaff({
      orgId: p.orgId,
      restaurantId,
      statuses: query.status,
      channel: query.channel,
      limit: query.limit,
    });
  }

  /** POS / drive-thru order entry. Priced on the server; leaving it unpaid parks it. */
  @Post()
  @RequirePermission('orders.create')
  async create(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Body(new ZodPipe(StaffCreateOrderRequestSchema))
    body: z.output<typeof StaffCreateOrderRequestSchema>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Principal() p: StaffPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderView> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.orders.placeOrder(
      {
        orgId: p.orgId,
        restaurantId,
        channel: body.channel,
        fulfilmentType: body.fulfilmentType,
        customerName: body.customerName,
        lines: body.lines,
        actor: { userId: p.userId },
      },
      key,
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  /** Take payment at a terminal: cash (with tendered amount) or a sandbox card token. */
  @Post(':orderId/payments')
  @RequirePermission('orders.create')
  async pay(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('orderId', UuidParam) orderId: string,
    @Body(new ZodPipe(StaffPaymentRequestSchema)) body: StaffPaymentRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Principal() p: StaffPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderView> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.orders.takePayment(
      { orgId: p.orgId, orderId, restaurantId, tender: body, actor: { userId: p.userId } },
      key,
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get(':orderId')
  @RequirePermission('orders.view')
  get(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('orderId', UuidParam) orderId: string,
    @Principal() p: StaffPrincipal,
  ): Promise<OrderView> {
    return this.orders.getForStaff({ orgId: p.orgId, restaurantId, orderId });
  }

  @Post(':orderId/handoff')
  @HttpCode(200)
  @RequirePermission('orders.handoff')
  handoff(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('orderId', UuidParam) orderId: string,
    @Principal() p: StaffPrincipal,
  ): Promise<OrderView> {
    return this.orders.handoff({
      orgId: p.orgId,
      restaurantId,
      orderId,
      actor: { userId: p.userId },
    });
  }

  @Post(':orderId/cancel')
  @HttpCode(200)
  @RequirePermission('orders.cancel')
  cancel(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('orderId', UuidParam) orderId: string,
    @Body(new ZodPipe(CancelOrderRequestSchema)) body: { reason: string },
    @Principal() p: StaffPrincipal,
    @CurrentPermissions() permissions: Set<Permission>,
  ): Promise<OrderView> {
    return this.orders.cancel({
      orgId: p.orgId,
      restaurantId,
      orderId,
      reason: body.reason,
      actor: { userId: p.userId },
      permissions,
    });
  }
}
