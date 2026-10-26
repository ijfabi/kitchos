import { randomUUID } from 'node:crypto';
import type { KitchenTaskView, OrderView, WasteRecordView } from '@kitchos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  balance,
  bearer,
  getMenu,
  item,
  login,
  placeAndPay,
  reconciliationErrors,
  restaurantId,
  startHarness,
  type Harness,
} from './harness.ts';

const CENTRAL = 'kitchos-central';

describe('waste, goods receipts and physical counts', () => {
  let h: Harness;
  let centralId: string;
  let crew: string;
  let manager: string;
  const itemIds = new Map<string, string>();

  beforeAll(async () => {
    h = await startHarness();
    centralId = await restaurantId(h, CENTRAL);
    crew = await login(h, 'crew1@central.kitchos.test');
    manager = await login(h, 'manager@central.kitchos.test');
    const org = await h.owner
      .selectFrom('restaurants')
      .select('org_id')
      .where('id', '=', centralId)
      .executeTakeFirstOrThrow();
    for (const r of await h.owner
      .selectFrom('inventory_items')
      .select(['id', 'sku'])
      .where('org_id', '=', org.org_id)
      .execute()) {
      itemIds.set(r.sku, r.id);
    }
  });
  afterAll(() => h.close());

  const sku = (s: string) => itemIds.get(s)!;
  const waste = (token: string, body: object, key = randomUUID()) =>
    h.http
      .post(`/v1/restaurants/${centralId}/inventory/waste`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send(body);
  const movementsFor = (sourceType: string, sourceId: string) =>
    h.owner
      .selectFrom('stock_movements as m')
      .innerJoin('inventory_items as i', 'i.id', 'm.inventory_item_id')
      .select(['i.sku', 'm.movement_type', 'm.quantity_delta', 'm.source_key'])
      .where('m.source_type', '=', sourceType)
      .where('m.source_id', '=', sourceId)
      .execute();
  const taskFor = async (order: OrderView) => {
    const tasks = (await h.http.get(`/v1/restaurants/${centralId}/kitchen/tasks`).set(bearer(crew)))
      .body as KitchenTaskView[];
    return tasks.find((t) => t.orderId === order.id)!;
  };
  const producibleLineId = async (orderId: string) =>
    (
      await h.owner
        .selectFrom('order_lines')
        .select('id')
        .where('order_id', '=', orderId)
        .where('kind', '=', 'item')
        .executeTakeFirstOrThrow()
    ).id;

  it('raw ingredient spoilage deducts stock once and values it at standard cost', async () => {
    const before = await balance(h, CENTRAL, 'LETTUCE');
    const key = randomUUID();
    const res = await waste(
      crew,
      {
        kind: 'raw_ingredient',
        inventoryItemId: sku('LETTUCE'),
        quantity: '500',
        reason: 'spoiled',
      },
      key,
    );
    expect(res.status).toBe(201);
    const rec = res.body as WasteRecordView;
    expect(rec).toMatchObject({
      status: 'recorded',
      costCents: 400,
      kind: 'raw_ingredient',
      itemName: 'Shredded lettuce',
    });
    expect(rec.lines).toEqual([
      expect.objectContaining({ sku: 'LETTUCE', treatment: 'deducted_now', costCents: 400 }),
    ]);
    expect((await balance(h, CENTRAL, 'LETTUCE')).onHand).toBe(before.onHand - 500);

    // Replaying the request (same Idempotency-Key) neither duplicates the record nor the deduction.
    const replay = await waste(
      crew,
      {
        kind: 'raw_ingredient',
        inventoryItemId: sku('LETTUCE'),
        quantity: '500',
        reason: 'spoiled',
      },
      key,
    );
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(rec.id);
    expect((await balance(h, CENTRAL, 'LETTUCE')).onHand).toBe(before.onHand - 500);
    expect(await movementsFor('waste_record', rec.id)).toEqual([
      { sku: 'LETTUCE', movement_type: 'waste_raw', quantity_delta: '-500.000', source_key: '' },
    ]);
  });

  it('already-prepared food waste is classified without a second deduction (invariant 12)', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Cheeseburger').id, quantity: 1 },
    ]);
    await h.http
      .post(`/v1/restaurants/${centralId}/kitchen/tasks/${(await taskFor(order)).id}/start`)
      .set(bearer(crew))
      .send({})
      .expect(200);
    const pattyAfterCooking = await balance(h, CENTRAL, 'PATTY-BEEF');
    const lineId = await producibleLineId(order.id);

    const res = await waste(crew, {
      kind: 'prepared_item',
      orderLineId: lineId,
      quantity: 1,
      reason: 'dropped',
    });
    expect(res.status).toBe(201);
    const rec = res.body as WasteRecordView;
    expect(rec.lines).toHaveLength(7);
    expect(rec.lines.every((l) => l.treatment === 'already_consumed')).toBe(true);
    expect(rec.costCents).toBe(204); // 45 + 110 + 18 + 2 + 7 + 18 + 4 at standard cost
    expect(await movementsFor('waste_record', rec.id)).toHaveLength(0);
    expect(await balance(h, CENTRAL, 'PATTY-BEEF')).toEqual(pattyAfterCooking);
  });

  it('a remake consumes exactly one fresh portion, and replays do not repeat it', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Cheeseburger').id, quantity: 2 },
    ]);
    await h.http
      .post(`/v1/restaurants/${centralId}/kitchen/tasks/${(await taskFor(order)).id}/start`)
      .set(bearer(crew))
      .send({})
      .expect(200);
    const before = await balance(h, CENTRAL, 'PATTY-BEEF');
    const lineId = await producibleLineId(order.id);
    const key = randomUUID();
    const body = {
      kind: 'prepared_item',
      orderLineId: lineId,
      quantity: 1,
      reason: 'burnt',
      remake: true,
    };

    const res = await waste(crew, body, key);
    expect(res.status).toBe(201);
    await waste(crew, body, key).expect(201);
    expect((await balance(h, CENTRAL, 'PATTY-BEEF')).onHand).toBe(before.onHand - 1);
    const remake = await movementsFor('order_line', lineId);
    expect(remake.filter((m) => m.source_key === `remake:${res.body.id}`)).toHaveLength(7);
    expect(remake.filter((m) => m.source_key === '')).toHaveLength(7); // original 2-burger consumption untouched

    const tooMany = await waste(crew, {
      kind: 'prepared_item',
      orderLineId: lineId,
      quantity: 3,
      reason: 'burnt',
    });
    expect(tooMany.status).toBe(422);
  });

  it('waste of food not yet consumed deducts it now; later completion consumes the replacement', async () => {
    const before = await balance(h, CENTRAL, 'FRIES-FROZEN');
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Medium Fries').id, quantity: 1 },
    ]);
    const lineId = await producibleLineId(order.id);
    const res = await waste(crew, {
      kind: 'prepared_item',
      orderLineId: lineId,
      quantity: 1,
      reason: 'spilled',
      remake: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.lines.every((l: { treatment: string }) => l.treatment === 'deducted_now')).toBe(
      true,
    );
    expect(await movementsFor('waste_record', res.body.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sku: 'FRIES-FROZEN',
          movement_type: 'waste_prepared',
          quantity_delta: '-115.000',
        }),
      ]),
    );
    await h.http
      .post(`/v1/restaurants/${centralId}/kitchen/tasks/${(await taskFor(order)).id}/complete`)
      .set(bearer(crew))
      .send({})
      .expect(200);
    // Two physical portions: the spilled one (waste) and the one served (consumption).
    expect((await balance(h, CENTRAL, 'FRIES-FROZEN')).onHand).toBe(before.onHand - 230);
    expect(await reconciliationErrors(h)).toEqual([]);
  });

  it('overproduction waste uses the recipe pinned on the current menu; combos must be split', async () => {
    const menu = await getMenu(h, CENTRAL);
    const before = await balance(h, CENTRAL, 'FRIES-FROZEN');
    const res = await waste(crew, {
      kind: 'prepared_item',
      menuItemId: item(menu, 'Medium Fries').id,
      quantity: 3,
      reason: 'overproduction',
    });
    expect(res.status).toBe(201);
    expect((await balance(h, CENTRAL, 'FRIES-FROZEN')).onHand).toBe(before.onHand - 345);
    const combo = await waste(crew, {
      kind: 'prepared_item',
      menuItemId: item(menu, 'Cheeseburger Meal').id,
      quantity: 1,
      reason: 'overproduction',
    });
    expect(combo.status).toBe(422);
    expect(combo.body.error.code).toBe('WASTE_COMBO_NOT_ALLOWED');
  });

  it('waste above the threshold needs a different manager to approve; rejection reverses stock', async () => {
    const before = await balance(h, CENTRAL, 'PATTY-BEEF');
    const big = await waste(manager, {
      kind: 'raw_ingredient',
      inventoryItemId: sku('PATTY-BEEF'),
      quantity: '50',
      reason: 'temperature_breach',
    });
    expect(big.status).toBe(201);
    expect(big.body).toMatchObject({ status: 'pending_approval', costCents: 5500 });
    expect((await balance(h, CENTRAL, 'PATTY-BEEF')).onHand).toBe(before.onHand - 50); // physical loss recorded immediately

    const approve = (token: string, id: string) =>
      h.http
        .post(`/v1/restaurants/${centralId}/inventory/waste/${id}/approve`)
        .set(bearer(token))
        .send({ reason: 'Fridge failure confirmed' });
    expect((await approve(crew, big.body.id)).status).toBe(403); // crew lacks waste.approve
    expect((await approve(manager, big.body.id)).status).toBe(403); // cannot approve own record
    const inventoryController = await login(h, 'inventory@kitchos.test');
    const ok = await approve(inventoryController, big.body.id);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', reviewedBy: 'Ruth Adeyemi' });
    expect((await approve(inventoryController, big.body.id)).status).toBe(409);

    // A mistaken entry by crew is rejected: stock comes back via a correction movement.
    const mistaken = await waste(crew, {
      kind: 'raw_ingredient',
      inventoryItemId: sku('BUN-REG'),
      quantity: '60',
      reason: 'other',
    });
    const bunsAfterMistake = await balance(h, CENTRAL, 'BUN-REG');
    const rejected = await h.http
      .post(`/v1/restaurants/${centralId}/inventory/waste/${mistaken.body.id}/reject`)
      .set(bearer(manager))
      .send({ reason: 'Entered 60 instead of 6' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');
    expect((await balance(h, CENTRAL, 'BUN-REG')).onHand).toBe(bunsAfterMistake.onHand + 60);
    expect(await movementsFor('waste_reversal', mistaken.body.id)).toEqual([
      expect.objectContaining({
        sku: 'BUN-REG',
        movement_type: 'correction',
        quantity_delta: '60.000',
      }),
    ]);
    const audits = await h.owner
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', mistaken.body.id)
      .execute();
    expect(audits.map((a) => a.action).sort()).toEqual(['waste.record', 'waste.reject']);
    expect(await reconciliationErrors(h)).toEqual([]);
  });

  it('waste summary separates reclassified cost from direct deductions and excludes rejected records', async () => {
    const list = await h.http
      .get(`/v1/restaurants/${centralId}/inventory/waste?limit=200`)
      .set(bearer(manager))
      .expect(200);
    const records = list.body as WasteRecordView[];
    const date = records[0]!.businessDate;
    const summary = await h.http
      .get(`/v1/restaurants/${centralId}/inventory/waste/summary?from=${date}&to=${date}`)
      .set(bearer(manager))
      .expect(200);
    const counted = records.filter((r) => r.status !== 'rejected' && r.businessDate === date);
    expect(summary.body.totalCostCents).toBe(counted.reduce((s, r) => s + r.costCents, 0));
    expect(summary.body.reclassifiedFromConsumptionCents + summary.body.deductedDirectlyCents).toBe(
      summary.body.totalCostCents,
    );
    expect(summary.body.reclassifiedFromConsumptionCents).toBeGreaterThanOrEqual(204);
    expect(summary.body.byReason.map((r: { reason: string }) => r.reason)).toEqual(
      expect.arrayContaining(['dropped', 'spoiled']),
    );
    expect(summary.body.byReason.map((r: { reason: string }) => r.reason)).not.toContain('other'); // only the rejected record had it
    expect(
      (
        await h.http
          .get(`/v1/restaurants/${centralId}/inventory/waste/summary?from=${date}&to=${date}`)
          .set(bearer(crew))
      ).status,
    ).toBe(403);
  });

  it('goods receipts add stock idempotently and require inventory permissions', async () => {
    const before = await balance(h, CENTRAL, 'BUN-REG');
    const body = {
      supplierName: 'Harbour Bakery (synthetic)',
      reference: 'INV-1042',
      lines: [
        {
          inventoryItemId: sku('BUN-REG'),
          quantity: '96',
          unitCost: '44.5',
          lotCode: 'L2026-10-26',
          expiresOn: '2026-11-02',
        },
        { inventoryItemId: sku('LETTUCE'), quantity: '2000.5' },
      ],
    };
    const key = randomUUID();
    const post = (token: string) =>
      h.http
        .post(`/v1/restaurants/${centralId}/inventory/receipts`)
        .set(bearer(token))
        .set('Idempotency-Key', key)
        .send(body);
    expect((await post(crew)).status).toBe(403);
    const res = await post(manager);
    expect(res.status).toBe(201);
    expect(res.body.lines).toEqual(
      expect.arrayContaining([{ sku: 'LETTUCE', name: 'Shredded lettuce', quantity: '2000.500' }]),
    );
    await post(manager).expect(201);
    expect((await balance(h, CENTRAL, 'BUN-REG')).onHand).toBe(before.onHand + 96);
  });

  it('physical counts post the variance against locked on-hand and keep an expected/counted record', async () => {
    const before = await balance(h, CENTRAL, 'BUN-REG');
    const counted = before.onHand - 3;
    const inv = await login(h, 'inventory@kitchos.test');
    const res = await h.http
      .post(`/v1/restaurants/${centralId}/inventory/counts`)
      .set(bearer(inv))
      .set('Idempotency-Key', randomUUID())
      .send({ lines: [{ inventoryItemId: sku('BUN-REG'), counted: String(counted) }] });
    expect(res.status).toBe(201);
    expect(res.body.lines[0]).toMatchObject({
      sku: 'BUN-REG',
      variance: '-3.000',
      varianceCents: -135,
    });
    expect(res.body.approvedBy).toBeNull(); // under the threshold
    expect((await balance(h, CENTRAL, 'BUN-REG')).onHand).toBe(counted);

    const big = await h.http
      .post(`/v1/restaurants/${centralId}/inventory/counts`)
      .set(bearer(manager))
      .set('Idempotency-Key', randomUUID())
      .send({ lines: [{ inventoryItemId: sku('COFFEE-BEANS'), counted: '0' }] });
    expect(big.status).toBe(201);
    expect(big.body.approvedBy).toBe('Priya Natarajan');
    expect((await balance(h, CENTRAL, 'COFFEE-BEANS')).onHand).toBe(0);

    const supervisor = await login(h, 'supervisor@central.kitchos.test');
    const denied = await h.http
      .post(`/v1/restaurants/${centralId}/inventory/counts`)
      .set(bearer(supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({ lines: [{ inventoryItemId: sku('COFFEE-BEANS'), counted: '10' }] });
    expect(denied.status).toBe(403);
    expect(await reconciliationErrors(h)).toEqual([]);
  });

  it('rejects malformed waste requests at the boundary', async () => {
    expect(
      (
        await waste(crew, {
          kind: 'raw_ingredient',
          inventoryItemId: sku('LETTUCE'),
          quantity: '0',
          reason: 'spoiled',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await waste(crew, {
          kind: 'raw_ingredient',
          inventoryItemId: sku('LETTUCE'),
          quantity: '1.2345',
          reason: 'spoiled',
        })
      ).status,
    ).toBe(400);
    expect(
      (await waste(crew, { kind: 'prepared_item', quantity: 1, reason: 'dropped' })).status,
    ).toBe(400);
    expect(
      (
        await waste(crew, {
          kind: 'raw_ingredient',
          inventoryItemId: sku('LETTUCE'),
          quantity: '1',
          reason: 'stolen',
        })
      ).status,
    ).toBe(400);
    const auditor = await login(h, 'auditor@kitchos.test');
    expect(
      (
        await waste(auditor, {
          kind: 'raw_ingredient',
          inventoryItemId: sku('LETTUCE'),
          quantity: '1',
          reason: 'spoiled',
        })
      ).status,
    ).toBe(403);
  });
});
