import type { Tx } from '@kitchos/database';

export interface DomainEventInput {
  orgId: string;
  restaurantId: string;
  aggregateType: 'order' | 'payment' | 'kitchen_task' | 'stock';
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Appends a domain event to the transactional outbox, in the same transaction
 * as the state change it describes. Assigns a gap-free, store-scoped sequence.
 *
 * Lock-ordering convention: append events LAST in a command. The sequence row
 * lock serialises event production per restaurant until commit.
 */
export async function appendEvents(tx: Tx, events: readonly DomainEventInput[]): Promise<void> {
  if (events.length === 0) return;
  const restaurantId = events[0]!.restaurantId;
  if (events.some((e) => e.restaurantId !== restaurantId)) {
    throw new Error('appendEvents: all events in one call must belong to the same restaurant');
  }
  const { last_sequence } = await tx
    .updateTable('restaurant_event_sequences')
    .set((eb) => ({ last_sequence: eb('last_sequence', '+', events.length) }))
    .where('restaurant_id', '=', restaurantId)
    .returning('last_sequence')
    .executeTakeFirstOrThrow();
  const first = last_sequence - events.length + 1;
  await tx
    .insertInto('outbox_events')
    .values(
      events.map((e, i) => ({
        org_id: e.orgId,
        restaurant_id: e.restaurantId,
        store_sequence: first + i,
        aggregate_type: e.aggregateType,
        aggregate_id: e.aggregateId,
        aggregate_version: e.aggregateVersion,
        event_type: e.eventType,
        payload: JSON.stringify(e.payload),
      })),
    )
    .execute();
}
