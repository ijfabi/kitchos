import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type Database, type Tx } from '@kitchos/database';
import type {
  GoodsReceiptView,
  StockCountView,
  WasteRecordView,
  WasteSummary,
} from '@kitchos/contracts';
import {
  extendedCostCents,
  formatDecimalQty,
  parseDecimalQty,
  type SimpleMenuItemDef,
} from '@kitchos/domain';
import { sql } from 'kysely';
import type { Permission } from '../auth/permissions.ts';
import { MenuRepository } from '../catalog/menu.repository.ts';
import { appendEvents } from '../events/outbox.ts';
import { audit } from '../infra/audit.ts';
import { ApiException, forbidden, notFound } from '../infra/http-errors.ts';
import { idempotent, type IdempotentResult } from '../infra/idempotency.ts';
import { DB } from '../infra/tokens.ts';
import { InventoryService, ORDER_LINE_SOURCE, type MovementInput } from './inventory.service.ts';

export interface OperationContext {
  orgId: string;
  restaurantId: string;
  userId: string;
  permissions: Set<Permission>;
}

export type RecordWasteInput =
  | {
      kind: 'raw_ingredient';
      inventoryItemId: string;
      quantity: string;
      reason: string;
      stationId?: string | undefined;
      notes?: string | undefined;
    }
  | {
      kind: 'prepared_item';
      orderLineId?: string | undefined;
      menuItemId?: string | undefined;
      quantity: number;
      remake: boolean;
      reason: string;
      stationId?: string | undefined;
      notes?: string | undefined;
    };

const WASTE_SOURCE = 'waste_record';
const WASTE_REVERSAL_SOURCE = 'waste_reversal';

interface WasteLinePlan {
  inventoryItemId: string;
  quantityMilli: number;
  treatment: 'deducted_now' | 'already_consumed';
}

/**
 * Inventory operations that change stock outside the order flow: waste,
 * goods receipts and physical counts. Physical movements and financial
 * classification are kept separate (ADR-0011): wasting an already-produced
 * item records its cost as waste without a second physical deduction.
 */
