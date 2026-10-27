import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type Database, type Tx } from '@kitchos/database';
import type {
  OrderDiscountView,
  OrderLineInput,
  OrderView,
  StaffPaymentRequest,
} from '@kitchos/contracts';
import {
  DomainError,
  formatDecimalQty,
  orderStateMachine,
  paymentStateMachine,
  priceOrder,
  cashPayableCents,
  productionUnits,
  settleCash,
  type OrderStatus,
  type PricedOrder,
  type ProductionSpec,
} from '@kitchos/domain';
import { sql } from 'kysely';
import type { Permission } from '../auth/permissions.ts';
import { MenuRepository } from '../catalog/menu.repository.ts';
import { appendEvents, type DomainEventInput } from '../events/outbox.ts';
import { audit } from '../infra/audit.ts';
import { ApiException, forbidden, notFound } from '../infra/http-errors.ts';
import { idempotent, type IdempotentResult } from '../infra/idempotency.ts';
import { DB } from '../infra/tokens.ts';
import { InventoryService, type Actor } from '../inventory/inventory.service.ts';
import { KitchenService, routeToStation } from '../kitchen/kitchen.service.ts';

export interface PlaceOrderInput {
  orgId: string;
  restaurantId: string;
  channel: 'web' | 'pos' | 'kiosk' | 'drive_thru';
  fulfilmentType: 'dine_in' | 'takeaway' | 'pickup' | 'drive_thru';
  customerName?: string | undefined;
  lines: OrderLineInput[];
  actor: Actor;
}

/**
 * Sandbox card provider. Real providers return a token from their client SDK;
 * KitchOS only ever sees that token, never a PAN or CVV.
 */
const SANDBOX_TOKENS: Record<
  string,
  { outcome: 'captured' | 'failed'; brand: string; last4: string; reason?: string }
