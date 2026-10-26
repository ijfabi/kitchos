import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { LiveEvent } from '@kitchos/contracts';
import pg from 'pg';
import type { Logger } from 'pino';
import { Subject, type Observable, filter, map } from 'rxjs';
import { APP_CONFIG, type AppConfig } from '../config.ts';
import { LOGGER } from '../infra/tokens.ts';

interface Notification extends LiveEvent {
  orgId: string;
  restaurantId: string;
}

/**
 * Fans out committed outbox events to live screens. Each API replica holds one
 * LISTEN connection; Postgres delivers NOTIFY only after commit. Payloads carry
 * identifiers only — clients refetch authoritative state through authorised
 * endpoints — so a missed notification costs latency, never correctness.
 */
@Injectable()
export class LiveEventsService implements OnModuleInit, OnApplicationShutdown {
  private readonly events = new Subject<Notification>();
  private client: pg.Client | null = null;
  private stopped = false;
  private retryMs = 500;
  connected = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.events.complete();
    await this.client?.end().catch(() => undefined);
  }

  forRestaurant(orgId: string, restaurantId: string): Observable<LiveEvent> {
    return this.events.pipe(
      filter((e) => e.orgId === orgId && e.restaurantId === restaurantId),
      map(({ seq, type, aggregateType, aggregateId }) => ({
        seq,
        type,
        aggregateType,
        aggregateId,
      })),
    );
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({
      connectionString: this.config.DATABASE_URL,
      application_name: 'kitchos-live-events',
    });
    client.on('notification', (msg) => {
      if (msg.channel !== 'kitchos_events' || !msg.payload) return;
      try {
        this.events.next(JSON.parse(msg.payload) as Notification);
      } catch (err) {
        this.logger.warn({ err }, 'ignoring malformed notification');
      }
    });
    client.on('error', (err) => {
      this.logger.error({ err }, 'live events connection error');
      this.scheduleReconnect(client);
    });
    client.on('end', () => this.scheduleReconnect(client));
    try {
      await client.connect();
      await client.query('LISTEN kitchos_events');
      this.client = client;
      this.connected = true;
      this.retryMs = 500;
    } catch (err) {
      this.logger.error({ err }, 'could not start live events listener');
      this.scheduleReconnect(client);
    }
  }

  private scheduleReconnect(client: pg.Client): void {
    if (this.client && this.client !== client) return;
    this.connected = false;
    this.client = null;
    if (this.stopped) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    setTimeout(() => void this.connect(), delay).unref();
  }
}
