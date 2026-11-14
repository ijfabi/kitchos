import { randomUUID } from 'node:crypto';
import type { StockTransferView } from '@kitchos/contracts';
import { createDb, type Database } from '@kitchos/database';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import { bearer, login, restaurantId, startHarness, type Harness } from './harness.ts';

describe('stock transfers between restaurants (ADR-0019)', () => {
  let h: Harness;
  let appDb: Database;
  let dispatcher: EventDispatcher;
  let orgId: string;
  let central: string;
  let express: string;
  let drive: string;
  let rival: string;
  let centralManager: string;
  let expressManager: string;
  let centralSupervisor: string;
  let crew: string;
  // Items of this file only, so balances are exact whatever other files do.
  let each: string; // 125 cents each
  let grams: string; // a third of a cent per gram: rounding matters

  beforeAll(async () => {
    h = await startHarness();
    appDb = createDb({ connectionString: inject('appUrl'), max: 2 }).db;
    dispatcher = h.app.get(EventDispatcher);
    central = await restaurantId(h, 'kitchos-central');
    express = await restaurantId(h, 'kitchos-express');
    drive = await restaurantId(h, 'kitchos-drive');
    rival = await restaurantId(h, 'rival-southbank');
    orgId = (
      await h.owner
        .selectFrom('restaurants')
        .select('org_id')
        .where('id', '=', central)
        .executeTakeFirstOrThrow()
    ).org_id;
    centralManager = await login(h, 'manager@central.kitchos.test');
    expressManager = await login(h, 'manager@express.kitchos.test');
    centralSupervisor = await login(h, 'supervisor@central.kitchos.test');
    crew = await login(h, 'crew1@central.kitchos.test');
    const suffix = randomUUID().slice(0, 8);
    const inv = async (sku: string, unit: string, cost: string) =>
      (
        await h.owner
          .insertInto('inventory_items')
          .values({
            org_id: orgId,
            sku: `${sku}-${suffix}`,
            name: `Transfer ${sku} ${suffix}`,
            base_unit: unit,
            category: 'ingredient',
            standard_unit_cost: cost,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    each = await inv('EACH', 'each', '125');
    grams = await inv('GRAMS', 'g', '0.333333');
    // Real stock at Central, received through the API (and so valued and posted).
    await h.http
      .post(`/v1/restaurants/${central}/inventory/receipts`)
      .set(bearer(centralManager))
      .set('Idempotency-Key', randomUUID())
      .send({
        lines: [
          { inventoryItemId: each, quantity: '40' },
          { inventoryItemId: grams, quantity: '5000' },
        ],
      })
      .expect(201);
    await dispatcher.runOnce();
  });
  afterAll(async () => {
    await appDb.destroy();
    await h.close();
  });

  const onHand = async (restaurant: string, item: string) => {
    const r = await h.owner
      .selectFrom('stock_balances as b')
      .innerJoin('stock_locations as l', 'l.id', 'b.location_id')
      .select('b.on_hand')
      .where('l.restaurant_id', '=', restaurant)
      .where('l.is_default', '=', true)
      .where('b.inventory_item_id', '=', item)
      .executeTakeFirst();
    return Number(r?.on_hand ?? 0);
  };
  const send = (token: string, from: string, body: object, key = randomUUID()) =>
    h.http
      .post(`/v1/restaurants/${from}/inventory/transfers`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send(body);
  const receive = (token: string, at: string, id: string, body: object, key = randomUUID()) =>
    h.http
      .post(`/v1/restaurants/${at}/inventory/transfers/${id}/receive`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send(body);
  /** Net debit per system account of the entry for (transfer, type), with its restaurant and day. */
  const entry = async (sourceId: string, entryType: string) => {
    const e = await h.owner
      .selectFrom('journal_entries')
      .select(['id', 'restaurant_id', sql<string>`business_date::text`.as('day')])
      .where('source_type', '=', 'stock_transfer')
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
    return {
      restaurantId: e.restaurant_id,
      day: e.day,
      net: Object.fromEntries(
        lines.map((l) => [l.system_key!, Number(l.debit_cents) - Number(l.credit_cents)]),
      ),
    };
  };
  const movementValue = async (id: string, type: string) =>
    Number(
      (
        await h.owner
          .selectFrom('stock_movements')
          .select(sql<string>`coalesce(sum(value_cents), 0)`.as('v'))
          .where('source_type', '=', 'stock_transfer')
          .where('source_id', '=', id)
          .where('movement_type', '=', type)
          .executeTakeFirstOrThrow()
      ).v,
    );
  const inventoryReconciles = async (restaurant: string, token: string, day: string) => {
    const r = await h.http
      .get(`/v1/restaurants/${restaurant}/accounting/reconciliation?businessDate=${day}`)
      .set(bearer(token))
      .expect(200);
    return r.body.stockMovementsValueCents === r.body.journalInventoryCents;
  };

  it('lists the other restaurants of the organisation as destinations', async () => {
    const res = await h.http
      .get(`/v1/restaurants/${central}/inventory/transfer-destinations`)
      .set(bearer(centralManager))
      .expect(200);
    const ids = (res.body as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([express, drive]));
    expect(ids).not.toContain(central);
    expect(ids).not.toContain(rival);
  });

  it('dispatch moves stock out of the sender and its value into transit; receipt clears it', async () => {
    const before = {
      cEach: await onHand(central, each),
      cGrams: await onHand(central, grams),
      xEach: await onHand(express, each),
      xGrams: await onHand(express, grams),
    };
    const sent = await send(centralManager, central, {
      toRestaurantId: express,
      notes: 'Express ran short of buns',
      lines: [
        { inventoryItemId: each, quantity: '10' },
        { inventoryItemId: grams, quantity: '1000' },
      ],
    });
    expect(sent.status).toBe(201);
    const t = sent.body as StockTransferView;
    expect(t).toMatchObject({
      status: 'in_transit',
      from: { id: central },
      to: { id: express },
      notes: 'Express ran short of buns',
      receivedCents: null,
      shortageCents: null,
    });
    // 10 × 125 + round(1000 × 0.333333 = 333.333) = 1250 + 333.
    expect(t.sentCents).toBe(1583);
    expect(await onHand(central, each)).toBe(before.cEach - 10);
    expect(await onHand(central, grams)).toBe(before.cGrams - 1000);
    expect(await onHand(express, each)).toBe(before.xEach); // still on the road

    await dispatcher.runOnce();
    const out = await entry(t.id, 'transfer_out');
    expect(out).toMatchObject({
      restaurantId: central,
      day: t.dispatchBusinessDate,
      net: { inventory: -1583, stock_in_transit: 1583 },
    });

    // The standard cost changes while the goods are on the road: arrival is still
    // valued at what left, so transit clears exactly.
    await h.owner
      .updateTable('inventory_items')
      .set({ standard_unit_cost: '999' })
      .where('id', '=', each)
      .execute();
    const incoming = await h.http
      .get(`/v1/restaurants/${express}/inventory/transfers?direction=incoming&status=in_transit`)
      .set(bearer(expressManager))
      .expect(200);
    expect((incoming.body as StockTransferView[]).map((x) => x.id)).toContain(t.id);

    const got = await receive(expressManager, express, t.id, {
      notes: 'Two buns crushed',
      lines: [
        { inventoryItemId: each, quantityReceived: '8' },
        { inventoryItemId: grams, quantityReceived: '1000' },
      ],
    })
      .then((res) => res)
      .finally(() =>
        // Other tests (in any order) value this item at 125.
        h.owner
          .updateTable('inventory_items')
          .set({ standard_unit_cost: '125' })
          .where('id', '=', each)
          .execute(),
      );
    expect(got.status).toBe(200);
    const r = got.body as StockTransferView;
    // 8 × 125 + 333 arrived; 2 × 125 short.
    expect(r).toMatchObject({
      status: 'received',
      receiveNotes: 'Two buns crushed',
      sentCents: 1583,
      receivedCents: 1333,
      shortageCents: 250,
    });
    expect(r.lines.find((l) => l.inventoryItemId === each)).toMatchObject({
      quantitySent: '10.000',
      quantityReceived: '8.000',
    });
    expect(await onHand(express, each)).toBe(before.xEach + 8);
    expect(await onHand(express, grams)).toBe(before.xGrams + 1000);
    expect(await movementValue(t.id, 'transfer_in')).toBe(1333);

    await dispatcher.runOnce();
    const inn = await entry(t.id, 'transfer_in');
    expect(inn).toMatchObject({
      restaurantId: express,
      day: r.receiveBusinessDate,
      net: { inventory: 1333, transfer_shortage: 250, stock_in_transit: -1583 },
    });
    // Across both restaurants the transfer leaves nothing in transit.
    expect(out!.net.stock_in_transit! + inn!.net.stock_in_transit!).toBe(0);
    // Both restaurants' inventory accounts still reconcile to their stock ledgers.
    expect(await inventoryReconciles(central, centralManager, t.dispatchBusinessDate)).toBe(true);
    expect(await inventoryReconciles(express, expressManager, r.receiveBusinessDate!)).toBe(true);

    // The sender sees the outcome too; a restaurant on neither side does not.
    const seen = await h.http
      .get(`/v1/restaurants/${central}/inventory/transfers/${t.id}`)
      .set(bearer(centralManager))
      .expect(200);
    expect(seen.body.shortageCents).toBe(250);
    const driveManager = await login(h, 'manager@drive.kitchos.test');
    expect(
      (
        await h.http
          .get(`/v1/restaurants/${drive}/inventory/transfers/${t.id}`)
          .set(bearer(driveManager))
      ).status,
    ).toBe(404);
  });

  it('a transfer is received exactly once, for every line and no more than was sent', async () => {
    const t = (
      await send(centralManager, central, {
        toRestaurantId: express,
        lines: [
          { inventoryItemId: each, quantity: '3' },
          { inventoryItemId: grams, quantity: '10.5' },
        ],
      }).expect(201)
    ).body as StockTransferView;
    const all = [
      { inventoryItemId: each, quantityReceived: '3' },
      { inventoryItemId: grams, quantityReceived: '0' },
    ];
    // Only the receiving restaurant receives.
    expect((await receive(centralManager, central, t.id, { lines: all })).status).toBe(404);
    const missing = await receive(expressManager, express, t.id, { lines: [all[0]] });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('TRANSFER_LINES_MISMATCH');
    const extra = await receive(expressManager, express, t.id, {
      lines: [...all, { inventoryItemId: randomUUID(), quantityReceived: '1' }],
    });
    expect(extra.body.error.code).toBe('TRANSFER_LINES_MISMATCH');
    const over = await receive(expressManager, express, t.id, {
      lines: [all[0], { inventoryItemId: grams, quantityReceived: '10.501' }],
    });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('RECEIVED_EXCEEDS_SENT');
    expect(
      (
        await h.owner
          .selectFrom('stock_transfers')
          .select('status')
          .where('id', '=', t.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('in_transit');

    const before = await onHand(express, grams);
    const key = randomUUID();
    const first = await receive(expressManager, express, t.id, { lines: all }, key);
    expect(first.status).toBe(200);
    expect(first.body.shortageCents).toBe(Math.round(10.5 * 0.333333)); // nothing of it arrived
    expect(await onHand(express, grams)).toBe(before); // a zero line moves no stock
    const replay = await receive(expressManager, express, t.id, { lines: all }, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const again = await receive(expressManager, express, t.id, { lines: all });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('TRANSFER_ALREADY_RECEIVED');
    const moved = await h.owner
      .selectFrom('stock_movements')
      .select(sql<string>`count(*)`.as('n'))
      .where('source_id', '=', t.id)
      .where('movement_type', '=', 'transfer_in')
      .executeTakeFirstOrThrow();
    expect(Number(moved.n)).toBe(1);

    await dispatcher.runOnce();
    const inn = await entry(t.id, 'transfer_in');
    expect(inn!.net).toEqual({
      inventory: 375, // 3 × 125, at the cost it left with
      transfer_shortage: 3,
      stock_in_transit: -378,
    });
  });

  it('racing receipts with different keys: one wins, the other is refused', async () => {
    const t = (
      await send(centralManager, central, {
        toRestaurantId: express,
        lines: [{ inventoryItemId: each, quantity: '2' }],
      }).expect(201)
    ).body as StockTransferView;
    const before = await onHand(express, each);
    const body = { lines: [{ inventoryItemId: each, quantityReceived: '2' }] };
    const results = await Promise.all([
      receive(expressManager, express, t.id, body).then((r) => r),
      receive(expressManager, express, t.id, body).then((r) => r),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await onHand(express, each)).toBe(before + 2);
  });

  it('the block policy refuses sending more than is available; nothing is recorded', async () => {
    const available = await onHand(central, each);
    const before = await h.owner
      .selectFrom('stock_transfers')
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    const res = await send(centralManager, central, {
      toRestaurantId: express,
      lines: [{ inventoryItemId: each, quantity: String(available + 1) }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await onHand(central, each)).toBe(available);
    const after = await h.owner
      .selectFrom('stock_transfers')
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
    // Express allows negative stock, so it may send what its books do not show.
    const x = await onHand(express, grams);
    const neg = await send(expressManager, express, {
      toRestaurantId: central,
      lines: [{ inventoryItemId: grams, quantity: String(x + 50) }],
    });
    expect(neg.status).toBe(201);
    expect(await onHand(express, grams)).toBe(-50);
  });

  it('refuses unknown, foreign and own destinations, and checks permissions', async () => {
    const lines = [{ inventoryItemId: each, quantity: '1' }];
    const self = await send(centralManager, central, { toRestaurantId: central, lines });
    expect(self.status).toBe(422);
    expect(self.body.error.code).toBe('TRANSFER_TO_SELF');
    expect((await send(centralManager, central, { toRestaurantId: rival, lines })).status).toBe(
      404,
    );
    expect(
      (await send(centralManager, central, { toRestaurantId: randomUUID(), lines })).status,
    ).toBe(404);
    expect(
      (
        await send(centralManager, central, {
          toRestaurantId: express,
          lines: [{ inventoryItemId: randomUUID(), quantity: '1' }],
        })
      ).status,
    ).toBe(404);
    // Another tenant's item.
    const rivalItem = await h.owner
      .selectFrom('inventory_items as i')
      .innerJoin('restaurants as r', 'r.org_id', 'i.org_id')
      .select('i.id')
      .where('r.id', '=', rival)
      .executeTakeFirstOrThrow();
    expect(
      (
        await send(centralManager, central, {
          toRestaurantId: express,
          lines: [{ inventoryItemId: rivalItem.id, quantity: '1' }],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send(centralManager, central, {
          toRestaurantId: express,
          lines: [...lines, ...lines],
        })
      ).status,
    ).toBe(400);
    expect(
      (await send(centralSupervisor, central, { toRestaurantId: express, lines })).status,
    ).toBe(403);
    expect((await send(crew, central, { toRestaurantId: express, lines })).status).toBe(403);
    // A manager of Express has no access to Central at all.
    expect((await send(expressManager, central, { toRestaurantId: express, lines })).status).toBe(
      404,
    );
    expect(
      (
        await h.http
          .get(`/v1/restaurants/${central}/inventory/transfers?direction=outgoing`)
          .set(bearer(centralSupervisor))
      ).status,
    ).toBe(403);
  });

  it('the runtime role cannot rewrite or delete a transfer, or receive one twice', async () => {
    const t = (
      await send(centralManager, central, {
        toRestaurantId: express,
        lines: [{ inventoryItemId: each, quantity: '1' }],
      }).expect(201)
    ).body as StockTransferView;
    const asApp = (q: ReturnType<typeof sql>) =>
      appDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.org_id', ${orgId}, true)`.execute(tx);
        return q.execute(tx);
      });
    await expect(
      asApp(
        sql`update stock_transfers set to_restaurant_id = ${drive}::uuid where id = ${t.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(
        sql`update stock_transfer_lines set quantity_sent = 99 where stock_transfer_id = ${t.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(asApp(sql`delete from stock_transfers where id = ${t.id}::uuid`)).rejects.toThrow(
      /permission denied|never deleted/,
    );
    await receive(expressManager, express, t.id, {
      lines: [{ inventoryItemId: each, quantityReceived: '1' }],
    }).expect(200);
    await expect(
      asApp(
        sql`update stock_transfer_lines set quantity_received = 0 where stock_transfer_id = ${t.id}::uuid`,
      ),
    ).rejects.toThrow(/already received/);
    await expect(
      asApp(sql`update stock_transfers set receive_notes = 'x' where id = ${t.id}::uuid`),
    ).rejects.toThrow(/already received/);
    // Even the owner cannot delete one.
    await expect(
      h.owner.deleteFrom('stock_transfers').where('id', '=', t.id).execute(),
    ).rejects.toThrow(/never deleted/);
    // A transfer_in for an item that was never dispatched cannot be valued.
    await expect(
      h.owner.transaction().execute(async (trx) => {
        const loc = await trx
          .selectFrom('stock_locations')
          .select('id')
          .where('restaurant_id', '=', express)
          .where('is_default', '=', true)
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('stock_movements')
          .values({
            org_id: orgId,
            restaurant_id: express,
            location_id: loc.id,
            inventory_item_id: grams,
            movement_type: 'transfer_in',
            quantity_delta: '1',
            source_type: 'stock_transfer',
            source_id: t.id,
            occurred_at: sql<Date>`now()`,
            business_date: sql<string>`current_date`,
          })
          .execute();
      }),
    ).rejects.toThrow(/no valued dispatch/);
  });

  it('the database keeps a receipt whole: every line recorded, none after receipt', async () => {
    const t = (
      await send(centralManager, central, {
        toRestaurantId: express,
        lines: [
          { inventoryItemId: each, quantity: '1' },
          { inventoryItemId: grams, quantity: '1' },
        ],
      }).expect(201)
    ).body as StockTransferView;
    const asApp = (q: ReturnType<typeof sql>) =>
      appDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.org_id', ${orgId}, true)`.execute(tx);
        return q.execute(tx);
      });
    // Received with one line still unrecorded.
    await expect(
      appDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.org_id', ${orgId}, true)`.execute(tx);
        await sql`update stock_transfer_lines set quantity_received = 1
                   where stock_transfer_id = ${t.id}::uuid and inventory_item_id = ${each}::uuid`.execute(
          tx,
        );
        await sql`update stock_transfers set status = 'received', received_by = dispatched_by,
                   received_at = now(), receive_business_date = current_date, version = version + 1
                   where id = ${t.id}::uuid`.execute(tx);
      }),
    ).rejects.toThrow(/nothing recorded as arrived/);
    // A line recorded after its transfer was received (the transfer guard switched
    // off to reach that state; the whole transaction is rolled back).
    await expect(
      h.owner.transaction().execute(async (trx) => {
        await sql`alter table stock_transfers disable trigger stock_transfers_guard`.execute(trx);
        await sql`update stock_transfers set status = 'received', received_by = dispatched_by,
                   received_at = now(), receive_business_date = current_date
                   where id = ${t.id}::uuid`.execute(trx);
        await sql`alter table stock_transfers enable trigger stock_transfers_guard`.execute(trx);
        await sql`update stock_transfer_lines set quantity_received = 1
                   where stock_transfer_id = ${t.id}::uuid`.execute(trx);
      }),
    ).rejects.toThrow(/stock transfer \S+ is already received/);
    // Nothing above stuck; the transfer is still receivable through the API.
    await expect(
      asApp(sql`select 1 from stock_transfer_lines where stock_transfer_id = ${t.id}::uuid
                 and quantity_received is not null`),
    ).resolves.toMatchObject({ rows: [] });
    await receive(expressManager, express, t.id, {
      lines: [
        { inventoryItemId: each, quantityReceived: '1' },
        { inventoryItemId: grams, quantityReceived: '1' },
      ],
    }).expect(200);
  });
});
