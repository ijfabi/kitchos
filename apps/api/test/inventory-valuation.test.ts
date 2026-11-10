import { randomUUID } from 'node:crypto';
import type { KitchenTaskView, OrderView } from '@kitchos/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import {
  bearer,
  getMenu,
  item,
  login,
  placeAndPay,
  restaurantId,
  startHarness,
  type Harness,
} from './harness.ts';

const CENTRAL = 'kitchos-central';

describe('inventory valuation in the journal (ADR-0016)', () => {
  let h: Harness;
  let centralId: string;
  let crew: string;
  let manager: string;
  let inventoryController: string;
  let dispatcher: EventDispatcher;
  const itemIds = new Map<string, string>();

  beforeAll(async () => {
    h = await startHarness();
    centralId = await restaurantId(h, CENTRAL);
    crew = await login(h, 'crew1@central.kitchos.test');
    manager = await login(h, 'manager@central.kitchos.test');
    inventoryController = await login(h, 'inventory@kitchos.test');
    dispatcher = h.app.get(EventDispatcher);
    const org = await h.owner
      .selectFrom('restaurants')
      .select('org_id')
      .where('id', '=', centralId)
      .executeTakeFirstOrThrow();
    for (const r of await h.owner
      .selectFrom('inventory_items')
      .select(['id', 'sku'])
      .where('org_id', '=', org.org_id)
      .execute())
      itemIds.set(r.sku, r.id);
    await dispatcher.runOnce();
  });
  afterAll(() => h.close());

  const sku = (s: string) => itemIds.get(s)!;
  /** Net debit per system account of the entry for (source, type), or null when not posted. */
  const entry = async (sourceId: string, entryType: string) => {
    const e = await h.owner
      .selectFrom('journal_entries')
      .select('id')
      .where('source_id', '=', sourceId)
      .where('entry_type', '=', entryType)
      .executeTakeFirst();
    if (!e) return null;
    const lines = await h.owner
      .selectFrom('journal_lines as l')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['a.system_key', 'l.debit_cents', 'l.credit_cents'])
      .where('l.entry_id', '=', e.id)
      .execute();
    return Object.fromEntries(lines.map((l) => [l.system_key!, l.debit_cents - l.credit_cents]));
  };
  /** Σ recorded value of stock movements for a source (negative = stock left). */
  const ledgerValue = async (sourceType: string, sourceId: string, sourceKey?: string) => {
    let q = h.owner
      .selectFrom('stock_movements')
      .select(sql<string>`coalesce(sum(value_cents), 0)`.as('v'))
      .where('source_type', '=', sourceType)
      .where('source_id', '=', sourceId);
    if (sourceKey !== undefined) q = q.where('source_key', '=', sourceKey);
    return Number((await q.executeTakeFirstOrThrow()).v);
  };
  const waste = (token: string, body: object) =>
    h.http
      .post(`/v1/restaurants/${centralId}/inventory/waste`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const taskFor = async (order: OrderView) => {
    const tasks = (await h.http.get(`/v1/restaurants/${centralId}/kitchen/tasks`).set(bearer(crew)))
      .body as KitchenTaskView[];
    return tasks.find((t) => t.orderId === order.id)!;
  };
  const lineOf = async (orderId: string) =>
    await h.owner
      .selectFrom('order_lines')
      .select(['id', 'consumption_point'])
      .where('order_id', '=', orderId)
      .where('kind', '=', 'item')
      .executeTakeFirstOrThrow();

  it('seeded opening stock is in the journal at its recorded value', async () => {
    const opening = await h.owner
      .selectFrom('stock_movements')
      .select(['source_id', sql<string>`sum(value_cents)`.as('v')])
      .where('restaurant_id', '=', centralId)
      .where('source_type', '=', 'opening_stock')
      .groupBy('source_id')
      .executeTakeFirstOrThrow();
    expect(Number(opening.v)).toBeGreaterThan(0);
    expect(await entry(opening.source_id, 'opening_stock')).toEqual({
      inventory: Number(opening.v),
      opening_balance_equity: -Number(opening.v),
    });
  });

  it('consumption posts COGS exactly once, in the event of the transaction that consumed it', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Cheeseburger').id, quantity: 2 },
    ]);
    const line = await lineOf(order.id);
    expect(line.consumption_point).toBe('task_started');
    await dispatcher.runOnce();
    expect(await entry(line.id, 'cogs')).toBeNull(); // nothing consumed yet

    await h.http
      .post(`/v1/restaurants/${centralId}/kitchen/tasks/${(await taskFor(order)).id}/start`)
      .set(bearer(crew))
      .send({})
      .expect(200);
    await dispatcher.runOnce();
    const consumed = await ledgerValue('order_line', line.id, '');
    expect(consumed).toBeLessThan(0);
    expect(await entry(line.id, 'cogs')).toEqual({ cogs: -consumed, inventory: consumed });

    // Completing the task (a later event for the same line) posts nothing more.
    await h.http
      .post(`/v1/restaurants/${centralId}/kitchen/tasks/${(await taskFor(order)).id}/complete`)
      .set(bearer(crew))
      .send({})
      .expect(200);
    await dispatcher.runOnce();
    const all = await h.owner
      .selectFrom('journal_entries')
      .select('id')
      .where('source_id', '=', line.id)
      .execute();
    expect(all).toHaveLength(1);
  });

  it('a late-processed order.accepted never double-counts lines consumed by kitchen tasks', async () => {
    const menu = await getMenu(h, CENTRAL);
    // A meal: the drink is consumed at acceptance, the burger and fries by their tasks.
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Cheeseburger Meal').id, quantity: 1 },
    ]);
    const tasks = (await h.http.get(`/v1/restaurants/${centralId}/kitchen/tasks`).set(bearer(crew)))
      .body as KitchenTaskView[];
    for (const t of tasks.filter((x) => x.orderId === order.id)) {
      await h.http
        .post(`/v1/restaurants/${centralId}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(crew))
        .send({})
        .expect(200);
    }
    // Only now does the ledger see any of this order's events.
    await dispatcher.runOnce();
    const { rows } = await sql<{ ledger: string; journal: string }>`
      select
        (select -coalesce(sum(m.value_cents), 0) from stock_movements m
           join order_lines l on l.id = m.source_id
          where l.order_id = ${order.id}::uuid and m.movement_type = 'production_consumption') as ledger,
        (select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) from journal_lines jl
           join journal_entries e on e.id = jl.entry_id
           join accounts a on a.id = jl.account_id
          where a.system_key = 'cogs' and e.entry_type = 'cogs'
            and (e.source_id = ${order.id}::uuid
                 or e.source_id in (select id from order_lines where order_id = ${order.id}::uuid))) as journal`.execute(
      h.owner,
    );
    expect(Number(rows[0]!.ledger)).toBeGreaterThan(0);
    expect(Number(rows[0]!.journal)).toBe(Number(rows[0]!.ledger));
  });

  it('the value is fixed when the stock moved: a later standard-cost change does not revalue it', async () => {
    const before = await h.owner
      .selectFrom('inventory_items')
      .select('standard_unit_cost')
      .where('id', '=', sku('LETTUCE'))
      .executeTakeFirstOrThrow();
    const res = await waste(crew, {
      kind: 'raw_ingredient',
      inventoryItemId: sku('LETTUCE'),
      quantity: '250',
      reason: 'spoiled',
    }).expect(201);
    const recorded = await ledgerValue('waste_record', res.body.id);
    expect(recorded).toBe(-res.body.costCents); // ledger value = the waste record's standard cost
    try {
      await h.owner
        .updateTable('inventory_items')
        .set({ standard_unit_cost: '999' })
        .where('id', '=', sku('LETTUCE'))
        .execute();
      await dispatcher.runOnce();
      expect(await entry(res.body.id, 'waste')).toEqual({
        inventory: recorded,
        waste_expense: -recorded,
      });
    } finally {
      await h.owner
        .updateTable('inventory_items')
        .set({ standard_unit_cost: before.standard_unit_cost })
        .where('id', '=', sku('LETTUCE'))
        .execute();
    }
  });

  it('waste of consumed food is reclassified from COGS; a remake is new COGS; rejection reverses all but the remake', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Cheeseburger').id, quantity: 1 },
    ]);
    await h.http
      .post(`/v1/restaurants/${centralId}/kitchen/tasks/${(await taskFor(order)).id}/start`)
      .set(bearer(crew))
      .send({})
      .expect(200);
    const line = await lineOf(order.id);
    const res = await waste(crew, {
      kind: 'prepared_item',
      orderLineId: line.id,
      quantity: 1,
      reason: 'dropped',
      remake: true,
    }).expect(201);
    await dispatcher.runOnce();
    const remake = await ledgerValue('order_line', line.id, `remake:${res.body.id}`);
    expect(remake).toBeLessThan(0);
    expect(await ledgerValue('waste_record', res.body.id)).toBe(0); // no second deduction
    // Reclassified out of COGS (+cost) and remake into COGS (−remake) are netted per
    // account; when they cancel (same portion), COGS does not appear at all.
    const cogs = -res.body.costCents - remake;
    expect(await entry(res.body.id, 'waste')).toEqual({
      waste_expense: res.body.costCents,
      inventory: remake,
      ...(cogs !== 0 ? { cogs } : {}),
    });

    await h.http
      .post(`/v1/restaurants/${centralId}/inventory/waste/${res.body.id}/reject`)
      .set(bearer(manager))
      .send({ reason: 'Recorded against the wrong order' })
      .expect(200);
    await dispatcher.runOnce();
    expect(await entry(res.body.id, 'waste_reversal')).toEqual({
      cogs: res.body.costCents,
      waste_expense: -res.body.costCents,
    });
  });

  it('rejected raw waste puts the value back in inventory', async () => {
    const res = await waste(crew, {
      kind: 'raw_ingredient',
      inventoryItemId: sku('BUN-REG'),
      quantity: '4',
      reason: 'other',
    }).expect(201);
    await h.http
      .post(`/v1/restaurants/${centralId}/inventory/waste/${res.body.id}/reject`)
      .set(bearer(manager))
      .send({ reason: 'Entered by mistake' })
      .expect(200);
    await dispatcher.runOnce();
    const deducted = await ledgerValue('waste_record', res.body.id);
    const restored = await ledgerValue('waste_reversal', res.body.id);
    expect(restored).toBe(-deducted);
    expect(await entry(res.body.id, 'waste')).toEqual({
      inventory: deducted,
      waste_expense: -deducted,
    });
    expect(await entry(res.body.id, 'waste_reversal')).toEqual({
      inventory: restored,
      waste_expense: -restored,
    });
  });

  it('receipts accrue goods received not invoiced; count shrinkage is a variance expense', async () => {
    const receipt = await h.http
      .post(`/v1/restaurants/${centralId}/inventory/receipts`)
      .set(bearer(manager))
      .set('Idempotency-Key', randomUUID())
      .send({ lines: [{ inventoryItemId: sku('BUN-REG'), quantity: '48' }] })
      .expect(201);
    const counted = await h.owner
      .selectFrom('stock_balances as b')
      .innerJoin('stock_locations as l', 'l.id', 'b.location_id')
      .select('b.on_hand')
      .where('l.restaurant_id', '=', centralId)
      .where('b.inventory_item_id', '=', sku('BUN-REG'))
      .executeTakeFirstOrThrow();
    const count = await h.http
      .post(`/v1/restaurants/${centralId}/inventory/counts`)
      .set(bearer(inventoryController))
      .set('Idempotency-Key', randomUUID())
      .send({
        lines: [{ inventoryItemId: sku('BUN-REG'), counted: String(Number(counted.on_hand) - 2) }],
      })
      .expect(201);
    await dispatcher.runOnce();
    const received = await ledgerValue('goods_receipt', receipt.body.id);
    expect(received).toBeGreaterThan(0);
    expect(await entry(receipt.body.id, 'goods_receipt')).toEqual({
      inventory: received,
      goods_received_not_invoiced: -received,
    });
    const shrink = await ledgerValue('stock_count', count.body.id);
    expect(shrink).toBe(count.body.lines[0].varianceCents);
    expect(await entry(count.body.id, 'stock_count')).toEqual({
      inventory: shrink,
      stock_variance: -shrink,
    });
  });

  it('rejecting waste after a standard-cost change reverses it at the original value', async () => {
    // Regression (review): corrections used today's cost, leaving residue in Waste expense.
    const res = await waste(crew, {
      kind: 'raw_ingredient',
      inventoryItemId: sku('BUN-REG'),
      quantity: '3',
      reason: 'other',
    }).expect(201);
    const before = await h.owner
      .selectFrom('inventory_items')
      .select('standard_unit_cost')
      .where('id', '=', sku('BUN-REG'))
      .executeTakeFirstOrThrow();
    try {
      await h.owner
        .updateTable('inventory_items')
        .set({ standard_unit_cost: '777' })
        .where('id', '=', sku('BUN-REG'))
        .execute();
      await h.http
        .post(`/v1/restaurants/${centralId}/inventory/waste/${res.body.id}/reject`)
        .set(bearer(manager))
        .send({ reason: 'Mis-keyed' })
        .expect(200);
    } finally {
      await h.owner
        .updateTable('inventory_items')
        .set({ standard_unit_cost: before.standard_unit_cost })
        .where('id', '=', sku('BUN-REG'))
        .execute();
    }
    await dispatcher.runOnce();
    const wasted = await entry(res.body.id, 'waste');
    const reversed = await entry(res.body.id, 'waste_reversal');
    expect(reversed).toEqual({
      inventory: -wasted!.inventory!,
      waste_expense: -wasted!.waste_expense!,
    });
  });

  it('waste of a line consumed before valuation existed stays out of the journal', async () => {
    // Regression (review): the reclassification would credit COGS that was never debited.
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Cheeseburger').id, quantity: 1 },
    ]);
    const line = await lineOf(order.id);
    const loc = await h.owner
      .selectFrom('stock_locations')
      .select(['id', 'org_id'])
      .where('restaurant_id', '=', centralId)
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    const snapshot = await h.owner
      .selectFrom('order_line_ingredients')
      .select(['inventory_item_id', 'quantity'])
      .where('order_line_id', '=', line.id)
      .execute();
    // Simulate consumption recorded before migration 0009: movements with no value.
    await h.owner.transaction().execute(async (trx) => {
      await sql`alter table stock_movements disable trigger stock_movements_value`.execute(trx);
      await trx
        .insertInto('stock_movements')
        .values(
          snapshot.map((s) => ({
            org_id: loc.org_id,
            restaurant_id: centralId,
            location_id: loc.id,
            inventory_item_id: s.inventory_item_id,
            movement_type: 'production_consumption',
            quantity_delta: `-${s.quantity}`,
            source_type: 'order_line',
            source_id: line.id,
            occurred_at: sql<Date>`now()`,
            business_date: sql<string>`app.business_date(${centralId}::uuid, now())`,
          })),
        )
        .execute();
      await sql`alter table stock_movements enable trigger stock_movements_value`.execute(trx);
    });
    const res = await waste(crew, {
      kind: 'prepared_item',
      orderLineId: line.id,
      quantity: 1,
      reason: 'dropped',
    }).expect(201);
    expect(
      res.body.lines.every((l: { treatment: string }) => l.treatment === 'already_consumed'),
    ).toBe(true);
    await dispatcher.runOnce();
    expect(await entry(res.body.id, 'waste')).toBeNull();
    // Processed, not failed. Scoped to this record: other test files deliberately
    // dead-letter poison events in other tenants.
    const handled = await h.owner
      .selectFrom('outbox_events as o')
      .leftJoin('inbox_events as i', (j) =>
        j.onRef('i.event_id', '=', 'o.id').on('i.consumer', '=', 'ledger'),
      )
      .leftJoin('event_consumer_failures as f', (j) =>
        j.onRef('f.event_id', '=', 'o.id').on('f.consumer', '=', 'ledger'),
      )
      .select(['i.event_id as claimed', 'f.event_id as failed'])
      .where('o.event_type', '=', 'inventory.waste_recorded')
      .where('o.aggregate_id', '=', res.body.id)
      .executeTakeFirstOrThrow();
    expect(handled.claimed).not.toBeNull();
    expect(handled.failed).toBeNull();
    // Release the line's reservation so stock elsewhere is unaffected.
    const supervisor = await login(h, 'supervisor@central.kitchos.test');
    await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/cancel`)
      .set(bearer(supervisor))
      .send({ reason: 'Test cleanup' });
  });

  it('values are computed by the database, never taken from the writer', async () => {
    const loc = await h.owner
      .selectFrom('stock_locations')
      .select(['id', 'org_id'])
      .where('restaurant_id', '=', centralId)
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    const cost = await h.owner
      .selectFrom('inventory_items')
      .select('standard_unit_cost')
      .where('id', '=', sku('BUN-REG'))
      .executeTakeFirstOrThrow();
    const row = await h.owner
      .insertInto('stock_movements')
      .values({
        org_id: loc.org_id,
        restaurant_id: centralId,
        location_id: loc.id,
        inventory_item_id: sku('BUN-REG'),
        movement_type: 'count_adjustment',
        quantity_delta: '1',
        source_type: 'value_tamper_test',
        source_id: randomUUID(),
        occurred_at: sql<Date>`now()`,
        business_date: sql<string>`app.business_date(${centralId}::uuid, now())`,
        unit_cost: '0',
        value_cents: 999_999,
      })
      .returning(['unit_cost', 'value_cents', 'id'])
      .executeTakeFirstOrThrow();
    expect(row.unit_cost).toBe(cost.standard_unit_cost);
    expect(row.value_cents).toBe(Math.round(Number(cost.standard_unit_cost)));
    // Undo it the append-only way so the books still reconcile for other files.
    await h.owner
      .insertInto('stock_movements')
      .values({
        org_id: loc.org_id,
        restaurant_id: centralId,
        location_id: loc.id,
        inventory_item_id: sku('BUN-REG'),
        movement_type: 'count_adjustment',
        quantity_delta: '-1',
        source_type: 'value_tamper_test',
        source_id: row.id,
        occurred_at: sql<Date>`now()`,
        business_date: sql<string>`app.business_date(${centralId}::uuid, now())`,
      })
      .execute();
  });

  it('redelivery posts nothing twice and the Inventory account reconciles to the stock ledger', async () => {
    await dispatcher.runOnce();
    const before = await h.owner
      .selectFrom('journal_entries')
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    // Forget that the ledger processed today's inventory events, then dispatch again.
    await sql`delete from inbox_events where consumer = 'ledger' and event_id in (
      select id from outbox_events where restaurant_id = ${centralId}::uuid
        and event_type in ('inventory.waste_recorded', 'inventory.counted', 'kitchen.task.started'))`.execute(
      h.owner,
    );
    // One pass handles one batch, and other test files may have left events behind.
    while ((await dispatcher.runOnce()).processed > 0);
    const after = await h.owner
      .selectFrom('journal_entries')
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);

    const { rows } = await sql<{ d: string }>`
      select app.business_date(${centralId}::uuid, now())::text as d`.execute(h.owner);
    const rec = await h.http
      .get(`/v1/restaurants/${centralId}/accounting/reconciliation?businessDate=${rows[0]!.d}`)
      .set(bearer(manager))
      .expect(200);
    expect(rec.body.stockMovementsValueCents).toBe(rec.body.journalInventoryCents);
    expect(rec.body).toMatchObject({ reconciled: true, pendingEvents: 0, deadLetteredEvents: 0 });
  });
});
