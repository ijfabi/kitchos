import { randomUUID } from 'node:crypto';
import type { FoodCostReport, MenuItemReport } from '@kitchos/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import { bearer, login, startHarness, type Harness } from './harness.ts';

/**
 * Adversarial tests for the per menu item food cost report.
 *
 * Every expected figure is rebuilt here from source rows (orders, order_lines, stock_movements,
 * refunds, refund_lines), dated by the source rows' own timestamps, with this file's own GST
 * allocation and rounding; nothing re-runs the controller's queries or domain helpers.
 *
 * Hygiene: everything that posts runs in a throwaway organisation with its own restaurants, so no
 * seeded stock is touched and no other file's sales interfere. No day is closed. Drawer sessions
 * opened here are closed before the test that opened them ends. Seeded tenants only receive
 * requests that must be refused.
 */
describe('menu item report (adversarial)', () => {
  let h: Harness;
  let dispatcher: EventDispatcher;
  let orgId: string;
  let brandId: string;
  let regionId: string;
  let menuId: string;
  let tag: string;
  let passwordHash: string;
  const inv = { bun: '', cup: '' };
  const menuItems = { burger: '', cola: '', water: '', odd: '', meal: '' };
  const tokens = { manager: '', supervisor: '', crew: '', otherManager: '' };
  const burgerProduct = { productId: '', rv: '' };

  // ------------------------------------------------------------------ fixture

  const addUser = async (k: string, role: string, scopeType: string, scopeId: string) => {
    const email = `${k}-${tag}@mia.test`;
    const user = await h.owner
      .insertInto('users')
      .values({ org_id: orgId, email, display_name: `MIA ${k}`, password_hash: passwordHash })
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
        .values({ name: `Menu item adversarial ${tag}`, slug: `mia-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await sql`select app.create_default_chart(${orgId}::uuid)`.execute(h.owner);
    brandId = (
      await h.owner
        .insertInto('brands')
        .values({ org_id: orgId, name: 'MIA', slug: `mia-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    regionId = (
      await h.owner
        .insertInto('regions')
        .values({ org_id: orgId, name: 'MIA region' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const addInv = async (sku: string, cost: string) =>
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
    inv.bun = await addInv('BUN', '40');
    inv.cup = await addInv('CUP', '15');
    menuId = (
      await h.owner
        .insertInto('menus')
        .values({ org_id: orgId, brand_id: brandId, name: 'MIA menu' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const mv = await h.owner
      .insertInto('menu_versions')
      .values({ org_id: orgId, menu_id: menuId, version: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const product = async (name: string, kind: 'item' | 'combo', taxable = true) =>
      (
        await h.owner
          .insertInto('products')
          .values({ org_id: orgId, brand_id: brandId, sku: name, name, kind, taxable })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const recipe = async (productId: string, ingredient: string, point: string) => {
      const r = await h.owner
        .insertInto('recipes')
        .values({ org_id: orgId, product_id: productId })
        .returning('id')
        .executeTakeFirstOrThrow();
      const rv = await h.owner
        .insertInto('recipe_versions')
        .values({
          org_id: orgId,
          recipe_id: r.id,
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
    const simple = async (
      name: string,
      category: string,
      price: number,
      ingredient: string,
      point: string,
      taxable = true,
    ) => {
      const pid = await product(name, 'item', taxable);
      const rv = await recipe(pid, ingredient, point);
      const mi = await h.owner
        .insertInto('menu_items')
        .values({
          org_id: orgId,
          menu_version_id: mv.id,
          product_id: pid,
          category,
          price_cents: price,
          recipe_version_id: rv,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { menuItemId: mi.id, productId: pid, rv };
    };
    const burger = await simple('Burger', 'Mains', 1100, inv.bun, 'task_started');
    const cola = await simple('Cola', 'Drinks', 330, inv.cup, 'order_accepted');
    const water = await simple('Water', 'Drinks', 300, inv.cup, 'order_accepted', false);
    const odd = await simple('Odd', 'Mains', 1103, inv.bun, 'task_started');
    menuItems.burger = burger.menuItemId;
    burgerProduct.productId = burger.productId;
    burgerProduct.rv = burger.rv;
    menuItems.cola = cola.menuItemId;
    menuItems.water = water.menuItemId;
    menuItems.odd = odd.menuItemId;
    const mealProduct = await product('Meal', 'combo');
    menuItems.meal = (
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
    for (const [i, c] of [burger, cola].entries()) {
      await h.owner
        .insertInto('combo_components')
        .values({
          org_id: orgId,
          menu_item_id: menuItems.meal,
          product_id: c.productId,
          quantity: 1,
          recipe_version_id: c.rv,
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
    tokens.crew = await addUser('crew', 'crew_member', 'organisation', orgId);
  };

  const newRestaurant = async () => {
    const slug = `mia-${randomUUID().slice(0, 8)}`;
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
    await h.owner
      .insertInto('stock_locations')
      .values({ org_id: orgId, restaurant_id: r.id, code: 'main', name: 'Main', is_default: true })
      .execute();
    await h.owner
      .insertInto('restaurant_event_sequences')
      .values({ org_id: orgId, restaurant_id: r.id })
      .execute();
    await h.owner
      .insertInto('cash_drawers')
      .values({ org_id: orgId, restaurant_id: r.id, code: 'till-1', name: 'Till 1' })
      .execute();
    const receipt = await h.http
      .post(`${api(r.id)}/inventory/receipts`)
      .set(bearer(tokens.manager))
      .set('Idempotency-Key', randomUUID())
      .send({
        lines: [
          { inventoryItemId: inv.bun, quantity: '200' },
          { inventoryItemId: inv.cup, quantity: '200' },
        ],
      });
    expect(receipt.status).toBe(201);
    await drain();
    return r.id;
  };

  beforeAll(async () => {
    h = await startHarness();
    dispatcher = h.app.get(EventDispatcher);
    await buildOrg();
  });

  afterAll(async () => {
    await drain();
    const open = await h.owner
      .selectFrom('drawer_sessions')
      .select('id')
      .where('org_id', '=', orgId)
      .where('status', '<>', 'closed')
      .execute();
    const dead = await h.owner
      .selectFrom('event_consumer_failures')
      .select('event_id')
      .where('org_id', '=', orgId)
      .execute();
    await h.close();
    expect({ open, dead }).toEqual({ open: [], dead: [] });
  });

  // ------------------------------------------------------------------ helpers

  const api = (rid: string) => `/v1/restaurants/${rid}`;
  const drain = async () => {
    for (let i = 0; i < 50; i++) {
      if ((await dispatcher.runOnce()).processed === 0) return;
    }
  };
  const asOwnerRaw = (fn: (tx: typeof h.owner) => Promise<void>) =>
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

  /** Moves everything recorded at this restaurant since `since` back by whole days (undispatched). */
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
      await sql`update outbox_events set occurred_at = occurred_at - ${by}
                where restaurant_id = ${rid}::uuid and occurred_at >= ${since}`.execute(tx);
    });

  type Item = keyof typeof menuItems;
  interface Placed {
    id: string;
    lines: { id: string; name: string; kind: string; parent: string | null }[];
  }
  const CARD = { method: 'card', paymentToken: 'tok_sandbox_approve' };

  const ring = async (rid: string, items: [Item | string, number][]): Promise<Placed> => {
    const res = await h.http
      .post(`${api(rid)}/orders`)
      .set(bearer(tokens.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({
        fulfilmentType: 'dine_in',
        lines: items.map(([n, quantity]) => ({
          menuItemId: n in menuItems ? menuItems[n as Item] : n,
          quantity,
        })),
      });
    if (res.status !== 201) throw new Error(`ring ${res.status} ${JSON.stringify(res.body)}`);
    const lines = await h.owner
      .selectFrom('order_lines')
      .select(['id', 'name', 'kind', 'parent_line_id as parent'])
      .where('order_id', '=', res.body.id)
      .execute();
    return { id: res.body.id as string, lines };
  };
  const discount = async (rid: string, o: Placed, body: object) => {
    const res = await h.http
      .post(`${api(rid)}/orders/${o.id}/discount`)
      .set(bearer(tokens.manager))
      .set('Idempotency-Key', randomUUID())
      .send(body);
    if (res.status !== 200) throw new Error(`discount ${res.status} ${JSON.stringify(res.body)}`);
  };
  const pay = async (rid: string, o: Placed, tender: object = CARD) => {
    const res = await h.http
      .post(`${api(rid)}/orders/${o.id}/payments`)
      .set(bearer(tokens.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send(tender);
    if (res.status !== 200) throw new Error(`pay ${res.status} ${JSON.stringify(res.body)}`);
  };
  const tasksOf = (orderId: string) =>
    h.owner
      .selectFrom('kitchen_tasks')
      .select(['id', 'order_line_id'])
      .where('order_id', '=', orderId)
      .execute();
  const completeAll = async (rid: string, o: Placed) => {
    for (const t of await tasksOf(o.id)) {
      await h.http
        .post(`${api(rid)}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(tokens.supervisor))
        .send({})
        .expect(200);
    }
  };
  const handoff = (rid: string, o: Placed) =>
    h.http
      .post(`${api(rid)}/orders/${o.id}/handoff`)
      .set(bearer(tokens.supervisor))
      .expect(200);
  const finished = async (
    rid: string,
    items: [Item | string, number][],
    opts: { discount?: object; tender?: object | null } = {},
  ) => {
    const o = await ring(rid, items);
    if (opts.discount) await discount(rid, o, opts.discount);
    if (opts.tender !== null) await pay(rid, o, opts.tender ?? CARD);
    await completeAll(rid, o);
    await handoff(rid, o);
    return o;
  };
  const top = (o: Placed, name: string) =>
    o.lines.find((l) => l.name === name && l.parent === null)!.id;
  const refund = async (rid: string, o: Placed, body: object) => {
    const res = await h.http
      .post(`${api(rid)}/orders/${o.id}/refunds`)
      .set(bearer(tokens.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'quality', waste: [], ...body });
    if (res.status !== 201) throw new Error(`refund ${res.status} ${JSON.stringify(res.body)}`);
  };
  const byItem = (lineId: string, quantity = 1) => ({ items: [{ orderLineId: lineId, quantity }] });
  const openSession = async (rid: string) => {
    const drawers = (
      await h.http
        .get(`${api(rid)}/cash/drawers`)
        .set(bearer(tokens.supervisor))
        .expect(200)
    ).body as { id: string }[];
    const res = await h.http
      .post(`${api(rid)}/cash/drawers/${drawers[0]!.id}/sessions`)
      .set(bearer(tokens.supervisor))
      .send({ openingFloatCents: 20_000 });
    if (res.status !== 201) throw new Error(`open ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  };
  const closeSession = async (rid: string, sessionId: string) => {
    const s = (
      await h.http
        .get(`${api(rid)}/cash/sessions/${sessionId}`)
        .set(bearer(tokens.manager))
        .expect(200)
    ).body as { expected: { expectedCents: number } };
    const res = await h.http
      .post(`${api(rid)}/cash/sessions/${sessionId}/count`)
      .set(bearer(tokens.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({ countedCents: s.expected.expectedCents });
    expect(res.status).toBe(200);
  };

  const menuReport = async (rid: string, from: string, to: string, token = tokens.manager) => {
    const res = await h.http
      .get(`${api(rid)}/reports/menu-items?from=${from}&to=${to}`)
      .set(bearer(token));
    if (res.status !== 200) throw new Error(`menu ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as MenuItemReport;
  };
  const foodCostReport = async (rid: string, from: string, to: string) => {
    const res = await h.http
      .get(`${api(rid)}/reports/food-cost?from=${from}&to=${to}`)
      .set(bearer(tokens.manager));
    if (res.status !== 200) throw new Error(`food ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as FoodCostReport;
  };

  // ------------------------------------------------- independent model from source rows

  const n = (v: unknown) => Number(v ?? 0);
  /** round(a / b) half up, a >= 0, b > 0, in exact integers. */
  const halfUp = (a: number, b: number) => Number((2n * BigInt(a) + BigInt(b)) / (2n * BigInt(b)));
  /** Largest remainder; ties to the earlier line. Written here, not imported. */
  const spread = (amount: number, weights: number[]) => {
    const total = weights.reduce((s, w) => s + w, 0);
    if (amount === 0 || total === 0) return weights.map(() => 0);
    const base = weights.map((w) => Math.floor((amount * w) / total));
    const rem = weights.map((w, i) => ({ i, r: (amount * w) % total }));
    let left = amount - base.reduce((s, b) => s + b, 0);
    rem.sort((a, b) => b.r - a.r || a.i - b.i);
    for (const { i } of rem) {
      if (left === 0) break;
      base[i]! += 1;
      left -= 1;
    }
    return base;
  };
  /** Cumulative share of `whole` for the first k of q units. */
  const upTo = (whole: number, q: number, k: number) => (k === q ? whole : halfUp(k * whole, q));
  const bps = (cost: number, sales: number): number | null => {
    if (sales <= 0) return null;
    const exact = (Math.abs(cost) * 10_000) / sales;
    const whole = Math.floor(exact);
    const r = exact - whole >= 0.5 ? whole + 1 : whole;
    return cost < 0 ? -r : r;
  };

  interface TopLine {
    id: string;
    product_id: string;
    name: string;
    category: string;
    quantity: number;
    net: number;
    gst: number;
    consumed: number;
  }
  /** An order's top-level lines with their GST share and consumption (remakes excluded). */
  const topLines = async (orderId: string): Promise<TopLine[]> => {
    const o = await h.owner
      .selectFrom('orders')
      .select(['tax_cents', 'total_cents'])
      .where('id', '=', orderId)
      .executeTakeFirstOrThrow();
    const rows = (
      await sql<{
        id: string;
        product_id: string;
        name: string;
        category: string | null;
        quantity: number;
        line_total_cents: string;
        discount_cents: string;
        taxable: boolean;
        consumed: string;
      }>`
        select l.id, l.product_id, l.name, mi.category, l.quantity, l.line_total_cents,
               l.discount_cents, l.taxable,
               (select coalesce(-sum(m.value_cents), 0) from stock_movements m
                  join order_lines x on x.id = m.source_id
                 where m.source_type = 'order_line' and m.movement_type = 'production_consumption'
                   and m.source_key not like 'remake:%'
                   and (x.id = l.id or x.parent_line_id = l.id)) as consumed
          from order_lines l left join menu_items mi on mi.id = l.menu_item_id
         where l.order_id = ${orderId}::uuid and l.parent_line_id is null
         order by l.line_no`.execute(h.owner)
    ).rows;
    const nets = rows.map((r) => n(r.line_total_cents) - n(r.discount_cents));
    // The order's own arithmetic: lines add up to its total.
    expect(nets.reduce((s, x) => s + x, 0)).toBe(n(o.total_cents));
    const gst = spread(
      n(o.tax_cents),
      rows.map((r, i) => (r.taxable ? nets[i]! : 0)),
    );
    return rows.map((r, i) => ({
      id: r.id,
      product_id: r.product_id,
      name: r.name,
      category: r.category ?? 'Other',
      quantity: r.quantity,
      net: nets[i]!,
      gst: gst[i]!,
      consumed: n(r.consumed),
    }));
  };

  interface Exp {
    productId: string;
    name: string;
    category: string;
    unitsSold: number;
    netSalesCents: number;
    recipeCostCents: number;
  }
  const expected = async (rid: string, from: string, to: string) => {
    const rows = new Map<string, Exp>();
    const row = (l: TopLine) => {
      let r = rows.get(l.product_id);
      if (!r) {
        r = {
          productId: l.product_id,
          name: l.name,
          category: l.category,
          unitsSold: 0,
          netSalesCents: 0,
          recipeCostCents: 0,
        };
        rows.set(l.product_id, r);
      }
      return r;
    };
    const sold = (
      await sql<{ id: string }>`
        select id from orders
         where restaurant_id = ${rid}::uuid and status = 'completed'
           and app.business_date(restaurant_id, completed_at) between ${from}::date and ${to}::date`.execute(
        h.owner,
      )
    ).rows;
    for (const o of sold) {
      for (const l of await topLines(o.id)) {
        const r = row(l);
        r.unitsSold += l.quantity;
        r.netSalesCents += l.net - l.gst;
        r.recipeCostCents += l.consumed;
      }
    }
    const refunds = (
      await sql<{ id: string; order_id: string; amount: string; gst: string | null; at: Date }>`
        select id, order_id, amount_cents as amount, gst_cents as gst, created_at as at
          from refunds
         where restaurant_id = ${rid}::uuid and treatment = 'sales_return'
           and app.business_date(restaurant_id, created_at) between ${from}::date and ${to}::date`.execute(
        h.owner,
      )
    ).rows;
    let byAmount = 0;
    for (const f of refunds) {
      const lines = await h.owner
        .selectFrom('refund_lines')
        .select(['order_line_id', 'quantity', 'amount_cents', 'gst_cents'])
        .where('refund_id', '=', f.id)
        .execute();
      if (lines.length === 0) {
        expect(f.gst).not.toBeNull();
        byAmount += n(f.amount) - n(f.gst);
        continue;
      }
      const tops = await topLines(f.order_id);
      for (const rl of lines) {
        const l = tops.find((t) => t.id === rl.order_line_id)!;
        const before = n(
          (
            await sql<{ q: string }>`
              select coalesce(sum(rl.quantity), 0) as q
                from refund_lines rl join refunds f on f.id = rl.refund_id
               where rl.order_line_id = ${l.id}::uuid
                 and (f.created_at, f.id) < (${f.at}::timestamptz, ${f.id}::uuid)`.execute(h.owner)
          ).rows[0]!.q,
        );
        const share = (whole: number) =>
          upTo(whole, l.quantity, before + rl.quantity) - upTo(whole, l.quantity, before);
        // The refund service priced it the same way.
        expect({ amount: rl.amount_cents, gst: rl.gst_cents }).toEqual({
          amount: share(l.net),
          gst: share(l.gst),
        });
        const r = row(l);
        r.unitsSold -= rl.quantity;
        r.netSalesCents -= share(l.net) - share(l.gst);
        r.recipeCostCents -= share(l.consumed);
      }
    }
    return { rows, byAmount };
  };

  /** Report vs model vs food cost report, and the report's own arithmetic. */
  const check = async (rid: string, from: string, to: string) => {
    await drain();
    const rep = await menuReport(rid, from, to);
    const fc = await foodCostReport(rid, from, to);
    const exp = await expected(rid, from, to);
    const label = `${from}..${to}`;
    const got = Object.fromEntries(
      rep.items.map((i) => [
        i.name,
        [
          i.category,
          i.unitsSold,
          i.netSalesCents,
          i.recipeCostCents,
          i.grossProfitCents,
          i.recipeCostBps,
        ],
      ]),
    );
    const want = Object.fromEntries(
      [...exp.rows.values()].map((e) => [
        e.name,
        [
          e.category,
          e.unitsSold,
          e.netSalesCents,
          e.recipeCostCents,
          e.netSalesCents - e.recipeCostCents,
          bps(e.recipeCostCents, e.netSalesCents),
        ],
      ]),
    );
    expect({ label, items: got }).toEqual({ label, items: want });
    expect(new Set(rep.items.map((i) => i.productId)).size).toBe(rep.items.length);
    for (const i of rep.items) expect(exp.rows.get(i.productId)?.name).toBe(i.name);
    expect({ label, byAmount: rep.refundsByAmountCents }).toEqual({
      label,
      byAmount: exp.byAmount,
    });
    const itemNet = [...exp.rows.values()].reduce((s, e) => s + e.netSalesCents, 0);
    const itemCost = [...exp.rows.values()].reduce((s, e) => s + e.recipeCostCents, 0);
    const totNet = itemNet - exp.byAmount;
    expect({ label, totals: rep.totals }).toEqual({
      label,
      totals: {
        netSalesCents: totNet,
        recipeCostCents: itemCost,
        grossProfitCents: totNet - itemCost,
        recipeCostBps: bps(itemCost, totNet),
      },
    });
    // The claimed cross-report invariant.
    expect({
      label,
      net: rep.totals.netSalesCents,
      cost: rep.totals.recipeCostCents,
    }).toEqual({ label, net: fc.totals.netSalesCents, cost: fc.totals.soldRecipeCents });
    // Categories are the sums of their items, each category once.
    expect(new Set(rep.categories.map((c) => c.category)).size).toBe(rep.categories.length);
    for (const c of rep.categories) {
      const of = rep.items.filter((i) => i.category === c.category);
      const net = of.reduce((s, i) => s + i.netSalesCents, 0);
      const cost = of.reduce((s, i) => s + i.recipeCostCents, 0);
      expect(c).toEqual({
        category: c.category,
        unitsSold: of.reduce((s, i) => s + i.unitsSold, 0),
        netSalesCents: net,
        recipeCostCents: cost,
        grossProfitCents: net - cost,
        recipeCostBps: bps(cost, net),
      });
    }
    expect([...new Set(rep.items.map((i) => i.category))].sort()).toEqual(
      rep.categories.map((c) => c.category).sort(),
    );
    return rep;
  };

  // ------------------------------------------------------------------ scenarios

  describe('a week of discounts, comps, meals, cash, remakes, cancellations and refunds', () => {
    let rid: string;
    let T: string;
    const days: string[] = [];
    const o: Record<string, Placed> = {};

    beforeAll(async () => {
      rid = await newRestaurant();
      T = await today(rid);
      for (let i = -4; i <= 0; i++) days.push(await addDays(T, i));

      // ---- T-3: sales with order-level discounts across several lines, a GST-free item, meals.
      const s1 = await dbNow();
      o.pct = await finished(
        rid,
        [
          ['burger', 3],
          ['cola', 2],
          ['water', 1],
        ],
        { discount: { kind: 'percent', value: 1500, reason: 'customer_service' } },
      );
      o.amt = await finished(
        rid,
        [
          ['meal', 2],
          ['burger', 1],
          ['water', 2],
        ],
        { discount: { kind: 'amount', value: 333, reason: 'customer_service' } },
      );
      o.two = await finished(rid, [['burger', 2]]);
      o.meals = await finished(rid, [['meal', 3]]);
      await shift(rid, 3, s1);

      // ---- T-1: refunds by item of T-3's sales, one unit at a time, mixed with by amount.
      const s2 = await dbNow();
      await refund(rid, o.two, byItem(top(o.two, 'Burger')));
      await refund(rid, o.pct, byItem(top(o.pct, 'Water')));
      await refund(rid, o.pct, byItem(top(o.pct, 'Burger')));
      await refund(rid, o.pct, { amountCents: 77, reason: 'other' });
      await refund(rid, o.meals, byItem(top(o.meals, 'Meal')));
      await refund(rid, o.amt, byItem(top(o.amt, 'Water')));
      await shift(rid, 1, s2);
      await drain();

      // ---- T: more refunds of old sales, plus today's own business.
      await refund(rid, o.two, byItem(top(o.two, 'Burger'))); // second of two: line fully back
      await refund(rid, o.pct, byItem(top(o.pct, 'Burger')));
      await refund(rid, o.pct, byItem(top(o.pct, 'Cola'), 2));
      await refund(rid, o.meals, byItem(top(o.meals, 'Meal')));
      await refund(rid, o.amt, { amountCents: 101, reason: 'other' });

      // Comp: 100% complimentary burger and cola, never paid.
      o.comp = await finished(
        rid,
        [
          ['burger', 1],
          ['cola', 1],
        ],
        { discount: { kind: 'percent', value: 10_000, reason: 'complimentary' }, tender: null },
      );
      // Remake: burnt after completion, remade, then handed over.
      o.remake = await ring(rid, [['burger', 1]]);
      await pay(rid, o.remake);
      await completeAll(rid, o.remake);
      const w = await h.http
        .post(`${api(rid)}/inventory/waste`)
        .set(bearer(tokens.crew))
        .set('Idempotency-Key', randomUUID())
        .send({
          kind: 'prepared_item',
          orderLineId: top(o.remake, 'Burger'),
          quantity: 1,
          reason: 'burnt',
          remake: true,
        });
      expect(w.status).toBe(201);
      await handoff(rid, o.remake);
      // Cancelled before handoff, after the kitchen started it, then the deposit refunded.
      o.cancel = await ring(rid, [
        ['burger', 1],
        ['meal', 1],
      ]);
      await pay(rid, o.cancel);
      const [task] = await tasksOf(o.cancel.id);
      await h.http
        .post(`${api(rid)}/kitchen/tasks/${task!.id}/start`)
        .set(bearer(tokens.crew))
        .send({})
        .expect(200);
      await h.http
        .post(`${api(rid)}/orders/${o.cancel.id}/cancel`)
        .set(bearer(tokens.manager))
        .send({ reason: 'customer left' })
        .expect(200);
      await refund(rid, o.cancel, { reason: 'cancelled_order' });
      // Cash with 5c rounding: 2 x 1103 + 300 + 1250 = 3756 -> 3755; refunds by item and amount.
      const session = await openSession(rid);
      try {
        o.cash = await finished(
          rid,
          [
            ['odd', 2],
            ['water', 1],
            ['meal', 1],
          ],
          {
            discount: { kind: 'percent', value: 700, reason: 'customer_service' },
            tender: { method: 'cash', tenderedCents: 10_000 },
          },
        );
        await refund(rid, o.cash, byItem(top(o.cash, 'Odd')));
        await refund(rid, o.cash, { amountCents: 33, reason: 'other' });
        await refund(rid, o.cash, byItem(top(o.cash, 'Water')));
        await drain();
      } finally {
        await closeSession(rid, session);
      }
      // Today's meals refunded one at a time, and all of one line.
      o.todayMeals = await finished(rid, [
        ['meal', 3],
        ['cola', 1],
      ]);
      await refund(rid, o.todayMeals, byItem(top(o.todayMeals, 'Meal')));
      await refund(rid, o.todayMeals, byItem(top(o.todayMeals, 'Meal')));
      await refund(rid, o.todayMeals, byItem(top(o.todayMeals, 'Cola')));
      await drain();
    });

    it('fixture sanity: dates, statuses, treatments and costs are what the scenarios need', async () => {
      const dated = await sql<{ id: string; d: string | null; status: string }>`
        select id, app.business_date(restaurant_id, completed_at)::text as d, status
          from orders where restaurant_id = ${rid}::uuid`.execute(h.owner);
      const byId = new Map(dated.rows.map((r) => [r.id, r]));
      for (const k of ['pct', 'amt', 'two', 'meals']) expect(byId.get(o[k]!.id)!.d).toBe(days[1]);
      for (const k of ['comp', 'remake', 'cash', 'todayMeals'])
        expect(byId.get(o[k]!.id)!.d).toBe(T);
      expect(byId.get(o.cancel!.id)!.status).toBe('cancelled');
      const refunds = await sql<{ d: string; t: string; c: string }>`
        select app.business_date(restaurant_id, created_at)::text as d, treatment as t,
               count(*)::text as c
          from refunds where restaurant_id = ${rid}::uuid group by 1, 2 order by 1, 2`.execute(
        h.owner,
      );
      expect(refunds.rows).toEqual([
        { d: days[3], t: 'sales_return', c: '6' },
        { d: T, t: 'deposit_release', c: '1' },
        { d: T, t: 'sales_return', c: '11' },
      ]);
      // Remake: two portions consumed on the line, one counted as the sale's recipe cost.
      const remake = await topLines(o.remake!.id);
      expect(remake[0]!.consumed).toBe(40);
      const all = await sql<{ v: string }>`
        select -sum(m.value_cents) as v from stock_movements m join order_lines l on l.id = m.source_id
         where l.order_id = ${o.remake!.id}::uuid and m.movement_type = 'production_consumption'`.execute(
        h.owner,
      );
      expect(n(all.rows[0]!.v)).toBe(80);
      // Comp: no revenue, full cost.
      const comp = await topLines(o.comp!.id);
      expect(comp.map((l) => [l.name, l.net, l.consumed])).toEqual([
        ['Burger', 0, 40],
        ['Cola', 0, 15],
      ]);
      // Cash rounding happened.
      const p = await h.owner
        .selectFrom('payments')
        .select('cash_rounding_cents')
        .where('order_id', '=', o.cash!.id)
        .executeTakeFirstOrThrow();
      expect(p.cash_rounding_cents).not.toBe(0);
    });

    it('every day on its own equals the source rows and the food cost report', async () => {
      for (const d of days) await check(rid, d, d);
    });

    it('every sub-range of the week equals the source rows and the food cost report', async () => {
      for (let i = 0; i < days.length; i++) {
        for (let j = i; j < days.length; j++) await check(rid, days[i]!, days[j]!);
      }
    });

    it('a refund-only day: the old sales are not there, their items go negative', async () => {
      const rep = await check(rid, days[3]!, days[3]!);
      const units = Object.fromEntries(rep.items.map((i) => [i.name, i.unitsSold]));
      expect(units).toEqual({ Burger: -2, Water: -2, Meal: -1 });
      expect(rep.refundsByAmountCents).toBeGreaterThan(0);
      expect(rep.totals.netSalesCents).toBeLessThan(0);
      expect(rep.totals.recipeCostBps).toBeNull();
    });

    it('over the whole week, a line refunded completely nets to exactly zero', async () => {
      // o.two: 2 burgers, refunded one at T-1 and one at T. Isolate it from the rest by subtracting
      // the model without it is not possible from the API; check it from the source model instead.
      const lines = await topLines(o.two!.id);
      const l = lines[0]!;
      const a = upTo(l.consumed, 2, 1) - upTo(l.consumed, 2, 0);
      const b = upTo(l.consumed, 2, 2) - upTo(l.consumed, 2, 1);
      expect(a + b).toBe(l.consumed);
      await check(rid, days[0]!, T);
    });
  });

  describe('access and isolation', () => {
    let a: string;
    let b: string;
    let day: string;

    beforeAll(async () => {
      a = await newRestaurant();
      b = await newRestaurant();
      tokens.otherManager = await addUser('otherManager', 'restaurant_manager', 'restaurant', b);
      day = await today(a);
      await finished(a, [['burger', 1]]);
      await finished(b, [
        ['meal', 2],
        ['burger', 5],
      ]);
      await drain();
    });

    const status = async (token: string, rid: string) =>
      (await h.http.get(`${api(rid)}/reports/menu-items?from=${day}&to=${day}`).set(bearer(token)))
        .status;

    it("another restaurant's sales in the same org never appear", async () => {
      const rep = await check(a, day, day);
      expect(rep.items.map((i) => [i.name, i.unitsSold])).toEqual([['Burger', 1]]);
      const repB = await check(b, day, day);
      expect(repB.items.map((i) => [i.name, i.unitsSold]).sort()).toEqual([
        ['Burger', 5],
        ['Meal', 2],
      ]);
    });

    it("a manager of another restaurant in the org, and another tenant's manager, get 404", async () => {
      expect(await status(tokens.otherManager, a)).toBe(404);
      expect(await status(tokens.otherManager, b)).toBe(200);
      expect(await status(await login(h, 'manager@rival.test'), a)).toBe(404);
      expect(await status(await login(h, 'manager@central.kitchos.test'), a)).toBe(404);
      expect(await status(tokens.crew, a)).toBe(403);
      expect(await status(tokens.supervisor, a)).toBe(403);
      expect(await status(tokens.manager, randomUUID())).toBe(404);
    });
  });
  // FINDING: rows are keyed by product, and a row's name and category come from whichever line the
  // controller happens to read first (the sale query in menu-item-report.controller.ts has no
  // ORDER BY). When a republished menu moves a product to another category, all of its sales land
  // in one category and the other category vanishes from the report.
  describe('one product sold under two categories (menu republished)', () => {
    it('a product moved to another category is one row, under its newest category (D-024)', async () => {
      const rid = await newRestaurant();
      const day = await today(rid);
      const menu2 = (
        await h.owner
          .insertInto('menus')
          .values({ org_id: orgId, brand_id: brandId, name: 'MIA menu 2' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await h.owner
        .updateTable('restaurants')
        .set({ menu_id: menu2 })
        .where('id', '=', rid)
        .execute();
      const version = async (v: number, category: string, price: number) => {
        const mv = await h.owner
          .insertInto('menu_versions')
          .values({ org_id: orgId, menu_id: menu2, version: v })
          .returning('id')
          .executeTakeFirstOrThrow();
        const mi = await h.owner
          .insertInto('menu_items')
          .values({
            org_id: orgId,
            menu_version_id: mv.id,
            product_id: burgerProduct.productId,
            category,
            price_cents: price,
            recipe_version_id: burgerProduct.rv,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await h.owner
          .updateTable('menu_versions')
          .set({ status: 'published', published_at: sql<Date>`now()` })
          .where('id', '=', mv.id)
          .execute();
        return mi.id;
      };
      const v1 = await version(1, 'Mains', 1100);
      await finished(rid, [[v1, 1]]);
      const v2 = await version(2, 'Grill', 1210);
      await finished(rid, [[v2, 2]]);
      await drain();
      const rep = await menuReport(rid, day, day);
      const fc = await foodCostReport(rid, day, day);
      expect(rep.totals.netSalesCents).toBe(fc.totals.netSalesCents);
      expect(rep.totals.netSalesCents).toBe(1000 + 2200);
      expect(rep.items.map((i) => [i.name, i.unitsSold, i.netSalesCents])).toEqual([
        ['Burger', 3, 3200],
      ]);
      // 1000 was sold as Mains (v1) and 2200 as Grill (v2): the product is shown as last sold.
      expect(rep.categories.map((c) => [c.category, c.netSalesCents])).toEqual([['Grill', 3200]]);
      expect(rep.items[0]!.category).toBe('Grill');
    });
  });
});