@Injectable()
export class StockOperationsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(MenuRepository) private readonly menus: MenuRepository,
  ) {}

  // ------------------------------------------------------------------ waste

  async recordWaste(
    ctx: OperationContext,
    input: RecordWasteInput,
    idempotencyKey: string,
  ): Promise<IdempotentResult<WasteRecordView>> {
    return withTenant(this.db, { orgId: ctx.orgId }, (tx) =>
      idempotent(tx, ctx.orgId, `waste:${ctx.restaurantId}`, idempotencyKey, input, async () => {
        const locationId = await this.inventory.defaultLocationId(tx, ctx.restaurantId);
        if (input.stationId) await this.requireStation(tx, ctx.restaurantId, input.stationId);

        let plan: WasteLinePlan[];
        let productId: string | null = null;
        let orderLineId: string | null = null;
        let quantity: string;
        let remakeMilliPerItem: { inventoryItemId: string; quantityMilli: number }[] = [];

        if (input.kind === 'raw_ingredient') {
          await this.requireItem(tx, input.inventoryItemId);
          quantity = formatDecimalQty(parseDecimalQty(input.quantity));
          plan = [
            {
              inventoryItemId: input.inventoryItemId,
              quantityMilli: parseDecimalQty(input.quantity),
              treatment: 'deducted_now',
            },
          ];
        } else if (input.orderLineId) {
          const line = await tx
            .selectFrom('order_lines as l')
            .innerJoin('orders as o', 'o.id', 'l.order_id')
            .select(['l.id', 'l.product_id', 'l.quantity', 'l.kind'])
            .where('l.id', '=', input.orderLineId)
            .where('o.restaurant_id', '=', ctx.restaurantId)
            .executeTakeFirst();
          if (!line || line.kind === 'combo') throw notFound('Order line');
          if (input.quantity > line.quantity) {
            throw new ApiException(
              422,
              'WASTE_QUANTITY_EXCEEDS_LINE',
              `Line has only ${line.quantity} item(s)`,
            );
          }
          const snapshot = await tx
            .selectFrom('order_line_ingredients')
            .select(['inventory_item_id', 'quantity'])
            .where('order_line_id', '=', line.id)
            .execute();
          const consumed = (await this.inventory.lineWasConsumed(tx, [line.id])).has(line.id);
          const portion = snapshot.map((s) => {
            const total = parseDecimalQty(s.quantity);
            if (total % line.quantity !== 0)
              throw new Error(`Snapshot for ${line.id} is not divisible by quantity`);
            return {
              inventoryItemId: s.inventory_item_id,
              quantityMilli: (total / line.quantity) * input.quantity,
            };
          });
          // Invariant 12: if the line's ingredients were already consumed in
          // production, the waste is a classification only — no second deduction.
          plan = portion.map((p) => ({
            ...p,
            treatment: consumed ? 'already_consumed' : 'deducted_now',
          }));
          productId = line.product_id;
          orderLineId = line.id;
          quantity = String(input.quantity);
          // A remake of an already-consumed line needs a fresh portion; an
          // unconsumed line will consume normally when its task progresses.
          if (input.remake && consumed) remakeMilliPerItem = portion;
        } else {
          const menu = await this.menus.loadMenu(tx, ctx.restaurantId);
          const item = menu.catalog.items.get(input.menuItemId!);
          if (!item) throw notFound('Menu item');
          if (item.kind !== 'item') {
            throw new ApiException(
              422,
              'WASTE_COMBO_NOT_ALLOWED',
              'Record waste for each meal component separately',
            );
          }
          plan = (item as SimpleMenuItemDef).recipe.ingredients.map((i) => ({
            inventoryItemId: i.inventoryItemId,
            quantityMilli: i.quantityMilli * input.quantity,
            treatment: 'deducted_now' as const,
          }));
          productId = item.productId;
          quantity = String(input.quantity);
        }

        const costs = await this.unitCosts(
          tx,
          plan.map((p) => p.inventoryItemId),
        );
        const lines = plan.map((p) => ({
          ...p,
          unitCost: costs.get(p.inventoryItemId) ?? '0',
          costCents: extendedCostCents(p.quantityMilli, costs.get(p.inventoryItemId) ?? '0'),
        }));
        const costCents = lines.reduce((s, l) => s + l.costCents, 0);
        const threshold = await tx
          .selectFrom('restaurants')
          .select('waste_approval_threshold_cents')
          .where('id', '=', ctx.restaurantId)
          .executeTakeFirstOrThrow();
        const status =
          costCents > threshold.waste_approval_threshold_cents ? 'pending_approval' : 'recorded';

        const record = await tx
          .insertInto('waste_records')
          .values({
            org_id: ctx.orgId,
            restaurant_id: ctx.restaurantId,
            location_id: locationId,
            kind: input.kind,
            inventory_item_id: input.kind === 'raw_ingredient' ? input.inventoryItemId : null,
            product_id: productId,
            order_line_id: orderLineId,
            quantity,
            reason: input.reason,
            remake: input.kind === 'prepared_item' && input.remake,
            station_id: input.stationId ?? null,
            recorded_by: ctx.userId,
            notes: input.notes ?? null,
            cost_cents: costCents,
            status,
            business_date: sql<string>`app.business_date(${ctx.restaurantId}::uuid, now())`,
          })
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('waste_record_lines')
          .values(
            lines.map((l) => ({
              org_id: ctx.orgId,
              waste_record_id: record.id,
              inventory_item_id: l.inventoryItemId,
              quantity: formatDecimalQty(l.quantityMilli),
              treatment: l.treatment,
              unit_cost: l.unitCost,
              cost_cents: l.costCents,
            })),
          )
          .execute();

        const movements: MovementInput[] = lines
          .filter((l) => l.treatment === 'deducted_now')
          .map((l) => ({
            inventoryItemId: l.inventoryItemId,
            movementType: input.kind === 'raw_ingredient' ? 'waste_raw' : 'waste_prepared',
            quantityMilli: -l.quantityMilli,
            sourceType: WASTE_SOURCE,
            sourceId: record.id,
          }));
        for (const r of remakeMilliPerItem) {
          movements.push({
            inventoryItemId: r.inventoryItemId,
            movementType: 'production_consumption',
            quantityMilli: -r.quantityMilli,
            sourceType: ORDER_LINE_SOURCE,
            sourceId: orderLineId!,
            sourceKey: `remake:${record.id}`,
          });
        }
        await this.inventory.recordMovements(tx, {
          orgId: ctx.orgId,
          restaurantId: ctx.restaurantId,
          locationId,
          actor: { userId: ctx.userId },
          notes: input.notes ?? null,
          movements,
        });

        await audit(tx, {
          orgId: ctx.orgId,
          restaurantId: ctx.restaurantId,
          actorUserId: ctx.userId,
          action: 'waste.record',
          entityType: 'waste_record',
          entityId: record.id,
          reason: input.reason,
          data: { costCents, status, kind: input.kind, remake: remakeMilliPerItem.length > 0 },
        });
        await appendEvents(tx, [
          {
            orgId: ctx.orgId,
            restaurantId: ctx.restaurantId,
            aggregateType: 'stock',
            aggregateId: record.id,
            aggregateVersion: record.version,
            eventType: 'inventory.waste_recorded',
            payload: {
              kind: input.kind,
              reason: input.reason,
              costCents,
              status,
              reclassifiedCostCents: lines
                .filter((l) => l.treatment === 'already_consumed')
                .reduce((s, l) => s + l.costCents, 0),
            },
          },
        ]);
        return { status: 201, body: await this.wasteView(tx, record.id) };
      }),
    );
  }

  /**
   * Approve a waste record above the threshold, or reject any unreviewed
   * record. Rejection never edits history: stock deducted by the record is
   * restored with compensating `correction` movements. Approvers may not
   * review their own records (segregation of duties).
   */
  async reviewWaste(
    ctx: OperationContext,
    wasteId: string,
    decision: 'approve' | 'reject',
    reason: string,
  ): Promise<WasteRecordView> {
    return withTenant(this.db, { orgId: ctx.orgId }, async (tx) => {
      const rec = await tx
        .selectFrom('waste_records')
        .select(['id', 'status', 'version', 'recorded_by', 'location_id'])
        .where('id', '=', wasteId)
        .where('restaurant_id', '=', ctx.restaurantId)
        .forUpdate()
        .executeTakeFirst();
      if (!rec) throw notFound('Waste record');
      if (rec.recorded_by === ctx.userId)
        throw forbidden('You cannot review waste you recorded yourself');
      const allowed =
        decision === 'approve' ? ['pending_approval'] : ['pending_approval', 'recorded'];
      if (!allowed.includes(rec.status)) {
        throw new ApiException(409, 'INVALID_STATE_TRANSITION', `Waste record is ${rec.status}`);
      }

      if (decision === 'reject') {
        const deducted = await tx
          .selectFrom('stock_movements')
          .select(['id', 'inventory_item_id', 'quantity_delta'])
          .where('source_type', '=', WASTE_SOURCE)
          .where('source_id', '=', rec.id)
          .execute();
        await this.inventory.recordMovements(tx, {
          orgId: ctx.orgId,
          restaurantId: ctx.restaurantId,
          locationId: rec.location_id,
          actor: { userId: ctx.userId },
          notes: `Reversal of rejected waste record: ${reason}`,
          movements: deducted.map((m) => ({
            inventoryItemId: m.inventory_item_id,
            movementType: 'correction',
            quantityMilli: -parseDecimalQty(m.quantity_delta),
            sourceType: WASTE_REVERSAL_SOURCE,
            sourceId: rec.id,
            sourceKey: m.id,
          })),
        });
      }
      const status = decision === 'approve' ? 'approved' : 'rejected';
      await tx
        .updateTable('waste_records')
        .set({
          status,
          reviewed_by: ctx.userId,
          reviewed_at: sql`now()`,
          review_reason: reason,
          version: rec.version + 1,
        })
        .where('id', '=', rec.id)
        .where('version', '=', rec.version)
        .execute();
      await audit(tx, {
        orgId: ctx.orgId,
        restaurantId: ctx.restaurantId,
        actorUserId: ctx.userId,
        action: `waste.${decision}`,
        entityType: 'waste_record',
        entityId: rec.id,
        reason,
        data: { fromStatus: rec.status },
      });
      await appendEvents(tx, [
        {
          orgId: ctx.orgId,
          restaurantId: ctx.restaurantId,
          aggregateType: 'stock',
          aggregateId: rec.id,
          aggregateVersion: rec.version + 1,
          eventType: `inventory.waste_${status}`,
          payload: { reason },
        },
      ]);
      return this.wasteView(tx, rec.id);
    });
  }

  async listWaste(
    ctx: { orgId: string; restaurantId: string },
    filter: { status?: string | undefined; limit: number },
  ): Promise<WasteRecordView[]> {
    return withTenant(this.db, ctx, async (tx) => {
      let q = tx
        .selectFrom('waste_records')
        .select('id')
        .where('restaurant_id', '=', ctx.restaurantId)
        .orderBy('occurred_at', 'desc')
        .orderBy('id', 'desc')
        .limit(filter.limit);
      if (filter.status) q = q.where('status', '=', filter.status);
      const ids = await q.execute();
      const out: WasteRecordView[] = [];
      for (const { id } of ids) out.push(await this.wasteView(tx, id));
      return out;
    });
  }

  /** Waste by reason, station and employee over a business-date range. Rejected records are excluded. */
  async wasteSummary(
    ctx: { orgId: string; restaurantId: string },
    from: string,
    to: string,
  ): Promise<WasteSummary> {
    return withTenant(this.db, ctx, async (tx) => {
      const base = tx
        .selectFrom('waste_records as w')
        .where('w.restaurant_id', '=', ctx.restaurantId)
        .where('w.business_date', '>=', from)
        .where('w.business_date', '<=', to)
        .where('w.status', '<>', 'rejected');
      const total = await base
        .select((eb) =>
          eb.fn.coalesce(eb.fn.sum<number>('w.cost_cents'), sql<number>`0`).as('cents'),
        )
        .executeTakeFirstOrThrow();
      const split = await tx
        .selectFrom('waste_record_lines as l')
        .innerJoin('waste_records as w', 'w.id', 'l.waste_record_id')
        .select(['l.treatment', (eb) => eb.fn.sum<number>('l.cost_cents').as('cents')])
        .where('w.restaurant_id', '=', ctx.restaurantId)
        .where('w.business_date', '>=', from)
        .where('w.business_date', '<=', to)
        .where('w.status', '<>', 'rejected')
        .groupBy('l.treatment')
        .execute();
      const byReason = await base
        .select([
          'w.reason',
          (eb) => eb.fn.countAll<number>().as('n'),
          (eb) => eb.fn.sum<number>('w.cost_cents').as('cents'),
        ])
        .groupBy('w.reason')
        .orderBy('cents', 'desc')
        .execute();
      const byStation = await base
        .leftJoin('stations as s', 's.id', 'w.station_id')
        .select([
          (eb) => eb.fn.coalesce('s.name', sql<string>`'Unassigned'`).as('station'),
          (eb) => eb.fn.countAll<number>().as('n'),
          (eb) => eb.fn.sum<number>('w.cost_cents').as('cents'),
        ])
        .groupBy('s.name')
        .orderBy('cents', 'desc')
        .execute();
      const byEmployee = await base
        .innerJoin('users as u', 'u.id', 'w.recorded_by')
        .select([
          'u.display_name',
          (eb) => eb.fn.countAll<number>().as('n'),
          (eb) => eb.fn.sum<number>('w.cost_cents').as('cents'),
        ])
        .groupBy('u.display_name')
        .orderBy('cents', 'desc')
        .execute();
      const num = (v: unknown) => Number(v ?? 0);
      return {
        from,
        to,
        totalCostCents: num(total.cents),
        reclassifiedFromConsumptionCents: num(
          split.find((s) => s.treatment === 'already_consumed')?.cents,
        ),
        deductedDirectlyCents: num(split.find((s) => s.treatment === 'deducted_now')?.cents),
        byReason: byReason.map((r) => ({
          reason: r.reason,
          records: num(r.n),
          costCents: num(r.cents),
        })),
        byStation: byStation.map((r) => ({
          station: r.station,
          records: num(r.n),
          costCents: num(r.cents),
        })),
        byEmployee: byEmployee.map((r) => ({
          employee: r.display_name,
          records: num(r.n),
          costCents: num(r.cents),
        })),
      };
    });
  }

  // ---------------------------------------------------------------- receipts

  async receiveGoods(
    ctx: OperationContext,
    input: {
      supplierName?: string | undefined;
      reference?: string | undefined;
      notes?: string | undefined;
      lines: {
        inventoryItemId: string;
        quantity: string;
        unitCost?: string | undefined;
        lotCode?: string | undefined;
        expiresOn?: string | undefined;
      }[];
    },
    idempotencyKey: string,
  ): Promise<IdempotentResult<GoodsReceiptView>> {
    return withTenant(this.db, { orgId: ctx.orgId }, (tx) =>
      idempotent(tx, ctx.orgId, `receipt:${ctx.restaurantId}`, idempotencyKey, input, async () => {
        const locationId = await this.inventory.defaultLocationId(tx, ctx.restaurantId);
        for (const l of input.lines) await this.requireItem(tx, l.inventoryItemId);
        const receipt = await tx
          .insertInto('goods_receipts')
          .values({
            org_id: ctx.orgId,
            restaurant_id: ctx.restaurantId,
            location_id: locationId,
            supplier_name: input.supplierName ?? null,
            reference: input.reference ?? null,
            notes: input.notes ?? null,
            received_by: ctx.userId,
            business_date: sql<string>`app.business_date(${ctx.restaurantId}::uuid, now())`,
          })
          .returning(['id', 'business_date'])
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('goods_receipt_lines')
          .values(
            input.lines.map((l) => ({
              org_id: ctx.orgId,
              goods_receipt_id: receipt.id,
              inventory_item_id: l.inventoryItemId,
              quantity: formatDecimalQty(parseDecimalQty(l.quantity)),
              unit_cost: l.unitCost ?? null,
              lot_code: l.lotCode ?? null,
              expires_on: l.expiresOn ?? null,
            })),
          )
          .execute();
        await this.inventory.recordMovements(tx, {
          orgId: ctx.orgId,
          restaurantId: ctx.restaurantId,
          locationId,
          actor: { userId: ctx.userId },
          notes: input.reference ? `Receipt ${input.reference}` : null,
          movements: input.lines.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            movementType: 'receipt',
            quantityMilli: parseDecimalQty(l.quantity),
            sourceType: 'goods_receipt',
            sourceId: receipt.id,
          })),
        });
        await appendEvents(tx, [
          {
            orgId: ctx.orgId,
            restaurantId: ctx.restaurantId,
            aggregateType: 'stock',
            aggregateId: receipt.id,
            aggregateVersion: 1,
            eventType: 'inventory.goods_received',
            payload: { lines: input.lines.length, supplierName: input.supplierName ?? null },
          },
        ]);
        const names = await this.itemNames(
          tx,
          input.lines.map((l) => l.inventoryItemId),
        );
        return {
          status: 201,
          body: {
            id: receipt.id,
            businessDate: receipt.business_date,
            lines: input.lines.map((l) => ({
              sku: names.get(l.inventoryItemId)!.sku,
              name: names.get(l.inventoryItemId)!.name,
              quantity: formatDecimalQty(parseDecimalQty(l.quantity)),
            })),
          },
        };
      }),
    );
  }

  // ------------------------------------------------------------------ counts

  /**
   * Records a physical count. Variance = counted − on hand at the moment of
   * counting (rows locked), posted as count_adjustment movements. A total
   * absolute variance above the restaurant threshold requires
   * `inventory.approve`, and the approver is recorded.
   */
  async recordCount(
    ctx: OperationContext,
    input: { notes?: string | undefined; lines: { inventoryItemId: string; counted: string }[] },
    idempotencyKey: string,
  ): Promise<IdempotentResult<StockCountView>> {
    return withTenant(this.db, { orgId: ctx.orgId }, (tx) =>
      idempotent(tx, ctx.orgId, `count:${ctx.restaurantId}`, idempotencyKey, input, async () => {
        const locationId = await this.inventory.defaultLocationId(tx, ctx.restaurantId);
        for (const l of input.lines) await this.requireItem(tx, l.inventoryItemId);
        const ids = input.lines.map((l) => l.inventoryItemId);
        const onHand = await this.inventory.lockedBalances(tx, {
          orgId: ctx.orgId,
          locationId,
          itemIds: ids,
        });
        const costs = await this.unitCosts(tx, ids);
        const lines = input.lines.map((l) => {
          const expected = onHand.get(l.inventoryItemId) ?? 0;
          const counted = parseDecimalQty(l.counted);
          const variance = counted - expected;
          return {
            inventoryItemId: l.inventoryItemId,
            expected,
            counted,
            variance,
            varianceCents: extendedCostCents(variance, costs.get(l.inventoryItemId) ?? '0'),
          };
        });
        const netCents = lines.reduce((s, l) => s + l.varianceCents, 0);
        const absCents = lines.reduce((s, l) => s + Math.abs(l.varianceCents), 0);
        const { count_approval_threshold_cents: threshold } = await tx
          .selectFrom('restaurants')
          .select('count_approval_threshold_cents')
          .where('id', '=', ctx.restaurantId)
          .executeTakeFirstOrThrow();
        const needsApproval = absCents > threshold;
        if (needsApproval && !ctx.permissions.has('inventory.approve')) {
          throw forbidden(`Count variance of ${absCents} cents exceeds the approval threshold`);
        }
        const count = await tx
          .insertInto('stock_counts')
          .values({
            org_id: ctx.orgId,
            restaurant_id: ctx.restaurantId,
            location_id: locationId,
            counted_by: ctx.userId,
            business_date: sql<string>`app.business_date(${ctx.restaurantId}::uuid, now())`,
            variance_cents: netCents,
            approved_by: needsApproval ? ctx.userId : null,
            notes: input.notes ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('stock_count_lines')
          .values(
            lines.map((l) => ({
              org_id: ctx.orgId,
              stock_count_id: count.id,
              inventory_item_id: l.inventoryItemId,
              expected: formatDecimalQty(l.expected),
              counted: formatDecimalQty(l.counted),
              variance: formatDecimalQty(l.variance),
              variance_cents: l.varianceCents,
            })),
          )
          .execute();
        await this.inventory.recordMovements(tx, {
          orgId: ctx.orgId,
          restaurantId: ctx.restaurantId,
          locationId,
          actor: { userId: ctx.userId },
          notes: 'Physical count',
          movements: lines.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            movementType: 'count_adjustment',
            quantityMilli: l.variance,
            sourceType: 'stock_count',
            sourceId: count.id,
          })),
        });
        await audit(tx, {
          orgId: ctx.orgId,
          restaurantId: ctx.restaurantId,
          actorUserId: ctx.userId,
          action: 'inventory.count',
          entityType: 'stock_count',
          entityId: count.id,
          data: {
            netVarianceCents: netCents,
            absoluteVarianceCents: absCents,
            approvalRequired: needsApproval,
          },
        });
        await appendEvents(tx, [
          {
            orgId: ctx.orgId,
            restaurantId: ctx.restaurantId,
            aggregateType: 'stock',
            aggregateId: count.id,
            aggregateVersion: 1,
            eventType: 'inventory.counted',
            payload: { netVarianceCents: netCents, lines: lines.length },
          },
        ]);
        return { status: 201, body: await this.countView(tx, count.id) };
      }),
    );
  }

  // ----------------------------------------------------------------- helpers

  private async requireItem(tx: Tx, id: string): Promise<void> {
    const found = await tx
      .selectFrom('inventory_items')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!found) throw notFound('Inventory item');
  }

  private async requireStation(tx: Tx, restaurantId: string, id: string): Promise<void> {
    const found = await tx
      .selectFrom('stations')
      .select('id')
      .where('id', '=', id)
      .where('restaurant_id', '=', restaurantId)
      .executeTakeFirst();
    if (!found) throw notFound('Station');
  }

  private async unitCosts(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .selectFrom('inventory_items')
      .select(['id', 'standard_unit_cost'])
      .where('id', 'in', [...ids])
      .execute();
    return new Map(rows.map((r) => [r.id, r.standard_unit_cost]));
  }

  private async itemNames(tx: Tx, ids: readonly string[]) {
    const rows = await tx
      .selectFrom('inventory_items')
      .select(['id', 'sku', 'name'])
      .where('id', 'in', [...ids])
      .execute();
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async wasteView(tx: Tx, id: string): Promise<WasteRecordView> {
    const w = await tx
      .selectFrom('waste_records as w')
      .innerJoin('users as u', 'u.id', 'w.recorded_by')
      .leftJoin('users as rv', 'rv.id', 'w.reviewed_by')
      .leftJoin('stations as s', 's.id', 'w.station_id')
      .leftJoin('inventory_items as i', 'i.id', 'w.inventory_item_id')
      .leftJoin('products as p', 'p.id', 'w.product_id')
      .select([
        'w.id',
        'w.kind',
        'w.quantity',
        'w.reason',
        'w.remake',
        'w.cost_cents',
        'w.status',
        'w.notes',
        'w.review_reason',
        'w.business_date',
        'w.occurred_at',
        'u.display_name as recorded_by',
        'rv.display_name as reviewed_by',
        's.name as station_name',
        'i.name as item_name',
        'p.name as product_name',
      ])
      .where('w.id', '=', id)
      .executeTakeFirstOrThrow();
    const lines = await tx
      .selectFrom('waste_record_lines as l')
      .innerJoin('inventory_items as i', 'i.id', 'l.inventory_item_id')
      .select(['i.sku', 'i.name', 'l.quantity', 'l.treatment', 'l.cost_cents'])
      .where('l.waste_record_id', '=', id)
      .orderBy('i.sku')
      .execute();
    return {
      id: w.id,
      kind: w.kind as WasteRecordView['kind'],
      itemName: w.item_name ?? w.product_name ?? 'Unknown',
      quantity: w.quantity,
      reason: w.reason as WasteRecordView['reason'],
      remake: w.remake,
      costCents: w.cost_cents,
      status: w.status as WasteRecordView['status'],
      recordedBy: w.recorded_by,
      reviewedBy: w.reviewed_by,
      reviewReason: w.review_reason,
      stationName: w.station_name,
      notes: w.notes,
      businessDate: w.business_date,
      occurredAt: w.occurred_at.toISOString(),
      lines: lines.map((l) => ({
        sku: l.sku,
        name: l.name,
        quantity: l.quantity,
        treatment: l.treatment as 'deducted_now' | 'already_consumed',
        costCents: l.cost_cents,
      })),
    };
  }

  private async countView(tx: Tx, id: string): Promise<StockCountView> {
    const c = await tx
      .selectFrom('stock_counts as c')
      .leftJoin('users as a', 'a.id', 'c.approved_by')
      .select(['c.id', 'c.business_date', 'c.variance_cents', 'a.display_name as approved_by'])
      .where('c.id', '=', id)
      .executeTakeFirstOrThrow();
    const lines = await tx
      .selectFrom('stock_count_lines as l')
      .innerJoin('inventory_items as i', 'i.id', 'l.inventory_item_id')
      .select(['i.sku', 'i.name', 'l.expected', 'l.counted', 'l.variance', 'l.variance_cents'])
      .where('l.stock_count_id', '=', id)
      .orderBy('i.sku')
      .execute();
    return {
      id: c.id,
      businessDate: c.business_date,
      varianceCents: c.variance_cents,
      approvedBy: c.approved_by,
      lines: lines.map((l) => ({
        sku: l.sku,
        name: l.name,
        expected: l.expected,
        counted: l.counted,
        variance: l.variance,
        varianceCents: l.variance_cents,
      })),
    };
  }
}
