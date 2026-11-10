import { randomUUID } from 'node:crypto';
import type { WasteRecordView } from '@kitchos/contracts';
import { formatDecimalQty, parseDecimalQty } from '@kitchos/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import {
  bearer,
  getMenu,
  item,
  login,
  placeAndPay,
  placeOrder,
  reconciliationErrors,
  restaurantId,
  startHarness,
  type Harness,
} from './harness.ts';

const CENTRAL = 'kitchos-central';
const DRIVE = 'kitchos-drive';
const RIVAL = 'rival-southbank';

describe('inventory operations under adversarial conditions', () => {
  let h: Harness;
  let dispatcher: EventDispatcher;
  let centralId: string;
  let driveId: string;
  let rivalId: string;
  let centralOrg: string;
  let rivalOrg: string;
  let crew: string;
  let crew2: string;
  let supervisor: string;
  let manager: string;
  let driveCrew: string;
  let driveManager: string;
  let rivalManager: string;
  let controller: string;
  let auditor: string;
  let areaManager: string;
  let threshold: number;
  const itemIds = new Map<string, string>();
  const snapshots = new Map<string, Map<string, string>>();
  const orders: { id: string; restId: string }[] = [];

  // ------------------------------------------------------------------ helpers

  const sku = (s: string) => {
    const id = itemIds.get(s);
    if (!id) throw new Error(`unknown sku ${s}`);
    return id;
  };

  const onHandSnapshot = async (restId: string) => {
    const rows = await h.owner
      .selectFrom('stock_balances as b')
      .innerJoin('stock_locations as l', 'l.id', 'b.location_id')
      .select(['b.inventory_item_id', 'b.on_hand'])
      .where('l.restaurant_id', '=', restId)
      .where('l.is_default', '=', true)
      .execute();
    return new Map(rows.map((r) => [r.inventory_item_id, r.on_hand]));
  };

  /** Puts on-hand back to the snapshot with a real (valued, posted) stock count. */
  const restoreOnHand = async (restId: string, token: string, snap: Map<string, string>) => {
    const now = await onHandSnapshot(restId);
    const lines: { inventoryItemId: string; counted: string }[] = [];
    for (const [id, qty] of now) {
      const target = snap.get(id) ?? '0.000';
      if (qty !== target && !target.startsWith('-'))
        lines.push({ inventoryItemId: id, counted: target });
    }
    if (lines.length === 0) return;
    const res = await h.http
      .post(`/v1/restaurants/${restId}/inventory/counts`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ notes: 'adversarial operations test: restore', lines });
    if (res.status !== 201)
      throw new Error(`restore count failed: ${res.status} ${JSON.stringify(res.body)}`);
  };

  const drain = async (...ds: EventDispatcher[]) => {
    for (let i = 0; i < 20; i++) {
      const stats = await Promise.all((ds.length ? ds : [dispatcher]).map((d) => d.runOnce()));
      if (stats.every((s) => s.processed === 0)) return;
    }
  };

  const businessDate = async (restId: string) =>
    (
      await sql<{
        d: string;
      }>`select app.business_date(${restId}::uuid, now())::text as d`.execute(h.owner)
    ).rows[0]!.d;

  const reconciliation = async (restId: string, token: string) =>
    (
      await h.http
        .get(
          `/v1/restaurants/${restId}/accounting/reconciliation?businessDate=${await businessDate(restId)}`,
        )
        .set(bearer(token))
        .expect(200)
    ).body as {
      reconciled: boolean;
      pendingEvents: number;
      deadLetteredEvents: number;
      stockMovementsValueCents: number;
      journalInventoryCents: number;
    };

  const assertReconciled = async () => {
    await drain();
    expect(await reconciliationErrors(h)).toEqual([]);
    expect(await reconciliation(centralId, manager)).toMatchObject({
      reconciled: true,
      pendingEvents: 0,
      deadLetteredEvents: 0,
    });
  };

  const bal = async (restId: string, itemId: string) => {
    const row = await h.owner
      .selectFrom('stock_balances as b')
      .innerJoin('stock_locations as l', 'l.id', 'b.location_id')
      .select(['b.on_hand', 'b.reserved'])
      .where('l.restaurant_id', '=', restId)
      .where('l.is_default', '=', true)
      .where('b.inventory_item_id', '=', itemId)
      .executeTakeFirst();
    return {
      onHand: parseDecimalQty(row?.on_hand ?? '0'),
      reserved: parseDecimalQty(row?.reserved ?? '0'),
    };
  };

  const pay = async (slug: string, restId: string, name: string, quantity = 1) => {
    const menu = await getMenu(h, slug);
    const order = await placeAndPay(h, slug, [{ menuItemId: item(menu, name).id, quantity }]);
    orders.push({ id: order.id, restId });
    return order;
  };

  const lineOf = async (orderId: string) =>
    (
      await h.owner
        .selectFrom('order_lines')
        .select(['id', 'quantity'])
        .where('order_id', '=', orderId)
        .where('kind', '=', 'item')
        .executeTakeFirstOrThrow()
    ).id;

  const linesOf = (orderId: string) =>
    h.owner
      .selectFrom('order_lines')
      .select(['id', 'kind', 'consumption_point', 'name', 'quantity'])
      .where('order_id', '=', orderId)
      .execute();

  const taskOf = async (lineId: string) =>
    (
      await h.owner
        .selectFrom('kitchen_tasks')
        .select('id')
        .where('order_line_id', '=', lineId)
        .executeTakeFirstOrThrow()
    ).id;

  const start = (lineId: string) =>
    taskOf(lineId).then((t) =>
      h.http
        .post(`/v1/restaurants/${centralId}/kitchen/tasks/${t}/start`)
        .set(bearer(crew))
        .send({})
        .expect(200),
    );
  const complete = (lineId: string) =>
    taskOf(lineId).then((t) =>
      h.http
        .post(`/v1/restaurants/${centralId}/kitchen/tasks/${t}/complete`)
        .set(bearer(crew))
        .send({})
        .expect(200),
    );

  const waste = (
    token: string,
    body: object,
    opts: { restId?: string; key?: string; http?: Harness['http'] } = {},
  ) =>
    (opts.http ?? h.http)
      .post(`/v1/restaurants/${opts.restId ?? centralId}/inventory/waste`)
      .set(bearer(token))
      .set('Idempotency-Key', opts.key ?? randomUUID())
      .send(body);

  const raw = (inventoryItemId: string, quantity: string, reason = 'spoiled') => ({
    kind: 'raw_ingredient',
    inventoryItemId,
    quantity,
    reason,
  });
  const prepared = (orderLineId: string, quantity = 1, remake = false) => ({
    kind: 'prepared_item',
    orderLineId,
    quantity,
    remake,
    reason: 'dropped',
  });

  const review = (
    decision: 'approve' | 'reject',
    id: string,
    token = manager,
    restId = centralId,
  ) =>
    h.http
      .post(`/v1/restaurants/${restId}/inventory/waste/${id}/${decision}`)
      .set(bearer(token))
      .send({ reason: 'Adversarial review decision' });

  const count = (
    token: string,
    lines: { inventoryItemId: string; counted: string }[],
    opts: { restId?: string; key?: string } = {},
  ) =>
    h.http
      .post(`/v1/restaurants/${opts.restId ?? centralId}/inventory/counts`)
      .set(bearer(token))
      .set('Idempotency-Key', opts.key ?? randomUUID())
      .send({ lines });

  const receipt = (
    token: string,
    lines: { inventoryItemId: string; quantity: string }[],
    opts: { restId?: string; key?: string } = {},
  ) =>
    h.http
      .post(`/v1/restaurants/${opts.restId ?? centralId}/inventory/receipts`)
      .set(bearer(token))
      .set('Idempotency-Key', opts.key ?? randomUUID())
      .send({ lines });

  const entriesOf = (sourceId: string) =>
    h.owner
      .selectFrom('journal_entries')
      .select(['id', 'entry_type'])
      .where('source_id', '=', sourceId)
      .execute();

  /** Net debit per system account over several sources (and optionally entry types). */
  const netFor = async (sourceIds: string[]) => {
    const rows = await h.owner
      .selectFrom('journal_lines as l')
      .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['a.system_key', 'l.debit_cents', 'l.credit_cents'])
      .where('e.source_id', 'in', sourceIds)
      .execute();
    const out: Record<string, number> = {};
    for (const r of rows)
      out[r.system_key!] =
        (out[r.system_key!] ?? 0) + Number(r.debit_cents) - Number(r.credit_cents);
    return out;
  };

  const movementValue = async (sourceType: string, sourceId: string, sourceKey?: string) => {
    let q = h.owner
      .selectFrom('stock_movements')
      .select(sql<string>`coalesce(sum(value_cents), 0)`.as('v'))
      .where('source_type', '=', sourceType)
      .where('source_id', '=', sourceId);
    if (sourceKey !== undefined) q = q.where('source_key', '=', sourceKey);
    return Number((await q.executeTakeFirstOrThrow()).v);
  };

  const movementCount = async (sourceType: string, sourceId: string) =>
    (
      await h.owner
        .selectFrom('stock_movements')
        .select('id')
        .where('source_type', '=', sourceType)
        .where('source_id', '=', sourceId)
        .execute()
    ).length;

  const reservationsOf = (lineId: string) =>
    h.owner
      .selectFrom('stock_reservations')
      .select(['status', 'inventory_item_id', 'quantity'])
      .where('order_line_id', '=', lineId)
      .execute();

  /** Milli-units of one ingredient in one portion of a line. */
  const portionOf = async (lineId: string, itemId: string) => {
    const l = await h.owner
      .selectFrom('order_lines')
      .select('quantity')
      .where('id', '=', lineId)
      .executeTakeFirstOrThrow();
    const s = await h.owner
      .selectFrom('order_line_ingredients')
      .select('quantity')
      .where('order_line_id', '=', lineId)
      .where('inventory_item_id', '=', itemId)
      .executeTakeFirstOrThrow();
    return parseDecimalQty(s.quantity) / l.quantity;
  };

  /** A throwaway item for boundaries that must not disturb seeded stock. */
  const tempItem = async (cost: string) => {
    const { id } = await h.owner
      .insertInto('inventory_items')
      .values({
        org_id: centralOrg,
        sku: `ADV-${randomUUID()}`,
        name: 'Adversarial test item',
        base_unit: 'each',
        category: 'ingredient',
        standard_unit_cost: cost,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return id;
  };

  const withCost = async <T>(itemId: string, cost: string, fn: () => Promise<T>): Promise<T> => {
    const before = await h.owner
      .selectFrom('inventory_items')
      .select('standard_unit_cost')
      .where('id', '=', itemId)
      .executeTakeFirstOrThrow();
    await h.owner
      .updateTable('inventory_items')
      .set({ standard_unit_cost: cost })
      .where('id', '=', itemId)
      .execute();
    try {
      return await fn();
    } finally {
      await h.owner
        .updateTable('inventory_items')
        .set({ standard_unit_cost: before.standard_unit_cost })
        .where('id', '=', itemId)
        .execute();
    }
  };

  /** Owner-only fixture movement on a zero-cost item (value 0, so nothing to post). */
  const fixtureMovement = async (itemId: string, delta: string, sourceId = randomUUID()) => {
    const loc = await h.owner
      .selectFrom('stock_locations')
      .select('id')
      .where('restaurant_id', '=', centralId)
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    await h.owner
      .insertInto('stock_movements')
      .values({
        org_id: centralOrg,
        restaurant_id: centralId,
        location_id: loc.id,
        inventory_item_id: itemId,
        movement_type: 'count_adjustment',
        quantity_delta: delta,
        source_type: 'adversarial_fixture',
        source_id: sourceId,
        source_key: randomUUID(),
        occurred_at: sql<Date>`now()`,
        business_date: sql<string>`app.business_date(${centralId}::uuid, now())`,
      })
      .execute();
  };

  // -------------------------------------------------------------------- setup

  beforeAll(async () => {
    h = await startHarness();
    dispatcher = h.app.get(EventDispatcher);
    centralId = await restaurantId(h, CENTRAL);
    driveId = await restaurantId(h, DRIVE);
    rivalId = await restaurantId(h, RIVAL);
    const rest = async (id: string) =>
      h.owner
        .selectFrom('restaurants')
        .select(['org_id', 'waste_approval_threshold_cents'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    const central = await rest(centralId);
    centralOrg = central.org_id;
    threshold = Number(central.waste_approval_threshold_cents);
    rivalOrg = (await rest(rivalId)).org_id;
    for (const r of await h.owner
      .selectFrom('inventory_items')
      .select(['id', 'sku'])
      .where('org_id', '=', centralOrg)
      .execute())
      itemIds.set(r.sku, r.id);
    crew = await login(h, 'crew1@central.kitchos.test');
    crew2 = await login(h, 'crew2@central.kitchos.test');
    supervisor = await login(h, 'supervisor@central.kitchos.test');
    manager = await login(h, 'manager@central.kitchos.test');
    driveCrew = await login(h, 'crew1@drive.kitchos.test');
    driveManager = await login(h, 'manager@drive.kitchos.test');
    rivalManager = await login(h, 'manager@rival.test');
    controller = await login(h, 'inventory@kitchos.test');
    auditor = await login(h, 'auditor@kitchos.test');
    areaManager = await login(h, 'area.cbd@kitchos.test');
    for (const id of [centralId, driveId, rivalId]) snapshots.set(id, await onHandSnapshot(id));
    await drain();
  });

  afterAll(async () => {
    try {
      // Whatever a failed assertion left open must not strand reservations for other files.
      for (const o of orders) {
        const tasks = await h.owner
          .selectFrom('kitchen_tasks')
          .select(['id', 'status'])
          .where('order_id', '=', o.id)
          .execute();
        const token = o.restId === centralId ? manager : driveManager;
        for (const t of tasks) {
          if (t.status !== 'done')
            await h.http
              .post(`/v1/restaurants/${o.restId}/kitchen/tasks/${t.id}/complete`)
              .set(bearer(token))
              .send({});
        }
        await h.http.post(`/v1/restaurants/${o.restId}/orders/${o.id}/handoff`).set(bearer(token));
      }
      await drain();
      await restoreOnHand(centralId, controller, snapshots.get(centralId)!);
      await restoreOnHand(driveId, controller, snapshots.get(driveId)!);
      await restoreOnHand(rivalId, rivalManager, snapshots.get(rivalId)!);
      await drain();
    } finally {
      await h?.close();
    }
  });

  // --------------------------------- 1. repeated waste of the same order line

  // Regression: the quantity cap was per request, not cumulative. Repro: pay for 1 Cheeseburger, start
  // its task (consumed, COGS 204c), POST .../inventory/waste three times with
  // { kind:'prepared_item', orderLineId, quantity:1, remake:false } and new Idempotency-Keys.
  // All three return 201 and each credits COGS 204c, so the line's COGS ends at -408c.
  // Root cause: stock-operations.service.ts:114 compares only input.quantity to line.quantity.
  it('a consumed line cannot be reclassified beyond its quantity (COGS credit is capped at what was consumed)', async () => {
    const order = await pay(CENTRAL, centralId, 'Cheeseburger');
    const line = await lineOf(order.id);
    await start(line);
    await drain();
    const consumed = -(await movementValue('order_line', line, ''));
    expect(consumed).toBeGreaterThan(0);

    const results = [];
    for (let i = 0; i < 3; i++) results.push(await waste(crew, prepared(line)));
    await drain();

    const accepted = results.filter((r) => r.status === 201).map((r) => r.body.id as string);
    expect.soft(results.map((r) => r.status)).toEqual([201, 422, 422]);
    const net = await netFor([line, ...accepted]);
    // COGS for the line = what it consumed less what was moved to waste; never below zero.
    expect.soft(net.cogs ?? 0).toBeGreaterThanOrEqual(0);
    expect.soft(net.waste_expense ?? 0).toBeLessThanOrEqual(consumed);
    expect(net.inventory).toBe(-consumed); // the physical side was only ever one portion
  });

  // Regression: same root cause as above for a multi-item line. Repro: 2 Cheeseburgers, started, three
  // quantity-1 wastes: all 201, 3 portions reclassified out of 2 consumed.
  it('partial wastes of a multi-item line are capped cumulatively', async () => {
    const order = await pay(CENTRAL, centralId, 'Cheeseburger', 2);
    const line = await lineOf(order.id);
    await start(line);
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await waste(crew, prepared(line)));
    expect(results.map((r) => r.status)).toEqual([201, 201, 422]);
  });

  // Regression: the cap had no lock either, so a double-tap race would get past it unless the
  // check serialises on the line. Repro: 4 parallel quantity-1 wastes of a consumed quantity-1 line:
  // all 201. Root cause: stock-operations.service.ts:106-126 read the line with no row lock.
  it('parallel wastes of one consumed line: exactly one succeeds', async () => {
    const order = await pay(CENTRAL, centralId, 'Cheeseburger');
    const line = await lineOf(order.id);
    await start(line);
    const results = await Promise.all([1, 2, 3, 4].map(() => waste(crew, prepared(line))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 422)).toHaveLength(3);
  });

  // The race above can pass by timing alone (a mutation check proved it), so this one is
  // deterministic: while the order's row is locked, waste of its line must wait.
  it('waste of an order line waits for the order lock', async () => {
    const order = await pay(CENTRAL, centralId, 'Cheeseburger');
    const line = await lineOf(order.id);
    await start(line);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = h.owner.transaction().execute(async (trx) => {
      await trx.selectFrom('orders').select('id').where('id', '=', order.id).forUpdate().execute();
      locked();
      await held;
    });
    await isLocked;
    let settled = false;
    const attempt = Promise.resolve(waste(crew, prepared(line))).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 750));
    expect(settled).toBe(false);
    release();
    await holder;
    expect((await attempt).status).toBe(201);
  });

  // Regression: same root cause, physical side. Repro: pay for 1 Medium Fries (unconsumed, 115 g
  // reserved), three quantity-1 wastes with remake:false: all 201 and on-hand drops 345 g against a
  // line that only ever reserved 115 g.
  it('an unconsumed line cannot have more stock deducted as waste than the line ever reserved', async () => {
    const fries = sku('FRIES-FROZEN');
    const order = await pay(CENTRAL, centralId, 'Medium Fries');
    const line = await lineOf(order.id);
    const portion = await portionOf(line, fries);
    const before = await bal(centralId, fries);
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await waste(crew, prepared(line)));
    expect.soft(results.map((r) => r.status)).toEqual([201, 422, 422]);
    expect((await bal(centralId, fries)).onHand).toBe(before.onHand - portion);
  });

  it('a rejected waste gives its quantity back: waste, reject, waste again; books follow each step', async () => {
    const order = await pay(CENTRAL, centralId, 'Cheeseburger');
    const line = await lineOf(order.id);
    await start(line);
    await drain();
    const consumed = -(await movementValue('order_line', line, ''));
    const first = await waste(crew, prepared(line));
    expect(first.status).toBe(201);
    await drain();
    expect((await review('reject', first.body.id)).status).toBe(200);
    await drain();
    expect(await netFor([line, first.body.id])).toMatchObject({
      cogs: consumed,
      inventory: -consumed,
      waste_expense: 0,
    });
    const second = await waste(crew, prepared(line));
    expect(second.status).toBe(201);
    await drain();
    expect((await netFor([line, first.body.id, second.body.id])).waste_expense).toBe(
      second.body.costCents,
    );
  });

  it('repeated remakes each consume one fresh portion and net to zero in COGS; the final non-remake waste empties it', async () => {
    const order = await pay(CENTRAL, centralId, 'Cheeseburger');
    const line = await lineOf(order.id);
    await start(line);
    await drain();
    const consumed = -(await movementValue('order_line', line, ''));
    const patty = sku('PATTY-BEEF');
    const before = await bal(centralId, patty);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await waste(crew, prepared(line, 1, true));
      expect(r.status).toBe(201);
      ids.push(r.body.id);
    }
    await drain();
    expect((await bal(centralId, patty)).onHand).toBe(before.onHand - 3000);
    expect(await netFor([line, ...ids])).toEqual({
      cogs: consumed,
      inventory: -4 * consumed,
      waste_expense: 3 * consumed,
    });
    // The last portion made is wasted with no replacement: all cost is now waste.
    const last = await waste(crew, prepared(line));
    expect(last.status).toBe(201);
    await drain();
    const net = await netFor([line, ...ids, last.body.id]);
    expect(net.cogs ?? 0).toBe(0);
    expect(net.waste_expense).toBe(4 * consumed);
    expect((await bal(centralId, patty)).onHand).toBe(before.onHand - 3000);
  });

  // NOTE (accepted, R-024): per-portion rounding can reclassify slightly more than consumption
  // booked. FRIES-FROZEN at 0.004348 c/g: a quantity-3 Medium Fries line is consumed at 20c in total,
  // but its three quantity-1 wastes cost 7c each, 21c, so the line's COGS is -1c. Pinned to under
  // 1c per portion, so a larger drift fails here.
  it('splitting a line into partial wastes drifts from its consumption value by under 1c per portion', async () => {
    const fries = sku('FRIES-FROZEN');
    const order = await pay(CENTRAL, centralId, 'Medium Fries', 3);
    const line = await lineOf(order.id);
    const { consumed, wasted, ids } = await withCost(fries, '0.004348', async () => {
      await complete(line);
      const consumed = -(await movementValue('order_line', line, ''));
      const rs = [];
      for (let i = 0; i < 3; i++) rs.push(await waste(crew, prepared(line)));
      for (const r of rs) expect(r.status).toBe(201);
      return {
        consumed,
        wasted: rs.reduce((s, r) => s + (r.body.costCents as number), 0),
        ids: rs.map((r) => r.body.id as string),
      };
    });
    await drain();
    expect(wasted).toBeLessThanOrEqual(consumed + ids.length);
    expect((await netFor([line, ...ids])).cogs ?? 0).toBeGreaterThanOrEqual(-ids.length);
  });

  // Regression (Milestone 14): a reclassification used today's standard cost, so after a cost rise
  // it credited COGS for more than was consumed (-20c here). It now uses the consumption cost.
  it('after a standard cost rise a reclassification still credits exactly what was consumed', async () => {
    const order = await pay(CENTRAL, centralId, 'Cheeseburger');
    const line = await lineOf(order.id);
    await start(line);
    const consumed = -(await movementValue('order_line', line, ''));
    const r = await withCost(sku('PATTY-BEEF'), '130', () => waste(crew, prepared(line)));
    expect(r.status).toBe(201);
    expect(r.body.costCents).toBe(consumed);
    await drain();
    const net = await netFor([line, r.body.id]);
    expect(net.cogs ?? 0).toBe(0);
    expect(net.inventory).toBe(-consumed);
  });

  // ------------------------------------ 1b. the reservation of a wasted line

  // NOTE (design question, see report): remake:false on an unconsumed line has no effect on later
  // consumption, so a line wasted "with no replacement" that is still completed deducts two portions.
  // Everything else about it holds: reservation closed exactly once, books match.
  it('waste then consumption of an unconsumed line: reservation stays active, then closes once; two portions, posted separately', async () => {
    const fries = sku('FRIES-FROZEN');
    const before = await bal(centralId, fries);
    const order = await pay(CENTRAL, centralId, 'Medium Fries');
    const line = await lineOf(order.id);
    const portion = await portionOf(line, fries);
    const w = await waste(crew, prepared(line));
    expect(w.status).toBe(201);

    const during = await bal(centralId, fries);
    expect(during.onHand).toBe(before.onHand - portion);
    expect(during.reserved).toBe(before.reserved + portion);
    expect((await reservationsOf(line)).every((r) => r.status === 'active')).toBe(true);

    await complete(line);
    await drain();
    const after = await bal(centralId, fries);
    expect(after.onHand).toBe(before.onHand - 2 * portion);
    expect(after.reserved).toBe(before.reserved);
    expect((await reservationsOf(line)).every((r) => r.status === 'consumed')).toBe(true);
    const deducted = await movementValue('waste_record', w.body.id);
    expect((await netFor([w.body.id])).inventory).toBe(deducted);
    const consumed = await movementValue('order_line', line, '');
    expect((await netFor([line])).inventory).toBe(consumed);
    expect(await reconciliationErrors(h)).toEqual([]);
  });

  it('waste then cancellation of an unconsumed line: reservation released, not stranded; only the wasted portion is gone; rejection restores it', async () => {
    const fries = sku('FRIES-FROZEN');
    const before = await bal(centralId, fries);
    const order = await pay(CENTRAL, centralId, 'Medium Fries');
    const line = await lineOf(order.id);
    const portion = await portionOf(line, fries);
    const w = await waste(crew, prepared(line));
    expect(w.status).toBe(201);
    await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/cancel`)
      .set(bearer(manager))
      .send({ reason: 'customer left' })
      .expect(200);
    const after = await bal(centralId, fries);
    expect(after.onHand).toBe(before.onHand - portion);
    expect(after.reserved).toBe(before.reserved);
    expect((await reservationsOf(line)).every((r) => r.status === 'released')).toBe(true);
    expect(await movementCount('order_line', line)).toBe(0);

    expect((await review('reject', w.body.id)).status).toBe(200);
    expect(await bal(centralId, fries)).toEqual(before);
    await drain();
    expect(await reconciliationErrors(h)).toEqual([]);
  });

  // ------------------------------------------------------------- 2. combos

  it('a meal: the combo parent cannot be wasted; components are wasted individually, each by its own consumption state', async () => {
    const order = await pay(CENTRAL, centralId, 'Cheeseburger Meal', 2);
    await drain();
    const lines = await linesOf(order.id);
    const parent = lines.find((l) => l.kind === 'combo')!;
    const drink = lines.find((l) => l.consumption_point === 'order_accepted')!;
    const fries = lines.find((l) => l.consumption_point === 'task_completed')!;
    expect(parent).toBeDefined();

    const onParent = await waste(crew, prepared(parent.id));
    expect([404, 422]).toContain(onParent.status);
    expect(
      await h.owner
        .selectFrom('waste_records')
        .select('id')
        .where('order_line_id', '=', parent.id)
        .execute(),
    ).toEqual([]);

    // A component's cap is its own quantity.
    expect((await waste(crew, prepared(drink.id, drink.quantity + 1))).status).toBe(422);

    const drinkCogs = await netFor([order.id]);
    const wd = await waste(crew, prepared(drink.id));
    expect(wd.status).toBe(201);
    expect(
      wd.body.lines.every((l: { treatment: string }) => l.treatment === 'already_consumed'),
    ).toBe(true);
    const friesOnHand = await bal(centralId, sku('FRIES-FROZEN'));
    const wf = await waste(crew, prepared(fries.id));
    expect(wf.status).toBe(201);
    expect(wf.body.lines.every((l: { treatment: string }) => l.treatment === 'deducted_now')).toBe(
      true,
    );
    expect((await bal(centralId, sku('FRIES-FROZEN'))).onHand).toBe(
      friesOnHand.onHand - (await portionOf(fries.id, sku('FRIES-FROZEN'))),
    );
    await drain();
    // Reclassification of one drink out of the order's single COGS entry; nothing posted twice.
    expect(await netFor([wd.body.id])).toEqual({
      waste_expense: wd.body.costCents,
      cogs: -wd.body.costCents,
    });
    expect(await netFor([order.id])).toEqual(drinkCogs);
    // One of two drinks, each costed from its own portion: within a rounding cent of half the entry.
    expect(Math.abs(wd.body.costCents - (drinkCogs.cogs ?? 0) / 2)).toBeLessThanOrEqual(1);
    expect(await netFor([wf.body.id])).toEqual({
      waste_expense: wf.body.costCents,
      inventory: -wf.body.costCents,
    });
    expect(await netFor([parent.id])).toEqual({});
  });

  // ---------------------------------------------------- 3. approve vs reject

  it('approve racing reject: one decision, at most one correction set, one journal entry each way', async () => {
    const patty = sku('PATTY-BEEF');
    for (let round = 0; round < 3; round++) {
      const before = await bal(centralId, patty);
      const w = await waste(crew, raw(patty, '20', 'temperature_breach'));
      expect(w.status).toBe(201);
      expect(w.body.status).toBe('pending_approval');
      const h2Decisions = await Promise.all([
        review('approve', w.body.id, controller),
        review('reject', w.body.id, manager),
      ]);
      expect(h2Decisions.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = h2Decisions[0]!.status === 200 ? 'approved' : 'rejected';

      const row = await h.owner
        .selectFrom('waste_records')
        .select(['status', 'version'])
        .where('id', '=', w.body.id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe(winner);
      expect(row.version).toBe(2);
      const audits = await h.owner
        .selectFrom('audit_log')
        .select('action')
        .where('entity_id', '=', w.body.id)
        .where('action', 'in', ['waste.approve', 'waste.reject'])
        .execute();
      expect(audits).toHaveLength(1);
      const reversals = await movementCount('waste_reversal', w.body.id);
      expect(reversals).toBe(winner === 'rejected' ? 1 : 0);
      expect((await bal(centralId, patty)).onHand).toBe(
        winner === 'rejected' ? before.onHand : before.onHand - 20_000,
      );
      await drain();
      const types = (await entriesOf(w.body.id)).map((e) => e.entry_type).sort();
      expect(types).toEqual(winner === 'rejected' ? ['waste', 'waste_reversal'] : ['waste']);
    }
    await assertReconciled();
  });

  it('reject raced and replayed: one correction, one reversal; no decision after a decision', async () => {
    const tomato = sku('TOMATO');
    const before = await bal(centralId, tomato);
    const w = await waste(crew, raw(tomato, '10'));
    expect(w.body.status).toBe('recorded');
    const both = await Promise.all([
      review('reject', w.body.id, manager),
      review('reject', w.body.id, controller),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await review('reject', w.body.id, manager)).status).toBe(409);
    expect((await review('approve', w.body.id, manager)).status).toBe(409);
    expect(await movementCount('waste_reversal', w.body.id)).toBe(1);
    expect(await bal(centralId, tomato)).toEqual(before);
    await drain();
    expect((await entriesOf(w.body.id)).map((e) => e.entry_type).sort()).toEqual([
      'waste',
      'waste_reversal',
    ]);
    expect(await netFor([w.body.id])).toEqual({ inventory: 0, waste_expense: 0 });

    // An approved record is final: rejecting it later must not move stock.
    const a = await waste(crew, raw(sku('PATTY-BEEF'), '20', 'temperature_breach'));
    expect((await review('approve', a.body.id, manager)).status).toBe(200);
    expect((await review('reject', a.body.id, controller)).status).toBe(409);
    expect(await movementCount('waste_reversal', a.body.id)).toBe(0);
  });

  // ---------------------------------------------------------------- 4. counts

  it('parallel counts on one item serialise: each expected is the previous counted, final = last, ledger = balance', async () => {
    const onion = sku('ONION');
    const start0 = (await bal(centralId, onion)).onHand;
    const values = Array.from({ length: 8 }, (_, i) => start0 - (i + 1) * 1000);
    const results = await Promise.all(
      values.map((v) =>
        count(controller, [{ inventoryItemId: onion, counted: formatDecimalQty(v) }]),
      ),
    );
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(201);

    const next = new Map<number, number>(
      results.map((r) => {
        const l = r.body.lines[0];
        return [parseDecimalQty(l.expected), parseDecimalQty(l.counted)];
      }),
    );
    let walk: number = start0;
    for (let i = 0; i < values.length; i++) {
      const n = next.get(walk);
      expect(n, `no count locked on-hand ${walk}`).toBeDefined();
      walk = n!;
    }
    expect((await bal(centralId, onion)).onHand).toBe(walk);
    await drain();
    for (const r of results) {
      const v = await movementValue('stock_count', r.body.id);
      expect(v).toBe(r.body.varianceCents);
      expect((await netFor([r.body.id])).inventory ?? 0).toBe(v);
    }
    await assertReconciled();
  });

  it('multi-item counts, receipts and recipes in opposite item orders do not deadlock', async () => {
    const [a, b, c] = [sku('ONION'), sku('LETTUCE'), sku('TOMATO')];
    const onHand = async (id: string) => formatDecimalQty((await bal(centralId, id)).onHand);
    const [qa, qb, qc] = [await onHand(a), await onHand(b), await onHand(c)];
    const ops = await Promise.all(
      Array.from({ length: 4 }, (_, i) => [
        count(
          controller,
          [a, b, c].map((id, j) => ({
            inventoryItemId: id,
            counted: [qa, qb, qc][j]!,
          })),
        ),
        count(
          controller,
          [c, b, a].map((id) => ({
            inventoryItemId: id,
            counted: id === a ? qa : id === b ? qb : qc,
          })),
        ),
        receipt(controller, [
          { inventoryItemId: c, quantity: String(i + 1) },
          { inventoryItemId: a, quantity: String(i + 1) },
        ]),
      ]).flat(),
    );
    for (const r of ops) expect(r.status, JSON.stringify(r.body)).toBe(201);
    await assertReconciled();
  });

  it('a count racing a receipt and a waste: on-hand = counted plus whatever the count did not see', async () => {
    const lettuce = sku('LETTUCE');
    const [R, W] = [7_000, 3_000];
    for (let round = 0; round < 4; round++) {
      const s = (await bal(centralId, lettuce)).onHand;
      const target = s + 11_000;
      const [c, rc, w] = await Promise.all([
        count(controller, [{ inventoryItemId: lettuce, counted: formatDecimalQty(target) }]),
        receipt(controller, [{ inventoryItemId: lettuce, quantity: formatDecimalQty(R) }]),
        waste(crew, raw(lettuce, formatDecimalQty(W))),
      ]);
      expect([c.status, rc.status, w.status]).toEqual([201, 201, 201]);
      const expected = parseDecimalQty(c.body.lines[0].expected);
      const sawR = expected === s + R || expected === s + R - W;
      const sawW = expected === s - W || expected === s + R - W;
      expect(sawR || sawW || expected === s, `expected=${expected} s=${s}`).toBe(true);
      expect((await bal(centralId, lettuce)).onHand).toBe(target + (sawR ? 0 : R) - (sawW ? 0 : W));
      await drain();
      expect((await netFor([rc.body.id])).inventory).toBe(
        await movementValue('goods_receipt', rc.body.id),
      );
      expect((await netFor([w.body.id])).inventory).toBe(
        await movementValue('waste_record', w.body.id),
      );
      expect((await netFor([c.body.id])).inventory ?? 0).toBe(
        await movementValue('stock_count', c.body.id),
      );
    }
    await assertReconciled();
  });

  // ----------------------------------------------------------- 5. idempotency

  it('a key used with a different body is refused for waste, receipts and counts, and writes nothing', async () => {
    const lettuce = sku('LETTUCE');
    const before = await bal(centralId, lettuce);
    const wk = randomUUID();
    const w = await waste(crew, raw(lettuce, '1'), { key: wk });
    expect(w.status).toBe(201);
    const other = await waste(crew, raw(lettuce, '2'), { key: wk });
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await bal(centralId, lettuce)).onHand).toBe(before.onHand - 1000);

    const rk = randomUUID();
    await receipt(manager, [{ inventoryItemId: lettuce, quantity: '1' }], { key: rk }).expect(201);
    expect(
      (await receipt(manager, [{ inventoryItemId: lettuce, quantity: '2' }], { key: rk })).status,
    ).toBe(422);
    expect((await bal(centralId, lettuce)).onHand).toBe(before.onHand);

    const ck = randomUUID();
    const cnt = formatDecimalQty(before.onHand);
    await count(manager, [{ inventoryItemId: lettuce, counted: cnt }], { key: ck }).expect(201);
    expect(
      (
        await count(
          manager,
          [{ inventoryItemId: lettuce, counted: formatDecimalQty(before.onHand + 1000) }],
          { key: ck },
        )
      ).status,
    ).toBe(422);
    expect((await bal(centralId, lettuce)).onHand).toBe(before.onHand);
  });

  it('the same key at another restaurant or tenant is its own request, never a replay', async () => {
    const key = randomUUID();
    const body = raw(sku('LETTUCE'), '1');
    const a = await waste(controller, body, { key });
    const b = await waste(controller, body, { key, restId: driveId });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
    expect(b.body.id).not.toBe(a.body.id);
    expect(await movementCount('waste_record', a.body.id)).toBe(1);
    expect(await movementCount('waste_record', b.body.id)).toBe(1);

    const rivalItem = await h.owner
      .selectFrom('inventory_items')
      .select('id')
      .where('org_id', '=', rivalOrg)
      .where('sku', '=', 'BUN')
      .executeTakeFirstOrThrow();
    const c = await waste(rivalManager, raw(rivalItem.id, '1'), { key, restId: rivalId });
    expect(c.status).toBe(201);
    expect(c.headers['idempotent-replayed']).toBeUndefined();
    const row = await h.owner
      .selectFrom('waste_records')
      .select(['org_id', 'restaurant_id'])
      .where('id', '=', c.body.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ org_id: rivalOrg, restaurant_id: rivalId });
  });

  it('replay after a rejection returns the original response and does not re-deduct; a new key does', async () => {
    const tomato = sku('TOMATO');
    const before = await bal(centralId, tomato);
    const key = randomUUID();
    const w = await waste(crew, raw(tomato, '5'), { key });
    expect(w.status).toBe(201);
    expect((await review('reject', w.body.id)).status).toBe(200);
    expect(await bal(centralId, tomato)).toEqual(before);

    const replay = await waste(crew, raw(tomato, '5'), { key });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(w.body.id);
    expect(await bal(centralId, tomato)).toEqual(before);
    expect(await movementCount('waste_record', w.body.id)).toBe(1);
    const row = await h.owner
      .selectFrom('waste_records')
      .select('status')
      .where('id', '=', w.body.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('rejected');
    await drain();
    expect((await entriesOf(w.body.id)).map((e) => e.entry_type).sort()).toEqual([
      'waste',
      'waste_reversal',
    ]);
  });

  it('parallel requests with one key create one record; a failed attempt leaves the key usable', async () => {
    const tomato = sku('TOMATO');
    const before = await bal(centralId, tomato);
    const key = randomUUID();
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => waste(crew, raw(tomato, '2'), { key })));
    for (const r of rs) expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(rs.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(4);
    expect((await bal(centralId, tomato)).onHand).toBe(before.onHand - 2000);

    const retryKey = randomUUID();
    const body = raw(randomUUID(), '1');
    expect((await waste(crew, body, { key: retryKey })).status).toBe(404);
    const stored = await h.owner
      .selectFrom('idempotency_keys')
      .select('key')
      .where('key', '=', retryKey)
      .execute();
    expect(stored).toEqual([]);
    expect((await waste(crew, raw(tomato, '1'), { key: retryKey })).status).toBe(201);

    const noKey = await h.http
      .post(`/v1/restaurants/${centralId}/inventory/waste`)
      .set(bearer(crew))
      .send(raw(tomato, '1'));
    expect(noKey.status).toBe(400);
  });

  // ----------------------------------------------------------- 6. boundaries

  it('0.001 of a low-cost item: cost rounds to 0c, the movement stands, nothing posts, event still claimed', async () => {
    const tomato = sku('TOMATO');
    const before = await bal(centralId, tomato);
    const w = await waste(crew, raw(tomato, '0.001'));
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({ costCents: 0, status: 'recorded' });
    expect((await bal(centralId, tomato)).onHand).toBe(before.onHand - 1);
    expect(await movementValue('waste_record', w.body.id)).toBe(0);
    await drain();
    expect(await entriesOf(w.body.id)).toEqual([]);
    expect((await review('reject', w.body.id)).status).toBe(200);
    expect((await bal(centralId, tomato)).onHand).toBe(before.onHand);
    await assertReconciled();
    expect(await entriesOf(w.body.id)).toEqual([]);
    const claimed = await h.owner
      .selectFrom('outbox_events as o')
      .innerJoin('inbox_events as i', (j) =>
        j.onRef('i.event_id', '=', 'o.id').on('i.consumer', '=', 'ledger'),
      )
      .select('o.event_type')
      .where('o.aggregate_id', '=', w.body.id)
      .execute();
    expect(claimed.map((c) => c.event_type).sort()).toEqual([
      'inventory.waste_recorded',
      'inventory.waste_rejected',
    ]);
  });

  it('the approval threshold: exactly at it is recorded; one cent over needs approval', async () => {
    const id = await tempItem('1');
    const q = (cents: number) => formatDecimalQty(cents * 1000);
    const at = await waste(crew, raw(id, q(threshold)));
    const over = await waste(crew, raw(id, q(threshold + 1)));
    try {
      expect(at.body).toMatchObject({ status: 'recorded', costCents: threshold });
      expect(over.body).toMatchObject({ status: 'pending_approval', costCents: threshold + 1 });
      expect((await bal(centralId, id)).onHand).toBe(-(2 * threshold + 1) * 1000);
      await drain();
      expect((await netFor([at.body.id])).waste_expense).toBe(threshold);
      expect((await netFor([over.body.id])).waste_expense).toBe(threshold + 1);
    } finally {
      await review('reject', at.body.id);
      await review('reject', over.body.id);
    }
    expect((await bal(centralId, id)).onHand).toBe(0);
    await drain();
    expect(await netFor([at.body.id, over.body.id])).toEqual({ inventory: 0, waste_expense: 0 });
  });

  it('waste can take on-hand negative (physical truth); the ledger stays equal, and a count of 0 corrects it', async () => {
    const id = await tempItem('2');
    const w = await waste(crew, raw(id, '5'));
    expect(w.status).toBe(201);
    expect(await bal(centralId, id)).toEqual({ onHand: -5000, reserved: 0 });
    expect(await movementValue('waste_record', w.body.id)).toBe(-10);
    const c = await count(controller, [{ inventoryItemId: id, counted: '0' }]);
    expect(c.status).toBe(201);
    expect(c.body.lines[0]).toMatchObject({ variance: '5.000', varianceCents: 10 });
    expect((await bal(centralId, id)).onHand).toBe(0);
    // Counting 0 again is no change, no movement, no entry.
    const again = await count(controller, [{ inventoryItemId: id, counted: '0.000' }]);
    expect(again.status).toBe(201);
    expect(await movementCount('stock_count', again.body.id)).toBe(0);
    await assertReconciled();
    expect(await entriesOf(again.body.id)).toEqual([]);
    expect(await netFor([w.body.id, c.body.id])).toEqual({
      inventory: 0,
      waste_expense: 10,
      stock_variance: -10,
    });
  });

  it('a count below reserved is allowed; available goes negative, new orders are refused, consumption still completes', async () => {
    const fries = sku('FRIES-FROZEN');
    const original = await bal(centralId, fries);
    const order = await pay(CENTRAL, centralId, 'Medium Fries');
    const line = await lineOf(order.id);
    const portion = await portionOf(line, fries);
    try {
      const reservedNow = (await bal(centralId, fries)).reserved;
      expect(reservedNow).toBe(original.reserved + portion);
      const c = await count(controller, [{ inventoryItemId: fries, counted: '0' }]);
      expect(c.status).toBe(201);
      const after = await bal(centralId, fries);
      expect(after).toEqual({ onHand: 0, reserved: reservedNow });
      const listed = await h.http
        .get(`/v1/restaurants/${centralId}/inventory/balances`)
        .set(bearer(manager))
        .expect(200);
      const row = (listed.body as { inventoryItemId: string; available: string }[]).find(
        (b) => b.inventoryItemId === fries,
      )!;
      expect(row.available).toBe(formatDecimalQty(-reservedNow));

      const menu = await getMenu(h, CENTRAL);
      const refused = await placeOrder(h, CENTRAL, [
        { menuItemId: item(menu, 'Medium Fries').id, quantity: 1 },
      ]);
      expect(refused.status).toBe(409);

      await complete(line);
      const done = await bal(centralId, fries);
      expect(done).toEqual({ onHand: -portion, reserved: original.reserved });
      expect(await reconciliationErrors(h)).toEqual([]);
    } finally {
      await count(controller, [
        { inventoryItemId: fries, counted: formatDecimalQty(original.onHand) },
      ]);
    }
    await assertReconciled();
  });

  it('negative half-cent variances round the same way in the response and the ledger', async () => {
    const lettuce = sku('LETTUCE'); // 0.8 c/g: -0.625 g is exactly -0.5c
    const s = (await bal(centralId, lettuce)).onHand;
    const c = await count(controller, [
      { inventoryItemId: lettuce, counted: formatDecimalQty(s - 625) },
    ]);
    expect(c.status).toBe(201);
    expect(c.body.lines[0].varianceCents).toBe(-1);
    expect(await movementValue('stock_count', c.body.id)).toBe(-1);
    await drain();
    expect((await netFor([c.body.id])).inventory).toBe(-1);
    await count(controller, [{ inventoryItemId: lettuce, counted: formatDecimalQty(s) }]);
    await drain();
  });

  it('malformed quantities stop at the boundary and write nothing', async () => {
    const lettuce = sku('LETTUCE');
    const before = await bal(centralId, lettuce);
    for (const q of ['0', '0.000', '0.0001', '-1', '1e3', '1000000000000', '']) {
      expect((await waste(crew, raw(lettuce, q))).status, `waste ${q}`).toBe(400);
      expect(
        (await receipt(manager, [{ inventoryItemId: lettuce, quantity: q }])).status,
        `receipt ${q}`,
      ).toBe(400);
    }
    for (const q of ['-1', '1e3', '1000000000000', '0.0001']) {
      expect(
        (await count(manager, [{ inventoryItemId: lettuce, counted: q }])).status,
        `count ${q}`,
      ).toBe(400);
    }
    const line = randomUUID();
    for (const q of [0, -1, 1.5, 101]) {
      expect((await waste(crew, prepared(line, q))).status, `prepared ${q}`).toBe(400);
    }
    expect(await bal(centralId, lettuce)).toEqual(before);
  });

  it('a huge valid waste is valued exactly, waits for approval and is fully reversible', async () => {
    const chicken = sku('CHICKEN-FILLET');
    const before = await bal(driveId, chicken);
    const w = await waste(driveCrew, raw(chicken, '999999999999.999'), { restId: driveId });
    expect(w.status).toBe(201);
    try {
      expect(w.body).toMatchObject({ status: 'pending_approval', costCents: 150_000_000_000_000 });
      expect(await movementValue('waste_record', w.body.id)).toBe(-150_000_000_000_000);
      await drain();
      expect((await netFor([w.body.id])).inventory).toBe(-150_000_000_000_000);
    } finally {
      expect((await review('reject', w.body.id, driveManager, driveId)).status).toBe(200);
    }
    expect(await bal(driveId, chicken)).toEqual(before);
    await drain();
    expect(await netFor([w.body.id])).toEqual({ inventory: 0, waste_expense: 0 });
    expect(await reconciliation(driveId, driveManager)).toMatchObject({ reconciled: true });
  });

  // Regression: a balance past 2^53 milli-units (about 9.007e12 units) cannot be read back, and it
  // takes the whole restaurant's stock list with it. Repro: as crew (waste.record only), POST ten
  // raw wastes of 999999999999.999 of one item. on_hand = -9999999999999.990, within numeric(18,3).
  // GET .../inventory/balances then returns 500 for every item at the restaurant, and POST
  // .../inventory/counts on that item returns 500, so a count cannot correct it (only rejecting
  // each record does). Root cause: inventory.controller.ts:48 and inventory.service.ts:267 parse
  // on_hand via parseDecimalQty (packages/domain/src/quantity.ts:13 throws above MAX_SAFE_INTEGER);
  // nothing bounds a balance to that range when movements are written.
  it('crew cannot wedge the balances screen or counts by pushing a balance past the safe-integer range', async () => {
    const id = await tempItem('0');
    const ids: string[] = [];
    try {
      for (let i = 0; i < 10; i++) {
        const r = await waste(crew, raw(id, '999999999999.999', 'expired'));
        if (r.status === 201) ids.push(r.body.id);
      }
      const list = await h.http
        .get(`/v1/restaurants/${centralId}/inventory/balances`)
        .set(bearer(manager));
      expect.soft(list.status, 'balances').toBe(200);
      const c = await count(controller, [{ inventoryItemId: id, counted: '0' }]);
      expect.soft(c.status, 'count').toBeLessThan(500);
    } finally {
      for (const w of ids) await review('reject', w, manager);
      const left = await h.owner
        .selectFrom('stock_balances')
        .select('on_hand')
        .where('inventory_item_id', '=', id)
        .execute();
      for (const row of left)
        if (row.on_hand !== '0.000')
          await fixtureMovement(
            id,
            row.on_hand.startsWith('-') ? row.on_hand.slice(1) : `-${row.on_hand}`,
          );
    }
    expect((await bal(centralId, id)).onHand).toBe(0);
    await drain();
  });

  // Regression: on-hand overflow surfaced as an unhandled 500. Repro: with on_hand at
  // 999999999999999.000 (the top of numeric(18,3)), POST a receipt of 999999999999.999: the
  // movement trigger hits numeric overflow and the API answers 500 rather than a 4xx. State is
  // safe (the transaction rolls back). Root cause: inventory.service.ts:209 recordMovements has no
  // bound check and the DB error is not mapped.
  it('a receipt that would overflow numeric(18,3) is refused as a client error and writes nothing', async () => {
    const id = await tempItem('0');
    const max = '999999999999999.000';
    await fixtureMovement(id, max);
    try {
      const r = await receipt(controller, [{ inventoryItemId: id, quantity: '999999999999.999' }]);
      expect.soft(r.status).toBeGreaterThanOrEqual(400);
      expect.soft(r.status).toBeLessThan(500);
      const row = await h.owner
        .selectFrom('stock_balances')
        .select('on_hand')
        .where('inventory_item_id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.on_hand).toBe(max);
    } finally {
      await fixtureMovement(id, `-${max}`);
    }
    expect((await bal(centralId, id)).onHand).toBe(0);
  });

  // ---------------------------------------------------------------- 7. access

  it('waste/mine shows a crew member only their own records, including ones others reviewed', async () => {
    const lettuce = sku('LETTUCE');
    const inv = `/v1/restaurants/${centralId}/inventory`;
    const me = (await h.http.get('/v1/me').set(bearer(crew2))).body.user.id as string;
    const mine = await waste(crew2, raw(lettuce, '0.5'));
    const theirs = await waste(crew, raw(lettuce, '0.5'));
    expect((await review('reject', mine.body.id)).status).toBe(200);
    const list = (await h.http.get(`${inv}/waste/mine`).set(bearer(crew2)).expect(200))
      .body as WasteRecordView[];
    expect(list.map((w) => w.id)).toContain(mine.body.id);
    expect(list.map((w) => w.id)).not.toContain(theirs.body.id);
    expect(new Set(list.map((w) => w.recordedById))).toEqual(new Set([me]));
    expect(list.find((w) => w.id === mine.body.id)!.status).toBe('rejected');
    // Other restaurants' records stay out too, even for the same person.
    const c1 = await waste(controller, raw(lettuce, '0.5'));
    const d1 = await waste(controller, raw(lettuce, '0.5'), { restId: driveId });
    const ctrlCentral = (await h.http.get(`${inv}/waste/mine`).set(bearer(controller)).expect(200))
      .body as WasteRecordView[];
    expect(ctrlCentral.map((w) => w.id)).toContain(c1.body.id);
    expect(ctrlCentral.map((w) => w.id)).not.toContain(d1.body.id);

    expect((await h.http.get(`${inv}/waste`).set(bearer(crew))).status).toBe(403);
    expect((await h.http.get(`${inv}/waste/mine`).set(bearer(auditor))).status).toBe(403);
    expect((await h.http.get(`${inv}/waste/mine`).set(bearer(driveCrew))).status).toBeOneOf([
      403, 404,
    ]);
    expect((await h.http.get(`${inv}/waste/mine`).set(bearer(rivalManager))).status).toBe(404);
  });

  it("waste-items exposes no quantities or costs, only the restaurant's items, and not to oversight or other tenants", async () => {
    const inv = `/v1/restaurants/${centralId}/inventory`;
    const id = await tempItem('50');
    await fixtureMovement(id, '0.001'); // has a balance row; value rounds to 0
    const res = await h.http.get(`${inv}/waste-items`).set(bearer(crew)).expect(200);
    const items = res.body as Record<string, unknown>[];
    for (const i of items) {
      expect(Object.keys(i).sort()).toEqual([
        'baseUnit',
        'category',
        'inventoryItemId',
        'name',
        'sku',
      ]);
    }
    expect(items.map((i) => i.inventoryItemId)).toContain(id);
    expect(JSON.stringify(res.body)).not.toMatch(/onHand|reserved|available|cost|cents/i);
    await fixtureMovement(id, '-0.001');
    const rivalItems = await h.owner
      .selectFrom('inventory_items')
      .select('id')
      .where('org_id', '=', rivalOrg)
      .execute();
    for (const r of rivalItems) expect(JSON.stringify(res.body)).not.toContain(r.id);

    expect((await h.http.get(`${inv}/waste-items`).set(bearer(areaManager))).status).toBe(403);
    expect((await h.http.get(`${inv}/waste-items`).set(bearer(auditor))).status).toBe(403);
    expect((await h.http.get(`${inv}/waste-items`).set(bearer(rivalManager))).status).toBe(404);
    expect((await h.http.get(`${inv}/waste-items`).set(bearer(driveCrew))).status).toBeOneOf([
      403, 404,
    ]);
    expect((await h.http.get(`${inv}/waste-items`).set(bearer(controller))).status).toBe(200);
    expect((await h.http.get(`${inv}/waste-items`)).status).toBe(401);
  });

  it("another tenant's ids through every endpoint: nothing found, nothing written", async () => {
    const inv = `/v1/restaurants/${centralId}/inventory`;
    const rivalItem = await h.owner
      .selectFrom('inventory_items')
      .select('id')
      .where('org_id', '=', rivalOrg)
      .where('sku', '=', 'BUN')
      .executeTakeFirstOrThrow();
    const rivalStation = await h.owner
      .selectFrom('stations')
      .select('id')
      .where('restaurant_id', '=', rivalId)
      .executeTakeFirst();
    const driveStation = await h.owner
      .selectFrom('stations')
      .select('id')
      .where('restaurant_id', '=', driveId)
      .executeTakeFirst();
    const rivalMenu = await getMenu(h, RIVAL);
    const rivalBurger = item(rivalMenu, 'Plain Burger').id;
    const rivalOrder = await placeOrder(h, RIVAL, [{ menuItemId: rivalBurger, quantity: 1 }]);
    const rivalLine =
      rivalOrder.status === 201
        ? (
            await h.owner
              .selectFrom('order_lines')
              .select('id')
              .where('order_id', '=', rivalOrder.body.id)
              .executeTakeFirstOrThrow()
          ).id
        : randomUUID();
    const rivalWaste = await waste(rivalManager, raw(rivalItem.id, '0.5'), { restId: rivalId });
    expect(rivalWaste.status).toBe(201);
    const central = await waste(crew, raw(sku('LETTUCE'), '0.5'));
    const countsBefore = await h.owner
      .selectFrom('waste_records')
      .select(sql<string>`count(*)`.as('n'))
      .where('restaurant_id', '=', centralId)
      .executeTakeFirstOrThrow();

    // Rival ids in Central requests by Central staff.
    expect((await waste(manager, raw(rivalItem.id, '1'))).status).toBe(404);
    expect((await waste(manager, prepared(rivalLine))).status).toBe(404);
    expect(
      (
        await waste(manager, {
          kind: 'prepared_item',
          menuItemId: rivalBurger,
          quantity: 1,
          reason: 'overproduction',
        })
      ).status,
    ).toBe(404);
    if (rivalStation) {
      expect(
        (await waste(manager, { ...raw(sku('LETTUCE'), '1'), stationId: rivalStation.id })).status,
      ).toBe(404);
    }
    if (driveStation) {
      expect(
        (await waste(manager, { ...raw(sku('LETTUCE'), '1'), stationId: driveStation.id })).status,
      ).toBe(404);
    }
    expect((await review('approve', rivalWaste.body.id)).status).toBe(404);
    expect((await review('reject', rivalWaste.body.id)).status).toBe(404);
    expect(
      (await receipt(manager, [{ inventoryItemId: rivalItem.id, quantity: '1' }])).status,
    ).toBe(404);
    expect((await count(manager, [{ inventoryItemId: rivalItem.id, counted: '1' }])).status).toBe(
      404,
    );

    // Rival staff through Central's restaurant, and Central ids through Rival's.
    const asRival = rivalManager;
    for (const path of ['balances', 'waste', 'waste/mine', 'waste-items', 'movements']) {
      expect((await h.http.get(`${inv}/${path}`).set(bearer(asRival))).status, path).toBe(404);
    }
    expect((await waste(asRival, raw(sku('LETTUCE'), '1'))).status).toBe(404);
    expect((await review('reject', central.body.id, asRival)).status).toBe(404);
    expect((await review('reject', central.body.id, asRival, rivalId)).status).toBe(404);
    expect((await review('approve', central.body.id, asRival, rivalId)).status).toBe(404);
    expect(
      (await receipt(asRival, [{ inventoryItemId: sku('LETTUCE'), quantity: '1' }])).status,
    ).toBe(404);
    expect((await count(asRival, [{ inventoryItemId: sku('LETTUCE'), counted: '1' }])).status).toBe(
      404,
    );
    expect((await waste(asRival, raw(sku('LETTUCE'), '1'), { restId: rivalId })).status).toBe(404);
    expect(
      (
        await h.http
          .get(`/v1/restaurants/${rivalId}/inventory/movements?sourceId=${central.body.id}`)
          .set(bearer(asRival))
          .expect(200)
      ).body,
    ).toEqual([]);

    // Sister restaurant in the same org: record and line are scoped by restaurant, not just org.
    const order = await pay(CENTRAL, centralId, 'Medium Cola');
    const line = await lineOf(order.id);
    expect((await waste(driveManager, prepared(line), { restId: driveId })).status).toBe(404);
    expect((await review('reject', central.body.id, driveManager, driveId)).status).toBe(404);
    expect((await review('reject', central.body.id, driveManager)).status).toBeOneOf([403, 404]);

    const countsAfter = await h.owner
      .selectFrom('waste_records')
      .select(sql<string>`count(*)`.as('n'))
      .where('restaurant_id', '=', centralId)
      .executeTakeFirstOrThrow();
    expect(countsAfter.n).toBe(countsBefore.n);
    const untouched = await h.owner
      .selectFrom('waste_records')
      .select('status')
      .where('id', 'in', [central.body.id, rivalWaste.body.id])
      .execute();
    expect(untouched.map((r) => r.status)).toEqual(['recorded', 'recorded']);
    if (rivalOrder.status === 201) {
      await h.http
        .post(`/v1/restaurants/${rivalId}/orders/${rivalOrder.body.id}/cancel`)
        .set(bearer(rivalManager))
        .send({ reason: 'adversarial test cleanup' })
        .expect(200);
    }
  });

  it('roles: crew, supervisor, oversight and the inventory controller can do only what their permissions say', async () => {
    const inv = `/v1/restaurants/${centralId}/inventory`;
    const lettuce = sku('LETTUCE');
    const w = await waste(crew2, raw(lettuce, '0.5'));
    expect(w.status).toBe(201);
    for (const t of [crew, crew2, supervisor, auditor, areaManager]) {
      expect((await review('reject', w.body.id, t)).status).toBe(403);
      expect((await review('approve', w.body.id, t)).status).toBe(403);
    }
    for (const t of [crew, supervisor, auditor, areaManager]) {
      expect((await receipt(t, [{ inventoryItemId: lettuce, quantity: '1' }])).status).toBe(403);
      expect((await count(t, [{ inventoryItemId: lettuce, counted: '1' }])).status).toBe(403);
    }
    for (const t of [auditor, areaManager]) {
      expect((await waste(t, raw(lettuce, '1'))).status).toBe(403);
      expect((await h.http.get(`${inv}/balances`).set(bearer(t))).status).toBe(200);
    }
    // The controller can record and review but not their own, and sees no summary (reports.view).
    const own = await waste(controller, raw(lettuce, '0.5'));
    expect(own.status).toBe(201);
    expect((await review('reject', own.body.id, controller)).status).toBe(403);
    const day = await businessDate(centralId);
    expect(
      (await h.http.get(`${inv}/waste/summary?from=${day}&to=${day}`).set(bearer(controller)))
        .status,
    ).toBe(403);
    // A rejected reviewer attempt changed nothing.
    const row = await h.owner
      .selectFrom('waste_records')
      .select(['status', 'version'])
      .where('id', '=', w.body.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'recorded', version: 1 });
  });

  it('client-supplied identity and money in the body are ignored', async () => {
    const lettuce = sku('LETTUCE');
    const me = (await h.http.get('/v1/me').set(bearer(crew))).body.user.id as string;
    const mgr = (await h.http.get('/v1/me').set(bearer(manager))).body.user.id as string;
    const r = await waste(crew, {
      ...raw(lettuce, '10'),
      orgId: rivalOrg,
      org_id: rivalOrg,
      restaurantId: rivalId,
      recordedBy: mgr,
      recorded_by: mgr,
      costCents: 1,
      cost_cents: 1,
      status: 'approved',
    });
    if (r.status === 400) return; // strict rejection is equally acceptable
    expect(r.status).toBe(201);
    const row = await h.owner
      .selectFrom('waste_records')
      .select(['org_id', 'restaurant_id', 'recorded_by', 'cost_cents', 'status'])
      .where('id', '=', r.body.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      org_id: centralOrg,
      restaurant_id: centralId,
      recorded_by: me,
      cost_cents: 8,
      status: 'recorded',
    });
  });

  // ------------------------------------------------------- global invariants

  it('afterwards: no entry is double posted, nothing failed and the books still reconcile', async () => {
    await drain();
    const { rows: dupes } = await sql<{ source_event_id: string }>`
      select source_event_id from journal_entries where source_event_id is not null
       group by source_event_id having count(*) > 1`.execute(h.owner);
    expect(dupes).toEqual([]);
    // Scoped to Central: other test files deliberately dead-letter poison events in other tenants.
    const { rows: dead } = await sql<{ event_id: string }>`
      select f.event_id from event_consumer_failures f
        join outbox_events o on o.id = f.event_id
       where o.restaurant_id = ${centralId}::uuid`.execute(h.owner);
    expect(dead).toEqual([]);
    await assertReconciled();
    const day = await businessDate(centralId);
    const tb = await h.http
      .get(`/v1/restaurants/${centralId}/accounting/trial-balance?from=2020-01-01&to=${day}`)
      .set(bearer(manager))
      .expect(200);
    expect(tb.body.balanced).toBe(true);
  });
});
