import { randomUUID } from 'node:crypto';
import type { FoodCostReport, KitchenTaskView } from '@kitchos/contracts';
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

describe('food cost and gross margin report', () => {
  let h: Harness;
  let driveId: string;
  let manager: string;
  let crew: string;
  let auditor: string;
  let dispatcher: EventDispatcher;

  beforeAll(async () => {
    h = await startHarness();
    driveId = await restaurantId(h, DRIVE);
    manager = await login(h, 'manager@drive.kitchos.test');
    crew = await login(h, 'crew1@drive.kitchos.test');
    auditor = await login(h, 'auditor@kitchos.test');
    dispatcher = h.app.get(EventDispatcher);
  });
  afterAll(() => h.close());

  const drain = async () => {
    while ((await dispatcher.runOnce()).processed > 0);
  };
  const dayOffset = async (days: number) => {
    const { rows } = await sql<{ d: string }>`
      select (app.business_date(${driveId}::uuid, now()) - ${days}::int)::text as d`.execute(
      h.owner,
    );
    return rows[0]!.d;
  };
  const report = async (from: string, to: string, token = manager) =>
    (
      await h.http
        .get(`/v1/restaurants/${driveId}/reports/food-cost?from=${from}&to=${to}`)
        .set(bearer(token))
        .expect(200)
    ).body as FoodCostReport;
  const todayRow = async () => {
    const day = await dayOffset(0);
    return (await report(day, day)).days[0]!;
  };
  /** Σ value of the stock movements a source recorded: the books must match these exactly. */
  const movementValue = async (sourceType: string, sourceIds: string[]) =>
    Number(
      (
        await h.owner
          .selectFrom('stock_movements')
          .select(sql<string>`coalesce(sum(value_cents), 0)`.as('v'))
          .where('source_type', '=', sourceType)
          .where('source_id', 'in', sourceIds)
          .executeTakeFirstOrThrow()
      ).v,
    );

  it('a sale moves net sales and recipe cost by exactly its source figures', async () => {
    await drain();
    const before = await todayRow();
    const menu = await getMenu(h, DRIVE);
    const order = await placeAndPay(h, DRIVE, [
      { menuItemId: item(menu, 'Cheeseburger').id, quantity: 2 },
    ]);
    const tasks = (
      await h.http.get(`/v1/restaurants/${driveId}/kitchen/tasks`).set(bearer(crew)).expect(200)
    ).body as KitchenTaskView[];
    for (const t of tasks.filter((x) => x.orderId === order.id)) {
      await h.http
        .post(`/v1/restaurants/${driveId}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(crew))
        .send({})
        .expect(200);
    }
    await h.http
      .post(`/v1/restaurants/${driveId}/orders/${order.id}/handoff`)
      .set(bearer(crew))
      .expect(200);
    await drain();
    const after = await todayRow();

    const lines = await h.owner
      .selectFrom('order_lines')
      .select('id')
      .where('order_id', '=', order.id)
      .execute();
    const consumed = -(await movementValue(
      'order_line',
      lines.map((l) => l.id),
    ));
    expect(consumed).toBeGreaterThan(0);
    expect(after.netSalesCents - before.netSalesCents).toBe(order.totalCents - order.taxCents);
    expect(after.cogsCents - before.cogsCents).toBe(consumed);
    expect(after.wasteCents).toBe(before.wasteCents);
    expect(after.grossProfitCents + after.actualFoodCostCents).toBe(after.netSalesCents);
  });

  it('waste and a count shortfall raise actual cost but not recipe cost', async () => {
    await drain();
    const before = await todayRow();
    const bun = await h.owner
      .selectFrom('inventory_items as i')
      .innerJoin('restaurants as r', 'r.org_id', 'i.org_id')
      .select('i.id')
      .where('i.sku', '=', 'BUN-REG')
      .where('r.id', '=', driveId)
      .executeTakeFirstOrThrow();
    const waste = await h.http
      .post(`/v1/restaurants/${driveId}/inventory/waste`)
      .set(bearer(crew))
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'raw_ingredient', inventoryItemId: bun.id, quantity: '2', reason: 'dropped' })
      .expect(201);
    const onHand = (
      await h.http
        .get(`/v1/restaurants/${driveId}/inventory/balances`)
        .set(bearer(manager))
        .expect(200)
    ).body.find((b: { inventoryItemId: string }) => b.inventoryItemId === bun.id).onHand as string;
    // One bun short of whatever is there; top up first if earlier files left too few to count down.
    if (Number(onHand.split('.')[0]) < 1) throw new Error(`not enough buns to count: ${onHand}`);
    const short = (Number(onHand.split('.')[0]) - 1).toString();
    const count = await h.http
      .post(`/v1/restaurants/${driveId}/inventory/counts`)
      .set(bearer(manager))
      .set('Idempotency-Key', randomUUID())
      .send({ lines: [{ inventoryItemId: bun.id, counted: short }] })
      .expect(201);
    await drain();
    const after = await todayRow();

    expect(after.wasteCents - before.wasteCents).toBe(
      -(await movementValue('waste_record', [waste.body.id])),
    );
    expect(after.stockVarianceCents - before.stockVarianceCents).toBe(
      -(await movementValue('stock_count', [count.body.id])),
    );
    expect(after.cogsCents).toBe(before.cogsCents);
    expect(after.actualFoodCostCents - before.actualFoodCostCents).toBe(
      after.wasteCents - before.wasteCents + (after.stockVarianceCents - before.stockVarianceCents),
    );
    // Restore the count to what it was before the shortfall (after the 2-bun waste).
    await h.http
      .post(`/v1/restaurants/${driveId}/inventory/counts`)
      .set(bearer(manager))
      .set('Idempotency-Key', randomUUID())
      .send({ lines: [{ inventoryItemId: bun.id, counted: onHand }] })
      .expect(201);
    await drain();
  });

  it('agrees with the day close figures for the same day', async () => {
    await drain();
    const day = await dayOffset(0);
    const row = (await report(day, day, auditor)).days[0]!;
    const close = (
      await h.http.get(`/v1/restaurants/${driveId}/days/${day}`).set(bearer(auditor)).expect(200)
    ).body;
    expect(row).toMatchObject({
      netSalesCents: close.totals.netSalesCents,
      cogsCents: close.totals.cogsCents,
      wasteCents: close.totals.wasteCents,
      stockVarianceCents: close.totals.stockVarianceCents,
    });
  });

  it('lists every day in the range, marks closed days, and has no percentage without sales', async () => {
    const closedDay = await dayOffset(70);
    await h.http
      .post(`/v1/restaurants/${driveId}/days/${closedDay}/close`)
      .set(bearer(manager))
      .send({})
      .expect(200);
    const r = await report(await dayOffset(71), await dayOffset(69));
    expect(r.days.map((d) => d.businessDate)).toEqual([
      await dayOffset(71),
      closedDay,
      await dayOffset(69),
    ]);
    expect(r.days.map((d) => d.closed)).toEqual([false, true, false]);
    for (const d of r.days) {
      expect(d).toMatchObject({
        netSalesCents: 0,
        grossProfitCents: 0,
        cogsBps: null,
        actualFoodCostBps: null,
      });
    }
  });

  it('totals come from summed figures, not averaged percentages', async () => {
    // Two quiet days with different ratios, posted as balanced entries: 40% then 10%.
    const days = [await dayOffset(80), await dayOffset(79)];
    const org = await h.owner
      .selectFrom('restaurants')
      .select('org_id')
      .where('id', '=', driveId)
      .executeTakeFirstOrThrow();
    const account = async (key: string) =>
      (
        await h.owner
          .selectFrom('accounts')
          .select('id')
          .where('org_id', '=', org.org_id)
          .where('system_key', '=', key)
          .executeTakeFirstOrThrow()
      ).id;
    const post = async (day: string, salesCents: number, cogsCents: number) =>
      h.owner.transaction().execute(async (trx) => {
        const e = await trx
          .insertInto('journal_entries')
          .values({
            org_id: org.org_id,
            restaurant_id: driveId,
            business_date: day,
            entry_type: 'adjustment',
            source_type: 'test',
            source_id: randomUUID(),
            description: 'Fixture day',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('journal_lines')
          .values([
            {
              org_id: org.org_id,
              entry_id: e.id,
              account_id: await account('card_clearing'),
              debit_cents: salesCents,
              credit_cents: 0,
            },
            {
              org_id: org.org_id,
              entry_id: e.id,
              account_id: await account('sales_revenue'),
              debit_cents: 0,
              credit_cents: salesCents,
            },
            {
              org_id: org.org_id,
              entry_id: e.id,
              account_id: await account('cogs'),
              debit_cents: cogsCents,
              credit_cents: 0,
            },
            {
              org_id: org.org_id,
              entry_id: e.id,
              account_id: await account('card_clearing'), // not Inventory: no stock moved
              debit_cents: 0,
              credit_cents: cogsCents,
            },
          ])
          .execute();
      });
    await post(days[0]!, 1_000, 400);
    await post(days[1]!, 9_000, 900);
    const r = await report(days[0]!, days[1]!);
    expect(r.days.map((d) => d.actualFoodCostBps)).toEqual([4_000, 1_000]);
    // Summed: 1300 / 10000 = 13%. Averaging the days would say 25%.
    expect(r.totals).toMatchObject({
      netSalesCents: 10_000,
      cogsCents: 1_300,
      actualFoodCostBps: 1_300,
      grossProfitCents: 8_700,
      grossMarginBps: 8_700,
    });
  });

  it('validates the range, and needs reports.view at this restaurant', async () => {
    const base = `/v1/restaurants/${driveId}/reports/food-cost`;
    const today = await dayOffset(0);
    const get = (qs: string, token = manager) => h.http.get(`${base}?${qs}`).set(bearer(token));
    expect((await get(`from=${today}&to=${await dayOffset(1)}`)).status).toBe(400);
    expect((await get(`from=${await dayOffset(92)}&to=${today}`)).status).toBe(400);
    expect((await get(`from=${await dayOffset(91)}&to=${today}`)).status).toBe(200);
    expect((await get(`from=0000-01-01&to=0000-01-02`)).status).toBe(400);
    expect((await get(`from=${today}`)).status).toBe(400);
    expect((await get(`from=${today}&to=${today}`, crew)).status).toBe(403);
    const supervisor = await login(h, 'supervisor@drive.kitchos.test');
    expect((await get(`from=${today}&to=${today}`, supervisor)).status).toBe(403);
    const centralManager = await login(h, 'manager@central.kitchos.test');
    expect((await get(`from=${today}&to=${today}`, centralManager)).status).toBe(404); // out of scope reads as absent
    const rival = await login(h, 'manager@rival.test');
    expect((await get(`from=${today}&to=${today}`, rival)).status).toBe(404);
  });

  describe('recipe cost of sales (theoretical food cost)', () => {
    const tasksOf = async (orderId: string) =>
      (
        (await h.http.get(`/v1/restaurants/${driveId}/kitchen/tasks`).set(bearer(crew)).expect(200))
          .body as KitchenTaskView[]
      ).filter((t) => t.orderId === orderId);
    const handOver = async (o: { id: string }) => {
      for (const t of await tasksOf(o.id)) {
        await h.http
          .post(`/v1/restaurants/${driveId}/kitchen/tasks/${t.id}/complete`)
          .set(bearer(crew))
          .send({})
          .expect(200);
      }
      await h.http
        .post(`/v1/restaurants/${driveId}/orders/${o.id}/handoff`)
        .set(bearer(crew))
        .expect(200);
    };
    const consumedValue = async (orderId: string) => {
      const lines = await h.owner
        .selectFrom('order_lines')
        .select('id')
        .where('order_id', '=', orderId)
        .execute();
      return -(await movementValue(
        'order_line',
        lines.map((l) => l.id),
      ));
    };

    it('a sale adds exactly what its lines were consumed at, on the day it is handed over', async () => {
      await drain();
      const before = await todayRow();
      const menu = await getMenu(h, DRIVE);
      const o = await placeAndPay(h, DRIVE, [
        { menuItemId: item(menu, 'Cheeseburger').id, quantity: 2 },
      ]);
      await handOver(o);
      await drain();
      const after = await todayRow();
      expect(after.soldRecipeCents - before.soldRecipeCents).toBe(await consumedValue(o.id));
      expect(after.unsoldProductionCents).toBe(after.cogsCents - after.soldRecipeCents);
    });

    it('a refund by item takes back its exact share; a fully refunded line nets to zero', async () => {
      const menu = await getMenu(h, DRIVE);
      const o = await placeAndPay(h, DRIVE, [
        { menuItemId: item(menu, 'Cheeseburger').id, quantity: 3 },
      ]);
      await handOver(o);
      await drain();
      const value = await consumedValue(o.id);
      const line = await h.owner
        .selectFrom('order_lines')
        .select('id')
        .where('order_id', '=', o.id)
        .executeTakeFirstOrThrow();
      const supervisor = await login(h, 'supervisor@drive.kitchos.test');
      const before = await todayRow();
      for (let i = 0; i < 3; i++) {
        await h.http
          .post(`/v1/restaurants/${driveId}/orders/${o.id}/refunds`)
          .set(bearer(supervisor))
          .set('Idempotency-Key', randomUUID())
          .send({ reason: 'quality', items: [{ orderLineId: line.id, quantity: 1 }] })
          .expect(201);
      }
      await drain();
      const after = await todayRow();
      // Sold and fully refunded the same day: recipe cost of sales is back where it started.
      expect(after.soldRecipeCents - before.soldRecipeCents).toBe(-value);
    });

    it('food cooked for a cancelled order is unsold production, not recipe cost of sales', async () => {
      await drain();
      const before = await todayRow();
      const menu = await getMenu(h, DRIVE);
      const o = await placeAndPay(h, DRIVE, [
        { menuItemId: item(menu, 'Cheeseburger').id, quantity: 1 },
      ]);
      for (const t of await tasksOf(o.id)) {
        await h.http
          .post(`/v1/restaurants/${driveId}/kitchen/tasks/${t.id}/start`)
          .set(bearer(crew))
          .send({})
          .expect(200);
      }
      const line = await h.owner
        .selectFrom('order_lines')
        .select('id')
        .where('order_id', '=', o.id)
        .executeTakeFirstOrThrow();
      // Kept in COGS (not recorded as waste), so it shows as production that was never sold.
      await h.http
        .post(`/v1/restaurants/${driveId}/orders/${o.id}/cancel`)
        .set(bearer(manager))
        .send({ reason: 'Customer left', waste: [{ orderLineId: line.id, quantity: 0 }] })
        .expect(200);
      await drain();
      const after = await todayRow();
      const value = await consumedValue(o.id);
      expect(after.soldRecipeCents).toBe(before.soldRecipeCents);
      expect(after.unsoldProductionCents - before.unsoldProductionCents).toBe(value);
    });
  });
});
