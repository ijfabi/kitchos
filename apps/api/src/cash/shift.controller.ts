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
import { CloseShiftRequestSchema, type CurrentShift, type ShiftView } from '@kitchos/contracts';
import { z } from 'zod';
import { Principal, RequirePermission, StaffAuthGuard } from '../auth/auth.guard.ts';
import type { StaffPrincipal } from '../auth/auth.service.ts';
import { BusinessDay, UuidParam, ZodPipe } from '../infra/zod.ts';
import { ShiftService } from './shift.service.ts';

/** Defaults to the restaurant's current business day. */
const DateQuery = z.object({ businessDate: BusinessDay.optional() });

/** Shifts and shift close (ADR-0018): supervisors and managers. */
@Controller('v1/restaurants/:restaurantId/shifts')
@UseGuards(StaffAuthGuard)
export class ShiftController {
  constructor(@Inject(ShiftService) private readonly shifts: ShiftService) {}

  @Get('current')
  @RequirePermission('shift.run')
  async current(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Principal() p: StaffPrincipal,
  ): Promise<CurrentShift> {
    return { shift: await this.shifts.current({ orgId: p.orgId, restaurantId, userId: p.userId }) };
  }

  @Get()
  @RequirePermission('shift.run')
  list(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Query(new ZodPipe(DateQuery)) q: z.output<typeof DateQuery>,
    @Principal() p: StaffPrincipal,
  ): Promise<ShiftView[]> {
    return this.shifts.list({ orgId: p.orgId, restaurantId, userId: p.userId }, q.businessDate);
  }

  @Get(':shiftId')
  @RequirePermission('shift.run')
  get(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('shiftId', UuidParam) shiftId: string,
    @Principal() p: StaffPrincipal,
  ): Promise<ShiftView> {
    return this.shifts.get({ orgId: p.orgId, restaurantId, userId: p.userId }, shiftId);
  }

  @Post()
  @RequirePermission('shift.run')
  open(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Principal() p: StaffPrincipal,
  ): Promise<ShiftView> {
    return this.shifts.open({ orgId: p.orgId, restaurantId, userId: p.userId });
  }

  @Post(':shiftId/close')
  @HttpCode(200)
  @RequirePermission('shift.run')
  close(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('shiftId', UuidParam) shiftId: string,
    @Body(new ZodPipe(CloseShiftRequestSchema)) body: z.output<typeof CloseShiftRequestSchema>,
    @Principal() p: StaffPrincipal,
  ): Promise<ShiftView> {
    return this.shifts.close(
      { orgId: p.orgId, restaurantId, userId: p.userId },
      shiftId,
      body.notes,
    );
  }
}