> = {
  tok_sandbox_approve: { outcome: 'captured', brand: 'visa', last4: '4242' },
  tok_sandbox_mastercard: { outcome: 'captured', brand: 'mastercard', last4: '4444' },
  tok_sandbox_decline: { outcome: 'failed', brand: 'visa', last4: '0002', reason: 'card_declined' },
  tok_sandbox_insufficient_funds: {
    outcome: 'failed',
    brand: 'visa',
    last4: '9995',
    reason: 'insufficient_funds',
  },
};

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(MenuRepository) private readonly menus: MenuRepository,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(KitchenService) private readonly kitchen: KitchenService,
  ) {}

  // ------------------------------------------------------------- place

  async placeOrder(
    input: PlaceOrderInput,
    idempotencyKey: string,
  ): Promise<IdempotentResult<OrderView>> {
    const { orgId, restaurantId } = input;
    const request = {
      channel: input.channel,
      fulfilmentType: input.fulfilmentType,
      customerName: input.customerName,
      lines: input.lines,
    };
    return withTenant(this.db, { orgId }, (tx) =>
      idempotent(tx, orgId, `orders.place:${restaurantId}`, idempotencyKey, request, async () => {
        const menu = await this.menus.loadMenu(tx, restaurantId);
        const priced = priceOrder(
          menu.catalog,
          input.lines.map((l) => ({
            menuItemId: l.menuItemId,
            quantity: l.quantity,
            modifierOptionIds: l.modifierOptionIds ?? [],
            components: (l.components ?? []).map((c) => ({
              componentId: c.componentId,
              modifierOptionIds: c.modifierOptionIds ?? [],
            })),
          })),
          { taxRateBasisPoints: menu.restaurant.taxRateBp },
        );

        // Fail before taking money if the kitchen cannot make something.
        const stations = await this.kitchen.activeStations(tx, restaurantId);
        for (const unit of productionUnits(priced)) {
          if (!routeToStation(stations, unit.spec.stationType)) {
            throw new ApiException(
              409,
              'NO_STATION_AVAILABLE',
              `${unit.name} cannot be prepared right now`,
            );
          }
        }

        const { business_date } = (
          await sql<{
            business_date: string;
          }>`select app.business_date(${restaurantId}::uuid, now())::text as business_date`.execute(
            tx,
          )
        ).rows[0]!;
        const counter = await tx
          .insertInto('restaurant_order_counters')
          .values({ org_id: orgId, restaurant_id: restaurantId, business_date, last_number: 1 })
          .onConflict((oc) =>
            oc.columns(['restaurant_id', 'business_date']).doUpdateSet((eb) => ({
              last_number: eb('restaurant_order_counters.last_number', '+', 1),
            })),
          )
          .returning('last_number')
          .executeTakeFirstOrThrow();

        const order = await tx
          .insertInto('orders')
          .values({
            org_id: orgId,
            restaurant_id: restaurantId,
            order_number: counter.last_number,
            business_date,
            channel: input.channel,
            fulfilment_type: input.fulfilmentType,
            status: 'pending_payment',
            menu_version_id: priced.menuVersionId,
            currency: menu.restaurant.currency,
            subtotal_cents: priced.subtotalCents,
            discount_cents: priced.discountCents,
            total_cents: priced.totalCents,
            tax_cents: priced.taxCents,
            tax_rate_bp: menu.restaurant.taxRateBp,
            customer_name: input.customerName ?? null,
            created_by_user_id: input.actor.userId ?? null,
            created_by_device_id: input.actor.deviceId ?? null,
          })
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();

        const requirements = await this.insertLines(tx, orgId, order.id, priced);
        await this.inventory.reserve(tx, {
          orgId,
          restaurantId,
          policy: menu.restaurant.shortagePolicy,
          lines: requirements,
        });

        await appendEvents(tx, [
          {
            orgId,
            restaurantId,
            aggregateType: 'order',
            aggregateId: order.id,
            aggregateVersion: order.version,
            eventType: 'order.placed',
            payload: {
              orderNumber: counter.last_number,
              channel: input.channel,
              totalCents: priced.totalCents,
              menuVersionId: priced.menuVersionId,
            },
          },
        ]);
        return { status: 201, body: await this.view(tx, order.id, { includeToken: true }) };
      }),
    );
  }

  /** Persists lines, modifiers and the immutable ingredient snapshot; returns per-line requirements. */
  private async insertLines(tx: Tx, orgId: string, orderId: string, priced: PricedOrder) {
    const requirements: { orderLineId: string; ingredients: ProductionSpec['ingredients'] }[] = [];
    const insertProducible = async (
      base: {
        line_no: number;
        product_id: string;
        name: string;
        quantity: number;
        taxable: boolean;
      },
      extra: {
        kind: 'item' | 'component';
        menu_item_id: string | null;
        combo_component_id: string | null;
        parent_line_id: string | null;
        unit_price_cents: number;
        line_total_cents: number;
      },
      spec: ProductionSpec,
      modifiers: readonly { optionId: string; name: string; priceDeltaCents: number }[],
    ) => {
      const row = await tx
        .insertInto('order_lines')
        .values({
          org_id: orgId,
          order_id: orderId,
          ...base,
          ...extra,
          recipe_version_id: spec.recipeVersionId,
          station_type: spec.stationType,
          consumption_point: spec.consumptionPoint,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.insertModifiers(tx, orgId, row.id, modifiers);
      if (spec.ingredients.length > 0) {
        await tx
          .insertInto('order_line_ingredients')
          .values(
            spec.ingredients.map((i) => ({
              org_id: orgId,
              order_line_id: row.id,
              inventory_item_id: i.inventoryItemId,
              quantity: formatDecimalQty(i.quantityMilli),
            })),
          )
          .execute();
      }
      requirements.push({ orderLineId: row.id, ingredients: spec.ingredients });
    };

    for (const line of priced.lines) {
      const base = {
        line_no: line.lineNo,
        product_id: line.productId,
        name: line.name,
        quantity: line.quantity,
        taxable: line.taxable,
      };
      if (line.production) {
        await insertProducible(
          base,
          {
            kind: 'item',
            menu_item_id: line.menuItemId,
            combo_component_id: null,
            parent_line_id: null,
            unit_price_cents: line.unitPriceCents,
            line_total_cents: line.lineTotalCents,
          },
          line.production,
          line.modifiers,
        );
        continue;
      }
      const parent = await tx
        .insertInto('order_lines')
        .values({
          org_id: orgId,
          order_id: orderId,
          ...base,
          kind: 'combo',
          menu_item_id: line.menuItemId,
          unit_price_cents: line.unitPriceCents,
          line_total_cents: line.lineTotalCents,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.insertModifiers(tx, orgId, parent.id, line.modifiers);
      for (const c of line.components) {
        await insertProducible(
          {
            line_no: line.lineNo,
            product_id: c.productId,
            name: c.name,
            quantity: c.quantity,
            taxable: line.taxable,
          },
          {
            kind: 'component',
            menu_item_id: null,
            combo_component_id: c.componentId,
            parent_line_id: parent.id,
            unit_price_cents: 0,
            line_total_cents: 0,
          },
          c.production,
          c.modifiers,
        );
      }
    }
    return requirements;
  }

  private async insertModifiers(
    tx: Tx,
    orgId: string,
    orderLineId: string,
    modifiers: readonly { optionId: string; name: string; priceDeltaCents: number }[],
  ): Promise<void> {
    if (modifiers.length === 0) return;
    await tx
      .insertInto('order_line_modifiers')
      .values(
        modifiers.map((m) => ({
          org_id: orgId,
          order_line_id: orderLineId,
          modifier_option_id: m.optionId,
          name: m.name,
          price_delta_cents: m.priceDeltaCents,
        })),
      )
      .execute();
  }

  // ------------------------------------------------------------- pay + accept

  /** Guest checkout: card tokens only (cash is never accepted from the public internet). */
  async payWithCard(
    args: { orgId: string; orderId: string; paymentToken: string; actor: Actor },
    idempotencyKey: string,
  ): Promise<IdempotentResult<OrderView>> {
    return this.takePayment(
      { ...args, tender: { method: 'card', paymentToken: args.paymentToken }, includeToken: true },
      idempotencyKey,
    );
  }

  /**
   * Takes payment for a pending order: a sandbox card token, or cash with the
   * amount tendered. Cash is rounded to the restaurant's increment (5c in
   * Australia) and the difference is recorded on the payment, not the order.
   * A declined card leaves the order awaiting payment (HTTP 402 body).
   */
  async takePayment(
    args: {
      orgId: string;
      orderId: string;
      /** When set (staff terminals), the order must belong to this restaurant. */
      restaurantId?: string;
      tender: StaffPaymentRequest;
      actor: Actor;
      includeToken?: boolean;
    },
    idempotencyKey: string,
  ): Promise<IdempotentResult<OrderView>> {
    return withTenant(this.db, { orgId: args.orgId }, (tx) =>
      idempotent(
        tx,
        args.orgId,
        // Scope by surface and restaurant: a stored response is replayed
        // before the order is re-checked, so a key validated at one
        // restaurant must never be replayable through another (or the public route).
        args.restaurantId
          ? `orders.pay:staff:${args.restaurantId}:${args.orderId}`
          : `orders.pay:public:${args.orderId}`,
        idempotencyKey,
        args.tender,
        async () => {
          const order = await this.lockOrder(tx, args.orderId, args.restaurantId);
          if (order.status !== 'pending_payment') {
            throw new ApiException(409, 'ORDER_NOT_AWAITING_PAYMENT', `Order is ${order.status}`);
          }
          const viewOpts = { includeToken: args.includeToken ?? false };
          const base = {
            org_id: args.orgId,
            restaurant_id: order.restaurant_id,
            order_id: order.id,
            amount_cents: order.total_cents,
            received_by: args.actor.userId ?? null,
          };

          let payment: { id: string; version: number };
          let outcome: 'captured' | 'failed';
          if (args.tender.method === 'cash') {
            const { cash_rounding_increment_cents: increment } = await tx
              .selectFrom('restaurants')
              .select('cash_rounding_increment_cents')
              .where('id', '=', order.restaurant_id)
              .executeTakeFirstOrThrow();
            const cash = settleCash(order.total_cents, args.tender.tenderedCents, increment);
            outcome = 'captured';
            paymentStateMachine.assertTransition('pending', outcome);
            payment = await tx
              .insertInto('payments')
              .values({
                ...base,
                method: 'cash',
                provider: 'cash',
                status: outcome,
                tendered_cents: cash.tenderedCents,
                change_cents: cash.changeCents,
                cash_rounding_cents: cash.roundingCents,
                captured_at: sql<Date>`now()`,
              })
              .returning(['id', 'version'])
              .executeTakeFirstOrThrow();
          } else {
            const sandbox = SANDBOX_TOKENS[args.tender.paymentToken];
            if (!sandbox)
              throw new ApiException(422, 'PAYMENT_TOKEN_INVALID', 'Unknown payment token');
            outcome = sandbox.outcome;
            paymentStateMachine.assertTransition('pending', outcome);
            payment = await tx
              .insertInto('payments')
              .values({
                ...base,
                method: 'card',
                provider: 'sandbox',
                status: outcome,
                provider_reference: `sbx_${crypto.randomUUID()}`,
                card_brand: sandbox.brand,
                card_last4: sandbox.last4,
                failure_reason: sandbox.reason ?? null,
                captured_at: outcome === 'captured' ? sql<Date>`now()` : null,
              })
              .returning(['id', 'version'])
              .executeTakeFirstOrThrow();
          }

          const paymentEvent: DomainEventInput = {
            orgId: args.orgId,
            restaurantId: order.restaurant_id,
            aggregateType: 'payment',
            aggregateId: payment.id,
            aggregateVersion: payment.version,
            eventType: outcome === 'captured' ? 'payment.captured' : 'payment.failed',
            payload: {
              orderId: order.id,
              amountCents: order.total_cents,
              method: args.tender.method,
              provider: args.tender.method === 'cash' ? 'cash' : 'sandbox',
              receivedBy: args.actor.userId ?? null,
            },
          };
          if (outcome === 'failed') {
            await appendEvents(tx, [paymentEvent]);
            return { status: 402, body: await this.view(tx, order.id, viewOpts) };
          }
          const events = await this.accept(tx, {
            orgId: args.orgId,
            restaurantId: order.restaurant_id,
            orderId: order.id,
            version: order.version,
            actor: args.actor,
          });
          await appendEvents(tx, [paymentEvent, ...events]);
          return { status: 200, body: await this.view(tx, order.id, viewOpts) };
        },
      ),
    );
  }

  /**
   * pending_payment -> accepted: release to the kitchen and consume
   * order_accepted lines. Called after a captured payment, or by the discount
   * flow when a fully discounted (complimentary) order has nothing to pay.
   */
  async accept(
    tx: Tx,
    args: { orgId: string; restaurantId: string; orderId: string; version: number; actor: Actor },
  ): Promise<DomainEventInput[]> {
    orderStateMachine.assertTransition('pending_payment', 'accepted');
    const updated = await tx
      .updateTable('orders')
      .set({ status: 'accepted', accepted_at: sql`now()`, version: args.version + 1 })
      .where('id', '=', args.orderId)
      .where('version', '=', args.version)
      .returning('version')
      .executeTakeFirst();
    if (!updated) throw new DomainError('CONCURRENT_MODIFICATION', 'Order changed concurrently');

    const taskEvents = await this.kitchen.createTasksForOrder(tx, args);
    const acceptLines = await tx
      .selectFrom('order_lines')
      .select('id')
      .where('order_id', '=', args.orderId)
      .where('consumption_point', '=', 'order_accepted')
      .orderBy('id')
      .execute();
    for (const l of acceptLines) {
      await this.inventory.consumeLine(tx, {
        orgId: args.orgId,
        restaurantId: args.restaurantId,
        orderLineId: l.id,
        actor: args.actor,
      });
    }
    return [
      {
        orgId: args.orgId,
        restaurantId: args.restaurantId,
        aggregateType: 'order',
        aggregateId: args.orderId,
        aggregateVersion: updated.version,
        eventType: 'order.accepted',
        payload: {},
      },
      ...taskEvents,
    ];
  }

  // ------------------------------------------------------------- staff commands

  async handoff(args: {
    orgId: string;
    restaurantId: string;
    orderId: string;
    actor: Actor;
  }): Promise<OrderView> {
    return withTenant(this.db, args, async (tx) => {
      const order = await this.lockOrder(tx, args.orderId, args.restaurantId);
      orderStateMachine.assertTransition(order.status, 'completed');
      const updated = await tx
        .updateTable('orders')
        .set({ status: 'completed', completed_at: sql`now()`, version: order.version + 1 })
        .where('id', '=', order.id)
        .where('version', '=', order.version)
        .returning('version')
        .executeTakeFirstOrThrow();
      await appendEvents(tx, [
        {
          orgId: args.orgId,
          restaurantId: args.restaurantId,
          aggregateType: 'order',
          aggregateId: order.id,
          aggregateVersion: updated.version,
          eventType: 'order.completed',
          payload: { handedOffBy: args.actor.userId ?? null },
        },
      ]);
      return this.view(tx, order.id);
    });
  }

  /**
   * Cancels an order. Unconsumed reservations are released. Stock already
   * consumed is NOT returned (invariant 11): the prepared food is a loss to be
   * classified as waste by the waste module, flagged on the event.
   * Cancelling once production has begun requires a manager-level permission.
   */
  async cancel(args: {
    orgId: string;
    restaurantId: string;
    orderId: string;
    reason: string;
    actor: Actor;
    permissions: Set<Permission>;
  }): Promise<OrderView> {
    return withTenant(this.db, args, async (tx) => {
      const order = await this.lockOrder(tx, args.orderId, args.restaurantId);
      orderStateMachine.assertTransition(order.status, 'cancelled');
      const lines = await tx
        .selectFrom('order_lines')
        .select('id')
        .where('order_id', '=', order.id)
        .orderBy('id')
        .execute();
      const consumed = await this.inventory.lineWasConsumed(
        tx,
        lines.map((l) => l.id),
      );
      const productionStarted =
        consumed.size > 0 || order.status === 'in_preparation' || order.status === 'ready';
      const needed: Permission = productionStarted ? 'orders.cancel_after_prep' : 'orders.cancel';
      if (!args.permissions.has(needed)) {
        throw forbidden(
          productionStarted
            ? 'Cancelling an order in production requires manager approval'
            : undefined,
        );
      }

      for (const l of lines)
        await this.inventory.releaseLine(tx, {
          restaurantId: args.restaurantId,
          orderLineId: l.id,
        });
      await tx
        .updateTable('kitchen_tasks')
        .set((eb) => ({
          status: 'cancelled',
          cancelled_at: sql`now()`,
          version: eb('version', '+', 1),
        }))
        .where('order_id', '=', order.id)
        .where('status', 'in', ['queued', 'in_progress'])
        .execute();
      const updated = await tx
        .updateTable('orders')
        .set({
          status: 'cancelled',
          cancelled_at: sql`now()`,
          cancel_reason: args.reason,
          version: order.version + 1,
        })
        .where('id', '=', order.id)
        .where('version', '=', order.version)
        .returning('version')
        .executeTakeFirstOrThrow();
      const captured = await tx
        .selectFrom('payments')
        .select('id')
        .where('order_id', '=', order.id)
        .where('status', '=', 'captured')
        .executeTakeFirst();

      await audit(tx, {
        orgId: args.orgId,
        restaurantId: args.restaurantId,
        actorUserId: args.actor.userId,
        actorDeviceId: args.actor.deviceId,
        action: 'order.cancel',
        entityType: 'order',
        entityId: order.id,
        reason: args.reason,
        data: { fromStatus: order.status, permissionUsed: needed, consumedLineIds: [...consumed] },
      });
      await appendEvents(tx, [
        {
          orgId: args.orgId,
          restaurantId: args.restaurantId,
          aggregateType: 'order',
          aggregateId: order.id,
          aggregateVersion: updated.version,
          eventType: 'order.cancelled',
          payload: {
            fromStatus: order.status,
            reason: args.reason,
            consumedLineIds: [...consumed],
            refundRequired: !!captured,
          },
        },
      ]);
      return this.view(tx, order.id);
    });
  }

  // ------------------------------------------------------------- queries

  async getByPublicToken(token: string): Promise<OrderView> {
    const ref = (
      await sql<{
        order_id: string;
        org_id: string;
      }>`select * from app.lookup_order_token(${token})`.execute(this.db)
    ).rows[0];
    if (!ref) throw notFound('Order');
    return withTenant(this.db, { orgId: ref.org_id }, (tx) =>
      this.view(tx, ref.order_id, { includeToken: true }),
    );
  }

  async resolvePublicToken(token: string): Promise<{ orderId: string; orgId: string }> {
    const ref = (
      await sql<{
        order_id: string;
        org_id: string;
      }>`select * from app.lookup_order_token(${token})`.execute(this.db)
    ).rows[0];
    if (!ref) throw notFound('Order');
    return { orderId: ref.order_id, orgId: ref.org_id };
  }

  async getForStaff(args: {
    orgId: string;
    restaurantId: string;
    orderId: string;
  }): Promise<OrderView> {
    return withTenant(this.db, args, async (tx) => {
      const exists = await tx
        .selectFrom('orders')
        .select('id')
        .where('id', '=', args.orderId)
        .where('restaurant_id', '=', args.restaurantId)
        .executeTakeFirst();
      if (!exists) throw notFound('Order');
      return this.view(tx, args.orderId);
    });
  }

  async listForStaff(args: {
    orgId: string;
    restaurantId: string;
    statuses: OrderStatus[];
    channel?: string | undefined;
    limit: number;
  }): Promise<OrderView[]> {
    return withTenant(this.db, args, async (tx) => {
      let q = tx
        .selectFrom('orders')
        .select('id')
        .where('restaurant_id', '=', args.restaurantId)
        .where('status', 'in', args.statuses)
        .orderBy('placed_at', 'desc')
        .limit(args.limit);
      if (args.channel) q = q.where('channel', '=', args.channel);
      const ids = await q.execute();
      const views: OrderView[] = [];
      for (const { id } of ids) views.push(await this.view(tx, id));
      return views;
    });
  }

  private async lockOrder(tx: Tx, orderId: string, restaurantId?: string) {
    let q = tx
      .selectFrom('orders')
      .select(['id', 'restaurant_id', 'status', 'version', 'total_cents'])
      .where('id', '=', orderId);
    if (restaurantId) q = q.where('restaurant_id', '=', restaurantId);
    const order = await q.forUpdate().executeTakeFirst();
    if (!order) throw notFound('Order');
    return { ...order, status: order.status as OrderStatus };
  }

  async view(tx: Tx, orderId: string, opts: { includeToken?: boolean } = {}): Promise<OrderView> {
    const o = await tx
      .selectFrom('orders as o')
      .innerJoin('restaurants as r', 'r.id', 'o.restaurant_id')
      .selectAll('o')
      .select(['r.name as restaurant_name', 'r.cash_rounding_increment_cents'])
      .where('o.id', '=', orderId)
      .executeTakeFirstOrThrow();
    const lines = await tx
      .selectFrom('order_lines')
      .selectAll()
      .where('order_id', '=', orderId)
      .orderBy('line_no')
      .orderBy('id')
      .execute();
    const mods = lines.length
      ? await tx
          .selectFrom('order_line_modifiers')
          .select(['order_line_id', 'name', 'price_delta_cents'])
          .where(
            'order_line_id',
            'in',
            lines.map((l) => l.id),
          )
          .execute()
      : [];
    const modsFor = (lineId: string) =>
      mods
        .filter((m) => m.order_line_id === lineId)
        .map((m) => ({ name: m.name, priceDeltaCents: m.price_delta_cents }));
    const payment = await tx
      .selectFrom('payments')
      .select([
        'status',
        'method',
        'amount_cents',
        'card_brand',
        'card_last4',
        'failure_reason',
        'tendered_cents',
        'change_cents',
        'cash_rounding_cents',
        'refunded_cents',
      ])
      .where('order_id', '=', orderId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const refunds = await tx
      .selectFrom('refunds as f')
      .innerJoin('users as u', 'u.id', 'f.requested_by')
      .select([
        'f.id',
        'f.method',
        'f.amount_cents',
        'f.cash_rounding_cents',
        'f.treatment',
        'f.reason',
        'f.created_at',
        'u.display_name',
      ])
      .where('f.order_id', '=', orderId)
      .orderBy('f.id')
      .execute();
    const discount = await tx
      .selectFrom('order_discounts as d')
      .innerJoin('users as a', 'a.id', 'd.applied_by')
      .innerJoin('users as p', 'p.id', 'd.approved_by')
      .select([
        'd.kind',
        'd.value',
        'd.amount_cents',
        'd.reason',
        'd.override_id',
        'a.display_name as applied_by',
        'p.display_name as approved_by',
      ])
      .where('d.order_id', '=', orderId)
      .executeTakeFirst();
    const tasks = await tx
      .selectFrom('kitchen_tasks as t')
      .innerJoin('stations as s', 's.id', 't.station_id')
      .select(['t.id', 't.label', 't.status', 's.name as station_name'])
      .where('t.order_id', '=', orderId)
      .orderBy('t.queued_at')
      .orderBy('t.id')
      .execute();

    return {
      id: o.id,
      orderNumber: o.order_number,
      businessDate: o.business_date,
      restaurantId: o.restaurant_id,
      restaurantName: o.restaurant_name,
      channel: o.channel,
      fulfilmentType: o.fulfilment_type,
      status: o.status as OrderStatus,
      customerName: o.customer_name,
      currency: o.currency,
      subtotalCents: o.subtotal_cents,
      discountCents: o.discount_cents,
      taxCents: o.tax_cents,
      totalCents: o.total_cents,
      cashDueCents: cashPayableCents(o.total_cents, o.cash_rounding_increment_cents),
      placedAt: o.placed_at.toISOString(),
      acceptedAt: o.accepted_at?.toISOString() ?? null,
      readyAt: o.ready_at?.toISOString() ?? null,
      completedAt: o.completed_at?.toISOString() ?? null,
      ...(opts.includeToken ? { publicToken: o.public_token } : {}),
      payment: payment
        ? {
            status: payment.status,
            method: payment.method,
            amountCents: payment.amount_cents,
            cardBrand: payment.card_brand,
            cardLast4: payment.card_last4,
            failureReason: payment.failure_reason,
            tenderedCents: payment.tendered_cents,
            changeCents: payment.change_cents,
            cashRoundingCents: payment.cash_rounding_cents,
            refundedCents: payment.refunded_cents,
          }
        : null,
      lines: lines
        .filter((l) => l.kind !== 'component')
        .map((l) => ({
          id: l.id,
          name: l.name,
          kind: l.kind as 'item' | 'combo',
          quantity: l.quantity,
          unitPriceCents: l.unit_price_cents,
          lineTotalCents: l.line_total_cents,
          modifiers: modsFor(l.id),
          components: lines
            .filter((c) => c.parent_line_id === l.id)
            .map((c) => ({
              id: c.id,
              name: c.name,
              quantity: c.quantity,
              modifiers: modsFor(c.id),
            })),
        })),
      refunds: refunds.map((f) => ({
        id: f.id,
        method: f.method as 'card' | 'cash',
        amountCents: f.amount_cents,
        cashReturnedCents: f.method === 'cash' ? f.amount_cents + f.cash_rounding_cents : null,
        treatment: f.treatment as 'deposit_release' | 'sales_return',
        reason: f.reason as OrderView['refunds'][number]['reason'],
        requestedBy: f.display_name,
        createdAt: f.created_at.toISOString(),
      })),
      discount: discount
        ? {
            kind: discount.kind as OrderDiscountView['kind'],
            value: discount.value,
            amountCents: discount.amount_cents,
            reason: discount.reason as OrderDiscountView['reason'],
            appliedBy: discount.applied_by,
            approvedBy: discount.approved_by,
            viaOverride: discount.override_id !== null,
          }
        : null,
      tasks: tasks.map((t) => ({
        id: t.id,
        label: t.label,
        stationName: t.station_name,
        status: t.status as OrderView['tasks'][number]['status'],
      })),
    };
  }
}
