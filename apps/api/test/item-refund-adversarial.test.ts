import { randomUUID } from 'node:crypto';
import type { LedgerReconciliation, OrderView } from '@kitchos/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import { bearer, login, startHarness, type Harness } from './harness.ts';

/**
 * Adversarial tests for refunds by item (Milestone 15). Complements prepared-waste.test.ts and
 * prepared-waste-adversarial.test.ts.
 *
 * Hygiene: everything that posts runs in a throwaway organisation with its own restaurants,
 * created here. Cash drawer sessions opened here are counted and closed before each test ends; no
 * day is closed. Demo tenants are only read, or receive requests that must be refused.
 */
describe('refunds by item (adversarial)', () => {
  let h: Harness;
  let dispatcher: EventDispatcher;
  let orgId: string;
  let brandId: string;
  let regionId: string;
  let menuId: string;
  const inv: Record<'bun' | 'cup' | 'fry' | 'nug', string> = { bun: '', cup: '', fry: '', nug: '' };
  const menuItems: Record<'burger' | 'cola' | 'fries' | 'nuggets' | 'water' | 'meal', string> = {
    burger: '',
    cola: '',
    fries: '',
    nuggets: '',
    water: '',
    meal: '',
  };
  const tokens = { manager: '', supervisor: '', crew: '' };

  // ------------------------------------------------------------------ fixture

  const buildOrg = async () => {
    const tag = randomUUID().slice(0, 8);
    orgId = (
      await h.owner
        .insertInto('organisations')
        .values({ name: `Item refund adversarial ${tag}`, slug: `ira-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await sql`select app.create_default_chart(${orgId}::uuid)`.execute(h.owner);
    brandId = (
      await h.owner
        .insertInto('brands')
        .values({ org_id: orgId, name: 'IRA', slug: `ira-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    regionId = (
      await h.owner
        .insertInto('regions')
        .values({ org_id: orgId, name: 'IRA region' })
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
    inv.fry = await addInv('FRY', '12');
    inv.nug = await addInv('NUG', '10.333');
    menuId = (
      await h.owner
        .insertInto('menus')
        .values({ org_id: orgId, brand_id: brandId, name: 'IRA menu' })
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
          category: 'All',
          price_cents: price,
          recipe_version_id: rv,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { menuItemId: mi.id, productId: pid, rv };
    };
    const burger = await simple('Burger', 1100, inv.bun, 'task_started');
    const cola = await simple('Cola', 330, inv.cup, 'order_accepted');
    const fries = await simple('Fries', 400, inv.fry, 'task_completed');
    const nuggets = await simple('Nuggets', 600, inv.nug, 'task_started');
    // A GST-free product (e.g. bottled water in some jurisdictions).
    const water = await simple('Water', 300, inv.cup, 'order_accepted', false);
    menuItems.burger = burger.menuItemId;
    menuItems.cola = cola.menuItemId;
    menuItems.fries = fries.menuItemId;
    menuItems.nuggets = nuggets.menuItemId;
    menuItems.water = water.menuItemId;
    const mealProduct = await product('Meal', 'combo');
    const meal = await h.owner
      .insertInto('menu_items')
      .values({
        org_id: orgId,
        menu_version_id: mv.id,
        product_id: mealProduct,
        category: 'All',
        price_cents: 1501,
        recipe_version_id: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    menuItems.meal = meal.id;
    for (const [i, c] of [burger, cola, fries].entries()) {
      await h.owner
        .insertInto('combo_components')
        .values({
          org_id: orgId,
          menu_item_id: meal.id,
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

    const { password_hash } = await h.owner
      .selectFrom('users')
      .select('password_hash')
      .where('email', '=', 'manager@central.kitchos.test')
      .executeTakeFirstOrThrow();
    const roles: Record<keyof typeof tokens, string> = {
      manager: 'restaurant_manager',
      supervisor: 'shift_supervisor',
      crew: 'crew_member',
    };
    for (const [k, role] of Object.entries(roles) as [keyof typeof tokens, string][]) {
      const email = `${k}-${tag}@ira.test`;
      const user = await h.owner
        .insertInto('users')
        .values({ org_id: orgId, email, display_name: `IRA ${k}`, password_hash })
        .returning('id')
        .executeTakeFirstOrThrow();
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

  const newRestaurant = async (opts: { cashIncrement?: number } = {}) => {
    const slug = `ira-${randomUUID().slice(0, 8)}`;
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
        ...(opts.cashIncrement !== undefined
          ? { cash_rounding_increment_cents: opts.cashIncrement }
          : {}),
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
    return r.id;
  };

  beforeAll(async () => {
    h = await startHarness();
    dispatcher = h.app.get(EventDispatcher);
    await buildOrg();
  });

  afterAll(async () => {
    await drain();
    // Hygiene: nothing left open or dead in this tenant.
    const open = await h.owner
      .selectFrom('drawer_sessions')
      .select('id')
      .where('org_id', '=', orgId)
      .where('status', '<>', 'closed')
      .execute();
    const dead = await h.owner
      .selectFrom('event_consumer_failures as f')
      .innerJoin('outbox_events as o', 'o.id', 'f.event_id')
      .select('f.event_id')
      .where('o.org_id', '=', orgId)
      .execute();
    await h.close();
    expect({ open, dead }).toEqual({ open: [], dead: [] });
  });

  // ------------------------------------------------------------------ helpers

  const api = (rid: string) => `/v1/restaurants/${rid}`;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const drain = async () => {
    for (let i = 0; i < 50; i++) {
      if ((await dispatcher.runOnce()).processed === 0) return;
    }
  };

  type Item = keyof typeof menuItems;
  interface Placed {
    id: string;
    lines: { id: string; name: string; kind: string; parent: string | null; quantity: number }[];
  }
  const CARD = { method: 'card', paymentToken: 'tok_sandbox_approve' };

  const ring = async (rid: string, items: [Item, number][]): Promise<Placed> => {
    const res = await h.http
      .post(`${api(rid)}/orders`)
      .set(bearer(tokens.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({
        fulfilmentType: 'dine_in',
        lines: items.map(([n, quantity]) => ({ menuItemId: menuItems[n], quantity })),
      });
    if (res.status !== 201) throw new Error(`ring ${res.status} ${JSON.stringify(res.body)}`);
    const lines = await h.owner
      .selectFrom('order_lines')
      .select(['id', 'name', 'kind', 'parent_line_id as parent', 'quantity'])
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
    return res.body as OrderView;
  };
  const pay = async (rid: string, o: Placed, tender: object = CARD) => {
    const res = await h.http
      .post(`${api(rid)}/orders/${o.id}/payments`)
      .set(bearer(tokens.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send(tender);
    if (res.status !== 200) throw new Error(`pay ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as OrderView;
  };
  const order = async (
    rid: string,
    items: [Item, number][],
    opts: { discount?: object; tender?: object } = {},
  ) => {
    const o = await ring(rid, items);
    if (opts.discount) await discount(rid, o, opts.discount);
    await pay(rid, o, opts.tender ?? CARD);
    return o;
  };
  const taskOf = async (lineId: string) =>
    (
      await h.owner
        .selectFrom('kitchen_tasks')
        .select('id')
        .where('order_line_id', '=', lineId)
        .executeTakeFirstOrThrow()
    ).id;
  const start = async (rid: string, lineId: string) =>
    h.http
      .post(`${api(rid)}/kitchen/tasks/${await taskOf(lineId)}/start`)
      .set(bearer(tokens.crew))
      .send({});
  const complete = async (rid: string, lineId: string) =>
    h.http
      .post(`${api(rid)}/kitchen/tasks/${await taskOf(lineId)}/complete`)
      .set(bearer(tokens.crew))
      .send({});
  const producible = (o: Placed) => o.lines.filter((x) => x.kind !== 'combo');
  const completeAll = async (rid: string, o: Placed) => {
    for (const l of producible(o)) expect((await complete(rid, l.id)).status).toBe(200);
  };
  const handoff = (rid: string, o: Placed) =>
    h.http
      .post(`${api(rid)}/orders/${o.id}/handoff`)
      .set(bearer(tokens.crew))
      .expect(200);
  const finished = async (
    rid: string,
    items: [Item, number][],
    opts: { discount?: object; tender?: object } = {},
  ) => {
    const o = await order(rid, items, opts);
    await completeAll(rid, o);
    await handoff(rid, o);
    return o;
  };
  const cancel = (rid: string, o: Placed, body: object = {}) =>
    h.http
      .post(`${api(rid)}/orders/${o.id}/cancel`)
      .set(bearer(tokens.manager))
      .send({ reason: 'Adversarial cancel', ...body });
  /** Top-level line by name (an item, or the whole meal). */
  const top = (o: Placed, name: string) =>
    o.lines.find((l) => l.name === name && l.parent === null)!.id;
  const component = (o: Placed, name: string) =>
    o.lines.find((l) => l.name === name && l.parent !== null)!.id;
  const refund = (
    rid: string,
    o: Placed,
    body: object,
    key = randomUUID(),
    token = tokens.supervisor,
  ) =>
    h.http
      .post(`${api(rid)}/orders/${o.id}/refunds`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send({ reason: 'quality', ...body });
  const items = (...xs: [string, number][]) => ({
    items: xs.map(([orderLineId, quantity]) => ({ orderLineId, quantity })),
  });
  const view = async (rid: string, o: Placed) =>
    (
      await h.http
        .get(`${api(rid)}/orders/${o.id}`)
        .set(bearer(tokens.manager))
        .expect(200)
    ).body as OrderView;

  const paymentOf = (o: Placed) =>
    h.owner
      .selectFrom('payments')
      .select(['status', 'amount_cents', 'refunded_cents', 'cash_rounding_cents', 'method'])
      .where('order_id', '=', o.id)
      .where('captured_at', 'is not', null)
      .executeTakeFirst();
  const refundsOf = (o: Placed) =>
    h.owner
      .selectFrom('refunds')
      .select([
        'id',
        'amount_cents',
        'refunded_before_cents',
        'cash_rounding_cents',
        'treatment',
        'reason',
      ])
      .where('order_id', '=', o.id)
      .orderBy('refunded_before_cents')
      .execute();
  const refundLinesOf = (o: Placed) =>
    h.owner
      .selectFrom('refund_lines as r')
      .innerJoin('order_lines as l', 'l.id', 'r.order_line_id')
      .select(['r.refund_id', 'r.order_line_id', 'r.quantity', 'r.amount_cents', 'l.name'])
      .where('l.order_id', '=', o.id)
      .execute();
  const orderRow = (o: Placed) =>
    h.owner
      .selectFrom('orders')
      .select(['status', 'total_cents', 'tax_cents', 'discount_cents'])
      .where('id', '=', o.id)
      .executeTakeFirstOrThrow();
  const lineNets = async (o: Placed) =>
    Object.fromEntries(
      (
        await h.owner
          .selectFrom('order_lines')
          .select(['id', 'line_total_cents', 'discount_cents', 'quantity', 'taxable'])
          .where('order_id', '=', o.id)
          .where('parent_line_id', 'is', null)
          .execute()
      ).map((l) => [l.id, { net: l.line_total_cents - l.discount_cents, qty: l.quantity }]),
    );

  /** Waste records against an order's lines (rejected excluded), portions per line name. */
  const wastedPortions = async (o: Placed) => {
    const rows = await h.owner
      .selectFrom('waste_records as w')
      .innerJoin('order_lines as l', 'l.id', 'w.order_line_id')
      .select(['l.name', 'w.quantity', 'w.status'])
      .where('l.order_id', '=', o.id)
      .execute();
    const out: Record<string, number> = {};
    for (const w of rows) {
      if (w.status === 'rejected') continue;
      out[w.name] = (out[w.name] ?? 0) + Number(w.quantity);
    }
    return out;
  };
  const wasteRecordCount = async (o: Placed) =>
    (
      await h.owner
        .selectFrom('waste_records as w')
        .innerJoin('order_lines as l', 'l.id', 'w.order_line_id')
        .select('w.id')
        .where('l.order_id', '=', o.id)
        .execute()
    ).length;

  /** Journal lines of one refund's entry, net debit by account key. */
  const refundEntry = async (refundId: string) => {
    const rows = await h.owner
      .selectFrom('journal_lines as l')
      .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['a.system_key', 'l.debit_cents', 'l.credit_cents'])
      .where('e.source_type', '=', 'refund')
      .where('e.source_id', '=', refundId)
      .execute();
    const out: Record<string, number> = {};
    for (const r of rows) {
      const k = r.system_key ?? '?';
      out[k] = (out[k] ?? 0) + Number(r.debit_cents) - Number(r.credit_cents);
    }
    return out;
  };

  const accountNet = async (rid: string, key: string) =>
    Number(
      (
        await h.owner
          .selectFrom('journal_lines as l')
          .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
          .innerJoin('accounts as a', 'a.id', 'l.account_id')
          .select(sql<string>`coalesce(sum(l.debit_cents - l.credit_cents), 0)`.as('net'))
          .where('e.restaurant_id', '=', rid)
          .where('a.system_key', '=', key)
          .executeTakeFirstOrThrow()
      ).net,
    );
  const consumedValue = async (rid: string) =>
    -Number(
      (
        await h.owner
          .selectFrom('stock_movements')
          .select(sql<string>`coalesce(sum(value_cents), 0)`.as('v'))
          .where('restaurant_id', '=', rid)
          .where('movement_type', '=', 'production_consumption')
          .executeTakeFirstOrThrow()
      ).v,
    );
  const liveWasteCost = async (rid: string) =>
    Number(
      (
        await h.owner
          .selectFrom('waste_records')
          .select(sql<string>`coalesce(sum(cost_cents), 0)`.as('c'))
          .where('restaurant_id', '=', rid)
          .where('status', '<>', 'rejected')
          .executeTakeFirstOrThrow()
      ).c,
    );
  const books = async (rid: string) => ({
    cogs: await accountNet(rid, 'cogs'),
    waste: await accountNet(rid, 'waste_expense'),
    inventory: await accountNet(rid, 'inventory'),
  });
  const today = async (rid: string) =>
    (
      await sql<{ d: string }>`select app.business_date(${rid}::uuid, now())::text as d`.execute(
        h.owner,
      )
    ).rows[0]!.d;
  const reconciliation = async (rid: string) =>
    (
      await h.http
        .get(`${api(rid)}/accounting/reconciliation?businessDate=${await today(rid)}`)
        .set(bearer(tokens.manager))
        .expect(200)
    ).body as LedgerReconciliation;
  const failuresAt = (rid: string) =>
    h.owner
      .selectFrom('event_consumer_failures as f')
      .innerJoin('outbox_events as o', 'o.id', 'f.event_id')
      .select(['o.event_type', 'f.last_error'])
      .where('o.restaurant_id', '=', rid)
      .execute();
  /** After dispatch: the day reconciles per tender and per entry; COGS + Waste = consumed. */
  const assertBooksClean = async (rid: string) => {
    await drain();
    expect(await failuresAt(rid)).toEqual([]);
    const rec = await reconciliation(rid);
    expect({
      reconciled: rec.reconciled,
      pending: rec.pendingEvents,
      dead: rec.deadLetteredEvents,
      refunds: rec.journalRefundsCents,
      card: rec.journalCardClearingCents,
      cash: rec.journalCashOnHandCents,
      rounding: rec.journalCashRoundingCents,
      stock: rec.journalInventoryCents,
      unmatchedReceipts: rec.unmatchedReceipts,
      unmatchedRefunds: rec.unmatchedRefunds,
    }).toEqual({
      reconciled: true,
      pending: 0,
      dead: 0,
      refunds: rec.refundsCents,
      card: rec.cardNetCents,
      cash: rec.cashNetCents,
      rounding: rec.cashRoundingCents,
      stock: rec.stockMovementsValueCents,
      unmatchedReceipts: 0,
      unmatchedRefunds: 0,
    });
    const consumed = await consumedValue(rid);
    const live = await liveWasteCost(rid);
    expect(await books(rid)).toEqual({
      cogs: consumed - live,
      waste: live,
      inventory: -consumed,
    });
    return { consumed, live };
  };
  /** Payment, refund rows and refund lines agree with each other and never exceed the payment. */
  const assertMoneyConsistent = async (o: Placed) => {
    const p = await paymentOf(o);
    const rs = await refundsOf(o);
    const rls = await refundLinesOf(o);
    const sum = rs.reduce((s, r) => s + r.amount_cents, 0);
    expect(p!.refunded_cents).toBe(sum);
    expect(sum).toBeLessThanOrEqual(p!.amount_cents);
    expect(p!.status).toBe(
      sum === 0 ? 'captured' : sum === p!.amount_cents ? 'refunded' : 'partially_refunded',
    );
    // refunded_before is the running total in order.
    let before = 0;
    for (const r of rs) {
      expect(r.refunded_before_cents).toBe(before);
      before += r.amount_cents;
    }
    // Each item refund's amount equals its lines; no line is refunded beyond its quantity or net.
    for (const r of rs) {
      const mine = rls.filter((l) => l.refund_id === r.id);
      if (mine.length) expect(mine.reduce((s, l) => s + l.amount_cents, 0)).toBe(r.amount_cents);
    }
    const nets = await lineNets(o);
    const per = new Map<string, { q: number; c: number }>();
    for (const l of rls) {
      const x = per.get(l.order_line_id) ?? { q: 0, c: 0 };
      per.set(l.order_line_id, { q: x.q + l.quantity, c: x.c + l.amount_cents });
    }
    for (const [id, x] of per) {
      expect(x.q).toBeLessThanOrEqual(nets[id]!.qty);
      expect(x.c).toBeLessThanOrEqual(nets[id]!.net);
      if (x.q === nets[id]!.qty) expect(x.c).toBe(nets[id]!.net);
    }
    return { payment: p!, refunds: rs, lines: rls };
  };

  // Cash drawers (the supervisor's own session).
  const openSession = async (rid: string, float = 20_000) => {
    const drawers = (
      await h.http
        .get(`${api(rid)}/cash/drawers`)
        .set(bearer(tokens.supervisor))
        .expect(200)
    ).body as { id: string; activeSession: { id: string } | null }[];
    const res = await h.http
      .post(`${api(rid)}/cash/drawers/${drawers[0]!.id}/sessions`)
      .set(bearer(tokens.supervisor))
      .send({ openingFloatCents: float });
    if (res.status !== 201) throw new Error(`open ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  };
  const closeSessionExact = async (rid: string, sessionId: string) => {
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
    expect({ status: res.body.status, variance: res.body.varianceCents }).toEqual({
      status: 'closed',
      variance: 0,
    });
    return s.expected;
  };

  // ------------------------------------------------------------------ 1. money

  describe('1. money', () => {
    let rid: string;
    beforeAll(async () => {
      rid = await newRestaurant();
    });

    it('a line refunded one unit at a time returns exactly its net; each unit is floor or ceil', async () => {
      // An amount discount of 10c over 1800 + 330 leaves Nuggets a net not divisible by 3.
      const o = await finished(
        rid,
        [
          ['nuggets', 3],
          ['cola', 1],
        ],
        { discount: { kind: 'amount', value: 10, reason: 'customer_service' } },
      );
      const nug = top(o, 'Nuggets');
      const nets = await lineNets(o);
      const net = nets[nug]!.net;
      for (let i = 0; i < 3; i++) {
        expect((await refund(rid, o, items([nug, 1]))).status).toBe(201);
      }
      const rows = await refundsOf(o);
      const units = rows.map((r) => r.amount_cents);
      expect(units.reduce((s, x) => s + x, 0)).toBe(net);
      for (const u of units) expect([Math.floor(net / 3), Math.ceil(net / 3)]).toContain(u);
      // A fourth unit is refused and writes nothing.
      const more = await refund(rid, o, items([nug, 1]));
      expect(more.status).toBe(422);
      expect(more.body.error.code).toBe('REFUND_EXCEEDS_LINE');
      expect((await refundsOf(o)).length).toBe(3);
      // The view: net and refunded quantities, items per refund.
      const v = await view(rid, o);
      expect(v.lines.find((l) => l.id === nug)).toMatchObject({
        netCents: net,
        refundedQuantity: 3,
      });
      expect(v.lines.find((l) => l.name === 'Cola')).toMatchObject({ refundedQuantity: 0 });
      expect(
        v.refunds.flatMap((r) => r.items).every((i) => i.name === 'Nuggets' && i.quantity === 1),
      ).toBe(true);
      // The cola line, then the order is fully refunded and equals the payment exactly.
      expect((await refund(rid, o, items([top(o, 'Cola'), 1]))).status).toBe(201);
      const { payment } = await assertMoneyConsistent(o);
      expect(payment).toMatchObject({ status: 'refunded', refunded_cents: payment.amount_cents });
      expect(payment.amount_cents).toBe((await orderRow(o)).total_cents);
      expect(await wastedPortions(o)).toEqual({ Nuggets: 3, Cola: 1 });
    });

    it('percent discount: a full refund by items equals the payment and the GST at full refund equals the order GST', async () => {
      const o = await finished(
        rid,
        [
          ['burger', 3],
          ['fries', 1],
          ['meal', 1],
        ],
        { discount: { kind: 'percent', value: 1250, reason: 'promotion' } },
      );
      const ord = await orderRow(o);
      expect(ord.discount_cents).toBeGreaterThan(0);
      for (const [name, n] of [
        ['Burger', 1],
        ['Meal', 1],
        ['Burger', 2],
        ['Fries', 1],
      ] as const) {
        const r = await refund(rid, o, items([top(o, name), n]));
        expect({ name, status: r.status }).toEqual({ name, status: 201 });
      }
      const { payment, refunds } = await assertMoneyConsistent(o);
      expect(payment.status).toBe('refunded');
      expect(payment.refunded_cents).toBe(ord.total_cents);
      await drain();
      let gst = 0;
      let returns = 0;
      for (const r of refunds) {
        const e = await refundEntry(r.id);
        gst += e.gst_payable ?? 0;
        returns += e.sales_returns ?? 0;
        expect(e.card_clearing).toBe(-r.amount_cents);
      }
      expect({ gst, returns }).toEqual({
        gst: ord.tax_cents,
        returns: ord.total_cents - ord.tax_cents,
      });
      await assertBooksClean(rid);
    });

    it('comps: a fully complimentary order and a zero-net line are refused, nothing is written', async () => {
      // 100% complimentary: nothing paid, the order is accepted without payment.
      const comp = await ring(rid, [['burger', 1]]);
      const v = await discount(rid, comp, {
        kind: 'percent',
        value: 10_000,
        reason: 'complimentary',
      });
      expect(v.totalCents).toBe(0);
      await completeAll(rid, comp);
      await handoff(rid, comp);
      const r = await refund(rid, comp, items([top(comp, 'Burger'), 1]));
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(await refundsOf(comp)).toEqual([]);
      expect(await refundLinesOf(comp)).toEqual([]);
      expect(await wasteRecordCount(comp)).toBe(0);

      // An amount discount of subtotal − 1: one line nets 0, the other 1 cent.
      const o = await ring(rid, [
        ['burger', 1],
        ['cola', 1],
      ]);
      await discount(rid, o, { kind: 'amount', value: 1429, reason: 'customer_service' });
      await pay(rid, o);
      await completeAll(rid, o);
      await handoff(rid, o);
      const nets = await lineNets(o);
      const zero = Object.entries(nets).find(([, x]) => x.net === 0)![0];
      const one = Object.entries(nets).find(([, x]) => x.net === 1)![0];
      const z = await refund(rid, o, items([zero, 1]));
      expect(z.status).toBe(422);
      expect(z.body.error.code).toBe('NOTHING_TO_REFUND');
      expect(await refundsOf(o)).toEqual([]);
      expect(await wasteRecordCount(o)).toBe(0);
      expect(await paymentOf(o)).toMatchObject({ status: 'captured', refunded_cents: 0 });
      // Both lines together: 1 cent, and both lines' food is waste.
      const both = await refund(rid, o, items([zero, 1], [one, 1]));
      expect(both.status).toBe(201);
      const { refunds } = await assertMoneyConsistent(o);
      expect(refunds.map((x) => x.amount_cents)).toEqual([1]);
      expect(await wastedPortions(o)).toEqual({ Burger: 1, Cola: 1 });
      await assertBooksClean(rid);
    });

    // FINDING: a refund by item of a GST-free item reverses GST it never carried, and a later refund
    // of the taxable item reverses too little. The sales-return GST is the order-proportional share
    // (refundGstShare, packages/domain/src/postings.ts:171-181, used by
    // apps/api/src/accounting/ledger.consumer.ts:177-186 with the order's total and tax), not the
    // GST of the refunded lines, although refund_lines now say exactly which lines were returned.
    // Known as R-019 (docs/RISKS.md:37), whose stated mitigation is line-level returns — which
    // Milestone 15 delivers without using them for GST.
    // Repro: Burger (1100, taxable) + Water (300, GST-free), card. Refund Water by item: the entry
    // debits gst_payable with a share of the order's GST (expected 0); refund Burger by item: the
    // entry debits less than the burger's GST.
    it('GST on a refund by item follows the refunded lines (GST-free item returns no GST)', async () => {
      const o = await finished(rid, [
        ['burger', 1],
        ['water', 1],
      ]);
      const taxable = await h.owner
        .selectFrom('order_lines')
        .select(['name', 'taxable'])
        .where('order_id', '=', o.id)
        .orderBy('name')
        .execute();
      expect(taxable).toEqual([
        { name: 'Burger', taxable: true },
        { name: 'Water', taxable: false },
      ]);
      const ord = await orderRow(o);
      expect(ord.tax_cents).toBeGreaterThan(0);
      expect((await refund(rid, o, items([top(o, 'Water'), 1]))).status).toBe(201);
      expect((await refund(rid, o, items([top(o, 'Burger'), 1]))).status).toBe(201);
      await drain();
      const [water, burger] = await refundsOf(o);
      const gstWater = (await refundEntry(water!.id)).gst_payable ?? 0;
      const gstBurger = (await refundEntry(burger!.id)).gst_payable ?? 0;
      expect(gstWater + gstBurger).toBe(ord.tax_cents);
      expect({ gstWater, gstBurger }).toEqual({ gstWater: 0, gstBurger: ord.tax_cents });
    });
  });

  // ------------------------------------------------------------------ 2. cash

  describe('2. cash', () => {
    it('item refunds hand back cash rounded on the running total; cumulative with an earlier amount refund; drawer balances', async () => {
      const rid = await newRestaurant({ cashIncrement: 10 });
      const session = await openSession(rid);
      try {
        // 12.5% off 3 x 1100 + 330 = 3630 -> 3176 total, 3180 cash.
        const o = await finished(
          rid,
          [
            ['burger', 3],
            ['cola', 1],
          ],
          {
            discount: { kind: 'percent', value: 1250, reason: 'promotion' },
            tender: { method: 'cash', tenderedCents: 5000 },
          },
        );
        const p0 = (await paymentOf(o))!;
        const cashPaid = p0.amount_cents + p0.cash_rounding_cents;
        expect(cashPaid % 10).toBe(0);
        for (const [name, n] of [
          ['Burger', 1],
          ['Cola', 1],
          ['Burger', 1],
          ['Burger', 1],
        ] as const) {
          const r = await refund(rid, o, items([top(o, name), n]));
          expect({ name, status: r.status, body: r.status === 201 ? null : r.body }).toEqual({
            name,
            status: 201,
            body: null,
          });
        }
        const { refunds, payment } = await assertMoneyConsistent(o);
        expect(payment.status).toBe('refunded');
        const handed = refunds.map((r) => r.amount_cents + r.cash_rounding_cents);
        for (const x of handed) expect(x % 10).toBe(0);
        expect(handed.reduce((s, x) => s + x, 0)).toBe(cashPaid);

        // An amount refund first, then items: items cannot take the total past the payment.
        const m = await finished(
          rid,
          [
            ['burger', 2],
            ['fries', 1],
          ],
          { tender: { method: 'cash', tenderedCents: 5000 } },
        );
        const pm = (await paymentOf(m))!;
        expect((await refund(rid, m, { amountCents: 7, reason: 'other' })).status).toBe(201);
        expect(await wasteRecordCount(m)).toBe(0); // money only
        expect((await refund(rid, m, items([top(m, 'Burger'), 2]))).status).toBe(201);
        // 400 Fries but only 393 left: refused, nothing written.
        const last = await refund(rid, m, items([top(m, 'Fries'), 1]));
        expect(last.status).toBe(422);
        expect(last.body.error.code).toBe('REFUND_EXCEEDS_PAYMENT');
        expect(await wastedPortions(m)).toEqual({ Burger: 2 });
        // The rest by amount: the last cent, then nothing.
        expect((await refund(rid, m, { reason: 'other' })).status).toBe(201);
        const after = await assertMoneyConsistent(m);
        expect(after.payment).toMatchObject({
          status: 'refunded',
          refunded_cents: pm.amount_cents,
        });
        const handedM = after.refunds.reduce(
          (s, r) => s + r.amount_cents + r.cash_rounding_cents,
          0,
        );
        expect(handedM).toBe(pm.amount_cents + pm.cash_rounding_cents);
        expect((await refund(rid, m, items([top(m, 'Fries'), 1]))).status).toBe(409);
      } finally {
        await closeSessionExact(rid, session);
      }
      await assertBooksClean(rid);
    });
  });

  // ------------------------------------------------------------------ 3. mixing

  describe('3. mixing', () => {
    it('items then an amount (defaults to the rest); the last cent; then nothing more by item', async () => {
      const rid = await newRestaurant();
      const o = await finished(rid, [
        ['burger', 2],
        ['cola', 1],
      ]);
      expect((await refund(rid, o, items([top(o, 'Burger'), 1]))).status).toBe(201);
      // All but one cent by amount.
      const p = (await paymentOf(o))!;
      expect(
        (await refund(rid, o, { amountCents: p.amount_cents - 1100 - 1, reason: 'other' })).status,
      ).toBe(201);
      // Any item now exceeds what is left.
      const r = await refund(rid, o, items([top(o, 'Cola'), 1]));
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('REFUND_EXCEEDS_PAYMENT');
      expect((await refund(rid, o, { amountCents: 2, reason: 'other' })).status).toBe(422);
      expect((await refund(rid, o, { amountCents: 1, reason: 'other' })).status).toBe(201);
      const { payment } = await assertMoneyConsistent(o);
      expect(payment.status).toBe('refunded');
      expect((await refund(rid, o, items([top(o, 'Burger'), 1]))).status).toBe(409);
      expect(await wastedPortions(o)).toEqual({ Burger: 1 });
      await assertBooksClean(rid);
    });
  });

  // ------------------------------------------------------------------ 4. races

  describe('4. races', () => {
    const STAGGER = [0, 3, 8, 15];

    it('two item refunds of the same line: never more units or cents than the line', async () => {
      const rid = await newRestaurant();
      const outcomes: string[] = [];
      for (const ms of STAGGER) {
        const o = await finished(rid, [
          ['burger', 3],
          ['cola', 1],
        ]);
        const b = top(o, 'Burger');
        const [a, c] = await Promise.all([
          refund(rid, o, items([b, 2])),
          sleep(ms).then(() => refund(rid, o, items([b, 2]))),
        ]);
        outcomes.push(`${a.status}/${c.status}`);
        expect([a.status, c.status].filter((s) => s === 201)).toHaveLength(1);
        expect([a.status, c.status].find((s) => s !== 201)).toBe(422);
        const { lines } = await assertMoneyConsistent(o);
        expect(lines.reduce((s, l) => s + l.quantity, 0)).toBe(2);
        expect(await wastedPortions(o)).toEqual({ Burger: 2 });
        // The last unit, both in parallel: one wins.
        const [x, y] = await Promise.all([
          refund(rid, o, items([b, 1])),
          sleep(ms).then(() => refund(rid, o, items([b, 1]))),
        ]);
        expect([x.status, y.status].sort()).toEqual([201, 422]);
        const after = await assertMoneyConsistent(o);
        expect(
          after.lines.filter((l) => l.order_line_id === b).reduce((s, l) => s + l.amount_cents, 0),
        ).toBe((await lineNets(o))[b]!.net);
        expect(await wastedPortions(o)).toEqual({ Burger: 3 });
      }
      console.log(`item vs item: ${outcomes.join(' ')}`);
      await assertBooksClean(rid);
    });

    it('an item refund racing an amount refund: the total never exceeds the payment', async () => {
      const rid = await newRestaurant();
      const outcomes: string[] = [];
      for (const ms of [...STAGGER, -3, -8]) {
        const o = await finished(rid, [['burger', 2]]);
        const [it1, am] = await Promise.all([
          sleep(Math.max(0, -ms)).then(() => refund(rid, o, items([top(o, 'Burger'), 2]))),
          sleep(Math.max(0, ms)).then(() => refund(rid, o, { amountCents: 100, reason: 'other' })),
        ]);
        outcomes.push(`${it1.status}/${am.status}`);
        // Items first take everything (the amount is then 409); the amount first leaves 2100,
        // less than the two burgers (the items are then 422). Exactly one wins.
        expect([it1.status, am.status].filter((s) => s === 201)).toHaveLength(1);
        if (it1.status !== 201) expect(it1.status).toBe(422);
        if (am.status !== 201) expect(am.status).toBe(409);
        const { payment, refunds } = await assertMoneyConsistent(o);
        expect(refunds.map((r) => r.amount_cents)).toEqual([it1.status === 201 ? 2200 : 100]);
        expect(payment.refunded_cents).toBeLessThanOrEqual(payment.amount_cents);
        expect(await wastedPortions(o)).toEqual(it1.status === 201 ? { Burger: 2 } : {});
      }
      console.log(`item vs amount: ${outcomes.join(' ')}`);
      await assertBooksClean(rid);
    });

    it('an item refund racing a cancel of a ready order: food is waste once; refund only after the cancel', async () => {
      const rid = await newRestaurant();
      const outcomes: string[] = [];
      for (const ms of [...STAGGER, -3, -8]) {
        const o = await order(rid, [['burger', 2]]);
        await completeAll(rid, o);
        const [c, r] = await Promise.all([
          sleep(Math.max(0, -ms)).then(() => cancel(rid, o)),
          sleep(Math.max(0, ms)).then(() => refund(rid, o, items([top(o, 'Burger'), 1]))),
        ]);
        outcomes.push(`${c.status}/${r.status}`);
        expect(c.status).toBe(200);
        expect([201, 409]).toContain(r.status);
        const { refunds } = await assertMoneyConsistent(o);
        if (r.status === 201) expect(refunds.map((x) => x.treatment)).toEqual(['deposit_release']);
        else expect(refunds).toEqual([]);
        expect(await wastedPortions(o)).toEqual({ Burger: 2 });
        // The rest of the deposit by item: no new waste.
        const n = r.status === 201 ? 1 : 2;
        expect((await refund(rid, o, items([top(o, 'Burger'), n]))).status).toBe(201);
        expect((await assertMoneyConsistent(o)).payment.status).toBe('refunded');
        expect(await wastedPortions(o)).toEqual({ Burger: 2 });
      }
      console.log(`cancel vs item refund: ${outcomes.join(' ')}`);
      await assertBooksClean(rid);
      expect((await books(rid)).cogs).toBe(0);
    });
  });

  // ------------------------------------------------------------------ 5. meals

  describe('5. meals', () => {
    let rid: string;
    beforeAll(async () => {
      rid = await newRestaurant();
    });

    it('a meal x2 refunded one at a time: one portion of each component each time, net exact', async () => {
      const o = await finished(rid, [['meal', 2]]);
      const meal = top(o, 'Meal');
      expect((await refund(rid, o, items([meal, 1]))).status).toBe(201);
      expect(await wastedPortions(o)).toEqual({ Burger: 1, Cola: 1, Fries: 1 });
      expect((await refund(rid, o, items([meal, 1]))).status).toBe(201);
      expect(await wastedPortions(o)).toEqual({ Burger: 2, Cola: 2, Fries: 2 });
      const { payment, refunds } = await assertMoneyConsistent(o);
      expect(payment.status).toBe('refunded');
      expect(refunds.map((r) => r.amount_cents).sort()).toEqual([1501, 1501]);
    });

    it('a component line id is refused, nothing written', async () => {
      const o = await finished(rid, [['meal', 1]]);
      for (const name of ['Burger', 'Cola', 'Fries']) {
        const r = await refund(rid, o, items([component(o, name), 1]));
        expect({ name, status: r.status, code: r.body.error?.code }).toEqual({
          name,
          status: 422,
          code: 'REFUND_LINE_INVALID',
        });
      }
      // Mixed with a valid line: still refused as a whole.
      const mixed = await refund(rid, o, items([top(o, 'Meal'), 1], [component(o, 'Fries'), 1]));
      expect(mixed.status).toBe(422);
      expect(await refundsOf(o)).toEqual([]);
      expect(await wasteRecordCount(o)).toBe(0);
      expect(await paymentOf(o)).toMatchObject({ status: 'captured', refunded_cents: 0 });
    });

    it('a cancelled meal x2 (nothing recorded on cancel), components consumed at different points', async () => {
      const o = await order(rid, [['meal', 2]]);
      // Cola consumed at acceptance, Burger at start; Fries never made.
      expect((await start(rid, component(o, 'Burger'))).status).toBe(200);
      const zeros = await cancel(rid, o, {
        waste: [
          { orderLineId: component(o, 'Burger'), quantity: 0 },
          { orderLineId: component(o, 'Cola'), quantity: 0 },
        ],
      });
      expect(zeros.status).toBe(200);
      expect(await wastedPortions(o)).toEqual({});
      const meal = top(o, 'Meal');
      expect((await refund(rid, o, items([meal, 1]))).status).toBe(201);
      expect(await wastedPortions(o)).toEqual({ Burger: 1, Cola: 1 });
      expect((await refund(rid, o, items([meal, 1]))).status).toBe(201);
      expect(await wastedPortions(o)).toEqual({ Burger: 2, Cola: 2 });
      const { refunds, payment } = await assertMoneyConsistent(o);
      expect(payment.status).toBe('refunded');
      expect(refunds.map((r) => r.treatment)).toEqual(['deposit_release', 'deposit_release']);
    });

    it('a cancelled order whose food was recorded on cancel: refunds by item record nothing more', async () => {
      const o = await order(rid, [
        ['burger', 2],
        ['meal', 1],
      ]);
      await completeAll(rid, o);
      expect((await cancel(rid, o)).status).toBe(200);
      const before = await wastedPortions(o);
      expect(before).toEqual({ Burger: 3, Cola: 1, Fries: 1 });
      const n = await wasteRecordCount(o);
      expect((await refund(rid, o, items([top(o, 'Burger'), 1], [top(o, 'Meal'), 1]))).status).toBe(
        201,
      );
      expect((await refund(rid, o, items([top(o, 'Burger'), 1]))).status).toBe(201);
      expect(await wastedPortions(o)).toEqual(before);
      expect(await wasteRecordCount(o)).toBe(n);
      expect((await assertMoneyConsistent(o)).payment.status).toBe('refunded');
    });

    it('books: COGS of every refunded portion moved to Waste exactly; the day reconciles', async () => {
      const { consumed, live } = await assertBooksClean(rid);
      // Every order above was fully refunded or cancelled except the component-refusal meal.
      expect(consumed - live).toBe(40 + 15 + 12);
    });
  });

  // ------------------------------------------------------------------ 6. idempotency

  describe('6. idempotency', () => {
    it('replay with the same key and body is one refund; same key with other items is 422', async () => {
      const rid = await newRestaurant();
      const o = await finished(rid, [['burger', 3]]);
      const b = top(o, 'Burger');
      const key = randomUUID();
      const results = await Promise.all([0, 1, 2].map(() => refund(rid, o, items([b, 1]), key)));
      for (const r of results) expect([201, 409]).toContain(r.status);
      expect(
        results.filter((r) => r.status === 201 && r.headers['idempotent-replayed'] !== 'true'),
      ).toHaveLength(1);
      const replay = await refund(rid, o, items([b, 1]), key);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const changed = await refund(rid, o, items([b, 2]), key);
      expect(changed.status).toBe(422);
      expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const asAmount = await refund(rid, o, { amountCents: 367 }, key);
      expect(asAmount.status).toBe(422);
      const { refunds, lines } = await assertMoneyConsistent(o);
      expect(refunds).toHaveLength(1);
      expect(lines.map((l) => l.quantity)).toEqual([1]);
      expect(await wastedPortions(o)).toEqual({ Burger: 1 });
      await assertBooksClean(rid);
    });
  });

  // ------------------------------------------------------------------ 7. access

  describe('7. access', () => {
    it("crew cannot refund; another restaurant's or tenant's lines are refused; nothing is written", async () => {
      const rid = await newRestaurant();
      const other = await newRestaurant();
      const o = await finished(rid, [['burger', 1]]);
      const elsewhere = await finished(other, [['burger', 1]]);
      const crew = await refund(rid, o, items([top(o, 'Burger'), 1]), randomUUID(), tokens.crew);
      expect(crew.status).toBe(403);
      // Another restaurant's line on our order.
      const r1 = await refund(rid, o, items([top(elsewhere, 'Burger'), 1]));
      expect(r1.status).toBe(422);
      // Our order through the other restaurant's path.
      const r2 = await refund(other, o, items([top(o, 'Burger'), 1]));
      expect(r2.status).toBe(404);
      // Another tenant's line id.
      const foreign = await h.owner
        .selectFrom('order_lines')
        .select('id')
        .where('org_id', '<>', orgId)
        .where('parent_line_id', 'is', null)
        .limit(1)
        .executeTakeFirst();
      if (!foreign) console.log('no other-tenant order line exists; using a random id');
      const r3 = await refund(rid, o, items([foreign?.id ?? randomUUID(), 1]));
      expect(r3.status).toBe(422);
      // Another tenant's manager on our order.
      const drive = await login(h, 'manager@drive.kitchos.test');
      const r4 = await refund(rid, o, items([top(o, 'Burger'), 1]), randomUUID(), drive);
      expect([403, 404]).toContain(r4.status);
      for (const x of [o, elsewhere]) {
        expect(await refundsOf(x)).toEqual([]);
        expect(await wasteRecordCount(x)).toBe(0);
        expect(await paymentOf(x)).toMatchObject({ status: 'captured', refunded_cents: 0 });
      }
      // Items and an amount together, empty items, zero quantity: 400.
      for (const body of [
        { amountCents: 100, ...items([top(o, 'Burger'), 1]) },
        { items: [] },
        items([top(o, 'Burger'), 0]),
      ]) {
        expect((await refund(rid, o, body)).status).toBe(400);
      }
      expect(await refundsOf(o)).toEqual([]);
      await assertBooksClean(rid);
      await assertBooksClean(other);
    });
  });
});
