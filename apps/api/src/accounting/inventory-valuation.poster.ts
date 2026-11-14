import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@kitchos/database';
import {
  consumptionPostings,
  countPostings,
  receiptPostings,
  transferCancelPostings,
  transferInPostings,
  transferOutPostings,
  wastePostings,
  wasteReversalPostings,
  type Posting,
} from '@kitchos/domain';
import { sql } from 'kysely';
import { ORDER_LINE_SOURCE } from '../inventory/inventory.service.ts';
import {
  GOODS_RECEIPT_SOURCE,
  STOCK_COUNT_SOURCE,
  WASTE_REVERSAL_SOURCE,
  WASTE_SOURCE,
} from '../inventory/stock-operations.service.ts';
import { STOCK_TRANSFER_SOURCE } from '../inventory/stock-transfer.service.ts';
import type { ConsumedEvent } from './ledger.consumer.ts';
import { LedgerService, type EntryInput } from './ledger.service.ts';

export const OPENING_STOCK_SOURCE = 'opening_stock';

const DESCRIPTION: Partial<Record<EntryInput['entryType'], string>> = {
  goods_receipt: 'Goods received',
  stock_count: 'Stock count adjustment',
  opening_stock: 'Opening stock',
};

interface MovementFilter {
  sourceType: string;
  sourceId: string | readonly string[];
  /** Exact source key; omit for any. */
  sourceKey?: string;
  movementType?: string;
}

/**
 * Inventory valuation postings (ADR-0016). Each stock operation is posted from
 * the event its own transaction emitted, using the values the stock ledger
 * recorded on its movements, so the Inventory account reconciles to the
 * ledger to the cent:
 *   order.accepted             -> COGS for the lines consumed at acceptance (one entry per order)
 *   kitchen.task.started/completed
 *                              -> COGS for the task's line, when that is its consumption point
 *   inventory.waste_recorded   -> waste (deducted now, reclassified from COGS, remake)
 *   inventory.waste_rejected   -> waste reversal
 *   inventory.goods_received   -> goods receipt (Cr goods received not invoiced)
 *   inventory.counted          -> stock count variance
 *   inventory.opening_stock    -> opening stock (Cr opening balance equity)
 *   inventory.transfer_dispatched -> stock into transit, at the sender (ADR-0019)
 *   inventory.transfer_received   -> transit cleared into inventory and shortage, at the receiver
 *   inventory.transfer_cancelled  -> transit cleared back into inventory, at the sender (ADR-0020)
 */
@Injectable()
export class InventoryValuationPoster {
  static readonly eventTypes = [
    'order.accepted',
    'kitchen.task.started',
    'kitchen.task.completed',
    'inventory.waste_recorded',
    'inventory.waste_rejected',
    'inventory.goods_received',
    'inventory.counted',
    'inventory.opening_stock',
    'inventory.transfer_dispatched',
    'inventory.transfer_received',
    'inventory.transfer_cancelled',
  ] as const;

  constructor(@Inject(LedgerService) private readonly ledger: LedgerService) {}

  handles(eventType: string): boolean {
    return (InventoryValuationPoster.eventTypes as readonly string[]).includes(eventType);
  }

