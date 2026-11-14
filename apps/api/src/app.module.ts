import { type DynamicModule, Module } from '@nestjs/common';
import type { Database } from '@kitchos/database';
import type pg from 'pg';
import type { Logger } from 'pino';
import { AccountingController } from './accounting/accounting.controller.ts';
import { DayCloseController, FailedEventsController } from './accounting/day-close.controller.ts';
import { DayCloseService } from './accounting/day-close.service.ts';
import { FoodCostController } from './accounting/food-cost.controller.ts';
import { MenuItemReportController } from './accounting/menu-item-report.controller.ts';
import { ReconciliationService } from './accounting/reconciliation.service.ts';
import { CashDrawerService } from './cash/cash-drawer.service.ts';
import { CashController } from './cash/cash.controller.ts';
import { ShiftController } from './cash/shift.controller.ts';
import { ShiftService } from './cash/shift.service.ts';
import { InventoryValuationPoster } from './accounting/inventory-valuation.poster.ts';
import { LedgerConsumer } from './accounting/ledger.consumer.ts';
import { LedgerService } from './accounting/ledger.service.ts';
import { AuthController } from './auth/auth.controller.ts';
import { StaffAuthGuard } from './auth/auth.guard.ts';
import { AuthService } from './auth/auth.service.ts';
import { CatalogController } from './catalog/catalog.controller.ts';
import { MenuRepository } from './catalog/menu.repository.ts';
import { APP_CONFIG, type AppConfig } from './config.ts';
import { EventDispatcher } from './events/event-dispatcher.service.ts';
import { LiveEventsController } from './events/live-events.controller.ts';
import { LiveEventsService } from './events/live-events.service.ts';
import { HealthController } from './health/health.controller.ts';
import { CredentialThrottle } from './infra/rate-limit.ts';
import { DB, LOGGER, PG_POOL } from './infra/tokens.ts';
import { InventoryController } from './inventory/inventory.controller.ts';
import { InventoryService } from './inventory/inventory.service.ts';
import { StockOperationsController } from './inventory/stock-operations.controller.ts';
import { StockOperationsService } from './inventory/stock-operations.service.ts';
import { StockTransferController } from './inventory/stock-transfer.controller.ts';
import { StockTransferService } from './inventory/stock-transfer.service.ts';
import { KitchenController } from './kitchen/kitchen.controller.ts';
import { KitchenService } from './kitchen/kitchen.service.ts';
import { PublicOrdersController } from './ordering/public-orders.controller.ts';
import { DiscountsService } from './ordering/discounts.service.ts';
import { OrdersService } from './ordering/orders.service.ts';
import { OverridesController } from './ordering/overrides.controller.ts';
import { RefundsService } from './ordering/refunds.service.ts';
import { StaffOrdersController } from './ordering/staff-orders.controller.ts';

export interface AppDependencies {
  config: AppConfig;
  db: Database;
  pool: pg.Pool;
  logger: Logger;
}

/**
 * Modular monolith root. Bounded contexts (catalog, ordering, kitchen,
 * inventory, auth) are separate folders with explicit service boundaries;
 * they are wired in one module until extraction is justified (ADR-0002).
 */
@Module({})
export class AppModule {
  static register(deps: AppDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        AuthController,
        CatalogController,
        PublicOrdersController,
        StaffOrdersController,
        OverridesController,
        KitchenController,
        InventoryController,
        StockOperationsController,
        StockTransferController,
        LiveEventsController,
        AccountingController,
        DayCloseController,
        FailedEventsController,
        FoodCostController,
        MenuItemReportController,
        CashController,
        ShiftController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: deps.config },
        { provide: DB, useValue: deps.db },
        { provide: PG_POOL, useValue: deps.pool },
        { provide: LOGGER, useValue: deps.logger },
        AuthService,
        CredentialThrottle,
        StaffAuthGuard,
        MenuRepository,
        InventoryService,
        StockOperationsService,
        StockTransferService,
        KitchenService,
        OrdersService,
        DiscountsService,
        RefundsService,
        LiveEventsService,
        LedgerService,
        InventoryValuationPoster,
        LedgerConsumer,
        ReconciliationService,
        DayCloseService,
        EventDispatcher,
        CashDrawerService,
        ShiftService,
      ],
    };
  }
}
