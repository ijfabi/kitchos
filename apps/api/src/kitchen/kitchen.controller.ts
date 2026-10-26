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
import { TaskCommandSchema, type KitchenTaskView, type StationView } from '@kitchos/contracts';
import { z } from 'zod';
import { Principal, RequirePermission, StaffAuthGuard } from '../auth/auth.guard.ts';
import type { StaffPrincipal } from '../auth/auth.service.ts';
import { UuidParam, ZodPipe } from '../infra/zod.ts';
import { KitchenService } from './kitchen.service.ts';

const TaskQuery = z.object({
  station: z
    .string()
    .regex(/^[a-z0-9-]{2,32}$/)
    .optional(),
  recentDoneMinutes: z.coerce.number().int().min(0).max(120).default(0),
});

@Controller('v1/restaurants/:restaurantId/kitchen')
@UseGuards(StaffAuthGuard)
export class KitchenController {
  constructor(@Inject(KitchenService) private readonly kitchen: KitchenService) {}

  @Get('stations')
  @RequirePermission('kitchen.view')
  stations(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Principal() p: StaffPrincipal,
  ): Promise<StationView[]> {
    return this.kitchen.listStations(p, restaurantId);
  }

  @Get('tasks')
  @RequirePermission('kitchen.view')
  tasks(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Query(new ZodPipe(TaskQuery)) query: z.output<typeof TaskQuery>,
    @Principal() p: StaffPrincipal,
  ): Promise<KitchenTaskView[]> {
    return this.kitchen.listTasks(p, restaurantId, {
      stationCode: query.station,
      includeRecentDoneMinutes: query.recentDoneMinutes,
    });
  }

  @Post('tasks/:taskId/start')
  @HttpCode(200)
  @RequirePermission('kitchen.operate')
  start(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('taskId', UuidParam) taskId: string,
    @Body(new ZodPipe(TaskCommandSchema)) body: { expectedVersion?: number | undefined },
    @Principal() p: StaffPrincipal,
  ): Promise<KitchenTaskView> {
    return this.kitchen.startTask(
      { orgId: p.orgId, restaurantId, actor: { userId: p.userId } },
      taskId,
      body.expectedVersion,
    );
  }

  @Post('tasks/:taskId/complete')
  @HttpCode(200)
  @RequirePermission('kitchen.operate')
  complete(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Param('taskId', UuidParam) taskId: string,
    @Body(new ZodPipe(TaskCommandSchema)) body: { expectedVersion?: number | undefined },
    @Principal() p: StaffPrincipal,
  ): Promise<KitchenTaskView> {
    return this.kitchen.completeTask(
      { orgId: p.orgId, restaurantId, actor: { userId: p.userId } },
      taskId,
      body.expectedVersion,
    );
  }
}
