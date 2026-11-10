import { randomUUID } from 'node:crypto';
import type { DayCloseView, FoodCostReport } from '@kitchos/contracts';
import { createDb, withTenant, type Database } from '@kitchos/database';
import { foodCost } from '@kitchos/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import { bearer, login, restaurantId, startHarness, type Harness } from './harness.ts';

const CENTRAL = 'kitchos-central';
const RIVAL = 'rival-southbank';

type Row = FoodCostReport['days'][number];
type Figures = Pick<Row, 'netSalesCents' | 'cogsCents' | 'wasteCents' | 'stockVarianceCents'>;

/**
 * Adversarial tests for the food cost and gross margin report.
 *
 * Every figure is compared with values computed independently from source rows
 * (orders, refunds, stock_movements.value_cents, waste_record_lines), never from
 * the journal the report reads.
 *
 * Hygiene: everything that posts runs in a throwaway organisation with its own
 * restaurants (so other files' sales never interfere and nobody else's counts
 * change). Only a day 60 days back is closed. Seeded restaurants are only read
 * or receive requests that must be refused. afterAll retires any failure still
 * retrying and closes every drawer session left open in the throwaway org.
 */
describe('food cost report (adversarial)', () => {
  let h: Harness;
  let appDb: Database;
  let dispatcher: EventDispatcher;
  let orgId: string;
  let brandId: string;
  let regionId: string;
  let otherRegionId: string;
  let menuId: string;
  const items = { burger: '', cola: '', odd: '', meal: '', big: '', big1: '', big3: '' };
  const skus = { bun: '', cup: '', pin1: '', pin3: '' };
  const tokens = {
    manager: '',
    supervisor: '',
    crew: '',
    auditor: '',
    area: '',
    areaOther: '',
    inventory: '',
    otherManager: '',
  };
  let passwordHash: string;
  let tag: string;

  interface Rest {
    id: string;
    drawers: string[];
  }

  // ------------------------------------------------------------------ fixture

  const buildOrg = async () => {
    tag = randomUUID().slice(0, 8);
    orgId = (
      await h.owner
        .insertInto('organisations')
        .values({ name: `Food cost adversarial ${tag}`, slug: `fca-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await sql`select app.create_default_chart(${orgId}::uuid)`.execute(h.owner);
    brandId = (
      await h.owner
        .insertInto('brands')
        .values({ org_id: orgId, name: 'FCA', slug: `fca-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const region = async (name: string) =>
      (
        await h.owner
          .insertInto('regions')
          .values({ org_id: orgId, name })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    regionId = await region('FCA region');
    otherRegionId = await region('FCA other region');
    const inv = async (sku: string, cost: string) =>
      (
        await h.owner
          .insertInto('inventory_items')
          .values({
            org_id: orgId,
            sku,
            name: sku,
            base_unit: 'each',
            category: 'ingredient',
            standard_unit_cost: cost,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    skus.bun = await inv('BUN', '40');
    skus.cup = await inv('CUP', '15');
    skus.pin1 = await inv('PIN1', '1');
    skus.pin3 = await inv('PIN3', '3');
    menuId = (
      await h.owner
        .insertInto('menus')
        .values({ org_id: orgId, brand_id: brandId, name: 'FCA menu' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const mv = await h.owner
      .insertInto('menu_versions')
      .values({ org_id: orgId, menu_id: menuId, version: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const product = async (name: string, kind: 'item' | 'combo') =>
      (
        await h.owner
          .insertInto('products')
          .values({ org_id: orgId, brand_id: brandId, sku: name, name, kind })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const recipeFor = async (productId: string, ingredient: string, point: string) => {
      const recipe = await h.owner
        .insertInto('recipes')
        .values({ org_id: orgId, product_id: productId })
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
      return rv.id;
    };
    const recipes: Record<string, { productId: string; rv: string }> = {};
    const addItem = async (
      key: keyof typeof items,
      name: string,
      price: number,
      ingredient: string,
      point: string,
    ) => {
      const productId = await product(name, 'item');
      const rv = await recipeFor(productId, ingredient, point);
      recipes[key] = { productId, rv };
      items[key] = (
        await h.owner
          .insertInto('menu_items')
          .values({
            org_id: orgId,
            menu_version_id: mv.id,
            product_id: productId,
            category: 'All',
            price_cents: price,
            recipe_version_id: rv,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    };
    await addItem('burger', 'Burger', 1100, skus.bun, 'task_started');
    await addItem('cola', 'Cola', 330, skus.cup, 'order_accepted');
    await addItem('odd', 'Odd', 1103, skus.bun, 'task_started');
    await addItem('big', 'Big', 22_000, skus.pin1, 'order_accepted');
    await addItem('big1', 'Big1', 22_001, skus.pin1, 'order_accepted');
    await addItem('big3', 'Big3', 22_000, skus.pin3, 'order_accepted');
    // A meal: burger and cola for 1250.
    const mealProduct = await product('Meal', 'combo');
    items.meal = (
      await h.owner
        .insertInto('menu_items')
        .values({
          org_id: orgId,
          menu_version_id: mv.id,
          product_id: mealProduct,
          category: 'Meals',
          price_cents: 1250,
          recipe_version_id: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    for (const [i, key] of (['burger', 'cola'] as const).entries()) {
      await h.owner
        .insertInto('combo_components')
        .values({
          org_id: orgId,
          menu_item_id: items.meal,
          product_id: recipes[key]!.productId,
          quantity: 1,
          recipe_version_id: recipes[key]!.rv,
          display_order: i,
        })
        .execute();
    }
    await h.owner
      .updateTable('menu_versions')
      .set({ status: 'published', published_at: sql<Date>`now()` })
      .where('id', '=', mv.id)
      .execute();

    passwordHash = (
      await h.owner
        .selectFrom('users')
        .select('password_hash')
        .where('email', '=', 'manager@central.kitchos.test')
        .executeTakeFirstOrThrow()
    ).password_hash;
    const orgRoles: [keyof typeof tokens, string, 'organisation' | 'region', string][] = [
      ['manager', 'restaurant_manager', 'organisation', orgId],
      ['supervisor', 'shift_supervisor', 'organisation', orgId],
      ['crew', 'crew_member', 'organisation', orgId],
      ['auditor', 'auditor', 'organisation', orgId],
      ['area', 'area_manager', 'region', regionId],
      ['areaOther', 'area_manager', 'region', otherRegionId],
      ['inventory', 'inventory_controller', 'organisation', orgId],
    ];
    for (const [k, role, scopeType, scopeId] of orgRoles) {
      tokens[k] = await addUser(k, role, scopeType, scopeId);
    }
  };

  const addUser = async (k: string, role: string, scopeType: string, scopeId: string) => {
    const email = `${k}-${tag}@fca.test`;
    const user = await h.owner
      .insertInto('users')
      .values({ org_id: orgId, email, display_name: `FCA ${k}`, password_hash: passwordHash })
      .returning('id')
      .executeTakeFirstOrThrow();
    await h.owner
      .insertInto('role_assignments')
      .values({ org_id: orgId, user_id: user.id, role, scope_type: scopeType, scope_id: scopeId })
      .execute();
    return login(h, email);
  };

  const newRestaurant = async (timezone = 'UTC', region = regionId): Promise<Rest> => {
    const slug = `fca-${randomUUID().slice(0, 8)}`;
    const r = await h.owner
      .insertInto('restaurants')
      .values({
        org_id: orgId,
        brand_id: brandId,
        region_id: region,
        menu_id: menuId,
        name: slug,
        slug,
        ownership: 'company',
        timezone,
        stock_shortage_policy: 'allow_negative',
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
    const drawers = await h.owner
      .insertInto('cash_drawers')
      .values({ org_id: orgId, restaurant_id: r.id, code: 'till-1', name: 'Till 1' })
      .returning('id')
      .execute();
    await h.owner
      .insertInto('stock_locations')
      .values({ org_id: orgId, restaurant_id: r.id, code: 'main', name: 'Main', is_default: true })
      .execute();
    await h.owner
      .insertInto('restaurant_event_sequences')
      .values({ org_id: orgId, restaurant_id: r.id })
      .execute();
    return { id: r.id, drawers: drawers.map((d) => d.id) };
  };

  beforeAll(async () => {
    h = await startHarness();
    appDb = createDb({ connectionString: inject('appUrl'), max: 2 }).db;
    dispatcher = h.app.get(EventDispatcher);
    await buildOrg();
  });

  afterAll(async () => {
    await drain();
    await asOwnerRaw(async (tx) => {
      await sql`update event_consumer_failures set dead_at = now()
                 where org_id = ${orgId}::uuid and dead_at is null`.execute(tx);
      await sql`update drawer_sessions
                   set status = 'closed', counted_at = now(), counted_by = opened_by,
                       counted_cents = 0, expected_cents = 0, variance_cents = 0, closed_at = now()
                 where org_id = ${orgId}::uuid and status <> 'closed'`.execute(tx);
    });
    await appDb.destroy();
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
  const businessDateAt = async (rid: string, ts: string) =>
    (
      await sql<{
        d: string;
      }>`select app.business_date(${rid}::uuid, ${ts}::timestamptz)::text as d`.execute(h.owner)
    ).rows[0]!.d;

  /** Moves everything recorded at this restaurant since `since` back by whole days. */
  const shift = (rid: string, days: number, since: Date) =>
    asOwnerRaw(async (tx) => {
      const by = sql`(${days}::int * interval '1 day')`;
      const prior = sql`${days}::int`;
      await sql`update orders set placed_at = placed_at - ${by}, accepted_at = accepted_at - ${by},
                  ready_at = ready_at - ${by}, completed_at = completed_at - ${by},
                  cancelled_at = cancelled_at - ${by}, business_date = business_date - ${prior}
                where restaurant_id = ${rid}::uuid and placed_at >= ${since}`.execute(tx);
      await sql`update payments set created_at = created_at - ${by}, captured_at = captured_at - ${by}
                where restaurant_id = ${rid}::uuid and created_at >= ${since}`.execute(tx);
      await sql`update refunds set created_at = created_at - ${by}
                where restaurant_id = ${rid}::uuid and created_at >= ${since}`.execute(tx);
      await sql`update stock_movements set occurred_at = occurred_at - ${by},
                  recorded_at = recorded_at - ${by}, business_date = business_date - ${prior}
                where restaurant_id = ${rid}::uuid and occurred_at >= ${since}`.execute(tx);
      await sql`update waste_records set occurred_at = occurred_at - ${by},
                  reviewed_at = reviewed_at - ${by}, business_date = business_date - ${prior}
                where restaurant_id = ${rid}::uuid and occurred_at >= ${since}`.execute(tx);
      await sql`update stock_counts set counted_at = counted_at - ${by},
                  business_date = business_date - ${prior}
                where restaurant_id = ${rid}::uuid and counted_at >= ${since}`.execute(tx);
      await sql`update goods_receipts set received_at = received_at - ${by},
                  business_date = business_date - ${prior}
                where restaurant_id = ${rid}::uuid and received_at >= ${since}`.execute(tx);
      await sql`update outbox_events set occurred_at = occurred_at - ${by}
                where restaurant_id = ${rid}::uuid and occurred_at >= ${since}`.execute(tx);
    });

  /** Re-times one finished, undispatched order (and its payment and consumption) to an instant. */
  const retimeOrder = (rid: string, orderId: string, instant: string) =>
    asOwnerRaw(async (tx) => {
      const at = sql`${instant}::timestamptz`;
      const day = sql`app.business_date(${rid}::uuid, ${instant}::timestamptz)`;
      await sql`update orders set placed_at = ${at}, accepted_at = ${at}, ready_at = ${at},
                  completed_at = ${at}, business_date = ${day}
                where id = ${orderId}::uuid`.execute(tx);
      await sql`update payments set created_at = ${at}, captured_at = ${at}
                where order_id = ${orderId}::uuid`.execute(tx);
      await sql`update stock_movements m set occurred_at = ${at}, recorded_at = ${at},
                  business_date = ${day}
                from order_lines l where l.id = m.source_id and l.order_id = ${orderId}::uuid`.execute(
        tx,
      );
      await sql`update outbox_events set occurred_at = ${at}
                where aggregate_id = ${orderId}::uuid`.execute(tx);
    });

  const noon = (day: string) => sql<Date>`((${day}::date + time '12:00') at time zone 'UTC')`;

  const report = async (rid: string, from: string, to: string, token = tokens.manager) => {
    const res = await h.http
      .get(`${api(rid)}/reports/food-cost?from=${from}&to=${to}`)
      .set(bearer(token));
    if (res.status !== 200) throw new Error(`report ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as FoodCostReport;
  };
  const dayRow = async (rid: string, day: string) => (await report(rid, day, day)).days[0]!;
  const figures = (r: Figures): Figures => ({
    netSalesCents: r.netSalesCents,
    cogsCents: r.cogsCents,
    wasteCents: r.wasteCents,
    stockVarianceCents: r.stockVarianceCents,
  });
  const diff = (a: Figures, b: Figures): Figures => ({
    netSalesCents: b.netSalesCents - a.netSalesCents,
    cogsCents: b.cogsCents - a.cogsCents,
    wasteCents: b.wasteCents - a.wasteCents,
    stockVarianceCents: b.stockVarianceCents - a.stockVarianceCents,
  });
  const fig = (
    netSalesCents: number,
    cogsCents: number,
    wasteCents = 0,
    stockVarianceCents = 0,
  ) => ({
    netSalesCents,
    cogsCents,
    wasteCents,
    stockVarianceCents,
  });
  /** Basis points, half away from zero, null without positive sales (computed separately here). */
  const bps = (cost: number, sales: number): number | null => {
    if (sales <= 0) return null;
    const exact = (Math.abs(cost) * 10_000) / sales;
    const whole = Math.floor(exact);
    const rounded = exact - whole >= 0.5 ? whole + 1 : whole;
    return cost < 0 ? -rounded : rounded;
  };
  const dayView = async (rid: string, day: string, token = tokens.manager) =>
    (
      await h.http
        .get(`${api(rid)}/days/${day}`)
        .set(bearer(token))
        .expect(200)
    ).body as DayCloseView;

  /**
   * One business day's figures from source rows only: completed orders and refunds,
   * stock movement values, and the already-consumed share of waste records.
   */
  const fromSources = async (rid: string, day: string): Promise<Figures> => {
    const n = (v: unknown) => Number(v ?? 0);
    const orders = (
      await sql<{ total: string; tax: string }>`
        select total_cents as total, tax_cents as tax from orders
         where restaurant_id = ${rid}::uuid and status = 'completed'
           and app.business_date(restaurant_id, completed_at) = ${day}::date`.execute(h.owner)
    ).rows;
    const refunds = (
      await sql<{
        amount: string;
        before: string;
        treatment: string;
        total: string;
        tax: string;
      }>`
        select f.amount_cents as amount, f.refunded_before_cents as before, f.treatment,
               o.total_cents as total, o.tax_cents as tax
          from refunds f join orders o on o.id = f.order_id
         where f.restaurant_id = ${rid}::uuid
           and app.business_date(f.restaurant_id, f.created_at) = ${day}::date`.execute(h.owner)
    ).rows;
    let sales = orders.reduce((s, o) => s + n(o.total) - n(o.tax), 0);
    for (const f of refunds) {
      if (f.treatment !== 'sales_return') continue;
      const share = (c: number) => Math.floor((c * n(f.tax)) / n(f.total) + 0.5);
      const gst = share(n(f.before) + n(f.amount)) - share(n(f.before));
      sales -= n(f.amount) - gst;
    }
    const mv = (
      await sql<{ consumed: string; wasted: string; counted: string }>`
        select coalesce(sum(value_cents) filter (where movement_type = 'production_consumption'), 0) as consumed,
               coalesce(sum(value_cents) filter (where source_type in ('waste_record', 'waste_reversal')), 0) as wasted,
               coalesce(sum(value_cents) filter (where movement_type = 'count_adjustment'), 0) as counted
          from stock_movements
         where restaurant_id = ${rid}::uuid and business_date = ${day}::date`.execute(h.owner)
    ).rows[0]!;
    const reclass = (
      await sql<{ recorded: string; rejected: string }>`
        select coalesce(sum(l.cost_cents) filter (where w.business_date = ${day}::date), 0) as recorded,
               coalesce(sum(l.cost_cents) filter (where w.status = 'rejected'
                 and app.business_date(w.restaurant_id, w.reviewed_at) = ${day}::date), 0) as rejected
          from waste_records w join waste_record_lines l on l.waste_record_id = w.id
         where w.restaurant_id = ${rid}::uuid and l.treatment = 'already_consumed'`.execute(h.owner)
    ).rows[0]!;
    const z = (v: number) => v + 0; // no -0
    return {
      netSalesCents: z(sales),
      cogsCents: z(-n(mv.consumed) - n(reclass.recorded) + n(reclass.rejected)),
      wasteCents: z(-n(mv.wasted) + n(reclass.recorded) - n(reclass.rejected)),
      stockVarianceCents: z(-n(mv.counted)),
    };
  };

  // Staff flows, all through the real API.

  const ring = async (
    rid: string,
    token: string,
    names: (keyof typeof items)[],
  ): Promise<{ id: string; totalCents: number; taxCents: number; cashDueCents: number }> => {
    const res = await h.http
      .post(`${api(rid)}/orders`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({
        fulfilmentType: 'dine_in',
        lines: names.map((n) => ({ menuItemId: items[n], quantity: 1 })),
      });
    if (res.status !== 201) throw new Error(`ring ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const pay = async (rid: string, token: string, orderId: string, tender: object) => {
    const res = await h.http
      .post(`${api(rid)}/orders/${orderId}/payments`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send(tender);
    if (res.status !== 200) throw new Error(`pay ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const CARD = { method: 'card', paymentToken: 'tok_sandbox_approve' };
  const CASH = { method: 'cash', tenderedCents: 5000 };
  const tasksOf = (orderId: string) =>
    h.owner
      .selectFrom('kitchen_tasks')
      .select(['id', 'order_line_id'])
      .where('order_id', '=', orderId)
      .execute();
  const startTask = (rid: string, taskId: string, token = tokens.crew) =>
    h.http
      .post(`${api(rid)}/kitchen/tasks/${taskId}/start`)
      .set(bearer(token))
      .send({})
      .expect(200);
  const completeTasks = async (rid: string, orderId: string, token = tokens.supervisor) => {
    for (const t of await tasksOf(orderId)) {
      await h.http
        .post(`${api(rid)}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(token))
        .send({})
        .expect(200);
    }
  };
  const handoff = (rid: string, orderId: string, token = tokens.supervisor) =>
    h.http
      .post(`${api(rid)}/orders/${orderId}/handoff`)
      .set(bearer(token))
      .expect(200);
  const finish = async (rid: string, orderId: string) => {
    await completeTasks(rid, orderId);
    await handoff(rid, orderId);
  };
  // Money only unless a test says otherwise: these tests pin money and cost, and a quality refund
  // would otherwise also record the food as waste (Milestone 14).
  const refund = (rid: string, token: string, orderId: string, body: object) =>
    h.http
      .post(`${api(rid)}/orders/${orderId}/refunds`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ waste: [], ...body });
  const recordWaste = (rid: string, token: string, body: object) =>
    h.http
      .post(`${api(rid)}/inventory/waste`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const onHand = async (rid: string, itemId: string) => {
    const row = await h.owner
      .selectFrom('stock_balances as b')
      .innerJoin('stock_locations as l', 'l.id', 'b.location_id')
      .select('b.on_hand')
      .where('l.restaurant_id', '=', rid)
      .where('b.inventory_item_id', '=', itemId)
      .executeTakeFirst();
    return Number(row?.on_hand ?? 0);
  };
  const count = async (rid: string, itemId: string, counted: number, token = tokens.manager) => {
    const res = await h.http
      .post(`${api(rid)}/inventory/counts`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ lines: [{ inventoryItemId: itemId, counted: counted.toFixed(3) }] });
    if (res.status !== 201) throw new Error(`count ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; varianceCents: number };
  };
  const movementValue = async (where: {
    sourceType?: string;
    sourceIds: string[];
    movementType?: string;
  }) => {
    let q = h.owner
      .selectFrom('stock_movements')
      .select(sql<string>`coalesce(sum(value_cents), 0)`.as('v'))
      .where('source_id', 'in', where.sourceIds);
    if (where.sourceType) q = q.where('source_type', '=', where.sourceType);
    if (where.movementType) q = q.where('movement_type', '=', where.movementType);
    return Number((await q.executeTakeFirstOrThrow()).v);
  };
  const lineIds = async (orderId: string) =>
    (
      await h.owner.selectFrom('order_lines').select('id').where('order_id', '=', orderId).execute()
    ).map((l) => l.id);
  const orderRow = (orderId: string) =>
    h.owner
      .selectFrom('orders')
      .select(['total_cents', 'tax_cents', 'subtotal_cents', 'discount_cents', 'status'])
      .where('id', '=', orderId)
      .executeTakeFirstOrThrow();
  /** Net sales (ex GST) of one order, and its consumption value, from source rows. */
  const orderSource = async (orderId: string) => {
    const o = await orderRow(orderId);
    return {
      netSales: Number(o.total_cents) - Number(o.tax_cents),
      consumed: -(await movementValue({
        sourceType: 'order_line',
        sourceIds: await lineIds(orderId),
        movementType: 'production_consumption',
      })),
    };
  };

  // --------------------------------------------- 1. a realistic day, scenario by scenario

  describe('1. a realistic day in Sydney, each operation traced to where its cost lands', () => {
    let r: Rest;
    let day: string;

    /** Runs `act`, dispatches, and returns how today's report row moved. */
    const step = async (act: () => Promise<void>) => {
      await drain();
      const before = figures(await dayRow(r.id, day));
      await act();
      await drain();
      const after = figures(await dayRow(r.id, day));
      return diff(before, after);
    };

    beforeAll(async () => {
      r = await newRestaurant('Australia/Sydney');
      day = await today(r.id);
      const receipt = await h.http
        .post(`${api(r.id)}/inventory/receipts`)
        .set(bearer(tokens.manager))
        .set('Idempotency-Key', randomUUID())
        .send({
          lines: [
            { inventoryItemId: skus.bun, quantity: '100' },
            { inventoryItemId: skus.cup, quantity: '50' },
          ],
        });
      expect(receipt.status).toBe(201);
      const s = await h.http
        .post(`${api(r.id)}/cash/drawers/${r.drawers[0]}/sessions`)
        .set(bearer(tokens.supervisor))
        .send({ openingFloatCents: 10_000 });
      expect(s.status).toBe(201); // closed by the file's afterAll, in this throwaway tenant
      await drain();
    });

    it('a goods receipt moves nothing on the report', async () => {
      expect(figures(await dayRow(r.id, day))).toEqual(fig(0, 0));
    });

    it('card sale: net sales ex GST and its recipe cost', async () => {
      let id = '';
      const d = await step(async () => {
        const o = await ring(r.id, tokens.supervisor, ['burger']);
        id = o.id;
        await pay(r.id, tokens.supervisor, o.id, CARD);
        await finish(r.id, o.id);
      });
      const src = await orderSource(id);
      expect(d).toEqual(fig(src.netSales, src.consumed));
      expect(d).toEqual(fig(1000, 40));
    });

    it('cash sale rounded up 2c: rounding is not sales', async () => {
      let id = '';
      const d = await step(async () => {
        const o = await ring(r.id, tokens.supervisor, ['odd']);
        id = o.id;
        expect(o.cashDueCents).toBe(1105);
        await pay(r.id, tokens.supervisor, o.id, CASH);
        await finish(r.id, o.id);
      });
      const p = await h.owner
        .selectFrom('payments')
        .select(['amount_cents', 'cash_rounding_cents'])
        .where('order_id', '=', id)
        .executeTakeFirstOrThrow();
      expect(Number(p.cash_rounding_cents)).toBe(2);
      const src = await orderSource(id);
      expect(d).toEqual(fig(src.netSales, src.consumed));
      expect(d).toEqual(fig(1103 - 100, 40));
    });

    it('10% discount, paid cash (rounded down): net sales are the discounted total ex GST', async () => {
      let id = '';
      const d = await step(async () => {
        const o = await ring(r.id, tokens.supervisor, ['burger', 'cola']);
        id = o.id;
        const res = await h.http
          .post(`${api(r.id)}/orders/${o.id}/discount`)
          .set(bearer(tokens.supervisor))
          .set('Idempotency-Key', randomUUID())
          .send({ kind: 'percent', value: 1000, reason: 'customer_service' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ totalCents: 1287, cashDueCents: 1285 });
        await pay(r.id, tokens.supervisor, o.id, CASH);
        await finish(r.id, o.id);
      });
      const src = await orderSource(id);
      expect(d).toEqual(fig(src.netSales, src.consumed));
      expect(d).toEqual(fig(1287 - 117, 55));
    });

    it('comp (100% complimentary): no net sales, full recipe cost', async () => {
      let id = '';
      const d = await step(async () => {
        const o = await ring(r.id, tokens.supervisor, ['burger']);
        id = o.id;
        const res = await h.http
          .post(`${api(r.id)}/orders/${o.id}/discount`)
          .set(bearer(tokens.supervisor))
          .set('Idempotency-Key', randomUUID())
          .send({ kind: 'percent', value: 10_000, reason: 'complimentary' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ totalCents: 0, status: 'accepted' });
        await finish(r.id, o.id);
      });
      const o = await orderRow(id);
      expect(o).toMatchObject({ status: 'completed' });
      expect(Number(o.total_cents)).toBe(0);
      expect(d).toEqual(fig(0, (await orderSource(id)).consumed));
      expect(d).toEqual(fig(0, 40));
    });

    it('meal combo: one sale, the cost of both components', async () => {
      let id = '';
      const d = await step(async () => {
        const o = await ring(r.id, tokens.supervisor, ['meal']);
        id = o.id;
        expect(o.totalCents).toBe(1250);
        await pay(r.id, tokens.supervisor, o.id, CARD);
        await finish(r.id, o.id);
      });
      const src = await orderSource(id);
      expect(d).toEqual(fig(src.netSales, src.consumed));
      expect(d).toEqual(fig(1250 - 114, 55));
    });

    it('partial refund of a handed-over order: a sales return ex GST, cost unchanged', async () => {
      let id = '';
      const d = await step(async () => {
        const o = await ring(r.id, tokens.supervisor, ['burger']);
        id = o.id;
        await pay(r.id, tokens.supervisor, o.id, CARD);
        await finish(r.id, o.id);
        const res = await refund(r.id, tokens.supervisor, o.id, {
          amountCents: 100,
          reason: 'quality',
        });
        expect(res.status).toBe(201);
      });
      const f = await h.owner
        .selectFrom('refunds')
        .select(['treatment', 'amount_cents'])
        .where('order_id', '=', id)
        .executeTakeFirstOrThrow();
      expect(f.treatment).toBe('sales_return');
      const src = await orderSource(id);
      // GST share of 100 out of 1100 with 100 GST: 9.09 -> 9.
      expect(d).toEqual(fig(src.netSales - (100 - 9), src.consumed));
      expect(d).toEqual(fig(909, 40));
    });

    let cancelledLine = '';
    it('cancelled after preparation and refunded: no sale, and its cost sits in recipe cost', async () => {
      let id = '';
      const d = await step(async () => {
        const o = await ring(r.id, tokens.supervisor, ['burger']);
        id = o.id;
        await pay(r.id, tokens.supervisor, o.id, CARD);
        const [task] = await tasksOf(o.id);
        cancelledLine = task!.order_line_id;
        await startTask(r.id, task!.id);
        await h.http
          .post(`${api(r.id)}/orders/${o.id}/cancel`)
          .set(bearer(tokens.manager))
          // Recorded by hand in the next step: cancel without recording it.
          .send({
            reason: 'customer walked out',
            waste: [{ orderLineId: cancelledLine, quantity: 0 }],
          })
          .expect(200);
        expect(
          (await refund(r.id, tokens.supervisor, o.id, { reason: 'cancelled_order' })).status,
        ).toBe(201);
      });
      const f = await h.owner
        .selectFrom('refunds')
        .select('treatment')
        .where('order_id', '=', id)
        .executeTakeFirstOrThrow();
      expect(f.treatment).toBe('deposit_release');
      // Documented (PROGRESS.md "Cancel-after-preparation does not record its waste
      // automatically"): until someone records the waste, food that was never sold is
      // reported as recipe cost, which inflates the theoretical food cost percentage.
      expect(d).toEqual(fig(0, (await orderSource(id)).consumed));
      expect(d).toEqual(fig(0, 40));
    });

    it('recording that cancelled food as waste reclassifies it: recipe cost down, waste up', async () => {
      let wasteId = '';
      const d = await step(async () => {
        const w = await recordWaste(r.id, tokens.crew, {
          kind: 'prepared_item',
          orderLineId: cancelledLine,
          quantity: 1,
          reason: 'cancelled_prepared_order',
        });
        expect(w.status).toBe(201);
        wasteId = w.body.id;
        expect(w.body.lines.map((l: { treatment: string }) => l.treatment)).toEqual([
          'already_consumed',
        ]);
      });
      const reclass = await h.owner
        .selectFrom('waste_record_lines')
        .select(sql<string>`sum(cost_cents)`.as('c'))
        .where('waste_record_id', '=', wasteId)
        .executeTakeFirstOrThrow();
      expect(await movementValue({ sourceType: 'waste_record', sourceIds: [wasteId] })).toBe(0);
      expect(d).toEqual(fig(0, -Number(reclass.c), Number(reclass.c)));
      expect(d).toEqual(fig(0, -40, 40));
    });

    it('a sold item burnt and remade: one portion in recipe cost, one in waste', async () => {
      let id = '';
      let wasteId = '';
      const d = await step(async () => {
        const o = await ring(r.id, tokens.supervisor, ['burger']);
        id = o.id;
        await pay(r.id, tokens.supervisor, o.id, CARD);
        await completeTasks(r.id, o.id);
        const [task] = await tasksOf(o.id);
        const w = await recordWaste(r.id, tokens.crew, {
          kind: 'prepared_item',
          orderLineId: task!.order_line_id,
          quantity: 1,
          reason: 'burnt',
          remake: true,
        });
        expect(w.status).toBe(201);
        expect(w.body.remake).toBe(true);
        wasteId = w.body.id;
        await handoff(r.id, o.id);
      });
      const src = await orderSource(id); // includes the remake portion
      const reclass = await h.owner
        .selectFrom('waste_record_lines')
        .select(sql<string>`sum(cost_cents)`.as('c'))
        .where('waste_record_id', '=', wasteId)
        .where('treatment', '=', 'already_consumed')
        .executeTakeFirstOrThrow();
      expect(src.consumed).toBe(80);
      expect(d).toEqual(fig(src.netSales, src.consumed - Number(reclass.c), Number(reclass.c)));
      expect(d).toEqual(fig(1000, 40, 40));
    });

    it('raw waste raises waste; its rejection takes it back out the same day', async () => {
      let wasteId = '';
      const first = await step(async () => {
        const w = await recordWaste(r.id, tokens.crew, {
          kind: 'raw_ingredient',
          inventoryItemId: skus.bun,
          quantity: '2',
          reason: 'spoiled',
        });
        expect(w.status).toBe(201);
        expect(w.body.status).toBe('recorded');
        wasteId = w.body.id;
      });
      expect(first).toEqual(
        fig(0, 0, -(await movementValue({ sourceType: 'waste_record', sourceIds: [wasteId] }))),
      );
      expect(first).toEqual(fig(0, 0, 80));
      const second = await step(async () => {
        await h.http
          .post(`${api(r.id)}/inventory/waste/${wasteId}/reject`)
          .set(bearer(tokens.manager))
          .send({ reason: 'Not actually spoiled' })
          .expect(200);
      });
      expect(second).toEqual(
        fig(0, 0, -(await movementValue({ sourceType: 'waste_reversal', sourceIds: [wasteId] }))),
      );
      expect(second).toEqual(fig(0, 0, -80));
    });

    it('a count that finds less is variance; one that finds more is a negative variance', async () => {
      let lessId = '';
      let moreId = '';
      const less = await step(async () => {
        lessId = (await count(r.id, skus.bun, (await onHand(r.id, skus.bun)) - 1)).id;
      });
      expect(less).toEqual(
        fig(0, 0, 0, -(await movementValue({ sourceType: 'stock_count', sourceIds: [lessId] }))),
      );
      expect(less).toEqual(fig(0, 0, 0, 40));
      const more = await step(async () => {
        moreId = (await count(r.id, skus.cup, (await onHand(r.id, skus.cup)) + 2)).id;
      });
      expect(more).toEqual(
        fig(0, 0, 0, -(await movementValue({ sourceType: 'stock_count', sourceIds: [moreId] }))),
      );
      expect(more).toEqual(fig(0, 0, 0, -30));
    });

    it('the whole day equals the source rows, the day close preview and its own arithmetic', async () => {
      await drain();
      const row = await dayRow(r.id, day);
      const src = await fromSources(r.id, day);
      // Sum of the steps above.
      expect(src).toEqual(
        fig(
          1000 + 1003 + 1170 + 0 + 1136 + 909 + 0 + 1000,
          40 + 40 + 55 + 40 + 55 + 40 + 40 - 40 + 40,
          40 + 40,
          10,
        ),
      );
      expect(figures(row)).toEqual(src);
      const v = await dayView(r.id, day);
      expect(v.totals).not.toBeNull();
      expect(figures(row)).toEqual({
        netSalesCents: v.totals!.netSalesCents,
        cogsCents: v.totals!.cogsCents,
        wasteCents: v.totals!.wasteCents,
        stockVarianceCents: v.totals!.stockVarianceCents,
      });
      const actual = src.cogsCents + src.wasteCents + src.stockVarianceCents;
      expect(row).toMatchObject({
        businessDate: day,
        closed: false,
        actualFoodCostCents: actual,
        grossProfitCents: src.netSalesCents - actual,
        cogsBps: bps(src.cogsCents, src.netSalesCents),
        actualFoodCostBps: bps(actual, src.netSalesCents),
      });
      // The auditor and the area manager of this region see exactly the same.
      expect(await dayRow(r.id, day)).toEqual(row);
      expect((await report(r.id, day, day, tokens.auditor)).days[0]).toEqual(row);
      expect((await report(r.id, day, day, tokens.area)).days[0]).toEqual(row);
    });
  });

  // ------------------------------------------- 2. refunds only, waste only, totals

  describe('2. a refund-only day, a waste-only day, and range totals', () => {
    let r: Rest;
    let A: string;
    let B: string;
    let C: string;
    let rep: FoodCostReport;

    beforeAll(async () => {
      r = await newRestaurant();
      const t = await today(r.id);
      A = await addDays(t, -62);
      B = await addDays(t, -61);
      C = await addDays(t, -60);
      const s1 = await dbNow();
      const o = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      await finish(r.id, o.id);
      await shift(r.id, 62, s1);
      const s2 = await dbNow();
      expect((await refund(r.id, tokens.supervisor, o.id, { reason: 'quality' })).status).toBe(201);
      await shift(r.id, 61, s2);
      const s3 = await dbNow();
      const w = await recordWaste(r.id, tokens.crew, {
        kind: 'raw_ingredient',
        inventoryItemId: skus.bun,
        quantity: '2',
        reason: 'dropped',
      });
      expect(w.status).toBe(201);
      await shift(r.id, 60, s3);
      await drain();
      rep = await report(r.id, A, C);
    });

    it('each day equals its source rows', async () => {
      expect(rep.days.map((d) => d.businessDate)).toEqual([A, B, C]);
      for (const d of rep.days) expect(figures(d)).toEqual(await fromSources(r.id, d.businessDate));
      expect(rep.days.map(figures)).toEqual([fig(1000, 40), fig(-1000, 0), fig(0, 0, 80)]);
    });

    it('a refund-only day has negative net sales, a negative margin and no percentage', () => {
      expect(rep.days[1]).toMatchObject({
        netSalesCents: -1000,
        actualFoodCostCents: 0,
        grossProfitCents: -1000,
        cogsBps: null,
        actualFoodCostBps: null,
      });
    });

    it('a day with waste and no sales has a negative margin and no percentage', () => {
      expect(rep.days[2]).toMatchObject({
        netSalesCents: 0,
        actualFoodCostCents: 80,
        grossProfitCents: -80,
        cogsBps: null,
        actualFoodCostBps: null,
      });
    });

    it('totals are the summed figures, with no percentage when summed sales are zero', () => {
      expect(rep.totals).toEqual({
        netSalesCents: 0,
        cogsCents: 40,
        wasteCents: 80,
        stockVarianceCents: 0,
        actualFoodCostCents: 120,
        grossProfitCents: -120,
        cogsBps: null,
        actualFoodCostBps: null,
        grossMarginBps: null,
        // The burger was sold on A; its refund on B was by amount, which names no items, so it
        // does not reduce recipe cost of sales (only refunds by item do).
        soldRecipeCents: 40,
        theoreticalFoodCostBps: null,
        unsoldProductionCents: 0,
      });
      // The first day on its own still has a percentage: 40/1000.
      expect(rep.days[0]).toMatchObject({ cogsBps: 400, actualFoodCostBps: 400 });
    });

    it('totals over a sub-range come from summed cents, not averaged percentages', async () => {
      const ab = await report(r.id, A, B);
      expect(ab.totals).toMatchObject({
        netSalesCents: 0,
        cogsCents: 40,
        cogsBps: null,
      });
    });
  });

  // ---------------------------------------------------- 3. percentage boundaries

  describe('3. percentage boundaries through real sales', () => {
    it('half a basis point rounds up: 1c of cost on 200.00 of sales is 1 bp', async () => {
      const r = await newRestaurant();
      const o = await ring(r.id, tokens.supervisor, ['big']);
      expect(o.totalCents).toBe(22_000);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      await finish(r.id, o.id);
      await drain();
      const day = await today(r.id);
      const row = await dayRow(r.id, day);
      expect(figures(row)).toEqual(await fromSources(r.id, day));
      expect(row).toMatchObject({
        netSalesCents: 20_000,
        cogsCents: 1,
        cogsBps: 1,
        actualFoodCostBps: 1,
        grossProfitCents: 19_999,
      });

      // A count that finds 2c more stock than the books: actual cost -1c, -0.5 bp.
      const counted = await count(r.id, skus.pin1, (await onHand(r.id, skus.pin1)) + 2);
      expect(counted.varianceCents).toBe(2);
      await drain();
      const after = await dayRow(r.id, day);
      expect(figures(after)).toEqual(await fromSources(r.id, day));
      expect(after).toMatchObject({
        stockVarianceCents: -2,
        actualFoodCostCents: -1,
        grossProfitCents: 20_001,
        cogsBps: 1,
        // Rounded half away from zero (divRoundHalfUp), so -0.5 bp is -1, not 0.
        actualFoodCostBps: -1,
      });
    });

    it('just under half a basis point rounds down: 1c on 200.01 is 0 bp', async () => {
      const r = await newRestaurant();
      const o = await ring(r.id, tokens.supervisor, ['big1']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      await finish(r.id, o.id);
      await drain();
      const row = await dayRow(r.id, await today(r.id));
      expect(row).toMatchObject({
        netSalesCents: 20_001,
        cogsCents: 1,
        cogsBps: 0,
        actualFoodCostBps: 0,
      });
    });

    it('1.5 bp rounds up to 2', async () => {
      const r = await newRestaurant();
      const o = await ring(r.id, tokens.supervisor, ['big3']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      await finish(r.id, o.id);
      await drain();
      const row = await dayRow(r.id, await today(r.id));
      expect(row).toMatchObject({
        netSalesCents: 20_000,
        cogsCents: 3,
        cogsBps: 2,
        actualFoodCostBps: 2,
      });
    });

    it('the domain rule on its own: exact integers, null at zero and negative sales', () => {
      expect(foodCost(fig(20_000, 1)).cogsBps).toBe(1);
      expect(foodCost(fig(20_001, 1)).cogsBps).toBe(0);
      expect(foodCost(fig(1, 0)).cogsBps).toBe(0);
      expect(foodCost(fig(0, 10)).cogsBps).toBeNull();
      expect(foodCost(fig(-5, 10)).actualFoodCostBps).toBeNull();
      expect(foodCost(fig(3, 1)).cogsBps).toBe(3333);
      expect(foodCost(fig(3, 2)).cogsBps).toBe(6667);
      // Large figures stay exact (bigint): 9 trillion cents of sales.
      expect(foodCost(fig(9_000_000_000_000, 4_500_000_000)).cogsBps).toBe(5);
      expect(foodCost(fig(9_000_000_000_000, 450_000_000)).cogsBps).toBe(1);
      expect(() => foodCost(fig(1.5, 0))).toThrow();
    });
  });

  // -------------------------------------- 4. an entry moved late from a closed day

  describe('4. an entry that arrives after its day closed (ADR-0017)', () => {
    let r: Rest;
    let D: string;
    let t: string;
    let lateOrder: string;
    let onTimeOrder: string;
    let rep: FoodCostReport;

    beforeAll(async () => {
      r = await newRestaurant();
      t = await today(r.id);
      D = await addDays(t, -60);
      const since = await dbNow();
      // Cooked on D (cost booked on D), handed over only after D closed.
      const late = await ring(r.id, tokens.supervisor, ['burger']);
      lateOrder = late.id;
      await pay(r.id, tokens.supervisor, late.id, CARD);
      await completeTasks(r.id, late.id);
      // An ordinary sale on D.
      const onTime = await ring(r.id, tokens.supervisor, ['burger']);
      onTimeOrder = onTime.id;
      await pay(r.id, tokens.supervisor, onTime.id, CARD);
      await finish(r.id, onTime.id);
      await shift(r.id, 60, since);
      await drain();
      const closed = await h.http
        .post(`${api(r.id)}/days/${D}/close`)
        .set(bearer(tokens.manager))
        .send({});
      expect(closed.status).toBe(200);
      // The handover transaction straddled the close: its sale is dated D.
      await handoff(r.id, late.id);
      await asOwnerRaw(async (tx) => {
        await sql`update orders set completed_at = ${noon(D)} where id = ${late.id}::uuid`.execute(
          tx,
        );
        await sql`update outbox_events set occurred_at = ${noon(D)}
                  where event_type = 'order.completed' and aggregate_id = ${late.id}::uuid`.execute(
          tx,
        );
      });
      await drain();
      rep = await report(r.id, D, t);
    });

    it('the late sale posts on the first open day, marked as late from D', async () => {
      const e = await h.owner
        .selectFrom('journal_entries')
        .select([
          sql<string>`business_date::text`.as('business_date'),
          sql<string | null>`posted_late_from::text`.as('late'),
        ])
        .where('source_id', '=', lateOrder)
        .where('entry_type', '=', 'sale_recognition')
        .executeTakeFirstOrThrow();
      expect(e).toEqual({ business_date: t, late: D });
      const failures = await h.owner
        .selectFrom('event_consumer_failures as f')
        .innerJoin('outbox_events as o', 'o.id', 'f.event_id')
        .select('o.event_type')
        .where('o.restaurant_id', '=', r.id)
        .execute();
      expect(failures).toEqual([]);
    });

    it('which day shows it: D keeps its closed figures, today carries the late revenue', () => {
      const first = rep.days[0]!;
      const last = rep.days[rep.days.length - 1]!;
      expect(rep.days).toHaveLength(61);
      expect(first).toMatchObject({ businessDate: D, closed: true });
      expect(figures(first)).toEqual(fig(1000, 80));
      expect(last).toMatchObject({ businessDate: t, closed: false });
      expect(figures(last)).toEqual(fig(1000, 0));
      // Documented consequence: D's food cost reads 8% and today's 0%, because the
      // late sale's revenue moved but the cost of cooking it stayed on D.
      expect(first.cogsBps).toBe(800);
      expect(last.cogsBps).toBe(0);
    });

    it('the closed day equals its stored snapshot', async () => {
      const v = await dayView(r.id, D);
      expect(v.status).toBe('closed');
      expect(figures(rep.days[0]!)).toEqual({
        netSalesCents: v.totals!.netSalesCents,
        cogsCents: v.totals!.cogsCents,
        wasteCents: v.totals!.wasteCents,
        stockVarianceCents: v.totals!.stockVarianceCents,
      });
    });

    it('every day of the range agrees with the day close figures', async () => {
      const mismatches: unknown[] = [];
      for (const d of rep.days) {
        const v = await dayView(r.id, d.businessDate);
        const close = {
          netSalesCents: v.totals!.netSalesCents,
          cogsCents: v.totals!.cogsCents,
          wasteCents: v.totals!.wasteCents,
          stockVarianceCents: v.totals!.stockVarianceCents,
        };
        if (JSON.stringify(close) !== JSON.stringify(figures(d))) {
          mismatches.push({ day: d.businessDate, report: figures(d), close });
        }
        expect(d.closed).toBe(v.status === 'closed');
      }
      expect(mismatches).toEqual([]);
      expect(rep.totals).toMatchObject({ netSalesCents: 2000, cogsCents: 80 });
    });

    it('the source rows put both sales on D: only the late one differs, by design', async () => {
      expect(await fromSources(r.id, D)).toEqual(fig(2000, 80));
      expect((await orderRow(onTimeOrder)).status).toBe('completed');
    });
  });

  // ---------------------------------------------------------------- 5. ranges

  describe('5. ranges', () => {
    let r: Rest;
    let t: string;
    const get = (rid: string, qs: string, token = tokens.manager) =>
      h.http.get(`${api(rid)}/reports/food-cost?${qs}`).set(bearer(token));

    beforeAll(async () => {
      r = await newRestaurant('Australia/Sydney');
      t = await today(r.id);
    });

    it('92 days inclusive is allowed, 93 is refused', async () => {
      const ok = await get(r.id, `from=${await addDays(t, -91)}&to=${t}`);
      expect(ok.status).toBe(200);
      expect((ok.body as FoodCostReport).days).toHaveLength(92);
      expect((await get(r.id, `from=${await addDays(t, -92)}&to=${t}`)).status).toBe(400);
      // Across a leap day too.
      const leap = await get(r.id, 'from=2028-01-01&to=2028-04-01');
      expect(leap.status).toBe(200);
      expect((leap.body as FoodCostReport).days).toHaveLength(92);
      expect((await get(r.id, 'from=2028-01-01&to=2028-04-02')).status).toBe(400);
    });

    it('from after to, invalid or malformed dates, and missing or repeated params are 400', async () => {
      const bad = [
        `from=${t}&to=${await addDays(t, -1)}`,
        'from=2026-02-30&to=2026-03-01',
        'from=2026-02-29&to=2026-03-01',
        'from=2026-13-01&to=2026-13-02',
        'from=2026-1-1&to=2026-01-02',
        'from=20260101&to=20260102',
        'from=today&to=today',
        'from=2026-01-01T00:00:00Z&to=2026-01-02',
        'from=0000-01-01&to=0000-01-02',
        `from=${t}`,
        `to=${t}`,
        '',
        `from=${t}&from=${t}&to=${t}`,
        `from=${t}'--&to=${t}`,
      ];
      const got = [];
      for (const qs of bad) got.push([qs, (await get(r.id, qs)).status]);
      expect(got).toEqual(bad.map((qs) => [qs, 400]));
    });

    it('the far past and far future return empty days, not errors', async () => {
      const past = await get(r.id, 'from=0001-01-01&to=0001-01-31');
      expect(past.status).toBe(200);
      expect((past.body as FoodCostReport).days).toHaveLength(31);
      expect((past.body as FoodCostReport).days[0]!.businessDate).toBe('0001-01-01');
      const future = await get(r.id, 'from=9999-10-01&to=9999-12-31');
      expect(future.status).toBe(200);
      const days = (future.body as FoodCostReport).days;
      expect(days).toHaveLength(92);
      expect(days[days.length - 1]!.businessDate).toBe('9999-12-31');
      expect((future.body as FoodCostReport).totals).toMatchObject({
        netSalesCents: 0,
        cogsBps: null,
      });
    });

    it('across both Sydney DST changes: every calendar day once, sales on the right business day', async () => {
      // DST ends 2026-04-05 03:00 AEDT (16:00Z on the 4th); starts 2026-10-04 02:00 AEST (16:00Z on the 3rd).
      // Business day 04-04 runs 25 hours (17:00Z on the 3rd to 18:00Z on the 4th); 10-03 runs 23.
      const sales: [string, string][] = [
        ['2026-04-03T17:00:00Z', '2026-04-04'],
        ['2026-04-04T17:59:59Z', '2026-04-04'],
        ['2026-04-04T18:00:00Z', '2026-04-05'],
        ['2026-10-02T18:00:00Z', '2026-10-03'],
        ['2026-10-03T16:59:59Z', '2026-10-03'],
        ['2026-10-03T17:00:00Z', '2026-10-04'],
      ];
      for (const [instant, expected] of sales) {
        expect([instant, await businessDateAt(r.id, instant)]).toEqual([instant, expected]);
      }
      for (const [instant] of sales) {
        const o = await ring(r.id, tokens.supervisor, ['burger']);
        await pay(r.id, tokens.supervisor, o.id, CARD);
        await finish(r.id, o.id);
        await retimeOrder(r.id, o.id, instant);
      }
      await drain();
      const april = await report(r.id, '2026-04-02', '2026-04-06');
      expect(april.days.map((d) => [d.businessDate, d.netSalesCents, d.cogsCents])).toEqual([
        ['2026-04-02', 0, 0],
        ['2026-04-03', 0, 0],
        ['2026-04-04', 2000, 80],
        ['2026-04-05', 1000, 40],
        ['2026-04-06', 0, 0],
      ]);
      const october = await report(r.id, '2026-10-01', '2026-10-05');
      expect(october.days.map((d) => [d.businessDate, d.netSalesCents, d.cogsCents])).toEqual([
        ['2026-10-01', 0, 0],
        ['2026-10-02', 0, 0],
        ['2026-10-03', 2000, 80],
        ['2026-10-04', 1000, 40],
        ['2026-10-05', 0, 0],
      ]);
      for (const d of [...april.days, ...october.days]) {
        expect(figures(d)).toEqual(await fromSources(r.id, d.businessDate));
      }
      // 92 days exactly, with the April change inside.
      const wide = await report(r.id, '2026-04-01', '2026-07-01');
      expect(wide.days).toHaveLength(92);
      expect(new Set(wide.days.map((d) => d.businessDate)).size).toBe(92);
      expect(wide.totals).toMatchObject({ netSalesCents: 3000, cogsCents: 120 });
    });
  });

  // ---------------------------------------------------------------- 6. access

  describe('6. access', () => {
    let r: Rest;
    let other: Rest;
    let elsewhere: Rest;
    let day: string;
    let seeded: Record<'centralManager' | 'demoAuditor' | 'rivalManager', string>;

    beforeAll(async () => {
      r = await newRestaurant();
      other = await newRestaurant();
      elsewhere = await newRestaurant('UTC', otherRegionId);
      tokens.otherManager = await addUser(
        'otherManager',
        'restaurant_manager',
        'restaurant',
        other.id,
      );
      day = await today(r.id);
      const o = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      await finish(r.id, o.id);
      await drain();
      seeded = {
        centralManager: await login(h, 'manager@central.kitchos.test'),
        demoAuditor: await login(h, 'auditor@kitchos.test'),
        rivalManager: await login(h, 'manager@rival.test'),
      };
    });

    const status = async (token: string | null, rid: string) => {
      const req = h.http.get(`${api(rid)}/reports/food-cost?from=${day}&to=${day}`);
      return (token ? await req.set(bearer(token)) : await req).status;
    };

    it('who may read it at this restaurant', async () => {
      const got = {
        manager: await status(tokens.manager, r.id),
        auditor: await status(tokens.auditor, r.id),
        areaManager: await status(tokens.area, r.id),
        supervisor: await status(tokens.supervisor, r.id),
        crew: await status(tokens.crew, r.id),
        inventoryController: await status(tokens.inventory, r.id),
        otherRestaurantsManager: await status(tokens.otherManager, r.id),
        otherRegionsAreaManager: await status(tokens.areaOther, r.id),
        centralManager: await status(seeded.centralManager, r.id),
        otherTenantsAuditor: await status(seeded.demoAuditor, r.id),
        rivalManager: await status(seeded.rivalManager, r.id),
        noToken: await status(null, r.id),
      };
      expect(got).toEqual({
        manager: 200,
        auditor: 200,
        areaManager: 200,
        supervisor: 403,
        crew: 403,
        inventoryController: 403,
        otherRestaurantsManager: 404,
        otherRegionsAreaManager: 404,
        centralManager: 404,
        otherTenantsAuditor: 404,
        rivalManager: 404,
        noToken: 401,
      });
      // Scoped roles still work where they are scoped.
      expect(await status(tokens.otherManager, other.id)).toBe(200);
      expect(await status(tokens.areaOther, elsewhere.id)).toBe(200);
      expect(await status(tokens.area, elsewhere.id)).toBe(404);
    });

    it('an unknown or malformed restaurant id, and a seeded restaurant from this tenant, are 404', async () => {
      expect(await status(tokens.auditor, randomUUID())).toBe(404);
      expect(await status(tokens.manager, 'not-a-uuid')).toBe(404);
      expect(await status(tokens.auditor, await restaurantId(h, CENTRAL))).toBe(404);
      expect(await status(tokens.manager, await restaurantId(h, RIVAL))).toBe(404);
    });

    it('a seeded manager reading their own restaurant sees nothing of this tenant', async () => {
      const central = await restaurantId(h, CENTRAL);
      const res = await h.http
        .get(`${api(central)}/reports/food-cost?from=${day}&to=${day}`)
        .set(bearer(seeded.centralManager));
      expect(res.status).toBe(200);
      // Central's figures come from Central's journal only.
      const centralSales = await sql<{ n: string }>`
        select coalesce(-sum(l.debit_cents - l.credit_cents), 0) as n
          from journal_entries e join journal_lines l on l.entry_id = e.id
          join accounts a on a.id = l.account_id
         where e.restaurant_id = ${central}::uuid and e.business_date = ${day}::date
           and a.system_key in ('sales_revenue', 'sales_discounts', 'sales_returns')`.execute(
        h.owner,
      );
      expect(res.body.days[0].netSalesCents).toBe(Number(centralSales.rows[0]!.n));
    });

    describe('runtime role (RLS)', () => {
      let rivalOrg: string;
      let demoOrg: string;
      const visible = (org: string | null) => {
        const q = (tx: Database) =>
          tx
            .selectFrom('journal_entries as e')
            .innerJoin('journal_lines as l', 'l.entry_id', 'e.id')
            .select('l.id')
            .where('e.restaurant_id', '=', r.id)
            .execute();
        return org === null ? q(appDb).catch(() => []) : withTenant(appDb, { orgId: org }, q);
      };

      beforeAll(async () => {
        const org = async (rid: string) =>
          (
            await h.owner
              .selectFrom('restaurants')
              .select('org_id')
              .where('id', '=', rid)
              .executeTakeFirstOrThrow()
          ).org_id;
        rivalOrg = await org(await restaurantId(h, RIVAL));
        demoOrg = await org(await restaurantId(h, CENTRAL));
      });

      it('another tenant sees none of the journal the report reads; the owning tenant does', async () => {
        expect(await visible(rivalOrg)).toEqual([]);
        expect(await visible(demoOrg)).toEqual([]);
        expect((await visible(orgId)).length).toBeGreaterThan(0);
      });

      it('with no tenant set nothing is visible', async () => {
        expect(await visible(null)).toEqual([]);
      });

      it("another tenant cannot see this tenant's accounts or day closes", async () => {
        const accounts = await withTenant(appDb, { orgId: rivalOrg }, (tx) =>
          tx.selectFrom('accounts').select('id').where('org_id', '=', orgId).execute(),
        );
        expect(accounts).toEqual([]);
        const closes = await withTenant(appDb, { orgId: rivalOrg }, (tx) =>
          tx.selectFrom('business_day_closes').select('id').where('org_id', '=', orgId).execute(),
        );
        expect(closes).toEqual([]);
      });
    });
  });

  // ----------------------------- 7. figures that are right by the rules but read oddly

  describe('7. documented: correct by the posting rules, misleading on the report', () => {
    it('waste rejected on a later day shows as negative waste on that day', async () => {
      const r = await newRestaurant();
      const t = await today(r.id);
      const X = await addDays(t, -61);
      const since = await dbNow();
      const w = await recordWaste(r.id, tokens.crew, {
        kind: 'raw_ingredient',
        inventoryItemId: skus.bun,
        quantity: '2',
        reason: 'spoiled',
      });
      expect(w.status).toBe(201);
      await shift(r.id, 61, since);
      await drain();
      await h.http
        .post(`${api(r.id)}/inventory/waste/${w.body.id}/reject`)
        .set(bearer(tokens.manager))
        .send({ reason: 'Found it in the walk-in' })
        .expect(200);
      await drain();
      const rep = await report(r.id, X, t);
      const first = rep.days[0]!;
      const last = rep.days[rep.days.length - 1]!;
      expect(figures(first)).toEqual(await fromSources(r.id, X));
      expect(figures(last)).toEqual(await fromSources(r.id, t));
      expect([first.wasteCents, last.wasteCents, rep.totals.wasteCents]).toEqual([80, -80, 0]);
      expect(last).toMatchObject({ actualFoodCostCents: -80, grossProfitCents: 80 });
    });

    it('a rejected remake keeps both portions in recipe cost for one sale', async () => {
      const r = await newRestaurant();
      const day = await today(r.id);
      const o = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      await completeTasks(r.id, o.id);
      const [task] = await tasksOf(o.id);
      const w = await recordWaste(r.id, tokens.crew, {
        kind: 'prepared_item',
        orderLineId: task!.order_line_id,
        quantity: 1,
        reason: 'burnt',
        remake: true,
      });
      expect(w.status).toBe(201);
      await handoff(r.id, o.id);
      await drain();
      await h.http
        .post(`${api(r.id)}/inventory/waste/${w.body.id}/reject`)
        .set(bearer(tokens.manager))
        .send({ reason: 'It was fine' })
        .expect(200);
      await drain();
      const row = await dayRow(r.id, day);
      expect(figures(row)).toEqual(await fromSources(r.id, day));
      // ADR-0016: "the remake stands". 80 of recipe cost against one 1000 sale: 8%, not 4%.
      expect(figures(row)).toEqual(fig(1000, 80, 0));
      expect(row.cogsBps).toBe(800);
    });

    // Regression (Milestone 14): waste of consumed food used today's standard cost, so a cost rise
    // left recipe cost at -10 here. It is now reclassified at the cost it was consumed at.
    it('a standard cost rise before waste is recorded no longer leaves recipe cost negative', async () => {
      const r = await newRestaurant();
      const day = await today(r.id);
      const o = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      const [task] = await tasksOf(o.id);
      await startTask(r.id, task!.id);
      await h.http
        .post(`${api(r.id)}/orders/${o.id}/cancel`)
        .set(bearer(tokens.manager))
        // Recorded by hand after the cost change: cancel without recording it.
        .send({
          reason: 'customer walked out',
          waste: [{ orderLineId: task!.order_line_id, quantity: 0 }],
        })
        .expect(200);
      expect(
        (await refund(r.id, tokens.supervisor, o.id, { reason: 'cancelled_order' })).status,
      ).toBe(201);
      try {
        await h.owner
          .updateTable('inventory_items')
          .set({ standard_unit_cost: '50' })
          .where('id', '=', skus.bun)
          .execute();
        const w = await recordWaste(r.id, tokens.crew, {
          kind: 'prepared_item',
          orderLineId: task!.order_line_id,
          quantity: 1,
          reason: 'cancelled_prepared_order',
        });
        expect(w.status).toBe(201);
      } finally {
        await h.owner
          .updateTable('inventory_items')
          .set({ standard_unit_cost: '40' })
          .where('id', '=', skus.bun)
          .execute();
      }
      await drain();
      const row = await dayRow(r.id, day);
      expect(figures(row)).toEqual(await fromSources(r.id, day));
      // Consumed at 40, so reclassified at 40: recipe cost nets to 0 and waste carries it.
      expect(figures(row)).toEqual(fig(0, 0, 40));
      expect(row.actualFoodCostCents).toBe(40);
    });
  });

  it('afterwards: nothing failed in this tenant', async () => {
    await drain();
    const failures = await h.owner
      .selectFrom('event_consumer_failures')
      .select(['event_id', 'last_error'])
      .where('org_id', '=', orgId)
      .execute();
    expect(failures).toEqual([]);
  });
});
