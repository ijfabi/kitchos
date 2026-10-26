import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Database } from '@kitchos/database';
import type { Response } from 'express';
import { sql } from 'kysely';
import { LiveEventsService } from '../events/live-events.service.ts';
import { registry } from '../infra/metrics.ts';
import { DB } from '../infra/tokens.ts';

@Controller()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(LiveEventsService) private readonly live: LiveEventsService,
  ) {}

  /** Liveness: the process is running and the event loop responds. */
  @Get('health/live')
  live_(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: dependencies needed to serve traffic are reachable. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<Record<string, unknown>> {
    const checks: Record<string, 'ok' | 'fail'> = {
      database: 'fail',
      liveEvents: this.live.connected ? 'ok' : 'fail',
    };
    try {
      await sql`select 1`.execute(this.db);
      checks.database = 'ok';
    } catch {
      // reported below
    }
    // Live events degrade gracefully (screens fall back to polling); only the database gates readiness.
    const ready = checks.database === 'ok';
    res.status(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', checks };
  }

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async metrics(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  }
}
