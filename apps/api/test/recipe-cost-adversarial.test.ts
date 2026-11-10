import { randomUUID } from 'node:crypto';
import type { FoodCostReport } from '@kitchos/contracts';
import { createDb, withTenant, type Database } from '@kitchos/database';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import { bearer, login, restaurantId, startHarness, type Harness } from './harness.ts';

const CENTRAL = 'kitchos-central';
const RIVAL = 'rival-southbank';

type Row = FoodCostReport['days'][number];

/**
 * Adversarial tests for recipe cost of sales (Milestone 16): soldRecipeCents,
 * theoreticalFoodCostBps and unsoldProductionCents on the food cost report.
 *
 * Expected figures come from source rows (orders, order_lines, stock_movements.value_cents,
 * refunds, refund_lines), recomputed here with this file's own rounding, and are also pinned
 * to hand-worked numbers.
 *
 * Hygiene: everything posts in a throwaway organisation with its own restaurants. The only
 * day closed is 70 days back. afterAll retires failures still retrying and closes every drawer
 * session left open in the throwaway org.
 */
describe('recipe cost of sales (adversarial)', () => {
  let h: Harness;
  let appDb: Database;
  let dispatcher: EventDispatcher;
  let orgId: string;
  let brandId: string;
  let regionId: string;
  let menuId: string;
  let passwordHash: string;
  let tag: string;
  const items = { burger: '', cola: '', fries: '', tri: '', meal: '' };
  const products = { burger: '', cola: '', fries: '', tri: '' };
  const skus = { bun: '', cup: '', pot: '', tri: '' };
  const tokens = { manager: '', supervisor: '', cashier: '', crew: '', otherManager: '' };

  interface Rest {
    id: string;
    drawers: string[];
  }

  // ------------------------------------------------------------------ fixture

  const addUser = async (k: string, role: string, scopeType: string, scopeId: string) => {
    const email = `${k}-${tag}@rca.test`;
    const user = await h.owner
      .insertInto('users')
      .values({ org_id: orgId, email, display_name: `RCA ${k}`, password_hash: passwordHash })
      .returning('id')
      .executeTakeFirstOrThrow();
    await h.owner
      .insertInto('role_assignments')
      .values({ org_id: orgId, user_id: user.id, role, scope_type: scopeType, scope_id: scopeId })
      .execute();
    return login(h, email);
  };

  const buildOrg = async () => {
    tag = randomUUID().slice(0, 8);
    orgId = (
      await h.owner
        .insertInto('organisations')
        .values({ name: `Recipe cost adversarial ${tag}`, slug: `rca-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await sql`select app.create_default_chart(${orgId}::uuid)`.execute(h.owner);
    brandId = (
      await h.owner
        .insertInto('brands')
        .values({ org_id: orgId, name: 'RCA', slug: `rca-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    regionId = (
      await h.owner
        .insertInto('regions')
        .values({ org_id: orgId, name: 'RCA region' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
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
    skus.pot = await inv('POT', '25');
    skus.tri = await inv('TRI', '3.333');
    menuId = (
      await h.owner
        .insertInto('menus')
        .values({ org_id: orgId, brand_id: brandId, name: 'RCA menu' })
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
    const rvs: Record<string, string> = {};
    const addItem = async (
      key: keyof typeof products,
      name: string,
      price: number,
      ingredient: string,
      point: string,
    ) => {
      const productId = await product(name, 'item');
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
      products[key] = productId;
      rvs[key] = rv.id;
      items[key] = (
        await h.owner
          .insertInto('menu_items')
          .values({
            org_id: orgId,
            menu_version_id: mv.id,
            product_id: productId,
            category: 'All',
            price_cents: price,
            recipe_version_id: rv.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    };
    await addItem('burger', 'Burger', 1100, skus.bun, 'task_started');
    await addItem('cola', 'Cola', 330, skus.cup, 'order_accepted');
    await addItem('fries', 'Fries', 550, skus.pot, 'task_completed');
    await addItem('tri', 'Tri', 300, skus.tri, 'order_accepted');
    // A meal whose three components are consumed at three different points.
    const mealProduct = await product('Meal', 'combo');
    items.meal = (
      await h.owner
        .insertInto('menu_items')
        .values({
          org_id: orgId,
          menu_version_id: mv.id,
          product_id: mealProduct,
          category: 'Meals',
          price_cents: 1500,
          recipe_version_id: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    for (const [i, key] of (['burger', 'cola', 'fries'] as const).entries()) {
      await h.owner
        .insertInto('combo_components')
        .values({
          org_id: orgId,
          menu_item_id: items.meal,
          product_id: products[key],
          quantity: 1,
          recipe_version_id: rvs[key]!,
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
    tokens.manager = await addUser('manager', 'restaurant_manager', 'organisation', orgId);
    tokens.supervisor = await addUser('supervisor', 'shift_supervisor', 'organisation', orgId);
    tokens.cashier = await addUser('cashier', 'shift_supervisor', 'organisation', orgId);
    tokens.crew = await addUser('crew', 'crew_member', 'organisation', orgId);
  };

  const newRestaurant = async (timezone = 'UTC'): Promise<Rest> => {
    const slug = `rca-${randomUUID().slice(0, 8)}`;
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
  const noon = (day: string) => sql<Date>`((${day}::date + time '12:00') at time zone 'UTC')`;

  /**
   * Moves everything recorded at this restaurant since `since` back by whole days, column by
   * column, so an order placed earlier but handed over (or refunded) now moves only its later
   * timestamps. Must run before the events are dispatched.
   */
  const shift = (rid: string, days: number, since: Date) =>
    asOwnerRaw(async (tx) => {
      const by = sql`(${days}::int * interval '1 day')`;
      const prior = sql`${days}::int`;
      const r = sql`${rid}::uuid`;
      await sql`update orders set placed_at = placed_at - ${by}, business_date = business_date - ${prior}
                where restaurant_id = ${r} and placed_at >= ${since}`.execute(tx);
      for (const col of ['accepted_at', 'ready_at', 'completed_at', 'cancelled_at']) {
        await sql`update orders set ${sql.ref(col)} = ${sql.ref(col)} - ${by}
                  where restaurant_id = ${r} and ${sql.ref(col)} >= ${since}`.execute(tx);
      }
      await sql`update payments set created_at = created_at - ${by}, captured_at = captured_at - ${by}
                where restaurant_id = ${r} and created_at >= ${since}`.execute(tx);
      await sql`update refunds set created_at = created_at - ${by}
                where restaurant_id = ${r} and created_at >= ${since}`.execute(tx);
      await sql`update stock_movements set occurred_at = occurred_at - ${by},
                  recorded_at = recorded_at - ${by}, business_date = business_date - ${prior}
                where restaurant_id = ${r} and occurred_at >= ${since}`.execute(tx);
      await sql`update waste_records set occurred_at = occurred_at - ${by},
                  business_date = business_date - ${prior}
                where restaurant_id = ${r} and occurred_at >= ${since}`.execute(tx);
      await sql`update waste_records set reviewed_at = reviewed_at - ${by}
                where restaurant_id = ${r} and reviewed_at >= ${since}`.execute(tx);
      await sql`update outbox_events set occurred_at = occurred_at - ${by}
                where restaurant_id = ${r} and occurred_at >= ${since}`.execute(tx);
    });

  const report = async (rid: string, from: string, to: string, token = tokens.manager) => {
    const res = await h.http
      .get(`${api(rid)}/reports/food-cost?from=${from}&to=${to}`)
      .set(bearer(token));
    if (res.status !== 200) throw new Error(`report ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as FoodCostReport;
  };
  const dayRow = async (rid: string, day: string) => (await report(rid, day, day)).days[0]!;
  const recipe = (r: Pick<Row, 'cogsCents' | 'soldRecipeCents' | 'unsoldProductionCents'>) => ({
    cogs: r.cogsCents,
    sold: r.soldRecipeCents,
    unsold: r.unsoldProductionCents,
  });
  const delta = (a: Row, b: Row) => ({
    sales: b.netSalesCents - a.netSalesCents,
    cogs: b.cogsCents - a.cogsCents,
    sold: b.soldRecipeCents - a.soldRecipeCents,
    unsold: b.unsoldProductionCents - a.unsoldProductionCents,
  });
  /** Basis points, half away from zero, null without positive sales (computed separately here). */
  const bps = (cost: number, sales: number): number | null => {
    if (sales <= 0) return null;
    const exact = (Math.abs(cost) * 10_000) / sales;
    const whole = Math.floor(exact);
    const rounded = exact - whole >= 0.5 ? whole + 1 : whole;
    return cost < 0 ? -rounded : rounded;
  };
  const n = (v: unknown) => Number(v ?? 0);

  /** COGS and net sales of one day from source rows (as in food-cost-adversarial). */
  const figuresFromSources = async (rid: string, day: string) => {
    const orders = (
      await sql<{ total: string; tax: string }>`
        select total_cents as total, tax_cents as tax from orders
         where restaurant_id = ${rid}::uuid and status = 'completed'
           and app.business_date(restaurant_id, completed_at) = ${day}::date`.execute(h.owner)
    ).rows;
    const refunds = (
      await sql<{ amount: string; treatment: string; gst: string | null }>`
        select f.amount_cents as amount, f.treatment, f.gst_cents as gst
          from refunds f join orders o on o.id = f.order_id
         where f.restaurant_id = ${rid}::uuid
           and app.business_date(f.restaurant_id, f.created_at) = ${day}::date`.execute(h.owner)
    ).rows;
    let sales = orders.reduce((s, o) => s + n(o.total) - n(o.tax), 0);
    for (const f of refunds) if (f.treatment === 'sales_return') sales -= n(f.amount) - n(f.gst);
    const mv = (
      await sql<{ consumed: string }>`
        select coalesce(sum(value_cents) filter (where movement_type = 'production_consumption'), 0) as consumed
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
    return {
      netSalesCents: sales + 0,
      cogsCents: -n(mv.consumed) - n(reclass.recorded) + n(reclass.rejected) + 0,
    };
  };

  /** Half-up share of a non-negative value for `k` of `q` units (the last unit takes the rest). */
  const upTo = (k: number, q: number, v: number) =>
    k === q ? v : Math.floor((2 * k * v + q) / (2 * q));

  /**
   * Recipe cost of sales per day from source rows: each completed order's original (non-remake)
   * consumption value on its handover day, less each item refund's cumulative share of the
   * refunded line's (or meal's) original consumption on the refund's day.
   */
  const soldFromSources = async (rid: string, from: string, to: string) => {
    const out = new Map<string, number>();
    const add = (d: string, c: number) => out.set(d, (out.get(d) ?? 0) + c);
    const lineValues = (
      await sql<{
        order_id: string;
        line: string;
        top: string;
        status: string;
        d: string | null;
        v: string;
      }>`
        select o.id as order_id, l.id as line, coalesce(l.parent_line_id, l.id) as top, o.status,
               app.business_date(o.restaurant_id, o.completed_at)::text as d,
               coalesce((select -sum(m.value_cents) from stock_movements m
                          where m.source_type = 'order_line' and m.source_id = l.id
                            and m.movement_type = 'production_consumption'
                            and m.source_key not like 'remake:%'), 0) as v
          from orders o join order_lines l on l.order_id = o.id
         where o.restaurant_id = ${rid}::uuid`.execute(h.owner)
    ).rows;
    const topValue = new Map<string, number>();
    for (const l of lineValues) {
      topValue.set(l.top, (topValue.get(l.top) ?? 0) + n(l.v));
      if (l.status === 'completed' && l.d! >= from && l.d! <= to) add(l.d!, n(l.v));
    }
    const rls = (
      await sql<{ line: string; q: number; lq: number; d: string; status: string }>`
        select rl.order_line_id as line, rl.quantity as q, l.quantity as lq, o.status,
               app.business_date(f.restaurant_id, f.created_at)::text as d
          from refund_lines rl join refunds f on f.id = rl.refund_id
          join order_lines l on l.id = rl.order_line_id join orders o on o.id = f.order_id
         where f.restaurant_id = ${rid}::uuid
         order by f.created_at, f.id`.execute(h.owner)
    ).rows;
    const done = new Map<string, number>();
    for (const r of rls) {
      if (r.status !== 'completed') continue; // a cancelled order's refund returns a deposit
      const before = done.get(r.line) ?? 0;
      const v = topValue.get(r.line) ?? 0;
      const share = upTo(before + r.q, r.lq, v) - upTo(before, r.lq, v);
      done.set(r.line, before + r.q);
      if (r.d >= from && r.d <= to) add(r.d, -share);
    }
    return out;
  };

  /** Every day of a report checked against source rows and the report's own arithmetic. */
  const checkAgainstSources = async (rid: string, rep: FoodCostReport) => {
    const sold = await soldFromSources(rid, rep.from, rep.to);
    const got: unknown[] = [];
    const want: unknown[] = [];
    for (const d of rep.days) {
      const f = await figuresFromSources(rid, d.businessDate);
      const s = sold.get(d.businessDate) ?? 0;
      got.push([
        d.businessDate,
        d.netSalesCents,
        d.cogsCents,
        d.soldRecipeCents,
        d.unsoldProductionCents,
        d.theoreticalFoodCostBps,
      ]);
      want.push([
        d.businessDate,
        f.netSalesCents,
        f.cogsCents,
        s,
        f.cogsCents - s,
        bps(s, f.netSalesCents),
      ]);
    }
    expect(got).toEqual(want);
  };

  // Staff flows, all through the real API.

  const ring = async (
    rid: string,
    token: string,
    lines: [keyof typeof items, number][],
  ): Promise<{ id: string; totalCents: number; taxCents: number }> => {
    const res = await h.http
      .post(`${api(rid)}/orders`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({
        fulfilmentType: 'dine_in',
        lines: lines.map(([k, quantity]) => ({ menuItemId: items[k], quantity })),
      });
    if (res.status !== 201) throw new Error(`ring ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const CARD = { method: 'card', paymentToken: 'tok_sandbox_approve' };
  const CASH = { method: 'cash', tenderedCents: 5000 };
  const pay = async (rid: string, token: string, orderId: string, tender: object = CARD) => {
    const res = await h.http
      .post(`${api(rid)}/orders/${orderId}/payments`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send(tender);
    if (res.status !== 200) throw new Error(`pay ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const sell = async (
    rid: string,
    lines: [keyof typeof items, number][],
    tender: object = CARD,
    token = tokens.supervisor,
  ) => {
    const o = await ring(rid, token, lines);
    await pay(rid, token, o.id, tender);
    await finish(rid, o.id);
    return o;
  };
  const tasksOf = (orderId: string) =>
    h.owner
      .selectFrom('kitchen_tasks as t')
      .innerJoin('order_lines as l', 'l.id', 't.order_line_id')
      .select(['t.id', 't.order_line_id', 'l.product_id'])
      .where('t.order_id', '=', orderId)
      .execute();
  const startTask = (rid: string, taskId: string) =>
    h.http
      .post(`${api(rid)}/kitchen/tasks/${taskId}/start`)
      .set(bearer(tokens.crew))
      .send({})
      .expect(200);
  const completeTasks = async (rid: string, orderId: string) => {
    for (const t of await tasksOf(orderId)) {
      await h.http
        .post(`${api(rid)}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(tokens.supervisor))
        .send({})
        .expect(200);
    }
  };
  const handoff = (rid: string, orderId: string) =>
    h.http
      .post(`${api(rid)}/orders/${orderId}/handoff`)
      .set(bearer(tokens.supervisor))
      .expect(200);
  const finish = async (rid: string, orderId: string) => {
    await completeTasks(rid, orderId);
    await handoff(rid, orderId);
  };
  /** Money only (no waste) unless `withWaste`. */
  const refund = async (
    rid: string,
    orderId: string,
    body: object,
    opts: { token?: string; withWaste?: boolean } = {},
  ) => {
    const res = await h.http
      .post(`${api(rid)}/orders/${orderId}/refunds`)
      .set(bearer(opts.token ?? tokens.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send(opts.withWaste ? body : { waste: [], ...body });
    if (res.status !== 201) throw new Error(`refund ${res.status} ${JSON.stringify(res.body)}`);
    return await h.owner
      .selectFrom('refunds')
      .select(['id', 'treatment'])
      .where('order_id', '=', orderId)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
  };
  const topLines = (orderId: string) =>
    h.owner
      .selectFrom('order_lines')
      .select(['id', 'product_id', 'kind', 'quantity'])
      .where('order_id', '=', orderId)
      .where('parent_line_id', 'is', null)
      .orderBy('line_no')
      .execute();
  const lineOf = async (orderId: string, key: keyof typeof products) =>
    (
      await h.owner
        .selectFrom('order_lines')
        .select('id')
        .where('order_id', '=', orderId)
        .where('product_id', '=', products[key])
        .executeTakeFirstOrThrow()
    ).id;
  /** Original consumption value of an order (remakes excluded), from stock movements. */
  const consumedOf = async (orderId: string, includeRemakes = false) => {
    const r = await sql<{ v: string }>`
      select coalesce(-sum(m.value_cents), 0) as v
        from stock_movements m join order_lines l on l.id = m.source_id
       where l.order_id = ${orderId}::uuid and m.source_type = 'order_line'
         and m.movement_type = 'production_consumption'
         and (${includeRemakes} or m.source_key not like 'remake:%')`.execute(h.owner);
    return n(r.rows[0]!.v);
  };
  const recordWaste = (rid: string, body: object) =>
    h.http
      .post(`${api(rid)}/inventory/waste`)
      .set(bearer(tokens.crew))
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const cancel = (rid: string, orderId: string, waste?: object[]) =>
    h.http
      .post(`${api(rid)}/orders/${orderId}/cancel`)
      .set(bearer(tokens.manager))
      .send(waste ? { reason: 'customer walked out', waste } : { reason: 'customer walked out' })
      .expect(200);
  const openDrawer = async (r: Rest, token: string) => {
    const s = await h.http
      .post(`${api(r.id)}/cash/drawers/${r.drawers[0]}/sessions`)
      .set(bearer(token))
      .send({ openingFloatCents: 20_000 });
    expect(s.status).toBe(201); // closed by afterAll, in this throwaway tenant
  };

  // ------------------------------------------------------- 1. a clean day

  describe('1. a clean day: everything produced was sold the same day', () => {
    let r: Rest;
    let day: string;
    const orders: string[] = [];

    beforeAll(async () => {
      r = await newRestaurant('Australia/Sydney');
      day = await today(r.id);
      await openDrawer(r, tokens.supervisor);
      orders.push((await sell(r.id, [['burger', 1]])).id);
      orders.push((await sell(r.id, [['cola', 2]], CASH)).id);
      orders.push((await sell(r.id, [['fries', 1]])).id);
      orders.push((await sell(r.id, [['meal', 1]])).id);
      orders.push((await sell(r.id, [['tri', 3]], CASH)).id);
      // A comp (sold at zero) and a 10% discounted meal.
      const comp = await ring(r.id, tokens.supervisor, [['burger', 1]]);
      const c = await h.http
        .post(`${api(r.id)}/orders/${comp.id}/discount`)
        .set(bearer(tokens.supervisor))
        .set('Idempotency-Key', randomUUID())
        .send({ kind: 'percent', value: 10_000, reason: 'complimentary' });
      expect(c.status).toBe(200);
      await finish(r.id, comp.id);
      orders.push(comp.id);
      const disc = await ring(r.id, tokens.supervisor, [['meal', 1]]);
      const d = await h.http
        .post(`${api(r.id)}/orders/${disc.id}/discount`)
        .set(bearer(tokens.supervisor))
        .set('Idempotency-Key', randomUUID())
        .send({ kind: 'percent', value: 1000, reason: 'customer_service' });
      expect(d.status).toBe(200);
      await pay(r.id, tokens.supervisor, disc.id, CARD);
      await finish(r.id, disc.id);
      orders.push(disc.id);
      await drain();
    });

    it('sold equals COGS, unsold is zero, theoretical equals the COGS percentage', async () => {
      const row = await dayRow(r.id, day);
      let consumed = 0;
      for (const id of orders) consumed += await consumedOf(id);
      // 40 + 2x15 + 25 + 80 + 10 (3 x 3.333) + 40 comp + 80 discounted meal
      expect(consumed).toBe(305);
      expect(recipe(row)).toEqual({ cogs: consumed, sold: consumed, unsold: 0 });
      expect(row.theoreticalFoodCostBps).toBe(row.cogsBps);
      expect(row.theoreticalFoodCostBps).toBe(bps(consumed, row.netSalesCents));
      await checkAgainstSources(r.id, await report(r.id, day, day));
    });

    it('comp and discount: recipe cost is the full recipe, sales are what was charged', async () => {
      const comp = orders[5]!;
      const o = await h.owner
        .selectFrom('orders')
        .select(['total_cents', 'status'])
        .where('id', '=', comp)
        .executeTakeFirstOrThrow();
      expect(o).toMatchObject({ total_cents: 0, status: 'completed' });
      expect(await consumedOf(comp)).toBe(40);
      expect(await consumedOf(orders[6]!)).toBe(80);
    });
  });

  // ------------------------------------------- 2. when consumption happens

  describe('2. consumption at acceptance, task start and completion; sold only at handover', () => {
    let r: Rest;
    let day: string;
    const step = async (act: () => Promise<void>) => {
      await drain();
      const before = await dayRow(r.id, day);
      await act();
      await drain();
      return delta(before, await dayRow(r.id, day));
    };

    beforeAll(async () => {
      r = await newRestaurant();
      day = await today(r.id);
    });

    for (const [label, lines] of [
      [
        'separate items',
        [
          ['burger', 1],
          ['cola', 1],
          ['fries', 1],
        ],
      ],
      ['a meal (combo parent with three components)', [['meal', 1]]],
    ] as const) {
      it(`${label}: 15 at acceptance, 40 at task start, 25 at completion, 80 sold at handover`, async () => {
        let id = '';
        const accepted = await step(async () => {
          const o = await ring(
            r.id,
            tokens.supervisor,
            lines as unknown as [keyof typeof items, number][],
          );
          id = o.id;
          await pay(r.id, tokens.supervisor, o.id);
        });
        expect(accepted).toMatchObject({ sales: 0, cogs: 15, sold: 0, unsold: 15 });
        const started = await step(async () => {
          for (const t of await tasksOf(id)) await startTask(r.id, t.id);
        });
        expect(started).toMatchObject({ sales: 0, cogs: 40, sold: 0, unsold: 40 });
        const completed = await step(() => completeTasks(r.id, id));
        expect(completed).toMatchObject({ sales: 0, cogs: 25, sold: 0, unsold: 25 });
        const handed = await step(async () => {
          await handoff(r.id, id);
        });
        expect(handed).toMatchObject({ cogs: 0, sold: 80, unsold: -80 });
        expect(handed.sales).toBeGreaterThan(0);
        expect(await consumedOf(id)).toBe(80);
      });
    }

    it('the day as a whole: sold == COGS, matches the source rows', async () => {
      const rep = await report(r.id, day, day);
      expect(recipe(rep.days[0]!)).toEqual({ cogs: 160, sold: 160, unsold: 0 });
      await checkAgainstSources(r.id, rep);
    });
  });

  // ---------------------------------------- 3. cooked on D, handed over on D+1

  describe('3. a meal partly cooked on D and finished and handed over on D+1', () => {
    let r: Rest;
    let D: string;
    let D1: string;
    let rep: FoodCostReport;

    beforeAll(async () => {
      r = await newRestaurant();
      const t = await today(r.id);
      D = await addDays(t, -58);
      D1 = await addDays(t, -57);
      const s1 = await dbNow();
      const o = await ring(r.id, tokens.supervisor, [['meal', 1]]);
      await pay(r.id, tokens.supervisor, o.id); // cola consumed
      const burgerTask = (await tasksOf(o.id)).find((x) => x.product_id === products.burger)!;
      await startTask(r.id, burgerTask.id); // burger consumed
      await shift(r.id, 58, s1);
      const s2 = await dbNow();
      await finish(r.id, o.id); // fries consumed, handed over
      await shift(r.id, 57, s2);
      await drain();
      rep = await report(r.id, D, D1);
    });

    it('cost lands where it was cooked, the recipe cost of sales on the handover day', () => {
      expect(rep.days.map((d) => [d.businessDate, recipe(d)])).toEqual([
        [D, { cogs: 55, sold: 0, unsold: 55 }],
        [D1, { cogs: 25, sold: 80, unsold: -55 }],
      ]);
      expect(rep.days[0]!.theoreticalFoodCostBps).toBeNull(); // no sales on D
      expect(rep.days[1]!.theoreticalFoodCostBps).toBe(bps(80, rep.days[1]!.netSalesCents));
      expect(recipe(rep.totals)).toEqual({ cogs: 80, sold: 80, unsold: 0 });
    });

    it('matches the source rows', async () => {
      await checkAgainstSources(r.id, rep);
    });
  });

  // ---------------------------------------------------------- 4. refunds

  describe('4. refunds by item and by amount, across days and the range edge', () => {
    let r: Rest;
    let D1: string;
    let D2: string;
    const o: Record<string, string> = {};

    beforeAll(async () => {
      r = await newRestaurant();
      const t = await today(r.id);
      D1 = await addDays(t, -56);
      D2 = await addDays(t, -55);
      await openDrawer(r, tokens.cashier);
      // ---- D1
      const s1 = await dbNow();
      o.tri = (await sell(r.id, [['tri', 3]])).id; // 3 x 3.333 consumed at 10
      o.meals = (await sell(r.id, [['meal', 2]], CASH, tokens.cashier)).id; // 160
      o.bc = (
        await sell(r.id, [
          ['burger', 1],
          ['cola', 1],
        ])
      ).id; // 55
      o.amount = (await sell(r.id, [['burger', 1]])).id; // 40
      const triLine = (await topLines(o.tri))[0]!.id;
      const mealLine = (await topLines(o.meals))[0]!.id;
      await refund(r.id, o.tri, {
        reason: 'quality',
        items: [{ orderLineId: triLine, quantity: 1 }],
      });
      // One whole meal, cash, with its prepared food recorded as waste (the default for items).
      await refund(
        r.id,
        o.meals,
        { reason: 'quality', items: [{ orderLineId: mealLine, quantity: 1 }] },
        { token: tokens.cashier, withWaste: true },
      );
      await shift(r.id, 56, s1);
      // ---- D2
      const s2 = await dbNow();
      await refund(r.id, o.tri, {
        reason: 'quality',
        items: [{ orderLineId: triLine, quantity: 1 }],
      });
      await refund(
        r.id,
        o.meals,
        { reason: 'quality', items: [{ orderLineId: mealLine, quantity: 1 }] },
        { token: tokens.cashier },
      );
      await refund(r.id, o.bc, {
        reason: 'quality',
        items: [{ orderLineId: await lineOf(o.bc, 'cola'), quantity: 1 }],
      });
      await refund(r.id, o.amount, { reason: 'quality', amountCents: 500 });
      // Sold on D2; its first item refund is then re-dated to D1 (before a range starting D2).
      o.late = (await sell(r.id, [['tri', 3]])).id;
      const lateLine = (await topLines(o.late))[0]!.id;
      const early = await refund(r.id, o.late, {
        reason: 'quality',
        items: [{ orderLineId: lateLine, quantity: 1 }],
      });
      await refund(r.id, o.late, {
        reason: 'quality',
        items: [{ orderLineId: lateLine, quantity: 1 }],
      });
      await shift(r.id, 55, s2);
      await asOwnerRaw(async (tx) => {
        await sql`update refunds set created_at = created_at - interval '1 day'
                  where id = ${early.id}::uuid`.execute(tx);
        await sql`update outbox_events set occurred_at = occurred_at - interval '1 day'
                  where aggregate_id = ${early.id}::uuid`.execute(tx);
      });
      await drain();
    });

    it('fixture: the consumption values the expectations rely on', async () => {
      expect(await consumedOf(o.tri!)).toBe(10);
      expect(await consumedOf(o.meals!)).toBe(160);
      expect(await consumedOf(o.bc!)).toBe(55);
      expect(await consumedOf(o.amount!)).toBe(40);
      expect(await consumedOf(o.late!)).toBe(10);
      const t = await h.owner
        .selectFrom('refunds')
        .select(['treatment'])
        .where('restaurant_id', '=', r.id)
        .execute();
      expect(t.every((x) => x.treatment === 'sales_return')).toBe(true);
    });

    it("per day: sales less each refund's cumulative share (3, 4, then the rest)", async () => {
      const rep = await report(r.id, D1, D2);
      // D1: 10 - 3 (tri #1) + 160 - 80 (meal #1) + 55 + 40 - 3 (late tri #1, re-dated) = 179
      // D2: -4 (tri #2) - 80 (meal #2) - 15 (cola) + 0 (by amount) + 10 - 4 (late tri) = -93
      expect(rep.days.map((d) => [d.businessDate, d.soldRecipeCents])).toEqual([
        [D1, 179],
        [D2, -93],
      ]);
      expect(rep.totals.soldRecipeCents).toBe(86);
      for (const d of rep.days)
        expect(d.unsoldProductionCents).toBe(d.cogsCents - d.soldRecipeCents);
      await checkAgainstSources(r.id, rep);
    });

    it('a refund before the range still counts as "before" for later refunds in it', async () => {
      const rep = await report(r.id, D2, D2);
      expect(rep.days[0]!.soldRecipeCents).toBe(-93);
      await checkAgainstSources(r.id, rep);
    });

    it('a refund by amount changes sales but not recipe cost of sales', async () => {
      // o.amount was refunded 500 by amount on D2; its 40 stays sold on D1.
      const lines = await h.owner
        .selectFrom('refund_lines as rl')
        .innerJoin('refunds as f', 'f.id', 'rl.refund_id')
        .select('rl.refund_id')
        .where('f.order_id', '=', o.amount!)
        .execute();
      expect(lines).toEqual([]);
    });

    it('a meal refunded in two halves nets its line to zero; the tri line keeps its last third', async () => {
      const rep = await report(r.id, D1, await today(r.id));
      expect(rep.totals.soldRecipeCents).toBe(86);
      // what remains sold: tri 3 (last unit), burger 40 (bc), burger 40 (amount), late tri 3
      expect(3 + 40 + 40 + 3).toBe(86);
    });
  });

  // ------------------------------------- 5. cancellations, waste and remakes

  describe('5. cancellations, automatic waste, waste-and-remake', () => {
    let r: Rest;
    let day: string;
    const step = async (act: () => Promise<void>) => {
      await drain();
      const before = await dayRow(r.id, day);
      await act();
      await drain();
      return delta(before, await dayRow(r.id, day));
    };

    beforeAll(async () => {
      r = await newRestaurant();
      day = await today(r.id);
    });

    it('cancelled after cooking, waste suppressed: unsold production, nothing sold', async () => {
      let id = '';
      const d = await step(async () => {
        const o = await ring(r.id, tokens.supervisor, [['burger', 1]]);
        id = o.id;
        await pay(r.id, tokens.supervisor, o.id);
        const [task] = await tasksOf(o.id);
        await startTask(r.id, task!.id);
        await cancel(r.id, o.id, [{ orderLineId: task!.order_line_id, quantity: 0 }]);
      });
      expect(d).toEqual({ sales: 0, cogs: 40, sold: 0, unsold: 40 });
      // Refunding it by item is a deposit release: still nothing sold, nothing taken back.
      const line = (await topLines(id))[0]!.id;
      const d2 = await step(async () => {
        const f = await refund(r.id, id, {
          reason: 'cancelled_order',
          items: [{ orderLineId: line, quantity: 1 }],
        });
        expect(f.treatment).toBe('deposit_release');
      });
      expect(d2).toEqual({ sales: 0, cogs: 0, sold: 0, unsold: 0 });
    });

    it('cancelled after cooking with the automatic waste: COGS reclassified, nothing sold', async () => {
      let id = '';
      const d = await step(async () => {
        const o = await ring(r.id, tokens.supervisor, [
          ['burger', 1],
          ['cola', 1],
        ]);
        id = o.id;
        await pay(r.id, tokens.supervisor, o.id);
        for (const t of await tasksOf(o.id)) await startTask(r.id, t.id);
        await cancel(r.id, o.id);
      });
      expect(await consumedOf(id)).toBe(55);
      expect(d.sold).toBe(0);
      expect(d.sales).toBe(0);
      expect(d.unsold).toBe(d.cogs);
      // All prepared food is recorded as waste by default, so it all leaves COGS.
      expect(d.cogs).toBe(0);
    });

    it('waste and remake: remake excluded from sold, original counted, unsold zero', async () => {
      let id = '';
      const d = await step(async () => {
        const o = await ring(r.id, tokens.supervisor, [['burger', 1]]);
        id = o.id;
        await pay(r.id, tokens.supervisor, o.id);
        await completeTasks(r.id, o.id);
        const [task] = await tasksOf(o.id);
        const w = await recordWaste(r.id, {
          kind: 'prepared_item',
          orderLineId: task!.order_line_id,
          quantity: 1,
          reason: 'burnt',
          remake: true,
        });
        expect(w.status).toBe(201);
        expect(w.body.remake).toBe(true);
        await handoff(r.id, o.id);
      });
      expect(await consumedOf(id, true)).toBe(80);
      expect(d).toMatchObject({ cogs: 40, sold: 40, unsold: 0 });
      // Refunding the remade burger takes back only the original portion.
      const line = (await topLines(id))[0]!.id;
      const d2 = await step(async () => {
        await refund(r.id, id, { reason: 'quality', items: [{ orderLineId: line, quantity: 1 }] });
      });
      expect(d2).toMatchObject({ cogs: 0, sold: -40, unsold: 40 });
    });

    it("a remade meal component: sold is the meal's original 80, not 105", async () => {
      let id = '';
      const d = await step(async () => {
        const o = await ring(r.id, tokens.supervisor, [['meal', 1]]);
        id = o.id;
        await pay(r.id, tokens.supervisor, o.id);
        await completeTasks(r.id, o.id);
        const w = await recordWaste(r.id, {
          kind: 'prepared_item',
          orderLineId: await lineOf(o.id, 'fries'),
          quantity: 1,
          reason: 'dropped',
          remake: true,
        });
        expect(w.status).toBe(201);
        await handoff(r.id, o.id);
      });
      expect(await consumedOf(id, true)).toBe(105);
      expect(d).toMatchObject({ cogs: 80, sold: 80, unsold: 0 });
      const meal = (await topLines(id))[0]!;
      expect(meal.kind).toBe('combo');
      const d2 = await step(async () => {
        await refund(r.id, id, {
          reason: 'quality',
          items: [{ orderLineId: meal.id, quantity: 1 }],
        });
      });
      expect(d2).toMatchObject({ cogs: 0, sold: -80 });
    });

    // Documented (as defined, but misleading): a refund by amount that records the food as waste
    // leaves the item in recipe cost of sales AND puts its cost in waste, so unsold goes negative
    // and the theoretical percentage still includes food the actual figures call waste.
    it('refund by amount with the food recorded as waste: sold unchanged, unsold negative', async () => {
      const o = await sell(r.id, [['burger', 1]]);
      const line = (await topLines(o.id))[0]!.id;
      const d = await step(async () => {
        const res = await h.http
          .post(`${api(r.id)}/orders/${o.id}/refunds`)
          .set(bearer(tokens.supervisor))
          .set('Idempotency-Key', randomUUID())
          .send({
            reason: 'quality',
            amountCents: 500,
            waste: [{ orderLineId: line, quantity: 1 }],
          });
        expect(res.status).toBe(201);
      });
      expect(d).toMatchObject({ cogs: -40, sold: 0, unsold: -40 });
    });

    it('the day matches the source rows', async () => {
      await checkAgainstSources(r.id, await report(r.id, day, day));
    });

    // Regression (Milestone 16): sold was read from orders directly while net sales and COGS waited
    // for the dispatcher, so an undispatched sale showed recipe cost with no revenue. It now follows
    // the journal's own sale entry, so all three move together.
    it('before dispatch nothing moves; after it, sales, COGS and sold move together', async () => {
      await drain();
      const before = await dayRow(r.id, day);
      await sell(r.id, [['burger', 1]]);
      const pending = delta(before, await dayRow(r.id, day));
      expect(pending).toEqual({ sales: 0, cogs: 0, sold: 0, unsold: 0 });
      await drain();
      expect(delta(before, await dayRow(r.id, day))).toMatchObject({
        cogs: 40,
        sold: 40,
        unsold: 0,
      });
    });
  });

  // ------------------------------------------------- 6. a 92-day range

  describe('6. a 92-day range: totals are the sum of days; no percentage without sales', () => {
    let r: Rest;
    let t: string;
    let rep: FoodCostReport;

    beforeAll(async () => {
      r = await newRestaurant();
      t = await today(r.id);
      const phase = async (days: number, act: () => Promise<void>) => {
        const s = await dbNow();
        await act();
        if (days > 0) await shift(r.id, days, s);
      };
      let first = '';
      let triOrder = '';
      await phase(91, async () => {
        first = (await sell(r.id, [['burger', 1]])).id;
      });
      await phase(50, async () => {
        triOrder = (await sell(r.id, [['tri', 3]])).id;
      });
      await phase(40, async () => {
        await refund(r.id, first, { reason: 'quality', amountCents: 200 });
      });
      await phase(30, async () => {
        const line = (await topLines(triOrder))[0]!.id;
        await refund(r.id, triOrder, {
          reason: 'quality',
          items: [{ orderLineId: line, quantity: 1 }],
        });
      });
      await phase(20, async () => {
        const comp = await ring(r.id, tokens.supervisor, [['burger', 1]]);
        const c = await h.http
          .post(`${api(r.id)}/orders/${comp.id}/discount`)
          .set(bearer(tokens.supervisor))
          .set('Idempotency-Key', randomUUID())
          .send({ kind: 'percent', value: 10_000, reason: 'complimentary' });
        expect(c.status).toBe(200);
        await finish(r.id, comp.id);
      });
      await phase(0, async () => {
        await sell(r.id, [['cola', 1]]);
      });
      await drain();
      rep = await report(r.id, await addDays(t, -91), t);
    });

    it('92 days, each matching its source rows', async () => {
      expect(rep.days).toHaveLength(92);
      await checkAgainstSources(r.id, rep);
    });

    it('totals equal the sum of the days, with percentages from summed cents', () => {
      const sum = (k: keyof Row) => rep.days.reduce((s, d) => s + (d[k] as number), 0);
      expect(rep.totals.soldRecipeCents).toBe(sum('soldRecipeCents'));
      expect(rep.totals.unsoldProductionCents).toBe(sum('unsoldProductionCents'));
      expect(rep.totals.cogsCents).toBe(sum('cogsCents'));
      expect(rep.totals.netSalesCents).toBe(sum('netSalesCents'));
      // 40 + 10 - 3 + 40 (comp) + 15
      expect(recipe(rep.totals)).toEqual({ cogs: 105, sold: 102, unsold: 3 });
      expect(rep.totals.theoreticalFoodCostBps).toBe(
        bps(rep.totals.soldRecipeCents, rep.totals.netSalesCents),
      );
    });

    it('days without positive sales have no theoretical percentage', async () => {
      const at = async (k: number) => {
        const day = await addDays(t, -k);
        return rep.days.find((d) => d.businessDate === day)!;
      };
      const refundOnly = await at(40);
      expect(refundOnly.netSalesCents).toBeLessThan(0);
      expect(refundOnly).toMatchObject({ soldRecipeCents: 0, theoreticalFoodCostBps: null });
      const itemRefundOnly = await at(30);
      expect(itemRefundOnly.netSalesCents).toBeLessThan(0);
      expect(itemRefundOnly).toMatchObject({
        soldRecipeCents: -3,
        theoreticalFoodCostBps: null,
        unsoldProductionCents: 3,
      });
      const compOnly = await at(20);
      expect(compOnly).toMatchObject({
        netSalesCents: 0,
        cogsCents: 40,
        soldRecipeCents: 40,
        unsoldProductionCents: 0,
        theoreticalFoodCostBps: null,
      });
      for (const d of rep.days) {
        if (d.netSalesCents <= 0) expect(d.theoreticalFoodCostBps).toBeNull();
      }
    });
  });

  // ------------------------------- 7. a sale and a refund that post late into an open day

  describe('7. a closed day: late handover and late item refund (ADR-0017)', () => {
    let r: Rest;
    let D: string;
    let t: string;
    let atClose: Row;
    let rep: FoodCostReport;
    let lateOrder = '';

    beforeAll(async () => {
      r = await newRestaurant();
      t = await today(r.id);
      D = await addDays(t, -70);
      const since = await dbNow();
      const late = await ring(r.id, tokens.supervisor, [['burger', 1]]);
      lateOrder = late.id;
      await pay(r.id, tokens.supervisor, late.id);
      await completeTasks(r.id, late.id); // cooked on D, not handed over
      await sell(r.id, [['burger', 1]]);
      const tri = await sell(r.id, [['tri', 3]]);
      await shift(r.id, 70, since);
      await drain();
      atClose = await dayRow(r.id, D);
      const closed = await h.http
        .post(`${api(r.id)}/days/${D}/close`)
        .set(bearer(tokens.manager))
        .send({});
      expect(closed.status).toBe(200);
      // The handover and an item refund straddle the close: both are dated D at source.
      await handoff(r.id, late.id);
      const f = await refund(r.id, tri.id, {
        reason: 'quality',
        items: [{ orderLineId: (await topLines(tri.id))[0]!.id, quantity: 1 }],
      });
      await asOwnerRaw(async (tx) => {
        await sql`update orders set completed_at = ${noon(D)} where id = ${late.id}::uuid`.execute(
          tx,
        );
        await sql`update outbox_events set occurred_at = ${noon(D)}
                  where event_type = 'order.completed' and aggregate_id = ${late.id}::uuid`.execute(
          tx,
        );
        await sql`update refunds set created_at = ${noon(D)} + interval '1 hour'
                  where id = ${f.id}::uuid`.execute(tx);
        await sql`update outbox_events set occurred_at = ${noon(D)} + interval '1 hour'
                  where aggregate_id = ${f.id}::uuid`.execute(tx);
      });
      await drain();
      rep = await report(r.id, D, t);
    });

    it('fixture: at close D had 50 sold of 90 produced', () => {
      expect(recipe(atClose)).toEqual({ cogs: 90, sold: 50, unsold: 40 });
    });

    it('the late sale and refund post on the first open day in the books', async () => {
      const entries = await h.owner
        .selectFrom('journal_entries')
        .select([sql<string>`business_date::text`.as('d'), 'entry_type'])
        .where('restaurant_id', '=', r.id)
        .where('entry_type', 'in', ['sale_recognition', 'refund'])
        .where(sql<boolean>`posted_late_from is not null`)
        .execute();
      expect(entries.map((e) => [e.entry_type, e.d]).sort()).toEqual([
        ['refund', t],
        ['sale_recognition', t],
      ]);
    });

    // Regression (fixed in Milestone 16): soldRecipeCost dates a sale by orders.completed_at and a refund by
    // refunds.created_at (food-cost.controller.ts:120/128 and :139/151), while net sales and COGS
    // come from the journal, which moves entries dated in a closed day to the first open day
    // (ADR-0017). So after D closed, its soldRecipeCents changes (50 -> 87) and its theoretical
    // food cost no longer matches its own net sales, while the open day carries the late revenue
    // with no recipe cost of sales. Observed: D {netSales 1818, cogs 90, sold 87, unsold 3,
    // theoretical 479 bps} (sold was 50 when D closed); today {netSales 727, cogs 0, sold 0,
    // theoretical 0 bps}. Expected: D sold stays 50; today sold 40 - 3 = 37.
    // Repro: this describe block.
    it("a closed day's recipe cost of sales does not change; the late items follow their revenue", () => {
      const first = rep.days[0]!;
      const last = rep.days[rep.days.length - 1]!;
      expect(first.netSalesCents).toBe(atClose.netSalesCents);
      expect(first.cogsCents).toBe(atClose.cogsCents);
      expect([first.businessDate, first.soldRecipeCents]).toEqual([D, 50]);
      expect([last.businessDate, last.soldRecipeCents]).toEqual([t, 40 - 3]);
      expect(rep.totals.soldRecipeCents).toBe(87);
    });

    it('fixture: the late order is completed', async () => {
      const o = await h.owner
        .selectFrom('orders')
        .select('status')
        .where('id', '=', lateOrder)
        .executeTakeFirstOrThrow();
      expect(o.status).toBe('completed');
    });
  });

  // ------------------------------------------- 8. tenant isolation and scoping

  describe('8. tenant isolation and restaurant scoping of the new figures', () => {
    let a: Rest;
    let b: Rest;
    let day: string;
    let rivalOrg: string;

    beforeAll(async () => {
      a = await newRestaurant();
      b = await newRestaurant();
      day = await today(a.id);
      tokens.otherManager = await addUser('otherManager', 'restaurant_manager', 'restaurant', b.id);
      await sell(a.id, [['burger', 1]]);
      const ob = await sell(b.id, [['meal', 1]]);
      await refund(b.id, ob.id, {
        reason: 'quality',
        items: [{ orderLineId: (await topLines(ob.id))[0]!.id, quantity: 1 }],
      });
      await sell(b.id, [['fries', 1]]);
      await drain();
      rivalOrg = (
        await h.owner
          .selectFrom('restaurants')
          .select('org_id')
          .where('id', '=', await restaurantId(h, RIVAL))
          .executeTakeFirstOrThrow()
      ).org_id;
    });

    it("each restaurant's sold figure is its own", async () => {
      expect(recipe(await dayRow(a.id, day))).toEqual({ cogs: 40, sold: 40, unsold: 0 });
      // b: meal 80 sold then refunded by item (money only), fries 25.
      expect(recipe(await dayRow(b.id, day))).toEqual({ cogs: 105, sold: 25, unsold: 80 });
      await checkAgainstSources(a.id, await report(a.id, day, day));
      await checkAgainstSources(b.id, await report(b.id, day, day));
    });

    it('a manager scoped to b reads b, not a; other tenants get 404', async () => {
      const status = async (token: string, rid: string) =>
        (await h.http.get(`${api(rid)}/reports/food-cost?from=${day}&to=${day}`).set(bearer(token)))
          .status;
      expect(await status(tokens.otherManager, a.id)).toBe(404);
      expect((await report(b.id, day, day, tokens.otherManager)).days[0]!.soldRecipeCents).toBe(25);
      const rival = await login(h, 'manager@rival.test');
      const central = await login(h, 'manager@central.kitchos.test');
      expect(await status(rival, a.id)).toBe(404);
      expect(await status(central, b.id)).toBe(404);
    });

    it("another tenant's report does not move with this tenant's sales", async () => {
      const centralId = await restaurantId(h, CENTRAL);
      const central = await login(h, 'manager@central.kitchos.test');
      const read = async () =>
        (
          (
            await h.http
              .get(`${api(centralId)}/reports/food-cost?from=${day}&to=${day}`)
              .set(bearer(central))
              .expect(200)
          ).body as FoodCostReport
        ).days[0]!;
      const before = await read();
      await sell(a.id, [['meal', 1]]);
      const ob = await sell(b.id, [['tri', 3]]);
      await refund(b.id, ob.id, {
        reason: 'quality',
        items: [{ orderLineId: (await topLines(ob.id))[0]!.id, quantity: 2 }],
      });
      await drain();
      const after = await read();
      expect(recipe(after)).toEqual(recipe(before));
      expect(recipe(await dayRow(a.id, day))).toEqual({ cogs: 120, sold: 120, unsold: 0 });
    });

    it('under RLS another tenant sees none of the rows the figure is built from', async () => {
      const seen = await withTenant(appDb, { orgId: rivalOrg }, async (tx) => ({
        orders: (
          await tx.selectFrom('orders').select('id').where('restaurant_id', '=', b.id).execute()
        ).length,
        movements: (
          await tx
            .selectFrom('stock_movements')
            .select('id')
            .where('restaurant_id', '=', b.id)
            .execute()
        ).length,
        refunds: (
          await tx.selectFrom('refunds').select('id').where('restaurant_id', '=', b.id).execute()
        ).length,
        refundLines: (
          await tx
            .selectFrom('refund_lines')
            .select('refund_id')
            .where('org_id', '=', orgId)
            .execute()
        ).length,
      }));
      expect(seen).toEqual({ orders: 0, movements: 0, refunds: 0, refundLines: 0 });
      const own = await withTenant(appDb, { orgId }, (tx) =>
        tx.selectFrom('refund_lines').select('refund_id').where('org_id', '=', orgId).execute(),
      );
      expect(own.length).toBeGreaterThan(0);
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