  async handle(tx: Tx, event: ConsumedEvent): Promise<void> {
    switch (event.eventType) {
      case 'order.accepted': {
        // Lines consumed at acceptance, all in the accepting transaction.
        const lines = await tx
          .selectFrom('order_lines')
          .select('id')
          .where('order_id', '=', event.aggregateId)
          .where('consumption_point', '=', 'order_accepted')
          .execute();
        return this.consumed(
          tx,
          event,
          'order',
          event.aggregateId,
          lines.map((l) => l.id),
        );
      }
      case 'kitchen.task.started':
      case 'kitchen.task.completed': {
        const task = await tx
          .selectFrom('kitchen_tasks as t')
          .innerJoin('order_lines as l', 'l.id', 't.order_line_id')
          .select(['t.order_line_id', 'l.consumption_point'])
          .where('t.id', '=', event.aggregateId)
          .executeTakeFirst();
        if (!task) throw new Error(`kitchen task ${event.aggregateId} not found`);
        // Only the event whose transaction consumed the line posts it.
        const point =
          event.eventType === 'kitchen.task.started' ? 'task_started' : 'task_completed';
        if (task.consumption_point !== point) return;
        return this.consumed(tx, event, ORDER_LINE_SOURCE, task.order_line_id, [
          task.order_line_id,
        ]);
      }
      case 'inventory.waste_recorded':
        return this.wasteRecorded(tx, event);
      case 'inventory.waste_rejected':
        return this.wasteRejected(tx, event);
      case 'inventory.goods_received':
        return this.simple(tx, event, GOODS_RECEIPT_SOURCE, 'goods_receipt', (v) =>
          receiptPostings(v, 'supplier'),
        );
      case 'inventory.counted':
        return this.simple(tx, event, STOCK_COUNT_SOURCE, 'stock_count', countPostings);
      case 'inventory.opening_stock':
        return this.simple(tx, event, OPENING_STOCK_SOURCE, 'opening_stock', (v) =>
          receiptPostings(v, 'opening'),
        );
      case 'inventory.transfer_dispatched':
        return this.transferDispatched(tx, event);
      case 'inventory.transfer_received':
        return this.transferReceived(tx, event);
      case 'inventory.transfer_cancelled':
        return this.transferCancelled(tx, event);
    }
  }

  private async transferDispatched(tx: Tx, event: ConsumedEvent): Promise<void> {
    const out = await this.value(tx, {
      sourceType: STOCK_TRANSFER_SOURCE,
      sourceId: event.aggregateId,
      movementType: 'transfer_out',
    });
    if (!out) return;
    await this.post(tx, event, {
      businessDate: out.businessDate,
      entryType: 'transfer_out',
      sourceType: STOCK_TRANSFER_SOURCE,
      sourceId: event.aggregateId,
      description: 'Stock transfer dispatched',
      postings: transferOutPostings(out.cents),
    });
  }

  /**
   * At the sender: the stock that came back, valued at the dispatch's cost, leaves
   * transit, so a cancelled transfer leaves nothing in transit either.
   */
  private async transferCancelled(tx: Tx, event: ConsumedEvent): Promise<void> {
    const back = await this.value(tx, {
      sourceType: STOCK_TRANSFER_SOURCE,
      sourceId: event.aggregateId,
      movementType: 'return_to_stock',
    });
    if (!back) throw new Error(`stock transfer ${event.aggregateId} returned nothing`);
    await this.post(tx, event, {
      businessDate: back.businessDate,
      entryType: 'transfer_cancel',
      sourceType: STOCK_TRANSFER_SOURCE,
      sourceId: event.aggregateId,
      description: 'Stock transfer cancelled',
      postings: transferCancelPostings(back.cents),
    });
  }

  /**
   * At the receiver: what arrived (valued at the dispatch's cost) leaves transit into
   * Inventory, and the rest of the dispatched value is the shortage, so the transfer
   * leaves nothing in transit. Nothing may have arrived at all, hence the transfer's
   * own receive date.
   */
  private async transferReceived(tx: Tx, event: ConsumedEvent): Promise<void> {
    const t = await tx
      .selectFrom('stock_transfers')
      .select(['status', sql<string | null>`receive_business_date::text`.as('day')])
      .where('id', '=', event.aggregateId)
      .executeTakeFirst();
    if (!t || t.status !== 'received' || t.day === null) {
      throw new Error(`stock transfer ${event.aggregateId} is not received`);
    }
    const filter = { sourceType: STOCK_TRANSFER_SOURCE, sourceId: event.aggregateId };
    const out = await this.value(tx, { ...filter, movementType: 'transfer_out' });
    // Every dispatch is valued (transfers postdate valuation), so this is a broken invariant.
    if (!out) throw new Error(`stock transfer ${event.aggregateId} has no valued dispatch`);
    const received = (await this.value(tx, { ...filter, movementType: 'transfer_in' }))?.cents ?? 0;
    await this.post(tx, event, {
      businessDate: t.day,
      entryType: 'transfer_in',
      sourceType: STOCK_TRANSFER_SOURCE,
      sourceId: event.aggregateId,
      description: 'Stock transfer received',
      postings: transferInPostings({
        receivedDeltaCents: received,
        shortageCents: -out.cents - received,
      }),
    });
  }

