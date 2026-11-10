import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { CloseDayRequestSchema, type DayCloseView, type FailedEventView } from '@kitchos/contracts';
import { z } from 'zod';
import { Principal, RequirePermission, StaffAuthGuard } from '../auth/auth.guard.ts';
import type { StaffPrincipal } from '../auth/auth.service.ts';
import { BusinessDay, UuidParam, ZodPipe } from '../infra/zod.ts';
import { DayCloseService } from './day-close.service.ts';

const IsoDate = new ZodPipe(BusinessDay);

@Controller('v1/restaurants/:restaurantId/days/:businessDate')
@UseGuards(StaffAuthGuard)
export class DayCloseController {
  constructor(@Inject(DayCloseService) private readonly days: DayCloseService) {}

  @Get()
  @RequirePermission('reports.view')
  view(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('businessDate', IsoDate) businessDate: string,
    @Principal() p: StaffPrincipal,
  ): Promise<DayCloseView> {
    return this.days.view({ orgId: p.orgId, restaurantId, userId: p.userId }, businessDate);
  }

  @Post('close')
  @HttpCode(200)
  @RequirePermission('day.close')
  close(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('businessDate', IsoDate) businessDate: string,
    @Body(new ZodPipe(CloseDayRequestSchema)) body: z.output<typeof CloseDayRequestSchema>,
    @Principal() p: StaffPrincipal,
  ): Promise<DayCloseView> {
    return this.days.close(
      { orgId: p.orgId, restaurantId, userId: p.userId },
      businessDate,
      body.notes,
    );
  }
}

/** Events the ledger gave up on, and putting them back in its queue. */
@Controller('v1/restaurants/:restaurantId/accounting/failed-events')
@UseGuards(StaffAuthGuard)
export class FailedEventsController {
  constructor(@Inject(DayCloseService) private readonly days: DayCloseService) {}

  @Get()
  @RequirePermission('reports.view')
  list(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Principal() p: StaffPrincipal,
  ): Promise<FailedEventView[]> {
    return this.days.failedEvents({ orgId: p.orgId, restaurantId });
  }

  @Post(':eventId/retry')
  @HttpCode(200)
  @RequirePermission('day.close')
  retry(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('eventId', UuidParam) eventId: string,
    @Principal() p: StaffPrincipal,
  ): Promise<FailedEventView[]> {
    return this.days.retryEvent({ orgId: p.orgId, restaurantId, userId: p.userId }, eventId);
  }
}
