import { randomUUID } from 'node:crypto';
import type { FoodCostReport, KitchenTaskView, MenuItemReport } from '@kitchos/contracts';
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

describe('food cost per menu item', () => {
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
  const today = async () =>
    (
      await sql<{ d: string }>`
        select app.business_date(${driveId}::uuid, now())::text as d`.execute(h.owner)
    ).rows[0]!.d;
  const items = async (day: string, token = manager) =>
    (
      await h.http
        .get(`${base()}/reports/menu-items?from=${day}&to=${day}`)
        .set(bearer(token))
        .expect(200)
    ).body as MenuItemReport;
  const foodCost = async (day: string) =>
    (
      await h.http
        .get(`${base()}/reports/food-cost?from=${day}&to=${day}`)
        .set(bearer(manager))
        .expect(200)
    ).body as FoodCostReport;
  const rowOf = (r: MenuItemReport, name: string) =>
    r.items.find((i) => i.name === name) ?? {
      unitsSold: 0,
      netSalesCents: 0,
      recipeCostCents: 0,
    };
  const sell = async (name: string, quantity: number) => {
    const menu = await getMenu(h, DRIVE);
    const o = await placeAndPay(h, DRIVE, [{ menuItemId: item(menu, name).id, quantity }]);
    const tasks = (
      (await h.http.get(`${base()}/kitchen/tasks`).set(bearer(crew)).expect(200))
        .body as KitchenTaskView[]
    ).filter((t) => t.orderId === o.id);
    for (const t of tasks) {
      await h.http
        .post(`${base()}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(crew))
        .send({})
        .expect(200);
    }
    await h.http.post(`${base()}/orders/${o.id}/handoff`).set(bearer(crew)).expect(200);
    await drain();
    return o;
  };
  const consumed = async (orderId: string) =>
    Number(
      (
        await sql<{ v: string }>`
          select coalesce(-sum(m.value_cents), 0)::text as v
            from stock_movements m join order_lines l on l.id = m.source_id
           where m.source_type = 'order_line' and m.source_key = ''
             and m.movement_type = 'production_consumption' and l.order_id = ${orderId}::uuid`.execute(
          h.owner,
        )
      ).rows[0]!.v,
    );
  const refund = (orderId: string, body: object) =>
    h.http
      .post(`${base()}/orders/${orderId}/refunds`)
      .set(bearer(supervisor))
      .set('Idempotency-Key', randomUUID())
      .send(body);

  it('a sale adds its units, its net ex GST and what it was consumed at to its item', async () => {
    const day = await today();
    await drain();
    const before = rowOf(await items(day), 'Cheeseburger');
    const o = await sell('Cheeseburger', 2);
    const after = rowOf(await items(day), 'Cheeseburger');
    expect(after.unitsSold - before.unitsSold).toBe(2);
    expect(after.netSalesCents - before.netSalesCents).toBe(o.totalCents - o.taxCents);
    expect(after.recipeCostCents - before.recipeCostCents).toBe(await consumed(o.id));
  });

  it('a meal is one row, costed with its components', async () => {
    const day = await today();
    const before = rowOf(await items(day), 'Cheeseburger Meal');
    const o = await sell('Cheeseburger Meal', 1);
    const after = rowOf(await items(day), 'Cheeseburger Meal');
    expect(after.unitsSold - before.unitsSold).toBe(1);
    expect(after.recipeCostCents - before.recipeCostCents).toBe(await consumed(o.id));
    const r = await items(day);
    expect(r.items.map((i) => i.name)).not.toContain('Medium Fries (component)');
  });

  it('a refund by item takes back units, net and cost; a refund by amount is shown apart', async () => {
    const day = await today();
    const o = await sell('Cheeseburger', 2);
    const line = await h.owner
      .selectFrom('order_lines')
      .select('id')
      .where('order_id', '=', o.id)
      .executeTakeFirstOrThrow();
    const before = await items(day);
    expect(
      (await refund(o.id, { reason: 'quality', items: [{ orderLineId: line.id, quantity: 1 }] }))
        .status,
    ).toBe(201);
    await drain();
    const mid = await items(day);
    expect(rowOf(mid, 'Cheeseburger').unitsSold - rowOf(before, 'Cheeseburger').unitsSold).toBe(-1);
    expect(
      rowOf(mid, 'Cheeseburger').recipeCostCents - rowOf(before, 'Cheeseburger').recipeCostCents,
    ).toBe(-Math.round((await consumed(o.id)) / 2));
    // Money only: no row moves, the unallocated line does.
    expect((await refund(o.id, { reason: 'other', amountCents: 100 })).status).toBe(201);
    await drain();
    const after = await items(day);
    expect(rowOf(after, 'Cheeseburger').unitsSold).toBe(rowOf(mid, 'Cheeseburger').unitsSold);
    expect(after.refundsByAmountCents - mid.refundsByAmountCents).toBeGreaterThan(0);
    expect(after.refundsByAmountCents - mid.refundsByAmountCents).toBeLessThanOrEqual(100);
  });

  it('items less refunds by amount equal the food cost report, to the cent', async () => {
    const day = await today();
    await drain();
    const r = await items(day);
    const f = await foodCost(day);
    expect(r.totals.netSalesCents).toBe(f.totals.netSalesCents);
    expect(r.totals.recipeCostCents).toBe(f.totals.soldRecipeCents);
    expect(r.items.reduce((s, i) => s + i.netSalesCents, 0) - r.refundsByAmountCents).toBe(
      r.totals.netSalesCents,
    );
    for (const c of r.categories) {
      const of = r.items.filter((i) => i.category === c.category);
      expect(c.netSalesCents).toBe(of.reduce((s, i) => s + i.netSalesCents, 0));
      expect(c.recipeCostCents).toBe(of.reduce((s, i) => s + i.recipeCostCents, 0));
    }
  });

  it('an item renamed between sales is shown by its newest name, whatever the read order', async () => {
    const day = await today();
    const older = await sell('Cheeseburger', 1);
    const newer = await sell('Cheeseburger', 1);
    const rename = (orderId: string, name: string) =>
      sql`update order_lines set name = ${name} where order_id = ${orderId}::uuid`.execute(h.owner);
    // Placed a minute apart, whichever way round the rows come back.
    await sql`update orders set placed_at = placed_at - interval '1 minute'
               where id = ${older.id}::uuid`.execute(h.owner);
    try {
      await rename(older.id, 'Cheeseburger (old name)');
      await rename(newer.id, 'Cheeseburger (new name)');
      const names = (await items(day)).items.map((i) => i.name);
      expect(names).toContain('Cheeseburger (new name)');
      expect(names).not.toContain('Cheeseburger (old name)');
      expect(names).not.toContain('Cheeseburger');
    } finally {
      await rename(older.id, 'Cheeseburger');
      await rename(newer.id, 'Cheeseburger');
    }
  });

  it('validates the range and needs reports.view at this restaurant', async () => {
    const day = await today();
    const get = (qs: string, token = manager) =>
      h.http.get(`${base()}/reports/menu-items?${qs}`).set(bearer(token));
    expect((await get(`from=${day}&to=${day}`, crew)).status).toBe(403);
    expect((await get(`from=${day}&to=${day}`, supervisor)).status).toBe(403);
    expect((await get(`from=${day}&to=${day}`, await login(h, 'manager@rival.test'))).status).toBe(
      404,
    );
    expect((await get(`from=${day}&to=2000-01-01`)).status).toBe(400);
    expect((await get(`from=2026-01-01&to=2026-06-01`)).status).toBe(400);
  });
});