  /**
   * COGS for the order lines one transaction consumed. Each line has exactly one
   * consumption point and is consumed exactly once, so every line's cost lands
   * in exactly one entry: the order's (lines consumed at acceptance) or the
   * line's own (consumed when its kitchen task started or completed).
   */
  private async consumed(
    tx: Tx,
    event: ConsumedEvent,
    sourceType: string,
    sourceId: string,
    orderLineIds: string[],
  ): Promise<void> {
    if (orderLineIds.length === 0) return;
    const v = await this.value(tx, {
      sourceType: ORDER_LINE_SOURCE,
      sourceId: orderLineIds,
      sourceKey: '',
      movementType: 'production_consumption',
    });
    if (!v) return;
    await this.post(tx, event, {
      businessDate: v.businessDate,
      entryType: 'cogs',
      sourceType,
      sourceId,
      description: 'Ingredients consumed',
      postings: consumptionPostings(v.cents),
    });
  }

  /**
   * A waste record that involves stock moved before valuation existed (its own
   * movements, or the consumption of the line it wastes) stays entirely outside
   * the journal: reclassifying cost out of COGS that was never posted to COGS
   * would misstate it.
   */
  private async involvesUnvalued(
    tx: Tx,
    rec: { id: string; order_line_id: string | null },
  ): Promise<boolean> {
    const found = await tx
      .selectFrom('stock_movements')
      .select('id')
      .where('value_cents', 'is', null)
      .where((w) =>
        w.or([
          w.and([w('source_type', '=', WASTE_SOURCE), w('source_id', '=', rec.id)]),
          w.and([w('source_type', '=', WASTE_REVERSAL_SOURCE), w('source_id', '=', rec.id)]),
          ...(rec.order_line_id
            ? [
                w.and([
                  w('source_type', '=', ORDER_LINE_SOURCE),
                  w('source_id', '=', rec.order_line_id),
                ]),
              ]
            : []),
        ]),
      )
      .limit(1)
      .executeTakeFirst();
    return found !== undefined;
  }

  private async wasteRecorded(tx: Tx, event: ConsumedEvent): Promise<void> {
    const rec = await this.wasteRecord(tx, event.aggregateId);
    if (await this.involvesUnvalued(tx, rec)) return;
    const deducted = await this.value(tx, { sourceType: WASTE_SOURCE, sourceId: rec.id });
    const remake = rec.order_line_id
      ? await this.value(tx, {
          sourceType: ORDER_LINE_SOURCE,
          sourceId: rec.order_line_id,
          sourceKey: `remake:${rec.id}`,
        })
      : null;
    await this.post(tx, event, {
      businessDate: rec.business_date,
      entryType: 'waste',
      sourceType: WASTE_SOURCE,
      sourceId: rec.id,
      description: `Waste: ${rec.reason.replace(/_/g, ' ')}`,
      postings: wastePostings({
        deductedDeltaCents: deducted?.cents ?? 0,
        reclassifiedCents: rec.reclassifiedCents,
        remakeDeltaCents: remake?.cents ?? 0,
      }),
    });
  }

