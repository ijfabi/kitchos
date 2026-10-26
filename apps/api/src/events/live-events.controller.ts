import { Controller, Inject, Param, Sse, UseGuards, type MessageEvent } from '@nestjs/common';
import { interval, map, merge, type Observable } from 'rxjs';
import { Principal, RequirePermission, StaffAuthGuard } from '../auth/auth.guard.ts';
import type { StaffPrincipal } from '../auth/auth.service.ts';
import { UuidParam } from '../infra/zod.ts';
import { LiveEventsService } from './live-events.service.ts';

@Controller('v1/restaurants/:restaurantId/live')
@UseGuards(StaffAuthGuard)
export class LiveEventsController {
  constructor(@Inject(LiveEventsService) private readonly live: LiveEventsService) {}

  /** Server-sent events for kitchen/expo screens. Heartbeats keep proxies from closing idle streams. */
  @Sse()
  @RequirePermission('orders.view')
  stream(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Principal() p: StaffPrincipal,
  ): Observable<MessageEvent> {
    return merge(
      this.live
        .forRestaurant(p.orgId, restaurantId)
        .pipe(map((data): MessageEvent => ({ type: 'event', data }))),
      interval(15_000).pipe(
        map((): MessageEvent => ({ type: 'heartbeat', data: { at: new Date().toISOString() } })),
      ),
    );
  }
}
