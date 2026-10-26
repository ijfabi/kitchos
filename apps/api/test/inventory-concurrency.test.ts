import { randomUUID } from 'node:crypto';
import type { KitchenTaskView } from '@kitchos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  balance,
  bearer,
  consumptionForOrder,
  getMenu,
  item,
  login,
  placeAndPay,
  placeOrder,
  reconciliationErrors,
  restaurantId,
  setAvailable,
  startHarness,
  type Harness,
} from './harness.ts';

describe('inventory correctness under concurrency, retries and cancellation', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(() => h.close());

  it('concurrent orders against limited stock never oversell', async () => {
    const DRIVE = 'kitchos-drive';
    await setAvailable(h, DRIVE, 'CHICKEN-FILLET', 3);
    const before = await balance(h, DRIVE, 'CHICKEN-FILLET');
    const menu = await getMenu(h, DRIVE);
    const chicken = item(menu, 'Crispy Chicken Burger');

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        placeOrder(h, DRIVE, [{ menuItemId: chicken.id, quantity: 1 }]),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 409)).toHaveLength(5);
    const rejected = results.find((r) => r.status === 409)!;
    expect(rejected.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(rejected.body.error.details.shortages[0]).toMatchObject({
      sku: 'CHICKEN-FILLET',
      available: '0.000',
    });

    const after = await balance(h, DRIVE, 'CHICKEN-FILLET');
    expect(after.reserved - before.reserved).toBe(3);
    expect(after.onHand - after.reserved).toBe(0);
    expect(await reconciliationErrors(h)).toEqual([]);
  });

  it('reservation row locks alone prevent overselling (independent of order-number serialisation)', async () => {
    // Order placement is also serialised per store by the order counter, so
    // exercise InventoryService.reserve directly, in independent transactions.
    const DRIVE = 'kitchos-drive';
    const driveId = await restaurantId(h, DRIVE);
    const menu = await getMenu(h, DRIVE);
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) {
      const placed = await placeOrder(h, DRIVE, [
        { menuItemId: item(menu, 'Medium Cola').id, quantity: 1 },
      ]);
      const line = await h.owner
        .selectFrom('order_lines')
        .select('id')
        .where('order_id', '=', placed.body.id)
        .executeTakeFirstOrThrow();
      lines.push(line.id);
    }
    await setAvailable(h, DRIVE, 'BACON', 2);
    const before = await balance(h, DRIVE, 'BACON');
    const org = await h.owner
      .selectFrom('restaurants')
      .select('org_id')
      .where('id', '=', driveId)
      .executeTakeFirstOrThrow();
    const bacon = await h.owner
      .selectFrom('inventory_items')
      .select('id')
      .where('sku', '=', 'BACON')
      .where('org_id', '=', org.org_id)
      .executeTakeFirstOrThrow();

    const { withTenant } = await import('@kitchos/database');
    const { InventoryService } = await import('../src/inventory/inventory.service.ts');
    const { DB } = await import('../src/infra/tokens.ts');
    const inventory = h.app.get(InventoryService);
    const db = h.app.get(DB);
    const outcomes = await Promise.allSettled(
      lines.map((orderLineId) =>
        withTenant(db, { orgId: org.org_id }, (tx) =>
          inventory.reserve(tx, {
            orgId: org.org_id,
            restaurantId: driveId,
            policy: 'block',
            lines: [
              { orderLineId, ingredients: [{ inventoryItemId: bacon.id, quantityMilli: 1000 }] },
            ],
          }),
        ),
      ),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(4);
    expect((await balance(h, DRIVE, 'BACON')).reserved - before.reserved).toBe(2);
    expect(await reconciliationErrors(h)).toEqual([]);
  });

  it('idempotency keys make order placement safe to retry, including concurrent duplicates', async () => {
    const menu = await getMenu(h, 'kitchos-central');
    const lines = [{ menuItemId: item(menu, 'Cheeseburger').id, quantity: 2 }];
    const key = `retry-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => placeOrder(h, 'kitchos-central', lines, { key })),
    );
    const ids = new Set(results.map((r) => r.body.id));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(4);
    const count = await h.owner
      .selectFrom('orders')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('id', 'in', [...ids])
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);

    const reused = await placeOrder(h, 'kitchos-central', [{ ...lines[0]!, quantity: 3 }], { key });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('duplicate start/complete commands from concurrent terminals produce exactly one set of movements', async () => {
    const CENTRAL = 'kitchos-central';
    const centralId = await restaurantId(h, CENTRAL);
    const crewA = await login(h, 'crew1@central.kitchos.test');
    const crewB = await login(h, 'crew2@central.kitchos.test');
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Double Cheeseburger').id, quantity: 2 },
    ]);
    const tasks = (
      await h.http.get(`/v1/restaurants/${centralId}/kitchen/tasks`).set(bearer(crewA))
    ).body as KitchenTaskView[];
    const grill = tasks.find((t) => t.orderId === order.id)!;

    const fire = (token: string, action: string) =>
      h.http
        .post(`/v1/restaurants/${centralId}/kitchen/tasks/${grill.id}/${action}`)
        .set(bearer(token))
        .send({});
    const responses = await Promise.all([
      fire(crewA, 'start'),
      fire(crewB, 'start'),
      fire(crewA, 'complete'),
      fire(crewB, 'complete'),
      fire(crewA, 'start'),
    ]);
    // A start that arrives after completion is a genuine conflict; everything else succeeds.
    for (const r of responses) expect([200, 409]).toContain(r.status);

    const consumed = await consumptionForOrder(h, order.id);
    expect(consumed).toHaveLength(7);
    expect(Number(consumed.find((c) => c.sku === 'PATTY-BEEF')!.quantity_delta)).toBe(-4);
    expect(await reconciliationErrors(h)).toEqual([]);
  });

  it('optimistic concurrency: a stale expectedVersion is rejected', async () => {
    const CENTRAL = 'kitchos-central';
    const centralId = await restaurantId(h, CENTRAL);
    const crew = await login(h, 'crew1@central.kitchos.test');
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Chocolate Sundae').id, quantity: 1 },
    ]);
    const t = (
      (await h.http.get(`/v1/restaurants/${centralId}/kitchen/tasks`).set(bearer(crew)))
        .body as KitchenTaskView[]
    ).find((x) => x.orderId === order.id)!;
    const ok = await h.http
      .post(`/v1/restaurants/${centralId}/kitchen/tasks/${t.id}/start`)
      .set(bearer(crew))
      .send({ expectedVersion: t.version });
    expect(ok.status).toBe(200);
    const stale = await h.http
      .post(`/v1/restaurants/${centralId}/kitchen/tasks/${t.id}/complete`)
      .set(bearer(crew))
      .send({ expectedVersion: t.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONCURRENT_MODIFICATION');
  });

  it('cancel before preparation releases reservations and consumes nothing', async () => {
    const CENTRAL = 'kitchos-central';
    const centralId = await restaurantId(h, CENTRAL);
    const supervisor = await login(h, 'supervisor@central.kitchos.test');
    const before = await balance(h, CENTRAL, 'PATTY-BEEF');
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Cheeseburger').id, quantity: 3 },
    ]);
    expect((await balance(h, CENTRAL, 'PATTY-BEEF')).reserved - before.reserved).toBe(3);

    const res = await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/cancel`)
      .set(bearer(supervisor))
      .send({ reason: 'Customer changed their mind' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.tasks.every((t: { status: string }) => t.status === 'cancelled')).toBe(true);
    expect(await balance(h, CENTRAL, 'PATTY-BEEF')).toEqual(before);
    expect(await consumptionForOrder(h, order.id)).toHaveLength(0);
    expect(await reconciliationErrors(h)).toEqual([]);
  });

  it('cancel after preparation needs a manager, keeps consumed stock consumed and flags the loss', async () => {
    const CENTRAL = 'kitchos-central';
    const centralId = await restaurantId(h, CENTRAL);
    const crew = await login(h, 'crew1@central.kitchos.test');
    const supervisor = await login(h, 'supervisor@central.kitchos.test');
    const manager = await login(h, 'manager@central.kitchos.test');
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Bacon Deluxe').id, quantity: 1 },
    ]);
    const t = (
      (await h.http.get(`/v1/restaurants/${centralId}/kitchen/tasks`).set(bearer(crew)))
        .body as KitchenTaskView[]
    ).find((x) => x.orderId === order.id)!;
    await h.http
      .post(`/v1/restaurants/${centralId}/kitchen/tasks/${t.id}/start`)
      .set(bearer(crew))
      .send({})
      .expect(200);
    const consumedBefore = await consumptionForOrder(h, order.id);
    expect(consumedBefore).toHaveLength(8);
    const baconAfterCook = await balance(h, CENTRAL, 'BACON');

    const cancel = (token: string) =>
      h.http
        .post(`/v1/restaurants/${centralId}/orders/${order.id}/cancel`)
        .set(bearer(token))
        .send({ reason: 'Burger dropped on floor' });
    expect((await cancel(crew)).status).toBe(403); // crew cannot cancel at all
    expect((await cancel(supervisor)).status).toBe(403); // in production -> manager required
    const ok = await cancel(manager);
    expect(ok.status).toBe(200);

    // Invariant 11: refunds/cancellations never silently restore prepared stock.
    expect(await consumptionForOrder(h, order.id)).toHaveLength(8);
    expect(await balance(h, CENTRAL, 'BACON')).toEqual(baconAfterCook);
    const returns = await h.owner
      .selectFrom('stock_movements')
      .select('id')
      .where('movement_type', '=', 'return_to_stock')
      .execute();
    expect(returns).toHaveLength(0);

    const evt = await h.owner
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', order.id)
      .where('event_type', '=', 'order.cancelled')
      .executeTakeFirstOrThrow();
    expect(evt.payload).toMatchObject({ refundRequired: true, fromStatus: 'in_preparation' });
    const auditRow = await h.owner
      .selectFrom('audit_log')
      .select(['action', 'reason', 'actor_user_id'])
      .where('entity_id', '=', order.id)
      .executeTakeFirstOrThrow();
    expect(auditRow).toMatchObject({ action: 'order.cancel', reason: 'Burger dropped on floor' });
    expect(auditRow.actor_user_id).not.toBeNull();
  });

  it('allow_negative restaurants still record every movement when stock runs out', async () => {
    const EXPRESS = 'kitchos-express';
    await setAvailable(h, EXPRESS, 'CROISSANT', 0);
    const before = await balance(h, EXPRESS, 'CROISSANT');
    const menu = await getMenu(h, EXPRESS);
    const order = await placeAndPay(h, EXPRESS, [
      { menuItemId: item(menu, 'Toasted Croissant').id, quantity: 2 },
    ]);
    const manager = await login(h, 'manager@express.kitchos.test');
    const expressId = await restaurantId(h, EXPRESS);
    const t = (
      (await h.http.get(`/v1/restaurants/${expressId}/kitchen/tasks`).set(bearer(manager)))
        .body as KitchenTaskView[]
    ).find((x) => x.orderId === order.id)!;
    expect(t.stationCode).toBe('pantry');
    await h.http
      .post(`/v1/restaurants/${expressId}/kitchen/tasks/${t.id}/complete`)
      .set(bearer(manager))
      .send({})
      .expect(200);
    const after = await balance(h, EXPRESS, 'CROISSANT');
    expect(after.onHand - before.onHand).toBe(-2);
    expect(after.onHand - after.reserved).toBe(-2); // shortfall is visible, not hidden
    expect(await reconciliationErrors(h)).toEqual([]);
  });

  it('the database itself rejects ledger tampering by the runtime role', async () => {
    const { createDb } = await import('@kitchos/database');
    const { inject } = await import('vitest');
    const { db: app } = createDb({ connectionString: inject('appUrl'), max: 1 });
    try {
      await expect(
        app.updateTable('stock_movements').set({ notes: 'tampered' }).execute(),
      ).rejects.toThrow(/permission denied/);
      await expect(app.deleteFrom('audit_log').execute()).rejects.toThrow(/permission denied/);
      await expect(
        app.updateTable('stock_balances').set({ on_hand: '999' }).execute(),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await app.destroy();
    }
    // Even the owner cannot rewrite history or published menus.
    await expect(
      h.owner.updateTable('stock_movements').set({ notes: 'x' }).execute(),
    ).rejects.toThrow(/KITCHOS_APPEND_ONLY/);
    await expect(
      h.owner.updateTable('menu_items').set({ price_cents: 1 }).execute(),
    ).rejects.toThrow(/KITCHOS_IMMUTABLE/);
  });
});