  private async wasteRejected(tx: Tx, event: ConsumedEvent): Promise<void> {
    const rec = await this.wasteRecord(tx, event.aggregateId);
    if (await this.involvesUnvalued(tx, rec)) return;
    const restored = await this.value(tx, {
      sourceType: WASTE_REVERSAL_SOURCE,
      sourceId: rec.id,
    });
    await this.post(tx, event, {
      // The reversal belongs to the day the rejection was decided (like its correction
      // movements), never the day the ledger happens to process it.
      businessDate: restored?.businessDate ?? (await this.reviewedDay(tx, rec.id)),
      entryType: 'waste_reversal',
      sourceType: WASTE_SOURCE,
      sourceId: rec.id,
      description: 'Rejected waste reversed',
      postings: wasteReversalPostings({
        restoredDeltaCents: restored?.cents ?? 0,
        reclassifiedCents: rec.reclassifiedCents,
      }),
    });
  }

  /** Operations whose movements all share the event's aggregate as their source. */
  private async simple(
    tx: Tx,
    event: ConsumedEvent,
    sourceType: string,
    entryType: EntryInput['entryType'],
    postings: (inventoryDeltaCents: number) => Posting[],
  ): Promise<void> {
    const v = await this.value(tx, { sourceType, sourceId: event.aggregateId });
    if (!v) return;
    await this.post(tx, event, {
      businessDate: v.businessDate,
      entryType,
      sourceType,
      sourceId: event.aggregateId,
      description: DESCRIPTION[entryType] ?? entryType,
      postings: postings(v.cents),
    });
  }

  private async post(
    tx: Tx,
    event: ConsumedEvent,
    e: Omit<EntryInput, 'orgId' | 'restaurantId' | 'sourceEventId'>,
  ): Promise<void> {
    if (e.postings.length === 0) return; // nothing of value moved (e.g. zero-cost items)
    await this.ledger.post(tx, {
      ...e,
      orgId: event.orgId,
      restaurantId: event.restaurantId,
      sourceEventId: event.id,
    });
  }

  /** Σ recorded value of the matching movements, or null when there are none. */
  private async value(
    tx: Tx,
    f: MovementFilter,
  ): Promise<{ cents: number; businessDate: string } | null> {
    let q = tx
      .selectFrom('stock_movements')
      .select([
        sql<string | null>`sum(value_cents)`.as('cents'),
        sql<string | null>`max(business_date)::text`.as('business_date'),
        sql<string>`count(*) filter (where value_cents is null)`.as('unvalued'),
      ])
      .where('source_type', '=', f.sourceType)
      .where('source_id', 'in', typeof f.sourceId === 'string' ? [f.sourceId] : [...f.sourceId]);
    if (f.sourceKey !== undefined) q = q.where('source_key', '=', f.sourceKey);
    if (f.movementType) q = q.where('movement_type', '=', f.movementType);
    const r = await q.executeTakeFirstOrThrow();
    if (r.business_date === null) return null;
    // Movements recorded before valuation existed have no value (ADR-0016). They
    // are left out of the journal rather than guessed at today's cost; an
    // operation's movements share one transaction, so they are all legacy or none.
    if (Number(r.unvalued) > 0) return null;
    return { cents: Number(r.cents ?? 0), businessDate: r.business_date };
  }

  private async wasteRecord(tx: Tx, id: string) {
    const rec = await tx
      .selectFrom('waste_records')
      .select([
        'id',
        'order_line_id',
        'reason',
        sql<string>`business_date::text`.as('business_date'),
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!rec) throw new Error(`waste record ${id} not found`);
    const reclass = await tx
      .selectFrom('waste_record_lines')
      .select(sql<string>`coalesce(sum(cost_cents), 0)`.as('cents'))
      .where('waste_record_id', '=', id)
      .where('treatment', '=', 'already_consumed')
      .executeTakeFirstOrThrow();
    return { ...rec, reclassifiedCents: Number(reclass.cents) };
  }

  private async reviewedDay(tx: Tx, wasteRecordId: string): Promise<string> {
    const r = await tx
      .selectFrom('waste_records')
      .select(sql<string>`app.business_date(restaurant_id, reviewed_at)::text`.as('d'))
      .where('id', '=', wasteRecordId)
      .executeTakeFirstOrThrow();
    return r.d;
  }
}
