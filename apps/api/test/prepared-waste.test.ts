import { randomUUID } from 'node:crypto';
import type { KitchenTaskView, OrderView, PreparedItemsView } from '@kitchos/contracts';
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

const DRIVE = 'kitchos-drive';

/** Prepared food on cancellation and refund becomes waste (Milestone 14, ADR-0011). */
describe('prepared food on cancel and refund', () => {
  let h: Harness;
  let driveId: string;
  let manager: string;
  let supervisor: string;
  let crew: string;
  let dispatcher: EventDispatcher;

  beforeAll(async () => {
    h = await startHarness();
    driveId = await restaurantId(h, DRIVE);
    manager = await login(h, 'manager@drive.kitchos.test');
    supervisor = await login(h, 'supervisor@drive.kitchos.test');
    crew = await login(h, 'crew1@drive.kitchos.test');
    dispatcher = h.app.get(EventDispatcher);
  });
  afterAll(() => h.close());

  const base = () => `/v1/restaurants/${driveId}`;
  const drain = async () => {
    while ((await dispatcher.runOnce()).processed > 0);
  };
  const order = async (lines: [string, number][]) => {
    const menu = await getMenu(h, DRIVE);
    return placeAndPay(
      h,
      DRIVE,
      lines.map(([name, quantity]) => ({ menuItemId: item(menu, name).id, quantity })),
    );
  };
  const tasks = async (o: OrderView) =>
    (
      (await h.http.get(`${base()}/kitchen/tasks`).set(bearer(crew)).expect(200))
        .body as KitchenTaskView[]
    ).filter((t) => t.orderId === o.id);
  const startAll = async (o: OrderView) => {
    for (const t of await tasks(o)) {
      await h.http
        .post(`${base()}/kitchen/tasks/${t.id}/start`)
        .set(bearer(crew))
        .send({})
        .expect(200);
    }
  };
  const finish = async (o: OrderView) => {
    for (const t of await tasks(o)) {
      await h.http
        .post(`${base()}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(crew))
        .send({})
        .expect(200);
    }
    await h.http.post(`${base()}/orders/${o.id}/handoff`).set(bearer(crew)).expect(200);
  };
  const cancel = (o: OrderView, body: object = {}) =>
    h.http
      .post(`${base()}/orders/${o.id}/cancel`)
      .set(bearer(manager))
      .send({ reason: 'Customer left', ...body });
  const refund = (o: OrderView, body: object, key = randomUUID()) =>
    h.http
      .post(`${base()}/orders/${o.id}/refunds`)
      .set(bearer(supervisor))
      .set('Idempotency-Key', key)
      .send(body);
  const preparedView = async (o: OrderView, token = crew) =>
    (await h.http.get(`${base()}/orders/${o.id}/prepared-items`).set(bearer(token)).expect(200))
      .body as PreparedItemsView;
  const prepared = async (o: OrderView, token = crew) =>
    (
      (await h.http.get(`${base()}/orders/${o.id}/prepared-items`).set(bearer(token)).expect(200))
        .body as PreparedItemsView
    ).items;
  /** Waste recorded against each of an order's lines, by line name. */
  const wasted = async (o: OrderView) => {
    const rows = await h.owner
      .selectFrom('waste_records as w')
      .innerJoin('order_lines as l', 'l.id', 'w.order_line_id')
      .select(['l.name', 'w.quantity', 'w.reason', 'w.status', 'w.id'])
      .where('l.order_id', '=', o.id)
      .orderBy('l.name')
      .execute();
    return rows;
  };
  const status = async (o: OrderView) =>
    (
      await h.owner
        .selectFrom('orders')
        .select('status')
        .where('id', '=', o.id)
        .executeTakeFirstOrThrow()
    ).status;

  it('cancelling after preparation records every prepared portion as waste, once, without new stock', async () => {
    // Fries are consumed when their task completes: started but not consumed, so not prepared.
    const o = await order([
      ['Cheeseburger', 2],
      ['Double Cheeseburger', 1],
      ['Medium Fries', 1],
    ]);
    await startAll(o);
    const before = await prepared(o);
    expect(before.map((p) => [p.name, p.remaining]).sort()).toEqual([
      ['Cheeseburger', 2],
      ['Double Cheeseburger', 1],
    ]);
    const movementsBefore = await h.owner
      .selectFrom('stock_movements')
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    expect((await cancel(o)).status).toBe(200);
    const rows = await wasted(o);
    expect(rows.map((r) => [r.name, r.quantity, r.reason])).toEqual([
      ['Cheeseburger', '2.000', 'cancelled_prepared_order'],
      ['Double Cheeseburger', '1.000', 'cancelled_prepared_order'],
    ]);
    // Already consumed: classification only, no second deduction.
    const movementsAfter = await h.owner
      .selectFrom('stock_movements')
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    expect(movementsAfter.n).toBe(movementsBefore.n);
    expect((await prepared(o)).every((p) => p.remaining === 0)).toBe(true);
    // The books move its cost from COGS to Waste, exactly.
    await drain();
    const lines = await h.owner
      .selectFrom('order_lines')
      .select('id')
      .where('order_id', '=', o.id)
      .execute();
    const { rows: net } = await sql<{ key: string; v: string }>`
      select a.system_key as key, sum(l.debit_cents - l.credit_cents)::text as v
        from journal_entries e join journal_lines l on l.entry_id = e.id
        join accounts a on a.id = l.account_id
       where (e.source_type = 'order_line' and e.source_id = any(${sql.val(lines.map((l) => l.id))}::uuid[]))
          or (e.source_type = 'order' and e.source_id = ${o.id}::uuid)
          or (e.source_type = 'waste_record' and e.source_id = any(${sql.val(rows.map((r) => r.id))}::uuid[]))
       group by a.system_key`.execute(h.owner);
    const v = (k: string) => Number(net.find((x) => x.key === k)?.v ?? 0);
    expect(v('cogs')).toBe(0);
    expect(v('waste_expense')).toBe(-v('inventory'));
    expect(v('waste_expense')).toBeGreaterThan(0);
  });

  it('a manager can lower the portions; a given list is the whole answer', async () => {
    const o = await order([
      ['Cheeseburger', 2],
      ['Double Cheeseburger', 1],
    ]);
    await startAll(o);
    const items = await prepared(o);
    const burger = items.find((p) => p.name === 'Cheeseburger')!;
    expect(
      (await cancel(o, { waste: [{ orderLineId: burger.orderLineId, quantity: 1 }] })).status,
    ).toBe(200);
    // One burger went to another customer; the Double Cheeseburger, unlisted, was not recorded.
    expect((await wasted(o)).map((r) => [r.name, r.quantity])).toEqual([['Cheeseburger', '1.000']]);
  });

  it('refuses portions that were not prepared, or more than remain, and then cancels nothing', async () => {
    const o = await order([['Cheeseburger', 1]]);
    const other = await order([['Cheeseburger', 1]]);
    await startAll(o);
    const [line] = await prepared(o);
    const otherLine = (
      await h.owner
        .selectFrom('order_lines')
        .select('id')
        .where('order_id', '=', other.id)
        .executeTakeFirstOrThrow()
    ).id;
    for (const waste of [
      [{ orderLineId: line!.orderLineId, quantity: 2 }],
      [{ orderLineId: otherLine, quantity: 1 }],
      [{ orderLineId: randomUUID(), quantity: 1 }],
    ]) {
      const res = await cancel(o, { waste });
      expect(res.status).toBe(422);
      expect(await status(o)).toBe('in_preparation');
    }
    expect(await wasted(o)).toEqual([]);
    expect(
      (
        await cancel(o, {
          waste: [
            { orderLineId: line!.orderLineId, quantity: 1 },
            { orderLineId: line!.orderLineId, quantity: 1 },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await cancel(o)).status).toBe(200);
    // Clean up the other order (not prepared: nothing to record).
    expect((await cancel(other)).status).toBe(200);
    expect(await wasted(other)).toEqual([]);
  });

  it('food already recorded as waste by hand is not recorded twice on cancel', async () => {
    const o = await order([['Cheeseburger', 2]]);
    await startAll(o);
    const [line] = await prepared(o);
    await h.http
      .post(`${base()}/inventory/waste`)
      .set(bearer(crew))
      .set('Idempotency-Key', randomUUID())
      .send({
        kind: 'prepared_item',
        orderLineId: line!.orderLineId,
        quantity: 1,
        reason: 'dropped',
      })
      .expect(201);
    expect((await prepared(o))[0]!.remaining).toBe(1);
    expect((await cancel(o)).status).toBe(200);
    expect((await wasted(o)).map((r) => [r.quantity, r.reason]).sort()).toEqual([
      ['1.000', 'cancelled_prepared_order'],
      ['1.000', 'dropped'],
    ]);
  });

  it('cancelling before preparation records nothing', async () => {
    const o = await order([['Cheeseburger', 1]]);
    expect(await prepared(o)).toEqual([]);
    expect((await cancel(o)).status).toBe(200);
    expect(await wasted(o)).toEqual([]);
  });

  /** Order lines of an order by name, for refunds by item. */
  const linesOf = async (o: OrderView) =>
    Object.fromEntries(
      (
        await h.owner
          .selectFrom('order_lines')
          .select([
            'id',
            'name',
            'quantity',
            'line_total_cents',
            'discount_cents',
            'parent_line_id',
          ])
          .where('order_id', '=', o.id)
          .execute()
      ).map((l) => [l.parent_line_id ? `${l.name} (component)` : l.name, l]),
    );

  it('a refund by item returns its net price, counts it as waste, and never twice', async () => {
    const o = await order([['Cheeseburger', 3]]);
    await finish(o);
    const burger = (await linesOf(o))['Cheeseburger']!;
    const net = burger.line_total_cents - burger.discount_cents;
    const one = await refund(o, {
      reason: 'quality',
      items: [{ orderLineId: burger.id, quantity: 1 }],
    });
    expect(one.status).toBe(201);
    const first = one.body.refunds[0];
    // The server prices it: one third of the line, rounded half up.
    expect(first.amountCents).toBe(Math.floor((net + 1) / 3));
    expect(first.items).toEqual([
      { name: 'Cheeseburger', quantity: 1, amountCents: first.amountCents },
    ]);
    expect((await wasted(o)).map((r) => [r.quantity, r.reason])).toEqual([
      ['1.000', 'poor_quality'],
    ]);
    // The other two: together the three refunds return exactly the line's net price.
    const two = await refund(o, {
      reason: 'order_error',
      items: [{ orderLineId: burger.id, quantity: 2 }],
    });
    expect(two.status).toBe(201);
    const total = (two.body as OrderView).refunds.reduce((s, r) => s + r.amountCents, 0);
    expect(total).toBe(net);
    expect((two.body as OrderView).lines[0]!.refundedQuantity).toBe(3);
    expect((await wasted(o)).map((r) => r.quantity).sort()).toEqual(['1.000', '2.000']);
    // Nothing is left to refund on that line.
    const more = await refund(o, {
      reason: 'quality',
      items: [{ orderLineId: burger.id, quantity: 1 }],
    });
    expect(more.status).toBe(409); // the payment is fully refunded
  });

  it('a meal refunded by item: its components are the waste', async () => {
    const o = await order([['Cheeseburger Meal', 1]]);
    await finish(o);
    const lines = await linesOf(o);
    const meal = lines['Cheeseburger Meal']!;
    expect(
      (await refund(o, { reason: 'quality', items: [{ orderLineId: meal.id, quantity: 1 }] }))
        .status,
    ).toBe(201);
    const names = (await wasted(o)).map((r) => r.name).sort();
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('Cheeseburger Meal');
    for (const n of names) expect(Object.keys(lines)).toContain(`${n} (component)`);
  });

  it('a refund by item is priced at the line net; a stale amount or a duplicate charge by item is refused', async () => {
    const o = await order([
      ['Cheeseburger', 2],
      ['Medium Cola', 1],
    ]);
    await finish(o);
    const { Cheeseburger: burger, 'Medium Cola': cola } = await linesOf(o);
    // A discount spread onto the lines after payment is not possible, so pin the net directly:
    // the server prices from line_total_cents - discount_cents.
    const net = burger!.line_total_cents - burger!.discount_cents;
    // The screen's amount must match, or nothing happens.
    const stale = await refund(o, {
      reason: 'quality',
      items: [{ orderLineId: burger!.id, quantity: 1 }],
      expectedAmountCents: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('REFUND_AMOUNT_CHANGED');
    expect(
      (
        await refund(o, {
          reason: 'duplicate_charge',
          items: [{ orderLineId: burger!.id, quantity: 1 }],
        })
      ).status,
    ).toBe(400);
    expect(
      await h.owner.selectFrom('refunds').select('id').where('order_id', '=', o.id).execute(),
    ).toEqual([]);
    // The right amount goes through.
    const ok = await refund(o, {
      reason: 'quality',
      items: [{ orderLineId: burger!.id, quantity: 2 }],
      expectedAmountCents: net,
    });
    expect(ok.status).toBe(201);
    expect((ok.body as OrderView).refunds[0]!.amountCents).toBe(net);
    // The burgers are done, but the cola is still unpaid back: the line limit applies on its own.
    const again = await refund(o, {
      reason: 'quality',
      items: [{ orderLineId: burger!.id, quantity: 1 }],
    });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('REFUND_EXCEEDS_LINE');
    expect(
      (await refund(o, { reason: 'quality', items: [{ orderLineId: cola!.id, quantity: 1 }] }))
        .status,
    ).toBe(201);
  });

  it('refuses more than is left, a line from another order, and items with an amount', async () => {
    const o = await order([['Cheeseburger', 1]]);
    const other = await order([['Cheeseburger', 1]]);
    await finish(o);
    const burger = (await linesOf(o))['Cheeseburger']!;
    const otherLine = (await linesOf(other))['Cheeseburger']!;
    expect(
      (await refund(o, { reason: 'quality', items: [{ orderLineId: burger.id, quantity: 2 }] }))
        .status,
    ).toBe(422);
    expect(
      (await refund(o, { reason: 'quality', items: [{ orderLineId: otherLine.id, quantity: 1 }] }))
        .status,
    ).toBe(422);
    expect(
      (
        await refund(o, {
          reason: 'quality',
          amountCents: 100,
          items: [{ orderLineId: burger.id, quantity: 1 }],
        })
      ).status,
    ).toBe(400);
    const refunds = await h.owner
      .selectFrom('refunds')
      .select('id')
      .where('order_id', '=', o.id)
      .execute();
    expect(refunds).toEqual([]);
    expect(await wasted(o)).toEqual([]);
    expect((await cancel(other)).status).toBe(200);
  });

  it('a refund by amount moves money only, unless staff enter waste by hand', async () => {
    const make = async () => {
      const o = await order([['Cheeseburger', 2]]);
      await finish(o);
      return o;
    };
    const d = await make();
    expect((await refund(d, { amountCents: 100, reason: 'duplicate_charge' })).status).toBe(201);
    expect(await wasted(d)).toEqual([]);
    const q = await make();
    expect((await refund(q, { amountCents: 100, reason: 'quality' })).status).toBe(201);
    expect(await wasted(q)).toEqual([]);
    // One burger came back, entered by hand; replaying the same refund records nothing more.
    const c = await make();
    const [line] = await prepared(c);
    const key = randomUUID();
    const body = {
      amountCents: 300,
      reason: 'customer_complaint',
      waste: [{ orderLineId: line!.orderLineId, quantity: 1 }],
    };
    expect((await refund(c, body, key)).status).toBe(201);
    const replay = await refund(c, body, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await wasted(c)).map((r) => [r.quantity, r.reason])).toEqual([
      ['1.000', 'poor_quality'],
    ]);
  });

  it('a refund of a cancelled order finds its food already recorded', async () => {
    const o = await order([['Cheeseburger', 1]]);
    await startAll(o);
    expect((await cancel(o)).status).toBe(200);
    const burger = (await linesOf(o))['Cheeseburger']!;
    expect(
      (await refund(o, { reason: 'quality', items: [{ orderLineId: burger.id, quantity: 1 }] }))
        .status,
    ).toBe(201);
    expect((await wasted(o)).map((r) => r.reason)).toEqual(['cancelled_prepared_order']);
  });

  it('prepared items are readable with orders.view at this restaurant only', async () => {
    const o = await order([['Cheeseburger', 1]]);
    await startAll(o);
    const url = `${base()}/orders/${o.id}/prepared-items`;
    expect((await h.http.get(url).set(bearer(crew))).status).toBe(200);
    const inventory = await login(h, 'auditor@kitchos.test');
    expect((await h.http.get(url).set(bearer(inventory))).status).toBe(200);
    const central = await login(h, 'manager@central.kitchos.test');
    expect((await h.http.get(url).set(bearer(central))).status).toBe(404);
    const rival = await login(h, 'manager@rival.test');
    expect((await h.http.get(url).set(bearer(rival))).status).toBe(404);
    expect(
      (await h.http.get(`${base()}/orders/${randomUUID()}/prepared-items`).set(bearer(crew)))
        .status,
    ).toBe(404);
    expect((await cancel(o)).status).toBe(200);
  });

  it('a cancel chosen from a list that has since changed is refused, and cancels nothing', async () => {
    const o = await order([['Cheeseburger', 2]]);
    await startAll(o);
    const seen = await preparedView(o);
    // Meanwhile someone records one burger as dropped: the list the manager saw is out of date.
    await h.http
      .post(`${base()}/inventory/waste`)
      .set(bearer(crew))
      .set('Idempotency-Key', randomUUID())
      .send({
        kind: 'prepared_item',
        orderLineId: seen.items[0]!.orderLineId,
        quantity: 1,
        reason: 'dropped',
      })
      .expect(201);
    const stale = await cancel(o, {
      preparedVersion: seen.version,
      waste: [{ orderLineId: seen.items[0]!.orderLineId, quantity: 1 }],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PREPARED_ITEMS_CHANGED');
    expect(await status(o)).toBe('in_preparation');
    const fresh = await preparedView(o);
    expect(fresh.version).not.toBe(seen.version);
    expect(
      (
        await cancel(o, {
          preparedVersion: fresh.version,
          waste: [{ orderLineId: fresh.items[0]!.orderLineId, quantity: 1 }],
        })
      ).status,
    ).toBe(200);
  });

  it('after a rejected remake, cancelling records every portion that was made', async () => {
    const o = await order([['Cheeseburger', 1]]);
    await startAll(o);
    const [line] = await prepared(o);
    const remade = await h.http
      .post(`${base()}/inventory/waste`)
      .set(bearer(crew))
      .set('Idempotency-Key', randomUUID())
      .send({
        kind: 'prepared_item',
        orderLineId: line!.orderLineId,
        quantity: 1,
        remake: true,
        reason: 'burnt',
      })
      .expect(201);
    await h.http
      .post(`${base()}/inventory/waste/${remade.body.id}/reject`)
      .set(bearer(manager))
      .send({ reason: 'It was fine' })
      .expect(200);
    // One ordered, one remade (the remake stands): two made, none wasted any more.
    expect((await prepared(o))[0]!.remaining).toBe(2);
    expect((await cancel(o)).status).toBe(200);
    expect((await wasted(o)).filter((r) => r.status !== 'rejected').map((r) => r.quantity)).toEqual(
      ['2.000'],
    );
  });

  it('food is moved out of COGS at the cost it went in at, even after a cost change', async () => {
    const o = await order([['Cheeseburger', 1]]);
    await startAll(o);
    await drain();
    const bun = await h.owner
      .selectFrom('inventory_items as i')
      .innerJoin('restaurants as r', 'r.org_id', 'i.org_id')
      .select(['i.id', 'i.standard_unit_cost'])
      .where('i.sku', '=', 'BUN-REG')
      .where('r.id', '=', driveId)
      .executeTakeFirstOrThrow();
    const [line] = await prepared(o);
    const consumed = Number(
      (
        await h.owner
          .selectFrom('stock_movements')
          .select(sql<string>`sum(value_cents)`.as('v'))
          .where('source_type', '=', 'order_line')
          .where('source_id', '=', line!.orderLineId)
          .executeTakeFirstOrThrow()
      ).v,
    );
    try {
      await h.owner
        .updateTable('inventory_items')
        .set({ standard_unit_cost: '999' })
        .where('id', '=', bun.id)
        .execute();
      expect((await cancel(o)).status).toBe(200);
    } finally {
      await h.owner
        .updateTable('inventory_items')
        .set({ standard_unit_cost: bun.standard_unit_cost })
        .where('id', '=', bun.id)
        .execute();
    }
    const [w] = await wasted(o);
    const cost = Number(
      (
        await h.owner
          .selectFrom('waste_records')
          .select('cost_cents')
          .where('id', '=', w!.id)
          .executeTakeFirstOrThrow()
      ).cost_cents,
    );
    expect(cost).toBe(-consumed); // not the new standard cost
    await drain();
    const { rows } = await sql<{ v: string }>`
      select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as v
        from journal_entries e join journal_lines l on l.entry_id = e.id
        join accounts a on a.id = l.account_id
       where a.system_key = 'cogs'
         and ((e.source_type = 'order_line' and e.source_id = ${line!.orderLineId}::uuid)
           or (e.source_type = 'order' and e.source_id = ${o.id}::uuid)
           or (e.source_type = 'waste_record' and e.source_id = ${w!.id}::uuid))`.execute(h.owner);
    expect(Number(rows[0]!.v)).toBe(0);
  });
});
