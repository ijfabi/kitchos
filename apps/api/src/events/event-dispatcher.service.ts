import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { withTenant, type Database, type Tx } from '@kitchos/database';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import {
  LedgerConsumer,
  type ConsumedEvent,
  type EventConsumer,
} from '../accounting/ledger.consumer.ts';
import { APP_CONFIG, type AppConfig } from '../config.ts';
import { DB, LOGGER } from '../infra/tokens.ts';

export const MAX_ATTEMPTS = 5;
const BATCH = 200;

export interface DispatchStats {
  processed: number;
  failed: number;
  deadLettered: number;
}

/**
 * Delivers committed outbox events to in-process consumers, exactly once per
 * consumer, without bypassing row-level security:
 *
 *  1. ask the narrow SECURITY DEFINER function which tenants have pending
 *     events for a consumer (ids only);
 *  2. for each tenant, inside withTenant (RLS applies), take each pending
 *     event in store order, lock it (SKIP LOCKED, so parallel workers do not
 *     collide), claim it in inbox_events and run the handler — all in one
 *     transaction, so the claim and the effect commit or roll back together;
 *  3. a failing event is recorded with exponential backoff and, after
 *     MAX_ATTEMPTS, dead-lettered; it never blocks the events behind it.
 */
@Injectable()
export class EventDispatcher implements OnModuleInit, OnApplicationShutdown {
  private readonly consumers: EventConsumer[];
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<DispatchStats> | null = null;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(LedgerConsumer) ledger: LedgerConsumer,
  ) {
    this.consumers = [ledger];
  }

  onModuleInit(): void {
    const every = this.config.EVENT_DISPATCH_INTERVAL_MS;
    if (every <= 0) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => this.logger.error({ err }, 'event dispatch failed'));
    }, every);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  /** One pass over all tenants and consumers. Never runs concurrently with itself. */
  runOnce(): Promise<DispatchStats> {
    if (!this.running) {
      this.running = this.dispatchAll().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async dispatchAll(): Promise<DispatchStats> {
    const stats: DispatchStats = { processed: 0, failed: 0, deadLettered: 0 };
    for (const consumer of this.consumers) {
      const { rows } = await sql<{ org_id: string }>`
        select org_id from app.orgs_with_pending_events(${consumer.name}, ${sql.val([...consumer.eventTypes])}::text[])`.execute(
        this.db,
      );
      for (const { org_id } of rows) {
        // One tenant's failure must never starve the others.
        try {
          await this.dispatchTenant(consumer, org_id, stats);
        } catch (err) {
          this.logger.error(
            { err, consumer: consumer.name, orgId: org_id },
            'tenant dispatch failed',
          );
        }
      }
    }
    return stats;
  }

  private async dispatchTenant(
    consumer: EventConsumer,
    orgId: string,
    stats: DispatchStats,
  ): Promise<void> {
    const pending = await withTenant(this.db, { orgId }, (tx) =>
      tx
        .selectFrom('outbox_events as o')
        .select(['o.id', 'o.restaurant_id', 'o.event_type', 'o.aggregate_id'])
        .where('o.event_type', 'in', [...consumer.eventTypes])
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('inbox_events as i')
                .select('i.event_id')
                .whereRef('i.event_id', '=', 'o.id')
                .where('i.consumer', '=', consumer.name),
            ),
          ),
        )
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('event_consumer_failures as f')
                .select('f.event_id')
                .whereRef('f.event_id', '=', 'o.id')
                .where('f.consumer', '=', consumer.name)
                .where((w) =>
                  w.or([
                    w('f.dead_at', 'is not', null),
                    w('f.next_attempt_at', '>', sql<Date>`now()`),
                  ]),
                ),
            ),
          ),
        )
        .orderBy('o.restaurant_id')
        .orderBy('o.store_sequence')
        .limit(BATCH)
        .execute(),
    );

    for (const row of pending) {
      const event: ConsumedEvent = {
        id: row.id,
        orgId,
        restaurantId: row.restaurant_id,
        eventType: row.event_type,
        aggregateId: row.aggregate_id,
      };
      try {
        const outcome = await withTenant(this.db, { orgId }, (tx) =>
          this.attempt(tx, consumer, event),
        );
        if (outcome === 'processed') stats.processed += 1;
        if (outcome === 'failed' || outcome === 'dead') stats.failed += 1;
        if (outcome === 'dead') stats.deadLettered += 1;
      } catch (err) {
        // The transaction itself failed (e.g. connection loss): record outside it.
        stats.failed += 1;
        const dead = await withTenant(this.db, { orgId }, (tx) =>
          this.recordFailure(tx, consumer, event, err),
        );
        if (dead) stats.deadLettered += 1;
      }
    }
  }

  /**
   * One delivery attempt, entirely under the event's row lock: re-check
   * backoff/dead state, then claim + handle inside a savepoint. On failure the
   * savepoint is rolled back and the failure is recorded in the same
   * transaction, so concurrent workers cannot burn extra attempts and a crash
   * cannot lose the attempt count.
   */
  private async attempt(
    tx: Tx,
    consumer: EventConsumer,
    event: ConsumedEvent,
  ): Promise<'processed' | 'skipped' | 'failed' | 'dead'> {
    const locked = await tx
      .selectFrom('outbox_events')
      .select('id')
      .where('id', '=', event.id)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (!locked) return 'skipped'; // another worker has it
    const blocked = await tx
      .selectFrom('event_consumer_failures')
      .select('event_id')
      .where('consumer', '=', consumer.name)
      .where('event_id', '=', event.id)
      .where((w) =>
        w.or([w('dead_at', 'is not', null), w('next_attempt_at', '>', sql<Date>`now()`)]),
      )
      .executeTakeFirst();
    if (blocked) return 'skipped'; // backing off, or dead-lettered meanwhile

    await sql`savepoint consumer_attempt`.execute(tx);
    try {
      const claimed = await tx
        .insertInto('inbox_events')
        .values({ consumer: consumer.name, event_id: event.id, org_id: event.orgId })
        .onConflict((oc) => oc.columns(['consumer', 'event_id']).doNothing())
        .returning('event_id')
        .executeTakeFirst();
      if (!claimed) {
        await sql`release savepoint consumer_attempt`.execute(tx);
        return 'skipped'; // already processed
      }
      await consumer.handle(tx, event);
      // Run deferred checks (journal balance) now, inside the savepoint.
      await sql`set constraints all immediate`.execute(tx);
      await sql`set constraints all deferred`.execute(tx);
      await sql`release savepoint consumer_attempt`.execute(tx);
    } catch (err) {
      await sql`rollback to savepoint consumer_attempt`.execute(tx);
      return (await this.recordFailure(tx, consumer, event, err)) ? 'dead' : 'failed';
    }
    await tx
      .deleteFrom('event_consumer_failures')
      .where('consumer', '=', consumer.name)
      .where('event_id', '=', event.id)
      .execute();
    return 'processed';
  }

  private async recordFailure(
    tx: Tx,
    consumer: EventConsumer,
    event: ConsumedEvent,
    err: unknown,
  ): Promise<boolean> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    const row = await tx
      .insertInto('event_consumer_failures')
      .values({
        consumer: consumer.name,
        event_id: event.id,
        org_id: event.orgId,
        attempts: 1,
        last_error: message,
        next_attempt_at: sql<Date>`now() + interval '5 seconds'`,
      })
      .onConflict((oc) =>
        oc.columns(['consumer', 'event_id']).doUpdateSet({
          attempts: sql`event_consumer_failures.attempts + 1`,
          last_error: message,
          // Exponential backoff: 5s, 10s, 20s, ... capped at one hour.
          next_attempt_at: sql<Date>`now() + least(interval '1 hour', interval '5 seconds' * power(2, event_consumer_failures.attempts))`,
          dead_at: sql<Date | null>`case when event_consumer_failures.attempts + 1 >= ${MAX_ATTEMPTS} then now() else null end`,
          updated_at: sql<Date>`now()`,
        }),
      )
      .returning(['attempts', 'dead_at'])
      .executeTakeFirstOrThrow();
    const level = row.dead_at ? 'error' : 'warn';
    this.logger[level](
      {
        consumer: consumer.name,
        eventId: event.id,
        eventType: event.eventType,
        attempts: row.attempts,
        err: message,
      },
      row.dead_at ? 'event dead-lettered' : 'event consumer failed; will retry',
    );
    return row.dead_at !== null;
  }
}
