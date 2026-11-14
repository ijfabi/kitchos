import { randomUUID } from 'node:crypto';
import type { StockTransferView } from '@kitchos/contracts';
import { createDb, withTenant, type Database } from '@kitchos/database';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { LedgerConsumer } from '../src/accounting/ledger.consumer.ts';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import { bearer, login, restaurantId, startHarness, type Harness } from './harness.ts';

/**
 * Adversarial tests for stock transfers (ADR-0019): races, idempotency abuse, malformed and
 * extreme quantities, cross-tenant and role probing, and journal integrity under redelivery,
 * rounding and cost changes. Every item here is created by this file, so balances are exact.
 */
describe('stock transfers: adversarial', () => {
  let h: Harness;
  let appDb: Database;
  let dispatcher: EventDispatcher;
  let orgId: string;
  let central: string; // block
  let express: string; // allow_negative
  let drive: string; // block
  let rival: string;
  let centralManager: string;
  let expressManager: string;
  let driveManager: string;
  let rivalManager: string;
  let areaManager: string;
  let auditor: string;
  let inventoryController: string;
  let admin: string;
  const suffix = randomUUID().slice(0, 8);

  const newItem = async (sku: string, cost: string, unit = 'each') =>
    (
      await h.owner
        .insertInto('inventory_items')
        .values({
          org_id: orgId,
          sku: `ADV-${sku}-${suffix}`,
          name: `Adversarial ${sku} ${suffix}`,
          base_unit: unit,
          category: 'ingredient',
          standard_unit_cost: cost,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

  const stockCentral = async (lines: { inventoryItemId: string; quantity: string }[]) => {
    await h.http
      .post(`/v1/restaurants/${central}/inventory/receipts`)
      .set(bearer(centralManager))
      .set('Idempotency-Key', randomUUID())
      .send({ lines })
      .expect(201);
  };

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
    driveManager = await login(h, 'manager@drive.kitchos.test');
    rivalManager = await login(h, 'manager@rival.test');
    areaManager = await login(h, 'area.cbd@kitchos.test');
    auditor = await login(h, 'auditor@kitchos.test');
    inventoryController = await login(h, 'inventory@kitchos.test');
    admin = await login(h, 'admin@kitchos.test');
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
  const transfersWithNotes = async (notes: string) =>
    Number(
      (
        await h.owner
          .selectFrom('stock_transfers')
          .select(sql<string>`count(*)`.as('n'))
          .where('notes', '=', notes)
          .executeTakeFirstOrThrow()
      ).n,
    );
  const entries = async (sourceId: string) =>
    h.owner
      .selectFrom('journal_entries')
      .select(['id', 'entry_type', 'restaurant_id', sql<string>`business_date::text`.as('day')])
      .where('source_type', '=', 'stock_transfer')
      .where('source_id', '=', sourceId)
      .execute();
  const entryNet = async (sourceId: string, entryType: string) => {
    const e = (await entries(sourceId)).filter((x) => x.entry_type === entryType);
    if (e.length === 0) return null;
    expect(e).toHaveLength(1);
    const lines = await h.owner
      .selectFrom('journal_lines as l')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['a.system_key', 'l.debit_cents', 'l.credit_cents'])
      .where('l.entry_id', '=', e[0]!.id)
      .execute();
    const net: Record<string, number> = {};
    for (const l of lines)
      net[l.system_key!] =
        (net[l.system_key!] ?? 0) + Number(l.debit_cents) - Number(l.credit_cents);
    return { restaurantId: e[0]!.restaurant_id, day: e[0]!.day, net, lines: lines.length };
  };
  const reconciliation = async (restaurant: string, token: string, day: string) => {
    const r = await h.http
      .get(`/v1/restaurants/${restaurant}/accounting/reconciliation?businessDate=${day}`)
      .set(bearer(token))
      .expect(200);
    return r.body as { stockMovementsValueCents: number; journalInventoryCents: number };
  };
  /** Asserts the transfer's journal clears transit and matches its view exactly. */
  const assertJournalClears = async (t: StockTransferView) => {
    const out = await entryNet(t.id, 'transfer_out');
    const inn = await entryNet(t.id, 'transfer_in');
    if (t.sentCents === 0) {
      expect(out).toBeNull();
    } else {
      expect(out).toMatchObject({
        restaurantId: t.from.id,
        day: t.dispatchBusinessDate,
        net: { inventory: -t.sentCents, stock_in_transit: t.sentCents },
      });
    }
    if (t.status !== 'received') return;
    expect(t.shortageCents).toBeGreaterThanOrEqual(0);
    expect(t.receivedCents! + t.shortageCents!).toBe(t.sentCents);
    if (t.sentCents === 0) return;
    expect(inn).not.toBeNull();
    expect(inn!.restaurantId).toBe(t.to.id);
    expect(inn!.day).toBe(t.receiveBusinessDate);
    expect(inn!.net.inventory ?? 0).toBe(t.receivedCents);
    expect(inn!.net.transfer_shortage ?? 0).toBe(t.shortageCents);
    expect((out!.net.stock_in_transit ?? 0) + (inn!.net.stock_in_transit ?? 0)).toBe(0);
  };
  const getView = async (restaurant: string, token: string, id: string) =>
    (
      await h.http
        .get(`/v1/restaurants/${restaurant}/inventory/transfers/${id}`)
        .set(bearer(token))
        .expect(200)
    ).body as StockTransferView;

  /** round(qty × cost) half away from zero, exactly, from decimal strings (≤3 and ≤6 places). */
  const exactValue = (qty: string, cost: string): number => {
    const scaled = (s: string, places: number) => {
      const [w, f = ''] = s.split('.');
      return BigInt(w! + f.padEnd(places, '0'));
    };
    const p = scaled(qty, 3) * scaled(cost, 6); // units of 1e-9 cents
    const unit = 1_000_000_000n;
    const q = p / unit;
    const r = p % unit;
    return Number(r * 2n >= unit ? q + 1n : q);
  };

  // ------------------------------------------------------------------ races

  it('racing dispatches under the block policy never send more than is available', async () => {
    const item = await newItem('RACE', '7');
    await stockCentral([{ inventoryItemId: item, quantity: '10' }]);
    expect(await onHand(central, item)).toBe(10);
    const body = { toRestaurantId: express, lines: [{ inventoryItemId: item, quantity: '6' }] };
    const pair = await Promise.all([
      send(centralManager, central, body).then((r) => r),
      send(centralManager, central, body).then((r) => r),
    ]);
    expect(pair.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(pair.find((r) => r.status === 409)!.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await onHand(central, item)).toBe(4);

    // Five racers for one each with four left: exactly four win.
    const small = { toRestaurantId: drive, lines: [{ inventoryItemId: item, quantity: '1' }] };
    const five = await Promise.all(
      Array.from({ length: 5 }, () => send(centralManager, central, small).then((r) => r)),
    );
    const statuses = five.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 201, 201, 409]);
    expect(await onHand(central, item)).toBe(0);
    const out = await h.owner
      .selectFrom('stock_movements')
      .select(sql<string>`coalesce(sum(quantity_delta), 0)`.as('q'))
      .where('inventory_item_id', '=', item)
      .where('movement_type', '=', 'transfer_out')
      .executeTakeFirstOrThrow();
    expect(Number(out.q)).toBe(-10);
  });

  it('racing dispatches over the same items in opposite order do not deadlock', async () => {
    const a = await newItem('ORD-A', '3');
    const b = await newItem('ORD-B', '5');
    await stockCentral([
      { inventoryItemId: a, quantity: '100' },
      { inventoryItemId: b, quantity: '100' },
    ]);
    const res = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        send(centralManager, central, {
          toRestaurantId: express,
          lines:
            i % 2 === 0
              ? [
                  { inventoryItemId: a, quantity: '1' },
                  { inventoryItemId: b, quantity: '2' },
                ]
              : [
                  { inventoryItemId: b, quantity: '2' },
                  { inventoryItemId: a, quantity: '1' },
                ],
        }).then((r) => r),
      ),
    );
    expect(res.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(await onHand(central, a)).toBe(94);
    expect(await onHand(central, b)).toBe(88);
  });

  it('a dispatch cannot take stock that is reserved for orders', async () => {
    const item = await newItem('RESV', '11');
    await stockCentral([{ inventoryItemId: item, quantity: '10' }]);
    const loc = await h.owner
      .selectFrom('stock_locations')
      .select('id')
      .where('restaurant_id', '=', central)
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    await h.owner
      .updateTable('stock_balances')
      .set({ reserved: '7' })
      .where('location_id', '=', loc.id)
      .where('inventory_item_id', '=', item)
      .execute();
    try {
      const tooMuch = await send(centralManager, central, {
        toRestaurantId: express,
        lines: [{ inventoryItemId: item, quantity: '3.001' }],
      });
      expect(tooMuch.status).toBe(409);
      expect(tooMuch.body.error.code).toBe('INSUFFICIENT_STOCK');
      expect(await onHand(central, item)).toBe(10);
      const exact = await send(centralManager, central, {
        toRestaurantId: express,
        lines: [{ inventoryItemId: item, quantity: '3' }],
      });
      expect(exact.status).toBe(201);
      expect(await onHand(central, item)).toBe(7);
    } finally {
      // No real reservation rows back this; restore so ledger reconciliation holds for others.
      await h.owner
        .updateTable('stock_balances')
        .set({ reserved: '0' })
        .where('location_id', '=', loc.id)
        .where('inventory_item_id', '=', item)
        .execute();
    }
  });

  it('five racing receipts with different keys and bodies: exactly one is recorded', async () => {
    const item = await newItem('RCV-RACE', '13');
    await stockCentral([{ inventoryItemId: item, quantity: '10' }]);
    const t = (
      await send(centralManager, central, {
        toRestaurantId: express,
        lines: [{ inventoryItemId: item, quantity: '10' }],
      }).expect(201)
    ).body as StockTransferView;
    const res = await Promise.all(
      [10, 9, 8, 7, 6].map((q) =>
        receive(expressManager, express, t.id, {
          lines: [{ inventoryItemId: item, quantityReceived: String(q) }],
        }).then((r) => r),
      ),
    );
    const ok = res.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(4);
    const won = Number(ok[0]!.body.lines[0].quantityReceived);
    expect(await onHand(express, item)).toBe(won);
    const moves = await h.owner
      .selectFrom('stock_movements')
      .select(['quantity_delta'])
      .where('source_id', '=', t.id)
      .where('movement_type', '=', 'transfer_in')
      .execute();
    expect(moves).toHaveLength(1);
    expect(Number(moves[0]!.quantity_delta)).toBe(won);
  });

  // ------------------------------------------------------------------ idempotency

  it('a dispatch key reused with a different body is refused; a double tap sends once', async () => {
    const item = await newItem('IDEM', '2');
    await stockCentral([{ inventoryItemId: item, quantity: '50' }]);
    const key = randomUUID();
    const note = `idem ${randomUUID()}`;
    const body = {
      toRestaurantId: express,
      notes: note,
      lines: [{ inventoryItemId: item, quantity: '5' }],
    };
    expect((await send(centralManager, central, body, key)).status).toBe(201);
    const reused = await send(
      centralManager,
      central,
      { ...body, lines: [{ inventoryItemId: item, quantity: '6' }] },
      key,
    );
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const toOther = await send(centralManager, central, { ...body, toRestaurantId: drive }, key);
    expect(toOther.status).toBe(422);
    const replay = await send(centralManager, central, body, key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await onHand(central, item)).toBe(45);
    expect(await transfersWithNotes(note)).toBe(1);

    // Double tap: the same key in flight twice at once.
    const note2 = `tap ${randomUUID()}`;
    const key2 = randomUUID();
    const tap = { ...body, notes: note2 };
    const both = await Promise.all([
      send(centralManager, central, tap, key2).then((r) => r),
      send(centralManager, central, tap, key2).then((r) => r),
    ]);
    for (const r of both) expect([201, 409]).toContain(r.status);
    expect(both.some((r) => r.status === 201)).toBe(true);
    expect(await transfersWithNotes(note2)).toBe(1);
    expect(await onHand(central, item)).toBe(40);
  });

  it('a receive key reused with a different body or another transfer is refused', async () => {
    const item = await newItem('IDEM-RCV', '4');
    await stockCentral([{ inventoryItemId: item, quantity: '20' }]);
    const mk = async () =>
      (
        await send(centralManager, central, {
          toRestaurantId: express,
          lines: [{ inventoryItemId: item, quantity: '5' }],
        }).expect(201)
      ).body as StockTransferView;
    const t1 = await mk();
    const t2 = await mk();
    const key = randomUUID();
    const body = { lines: [{ inventoryItemId: item, quantityReceived: '5' }] };
    expect((await receive(expressManager, express, t1.id, body, key)).status).toBe(200);
    const diff = await receive(
      expressManager,
      express,
      t1.id,
      { lines: [{ inventoryItemId: item, quantityReceived: '4' }] },
      key,
    );
    expect(diff.status).toBe(422);
    expect(diff.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const other = await receive(expressManager, express, t2.id, body, key);
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const st = await h.owner
      .selectFrom('stock_transfers')
      .select('status')
      .where('id', '=', t2.id)
      .executeTakeFirstOrThrow();
    expect(st.status).toBe('in_transit');
    // The key is per restaurant: the same key at another restaurant is a new request.
    const noKey = await h.http
      .post(`/v1/restaurants/${express}/inventory/transfers/${t2.id}/receive`)
      .set(bearer(expressManager))
      .send(body);
    expect(noKey.status).toBe(400);
  });

  // ------------------------------------------------------------------ malformed input

  it('rejects malformed, negative, over-precise and oversized quantities', async () => {
    const item = await newItem('BAD', '1');
    await stockCentral([{ inventoryItemId: item, quantity: '10' }]);
    for (const quantity of [
      '1.0001',
      '-1',
      '0',
      '0.000',
      '1e3',
      ' 1',
      '1,5',
      '',
      '1000000000000',
      'NaN',
      'Infinity',
      1,
      null,
    ]) {
      const r = await send(centralManager, central, {
        toRestaurantId: express,
        lines: [{ inventoryItemId: item, quantity }],
      });
      expect(r.status, `quantity ${JSON.stringify(quantity)}`).toBe(400);
    }
    expect(await onHand(central, item)).toBe(10);
    for (const lines of [[], Array.from({ length: 201 }, () => ({}))]) {
      expect((await send(centralManager, central, { toRestaurantId: express, lines })).status).toBe(
        400,
      );
    }
    expect(
      (
        await send(centralManager, central, {
          toRestaurantId: express,
          notes: 'x'.repeat(501),
          lines: [{ inventoryItemId: item, quantity: '1' }],
        })
      ).status,
    ).toBe(400);

    const t = (
      await send(centralManager, central, {
        toRestaurantId: express,
        lines: [{ inventoryItemId: item, quantity: '2' }],
      }).expect(201)
    ).body as StockTransferView;
    for (const quantityReceived of ['1.2345', '-1', '-0.001', '', '1e0', 2, '2.0001']) {
      const r = await receive(expressManager, express, t.id, {
        lines: [{ inventoryItemId: item, quantityReceived }],
      });
      expect(r.status, `received ${JSON.stringify(quantityReceived)}`).toBe(400);
    }
    expect(
      (
        await h.http
          .get(`/v1/restaurants/${express}/inventory/transfers/not-a-uuid`)
          .set(bearer(expressManager))
      ).status,
    ).toBe(400);
    for (const q of [
      'direction=sideways',
      'direction=incoming&status=lost',
      'direction=incoming&limit=0',
      '',
    ]) {
      expect(
        (
          await h.http
            .get(`/v1/restaurants/${express}/inventory/transfers?${q}`)
            .set(bearer(expressManager))
        ).status,
        q,
      ).toBe(400);
    }
    const still = await getView(express, expressManager, t.id);
    expect(still.status).toBe('in_transit');
    expect(await onHand(express, item)).toBe(0);
  });

  it('huge quantities are carried exactly and the balance range guard holds', async () => {
    // Tiny cost so the values stay small: the point is the quantity range.
    const item = await newItem('HUGE', '0.000001');
    const q = '999999999999.999';
    const note = `huge ${randomUUID()}`;
    const sent: StockTransferView[] = [];
    let refused: { status: number; body: { error: { code: string } } } | null = null;
    for (let i = 0; i < 9; i++) {
      const r = await send(expressManager, express, {
        toRestaurantId: central,
        notes: note,
        lines: [{ inventoryItemId: item, quantity: q }],
      });
      if (r.status === 201) sent.push(r.body as StockTransferView);
      else {
        refused = r;
        break;
      }
    }
    // Express allows negative stock; the guard stops it at ±8×10^12 units.
    expect(sent).toHaveLength(8);
    expect(refused?.status).toBe(422);
    expect(refused?.body.error.code).toBe('QUANTITY_OUT_OF_RANGE');
    expect(await transfersWithNotes(note)).toBe(8);
    const raw = await h.owner
      .selectFrom('stock_balances as b')
      .innerJoin('stock_locations as l', 'l.id', 'b.location_id')
      .select(sql<string>`b.on_hand::text`.as('on_hand'))
      .where('l.restaurant_id', '=', express)
      .where('b.inventory_item_id', '=', item)
      .executeTakeFirstOrThrow();
    expect(raw.on_hand).toBe('-7999999999999.992');
    for (const t of sent) {
      expect(t.lines[0]!.quantitySent).toBe(q);
      expect(t.sentCents).toBe(exactValue(q, '0.000001'));
      const r = await receive(expressManager, express, t.id, {
        lines: [{ inventoryItemId: item, quantityReceived: q }],
      });
      expect(r.status).toBe(404); // Express is the sender, not the receiver
      const got = await receive(centralManager, central, t.id, {
        lines: [{ inventoryItemId: item, quantityReceived: q }],
      });
      expect(got.status).toBe(200);
      expect(got.body.shortageCents).toBe(0);
    }
    const back = await h.owner
      .selectFrom('stock_balances as b')
      .innerJoin('stock_locations as l', 'l.id', 'b.location_id')
      .select(sql<string>`b.on_hand::text`.as('on_hand'))
      .where('l.restaurant_id', '=', central)
      .where('b.inventory_item_id', '=', item)
      .executeTakeFirstOrThrow();
    expect(back.on_hand).toBe('7999999999999.992');
    await dispatcher.runOnce();
    for (const t of sent) await assertJournalClears(await getView(central, centralManager, t.id));
  });

  // ------------------------------------------------------------------ tenancy and roles

  it('another tenant can neither see, receive nor target a transfer', async () => {
    const item = await newItem('TENANT', '9');
    await stockCentral([{ inventoryItemId: item, quantity: '5' }]);
    const t = (
      await send(centralManager, central, {
        toRestaurantId: express,
        lines: [{ inventoryItemId: item, quantity: '1' }],
      }).expect(201)
    ).body as StockTransferView;
    const lines = [{ inventoryItemId: item, quantityReceived: '1' }];
    // Rival's own restaurant, demo transfer id.
    expect(
      (
        await h.http
          .get(`/v1/restaurants/${rival}/inventory/transfers/${t.id}`)
          .set(bearer(rivalManager))
      ).status,
    ).toBe(404);
    expect((await receive(rivalManager, rival, t.id, { lines })).status).toBe(404);
    const rivalList = await h.http
      .get(`/v1/restaurants/${rival}/inventory/transfers?direction=incoming`)
      .set(bearer(rivalManager))
      .expect(200);
    expect((rivalList.body as StockTransferView[]).map((x) => x.id)).not.toContain(t.id);
    const rivalDest = await h.http
      .get(`/v1/restaurants/${rival}/inventory/transfer-destinations`)
      .set(bearer(rivalManager))
      .expect(200);
    const destIds = (rivalDest.body as { id: string }[]).map((d) => d.id);
    for (const id of [central, express, drive]) expect(destIds).not.toContain(id);
    // Demo restaurant paths with a Rival token.
    for (const path of [
      `/v1/restaurants/${express}/inventory/transfers/${t.id}`,
      `/v1/restaurants/${central}/inventory/transfers?direction=outgoing`,
      `/v1/restaurants/${central}/inventory/transfer-destinations`,
    ]) {
      const r = await h.http.get(path).set(bearer(rivalManager));
      expect([403, 404], path).toContain(r.status);
    }
    expect([403, 404]).toContain((await receive(rivalManager, express, t.id, { lines })).status);
    // Rival sending its own item to a demo restaurant.
    const rivalItem = await h.owner
      .selectFrom('inventory_items as i')
      .innerJoin('restaurants as r', 'r.org_id', 'i.org_id')
      .select('i.id')
      .where('r.id', '=', rival)
      .executeTakeFirstOrThrow();
    const rivalSend = await send(rivalManager, rival, {
      toRestaurantId: central,
      lines: [{ inventoryItemId: rivalItem.id, quantity: '1' }],
    });
    expect(rivalSend.status).toBe(404);
    // Demo manager with a demo item, sending from a Rival path.
    expect([403, 404]).toContain(
      (
        await send(centralManager, rival, {
          toRestaurantId: express,
          lines: [{ inventoryItemId: item, quantity: '1' }],
        })
      ).status,
    );
    expect(await getView(express, expressManager, t.id)).toMatchObject({ status: 'in_transit' });
    expect(await onHand(central, item)).toBe(4);
  });

  it('a restaurant on neither side cannot receive or read; a restaurant cannot receive its own dispatch', async () => {
    const item = await newItem('SIDES', '9');
    await stockCentral([{ inventoryItemId: item, quantity: '5' }]);
    const t = (
      await send(centralManager, central, {
        toRestaurantId: express,
        lines: [{ inventoryItemId: item, quantity: '2' }],
      }).expect(201)
    ).body as StockTransferView;
    const lines = [{ inventoryItemId: item, quantityReceived: '2' }];
    expect((await receive(driveManager, drive, t.id, { lines })).status).toBe(404);
    expect((await receive(centralManager, central, t.id, { lines })).status).toBe(404);
    // Express's manager has no access to Central, so cannot pose as the sender.
    expect(
      (
        await h.http
          .get(`/v1/restaurants/${central}/inventory/transfers/${t.id}`)
          .set(bearer(expressManager))
      ).status,
    ).toBe(404);
    const driveIncoming = await h.http
      .get(`/v1/restaurants/${drive}/inventory/transfers?direction=incoming`)
      .set(bearer(driveManager))
      .expect(200);
    expect((driveIncoming.body as StockTransferView[]).map((x) => x.id)).not.toContain(t.id);
    // The outgoing list of the receiver does not show it as its own.
    const expressOutgoing = await h.http
      .get(`/v1/restaurants/${express}/inventory/transfers?direction=outgoing&limit=200`)
      .set(bearer(expressManager))
      .expect(200);
    expect((expressOutgoing.body as StockTransferView[]).map((x) => x.id)).not.toContain(t.id);
    expect(await onHand(express, item)).toBe(0);
  });

  it('oversight roles cannot transfer; org-scoped inventory controller and admin can', async () => {
    const item = await newItem('ROLES', '10');
    await stockCentral([{ inventoryItemId: item, quantity: '10' }]);
    const body = { toRestaurantId: drive, lines: [{ inventoryItemId: item, quantity: '1' }] };
    for (const token of [areaManager, auditor]) {
      expect((await send(token, central, body)).status).toBe(403);
      for (const path of [
        `/v1/restaurants/${central}/inventory/transfer-destinations`,
        `/v1/restaurants/${central}/inventory/transfers?direction=outgoing`,
      ]) {
        expect((await h.http.get(path).set(bearer(token))).status).toBe(403);
      }
    }
    expect(await onHand(central, item)).toBe(10);
    const t = (await send(inventoryController, central, body).expect(201))
      .body as StockTransferView;
    // The CBD area manager has no access to Drive (Western Sydney) at all: 404; the
    // organisation-wide auditor has access but not the permission: 403.
    for (const [token, status] of [
      [areaManager, 404],
      [auditor, 403],
    ] as const) {
      expect(
        (
          await receive(token, drive, t.id, {
            lines: [{ inventoryItemId: item, quantityReceived: '1' }],
          })
        ).status,
      ).toBe(status);
      expect(
        (
          await h.http
            .get(`/v1/restaurants/${drive}/inventory/transfers/${t.id}`)
            .set(bearer(token))
        ).status,
      ).toBe(status);
    }
    // At Express (CBD) the area manager has access but lacks inventory.adjust.
    expect(
      (
        await h.http
          .get(`/v1/restaurants/${express}/inventory/transfers?direction=incoming`)
          .set(bearer(areaManager))
      ).status,
    ).toBe(403);
    expect((await getView(drive, admin, t.id)).status).toBe('in_transit');
    const got = await receive(inventoryController, drive, t.id, {
      lines: [{ inventoryItemId: item, quantityReceived: '1' }],
    });
    expect(got.status).toBe(200);
    expect(await onHand(drive, item)).toBe(1);
    expect(await onHand(central, item)).toBe(9);
  });

  it('an inactive restaurant is not a destination', async () => {
    const item = await newItem('INACTIVE', '10');
    await stockCentral([{ inventoryItemId: item, quantity: '3' }]);
    await h.owner
      .updateTable('restaurants')
      .set({ status: 'inactive' })
      .where('id', '=', drive)
      .execute();
    try {
      const dest = await h.http
        .get(`/v1/restaurants/${central}/inventory/transfer-destinations`)
        .set(bearer(centralManager))
        .expect(200);
      expect((dest.body as { id: string }[]).map((d) => d.id)).not.toContain(drive);
      const r = await send(centralManager, central, {
        toRestaurantId: drive,
        lines: [{ inventoryItemId: item, quantity: '1' }],
      });
      expect(r.status).toBe(404);
      expect(await onHand(central, item)).toBe(3);
    } finally {
      await h.owner
        .updateTable('restaurants')
        .set({ status: 'active' })
        .where('id', '=', drive)
        .execute();
    }
  });

  // ------------------------------------------------------------------ journal

  it('rounding with fractional unit costs across many lines clears transit exactly', async () => {
    const specs: { cost: string; sent: string; got: string }[] = [
      { cost: '0.5', sent: '1', got: '1' },
      { cost: '0.5', sent: '3', got: '1' },
      { cost: '0.333333', sent: '10.5', got: '10.499' },
      { cost: '1.005', sent: '1', got: '0.999' },
      { cost: '2.675', sent: '0.001', got: '0' },
      { cost: '0.125', sent: '4.004', got: '4.003' },
      { cost: '999.999999', sent: '7.777', got: '7.776' },
      { cost: '0.000001', sent: '0.001', got: '0.001' },
      { cost: '0.499999', sent: '1', got: '1' },
      { cost: '0.500001', sent: '1', got: '0' },
      { cost: '13.37', sent: '0.015', got: '0.015' },
      { cost: '0', sent: '5', got: '2' },
    ];
    const items: string[] = [];
    for (const [i, s] of specs.entries()) items.push(await newItem(`RND${i}`, s.cost, 'g'));
    await stockCentral(items.map((id) => ({ inventoryItemId: id, quantity: '100' })));
    const t = (
      await send(centralManager, central, {
        toRestaurantId: express,
        lines: items.map((id, i) => ({ inventoryItemId: id, quantity: specs[i]!.sent })),
      }).expect(201)
    ).body as StockTransferView;
    const expectedSent = specs.reduce((a, s) => a + exactValue(s.sent, s.cost), 0);
    expect(t.sentCents).toBe(expectedSent);
    const r = (
      await receive(expressManager, express, t.id, {
        lines: items.map((id, i) => ({ inventoryItemId: id, quantityReceived: specs[i]!.got })),
      }).expect(200)
    ).body as StockTransferView;
    const expectedReceived = specs.reduce((a, s) => a + exactValue(s.got, s.cost), 0);
    expect(r.receivedCents).toBe(expectedReceived);
    expect(r.shortageCents).toBe(expectedSent - expectedReceived);
    await dispatcher.runOnce();
    await assertJournalClears(r);
    for (const [restaurant, token, day] of [
      [central, centralManager, r.dispatchBusinessDate],
      [express, expressManager, r.receiveBusinessDate!],
    ] as const) {
      const rec = await reconciliation(restaurant, token, day);
      expect(rec.stockMovementsValueCents, restaurant).toBe(rec.journalInventoryCents);
    }
  });

  it('a standard-cost change before posting and before receipt changes nothing in transit', async () => {
    const item = await newItem('COST', '125');
    await stockCentral([{ inventoryItemId: item, quantity: '10' }]);
    await dispatcher.runOnce();
    const t = (
      await send(centralManager, central, {
        toRestaurantId: express,
        lines: [{ inventoryItemId: item, quantity: '4' }],
      }).expect(201)
    ).body as StockTransferView;
    expect(t.sentCents).toBe(500);
    // Changed before the dispatch is even posted.
    await h.owner
      .updateTable('inventory_items')
      .set({ standard_unit_cost: '1' })
      .where('id', '=', item)
      .execute();
    await dispatcher.runOnce();
    expect((await entryNet(t.id, 'transfer_out'))!.net).toEqual({
      inventory: -500,
      stock_in_transit: 500,
    });
    await h.owner
      .updateTable('inventory_items')
      .set({ standard_unit_cost: '777.777777' })
      .where('id', '=', item)
      .execute();
    const r = (
      await receive(expressManager, express, t.id, {
        lines: [{ inventoryItemId: item, quantityReceived: '3' }],
      }).expect(200)
    ).body as StockTransferView;
    expect(r).toMatchObject({ sentCents: 500, receivedCents: 375, shortageCents: 125 });
    await dispatcher.runOnce();
    await assertJournalClears(r);
    const rec = await reconciliation(express, expressManager, r.receiveBusinessDate!);
    expect(rec.stockMovementsValueCents).toBe(rec.journalInventoryCents);
  });

  it('redelivering transfer events posts nothing twice', async () => {
    const item = await newItem('REDELIVER', '33');
    await stockCentral([{ inventoryItemId: item, quantity: '10' }]);
    const t = (
      await send(centralManager, central, {
        toRestaurantId: express,
        lines: [{ inventoryItemId: item, quantity: '6' }],
      }).expect(201)
    ).body as StockTransferView;
    await receive(expressManager, express, t.id, {
      lines: [{ inventoryItemId: item, quantityReceived: '5' }],
    }).expect(200);
    await dispatcher.runOnce();
    await dispatcher.runOnce();
    const before = await entries(t.id);
    expect(before.map((e) => e.entry_type).sort()).toEqual(['transfer_in', 'transfer_out']);
    const lineCount = async () =>
      Number(
        (
          await h.owner
            .selectFrom('journal_lines')
            .select(sql<string>`count(*)`.as('n'))
            .where(
              'entry_id',
              'in',
              before.map((e) => e.id),
            )
            .executeTakeFirstOrThrow()
        ).n,
      );
    const linesBefore = await lineCount();
    const events = await h.owner
      .selectFrom('outbox_events')
      .select(['id', 'restaurant_id', 'event_type', 'aggregate_id'])
      .where('aggregate_id', '=', t.id)
      .execute();
    expect(events.map((e) => e.event_type).sort()).toEqual([
      'inventory.transfer_dispatched',
      'inventory.transfer_received',
    ]);
    const consumer = h.app.get(LedgerConsumer);
    for (let i = 0; i < 2; i++) {
      for (const e of events) {
        await withTenant(appDb, { orgId }, (tx) =>
          consumer.handle(tx, {
            id: e.id,
            orgId,
            restaurantId: e.restaurant_id,
            eventType: e.event_type,
            aggregateId: e.aggregate_id,
          }),
        );
      }
    }
    expect((await entries(t.id)).map((e) => e.id).sort()).toEqual(before.map((e) => e.id).sort());
    expect(await lineCount()).toBe(linesBefore);
    await assertJournalClears(await getView(express, expressManager, t.id));
  });

  it('a chain of transfers A→B→C leaves no stock in transit and both books reconcile', async () => {
    const item = await newItem('CHAIN', '0.777777', 'g');
    await stockCentral([{ inventoryItemId: item, quantity: '1000' }]);
    const ab = (
      await send(centralManager, central, {
        toRestaurantId: express,
        lines: [{ inventoryItemId: item, quantity: '333.333' }],
      }).expect(201)
    ).body as StockTransferView;
    const abR = (
      await receive(expressManager, express, ab.id, {
        lines: [{ inventoryItemId: item, quantityReceived: '333.332' }],
      }).expect(200)
    ).body as StockTransferView;
    // Express forwards more than it holds (allow_negative) to Drive, which receives in full.
    const bc = (
      await send(expressManager, express, {
        toRestaurantId: drive,
        lines: [{ inventoryItemId: item, quantity: '400' }],
      }).expect(201)
    ).body as StockTransferView;
    const bcR = (
      await receive(driveManager, drive, bc.id, {
        lines: [{ inventoryItemId: item, quantityReceived: '400' }],
      }).expect(200)
    ).body as StockTransferView;
    expect(await onHand(express, item)).toBeCloseTo(-66.668, 3);
    expect(await onHand(drive, item)).toBe(400);
    await dispatcher.runOnce();
    await assertJournalClears(abR);
    await assertJournalClears(bcR);
    // Org-wide, the two transfers net to zero in transit.
    const transit = await h.owner
      .selectFrom('journal_lines as l')
      .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(sql<string>`coalesce(sum(l.debit_cents - l.credit_cents), 0)`.as('net'))
      .where('a.system_key', '=', 'stock_in_transit')
      .where('e.source_type', '=', 'stock_transfer')
      .where('e.source_id', 'in', [ab.id, bc.id])
      .executeTakeFirstOrThrow();
    expect(Number(transit.net)).toBe(0);
    for (const [restaurant, token, day] of [
      [central, centralManager, ab.dispatchBusinessDate],
      [express, expressManager, abR.receiveBusinessDate!],
      [drive, driveManager, bcR.receiveBusinessDate!],
    ] as const) {
      const rec = await reconciliation(restaurant, token, day);
      expect(rec.stockMovementsValueCents, restaurant).toBe(rec.journalInventoryCents);
    }
  });

  it('receiving zero of everything writes it all off without moving stock', async () => {
    const item = await newItem('ZERO', '50');
    const item2 = await newItem('ZERO2', '0.5');
    await stockCentral([
      { inventoryItemId: item, quantity: '2' },
      { inventoryItemId: item2, quantity: '3' },
    ]);
    const t = (
      await send(centralManager, central, {
        toRestaurantId: express,
        lines: [
          { inventoryItemId: item, quantity: '2' },
          { inventoryItemId: item2, quantity: '3' },
        ],
      }).expect(201)
    ).body as StockTransferView;
    const r = (
      await receive(expressManager, express, t.id, {
        lines: [
          { inventoryItemId: item, quantityReceived: '0' },
          { inventoryItemId: item2, quantityReceived: '0.000' },
        ],
      }).expect(200)
    ).body as StockTransferView;
    expect(r).toMatchObject({ sentCents: 102, receivedCents: 0, shortageCents: 102 });
    expect(await onHand(express, item)).toBe(0);
    await dispatcher.runOnce();
    await assertJournalClears(r);
  });
});
