import { randomUUID } from 'node:crypto';
import type {
  DayCloseView,
  FoodCostReport,
  LedgerReconciliation,
  MenuItemReport,
  StockCountView,
  StockTransferView,
  TrialBalance,
} from '@kitchos/contracts';
import type { Database } from '@kitchos/database';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import { bearer, login, startHarness, type Harness } from './harness.ts';

/**
 * Stock transfers (ADR-0019) interacting with the rest of the system: business-day close,
 * food cost and menu-item reports, physical counts, waste, order reservations, the trial
 * balance and the audit trail.
 *
 * Hygiene: everything runs in a throwaway organisation with its own restaurants (as
 * day-close-adversarial does), because these tests close days and backdate rows. A
 * throwaway restaurant in the demo organisation would break counts other files assert.
 * Backdating uses `session_replication_role = replica` for one owner transaction (stock
 * movements are append-only, transfers are guarded) and runs before the ledger posts, so
 * the real consumer computes the real posting date.
 */
describe('stock transfers: interactions with day close, reports, counts, orders and audit', () => {
  let h: Harness;
  let dispatcher: EventDispatcher;
  let orgId: string;
  let brandId: string;
  let regionId: string;
  let menuId: string;
  const menuItems = { burger: '', cola: '' };
  const skus = { bun: '', cup: '', gram: '' };
  const tokens = { managerA: '', managerB: '', supervisor: '', inventory: '' };
  const userIds = { managerA: '', managerB: '', supervisor: '', inventory: '' };
  const names = { managerA: '', managerB: '', supervisor: '', inventory: '' };
  const restaurants: string[] = [];

  // ------------------------------------------------------------------ fixture

  const buildOrg = async () => {
    const tag = randomUUID().slice(0, 8);
    orgId = (
      await h.owner
        .insertInto('organisations')
        .values({ name: `Transfer interactions ${tag}`, slug: `sti-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await sql`select app.create_default_chart(${orgId}::uuid)`.execute(h.owner);
    brandId = (
      await h.owner
        .insertInto('brands')
        .values({ org_id: orgId, name: 'STI', slug: `sti-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    regionId = (
      await h.owner
        .insertInto('regions')
        .values({ org_id: orgId, name: 'STI region' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const inv = async (sku: string, cost: string, unit = 'each') =>
      (
        await h.owner
          .insertInto('inventory_items')
          .values({
            org_id: orgId,
            sku,
            name: sku,
            base_unit: unit,
            category: 'ingredient',
            standard_unit_cost: cost,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    skus.bun = await inv('BUN', '40');
    skus.cup = await inv('CUP', '15');
    skus.gram = await inv('GRAM', '0.333333', 'g');
    const menu = await h.owner
      .insertInto('menus')
      .values({ org_id: orgId, brand_id: brandId, name: 'STI menu' })
      .returning('id')
      .executeTakeFirstOrThrow();
    menuId = menu.id;
    const mv = await h.owner
      .insertInto('menu_versions')
      .values({ org_id: orgId, menu_id: menu.id, version: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const addItem = async (name: string, price: number, ingredient: string, point: string) => {
      const product = await h.owner
        .insertInto('products')
        .values({ org_id: orgId, brand_id: brandId, sku: name, name, kind: 'item' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const recipe = await h.owner
        .insertInto('recipes')
        .values({ org_id: orgId, product_id: product.id })
        .returning('id')
        .executeTakeFirstOrThrow();
      const rv = await h.owner
        .insertInto('recipe_versions')
        .values({
          org_id: orgId,
          recipe_id: recipe.id,
          version: 1,
          station_type: 'grill',
          consumption_point: point,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await h.owner
        .insertInto('recipe_lines')
        .values({
          org_id: orgId,
          recipe_version_id: rv.id,
          inventory_item_id: ingredient,
          quantity: '1',
        })
        .execute();
      await h.owner
        .updateTable('recipe_versions')
        .set({ status: 'published', published_at: sql<Date>`now()` })
        .where('id', '=', rv.id)
        .execute();
      return (
        await h.owner
          .insertInto('menu_items')
          .values({
            org_id: orgId,
            menu_version_id: mv.id,
            product_id: product.id,
            category: 'All',
            price_cents: price,
            recipe_version_id: rv.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    };
    menuItems.burger = await addItem('Burger', 1100, skus.bun, 'task_started');
    menuItems.cola = await addItem('Cola', 330, skus.cup, 'order_accepted');
    await h.owner
      .updateTable('menu_versions')
      .set({ status: 'published', published_at: sql<Date>`now()` })
      .where('id', '=', mv.id)
      .execute();

    const { password_hash } = await h.owner
      .selectFrom('users')
      .select('password_hash')
      .where('email', '=', 'manager@central.kitchos.test')
      .executeTakeFirstOrThrow();
    const roles: Record<keyof typeof tokens, string> = {
      managerA: 'restaurant_manager',
      managerB: 'restaurant_manager',
      supervisor: 'shift_supervisor',
      inventory: 'inventory_controller',
    };
    for (const [k, role] of Object.entries(roles) as [keyof typeof tokens, string][]) {
      const email = `${k.toLowerCase()}-${tag}@sti.test`;
      names[k] = `STI ${k} ${tag}`;
      const user = await h.owner
        .insertInto('users')
        .values({ org_id: orgId, email, display_name: names[k], password_hash })
        .returning('id')
        .executeTakeFirstOrThrow();
      userIds[k] = user.id;
      await h.owner
        .insertInto('role_assignments')
        .values({
          org_id: orgId,
          user_id: user.id,
          role,
          scope_type: 'organisation',
          scope_id: orgId,
        })
        .execute();
      tokens[k] = await login(h, email);
    }
  };

  const newRestaurant = async (policy: 'block' | 'allow_negative'): Promise<string> => {
    const slug = `sti-${randomUUID().slice(0, 8)}`;
    const r = await h.owner
      .insertInto('restaurants')
      .values({
        org_id: orgId,
        brand_id: brandId,
        region_id: regionId,
        menu_id: menuId,
        name: slug,
        slug,
        ownership: 'company',
        timezone: 'UTC',
        stock_shortage_policy: policy,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await h.owner
      .insertInto('stations')
      .values({
        org_id: orgId,
        restaurant_id: r.id,
        code: 'grill',
        name: 'Grill',
        station_types: ['grill', 'expo'],
      })
      .execute();
    await h.owner
      .insertInto('stock_locations')
      .values({ org_id: orgId, restaurant_id: r.id, code: 'main', name: 'Main', is_default: true })
      .execute();
    await h.owner
      .insertInto('restaurant_event_sequences')
      .values({ org_id: orgId, restaurant_id: r.id })
      .execute();
    restaurants.push(r.id);
    return r.id;
  };

  beforeAll(async () => {
    h = await startHarness();
    dispatcher = h.app.get(EventDispatcher);
    await buildOrg();
  });

  afterAll(async () => {
    await drain();
    // No failure of this org may keep retrying into later files.
    await h.owner.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = replica`.execute(tx);
      await sql`update event_consumer_failures set dead_at = now()
                 where org_id = ${orgId}::uuid and dead_at is null`.execute(tx);
    });
    await h.close();
  });

  // ------------------------------------------------------------------ helpers

  const api = (rid: string) => `/v1/restaurants/${rid}`;

  const drain = async () => {
    for (let i = 0; i < 30; i++) {
      const stats = await dispatcher.runOnce();
      if (stats.processed === 0) return;
    }
  };

  const asOwnerRaw = (fn: (tx: Database) => Promise<void>) =>
    h.owner.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = replica`.execute(tx);
      await fn(tx);
    });

  const dbNow = async () => (await sql<{ n: Date }>`select now() as n`.execute(h.owner)).rows[0]!.n;

  const today = async (rid: string) =>
    (
      await sql<{ d: string }>`select app.business_date(${rid}::uuid, now())::text as d`.execute(
        h.owner,
      )
    ).rows[0]!.d;

  const addDays = async (day: string, n: number) =>
    (await sql<{ d: string }>`select (${day}::date + ${n}::int)::text as d`.execute(h.owner))
      .rows[0]!.d;

  const noon = (day: string) => sql<Date>`((${day}::date + time '12:00') at time zone 'UTC')`;

  /** Moves this restaurant's stock activity (and its transfers) since `since` back by whole days. */
  const backdate = (rid: string, days: number, since: Date) =>
    asOwnerRaw(async (tx) => {
      const by = sql`(${days}::int * interval '1 day')`;
      const prior = sql`${days}::int`;
      await sql`update stock_movements set occurred_at = occurred_at - ${by},
                  recorded_at = recorded_at - ${by}, business_date = business_date - ${prior}
                where restaurant_id = ${rid}::uuid and occurred_at >= ${since}`.execute(tx);
      await sql`update goods_receipts set received_at = received_at - ${by},
                  business_date = business_date - ${prior}
                where restaurant_id = ${rid}::uuid and received_at >= ${since}`.execute(tx);
      await sql`update stock_transfers set dispatched_at = dispatched_at - ${by},
                  dispatch_business_date = dispatch_business_date - ${prior}
                where from_restaurant_id = ${rid}::uuid and dispatched_at >= ${since}`.execute(tx);
      await sql`update stock_transfers set received_at = received_at - ${by},
                  receive_business_date = receive_business_date - ${prior}
                where to_restaurant_id = ${rid}::uuid and received_at >= ${since}`.execute(tx);
      await sql`update outbox_events set occurred_at = occurred_at - ${by}
                where restaurant_id = ${rid}::uuid and occurred_at >= ${since}`.execute(tx);
    });

  const stockIn = async (rid: string, lines: { inventoryItemId: string; quantity: string }[]) => {
    await h.http
      .post(`${api(rid)}/inventory/receipts`)
      .set(bearer(tokens.managerA))
      .set('Idempotency-Key', randomUUID())
      .send({ lines })
      .expect(201);
  };
  const send = (token: string, from: string, body: object, key = randomUUID()) =>
    h.http
      .post(`${api(from)}/inventory/transfers`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send(body);
  const receive = (token: string, at: string, id: string, body: object, key = randomUUID()) =>
    h.http
      .post(`${api(at)}/inventory/transfers/${id}/receive`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send(body);
  const view = async (rid: string, day: string) =>
    (
      await h.http
        .get(`${api(rid)}/days/${day}`)
        .set(bearer(tokens.managerA))
        .expect(200)
    ).body as DayCloseView;
  const close = (rid: string, day: string) =>
    h.http
      .post(`${api(rid)}/days/${day}/close`)
      .set(bearer(tokens.managerA))
      .send({});
  const reconciliation = async (rid: string, day: string) =>
    (
      await h.http
        .get(`${api(rid)}/accounting/reconciliation?businessDate=${day}`)
        .set(bearer(tokens.managerA))
        .expect(200)
    ).body as LedgerReconciliation;
  const onHand = async (rid: string, item: string) => {
    const r = await h.owner
      .selectFrom('stock_balances as b')
      .innerJoin('stock_locations as l', 'l.id', 'b.location_id')
      .select(['b.on_hand', 'b.reserved'])
      .where('l.restaurant_id', '=', rid)
      .where('l.is_default', '=', true)
      .where('b.inventory_item_id', '=', item)
      .executeTakeFirst();
    return { onHand: Number(r?.on_hand ?? 0), reserved: Number(r?.reserved ?? 0) };
  };
  /** Net debit − credit on one account at a restaurant, for one day or all time. */
  const accountNet = async (rid: string, key: string, day?: string) => {
    let q = h.owner
      .selectFrom('journal_lines as l')
      .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(sql<string>`coalesce(sum(l.debit_cents - l.credit_cents), 0)`.as('net'))
      .where('e.restaurant_id', '=', rid)
      .where('a.system_key', '=', key);
    if (day) q = q.where('e.business_date', '=', day);
    return Number((await q.executeTakeFirstOrThrow()).net);
  };
  const transferEntry = (sourceId: string, entryType: string) =>
    h.owner
      .selectFrom('journal_entries')
      .select([
        'id',
        'restaurant_id',
        sql<string>`business_date::text`.as('day'),
        sql<string | null>`posted_late_from::text`.as('late_from'),
      ])
      .where('source_type', '=', 'stock_transfer')
      .where('source_id', '=', sourceId)
      .where('entry_type', '=', entryType)
      .execute();
  const failuresAt = (rid: string) =>
    h.owner
      .selectFrom('event_consumer_failures as f')
      .innerJoin('outbox_events as o', 'o.id', 'f.event_id')
      .select(['o.event_type', 'f.attempts', 'f.dead_at', 'f.last_error'])
      .where('o.restaurant_id', '=', rid)
      .execute();
  /** Balances at a restaurant that differ from the sum of their movements or active reservations. */
  const ledgerErrors = async (rid: string) =>
    (
      await sql`
      select b.inventory_item_id, b.on_hand, b.reserved
        from stock_balances b
        join stock_locations l on l.id = b.location_id
       where l.restaurant_id = ${rid}::uuid
         and (b.on_hand <> coalesce((select sum(m.quantity_delta) from stock_movements m
                where m.location_id = b.location_id and m.inventory_item_id = b.inventory_item_id), 0)
           or b.reserved <> coalesce((select sum(r.quantity) from stock_reservations r
                where r.location_id = b.location_id and r.inventory_item_id = b.inventory_item_id
                  and r.status = 'active'), 0)
           or b.on_hand - b.reserved < 0)`.execute(h.owner)
    ).rows;
  const storedClose = (rid: string, day: string) =>
    h.owner
      .selectFrom('business_day_closes')
      .select(['id', 'totals'])
      .where('restaurant_id', '=', rid)
      .where('business_date', '=', day)
      .executeTakeFirst();

  // ------------------------------------------------------------------ 1. day close

  it('the sender closes its dispatch day while goods are in transit; the receiver closes around the receipt', async () => {
    const A = await newRestaurant('block');
    const B = await newRestaurant('allow_negative');
    const t0 = await today(A);
    const D = await addDays(t0, -60);
    const since = await dbNow();
    await stockIn(A, [{ inventoryItemId: skus.bun, quantity: '20' }]);
    const sent = (
      await send(tokens.managerA, A, {
        toRestaurantId: B,
        lines: [{ inventoryItemId: skus.bun, quantity: '10' }],
      }).expect(201)
    ).body as StockTransferView;
    expect(sent.sentCents).toBe(400);
    await backdate(A, 60, since);
    await drain();

    // The dispatch posted to D at the sender, from the backdated movements.
    const out = await transferEntry(sent.id, 'transfer_out');
    expect(out).toMatchObject([{ restaurant_id: A, day: D, late_from: null }]);
    expect(await accountNet(A, 'stock_in_transit', D)).toBe(400);
    expect(await accountNet(A, 'inventory', D)).toBe(800 - 400);
    const recD = await reconciliation(A, D);
    expect(recD).toMatchObject({
      reconciled: true,
      stockMovementsValueCents: 400,
      journalInventoryCents: 400,
      pendingEvents: 0,
    });

    // An open transfer does not hold the sender's day (ADR: no close-readiness warning).
    const before = await view(A, D);
    expect(before.blockers).toEqual([]);
    const closedA = await close(A, D);
    expect(closedA.status).toBe(200);
    const snapA = (closedA.body as DayCloseView).totals;
    expect(snapA).toMatchObject({ cogsCents: 0, transferShortageCents: 0, stockVarianceCents: 0 });

    // The receiver closes the same day (nothing there) before anything arrives.
    expect((await close(B, D)).status).toBe(200);

    // The receipt happens today: it lands on today at B, never on the closed D.
    const got = (
      await receive(tokens.managerB, B, sent.id, {
        lines: [{ inventoryItemId: skus.bun, quantityReceived: '9' }],
      }).expect(200)
    ).body as StockTransferView;
    expect(got).toMatchObject({ receiveBusinessDate: t0, receivedCents: 360, shortageCents: 40 });
    await drain();
    expect(await failuresAt(A)).toEqual([]);
    expect(await failuresAt(B)).toEqual([]);
    const inn = await transferEntry(sent.id, 'transfer_in');
    expect(inn).toMatchObject([{ restaurant_id: B, day: t0, late_from: null }]);
    expect(await accountNet(B, 'inventory', D)).toBe(0);
    expect(await accountNet(B, 'stock_in_transit', t0)).toBe(-400);
    expect(await accountNet(B, 'transfer_shortage', t0)).toBe(40);
    expect(await accountNet(A, 'stock_in_transit')).toBe(400);
    expect(
      (await accountNet(A, 'stock_in_transit')) + (await accountNet(B, 'stock_in_transit')),
    ).toBe(0);
    expect(await reconciliation(B, t0)).toMatchObject({
      reconciled: true,
      stockMovementsValueCents: 360,
      journalInventoryCents: 360,
    });
    // The receiver's day view carries the shortage; the sender's closed snapshot is untouched.
    expect((await view(B, t0)).totals.transferShortageCents).toBe(40);
    expect((await storedClose(A, D))!.totals).toEqual(snapA);
    expect((await view(A, D)).status).toBe('closed');
  });

  it('a receipt that outlives the receiver closing its day posts to an open day, flagged late', async () => {
    const A = await newRestaurant('block');
    const B = await newRestaurant('allow_negative');
    const t0 = await today(B);
    const D = await addDays(t0, -50);
    await stockIn(A, [{ inventoryItemId: skus.gram, quantity: '3000' }]);
    const sent = (
      await send(tokens.managerA, A, {
        toRestaurantId: B,
        lines: [{ inventoryItemId: skus.gram, quantity: '1000' }],
      }).expect(201)
    ).body as StockTransferView;
    expect(sent.sentCents).toBe(333);
    await drain();
    const closed = await close(B, D);
    expect(closed.status).toBe(200);
    const snapshot = (closed.body as DayCloseView).totals;

    // The receipt's transaction began on D and committed after D closed (simulated: the
    // receipt and its event are moved onto D before the ledger posts them).
    const since = await dbNow();
    await receive(tokens.managerB, B, sent.id, {
      lines: [{ inventoryItemId: skus.gram, quantityReceived: '999.5' }],
    }).expect(200);
    await asOwnerRaw(async (tx) => {
      await sql`update stock_transfers set received_at = ${noon(D)}, receive_business_date = ${D}::date
                where id = ${sent.id}::uuid`.execute(tx);
      await sql`update stock_movements set occurred_at = ${noon(D)}, business_date = ${D}::date
                where source_id = ${sent.id}::uuid and movement_type = 'transfer_in'`.execute(tx);
      await sql`update outbox_events set occurred_at = ${noon(D)}
                where restaurant_id = ${B}::uuid and occurred_at >= ${since}`.execute(tx);
    });
    await drain();
    expect(await failuresAt(B)).toEqual([]);
    const inn = await transferEntry(sent.id, 'transfer_in');
    expect(inn).toHaveLength(1);
    expect(inn[0]!.late_from).toBe(D);
    expect(inn[0]!.day >= t0).toBe(true);
    // round(999.5 × 0.333333) = 333; transit clears exactly whatever day it landed on.
    expect(
      (await accountNet(A, 'stock_in_transit')) + (await accountNet(B, 'stock_in_transit')),
    ).toBe(0);
    expect(await accountNet(B, 'stock_in_transit', D)).toBe(0);
    expect((await storedClose(B, D))!.totals).toEqual(snapshot);
    // Today's comparison leaves the late entry out (its movements are dated D), so it still reconciles.
    expect((await reconciliation(B, inn[0]!.day)).reconciled).toBe(true);
  });

  // ------------------------------------------------------------------ 2. reports

  it('a transfer is not cost of sales: food cost and menu-item reports at both ends ignore it', async () => {
    const A = await newRestaurant('block');
    const B = await newRestaurant('allow_negative');
    const t0 = await today(A);
    await stockIn(A, [{ inventoryItemId: skus.bun, quantity: '30' }]);
    await stockIn(B, [{ inventoryItemId: skus.cup, quantity: '10' }]);
    // One real sale at B: a cola, whose cup (15) is consumed when the order is accepted.
    const order = await h.http
      .post(`${api(B)}/orders`)
      .set(bearer(tokens.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({ fulfilmentType: 'dine_in', lines: [{ menuItemId: menuItems.cola, quantity: 1 }] });
    expect(order.status).toBe(201);
    await h.http
      .post(`${api(B)}/orders/${order.body.id}/payments`)
      .set(bearer(tokens.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'card', paymentToken: 'tok_sandbox_approve' })
      .expect(200);
    // Handed over, so the sale is recognised (the menu-item report is dated by that entry).
    const tasks = await h.owner
      .selectFrom('kitchen_tasks')
      .select('id')
      .where('order_id', '=', order.body.id)
      .execute();
    for (const task of tasks) {
      await h.http
        .post(`${api(B)}/kitchen/tasks/${task.id}/complete`)
        .set(bearer(tokens.supervisor))
        .send({})
        .expect(200);
    }
    await h.http
      .post(`${api(B)}/orders/${order.body.id}/handoff`)
      .set(bearer(tokens.supervisor))
      .expect(200);
    const t = (
      await send(tokens.managerA, A, {
        toRestaurantId: B,
        lines: [{ inventoryItemId: skus.bun, quantity: '10' }],
      }).expect(201)
    ).body as StockTransferView;
    await receive(tokens.managerB, B, t.id, {
      lines: [{ inventoryItemId: skus.bun, quantityReceived: '7' }],
    }).expect(200);
    await drain();
    expect(await accountNet(B, 'cogs', t0)).toBe(15);

    const foodCost = async (rid: string) =>
      (
        await h.http
          .get(`${api(rid)}/reports/food-cost?from=${t0}&to=${t0}`)
          .set(bearer(tokens.managerA))
          .expect(200)
      ).body as FoodCostReport;
    const menuReport = async (rid: string) =>
      (
        await h.http
          .get(`${api(rid)}/reports/menu-items?from=${t0}&to=${t0}`)
          .set(bearer(tokens.managerA))
          .expect(200)
      ).body as MenuItemReport;

    const fa = await foodCost(A);
    expect(fa.totals).toMatchObject({
      netSalesCents: 0,
      cogsCents: 0,
      wasteCents: 0,
      stockVarianceCents: 0,
      actualFoodCostCents: 0,
    });
    const fb = await foodCost(B);
    // The shortage (3 × 40) is expensed as Transfer shortage, not in actual food cost (ADR-0019).
    expect(fb.totals).toMatchObject({
      cogsCents: 15,
      wasteCents: 0,
      stockVarianceCents: 0,
      actualFoodCostCents: 15,
    });
    expect(await accountNet(B, 'transfer_shortage', t0)).toBe(120);
    // The menu-item report is driven by sales only.
    expect((await menuReport(A)).items).toEqual([]);
    const mb = await menuReport(B);
    expect(mb.items.map((i) => i.name)).toEqual(['Cola']);
    expect(mb.totals.recipeCostCents).toBe(15);
    // The day close shows the shortage separately from COGS.
    expect((await view(B, t0)).totals).toMatchObject({ cogsCents: 15, transferShortageCents: 120 });
    expect((await view(A, t0)).totals).toMatchObject({ cogsCents: 0, transferShortageCents: 0 });
  });

  // ------------------------------------------------------------------ 3. races at the sender

  it('a dispatch racing a physical count and a waste record on the same items: counts see the right on-hand', async () => {
    const A = await newRestaurant('block');
    const B = await newRestaurant('allow_negative');
    for (let round = 0; round < 4; round++) {
      await stockIn(A, [
        { inventoryItemId: skus.bun, quantity: '100' },
        { inventoryItemId: skus.cup, quantity: '100' },
      ]);
      const x0 = (await onHand(A, skus.bun)).onHand;
      const y0 = (await onHand(A, skus.cup)).onHand;
      const [dispatch, count, waste] = await Promise.all([
        send(tokens.managerA, A, {
          toRestaurantId: B,
          lines: [
            { inventoryItemId: skus.bun, quantity: '10' },
            { inventoryItemId: skus.cup, quantity: '10' },
          ],
        }).then((r) => r),
        h.http
          .post(`${api(A)}/inventory/counts`)
          .set(bearer(tokens.managerA))
          .set('Idempotency-Key', randomUUID())
          .send({
            lines: [
              // Opposite order to the dispatch.
              { inventoryItemId: skus.cup, counted: '50' },
              { inventoryItemId: skus.bun, counted: '50' },
            ],
          })
          .then((r) => r),
        h.http
          .post(`${api(A)}/inventory/waste`)
          .set(bearer(tokens.managerA))
          .set('Idempotency-Key', randomUUID())
          .send({
            kind: 'raw_ingredient',
            inventoryItemId: skus.bun,
            quantity: '5',
            reason: 'spoiled',
          })
          .then((r) => r),
      ]);
      expect([dispatch.status, count.status, waste.status]).toEqual([201, 201, 201]);
      const c = count.body as StockCountView;
      const line = (sku: string) => c.lines.find((l) => l.sku === sku)!;
      const xFinal = (await onHand(A, skus.bun)).onHand;
      const yFinal = (await onHand(A, skus.cup)).onHand;
      // Whatever committed before the count is in its `expected`; whatever after is in the final
      // balance. So expected + final = start + counted − everything else that moved.
      expect(Number(line('BUN').expected) + xFinal).toBe(x0 + 50 - 10 - 5);
      expect(Number(line('CUP').expected) + yFinal).toBe(y0 + 50 - 10);
      expect(Number(line('BUN').variance)).toBe(50 - Number(line('BUN').expected));
      expect(line('BUN').varianceCents).toBe(40 * (50 - Number(line('BUN').expected)));
      expect(await ledgerErrors(A)).toEqual([]);
      // The count line persisted what the response says.
      const persisted = await h.owner
        .selectFrom('stock_count_lines')
        .select(['inventory_item_id', 'expected'])
        .where('stock_count_id', '=', c.id)
        .execute();
      expect(Number(persisted.find((p) => p.inventory_item_id === skus.bun)!.expected)).toBe(
        Number(line('BUN').expected),
      );
    }
    await drain();
    const t0 = await today(A);
    expect(await failuresAt(A)).toEqual([]);
    const rec = await reconciliation(A, t0);
    expect(rec.stockMovementsValueCents).toBe(rec.journalInventoryCents);
    expect(rec.reconciled).toBe(true);
    // Stock variance on the books equals the counts' own variance, unaffected by the transfers.
    const counted = await h.owner
      .selectFrom('stock_counts')
      .select(sql<string>`coalesce(sum(variance_cents), 0)`.as('v'))
      .where('restaurant_id', '=', A)
      .executeTakeFirstOrThrow();
    expect(await accountNet(A, 'stock_variance', t0)).toBe(-Number(counted.v));
  });

  it('a dispatch racing order placement under the block policy never takes reserved stock', async () => {
    const A = await newRestaurant('block');
    const B = await newRestaurant('allow_negative');
    for (let round = 0; round < 4; round++) {
      const start = await onHand(A, skus.bun);
      // Exactly five buns available this round.
      await stockIn(A, [
        { inventoryItemId: skus.bun, quantity: String(5 - (start.onHand - start.reserved)) },
      ]);
      const before = await onHand(A, skus.bun);
      expect(before.onHand - before.reserved).toBe(5);
      const orders = Array.from({ length: 4 }, () =>
        h.http
          .post(`${api(A)}/orders`)
          .set(bearer(tokens.supervisor))
          .set('Idempotency-Key', randomUUID())
          .send({
            fulfilmentType: 'dine_in',
            lines: [{ menuItemId: menuItems.burger, quantity: 1 }],
          })
          .then((r) => r),
      );
      const dispatch = send(tokens.managerA, A, {
        toRestaurantId: B,
        lines: [{ inventoryItemId: skus.bun, quantity: '3' }],
      }).then((r) => r);
      const all = await Promise.all([dispatch, ...orders]);
      const [d, ...placed] = all;
      expect([201, 409]).toContain(d!.status);
      for (const o of placed) expect([201, 409]).toContain(o.status);
      const won = placed.filter((o) => o.status === 201).length;
      const sent = d!.status === 201 ? 3 : 0;
      expect(won + sent).toBeLessThanOrEqual(5);
      const after = await onHand(A, skus.bun);
      expect(after.onHand).toBe(before.onHand - sent);
      expect(after.reserved).toBe(before.reserved + won);
      expect(after.onHand - after.reserved).toBeGreaterThanOrEqual(0);
      expect(await ledgerErrors(A)).toEqual([]);
      if (d!.status === 409) expect(d!.body.error.code).toBe('INSUFFICIENT_STOCK');
    }
    await drain();
    expect(await failuresAt(A)).toEqual([]);
  });

  // ------------------------------------------------------------------ 4. attribution

  it('dispatch and receipt are attributed to the people who did them, in rows and the audit log', async () => {
    const A = await newRestaurant('block');
    const B = await newRestaurant('allow_negative');
    await stockIn(A, [{ inventoryItemId: skus.bun, quantity: '5' }]);
    const t = (
      await send(tokens.inventory, A, {
        toRestaurantId: B,
        lines: [{ inventoryItemId: skus.bun, quantity: '4' }],
      }).expect(201)
    ).body as StockTransferView;
    const key = randomUUID();
    const body = { lines: [{ inventoryItemId: skus.bun, quantityReceived: '3' }] };
    const r = (await receive(tokens.managerB, B, t.id, body, key).expect(200))
      .body as StockTransferView;
    // A replay records nothing new.
    const replay = await receive(tokens.managerB, B, t.id, body, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    expect(r).toMatchObject({ dispatchedBy: names.inventory, receivedBy: names.managerB });
    const row = await h.owner
      .selectFrom('stock_transfers')
      .select(['dispatched_by', 'received_by', 'version', 'status'])
      .where('id', '=', t.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      dispatched_by: userIds.inventory,
      received_by: userIds.managerB,
      version: 2,
      status: 'received',
    });
    const movements = await h.owner
      .selectFrom('stock_movements')
      .select(['restaurant_id', 'movement_type', 'actor_user_id', 'quantity_delta'])
      .where('source_type', '=', 'stock_transfer')
      .where('source_id', '=', t.id)
      .orderBy('movement_type')
      .execute();
    expect(movements.map((m) => ({ ...m, quantity_delta: Number(m.quantity_delta) }))).toEqual([
      {
        restaurant_id: B,
        movement_type: 'transfer_in',
        actor_user_id: userIds.managerB,
        quantity_delta: 3,
      },
      {
        restaurant_id: A,
        movement_type: 'transfer_out',
        actor_user_id: userIds.inventory,
        quantity_delta: -4,
      },
    ]);
    const audits = await h.owner
      .selectFrom('audit_log')
      .select(['action', 'restaurant_id', 'actor_user_id', 'data'])
      .where('entity_type', '=', 'stock_transfer')
      .where('entity_id', '=', t.id)
      .orderBy('occurred_at')
      .execute();
    expect(audits).toEqual([
      {
        action: 'inventory.transfer_dispatch',
        restaurant_id: A,
        actor_user_id: userIds.inventory,
        data: { toRestaurantId: B, lines: 1 },
      },
      {
        action: 'inventory.transfer_receive',
        restaurant_id: B,
        actor_user_id: userIds.managerB,
        data: { fromRestaurantId: A, short: 1 },
      },
    ]);
    const events = await h.owner
      .selectFrom('outbox_events')
      .select(['event_type', 'restaurant_id', 'aggregate_version'])
      .where('aggregate_id', '=', t.id)
      .orderBy('aggregate_version')
      .execute();
    expect(events).toEqual([
      { event_type: 'inventory.transfer_dispatched', restaurant_id: A, aggregate_version: 1 },
      { event_type: 'inventory.transfer_received', restaurant_id: B, aggregate_version: 2 },
    ]);
    await drain();
  });

  // ------------------------------------------------------------------ 5. books across the org

  it('every trial balance stays balanced and org-wide Stock in transit equals the open dispatches', async () => {
    const A = await newRestaurant('block');
    const B = await newRestaurant('allow_negative');
    const C = await newRestaurant('block');
    await stockIn(A, [
      { inventoryItemId: skus.bun, quantity: '50' },
      { inventoryItemId: skus.gram, quantity: '5000' },
    ]);
    await stockIn(C, [{ inventoryItemId: skus.cup, quantity: '40' }]);
    const go = async (token: string, from: string, to: string, lines: object[]) =>
      (await send(token, from, { toRestaurantId: to, lines }).expect(201))
        .body as StockTransferView;
    const ab = await go(tokens.managerA, A, B, [
      { inventoryItemId: skus.bun, quantity: '10' },
      { inventoryItemId: skus.gram, quantity: '1234.567' },
    ]);
    const ac = await go(tokens.managerA, A, C, [{ inventoryItemId: skus.gram, quantity: '777' }]);
    const ca = await go(tokens.managerA, C, A, [{ inventoryItemId: skus.cup, quantity: '13' }]);
    await receive(tokens.managerB, B, ab.id, {
      lines: [
        { inventoryItemId: skus.bun, quantityReceived: '9' },
        { inventoryItemId: skus.gram, quantityReceived: '1000.001' },
      ],
    }).expect(200);
    // B forwards part of what it got (B allows negative; C blocks).
    await drain();
    const bc = await go(tokens.managerB, B, C, [{ inventoryItemId: skus.bun, quantity: '4' }]);
    await receive(tokens.managerB, C, ac.id, {
      lines: [{ inventoryItemId: skus.gram, quantityReceived: '777' }],
    }).expect(200);
    await drain();
    expect(await failuresAt(A)).toEqual([]);
    expect(await failuresAt(B)).toEqual([]);
    expect(await failuresAt(C)).toEqual([]);

    const t0 = await today(A);
    const from = await addDays(t0, -70);
    for (const rid of restaurants) {
      const tb = (
        await h.http
          .get(`${api(rid)}/accounting/trial-balance?from=${from}&to=${t0}`)
          .set(bearer(tokens.managerA))
          .expect(200)
      ).body as TrialBalance;
      expect(tb.balanced, rid).toBe(true);
      expect(tb.totalDebitCents, rid).toBe(tb.totalCreditCents);
    }
    // Org-wide (every restaurant of this throwaway org, every day, including the earlier tests).
    const transit = await h.owner
      .selectFrom('journal_lines as l')
      .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(sql<string>`coalesce(sum(l.debit_cents - l.credit_cents), 0)`.as('net'))
      .where('e.org_id', '=', orgId)
      .where('a.system_key', '=', 'stock_in_transit')
      .executeTakeFirstOrThrow();
    const open = await h.owner
      .selectFrom('stock_transfers as t')
      .innerJoin('stock_movements as m', (j) =>
        j
          .onRef('m.source_id', '=', 't.id')
          .on('m.source_type', '=', 'stock_transfer')
          .on('m.movement_type', '=', 'transfer_out'),
      )
      .select(sql<string>`coalesce(-sum(m.value_cents), 0)`.as('sent'))
      .where('t.org_id', '=', orgId)
      .where('t.status', '=', 'in_transit')
      .executeTakeFirstOrThrow();
    // ca and bc are still on the road (plus any open transfer of the earlier tests).
    expect(Number(open.sent)).toBeGreaterThanOrEqual(ca.sentCents + bc.sentCents);
    expect(Number(transit.net)).toBe(Number(open.sent));
    // Per restaurant, Inventory equals the value of its stock ledger, all time.
    for (const rid of restaurants) {
      const v = await h.owner
        .selectFrom('stock_movements')
        .select(sql<string>`coalesce(sum(value_cents), 0)`.as('v'))
        .where('restaurant_id', '=', rid)
        .executeTakeFirstOrThrow();
      expect(await accountNet(rid, 'inventory'), rid).toBe(Number(v.v));
    }
  });
});
