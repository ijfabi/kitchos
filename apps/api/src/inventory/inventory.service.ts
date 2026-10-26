import { Injectable } from '@nestjs/common';
import type { Tx } from '@kitchos/database';
import { DomainError, formatDecimalQty, parseDecimalQty } from '@kitchos/domain';
import { sql } from 'kysely';

export interface LineRequirement {
  orderLineId: string;
  ingredients: readonly { inventoryItemId: string; quantityMilli: number }[];
}

export interface Actor {
  userId?: string | null;
  deviceId?: string | null;
}

export const ORDER_LINE_SOURCE = 'order_line';

export type MovementType =
  | 'receipt'
  | 'production_consumption'
  | 'waste_raw'
  | 'waste_prepared'
  | 'count_adjustment'
  | 'correction';

export interface MovementInput {
  inventoryItemId: string;
  movementType: MovementType;
  /** Signed milli-units of the item's base unit. */
  quantityMilli: number;
  sourceType: string;
  sourceId: string;
  sourceKey?: string;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Physical inventory operations. All methods run inside the caller's
 * transaction and lock stock_balances rows in ascending inventory_item_id
 * order, so concurrent orders cannot deadlock each other.
 */
@Injectable()
export class InventoryService {
  async defaultLocationId(tx: Tx, restaurantId: string): Promise<string> {
    const loc = await tx
      .selectFrom('stock_locations')
      .select('id')
      .where('restaurant_id', '=', restaurantId)
      .where('is_default', '=', true)
      .executeTakeFirst();
    if (!loc) throw new Error(`Restaurant ${restaurantId} has no default stock location`);
    return loc.id;
  }

  /**
   * Reserves ingredient stock for an order's producible lines. With the
   * `block` policy, insufficient available stock (on hand − reserved) rejects
   * the order; with `allow_negative` the reservation is recorded regardless.
   */
  async reserve(
    tx: Tx,
    args: {
      orgId: string;
      restaurantId: string;
      policy: 'block' | 'allow_negative';
      lines: readonly LineRequirement[];
    },
  ): Promise<void> {
    const locationId = await this.defaultLocationId(tx, args.restaurantId);
    const totals = new Map<string, number>();
    for (const l of args.lines) {
      for (const i of l.ingredients)
        totals.set(i.inventoryItemId, (totals.get(i.inventoryItemId) ?? 0) + i.quantityMilli);
    }
    const itemIds = [...totals.keys()].sort(byId);
    if (itemIds.length === 0) return;

    // Make sure a balance row exists for every item (on_hand defaults to 0).
    await tx
      .insertInto('stock_balances')
      .values(
        itemIds.map((id) => ({
          org_id: args.orgId,
          location_id: locationId,
          inventory_item_id: id,
          reserved: '0',
        })),
      )
      .onConflict((oc) => oc.columns(['location_id', 'inventory_item_id']).doNothing())
      .execute();

    const balances = await tx
      .selectFrom('stock_balances as b')
      .innerJoin('inventory_items as i', 'i.id', 'b.inventory_item_id')
      .select(['b.inventory_item_id', 'b.on_hand', 'b.reserved', 'i.sku', 'i.name', 'i.base_unit'])
      .where('b.location_id', '=', locationId)
      .where('b.inventory_item_id', 'in', itemIds)
      .orderBy('b.inventory_item_id')
      .forUpdate('b')
      .execute();

    if (args.policy === 'block') {
      const shortages = balances
        .map((b) => {
          const required = totals.get(b.inventory_item_id) ?? 0;
          const available = parseDecimalQty(b.on_hand) - parseDecimalQty(b.reserved);
          return { b, required, available };
        })
        .filter((x) => x.available < x.required)
        .map(({ b, required, available }) => ({
          inventoryItemId: b.inventory_item_id,
          sku: b.sku,
          name: b.name,
          unit: b.base_unit,
          required: formatDecimalQty(required),
          available: formatDecimalQty(Math.max(0, available)),
        }));
      if (shortages.length > 0) {
        throw new DomainError('INSUFFICIENT_STOCK', 'Some items are out of stock', { shortages });
      }
    }

    for (const id of itemIds) {
      await tx
        .updateTable('stock_balances')
        .set({
          reserved: sql`reserved + ${formatDecimalQty(totals.get(id)!)}::numeric`,
          updated_at: sql`now()`,
        })
        .where('location_id', '=', locationId)
        .where('inventory_item_id', '=', id)
        .execute();
    }
    const rows = args.lines.flatMap((l) =>
      l.ingredients.map((i) => ({
        org_id: args.orgId,
        location_id: locationId,
        inventory_item_id: i.inventoryItemId,
        order_line_id: l.orderLineId,
        quantity: formatDecimalQty(i.quantityMilli),
      })),
    );
    if (rows.length > 0) await tx.insertInto('stock_reservations').values(rows).execute();
  }

  /**
   * Records production consumption for one order line, exactly once.
   *
   * The ledger's unique (source_type, source_id, source_key, item, type)
   * constraint turns a replay — duplicate event, double-tapped button, retried
   * request — into a no-op. Movements are recorded even if stock goes
   * negative: physical consumption happened and must never be lost.
   *
   * @returns number of movements inserted (0 when already consumed).
   */
  async consumeLine(
    tx: Tx,
    args: { orgId: string; restaurantId: string; orderLineId: string; actor: Actor },
  ): Promise<number> {
    const ingredients = await tx
      .selectFrom('order_line_ingredients')
      .select(['inventory_item_id', 'quantity'])
      .where('order_line_id', '=', args.orderLineId)
      .orderBy('inventory_item_id')
      .execute();
    if (ingredients.length === 0) return 0;
    const locationId = await this.defaultLocationId(tx, args.restaurantId);
    const inserted = await this.recordMovements(tx, {
      orgId: args.orgId,
      restaurantId: args.restaurantId,
      locationId,
      actor: args.actor,
      movements: ingredients.map((i) => ({
        inventoryItemId: i.inventory_item_id,
        movementType: 'production_consumption',
        quantityMilli: -parseDecimalQty(i.quantity),
        sourceType: ORDER_LINE_SOURCE,
        sourceId: args.orderLineId,
      })),
    });
    await this.closeReservations(tx, locationId, args.orderLineId, 'consumed');
    return inserted.length;
  }

