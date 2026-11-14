import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ReceiveTransferRequestSchema,
  StockTransferRequestSchema,
  type StockTransferView,
  type TransferDestination,
} from '@kitchos/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { Principal, RequirePermission, StaffAuthGuard } from '../auth/auth.guard.ts';
import type { StaffPrincipal } from '../auth/auth.service.ts';
import { requireIdempotencyKey } from '../infra/idempotency.ts';
import { UuidParam, ZodPipe } from '../infra/zod.ts';
import { StockTransferService } from './stock-transfer.service.ts';

const ListQuery = z.object({
  direction: z.enum(['incoming', 'outgoing']),
  status: z.enum(['in_transit', 'received']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Stock transfers (ADR-0019). Sending and receiving each need `inventory.adjust` at the
 * restaurant doing it; the other side needs no access to the sender's restaurant.
 */
@Controller('v1/restaurants/:restaurantId/inventory')
@UseGuards(StaffAuthGuard)
export class StockTransferController {
  constructor(@Inject(StockTransferService) private readonly transfers: StockTransferService) {}

  @Get('transfer-destinations')
  @RequirePermission('inventory.adjust')
  destinations(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Principal() p: StaffPrincipal,
  ): Promise<TransferDestination[]> {
    return this.transfers.destinations({ orgId: p.orgId, restaurantId });
  }

  @Get('transfers')
  @RequirePermission('inventory.adjust')
  list(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Query(new ZodPipe(ListQuery)) q: z.output<typeof ListQuery>,
    @Principal() p: StaffPrincipal,
  ): Promise<StockTransferView[]> {
    return this.transfers.list({ orgId: p.orgId, restaurantId }, q);
  }

  @Get('transfers/:transferId')
  @RequirePermission('inventory.adjust')
  get(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('transferId', UuidParam) transferId: string,
    @Principal() p: StaffPrincipal,
  ): Promise<StockTransferView> {
    return this.transfers.get({ orgId: p.orgId, restaurantId }, transferId);
  }

  @Post('transfers')
  @RequirePermission('inventory.adjust')
  async dispatch(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Body(new ZodPipe(StockTransferRequestSchema))
    body: z.output<typeof StockTransferRequestSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Principal() p: StaffPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockTransferView> {
    const result = await this.transfers.dispatch(
      { orgId: p.orgId, restaurantId, userId: p.userId },
      body,
      requireIdempotencyKey(key),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Post('transfers/:transferId/receive')
  @RequirePermission('inventory.adjust')
  async receive(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('transferId', UuidParam) transferId: string,
    @Body(new ZodPipe(ReceiveTransferRequestSchema))
    body: z.output<typeof ReceiveTransferRequestSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Principal() p: StaffPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockTransferView> {
    const result = await this.transfers.receive(
      { orgId: p.orgId, restaurantId, userId: p.userId },
      transferId,
      body,
      requireIdempotencyKey(key),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }
}
