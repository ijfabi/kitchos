import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type Database, type Tx } from '@kitchos/database';
import type { StockTransferView, TransferDestination } from '@kitchos/contracts';
import { formatDecimalQty, parseDecimalQty } from '@kitchos/domain';
import { sql } from 'kysely';
import { appendEvents } from '../events/outbox.ts';
import { audit } from '../infra/audit.ts';
import { ApiException, notFound } from '../infra/http-errors.ts';
import { idempotent, type IdempotentResult } from '../infra/idempotency.ts';
import { DB } from '../infra/tokens.ts';
import { InventoryService } from './inventory.service.ts';

export const STOCK_TRANSFER_SOURCE = 'stock_transfer';

interface TransferContext {
  orgId: string;
  restaurantId: string;
  userId: string;
}

/**
 * Stock transfers between restaurants of one organisation (ADR-0019). The sender
 * dispatches (transfer_out at its default location); the receiver records once what
 * arrived (transfer_in at its default location, valued at the dispatch's cost by the
 * stock ledger), or the sender cancels it and the stock comes back (return_to_stock, also at
 * the dispatch's cost; ADR-0020). Lock order: transfer → stock balances → event sequence.
 */
@Injectable()
export class StockTransferService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(InventoryService) private readonly inventory: InventoryService,
  ) {}

  /** Other active restaurants of the organisation that stock can be sent to. */
  async destinations(ctx: { orgId: string; restaurantId: string }): Promise<TransferDestination[]> {
    return withTenant(this.db, ctx, async (tx) => {
      const rows = await tx
        .selectFrom('restaurants')
        .select(['id', 'name'])
        .where('id', '<>', ctx.restaurantId)
        .where('status', '=', 'active')
        .orderBy('name')
        .execute();
      return rows.map((r) => ({ id: r.id, name: r.name }));
    });
  }

  async dispatch(
    ctx: TransferContext,
    input: {
      toRestaurantId: string;
      notes?: string | undefined;
      lines: { inventoryItemId: string; quantity: string }[];
    },
    idempotencyKey: string,
  ): Promise<IdempotentResult<StockTransferView>> {
    return withTenant(this.db, { orgId: ctx.orgId }, (tx) =>
      idempotent(tx, ctx.orgId, `transfer:${ctx.restaurantId}`, idempotencyKey, input, async () => {
        if (input.toRestaurantId === ctx.restaurantId) {
          throw new ApiException(422, 'TRANSFER_TO_SELF', 'Choose another restaurant to send to');
        }
        // RLS limits this to the caller's organisation: any other id is simply not found.
        const to = await tx
          .selectFrom('restaurants')
          .select('id')
          .where('id', '=', input.toRestaurantId)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (!to) throw notFound('Destination restaurant');
        const items = await tx
          .selectFrom('inventory_items')
          .select('id')
          .where(
            'id',
            'in',
            input.lines.map((l) => l.inventoryItemId),
          )
          .execute();
        if (items.length !== input.lines.length) throw notFound('Inventory item');

        const fromLocation = await this.inventory.defaultLocationId(tx, ctx.restaurantId);
        const toLocation = await tx
          .selectFrom('stock_locations')
          .select('id')
          .where('restaurant_id', '=', input.toRestaurantId)
          .where('is_default', '=', true)
          .executeTakeFirst()
          .then((l) => l?.id);
        if (!toLocation) {
          throw new ApiException(
            422,
            'DESTINATION_HAS_NO_STOCK_LOCATION',
            'That restaurant has no stock location to receive into',
          );
        }
        const transfer = await tx
          .insertInto('stock_transfers')
          .values({
            org_id: ctx.orgId,
            from_restaurant_id: ctx.restaurantId,
            from_location_id: fromLocation,
            to_restaurant_id: input.toRestaurantId,
            to_location_id: toLocation,
            dispatched_by: ctx.userId,
            dispatch_business_date: sql<string>`app.business_date(${ctx.restaurantId}::uuid, now())`,
            notes: input.notes ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('stock_transfer_lines')
          .values(
            input.lines.map((l) => ({
              org_id: ctx.orgId,
              stock_transfer_id: transfer.id,
              inventory_item_id: l.inventoryItemId,
              quantity_sent: formatDecimalQty(parseDecimalQty(l.quantity)),
            })),
          )
          .execute();
        await this.inventory.recordMovements(tx, {
          orgId: ctx.orgId,
          restaurantId: ctx.restaurantId,
          locationId: fromLocation,
          actor: { userId: ctx.userId },
          notes: 'Transfer dispatched',
          movements: input.lines.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            movementType: 'transfer_out',
            quantityMilli: -parseDecimalQty(l.quantity),
            sourceType: STOCK_TRANSFER_SOURCE,
            sourceId: transfer.id,
          })),
        });
        await this.enforceShortagePolicy(tx, ctx.restaurantId, fromLocation, input.lines);
        await audit(tx, {
          orgId: ctx.orgId,
          restaurantId: ctx.restaurantId,
          actorUserId: ctx.userId,
          action: 'inventory.transfer_dispatch',
          entityType: 'stock_transfer',
          entityId: transfer.id,
          data: { toRestaurantId: input.toRestaurantId, lines: input.lines.length },
        });
        await appendEvents(tx, [
          {
            orgId: ctx.orgId,
            restaurantId: ctx.restaurantId,
            aggregateType: 'stock',
            aggregateId: transfer.id,
            aggregateVersion: 1,
            eventType: 'inventory.transfer_dispatched',
            payload: { toRestaurantId: input.toRestaurantId, lines: input.lines.length },
          },
        ]);
        return { status: 201, body: await this.view(tx, transfer.id) };
      }),
    );
  }

  /**
   * Records, once, what arrived of a transfer sent to this restaurant. Every line
   * is accounted for: received (up to what was sent) or short.
   */
  async receive(
    ctx: TransferContext,
    transferId: string,
    input: {
      notes?: string | undefined;
      lines: { inventoryItemId: string; quantityReceived: string }[];
    },
    idempotencyKey: string,
  ): Promise<IdempotentResult<StockTransferView>> {
    return withTenant(this.db, { orgId: ctx.orgId }, (tx) =>
      idempotent(
        tx,
        ctx.orgId,
        `transfer-receive:${ctx.restaurantId}`,
        idempotencyKey,
        { transferId, ...input },
        async () => {
          const transfer = await tx
            .selectFrom('stock_transfers')
            .select(['id', 'status', 'version', 'to_location_id', 'from_restaurant_id'])
            .where('id', '=', transferId)
            .where('to_restaurant_id', '=', ctx.restaurantId)
            .forUpdate()
            .executeTakeFirst();
          if (!transfer) throw notFound('Transfer');
          assertInTransit(transfer.status);
          const sent = await tx
            .selectFrom('stock_transfer_lines')
            .select(['inventory_item_id', 'quantity_sent'])
            .where('stock_transfer_id', '=', transferId)
            .orderBy('inventory_item_id')
            .execute();
          const given = new Map(
            input.lines.map((l) => [l.inventoryItemId, parseDecimalQty(l.quantityReceived)]),
          );
          if (given.size !== sent.length || sent.some((l) => !given.has(l.inventory_item_id))) {
            throw new ApiException(
              422,
              'TRANSFER_LINES_MISMATCH',
              'Record what arrived for every item on the transfer, and only those',
            );
          }
          for (const l of sent) {
            if (given.get(l.inventory_item_id)! > parseDecimalQty(l.quantity_sent)) {
              throw new ApiException(
                422,
                'RECEIVED_EXCEEDS_SENT',
                'More cannot arrive than was sent; record any extra with a stock count',
                { inventoryItemId: l.inventory_item_id },
              );
            }
          }
          for (const l of sent) {
            await tx
              .updateTable('stock_transfer_lines')
              .set({ quantity_received: formatDecimalQty(given.get(l.inventory_item_id)!) })
              .where('stock_transfer_id', '=', transferId)
              .where('inventory_item_id', '=', l.inventory_item_id)
              .execute();
          }
          const updated = await tx
            .updateTable('stock_transfers')
            .set({
              status: 'received',
              received_by: ctx.userId,
              received_at: sql<Date>`now()`,
              receive_business_date: sql<string>`app.business_date(${ctx.restaurantId}::uuid, now())`,
              receive_notes: input.notes ?? null,
              version: transfer.version + 1,
            })
            .where('id', '=', transferId)
            .where('version', '=', transfer.version)
            .returning('id')
            .executeTakeFirst();
          if (!updated) {
            throw new ApiException(409, 'CONCURRENT_MODIFICATION', 'The transfer changed; retry');
          }
          await this.inventory.recordMovements(tx, {
            orgId: ctx.orgId,
            restaurantId: ctx.restaurantId,
            locationId: transfer.to_location_id,
            actor: { userId: ctx.userId },
            notes: 'Transfer received',
            movements: sent.map((l) => ({
              inventoryItemId: l.inventory_item_id,
              movementType: 'transfer_in',
              quantityMilli: given.get(l.inventory_item_id)!,
              sourceType: STOCK_TRANSFER_SOURCE,
              sourceId: transferId,
            })),
          });
          await audit(tx, {
            orgId: ctx.orgId,
            restaurantId: ctx.restaurantId,
            actorUserId: ctx.userId,
            action: 'inventory.transfer_receive',
            entityType: 'stock_transfer',
            entityId: transferId,
            data: {
              fromRestaurantId: transfer.from_restaurant_id,
              short: sent.filter(
                (l) => given.get(l.inventory_item_id)! < parseDecimalQty(l.quantity_sent),
              ).length,
            },
          });
          await appendEvents(tx, [
            {
              orgId: ctx.orgId,
              restaurantId: ctx.restaurantId,
              aggregateType: 'stock',
              aggregateId: transferId,
              aggregateVersion: transfer.version + 1,
              eventType: 'inventory.transfer_received',
              payload: { fromRestaurantId: transfer.from_restaurant_id },
            },
          ]);
          return { status: 200, body: await this.view(tx, transferId) };
        },
      ),
    );
  }

  /**
   * The sender cancels a transfer that has not been received: every line's stock comes
   * back to the shelf it left, valued at the dispatch's cost, and the transfer can then
   * never be received. Racing a receipt, whichever locks the transfer first wins.
   */
  async cancel(
    ctx: TransferContext,
    transferId: string,
    input: { reason: string },
    idempotencyKey: string,
  ): Promise<IdempotentResult<StockTransferView>> {
    return withTenant(this.db, { orgId: ctx.orgId }, (tx) =>
      idempotent(
        tx,
        ctx.orgId,
        `transfer-cancel:${ctx.restaurantId}`,
        idempotencyKey,
        { transferId, ...input },
        async () => {
          const transfer = await tx
            .selectFrom('stock_transfers')
            .select(['id', 'status', 'version', 'from_location_id', 'to_restaurant_id'])
            .where('id', '=', transferId)
            .where('from_restaurant_id', '=', ctx.restaurantId)
            .forUpdate()
            .executeTakeFirst();
          if (!transfer) throw notFound('Transfer');
          assertInTransit(transfer.status);
          const sent = await tx
            .selectFrom('stock_transfer_lines')
            .select(['inventory_item_id', 'quantity_sent'])
            .where('stock_transfer_id', '=', transferId)
            .orderBy('inventory_item_id')
            .execute();
          const updated = await tx
            .updateTable('stock_transfers')
            .set({
              status: 'cancelled',
              cancelled_by: ctx.userId,
              cancelled_at: sql<Date>`now()`,
              cancel_business_date: sql<string>`app.business_date(${ctx.restaurantId}::uuid, now())`,
              cancel_reason: input.reason,
              version: transfer.version + 1,
            })
            .where('id', '=', transferId)
            .where('version', '=', transfer.version)
            .returning('id')
            .executeTakeFirst();
          if (!updated) {
            throw new ApiException(409, 'CONCURRENT_MODIFICATION', 'The transfer changed; retry');
          }
          await this.inventory.recordMovements(tx, {
            orgId: ctx.orgId,
            restaurantId: ctx.restaurantId,
            locationId: transfer.from_location_id,
            actor: { userId: ctx.userId },
            notes: 'Transfer cancelled',
            movements: sent.map((l) => ({
              inventoryItemId: l.inventory_item_id,
              movementType: 'return_to_stock',
              quantityMilli: parseDecimalQty(l.quantity_sent),
              sourceType: STOCK_TRANSFER_SOURCE,
              sourceId: transferId,
            })),
          });
          await audit(tx, {
            orgId: ctx.orgId,
            restaurantId: ctx.restaurantId,
            actorUserId: ctx.userId,
            action: 'inventory.transfer_cancel',
            entityType: 'stock_transfer',
            entityId: transferId,
            reason: input.reason,
            data: { toRestaurantId: transfer.to_restaurant_id, lines: sent.length },
          });
          await appendEvents(tx, [
            {
              orgId: ctx.orgId,
              restaurantId: ctx.restaurantId,
              aggregateType: 'stock',
              aggregateId: transferId,
              aggregateVersion: transfer.version + 1,
              eventType: 'inventory.transfer_cancelled',
              payload: { toRestaurantId: transfer.to_restaurant_id },
            },
          ]);
          return { status: 200, body: await this.view(tx, transferId) };
        },
      ),
    );
  }

  /** Transfers sent from or to this restaurant, newest first. */
  async list(
    ctx: { orgId: string; restaurantId: string },
    q: {
      direction: 'incoming' | 'outgoing';
      status?: 'in_transit' | 'received' | 'cancelled' | undefined;
      limit: number;
    },
  ): Promise<StockTransferView[]> {
    return withTenant(this.db, ctx, async (tx) => {
      let query = tx
        .selectFrom('stock_transfers')
        .select('id')
        .where(
          q.direction === 'incoming' ? 'to_restaurant_id' : 'from_restaurant_id',
          '=',
          ctx.restaurantId,
        )
        .orderBy('dispatched_at', 'desc')
        .orderBy('id', 'desc')
        .limit(q.limit);
      if (q.status) query = query.where('status', '=', q.status);
      const ids = await query.execute();
      const out: StockTransferView[] = [];
      for (const { id } of ids) out.push(await this.view(tx, id));
      return out;
    });
  }

  /** A transfer this restaurant sent or received; any other is not found. */
  async get(
    ctx: { orgId: string; restaurantId: string },
    transferId: string,
  ): Promise<StockTransferView> {
    return withTenant(this.db, ctx, async (tx) => {
      const found = await tx
        .selectFrom('stock_transfers')
        .select('id')
        .where('id', '=', transferId)
        .where((w) =>
          w.or([
            w('from_restaurant_id', '=', ctx.restaurantId),
            w('to_restaurant_id', '=', ctx.restaurantId),
          ]),
        )
        .executeTakeFirst();
      if (!found) throw notFound('Transfer');
      return this.view(tx, transferId);
    });
  }

  /**
   * Under the `block` shortage policy a dispatch may not take more than is available
   * (on hand less reserved). Checked after the movements, on the balance rows they locked.
   */
  private async enforceShortagePolicy(
    tx: Tx,
    restaurantId: string,
    locationId: string,
    lines: { inventoryItemId: string }[],
  ): Promise<void> {
    const r = await tx
      .selectFrom('restaurants')
      .select('stock_shortage_policy')
      .where('id', '=', restaurantId)
      .executeTakeFirstOrThrow();
    if (r.stock_shortage_policy !== 'block') return;
    const short = await tx
      .selectFrom('stock_balances')
      .select('inventory_item_id')
      .where('location_id', '=', locationId)
      .where(
        'inventory_item_id',
        'in',
        lines.map((l) => l.inventoryItemId),
      )
      .where(sql<boolean>`on_hand - reserved < 0`)
      .orderBy('inventory_item_id')
      .execute();
    if (short.length > 0) {
      throw new ApiException(409, 'INSUFFICIENT_STOCK', 'Not enough stock available to send', {
        inventoryItemIds: short.map((s) => s.inventory_item_id),
      });
    }
  }

  private async view(tx: Tx, id: string): Promise<StockTransferView> {
    const t = await tx
      .selectFrom('stock_transfers as t')
      .innerJoin('restaurants as f', 'f.id', 't.from_restaurant_id')
      .innerJoin('restaurants as d', 'd.id', 't.to_restaurant_id')
      .innerJoin('users as s', 's.id', 't.dispatched_by')
      .leftJoin('users as r', 'r.id', 't.received_by')
      .leftJoin('users as c', 'c.id', 't.cancelled_by')
      .select([
        't.id',
        't.status',
        't.from_restaurant_id',
        'f.name as from_name',
        't.to_restaurant_id',
        'd.name as to_name',
        's.display_name as dispatched_by',
        't.dispatched_at',
        sql<string>`t.dispatch_business_date::text`.as('dispatch_business_date'),
        't.notes',
        'r.display_name as received_by',
        't.received_at',
        sql<string | null>`t.receive_business_date::text`.as('receive_business_date'),
        't.receive_notes',
        'c.display_name as cancelled_by',
        't.cancelled_at',
        sql<string | null>`t.cancel_business_date::text`.as('cancel_business_date'),
        't.cancel_reason',
      ])
      .where('t.id', '=', id)
      .executeTakeFirstOrThrow();
    const lines = await tx
      .selectFrom('stock_transfer_lines as l')
      .innerJoin('inventory_items as i', 'i.id', 'l.inventory_item_id')
      .select([
        'l.inventory_item_id',
        'i.sku',
        'i.name',
        'i.base_unit',
        'l.quantity_sent',
        'l.quantity_received',
      ])
      .where('l.stock_transfer_id', '=', id)
      .orderBy('i.name')
      .execute();
    const values = await tx
      .selectFrom('stock_movements')
      .select(['movement_type', sql<string>`coalesce(sum(value_cents), 0)::text`.as('cents')])
      .where('source_type', '=', STOCK_TRANSFER_SOURCE)
      .where('source_id', '=', id)
      .groupBy('movement_type')
      .execute();
    const valueOf = (type: string) =>
      Number(values.find((v) => v.movement_type === type)?.cents ?? 0);
    const sentCents = -valueOf('transfer_out');
    const received = t.status === 'received';
    const receivedCents = received ? valueOf('transfer_in') : null;
    return {
      id: t.id,
      status: t.status as StockTransferView['status'],
      from: { id: t.from_restaurant_id, name: t.from_name },
      to: { id: t.to_restaurant_id, name: t.to_name },
      dispatchedBy: t.dispatched_by,
      dispatchedAt: t.dispatched_at.toISOString(),
      dispatchBusinessDate: t.dispatch_business_date,
      notes: t.notes,
      receivedBy: t.received_by,
      receivedAt: t.received_at ? t.received_at.toISOString() : null,
      receiveBusinessDate: t.receive_business_date,
      receiveNotes: t.receive_notes,
      cancelledBy: t.cancelled_by,
      cancelledAt: t.cancelled_at ? t.cancelled_at.toISOString() : null,
      cancelBusinessDate: t.cancel_business_date,
      cancelReason: t.cancel_reason,
      sentCents,
      receivedCents,
      shortageCents: receivedCents === null ? null : sentCents - receivedCents,
      returnedCents: t.status === 'cancelled' ? valueOf('return_to_stock') : null,
      lines: lines.map((l) => ({
        inventoryItemId: l.inventory_item_id,
        sku: l.sku,
        name: l.name,
        baseUnit: l.base_unit,
        quantitySent: formatDecimalQty(parseDecimalQty(l.quantity_sent)),
        quantityReceived:
          l.quantity_received === null
            ? null
            : formatDecimalQty(parseDecimalQty(l.quantity_received)),
      })),
    };
  }
}

/** Only a transfer still in transit can be received or cancelled, and only once. */
function assertInTransit(status: string): void {
  if (status === 'received') {
    throw new ApiException(
      409,
      'TRANSFER_ALREADY_RECEIVED',
      'This transfer has already been received',
    );
  }
  if (status === 'cancelled') {
    throw new ApiException(409, 'TRANSFER_CANCELLED', 'This transfer has been cancelled');
  }
}