  /**
   * The single path for writing ledger movements. Locks the affected balance
   * rows in ascending item order, then inserts; a movement whose source key
   * already exists is skipped (exactly-once). Returns the rows inserted.
   */
  async recordMovements(
    tx: Tx,
    args: {
      orgId: string;
      restaurantId: string;
      locationId: string;
      actor: Actor;
      notes?: string | null;
      movements: readonly MovementInput[];
    },
  ): Promise<{ id: string; inventory_item_id: string }[]> {
    const movements = args.movements.filter((m) => m.quantityMilli !== 0);
    if (movements.length === 0) return [];
    await this.lockBalances(
      tx,
      args.locationId,
      movements.map((m) => m.inventoryItemId),
    );
    return tx
      .insertInto('stock_movements')
      .values(
        [...movements]
          .sort((a, b) => byId(a.inventoryItemId, b.inventoryItemId))
          .map((m) => ({
            org_id: args.orgId,
            restaurant_id: args.restaurantId,
            location_id: args.locationId,
            inventory_item_id: m.inventoryItemId,
            movement_type: m.movementType,
            quantity_delta: formatDecimalQty(m.quantityMilli),
            source_type: m.sourceType,
            source_id: m.sourceId,
            source_key: m.sourceKey ?? '',
            actor_user_id: args.actor.userId ?? null,
            actor_device_id: args.actor.deviceId ?? null,
            occurred_at: sql<Date>`now()`,
            business_date: sql<string>`app.business_date(${args.restaurantId}::uuid, now())`,
            notes: args.notes ?? null,
          })),
      )
      .onConflict((oc) => oc.constraint('stock_movements_source_unique').doNothing())
      .returning(['id', 'inventory_item_id'])
      .execute();
  }

  /**
   * Locks (creating if absent) balance rows and returns on-hand quantities in
   * milli-units. Used by physical counts, which must compare against a stable
   * on-hand value.
   */
  async lockedBalances(
    tx: Tx,
    args: { orgId: string; locationId: string; itemIds: readonly string[] },
  ): Promise<Map<string, number>> {
    const sorted = [...new Set(args.itemIds)].sort(byId);
    if (sorted.length === 0) return new Map();
    await tx
      .insertInto('stock_balances')
      .values(
        sorted.map((id) => ({
          org_id: args.orgId,
          location_id: args.locationId,
          inventory_item_id: id,
          reserved: '0',
        })),
      )
      .onConflict((oc) => oc.columns(['location_id', 'inventory_item_id']).doNothing())
      .execute();
    const rows = await tx
      .selectFrom('stock_balances')
      .select(['inventory_item_id', 'on_hand'])
      .where('location_id', '=', args.locationId)
      .where('inventory_item_id', 'in', sorted)
      .orderBy('inventory_item_id')
      .forUpdate()
      .execute();
    return new Map(rows.map((r) => [r.inventory_item_id, parseDecimalQty(r.on_hand)]));
  }

  /** Releases any still-active reservations for a line (e.g. cancelled before production). */
  async releaseLine(tx: Tx, args: { restaurantId: string; orderLineId: string }): Promise<void> {
    const locationId = await this.defaultLocationId(tx, args.restaurantId);
    await this.closeReservations(tx, locationId, args.orderLineId, 'released');
  }

  async lineWasConsumed(tx: Tx, orderLineIds: readonly string[]): Promise<Set<string>> {
    if (orderLineIds.length === 0) return new Set();
    const rows = await tx
      .selectFrom('stock_movements')
      .select('source_id')
      .distinct()
      .where('source_type', '=', ORDER_LINE_SOURCE)
      .where('source_id', 'in', orderLineIds)
      .where('source_key', '=', '')
      .where('movement_type', '=', 'production_consumption')
      .execute();
    return new Set(rows.map((r) => r.source_id));
  }

  private async lockBalances(tx: Tx, locationId: string, itemIds: string[]): Promise<void> {
    const sorted = [...new Set(itemIds)].sort(byId);
    if (sorted.length === 0) return;
    await tx
      .selectFrom('stock_balances')
      .select('inventory_item_id')
      .where('location_id', '=', locationId)
      .where('inventory_item_id', 'in', sorted)
      .orderBy('inventory_item_id')
      .forUpdate()
      .execute();
  }

  private async closeReservations(
    tx: Tx,
    locationId: string,
    orderLineId: string,
    status: 'consumed' | 'released',
  ): Promise<void> {
    const closed = await tx
      .updateTable('stock_reservations')
      .set({ status, closed_at: sql`now()` })
      .where('order_line_id', '=', orderLineId)
      .where('status', '=', 'active')
      .returning(['inventory_item_id', 'quantity'])
      .execute();
    closed.sort((a, b) => byId(a.inventory_item_id, b.inventory_item_id));
    for (const r of closed) {
      await tx
        .updateTable('stock_balances')
        .set({ reserved: sql`reserved - ${r.quantity}::numeric`, updated_at: sql`now()` })
        .where('location_id', '=', locationId)
        .where('inventory_item_id', '=', r.inventory_item_id)
        .execute();
    }
  }
}
