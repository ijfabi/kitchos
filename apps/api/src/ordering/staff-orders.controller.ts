import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CancelOrderRequestSchema, OrderStatusSchema, type OrderView } from '@kitchos/contracts';
import { z } from 'zod';
import {
  CurrentPermissions,
  Principal,
  RequirePermission,
  StaffAuthGuard,
} from '../auth/auth.guard.ts';
import type { StaffPrincipal } from '../auth/auth.service.ts';
import type { Permission } from '../auth/permissions.ts';
import { UuidParam, ZodPipe } from '../infra/zod.ts';
import { OrdersService } from './orders.service.ts';

const ListQuery = z.object({
  status: z
    .string()
    .default('accepted,in_preparation,ready')
    .transform((s) => s.split(','))
    .pipe(z.array(OrderStatusSchema).min(1)),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('v1/restaurants/:restaurantId/orders')
@UseGuards(StaffAuthGuard)
export class StaffOrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

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
      limit: query.limit,
    });
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
