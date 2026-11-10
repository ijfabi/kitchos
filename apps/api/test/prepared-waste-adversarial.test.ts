import { randomUUID } from 'node:crypto';
import type { LedgerReconciliation, PreparedItemsView } from '@kitchos/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import { bearer, login, startHarness, type Harness } from './harness.ts';

/**
 * Adversarial tests for prepared food recorded as waste on cancel and refund
 * (Milestone 14, ADR-0011). Complements prepared-waste.test.ts.
 *
 * Hygiene: everything that posts runs in a throwaway organisation with its own
 * restaurants, created here (card payments only, so no drawer sessions; no day is
 * closed). Demo tenants are only read, or receive requests that must be refused.
 */
describe('prepared food on cancel and refund (adversarial)', () => {
  let h: Harness;
  let dispatcher: EventDispatcher;
  let orgId: string;
  let brandId: string;
  let regionId: string;
  let menuId: string;
  const inv: Record<'bun' | 'cup' | 'fry' | 'nug', string> = { bun: '', cup: '', fry: '', nug: '' };
  const menuItems: Record<'burger' | 'cola' | 'fries' | 'nuggets' | 'meal', string> = {
    burger: '',
    cola: '',
    fries: '',
    nuggets: '',
    meal: '',
  };
  const tokens = { manager: '', manager2: '', supervisor: '', crew: '' };
  const restaurantIds: string[] = [];

  // ------------------------------------------------------------------ fixture

  const buildOrg = async () => {
    const tag = randomUUID().slice(0, 8);
    orgId = (
      await h.owner
        .insertInto('organisations')
        .values({ name: `Prepared waste adversarial ${tag}`, slug: `pwa-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await sql`select app.create_default_chart(${orgId}::uuid)`.execute(h.owner);
    brandId = (
      await h.owner
        .insertInto('brands')
        .values({ org_id: orgId, name: 'PWA', slug: `pwa-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    regionId = (
      await h.owner
        .insertInto('regions')
        .values({ org_id: orgId, name: 'PWA region' })
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
    inv.nug = await addInv('NUG', '10.333'); // a fractional cost: rounding is visible
    menuId = (
      await h.owner
        .insertInto('menus')
        .values({ org_id: orgId, brand_id: brandId, name: 'PWA menu' })
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
    const simple = async (name: string, price: number, ingredient: string, point: string) => {
      const pid = await product(name, 'item');
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
    menuItems.burger = burger.menuItemId;
    menuItems.cola = cola.menuItemId;
    menuItems.fries = fries.menuItemId;
    menuItems.nuggets = nuggets.menuItemId;
    // A meal whose components are consumed at three different points.
    const mealProduct = await product('Meal', 'combo');
    const meal = await h.owner
      .insertInto('menu_items')
      .values({
        org_id: orgId,
        menu_version_id: mv.id,
        product_id: mealProduct,
        category: 'All',
        price_cents: 1500,
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
      manager2: 'restaurant_manager',
      supervisor: 'shift_supervisor',
      crew: 'crew_member',
    };
    for (const [k, role] of Object.entries(roles) as [keyof typeof tokens, string][]) {
      const email = `${k}-${tag}@pwa.test`;
      const user = await h.owner
        .insertInto('users')
        .values({ org_id: orgId, email, display_name: `PWA ${k}`, password_hash })
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

  const newRestaurant = async (threshold?: number): Promise<string> => {
    const slug = `pwa-${randomUUID().slice(0, 8)}`;
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
        ...(threshold !== undefined ? { waste_approval_threshold_cents: threshold } : {}),
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
    restaurantIds.push(r.id);
    return r.id;
  };

  beforeAll(async () => {
    h = await startHarness();
    dispatcher = h.app.get(EventDispatcher);
    await buildOrg();
  });

  afterAll(async () => {
    await drain();
    await h.close();
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
    lines: { id: string; name: string; kind: string; parent: string | null }[];
  }

  /** Rings an order at the POS and pays by card (accepting it). */
  const order = async (rid: string, items: [Item, number][]): Promise<Placed> => {
    const res = await h.http
      .post(`${api(rid)}/orders`)
      .set(bearer(tokens.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({
        fulfilmentType: 'dine_in',
        lines: items.map(([n, quantity]) => ({ menuItemId: menuItems[n], quantity })),
      });
    if (res.status !== 201) throw new Error(`ring ${res.status} ${JSON.stringify(res.body)}`);
    const paid = await h.http
      .post(`${api(rid)}/orders/${res.body.id}/payments`)
      .set(bearer(tokens.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'card', paymentToken: 'tok_sandbox_approve' });
    if (paid.status !== 200) throw new Error(`pay ${paid.status} ${JSON.stringify(paid.body)}`);
    const lines = await h.owner
      .selectFrom('order_lines')
      .select(['id', 'name', 'kind', 'parent_line_id as parent'])
      .where('order_id', '=', res.body.id)
      .execute();
    return { id: res.body.id as string, lines };
  };
  /** The producible (non-combo) line with this name. */
  const line = (o: Placed, name: string) =>
    o.lines.find((l) => l.name === name && l.kind !== 'combo')!.id;
  const taskOf = async (lineId: string) =>
    (
      await h.owner
        .selectFrom('kitchen_tasks')
        .select('id')
        .where('order_line_id', '=', lineId)
        .executeTakeFirstOrThrow()
    ).id;
  const start = async (rid: string, lineId: string, token = tokens.crew) =>
    h.http
      .post(`${api(rid)}/kitchen/tasks/${await taskOf(lineId)}/start`)
      .set(bearer(token))
      .send({});
  const complete = async (rid: string, lineId: string, token = tokens.crew) =>
    h.http
      .post(`${api(rid)}/kitchen/tasks/${await taskOf(lineId)}/complete`)
      .set(bearer(token))
      .send({});
  const startAll = async (rid: string, o: Placed) => {
    for (const l of o.lines.filter((x) => x.kind !== 'combo')) {
      expect((await start(rid, l.id)).status).toBe(200);
    }
  };
  const completeAll = async (rid: string, o: Placed) => {
    for (const l of o.lines.filter((x) => x.kind !== 'combo')) {
      expect((await complete(rid, l.id)).status).toBe(200);
    }
  };
  const handoff = (rid: string, o: Placed) =>
    h.http
      .post(`${api(rid)}/orders/${o.id}/handoff`)
      .set(bearer(tokens.crew))
      .expect(200);
  const finished = async (rid: string, items: [Item, number][]) => {
    const o = await order(rid, items);
    await completeAll(rid, o);
    await handoff(rid, o);
    return o;
  };
  const cancel = (rid: string, o: Placed, body: object = {}, token = tokens.manager) =>
    h.http
      .post(`${api(rid)}/orders/${o.id}/cancel`)
      .set(bearer(token))
      .send({ reason: 'Adversarial cancel', ...body });
  /** Every item on an order, in full: a refund by item of the whole order. */
  const allItems = async (o: Placed) =>
    (
      await h.owner
        .selectFrom('order_lines')
        .select(['id', 'quantity'])
        .where('order_id', '=', o.id)
        .where('parent_line_id', 'is', null)
        .execute()
    ).map((l) => ({ orderLineId: l.id, quantity: l.quantity }));
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
      // A refund by item is priced by the server; by amount, 100c unless the test says otherwise.
      .send('items' in body ? body : { amountCents: 100, ...body });
  const manualWaste = (rid: string, lineId: string, quantity: number, extra: object = {}) =>
    h.http
      .post(`${api(rid)}/inventory/waste`)
      .set(bearer(tokens.crew))
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'prepared_item', orderLineId: lineId, quantity, reason: 'dropped', ...extra });
  const review = (rid: string, wasteId: string, decision: 'approve' | 'reject', token: string) =>
    h.http
      .post(`${api(rid)}/inventory/waste/${wasteId}/${decision}`)
      .set(bearer(token))
      .send({ reason: 'Adversarial review' });
  const prepared = async (rid: string, o: Placed, token = tokens.crew) =>
    (
      await h.http
        .get(`${api(rid)}/orders/${o.id}/prepared-items`)
        .set(bearer(token))
        .expect(200)
    ).body as PreparedItemsView;

  const orderStatus = async (o: Placed) =>
    (
      await h.owner
        .selectFrom('orders')
        .select('status')
        .where('id', '=', o.id)
        .executeTakeFirstOrThrow()
    ).status;

  /** Waste records against an order's lines. */
  const wasted = async (o: Placed) =>
    (
      await h.owner
        .selectFrom('waste_records as w')
        .innerJoin('order_lines as l', 'l.id', 'w.order_line_id')
        .select([
          'w.id',
          'l.name',
          'w.order_line_id',
          'w.quantity',
          'w.reason',
          'w.status',
          'w.recorded_by',
          'w.cost_cents',
          'w.remake',
        ])
        .where('l.order_id', '=', o.id)
        .orderBy('l.name')
        .orderBy('w.occurred_at')
        .execute()
    ).map((w) => ({ ...w, cost_cents: Number(w.cost_cents) }));
  /** Portions still counted as waste per line (rejected records excluded). */
  const wastedPortions = async (o: Placed) => {
    const out: Record<string, number> = {};
    for (const w of await wasted(o)) {
      if (w.status === 'rejected') continue;
      out[w.name] = (out[w.name] ?? 0) + Number(w.quantity);
    }
    return out;
  };
  const wasteLines = (wasteIds: string[]) =>
    wasteIds.length === 0
      ? Promise.resolve([])
      : h.owner
          .selectFrom('waste_record_lines')
          .select(['waste_record_id', 'treatment', 'quantity', 'unit_cost', 'cost_cents'])
          .where('waste_record_id', 'in', wasteIds)
          .execute();

  /** Every stock movement tied to an order: its lines' consumption and its waste records. */
  const movementsOf = async (o: Placed) => {
    const lineIds = o.lines.map((l) => l.id);
    const wasteIds = (await wasted(o)).map((w) => w.id);
    return h.owner
      .selectFrom('stock_movements')
      .select([
        'id',
        'movement_type',
        'source_type',
        'source_id',
        'source_key',
        'quantity_delta',
        'inventory_item_id',
      ])
      .where((w) =>
        w.or([
          w('source_id', 'in', lineIds),
          ...(wasteIds.length ? [w('source_id', 'in', wasteIds)] : []),
        ]),
      )
      .execute();
  };
  /** Ordinary (non-remake) consumption per line: at most one movement per ingredient. */
  const consumedLines = async (o: Placed) =>
    new Set(
      (await movementsOf(o))
        .filter((m) => m.movement_type === 'production_consumption' && m.source_key === '')
        .map((m) => m.source_id),
    );
  const assertNoDoubleMovement = async (o: Placed) => {
    const ms = await movementsOf(o);
    const keys = ms.map(
      (m) =>
        `${m.movement_type}|${m.source_type}|${m.source_id}|${m.source_key}|${m.inventory_item_id}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    // Food already consumed is reclassified only: no waste_prepared deduction for it.
    expect(
      ms.filter((m) => m.movement_type === 'waste_prepared' || m.movement_type === 'waste_raw'),
    ).toEqual([]);
  };

  /** Net debit − credit on one account at a restaurant, all time. */
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
  /** Σ value of ordinary and remake consumption at a restaurant (positive cents). */
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
  /** Stock balances at this restaurant equal the sum of their movements. */
  const balanceErrors = async (rid: string) =>
    (
      await sql`
      select b.inventory_item_id, b.on_hand
        from stock_balances b join stock_locations l on l.id = b.location_id
       where l.restaurant_id = ${rid}::uuid
         and b.on_hand <> coalesce((select sum(m.quantity_delta) from stock_movements m
                                     where m.location_id = b.location_id
                                       and m.inventory_item_id = b.inventory_item_id), 0)`.execute(
        h.owner,
      )
    ).rows;
  const assertBooksClean = async (rid: string) => {
    await drain();
    expect(await failuresAt(rid)).toEqual([]);
    expect(await balanceErrors(rid)).toEqual([]);
    const rec = await reconciliation(rid);
    expect({
      reconciled: rec.reconciled,
      pending: rec.pendingEvents,
      dead: rec.deadLetteredEvents,
      stock: rec.stockMovementsValueCents,
    }).toEqual({
      reconciled: true,
      pending: 0,
      dead: 0,
      stock: rec.journalInventoryCents,
    });
  };
  const setCost = (id: string, cost: string) =>
    h.owner
      .updateTable('inventory_items')
      .set({ standard_unit_cost: cost })
      .where('id', '=', id)
      .execute();

  // ------------------------------------------------- 1. consumption points and stages

  describe('1. a meal cancelled at each stage', () => {
    let rid: string;
    beforeAll(async () => {
      rid = await newRestaurant();
    });

    it('accepted: only the component consumed at acceptance is waste; supervisor and crew are refused', async () => {
      const o = await order(rid, [['meal', 1]]);
      const list = await prepared(rid, o);
      expect(list.items.map((i) => [i.name, i.remaining])).toEqual([['Cola', 1]]);
      // Production has begun (Cola consumed): a supervisor's orders.cancel is not enough.
      expect((await cancel(rid, o, {}, tokens.supervisor)).status).toBe(403);
      expect((await cancel(rid, o, {}, tokens.crew)).status).toBe(403);
      expect(await orderStatus(o)).toBe('accepted');
      expect(await wasted(o)).toEqual([]);

      expect((await cancel(rid, o)).status).toBe(200);
      const rows = await wasted(o);
      expect(rows.map((r) => [r.name, r.quantity, r.reason, r.status])).toEqual([
        ['Cola', '1.000', 'cancelled_prepared_order', 'recorded'],
      ]);
      expect((await wasteLines(rows.map((r) => r.id))).map((l) => l.treatment)).toEqual([
        'already_consumed',
      ]);
      // The other components were never made and can no longer be.
      expect((await start(rid, line(o, 'Burger'))).status).toBeGreaterThanOrEqual(400);
      expect((await complete(rid, line(o, 'Fries'))).status).toBeGreaterThanOrEqual(400);
      expect([...(await consumedLines(o))]).toEqual([line(o, 'Cola')]);
      await assertNoDoubleMovement(o);
    });

    it('in preparation: the components consumed at acceptance and at task start', async () => {
      const o = await order(rid, [['meal', 1]]);
      await startAll(rid, o);
      expect((await prepared(rid, o)).items.map((i) => i.name).sort()).toEqual(['Burger', 'Cola']);
      expect((await cancel(rid, o)).status).toBe(200);
      expect(await wastedPortions(o)).toEqual({ Burger: 1, Cola: 1 });
      expect((await complete(rid, line(o, 'Fries'))).status).toBeGreaterThanOrEqual(400);
      expect((await consumedLines(o)).has(line(o, 'Fries'))).toBe(false);
      await assertNoDoubleMovement(o);
    });

    it('ready: every component, each once', async () => {
      const o = await order(rid, [['meal', 1]]);
      await completeAll(rid, o);
      expect(await orderStatus(o)).toBe('ready');
      expect((await cancel(rid, o)).status).toBe(200);
      expect(await wastedPortions(o)).toEqual({ Burger: 1, Cola: 1, Fries: 1 });
      expect((await prepared(rid, o)).items.every((i) => i.remaining === 0)).toBe(true);
      await assertNoDoubleMovement(o);
    });

    it('books: COGS nets to zero, Waste carries the consumed cost, the day reconciles', async () => {
      await assertBooksClean(rid);
      const consumed = await consumedValue(rid);
      // Cola 15 (x3) + Burger 40 (x2) + Fries 12.
      expect(consumed).toBe(15 * 3 + 40 * 2 + 12);
      expect(await books(rid)).toEqual({ cogs: 0, waste: consumed, inventory: -consumed });
    });
  });

  // ----------------------------------------------------- 2. lists that must be refused

  describe('2. waste lists', () => {
    let rid: string;
    let other: string;
    let foreignLine: string;
    beforeAll(async () => {
      rid = await newRestaurant();
      other = await newRestaurant();
      const f = await h.owner
        .selectFrom('order_lines')
        .select('id')
        .where('org_id', '<>', orgId)
        .limit(1)
        .executeTakeFirst();
      foreignLine = f?.id ?? randomUUID();
      if (!f) console.log('no other-tenant order line exists; using a random id');
    });

    it('naming the combo parent, another order, another restaurant or tenant, or a random id: 422, nothing changes', async () => {
      const o = await order(rid, [['meal', 1]]);
      await startAll(rid, o);
      const sameRestaurant = await order(rid, [['burger', 1]]);
      await startAll(rid, sameRestaurant);
      const elsewhere = await order(other, [['burger', 1]]);
      await startAll(other, elsewhere);
      const parent = o.lines.find((l) => l.kind === 'combo')!.id;
      const movesBefore = (await movementsOf(o)).length;
      for (const id of [
        parent,
        line(sameRestaurant, 'Burger'),
        line(elsewhere, 'Burger'),
        foreignLine,
        randomUUID(),
      ]) {
        for (const quantity of [0, 1]) {
          const res = await cancel(rid, o, { waste: [{ orderLineId: id, quantity }] });
          expect({ id, quantity, status: res.status }).toEqual({ id, quantity, status: 422 });
          expect(res.body.error.code).toBe('WASTE_LINE_NOT_PREPARED');
        }
      }
      expect(await orderStatus(o)).toBe('in_preparation');
      expect(await wasted(o)).toEqual([]);
      expect(await wasted(sameRestaurant)).toEqual([]);
      expect(await wasted(elsewhere)).toEqual([]);
      expect((await movementsOf(o)).length).toBe(movesBefore);
      // Duplicates are refused at the edge.
      const dup = await cancel(rid, o, {
        waste: [
          { orderLineId: line(o, 'Burger'), quantity: 0 },
          { orderLineId: line(o, 'Burger'), quantity: 1 },
        ],
      });
      expect(dup.status).toBe(400);
      expect(await orderStatus(o)).toBe('in_preparation');

      // A list of zeros: cancels, records nothing.
      const zeros = await cancel(rid, o, {
        waste: [
          { orderLineId: line(o, 'Burger'), quantity: 0 },
          { orderLineId: line(o, 'Cola'), quantity: 0 },
        ],
      });
      expect(zeros.status).toBe(200);
      expect(await wasted(o)).toEqual([]);
      expect((await movementsOf(o)).length).toBe(movesBefore);
      // The food is still free to record (e.g. by a later quality refund).
      expect((await prepared(rid, o)).items.map((i) => i.remaining)).toEqual([1, 1]);

      for (const x of [sameRestaurant]) expect((await cancel(rid, x)).status).toBe(200);
      expect((await cancel(other, elsewhere)).status).toBe(200);
    });

    it('refund lists: foreign lines refuse the refund too, and no money moves', async () => {
      const o = await finished(rid, [['meal', 1]]);
      const elsewhere = await finished(other, [['burger', 1]]);
      const parent = o.lines.find((l) => l.kind === 'combo')!.id;
      for (const id of [parent, line(elsewhere, 'Burger'), foreignLine]) {
        const res = await refund(rid, o, {
          reason: 'quality',
          waste: [{ orderLineId: id, quantity: 1 }],
        });
        expect(res.status).toBe(422);
      }
      const refunds = await h.owner
        .selectFrom('refunds')
        .select('id')
        .where('order_id', '=', o.id)
        .execute();
      expect(refunds).toEqual([]);
      const pay = await h.owner
        .selectFrom('payments')
        .select(['status', 'refunded_cents'])
        .where('order_id', '=', o.id)
        .executeTakeFirstOrThrow();
      expect(pay).toEqual({ status: 'captured', refunded_cents: 0 });
      expect(await wasted(o)).toEqual([]);
      // A zero list on a quality refund: money only.
      const zero = await refund(rid, o, {
        reason: 'quality',
        waste: [{ orderLineId: line(o, 'Burger'), quantity: 0 }],
      });
      expect(zero.status).toBe(201);
      expect(await wasted(o)).toEqual([]);
      await assertBooksClean(rid);
      await assertBooksClean(other);
    });
  });

  // ------------------------------------------------------------------ 3. races

  describe('3. races', () => {
    const STAGGER = [0, 3, 8, 15, 30];

    it('cancel racing a manual waste of the same line: never more than was made', async () => {
      const rid = await newRestaurant();
      const outcomes: string[] = [];
      // Positive: the waste starts later; negative: the cancel does. Both orderings occur.
      for (const ms of [...STAGGER, -3, -8, -15, -30]) {
        const o = await order(rid, [['burger', 2]]);
        await startAll(rid, o);
        const burger = line(o, 'Burger');
        const [c, w] = await Promise.all([
          sleep(Math.max(0, -ms)).then(() => cancel(rid, o)),
          sleep(Math.max(0, ms)).then(() => manualWaste(rid, burger, 1)),
        ]);
        outcomes.push(`${c.status}/${w.status}`);
        expect(c.status).toBe(200);
        expect([201, 422]).toContain(w.status);
        const rows = await wasted(o);
        // Either the manual one went first (1 + cancel's 1) or the cancel took both.
        expect(rows.reduce((s, r) => s + Number(r.quantity), 0)).toBe(2);
        expect(rows.length).toBe(w.status === 201 ? 2 : 1);
        await assertNoDoubleMovement(o);
      }
      console.log(`cancel vs manual waste: ${outcomes.join(' ')}`);
      await assertBooksClean(rid);
      expect((await books(rid)).cogs).toBe(0);
    });

    it('two quality refunds racing on one order: the food is recorded once', async () => {
      const rid = await newRestaurant();
      for (const ms of STAGGER) {
        const o = await finished(rid, [['burger', 2]]);
        const [a, b] = await Promise.all([
          refund(rid, o, { reason: 'quality', items: await allItems(o) }),
          sleep(ms).then(async () =>
            refund(rid, o, { reason: 'quality', items: await allItems(o) }),
          ),
        ]);
        // An item can be refunded only once: one refund wins, the other is refused.
        expect([a.status, b.status].sort()).toEqual([201, expect.any(Number)].sort());
        expect([a.status, b.status].filter((x) => x === 201)).toHaveLength(1);
        expect([a.status, b.status].find((x) => x !== 201)).toBeGreaterThanOrEqual(409);
        const rows = await wasted(o);
        expect(rows.map((r) => [r.quantity, r.reason])).toEqual([['2.000', 'poor_quality']]);
        await assertNoDoubleMovement(o);
      }
      await assertBooksClean(rid);
      expect((await books(rid)).cogs).toBe(0);
    });

    it('a quality refund racing a waste rejection: COGS + Waste always equal what was consumed', async () => {
      const rid = await newRestaurant();
      const outcomes: string[] = [];
      for (const ms of STAGGER) {
        const o = await finished(rid, [['burger', 2]]);
        const burger = line(o, 'Burger');
        const dropped = await manualWaste(rid, burger, 1);
        expect(dropped.status).toBe(201);
        const [rj, rf] = await Promise.all([
          review(rid, dropped.body.id, 'reject', tokens.manager),
          sleep(ms).then(async () =>
            refund(rid, o, { reason: 'quality', items: await allItems(o) }),
          ),
        ]);
        expect(rj.status).toBe(200);
        expect(rf.status).toBe(201);
        const portions = (await wastedPortions(o)).Burger ?? 0;
        outcomes.push(String(portions));
        // Refund before rejection: 1 (the other came back); after: 2.
        expect([1, 2]).toContain(portions);
        expect((await prepared(rid, { id: o.id, lines: o.lines })).items[0]!.remaining).toBe(
          2 - portions,
        );
      }
      console.log(`refund vs rejection: portions wasted ${outcomes.join(',')}`);
      await assertBooksClean(rid);
      const consumed = await consumedValue(rid);
      const b = await books(rid);
      const live = Number(
        (
          await h.owner
            .selectFrom('waste_records')
            .select(sql<string>`coalesce(sum(cost_cents), 0)`.as('c'))
            .where('restaurant_id', '=', rid)
            .where('status', '<>', 'rejected')
            .executeTakeFirstOrThrow()
        ).c,
      );
      expect(b).toEqual({ cogs: consumed - live, waste: live, inventory: -consumed });
    });

    for (const withVersion of [false, true]) {
      for (const stage of ['start', 'complete'] as const) {
        it(`cancel racing a task ${stage} (${withVersion ? 'with' : 'without'} preparedVersion): consumed food is always waste`, async () => {
          const rid = await newRestaurant();
          const outcomes: string[] = [];
          for (const ms of [...STAGGER, ...STAGGER]) {
            // Burger consumes at start; Fries at completion (started first so completion consumes).
            const item: Item = stage === 'start' ? 'burger' : 'fries';
            const name = stage === 'start' ? 'Burger' : 'Fries';
            const o = await order(rid, [[item, 1]]);
            const l = line(o, name);
            if (stage === 'complete') expect((await start(rid, l)).status).toBe(200);
            const seen = await prepared(rid, o);
            expect(seen.items).toEqual([]);
            const body = withVersion ? { preparedVersion: seen.version } : {};
            const [k, c] = await Promise.all([
              stage === 'start' ? start(rid, l) : complete(rid, l),
              sleep(ms).then(() => cancel(rid, o, body)),
            ]);
            outcomes.push(`${k.status}/${c.status}`);
            const consumed = (await consumedLines(o)).has(l);
            if (c.status === 200) {
              expect(await orderStatus(o)).toBe('cancelled');
              // Consumed before the cancel committed (a version mismatch would have refused it)...
              if (withVersion) expect(consumed).toBe(false);
              expect(await wastedPortions(o)).toEqual(consumed ? { [name]: 1 } : {});
              if (!consumed) expect(k.status).toBeGreaterThanOrEqual(400);
            } else {
              // ...or the kitchen won and the stale list is refused, cancelling nothing.
              expect(withVersion).toBe(true);
              expect(c.status).toBe(409);
              expect(c.body.error.code).toBe('PREPARED_ITEMS_CHANGED');
              expect(k.status).toBe(200);
              expect(consumed).toBe(true);
              expect(await orderStatus(o)).not.toBe('cancelled');
              expect(await wasted(o)).toEqual([]);
              const fresh = await prepared(rid, o);
              expect((await cancel(rid, o, { preparedVersion: fresh.version })).status).toBe(200);
              expect(await wastedPortions(o)).toEqual({ [name]: 1 });
            }
            await assertNoDoubleMovement(o);
          }
          console.log(`cancel vs task ${stage} (version ${withVersion}): ${outcomes.join(' ')}`);
          await assertBooksClean(rid);
          expect((await books(rid)).cogs).toBe(0);
        });
      }
    }
  });

  // ------------------------------------------------------------------ 4. remakes

  describe('4. remakes', () => {
    it('an accepted remake before cancel: both portions made are waste, COGS nets to zero', async () => {
      const rid = await newRestaurant();
      const o = await order(rid, [['burger', 1]]);
      await startAll(rid, o);
      const b = line(o, 'Burger');
      const r = await manualWaste(rid, b, 1, { remake: true, reason: 'burnt' });
      expect(r.status).toBe(201);
      expect(r.body.remake).toBe(true);
      expect((await prepared(rid, o)).items[0]!.remaining).toBe(1);
      expect((await cancel(rid, o)).status).toBe(200);
      expect(await wastedPortions(o)).toEqual({ Burger: 2 });
      await assertNoDoubleMovement(o);
      await assertBooksClean(rid);
      expect(await books(rid)).toEqual({ cogs: 0, waste: 80, inventory: -80 });
    });

    it('a rejected remake before a quality refund: every portion made is waste once', async () => {
      const rid = await newRestaurant();
      const o = await finished(rid, [['burger', 1]]);
      const b = line(o, 'Burger');
      const r = await manualWaste(rid, b, 1, { remake: true, reason: 'burnt' });
      expect(r.status).toBe(201);
      await drain();
      expect((await review(rid, r.body.id, 'reject', tokens.manager)).status).toBe(200);
      expect((await prepared(rid, o)).items[0]!.remaining).toBe(2);
      expect((await refund(rid, o, { reason: 'quality', items: await allItems(o) })).status).toBe(
        201,
      );
      // Refunds are by item (Milestone 15): the one refunded burger is waste. The remade one was
      // made too (the remake stands) and stays in production cost.
      expect(await wastedPortions(o)).toEqual({ Burger: 1 });
      await assertNoDoubleMovement(o);
      await assertBooksClean(rid);
      expect(await books(rid)).toEqual({ cogs: 40, waste: 40, inventory: -80 });
    });

    // Regression (fixed in Milestone 14): the remade portion is reclassified at the ORIGINAL consumption cost, not the cost
    // its remake consumption was valued at, so COGS keeps the difference after a cost change.
    // Repro: Burger (BUN 40) started; standard cost of BUN -> 100; record waste with remake
    // (remake consumption valued 100); cancel (waste of the remaining portion, valued 40).
    // COGS = 40 + 100 - 40 - 40 = 60, Waste = 80; expected COGS 0, Waste 140.
    // consumptionCosts (stock-operations.service.ts:926-937) reads only source_key = '' movements,
    // and recordWasteIn (stock-operations.service.ts:154, :215-218) applies that one unit cost to
    // every portion of the line, remade or not.
    it('a remake across a standard cost change, then cancel: COGS still nets to zero', async () => {
      const rid = await newRestaurant();
      const o = await order(rid, [['burger', 1]]);
      await startAll(rid, o);
      const b = line(o, 'Burger');
      try {
        await setCost(inv.bun, '100');
        expect((await manualWaste(rid, b, 1, { remake: true, reason: 'burnt' })).status).toBe(201);
      } finally {
        await setCost(inv.bun, '40');
      }
      expect((await cancel(rid, o)).status).toBe(200);
      expect(await wastedPortions(o)).toEqual({ Burger: 2 });
      await assertBooksClean(rid);
      const consumed = await consumedValue(rid);
      expect(consumed).toBe(140);
      expect(await books(rid)).toEqual({ cogs: 0, waste: 140, inventory: -140 });
    });
  });

  // --------------------------------------------------------- 5. amounts and approval

  describe('5. amounts above the approval threshold', () => {
    it('a supervisor refund records waste pending approval; another manager approves; books net', async () => {
      const rid = await newRestaurant(50);
      const o = await finished(rid, [['burger', 2]]); // 80 > 50
      const res = await refund(
        rid,
        o,
        { reason: 'quality', items: await allItems(o) },
        randomUUID(),
        tokens.supervisor,
      );
      expect(res.status).toBe(201);
      const [w] = await wasted(o);
      const supervisorId = (await h.http.get('/v1/me').set(bearer(tokens.supervisor))).body.user.id;
      expect(w).toMatchObject({
        status: 'pending_approval',
        cost_cents: 80,
        recorded_by: supervisorId,
      });
      // A supervisor cannot approve (no waste.approve); crew neither.
      expect((await review(rid, w!.id, 'approve', tokens.supervisor)).status).toBe(403);
      expect((await review(rid, w!.id, 'approve', tokens.crew)).status).toBe(403);
      await drain();
      // Posted when recorded: the loss happened.
      expect(await books(rid)).toEqual({ cogs: 0, waste: 80, inventory: -80 });
      const ok = await review(rid, w!.id, 'approve', tokens.manager);
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('approved');
      // A second decision is refused.
      expect((await review(rid, w!.id, 'reject', tokens.manager2)).status).toBe(409);
      await assertBooksClean(rid);
      expect(await books(rid)).toEqual({ cogs: 0, waste: 80, inventory: -80 });
    });

    it("rejecting a cancellation's waste (not by the canceller) reverses the reclassification exactly", async () => {
      const rid = await newRestaurant(50);
      const o = await order(rid, [
        ['meal', 1],
        ['burger', 1],
      ]);
      await startAll(rid, o);
      expect((await cancel(rid, o, {}, tokens.manager2)).status).toBe(200);
      const rows = await wasted(o);
      expect(rows.map((r) => [r.name, r.status]).sort()).toEqual([
        ['Burger', 'recorded'],
        ['Burger', 'recorded'],
        ['Cola', 'recorded'],
      ]);
      await drain();
      const consumed = await consumedValue(rid);
      expect(consumed).toBe(95);
      expect(await books(rid)).toEqual({ cogs: 0, waste: 95, inventory: -95 });
      const movesBefore = (await movementsOf(o)).length;
      // The canceller cannot review the records the cancel made.
      expect((await review(rid, rows[0]!.id, 'reject', tokens.manager2)).status).toBe(403);
      for (const r of rows)
        expect((await review(rid, r.id, 'reject', tokens.manager)).status).toBe(200);
      // Already consumed: nothing to put back physically.
      expect((await movementsOf(o)).length).toBe(movesBefore);
      await assertBooksClean(rid);
      expect(await books(rid)).toEqual({ cogs: 95, waste: 0, inventory: -95 });
      // The food is free to record again, and recording it moves it once more, exactly.
      expect((await prepared(rid, o)).items.map((i) => i.remaining)).toEqual([1, 1, 1]);
      expect(
        (await refund(rid, o, { reason: 'order_error', items: await allItems(o) })).status,
      ).toBe(201);
      await assertBooksClean(rid);
      expect(await books(rid)).toEqual({ cogs: 0, waste: 95, inventory: -95 });
    });
  });

  // ---------------------------------------------------------------- 6. idempotency

  describe('6. refund idempotency', () => {
    it('replay records nothing more; same key with another list is 422; concurrent replays once', async () => {
      const rid = await newRestaurant();
      const o = await finished(rid, [['burger', 2]]);
      const key = randomUUID();
      const body = {
        reason: 'customer_complaint',
        waste: [{ orderLineId: line(o, 'Burger'), quantity: 1 }],
      };
      const results = await Promise.all([0, 1, 2].map(() => refund(rid, o, body, key)));
      for (const r of results) expect([201, 409]).toContain(r.status);
      expect(
        results.filter((r) => r.status === 201 && r.headers['idempotent-replayed'] !== 'true'),
      ).toHaveLength(1);
      const replay = await refund(rid, o, body, key);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const changed = await refund(
        rid,
        o,
        { ...body, waste: [{ orderLineId: line(o, 'Burger'), quantity: 2 }] },
        key,
      );
      expect(changed.status).toBe(422);
      expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const omitted = await refund(rid, o, { reason: 'customer_complaint' }, key);
      expect(omitted.status).toBe(422);
      expect(await wastedPortions(o)).toEqual({ Burger: 1 });
      const refunds = await h.owner
        .selectFrom('refunds')
        .select('id')
        .where('order_id', '=', o.id)
        .execute();
      expect(refunds).toHaveLength(1);
      await assertNoDoubleMovement(o);
      await assertBooksClean(rid);
    });
  });

  // ------------------------------------------------------------------ 7. books

  describe('7. books', () => {
    it('a fully wasted refunded order across a standard cost change: COGS zero at the cost consumed', async () => {
      const rid = await newRestaurant();
      const o = await finished(rid, [['burger', 2]]);
      try {
        await setCost(inv.bun, '999');
        // Partial wastes: one portion, then the other.
        for (let i = 0; i < 2; i++) {
          expect(
            (
              await refund(rid, o, {
                reason: 'other',
                waste: [{ orderLineId: line(o, 'Burger'), quantity: 1 }],
              })
            ).status,
          ).toBe(201);
        }
      } finally {
        await setCost(inv.bun, '40');
      }
      const rows = await wasted(o);
      expect(rows.map((r) => [r.quantity, r.cost_cents, r.reason])).toEqual([
        ['1.000', 40, 'other'],
        ['1.000', 40, 'other'],
      ]);
      await assertBooksClean(rid);
      expect(await books(rid)).toEqual({ cogs: 0, waste: 80, inventory: -80 });
    });

    // Regression (fixed in Milestone 14): partial wastes of a line round each portion separately, so their sum differs from
    // the single rounded value of the line's consumption and COGS keeps a residue.
    // Repro: Nuggets x3 (NUG standard cost 10.333) started: consumption valued round(3 x 10.333)
    // = 31. Cancel with a list of 1, then two customer_complaint refunds of 1 each: each record
    // is extendedCostCents(1 x 10.333) = 10, total 30. After dispatch COGS = 1, Waste = 30;
    // expected COGS 0, Waste 31. stock-operations.service.ts:215-221 (per-record rounding of a
    // per-unit cost) against the movement value round(quantity_delta * unit_cost) in
    // 0009_inventory_valuation.sql:41.
    it('a line wasted in parts with a fractional unit cost: COGS nets to exactly zero', async () => {
      const rid = await newRestaurant();
      const o = await order(rid, [['nuggets', 3]]);
      await startAll(rid, o);
      const n = line(o, 'Nuggets');
      expect((await cancel(rid, o, { waste: [{ orderLineId: n, quantity: 1 }] })).status).toBe(200);
      for (let i = 0; i < 2; i++) {
        expect(
          (
            await refund(rid, o, {
              reason: 'customer_complaint',
              waste: [{ orderLineId: n, quantity: 1 }],
            })
          ).status,
        ).toBe(201);
      }
      expect(await wastedPortions(o)).toEqual({ Nuggets: 3 });
      await assertBooksClean(rid);
      const consumed = await consumedValue(rid);
      expect(consumed).toBe(31);
      const recorded = (await wasted(o)).reduce((s, w) => s + Number(w.cost_cents), 0);
      expect({ recorded, books: await books(rid) }).toEqual({
        recorded: 31,
        books: { cogs: 0, waste: 31, inventory: -31 },
      });
    });
  });

  // ------------------------------------------------------------------ 8. access

  describe('8. access to prepared items', () => {
    it("only at the order's own restaurant and tenant", async () => {
      const rid = await newRestaurant();
      const other = await newRestaurant();
      const o = await order(rid, [['burger', 1]]);
      await startAll(rid, o);
      expect((await prepared(rid, o, tokens.crew)).items).toHaveLength(1);
      // Same tenant, wrong restaurant in the path.
      expect(
        (
          await h.http
            .get(`${api(other)}/orders/${o.id}/prepared-items`)
            .set(bearer(tokens.manager))
        ).status,
      ).toBe(404);
      // Another tenant's manager, at this restaurant.
      const drive = await login(h, 'manager@drive.kitchos.test');
      const res = await h.http.get(`${api(rid)}/orders/${o.id}/prepared-items`).set(bearer(drive));
      expect([403, 404]).toContain(res.status);
      // Our manager, at another tenant's restaurant and order.
      const driveOrder = await h.owner
        .selectFrom('orders as o')
        .innerJoin('restaurants as r', 'r.id', 'o.restaurant_id')
        .select(['o.id', 'r.id as rid'])
        .where('r.slug', '=', 'kitchos-drive')
        .limit(1)
        .executeTakeFirst();
      const driveRid =
        driveOrder?.rid ??
        (
          await h.owner
            .selectFrom('restaurants')
            .select('id')
            .where('slug', '=', 'kitchos-drive')
            .executeTakeFirstOrThrow()
        ).id;
      const theirs = await h.http
        .get(`${api(driveRid)}/orders/${driveOrder?.id ?? randomUUID()}/prepared-items`)
        .set(bearer(tokens.manager));
      expect([403, 404]).toContain(theirs.status);
      // And our order through their restaurant.
      const crossed = await h.http
        .get(`${api(driveRid)}/orders/${o.id}/prepared-items`)
        .set(bearer(drive));
      expect(crossed.status).toBe(404);
      // A cancel of our order from another tenant changes nothing.
      const foreignCancel = await h.http
        .post(`${api(rid)}/orders/${o.id}/cancel`)
        .set(bearer(drive))
        .send({ reason: 'Not yours' });
      expect([403, 404]).toContain(foreignCancel.status);
      expect(await orderStatus(o)).toBe('in_preparation');
      expect((await cancel(rid, o)).status).toBe(200);
      await assertBooksClean(rid);
    });
  });
});
