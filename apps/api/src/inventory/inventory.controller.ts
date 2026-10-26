import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { withTenant, type Database } from '@kitchos/database';
import type { StockBalanceView, StockMovementView } from '@kitchos/contracts';
import { formatDecimalQty, parseDecimalQty } from '@kitchos/domain';
import { z } from 'zod';
import { Principal, RequirePermission, StaffAuthGuard } from '../auth/auth.guard.ts';
import type { StaffPrincipal } from '../auth/auth.service.ts';
import { DB } from '../infra/tokens.ts';
import { UuidParam, ZodPipe } from '../infra/zod.ts';

const MovementQuery = z.object({
  sourceId: z.uuid().optional(),
  sku: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

@Controller('v1/restaurants/:restaurantId/inventory')
@UseGuards(StaffAuthGuard)
export class InventoryController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get('balances')
  @RequirePermission('inventory.view')
  async balances(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Principal() p: StaffPrincipal,
  ): Promise<StockBalanceView[]> {
    const rows = await withTenant(this.db, p, (tx) =>
      tx
        .selectFrom('stock_balances as b')
        .innerJoin('stock_locations as l', 'l.id', 'b.location_id')
        .innerJoin('inventory_items as i', 'i.id', 'b.inventory_item_id')
        .select(['i.id', 'i.sku', 'i.name', 'i.base_unit', 'i.category', 'b.on_hand', 'b.reserved'])
        .where('l.restaurant_id', '=', restaurantId)
        .where('l.is_default', '=', true)
        .orderBy('i.category')
        .orderBy('i.name')
        .execute(),
    );
    return rows.map((r) => ({
      inventoryItemId: r.id,
      sku: r.sku,
      name: r.name,
      baseUnit: r.base_unit,
      category: r.category,
      onHand: r.on_hand,
      reserved: r.reserved,
      available: formatDecimalQty(parseDecimalQty(r.on_hand) - parseDecimalQty(r.reserved)),
    }));
  }

  @Get('movements')
  @RequirePermission('inventory.view')
  async movements(
    @Param('restaurantId', UuidParam) restaurantId: string,
    @Query(new ZodPipe(MovementQuery)) query: z.output<typeof MovementQuery>,
    @Principal() p: StaffPrincipal,
  ): Promise<StockMovementView[]> {
    const rows = await withTenant(this.db, p, (tx) => {
      let q = tx
        .selectFrom('stock_movements as m')
        .innerJoin('inventory_items as i', 'i.id', 'm.inventory_item_id')
        .select([
          'm.id',
          'i.sku',
          'i.name',
          'm.movement_type',
          'm.quantity_delta',
          'm.source_type',
          'm.source_id',
          'm.occurred_at',
          'm.business_date',
        ])
        .where('m.restaurant_id', '=', restaurantId)
        .orderBy('m.recorded_at', 'desc')
        .orderBy('m.id', 'desc')
        .limit(query.limit);
      if (query.sourceId) q = q.where('m.source_id', '=', query.sourceId);
      if (query.sku) q = q.where('i.sku', '=', query.sku);
      return q.execute();
    });
    return rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      movementType: r.movement_type,
      quantityDelta: r.quantity_delta,
      sourceType: r.source_type,
      sourceId: r.source_id,
      occurredAt: r.occurred_at.toISOString(),
      businessDate: r.business_date,
    }));
  }
}
