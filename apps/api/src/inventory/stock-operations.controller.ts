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
  GoodsReceiptRequestSchema,
  RecordWasteRequestSchema,
  ReviewWasteRequestSchema,
  StockCountRequestSchema,
  type GoodsReceiptView,
  type StockCountView,
  type WasteRecordView,
  type WasteSummary,
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
import { StockOperationsService } from './stock-operations.service.ts';

const WasteListQuery = z.object({
  status: z.enum(['recorded', 'pending_approval', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const SummaryQuery = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((q) => q.from <= q.to, 'from must not be after to');

@Controller('v1/restaurants/:restaurantId/inventory')
@UseGuards(StaffAuthGuard)
export class StockOperationsController {
  constructor(@Inject(StockOperationsService) private readonly ops: StockOperationsService) {}

  @Post('waste')
  @RequirePermission('waste.record')
  async recordWaste(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Body(new ZodPipe(RecordWasteRequestSchema)) body: z.output<typeof RecordWasteRequestSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Principal() p: StaffPrincipal,
    @CurrentPermissions() permissions: Set<Permission>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WasteRecordView> {
    const result = await this.ops.recordWaste(
      { orgId: p.orgId, restaurantId, userId: p.userId, permissions },
      body,
      requireIdempotencyKey(key),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get('waste')
  @RequirePermission('inventory.view')
  listWaste(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Query(new ZodPipe(WasteListQuery)) q: z.output<typeof WasteListQuery>,
    @Principal() p: StaffPrincipal,
  ): Promise<WasteRecordView[]> {
    return this.ops.listWaste({ orgId: p.orgId, restaurantId }, q);
  }

  @Get('waste/summary')
  @RequirePermission('reports.view')
  summary(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Query(new ZodPipe(SummaryQuery)) q: z.output<typeof SummaryQuery>,
    @Principal() p: StaffPrincipal,
  ): Promise<WasteSummary> {
    return this.ops.wasteSummary({ orgId: p.orgId, restaurantId }, q.from, q.to);
  }

  @Post('waste/:wasteId/approve')
  @HttpCode(200)
  @RequirePermission('waste.approve')
  approve(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('wasteId', UuidParam) wasteId: string,
    @Body(new ZodPipe(ReviewWasteRequestSchema)) body: { reason: string },
    @Principal() p: StaffPrincipal,
    @CurrentPermissions() permissions: Set<Permission>,
  ): Promise<WasteRecordView> {
    return this.ops.reviewWaste(
      { orgId: p.orgId, restaurantId, userId: p.userId, permissions },
      wasteId,
      'approve',
      body.reason,
    );
  }

  @Post('waste/:wasteId/reject')
  @HttpCode(200)
  @RequirePermission('waste.approve')
  reject(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('wasteId', UuidParam) wasteId: string,
    @Body(new ZodPipe(ReviewWasteRequestSchema)) body: { reason: string },
    @Principal() p: StaffPrincipal,
    @CurrentPermissions() permissions: Set<Permission>,
  ): Promise<WasteRecordView> {
    return this.ops.reviewWaste(
      { orgId: p.orgId, restaurantId, userId: p.userId, permissions },
      wasteId,
      'reject',
      body.reason,
    );
  }

  @Post('receipts')
  @RequirePermission('inventory.adjust')
  async receive(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Body(new ZodPipe(GoodsReceiptRequestSchema)) body: z.output<typeof GoodsReceiptRequestSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Principal() p: StaffPrincipal,
    @CurrentPermissions() permissions: Set<Permission>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GoodsReceiptView> {
    const result = await this.ops.receiveGoods(
      { orgId: p.orgId, restaurantId, userId: p.userId, permissions },
      body,
      requireIdempotencyKey(key),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Post('counts')
  @RequirePermission('inventory.adjust')
  async count(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Body(new ZodPipe(StockCountRequestSchema)) body: z.output<typeof StockCountRequestSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Principal() p: StaffPrincipal,
    @CurrentPermissions() permissions: Set<Permission>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockCountView> {
    const result = await this.ops.recordCount(
      { orgId: p.orgId, restaurantId, userId: p.userId, permissions },
      body,
      requireIdempotencyKey(key),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }
}
