import { randomUUID } from 'node:crypto';
import type { OrderView } from '@kitchos/contracts';
import { createDb, withTenant, type Database } from '@kitchos/database';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import {
  balance,
  bearer,
  getMenu,
  item,
  login,
  placeAndPay,
  restaurantId,
  setAvailable,
  startHarness,
  type Harness,
} from './harness.ts';

const CENTRAL = 'kitchos-central';
const DRIVE = 'kitchos-drive';
const EXPRESS = 'kitchos-express';
const RIVAL = 'rival-southbank';
const INVENTORY_EVENTS = [
  'order.accepted',
  'kitchen.task.started',
  'kitchen.task.completed',
  'inventory.waste_recorded',
  'inventory.waste_rejected',
  'inventory.goods_received',
  'inventory.counted',
  'inventory.opening_stock',
];
const INVENTORY_ENTRY_TYPES = [
  'cogs',
  'waste',
  'waste_reversal',
  'goods_receipt',
  'stock_count',
  'opening_stock',
];

describe('inventory valuation under adversarial conditions (ADR-0016)', () => {
  let h: Harness;
  let app: Database; // restricted runtime role (kitchos_app), RLS enforced
  let dispatcher: EventDispatcher;
  let centralId: string;
  let driveId: string;
  let expressId: string;
  let rivalId: string;
  let centralOrg: string;
  let rivalOrg: string;
  let crew: string;
  let supervisor: string;
  let manager: string;
  let driveManager: string;
  let expressManager: string;
  let rivalManager: string;
  let inventoryController: string;
  const itemIds = new Map<string, string>();
  const snapshots = new Map<string, Map<string, string>>();

  // ------------------------------------------------------------------ helpers

  const sku = (s: string) => {
    const id = itemIds.get(s);
    if (!id) throw new Error(`unknown sku ${s}`);
    return id;
  };

  /** on_hand per inventory item at the restaurant's default location. */
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
  const restoreOnHand = async (restId: string, snap: Map<string, string>) => {
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
      .set(bearer(inventoryController))
      .set('Idempotency-Key', randomUUID())
      .send({ notes: 'adversarial valuation test: restore', lines });
    if (res.status !== 201)
      throw new Error(`restore count failed: ${res.status} ${JSON.stringify(res.body)}`);
  };

  const businessDate = async (restId: string, at: string = 'now()') =>
    (
      await sql<{
        d: string;
      }>`select app.business_date(${restId}::uuid, ${sql.raw(at)})::text as d`.execute(h.owner)
    ).rows[0]!.d;

  const drain = async (...ds: EventDispatcher[]) => {
    for (let i = 0; i < 20; i++) {
      const stats = await Promise.all((ds.length ? ds : [dispatcher]).map((d) => d.runOnce()));
      if (stats.every((s) => s.processed === 0)) return;
    }
  };

  const tasksOf = (orderId: string) =>
    h.owner
      .selectFrom('kitchen_tasks as t')
      .innerJoin('order_lines as l', 'l.id', 't.order_line_id')
      .select(['t.id', 't.order_line_id', 't.status', 'l.consumption_point', 'l.name'])
      .where('t.order_id', '=', orderId)
      .orderBy('t.id')
      .execute();

  const linesOf = (orderId: string) =>
    h.owner
      .selectFrom('order_lines')
      .select(['id', 'kind', 'consumption_point', 'name'])
      .where('order_id', '=', orderId)
      .execute();

  const startTask = (restId: string, token: string, taskId: string, http = h.http) =>
    http
      .post(`/v1/restaurants/${restId}/kitchen/tasks/${taskId}/start`)
      .set(bearer(token))
      .send({});
  const completeTask = (restId: string, token: string, taskId: string, http = h.http) =>
    http
      .post(`/v1/restaurants/${restId}/kitchen/tasks/${taskId}/complete`)
      .set(bearer(token))
      .send({});

  /** Completes every open task of the order and hands it over. */
  const finish = async (restId: string, token: string, orderId: string) => {
    for (const t of await tasksOf(orderId)) {
      if (t.status !== 'done') {
        const r = await completeTask(restId, token, t.id);
        expect(r.status, `complete ${t.name}`).toBe(200);
      }
    }
    const handoff = await h.http
      .post(`/v1/restaurants/${restId}/orders/${orderId}/handoff`)
      .set(bearer(token));
    expect(handoff.status).toBe(200);
  };

  const waste = (token: string, body: object, restId = centralId, http = h.http) =>
    http
      .post(`/v1/restaurants/${restId}/inventory/waste`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send(body);

  const reject = (wasteId: string, reason = 'Mis-keyed by the recorder') =>
    h.http
      .post(`/v1/restaurants/${centralId}/inventory/waste/${wasteId}/reject`)
      .set(bearer(manager))
      .send({ reason });

  const entriesOf = (sourceId: string) =>
    h.owner
      .selectFrom('journal_entries')
      .select(['id', 'entry_type', 'source_type', 'source_event_id', 'business_date', 'org_id'])
      .where('source_id', '=', sourceId)
      .execute();

  /** Net debit (debit − credit) per system account for one journal entry. */
  const netOf = async (entryId: string) => {
    const lines = await h.owner
      .selectFrom('journal_lines as l')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['a.system_key', 'l.debit_cents', 'l.credit_cents'])
      .where('l.entry_id', '=', entryId)
      .execute();
    const out: Record<string, number> = {};
    for (const l of lines)
      out[l.system_key!] =
        (out[l.system_key!] ?? 0) + Number(l.debit_cents) - Number(l.credit_cents);
    return out;
  };

  const entry = async (sourceId: string, entryType: string) => {
    const e = (await entriesOf(sourceId)).filter((x) => x.entry_type === entryType);
    expect(e.length, `${entryType} entries for ${sourceId}`).toBeLessThanOrEqual(1);
    return e[0] ? { ...e[0], net: await netOf(e[0].id) } : null;
  };

  /** Σ recorded value of the movements of one source (negative = stock left). */
  const ledgerValue = async (sourceType: string, sourceId: string, sourceKey?: string) => {
    let q = h.owner
      .selectFrom('stock_movements')
      .select(sql<string>`coalesce(sum(value_cents), 0)`.as('v'))
      .where('source_type', '=', sourceType)
      .where('source_id', '=', sourceId);
    if (sourceKey !== undefined) q = q.where('source_key', '=', sourceKey);
    return Number((await q.executeTakeFirstOrThrow()).v);
  };

  const consumptionValue = (lineId: string) => ledgerValue('order_line', lineId, '').then((v) => v);

  /** −Σ value of the production consumption of all of an order's lines (remakes excluded). */
  const orderConsumption = async (orderId: string) => {
    const { rows } = await sql<{ v: string }>`
      select -coalesce(sum(m.value_cents), 0) as v from stock_movements m
        join order_lines l on l.id = m.source_id
       where l.order_id = ${orderId}::uuid and m.source_type = 'order_line'
         and m.source_key = '' and m.movement_type = 'production_consumption'`.execute(h.owner);
    return Number(rows[0]!.v);
  };

  /** COGS the journal booked for an order: its own cogs entry plus its lines' cogs entries. */
  const orderJournalCogs = async (orderId: string) => {
    const { rows } = await sql<{ v: string }>`
      select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) as v from journal_lines jl
        join journal_entries e on e.id = jl.entry_id
        join accounts a on a.id = jl.account_id
       where a.system_key = 'cogs' and e.entry_type = 'cogs'
         and (e.source_id = ${orderId}::uuid
              or e.source_id in (select id from order_lines where order_id = ${orderId}::uuid))`.execute(
      h.owner,
    );
    return Number(rows[0]!.v);
  };

  /**
   * Every consumed line's cost is in exactly one entry: the order's (lines consumed at
   * acceptance) or the line's own; and journal COGS for the order = −Σ consumption value.
   */
  const assertOrderCogs = async (orderId: string) => {
    const lines = (await linesOf(orderId)).filter((l) => l.kind !== 'combo');
    let acceptValue = 0;
    for (const l of lines) {
      const consumed = await consumptionValue(l.id);
      const own = (await entriesOf(l.id)).filter((e) => e.entry_type === 'cogs');
      if (l.consumption_point === 'order_accepted') {
        acceptValue += consumed;
        expect(own, `${l.name} has no line-level entry`).toHaveLength(0);
      } else if (consumed !== 0) {
        expect(own, `${l.name} posted once`).toHaveLength(1);
        expect(await netOf(own[0]!.id)).toEqual({ cogs: -consumed, inventory: consumed });
      } else {
        expect(own, `${l.name} not consumed, not posted`).toHaveLength(0);
      }
    }
    const orderEntries = (await entriesOf(orderId)).filter((e) => e.entry_type === 'cogs');
    if (acceptValue !== 0) {
      expect(orderEntries).toHaveLength(1);
      expect(await netOf(orderEntries[0]!.id)).toEqual({
        cogs: -acceptValue,
        inventory: acceptValue,
      });
    } else {
      expect(orderEntries).toHaveLength(0);
    }
    expect(await orderJournalCogs(orderId)).toBe(await orderConsumption(orderId));
  };

  const reconciliation = async (restId: string, token: string, day?: string) =>
    (
      await h.http
        .get(
          `/v1/restaurants/${restId}/accounting/reconciliation?businessDate=${day ?? (await businessDate(restId))}`,
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

  const ring = async (lines: { menuItemId: string; quantity: number }[]) =>
    (
      await h.http
        .post(`/v1/restaurants/${centralId}/orders`)
        .set(bearer(crew))
        .set('Idempotency-Key', randomUUID())
        .send({ fulfilmentType: 'dine_in', lines })
        .expect(201)
    ).body as OrderView;

  // -------------------------------------------------------------------- setup

  beforeAll(async () => {
    h = await startHarness();
    app = createDb({ connectionString: inject('appUrl'), max: 2 }).db;
    dispatcher = h.app.get(EventDispatcher);
    centralId = await restaurantId(h, CENTRAL);
    driveId = await restaurantId(h, DRIVE);
    expressId = await restaurantId(h, EXPRESS);
    rivalId = await restaurantId(h, RIVAL);
    const orgOf = async (id: string) =>
      (
        await h.owner
          .selectFrom('restaurants')
          .select('org_id')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).org_id;
    centralOrg = await orgOf(centralId);
    rivalOrg = await orgOf(rivalId);
    for (const r of await h.owner
      .selectFrom('inventory_items')
      .select(['id', 'sku'])
      .where('org_id', '=', centralOrg)
      .execute())
      itemIds.set(r.sku, r.id);
    crew = await login(h, 'crew1@central.kitchos.test');
    supervisor = await login(h, 'supervisor@central.kitchos.test');
    manager = await login(h, 'manager@central.kitchos.test');
    driveManager = await login(h, 'manager@drive.kitchos.test');
    expressManager = await login(h, 'manager@express.kitchos.test');
    rivalManager = await login(h, 'manager@rival.test');
    inventoryController = await login(h, 'inventory@kitchos.test');
    for (const id of [centralId, driveId, expressId]) snapshots.set(id, await onHandSnapshot(id));
    await drain();
  });

  afterAll(async () => {
    try {
      // Give back every unit this file moved so other files see the stock they expect.
      for (const [id, snap] of snapshots) await restoreOnHand(id, snap);
      await drain();
    } finally {
      await app?.destroy();
      await h?.close();
    }
  });

  // -------------------------------------------------------- consumption paths

  it('a combo posts each component exactly once: the drink with the order, burger and fries with their tasks', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Cheeseburger Meal').id, quantity: 1 },
    ]);
    await drain();
    // Only the drink is consumed so far; it is in the order's entry, nothing else posted.
    const lines = await linesOf(order.id);
    const drink = lines.find((l) => l.consumption_point === 'order_accepted')!;
    expect(drink.kind).toBe('component');
    expect(await consumptionValue(drink.id)).toBeLessThan(0);
    await assertOrderCogs(order.id);
    expect((await entriesOf(order.id)).map((e) => e.entry_type)).toEqual(['cogs']);

    // Bump every task straight from the queue: the burger (task_started) goes
    // started+completed in one transaction, fries (task_completed) at completion.
    for (const t of await tasksOf(order.id)) {
      expect((await completeTask(centralId, crew, t.id)).status).toBe(200);
    }
    await drain();
    await assertOrderCogs(order.id);
    const burger = lines.find((l) => l.consumption_point === 'task_started')!;
    const fries = lines.find((l) => l.consumption_point === 'task_completed')!;
    for (const l of [burger, fries]) {
      const e = await entriesOf(l.id);
      expect(e.map((x) => x.entry_type)).toEqual(['cogs']);
      // Posted from the event of the transaction that consumed it.
      const ev = await h.owner
        .selectFrom('outbox_events')
        .select('event_type')
        .where('id', '=', e[0]!.source_event_id!)
        .executeTakeFirstOrThrow();
      expect(ev.event_type).toBe(l === burger ? 'kitchen.task.started' : 'kitchen.task.completed');
    }
    await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/handoff`)
      .set(bearer(crew))
      .expect(200);
    await drain();
    // The sale is a different entry type and never collides with the order's COGS entry.
    expect((await entriesOf(order.id)).map((e) => e.entry_type).sort()).toEqual([
      'cogs',
      'sale_recognition',
    ]);
  });

  it('a 100% complimentary order accepted without payment still books its COGS', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await ring([{ menuItemId: item(menu, 'Cheeseburger Meal').id, quantity: 2 }]);
    const res = await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/discount`)
      .set(bearer(supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'percent', value: 10_000, reason: 'complimentary', note: 'valuation test' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalCents: 0, status: 'accepted' });
    await drain();
    expect(await orderConsumption(order.id)).toBeGreaterThan(0); // the drinks
    await assertOrderCogs(order.id);
    await finish(centralId, crew, order.id);
    await drain();
    await assertOrderCogs(order.id);
    const payments = await h.owner
      .selectFrom('payments')
      .select('id')
      .where('order_id', '=', order.id)
      .execute();
    expect(payments).toHaveLength(0);
  });

  it('cancelled after production: COGS stays booked once; waste of it is a reclassification, not new cost', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Cheeseburger').id, quantity: 1 },
    ]);
    const [task] = await tasksOf(order.id);
    expect((await startTask(centralId, crew, task!.id)).status).toBe(200);
    await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/cancel`)
      .set(bearer(manager))
      // Recorded by hand below: cancel without recording it.
      .send({
        reason: 'customer walked out',
        waste: [{ orderLineId: task!.order_line_id, quantity: 0 }],
      })
      .expect(200);
    await drain();
    const consumed = await consumptionValue(task!.order_line_id);
    expect(consumed).toBeLessThan(0);
    await assertOrderCogs(order.id);

    const w = await waste(crew, {
      kind: 'prepared_item',
      orderLineId: task!.order_line_id,
      quantity: 1,
      reason: 'cancelled_prepared_order',
    });
    expect(w.status).toBe(201);
    expect(
      w.body.lines.every((l: { treatment: string }) => l.treatment === 'already_consumed'),
    ).toBe(true);
    await drain();
    expect(await ledgerValue('waste_record', w.body.id)).toBe(0);
    expect((await entry(w.body.id, 'waste'))!.net).toEqual({
      waste_expense: w.body.costCents,
      cogs: -w.body.costCents,
    });
    // Still exactly one consumption entry for the line.
    expect((await entriesOf(task!.order_line_id)).map((e) => e.entry_type)).toEqual(['cogs']);
  });

  it('waste of a not-yet-consumed line is deducted now; its later consumption is posted separately, once', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Medium Fries').id, quantity: 1 },
    ]);
    const [task] = await tasksOf(order.id);
    const w = await waste(crew, {
      kind: 'prepared_item',
      orderLineId: task!.order_line_id,
      quantity: 1,
      reason: 'spilled',
      remake: true, // unconsumed: no remake movement, the line consumes normally later
    });
    expect(w.status).toBe(201);
    await drain();
    const deducted = await ledgerValue('waste_record', w.body.id);
    expect(deducted).toBeLessThan(0);
    expect(await ledgerValue('order_line', task!.order_line_id, `remake:${w.body.id}`)).toBe(0);
    expect((await entry(w.body.id, 'waste'))!.net).toEqual({
      waste_expense: -deducted,
      inventory: deducted,
    });
    expect(await entriesOf(task!.order_line_id)).toHaveLength(0);

    await finish(centralId, crew, order.id);
    await drain();
    await assertOrderCogs(order.id);
    expect(await consumptionValue(task!.order_line_id)).toBe(deducted); // same portion, same cost
  });

  it('standard cost changed between consumption and a remake: the waste at the old cost, the remake at the new', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Cheeseburger').id, quantity: 1 },
    ]);
    const [task] = await tasksOf(order.id);
    expect((await startTask(centralId, crew, task!.id)).status).toBe(200);
    const consumed = await consumptionValue(task!.order_line_id);
    const before = await h.owner
      .selectFrom('inventory_items')
      .select('standard_unit_cost')
      .where('id', '=', sku('PATTY-BEEF'))
      .executeTakeFirstOrThrow();
    let w: { id: string; costCents: number };
    try {
      await h.owner
        .updateTable('inventory_items')
        .set({ standard_unit_cost: '130' })
        .where('id', '=', sku('PATTY-BEEF'))
        .execute();
      const res = await waste(crew, {
        kind: 'prepared_item',
        orderLineId: task!.order_line_id,
        quantity: 1,
        reason: 'burnt',
        remake: true,
      });
      expect(res.status).toBe(201);
      w = res.body;
    } finally {
      await h.owner
        .updateTable('inventory_items')
        .set({ standard_unit_cost: before.standard_unit_cost })
        .where('id', '=', sku('PATTY-BEEF'))
        .execute();
    }
    await drain();
    const remake = await ledgerValue('order_line', task!.order_line_id, `remake:${w.id}`);
    // The wasted portion leaves COGS at the cost it was consumed at (110); the fresh portion is
    // made at today's cost (130), so the 20 difference is the remake's real cost, in COGS.
    expect(w.costCents).toBe(-consumed);
    expect(remake).toBe(-(w.costCents + 20));
    const e = (await entry(w.id, 'waste'))!;
    expect(e.net).toEqual({ waste_expense: w.costCents, cogs: 20, inventory: remake });
    // Consumption stays exactly once, at the value recorded when it happened.
    expect((await entry(task!.order_line_id, 'cogs'))!.net).toEqual({
      cogs: -consumed,
      inventory: consumed,
    });
    await finish(centralId, crew, order.id);
    await drain();
  });

  // Regression: correction movements that reverse a movement are valued at that movement's
  // unit cost (fixed in 0009 after review), so a rejection is an exact undo across cost changes.
  it('rejecting a waste record undoes exactly the value it removed, even if the standard cost changed', async () => {
    const w = await waste(crew, {
      kind: 'raw_ingredient',
      inventoryItemId: sku('TOMATO'),
      quantity: '100',
      reason: 'spoiled',
    });
    expect(w.status).toBe(201);
    const before = await h.owner
      .selectFrom('inventory_items')
      .select('standard_unit_cost')
      .where('id', '=', sku('TOMATO'))
      .executeTakeFirstOrThrow();
    try {
      await h.owner
        .updateTable('inventory_items')
        .set({ standard_unit_cost: '0.9' })
        .where('id', '=', sku('TOMATO'))
        .execute();
      expect((await reject(w.body.id)).status).toBe(200);
    } finally {
      await h.owner
        .updateTable('inventory_items')
        .set({ standard_unit_cost: before.standard_unit_cost })
        .where('id', '=', sku('TOMATO'))
        .execute();
    }
    await drain();
    const deducted = await ledgerValue('waste_record', w.body.id);
    const restored = await ledgerValue('waste_reversal', w.body.id);
    expect(deducted).toBe(-60);
    // Both entries are posted from the ledger values (this part holds)...
    expect((await entry(w.body.id, 'waste'))!.net.inventory).toBe(deducted);
    expect((await entry(w.body.id, 'waste_reversal'))!.net.inventory).toBe(restored);
    // ...but a rejection must be an exact undo: no net inventory value, no waste expense left.
    expect(restored).toBe(-deducted);
    const wasteExpense =
      ((await entry(w.body.id, 'waste'))!.net.waste_expense ?? 0) +
      ((await entry(w.body.id, 'waste_reversal'))!.net.waste_expense ?? 0);
    expect(wasteExpense).toBe(0);
  });

  // Regression: the reversal of a rejected waste record that moved no stock (food already consumed,
  // reclassification only) was dated by the dispatcher's clock at posting time, not by when the
  // rejection was decided. If the ledger consumer processes the event after the business day rolls
  // over (backlog, outage, retry), the COGS/Waste reclassification would land on the wrong day.
  // Every other posting (payments, sales, refunds, stock operations) uses its source's own
  // timestamp. Repro: reject an already_consumed waste record, let the dispatcher pick it up a day
  // later (simulated by moving reviewed_at/occurred_at back one day), the entry is dated today.
  it('a reclassification-only waste reversal is dated by the rejection, not by when the ledger processed it', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Cheeseburger').id, quantity: 1 },
    ]);
    const [task] = await tasksOf(order.id);
    expect((await startTask(centralId, crew, task!.id)).status).toBe(200);
    const w = await waste(crew, {
      kind: 'prepared_item',
      orderLineId: task!.order_line_id,
      quantity: 1,
      reason: 'dropped',
    });
    expect(w.status).toBe(201);
    await drain();
    expect((await reject(w.body.id, 'Recorded against the wrong line')).status).toBe(200);
    // The ledger consumer only gets to it after the business day has rolled over.
    await h.owner
      .updateTable('waste_records')
      .set({ reviewed_at: sql`reviewed_at - interval '1 day'` })
      .where('id', '=', w.body.id)
      .execute();
    await h.owner
      .updateTable('outbox_events')
      .set({ occurred_at: sql`occurred_at - interval '1 day'` })
      .where('aggregate_id', '=', w.body.id)
      .where('event_type', '=', 'inventory.waste_rejected')
      .execute();
    await drain();
    const { reviewed_at } = await h.owner
      .selectFrom('waste_records')
      .select('reviewed_at')
      .where('id', '=', w.body.id)
      .executeTakeFirstOrThrow();
    const decidedOn = await businessDate(centralId, `'${reviewed_at!.toISOString()}'::timestamptz`);
    const e = (await entry(w.body.id, 'waste_reversal'))!;
    expect(e.net).toEqual({ cogs: w.body.costCents, waste_expense: -w.body.costCents });
    expect(e.business_date).toBe(decidedOn);
    await finish(centralId, crew, order.id);
    await drain();
  });

  it('negative stock (allow_negative) is still consumed, valued and posted', async () => {
    const menu = await getMenu(h, EXPRESS);
    await setAvailable(h, EXPRESS, 'CROISSANT', 1);
    const order = await placeAndPay(h, EXPRESS, [
      { menuItemId: item(menu, 'Toasted Croissant').id, quantity: 3 },
    ]);
    const [task] = await tasksOf(order.id);
    expect((await startTask(expressId, expressManager, task!.id)).status).toBe(200);
    expect((await balance(h, EXPRESS, 'CROISSANT')).onHand).toBeLessThan(0);
    await drain();
    const croissant = await h.owner
      .selectFrom('stock_movements')
      .select(['value_cents', 'unit_cost', 'quantity_delta'])
      .where('source_id', '=', task!.order_line_id)
      .where('inventory_item_id', '=', sku('CROISSANT'))
      .executeTakeFirstOrThrow();
    expect(croissant).toMatchObject({ quantity_delta: '-3.000', value_cents: -360 });
    await assertOrderCogs(order.id);
    await finish(expressId, expressManager, order.id);
    await drain();
    const rec = await reconciliation(expressId, expressManager);
    expect(rec.stockMovementsValueCents).toBe(rec.journalInventoryCents);
  });

  it('zero-cost items (Rival has no standard costs) record value 0 and post nothing; Rival reconciles', async () => {
    const b = await balance(h, RIVAL, 'BUN');
    if (b.onHand - b.reserved < 5) await setAvailable(h, RIVAL, 'BUN', 20);
    const menu = await getMenu(h, RIVAL);
    const order = await placeAndPay(h, RIVAL, [
      { menuItemId: item(menu, 'Plain Burger').id, quantity: 2 },
    ]);
    const [task] = await tasksOf(order.id);
    expect((await startTask(rivalId, rivalManager, task!.id)).status).toBe(200);
    await drain();
    const m = await h.owner
      .selectFrom('stock_movements')
      .select(['value_cents', 'unit_cost', 'org_id'])
      .where('source_id', '=', task!.order_line_id)
      .executeTakeFirstOrThrow();
    expect(m).toMatchObject({ value_cents: 0, unit_cost: '0.000000', org_id: rivalOrg });
    expect(await entriesOf(task!.order_line_id)).toHaveLength(0);
    // The started event was still claimed (not left pending or failed).
    const ev = await h.owner
      .selectFrom('outbox_events as o')
      .innerJoin('inbox_events as i', (j) =>
        j.onRef('i.event_id', '=', 'o.id').on('i.consumer', '=', 'ledger'),
      )
      .select('o.id')
      .where('o.aggregate_id', '=', task!.id)
      .where('o.event_type', '=', 'kitchen.task.started')
      .execute();
    expect(ev).toHaveLength(1);
    await finish(rivalId, rivalManager, order.id);
    await drain();
    const rec = await reconciliation(rivalId, rivalManager);
    expect(rec.stockMovementsValueCents).toBe(rec.journalInventoryCents);
  });

  it('huge quantities are valued exactly (no float or int8 loss) and reconcile', async () => {
    const before = await balance(h, DRIVE, 'CHICKEN-FILLET');
    const receipt = await h.http
      .post(`/v1/restaurants/${driveId}/inventory/receipts`)
      .set(bearer(inventoryController))
      .set('Idempotency-Key', randomUUID())
      .send({ lines: [{ inventoryItemId: sku('CHICKEN-FILLET'), quantity: '999999999999.999' }] });
    expect(receipt.status).toBe(201);
    // 999999999999.999 × 150 c = 149 999 999 999 999.85 c -> 150 000 000 000 000 (half away from zero)
    expect(await ledgerValue('goods_receipt', receipt.body.id)).toBe(150_000_000_000_000);
    const count = await h.http
      .post(`/v1/restaurants/${driveId}/inventory/counts`)
      .set(bearer(inventoryController))
      .set('Idempotency-Key', randomUUID())
      .send({
        lines: [{ inventoryItemId: sku('CHICKEN-FILLET'), counted: before.onHand.toFixed(3) }],
      });
    expect(count.status).toBe(201);
    expect((await balance(h, DRIVE, 'CHICKEN-FILLET')).onHand).toBe(before.onHand);
    await drain();
    const counted = await ledgerValue('stock_count', count.body.id);
    expect(counted).toBe(count.body.varianceCents);
    expect(counted).toBe(-150_000_000_000_000);
    expect((await entry(receipt.body.id, 'goods_receipt'))!.net).toEqual({
      inventory: 150_000_000_000_000,
      goods_received_not_invoiced: -150_000_000_000_000,
    });
    expect((await entry(count.body.id, 'stock_count'))!.net).toEqual({
      inventory: counted,
      stock_variance: -counted,
    });
    const rec = await reconciliation(driveId, driveManager);
    expect(rec.stockMovementsValueCents).toBe(rec.journalInventoryCents);
  });

  // ------------------------------------------------------------- concurrency

  it('task starts, bumps, waste, counts and receipts racing two dispatchers: every operation posted exactly once', async () => {
    const menu = await getMenu(h, CENTRAL);
    const orders: OrderView[] = [];
    for (let i = 0; i < 4; i++) {
      orders.push(
        await placeAndPay(h, CENTRAL, [
          { menuItemId: item(menu, 'Cheeseburger').id, quantity: 1 },
          { menuItemId: item(menu, 'Medium Fries').id, quantity: 1 },
        ]),
      );
    }
    const tasks = (await Promise.all(orders.map((o) => tasksOf(o.id)))).flat();
    const onion = (await balance(h, CENTRAL, 'ONION')).onHand;
    const h2 = await startHarness();
    try {
      const d2 = h2.app.get(EventDispatcher);
      const pump = async () => {
        for (let i = 0; i < 4; i++) await Promise.all([dispatcher.runOnce(), d2.runOnce()]);
      };
      const ops = await Promise.all([
        pump(),
        ...tasks.map((t) => startTask(centralId, crew, t.id)),
        ...tasks.map((t) => startTask(centralId, crew, t.id, h2.http)),
        ...tasks.map((t) => completeTask(centralId, crew, t.id, h2.http)),
        waste(crew, {
          kind: 'raw_ingredient',
          inventoryItemId: sku('LETTUCE'),
          quantity: '20',
          reason: 'spoiled',
        }),
        waste(
          crew,
          {
            kind: 'raw_ingredient',
            inventoryItemId: sku('LETTUCE'),
            quantity: '30',
            reason: 'spoiled',
          },
          centralId,
          h2.http,
        ),
        waste(crew, {
          kind: 'raw_ingredient',
          inventoryItemId: sku('ONION'),
          quantity: '15',
          reason: 'spoiled',
        }),
        h.http
          .post(`/v1/restaurants/${centralId}/inventory/counts`)
          .set(bearer(inventoryController))
          .set('Idempotency-Key', randomUUID())
          .send({ lines: [{ inventoryItemId: sku('ONION'), counted: String(onion - 7) }] }),
        h2.http
          .post(`/v1/restaurants/${centralId}/inventory/counts`)
          .set(bearer(inventoryController))
          .set('Idempotency-Key', randomUUID())
          .send({ lines: [{ inventoryItemId: sku('ONION'), counted: String(onion - 3) }] }),
        h2.http
          .post(`/v1/restaurants/${centralId}/inventory/receipts`)
          .set(bearer(inventoryController))
          .set('Idempotency-Key', randomUUID())
          .send({ lines: [{ inventoryItemId: sku('ONION'), quantity: '11' }] }),
        pump(),
      ]);
      const responses = ops.filter((r): r is Exclude<typeof r, void> => r !== undefined);
      for (const r of responses)
        expect([200, 201, 409], JSON.stringify(r.body)).toContain(r.status);
      const ids = responses.filter((r) => r.status === 201).map((r) => r.body.id as string);
      expect(ids).toHaveLength(6); // 3 waste records, 2 counts, 1 receipt
      for (const t of await Promise.all(orders.map((o) => tasksOf(o.id))))
        for (const x of t)
          if (x.status !== 'done') await completeTask(centralId, crew, x.id).expect(200);
      await drain(dispatcher, d2);

      for (const o of orders) await assertOrderCogs(o.id);
      for (const id of ids) {
        const e = await entriesOf(id);
        const type = e[0]?.entry_type;
        const sourceType =
          type === 'waste'
            ? 'waste_record'
            : type === 'stock_count'
              ? 'stock_count'
              : 'goods_receipt';
        const v = await ledgerValue(sourceType, id);
        if (v === 0) {
          expect(e).toHaveLength(0);
          continue;
        }
        expect(e, `one entry for ${id}`).toHaveLength(1);
        expect((await netOf(e[0]!.id)).inventory).toBe(v);
      }
      // Every inventory event of these operations was claimed once and none failed.
      const aggregates = [...ids, ...orders.map((o) => o.id), ...tasks.map((t) => t.id)];
      const events = await h.owner
        .selectFrom('outbox_events as o')
        .leftJoin('inbox_events as i', (j) =>
          j.onRef('i.event_id', '=', 'o.id').on('i.consumer', '=', 'ledger'),
        )
        .leftJoin('event_consumer_failures as f', (j) =>
          j.onRef('f.event_id', '=', 'o.id').on('f.consumer', '=', 'ledger'),
        )
        .select(['o.id', 'o.event_type', 'i.event_id as claimed', 'f.event_id as failed'])
        .where('o.aggregate_id', 'in', aggregates)
        .where('o.event_type', 'in', INVENTORY_EVENTS)
        .execute();
      expect(events.length).toBeGreaterThanOrEqual(6 + orders.length + tasks.length * 2);
      expect(events.filter((e) => !e.claimed || e.failed)).toEqual([]);
    } finally {
      await h2.close();
    }
    for (const o of orders)
      await h.http
        .post(`/v1/restaurants/${centralId}/orders/${o.id}/handoff`)
        .set(bearer(crew))
        .expect(200);
    await drain();
  });

  it('redelivery of every inventory event (inbox wiped, two workers) posts nothing new', async () => {
    await drain();
    const count = async () =>
      Number(
        (await sql<{ n: string }>`select count(*) as n from journal_lines`.execute(h.owner))
          .rows[0]!.n,
      );
    const entries = async () =>
      Number(
        (await sql<{ n: string }>`select count(*) as n from journal_entries`.execute(h.owner))
          .rows[0]!.n,
      );
    const [lines0, entries0] = [await count(), await entries()];
    const deleted = await h.owner
      .deleteFrom('inbox_events')
      .where('consumer', '=', 'ledger')
      .where('event_id', 'in', (eb) =>
        eb.selectFrom('outbox_events').select('id').where('event_type', 'in', INVENTORY_EVENTS),
      )
      .executeTakeFirst();
    expect(Number(deleted.numDeletedRows)).toBeGreaterThan(20);
    // While they are pending again, reconciliation must not claim success.
    expect((await reconciliation(centralId, manager)).reconciled).toBe(false);
    const h2 = await startHarness();
    try {
      const d2 = h2.app.get(EventDispatcher);
      const [a, b] = await Promise.all([dispatcher.runOnce(), d2.runOnce()]);
      expect(a.failed + b.failed).toBe(0);
      await drain(dispatcher, d2);
    } finally {
      await h2.close();
    }
    expect(await entries()).toBe(entries0);
    expect(await count()).toBe(lines0);
    expect(await reconciliation(centralId, manager)).toMatchObject({
      reconciled: true,
      pendingEvents: 0,
    });
  });

  it('reconciliation is false while an inventory event is pending and true once it is posted', async () => {
    await drain();
    expect((await reconciliation(centralId, manager)).reconciled).toBe(true);
    const w = await waste(crew, {
      kind: 'raw_ingredient',
      inventoryItemId: sku('LETTUCE'),
      quantity: '10',
      reason: 'expired',
    });
    expect(w.status).toBe(201);
    const pending = await reconciliation(centralId, manager);
    expect(pending.pendingEvents).toBeGreaterThanOrEqual(1);
    expect(pending.reconciled).toBe(false);
    expect(pending.stockMovementsValueCents - pending.journalInventoryCents).toBe(-8);
    await drain();
    const done = await reconciliation(centralId, manager);
    expect(done).toMatchObject({ reconciled: true, pendingEvents: 0 });
    expect(done.stockMovementsValueCents).toBe(done.journalInventoryCents);
  });

  // -------------------------------------------------- database-level controls

  it('the runtime role cannot supply, alter or switch off movement values', async () => {
    const loc = await h.owner
      .selectFrom('stock_locations')
      .select('id')
      .where('restaurant_id', '=', centralId)
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    const movement = (delta: string, sourceId: string, key = '') => ({
      org_id: centralOrg,
      restaurant_id: centralId,
      location_id: loc.id,
      inventory_item_id: sku('BUN-REG'),
      movement_type: 'count_adjustment',
      quantity_delta: delta,
      source_type: 'value_tamper_test',
      source_id: sourceId,
      source_key: key,
      occurred_at: sql<Date>`now()`,
      business_date: sql<string>`app.business_date(${centralId}::uuid, now())`,
    });
    const sourceId = randomUUID();
    // Supplying the value is ignored: the trigger computes it.
    const rows = await withTenant(app, { orgId: centralOrg }, async (tx) => [
      await tx
        .insertInto('stock_movements')
        .values({ ...movement('1', sourceId), unit_cost: '0', value_cents: 999_999 })
        .returning(['id', 'unit_cost', 'value_cents'])
        .executeTakeFirstOrThrow(),
      // ...and undone the append-only way in the same transaction (net zero value and quantity).
      await tx
        .insertInto('stock_movements')
        .values({ ...movement('-1', sourceId, 'undo'), value_cents: -1 })
        .returning(['id', 'unit_cost', 'value_cents'])
        .executeTakeFirstOrThrow(),
    ]);
    expect(rows.map((r) => [r.unit_cost, r.value_cents])).toEqual([
      ['45.000000', 45],
      ['45.000000', -45],
    ]);

    const attempt = (
      q: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<unknown>,
    ) => withTenant(app, { orgId: centralOrg }, q);
    await expect(
      attempt((tx) =>
        tx
          .updateTable('stock_movements')
          .set({ value_cents: 0 })
          .where('id', '=', rows[0]!.id)
          .execute(),
      ),
    ).rejects.toThrow(/permission denied|append-only|not allowed/i);
    await expect(
      attempt((tx) => sql`set local session_replication_role = replica`.execute(tx)),
    ).rejects.toThrow(/permission denied|must be superuser/i);
    await expect(
      attempt((tx) =>
        sql`alter table stock_movements disable trigger stock_movements_value`.execute(tx),
      ),
    ).rejects.toThrow(/must be owner|permission denied/i);
    // Owner cannot rewrite history either.
    await expect(
      h.owner
        .updateTable('stock_movements')
        .set({ value_cents: 0 })
        .where('id', '=', rows[0]!.id)
        .execute(),
    ).rejects.toThrow();
  });

  // Regression: the valuation trigger must not resolve inventory_items through a TEMP table the
  // runtime role creates (pg_temp is searched first unless search_path is pinned; pinned in 0009).
  it('the valuation trigger cannot be redirected to a forged cost table (search_path hijack)', async () => {
    const loc = await h.owner
      .selectFrom('stock_locations')
      .select('id')
      .where('restaurant_id', '=', centralId)
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    const sourceId = randomUUID();
    const values = await withTenant(app, { orgId: centralOrg }, async (tx) => {
      await sql`create temp table inventory_items (id uuid, standard_unit_cost numeric) on commit drop`.execute(
        tx,
      );
      await sql`insert into inventory_items values (${sku('BUN-REG')}::uuid, 0)`.execute(tx);
      const out: (number | null)[] = [];
      for (const [delta, key] of [
        ['1', ''],
        ['-1', 'undo'], // net zero quantity and (whatever happens) net zero value
      ] as const) {
        const { rows } = await sql<{ value_cents: number | null }>`
          insert into public.stock_movements (org_id, restaurant_id, location_id, inventory_item_id,
            movement_type, quantity_delta, source_type, source_id, source_key, occurred_at, business_date)
          values (${centralOrg}::uuid, ${centralId}::uuid, ${loc.id}::uuid, ${sku('BUN-REG')}::uuid,
            'count_adjustment', ${delta}::numeric, 'value_tamper_test', ${sourceId}::uuid, ${key},
            now(), app.business_date(${centralId}::uuid, now()))
          returning value_cents`.execute(tx);
        out.push(rows[0]!.value_cents);
      }
      return out;
    });
    expect(values).toEqual([45, -45]);
  });

  // ------------------------------------------------------------------ tenancy

  it('cross-tenant: Rival cannot touch Central stock operations and no entry crosses orgs', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Medium Cola').id, quantity: 1 },
    ]);
    const [line] = (await linesOf(order.id)).filter((l) => l.kind === 'item');
    // Central's order line through Rival's own restaurant: invisible under RLS.
    const viaRival = await waste(
      rivalManager,
      { kind: 'prepared_item', orderLineId: line!.id, quantity: 1, reason: 'dropped' },
      rivalId,
    );
    expect(viaRival.status).toBe(404);
    // Central's item on a Rival receipt: invisible.
    const receipt = await h.http
      .post(`/v1/restaurants/${rivalId}/inventory/receipts`)
      .set(bearer(rivalManager))
      .set('Idempotency-Key', randomUUID())
      .send({ lines: [{ inventoryItemId: sku('BUN-REG'), quantity: '1' }] });
    expect(receipt.status).toBe(404);
    // Central's restaurant directly.
    const direct = await waste(
      rivalManager,
      { kind: 'raw_ingredient', inventoryItemId: sku('BUN-REG'), quantity: '1', reason: 'spoiled' },
      centralId,
    );
    expect([403, 404]).toContain(direct.status);
    await drain();
    await assertOrderCogs(order.id);
    await finish(centralId, crew, order.id);
    await drain();

    const q = async (query: ReturnType<typeof sql<{ n: string }>>) =>
      Number((await query.execute(h.owner)).rows[0]!.n);
    // Inventory entries carry the org and restaurant of their source event and movements.
    expect(
      await q(sql`select count(*) as n from journal_entries e join outbox_events o on o.id = e.source_event_id
                  where e.entry_type in ('cogs','waste','waste_reversal','goods_receipt','stock_count','opening_stock')
                    and (o.org_id <> e.org_id or o.restaurant_id <> e.restaurant_id)`),
    ).toBe(0);
    expect(
      await q(sql`select count(*) as n from journal_entries e join stock_movements m on m.source_id = e.source_id
                  where e.entry_type in ('goods_receipt','stock_count','opening_stock','waste')
                    and (m.org_id <> e.org_id or m.restaurant_id <> e.restaurant_id)`),
    ).toBe(0);
    expect(
      await q(sql`select count(*) as n from journal_lines l join accounts a on a.id = l.account_id
                  join journal_entries e on e.id = l.entry_id
                  where (e.org_id = ${rivalOrg}::uuid) <> (a.org_id = ${rivalOrg}::uuid)`),
    ).toBe(0);
  });

  // --------------------------------------------------------- global invariants

  it('globally: one entry per source event; Inventory = Σ valued movements per restaurant and day; TB balanced', async () => {
    await drain();
    const { rows: dupes } = await sql<{ source_event_id: string; n: string }>`
      select source_event_id, count(*)::text as n from journal_entries
       where source_event_id is not null group by source_event_id having count(*) > 1`.execute(
      h.owner,
    );
    expect(dupes).toEqual([]);
    const { rows: orphans } = await sql<{ id: string }>`
      select id from journal_entries
       where entry_type in ('cogs','waste','waste_reversal','goods_receipt','stock_count','opening_stock')
         and source_event_id is null`.execute(h.owner);
    expect(orphans).toEqual([]);
    // Every inventory entry was posted by an event of the matching kind.
    const { rows: mismatched } = await sql<{ id: string; entry_type: string; event_type: string }>`
      select e.id, e.entry_type, o.event_type from journal_entries e join outbox_events o on o.id = e.source_event_id
       where e.entry_type = any(${sql.val(INVENTORY_ENTRY_TYPES)}::text[])
         and not (
           (e.entry_type = 'cogs' and o.event_type in ('order.accepted','kitchen.task.started','kitchen.task.completed'))
        or (e.entry_type = 'waste' and o.event_type = 'inventory.waste_recorded')
        or (e.entry_type = 'waste_reversal' and o.event_type = 'inventory.waste_rejected')
        or (e.entry_type = 'goods_receipt' and o.event_type = 'inventory.goods_received')
        or (e.entry_type = 'stock_count' and o.event_type = 'inventory.counted')
        or (e.entry_type = 'opening_stock' and o.event_type = 'inventory.opening_stock'))`.execute(
      h.owner,
    );
    expect(mismatched).toEqual([]);

    const { rows: drift } = await sql<{ r: string; d: string; sv: string; jv: string }>`
      with s as (
        select restaurant_id, business_date d, sum(value_cents) v from stock_movements
         where value_cents is not null group by 1, 2),
      j as (
        select e.restaurant_id, e.business_date d, sum(l.debit_cents - l.credit_cents) v
          from journal_lines l join journal_entries e on e.id = l.entry_id
          join accounts a on a.id = l.account_id
         where a.system_key = 'inventory' and e.posted_late_from is null group by 1, 2)
      select coalesce(s.restaurant_id, j.restaurant_id)::text r, coalesce(s.d, j.d)::text d,
             coalesce(s.v, 0)::text sv, coalesce(j.v, 0)::text jv
        from s full join j on s.restaurant_id = j.restaurant_id and s.d = j.d
       where coalesce(s.v, 0) <> coalesce(j.v, 0)
         and not exists (select 1 from business_day_closes c
                          where c.restaurant_id = coalesce(s.restaurant_id, j.restaurant_id)
                            and c.business_date = coalesce(s.d, j.d))`.execute(h.owner);
    expect(drift).toEqual([]);

    for (const [restId, token] of [
      [centralId, manager],
      [driveId, driveManager],
      [expressId, expressManager],
      [rivalId, rivalManager],
    ] as const) {
      const day = await businessDate(restId);
      const tb = await h.http
        .get(`/v1/restaurants/${restId}/accounting/trial-balance?from=2020-01-01&to=${day}`)
        .set(bearer(token))
        .expect(200);
      expect(tb.body.balanced, restId).toBe(true);
      const rec = await reconciliation(restId, token, day);
      expect(rec.stockMovementsValueCents, restId).toBe(rec.journalInventoryCents);
    }
    for (const [restId, token] of [
      [centralId, manager],
      [driveId, driveManager],
    ] as const) {
      expect(await reconciliation(restId, token)).toMatchObject({
        reconciled: true,
        pendingEvents: 0,
        deadLetteredEvents: 0,
      });
    }
  });
});
