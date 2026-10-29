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
  DrawerApproveRequestSchema,
  DrawerCountRequestSchema,
  DrawerMovementRequestSchema,
  OpenDrawerSessionRequestSchema,
  type DrawerSessionView,
  type DrawerView,
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
import { CashDrawerService } from './cash-drawer.service.ts';

/** Defaults to the restaurant's current business day. */
const DateQuery = z.object({ businessDate: z.iso.date().optional() });

@Controller('v1/restaurants/:restaurantId/cash')
@UseGuards(StaffAuthGuard)
export class CashController {
  constructor(@Inject(CashDrawerService) private readonly cash: CashDrawerService) {}

  @Get('drawers')
  @RequirePermission('cash.drawer')
  drawers(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Principal() p: StaffPrincipal,
  ): Promise<DrawerView[]> {
    return this.cash.listDrawers({ orgId: p.orgId, restaurantId });
  }

  @Post('drawers/:drawerId/sessions')
  @RequirePermission('cash.drawer')
  open(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('drawerId', UuidParam) drawerId: string,
    @Body(new ZodPipe(OpenDrawerSessionRequestSchema)) body: { openingFloatCents: number },
    @Principal() p: StaffPrincipal,
    @CurrentPermissions() permissions: Set<Permission>,
  ): Promise<DrawerSessionView> {
    return this.cash.open(
      { orgId: p.orgId, restaurantId, userId: p.userId, permissions },
      drawerId,
      body.openingFloatCents,
    );
  }

  /** Sessions for a business day, with expected cash and variances (managers). */
  @Get('sessions')
  @RequirePermission('cash.manage')
  list(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Query(new ZodPipe(DateQuery)) q: z.output<typeof DateQuery>,
    @Principal() p: StaffPrincipal,
    @CurrentPermissions() permissions: Set<Permission>,
  ): Promise<DrawerSessionView[]> {
    return this.cash.list(
      { orgId: p.orgId, restaurantId, userId: p.userId, permissions },
      q.businessDate,
    );
  }

  @Get('sessions/:sessionId')
  @RequirePermission('cash.drawer')
  get(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('sessionId', UuidParam) sessionId: string,
    @Principal() p: StaffPrincipal,
    @CurrentPermissions() permissions: Set<Permission>,
  ): Promise<DrawerSessionView> {
    return this.cash.get(
      { orgId: p.orgId, restaurantId, userId: p.userId, permissions },
      sessionId,
    );
  }

  @Post('sessions/:sessionId/movements')
  @RequirePermission('cash.drawer')
  async movement(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('sessionId', UuidParam) sessionId: string,
    @Body(new ZodPipe(DrawerMovementRequestSchema))
    body: z.output<typeof DrawerMovementRequestSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Principal() p: StaffPrincipal,
    @CurrentPermissions() permissions: Set<Permission>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DrawerSessionView> {
    const result = await this.cash.recordMovement(
      { orgId: p.orgId, restaurantId, userId: p.userId, permissions },
      sessionId,
      body,
      requireIdempotencyKey(key),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  /** Blind count: the response is the first time the counter sees expected cash and the variance. */
  @Post('sessions/:sessionId/count')
  @HttpCode(200)
  @RequirePermission('cash.drawer')
  async count(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('sessionId', UuidParam) sessionId: string,
    @Body(new ZodPipe(DrawerCountRequestSchema)) body: z.output<typeof DrawerCountRequestSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Principal() p: StaffPrincipal,
    @CurrentPermissions() permissions: Set<Permission>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DrawerSessionView> {
    const result = await this.cash.count(
      { orgId: p.orgId, restaurantId, userId: p.userId, permissions },
      sessionId,
      body,
      requireIdempotencyKey(key),
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Post('sessions/:sessionId/approve')
  @HttpCode(200)
  @RequirePermission('cash.manage')
  approve(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('sessionId', UuidParam) sessionId: string,
    @Body(new ZodPipe(DrawerApproveRequestSchema)) body: { notes: string },
    @Principal() p: StaffPrincipal,
    @CurrentPermissions() permissions: Set<Permission>,
  ): Promise<DrawerSessionView> {
    return this.cash.approve(
      { orgId: p.orgId, restaurantId, userId: p.userId, permissions },
      sessionId,
      body.notes,
    );
  }
}
