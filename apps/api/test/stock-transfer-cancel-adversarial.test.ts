import { randomUUID } from 'node:crypto';
import type { DayCloseView, LedgerReconciliation, StockTransferView } from '@kitchos/contracts';
import type { Database } from '@kitchos/database';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import { bearer, login, startHarness, type Harness } from './harness.ts';

/**
 * Adversarial tests for cancelling a stock transfer in transit (ADR-0020): cancels on later
 * and closed business days, rounding, racing cancels, dispatches and orders, event
 * redelivery, mixed days at both ends, negative stock and the balance range guard.
 *
 * Hygiene: a throwaway organisation with fresh restaurants per test, because these tests
 * close days and backdate rows. Backdating uses `session_replication_role = replica` for one
 * owner transaction and runs before the ledger posts (unless a test says otherwise), so the
 * real consumer computes the real posting date.
 */
describe('stock transfer cancel: adversarial (ADR-0020)', () => {
  let h: Harness;
  let dispatcher: EventDispatcher;
  let orgId: string;
  let brandId: string;
  let regionId: string;
  let menuId: string;
  const menuItems = { burger: '' };
  const skus = { bun: '', cup: '', gram: '' };
  const tokens = { managerA: '', managerB: '', supervisor: '' };

  // ------------------------------------------------------------------ fixture

  const inv = async (sku: string, cost: string, unit = 'each') =>
    (
      await h.owner
        .insertInto('inventory_items')
        .values({
          org_id: orgId,
          sku,
          name: sku,
          base_unit: unit,
          category: 'ingredient',
          standard_unit_cost: cost,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

  const buildOrg = async () => {
    const tag = randomUUID().slice(0, 8);
    orgId = (
      await h.owner
        .insertInto('organisations')
        .values({ name: `Transfer cancel adversarial ${tag}`, slug: `stca-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await sql`select app.create_default_chart(${orgId}::uuid)`.execute(h.owner);
    brandId = (
      await h.owner
        .insertInto('brands')
        .values({ org_id: orgId, name: 'STCA', slug: `stca-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    regionId = (
      await h.owner
        .insertInto('regions')
        .values({ org_id: orgId, name: 'STCA region' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    skus.bun = await inv('BUN', '40');
    skus.cup = await inv('CUP', '15');
    skus.gram = await inv('GRAM', '0.333333', 'g');
    const menu = await h.owner
      .insertInto('menus')
      .values({ org_id: orgId, brand_id: brandId, name: 'STCA menu' })
      .returning('id')
      .executeTakeFirstOrThrow();
    menuId = menu.id;
    const mv = await h.owner
      .insertInto('menu_versions')
      .values({ org_id: orgId, menu_id: menu.id, version: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const product = await h.owner
      .insertInto('products')
      .values({ org_id: orgId, brand_id: brandId, sku: 'Burger', name: 'Burger', kind: 'item' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const recipe = await h.owner
      .insertInto('recipes')
      .values({ org_id: orgId, product_id: product.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    const rv = await h.owner
      .insertInto('recipe_versions')
      .values({
        org_id: orgId,
        recipe_id: recipe.id,
        version: 1,
        station_type: 'grill',
        consumption_point: 'task_started',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await h.owner
      .insertInto('recipe_lines')
      .values({
        org_id: orgId,
        recipe_version_id: rv.id,
        inventory_item_id: skus.bun,
        quantity: '1',
      })
      .execute();
    await h.owner
      .updateTable('recipe_versions')
      .set({ status: 'published', published_at: sql<Date>`now()` })
      .where('id', '=', rv.id)
      .execute();
    menuItems.burger = (
      await h.owner
        .insertInto('menu_items')
        .values({
          org_id: orgId,
          menu_version_id: mv.id,
          product_id: product.id,
          category: 'All',
          price_cents: 1100,
          recipe_version_id: rv.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
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
      managerA: 'restaurant_manager',
      managerB: 'restaurant_manager',
      supervisor: 'shift_supervisor',
    };
    for (const [k, role] of Object.entries(roles) as [keyof typeof tokens, string][]) {
      const email = `${k.toLowerCase()}-${tag}@stca.test`;
      const user = await h.owner
        .insertInto('users')
        .values({ org_id: orgId, email, display_name: `STCA ${k}`, password_hash })
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

  const newRestaurant = async (policy: 'block' | 'allow_negative'): Promise<string> => {
    const slug = `stca-${randomUUID().slice(0, 8)}`;
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
        stock_shortage_policy: policy,
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
    return r.id;
  };

  beforeAll(async () => {
    h = await startHarness();
    dispatcher = h.app.get(EventDispatcher);
    await buildOrg();
  });

  afterAll(async () => {
    await drain();
    await h.owner.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = replica`.execute(tx);
      await sql`update event_consumer_failures set dead_at = now()
                 where org_id = ${orgId}::uuid and dead_at is null`.execute(tx);
    });
    await h.close();
  });

  // ------------------------------------------------------------------ helpers

  const api = (rid: string) => `/v1/restaurants/${rid}`;

  const drain = async () => {
    for (let i = 0; i < 40; i++) {
      if ((await dispatcher.runOnce()).processed === 0) return;
    }
  };

  const asOwnerRaw = (fn: (tx: Database) => Promise<void>) =>
    h.owner.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = replica`.execute(tx);
      await fn(tx);
    });

  const dbNow = async () => (await sql<{ n: Date }>`select now() as n`.execute(h.owner)).rows[0]!.n;

  const today = async (rid: string) =>
    (
      await sql<{ d: string }>`select app.business_date(${rid}::uuid, now())::text as d`.execute(
        h.owner,
      )
    ).rows[0]!.d;

  const addDays = async (day: string, n: number) =>
    (await sql<{ d: string }>`select (${day}::date + ${n}::int)::text as d`.execute(h.owner))
      .rows[0]!.d;

  const noon = (day: string) => sql<Date>`((${day}::date + time '12:00') at time zone 'UTC')`;

  /** Moves all of this organisation's stock and transfer activity since `since` back by whole days. */
  const backdateOrg = (days: number, since: Date) =>
    asOwnerRaw(async (tx) => {
      const by = sql`(${days}::int * interval '1 day')`;
      const prior = sql`${days}::int`;
      await sql`update stock_movements set occurred_at = occurred_at - ${by},
                  recorded_at = recorded_at - ${by}, business_date = business_date - ${prior}
                where org_id = ${orgId}::uuid and occurred_at >= ${since}`.execute(tx);
      await sql`update goods_receipts set received_at = received_at - ${by},
                  business_date = business_date - ${prior}
                where org_id = ${orgId}::uuid and received_at >= ${since}`.execute(tx);
      await sql`update stock_transfers set dispatched_at = dispatched_at - ${by},
                  dispatch_business_date = dispatch_business_date - ${prior}
                where org_id = ${orgId}::uuid and dispatched_at >= ${since}`.execute(tx);
      await sql`update stock_transfers set received_at = received_at - ${by},
                  receive_business_date = receive_business_date - ${prior}
                where org_id = ${orgId}::uuid and received_at >= ${since}`.execute(tx);
      await sql`update stock_transfers set cancelled_at = cancelled_at - ${by},
                  cancel_business_date = cancel_business_date - ${prior}
                where org_id = ${orgId}::uuid and cancelled_at >= ${since}`.execute(tx);
      await sql`update outbox_events set occurred_at = occurred_at - ${by}
                where org_id = ${orgId}::uuid and occurred_at >= ${since}`.execute(tx);
    });

  /** Puts a cancel (its row, its movements and its event) on `day`, as if it happened then. */
  const moveCancelTo = (transferId: string, day: string) =>
    asOwnerRaw(async (tx) => {
      await sql`update stock_transfers set cancelled_at = ${noon(day)}, cancel_business_date = ${day}::date
                where id = ${transferId}::uuid`.execute(tx);
      await sql`update stock_movements set occurred_at = ${noon(day)}, recorded_at = ${noon(day)},
                  business_date = ${day}::date
                where source_type = 'stock_transfer' and source_id = ${transferId}::uuid
                  and movement_type = 'return_to_stock'`.execute(tx);
      await sql`update outbox_events set occurred_at = ${noon(day)}
                where aggregate_id = ${transferId}::uuid
                  and event_type = 'inventory.transfer_cancelled'`.execute(tx);
    });

  const stockIn = async (rid: string, lines: { inventoryItemId: string; quantity: string }[]) => {
    await h.http
      .post(`${api(rid)}/inventory/receipts`)
      .set(bearer(tokens.managerA))
      .set('Idempotency-Key', randomUUID())
      .send({ lines })
      .expect(201);
  };
  const send = (from: string, to: string, lines: object[], token = tokens.managerA) =>
    h.http
      .post(`${api(from)}/inventory/transfers`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ toRestaurantId: to, lines });
  const sendOk = async (from: string, to: string, lines: object[], token = tokens.managerA) =>
    (await send(from, to, lines, token).expect(201)).body as StockTransferView;
  const receive = (at: string, id: string, lines: object[], token = tokens.managerB) =>
    h.http
      .post(`${api(at)}/inventory/transfers/${id}/receive`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ lines });
  const cancel = (
    at: string,
    id: string,
    reason = 'Sent by mistake',
    key = randomUUID(),
    token = tokens.managerA,
  ) =>
    h.http
      .post(`${api(at)}/inventory/transfers/${id}/cancel`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send({ reason });
  const view = async (rid: string, day: string) =>
    (
      await h.http
        .get(`${api(rid)}/days/${day}`)
        .set(bearer(tokens.managerA))
        .expect(200)
    ).body as DayCloseView;
  const close = (rid: string, day: string) =>
    h.http
      .post(`${api(rid)}/days/${day}/close`)
      .set(bearer(tokens.managerA))
      .send({});
  const reconciliation = async (rid: string, day: string) =>
    (
      await h.http
        .get(`${api(rid)}/accounting/reconciliation?businessDate=${day}`)
        .set(bearer(tokens.managerA))
        .expect(200)
    ).body as LedgerReconciliation;
  const onHand = async (rid: string, item: string) => {
    const r = await h.owner
      .selectFrom('stock_balances as b')
      .innerJoin('stock_locations as l', 'l.id', 'b.location_id')
      .select(['b.on_hand', 'b.reserved'])
      .where('l.restaurant_id', '=', rid)
      .where('l.is_default', '=', true)
      .where('b.inventory_item_id', '=', item)
      .executeTakeFirst();
    return { onHand: Number(r?.on_hand ?? 0), reserved: Number(r?.reserved ?? 0) };
  };
  const accountNet = async (rid: string, key: string, day?: string) => {
    let q = h.owner
      .selectFrom('journal_lines as l')
      .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(sql<string>`coalesce(sum(l.debit_cents - l.credit_cents), 0)`.as('net'))
      .where('e.restaurant_id', '=', rid)
      .where('a.system_key', '=', key);
    if (day) q = q.where('e.business_date', '=', day);
    return Number((await q.executeTakeFirstOrThrow()).net);
  };
  const movements = (id: string) =>
    h.owner
      .selectFrom('stock_movements')
      .select([
        'restaurant_id',
        'movement_type',
        'inventory_item_id',
        'quantity_delta',
        'value_cents',
        sql<string>`business_date::text`.as('day'),
      ])
      .where('source_type', '=', 'stock_transfer')
      .where('source_id', '=', id)
      .orderBy('movement_type')
      .orderBy('inventory_item_id')
      .execute();
  const transferEntry = (sourceId: string, entryType: string) =>
    h.owner
      .selectFrom('journal_entries')
      .select([
        'id',
        'restaurant_id',
        sql<string>`business_date::text`.as('day'),
        sql<string | null>`posted_late_from::text`.as('late_from'),
      ])
      .where('source_type', '=', 'stock_transfer')
      .where('source_id', '=', sourceId)
      .where('entry_type', '=', entryType)
      .execute();
  const entryNet = async (sourceId: string, entryType: string) => {
    const rows = await h.owner
      .selectFrom('journal_entries as e')
      .innerJoin('journal_lines as l', 'l.entry_id', 'e.id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['a.system_key', sql<string>`sum(l.debit_cents - l.credit_cents)`.as('net')])
      .where('e.source_type', '=', 'stock_transfer')
      .where('e.source_id', '=', sourceId)
      .where('e.entry_type', '=', entryType)
      .groupBy('a.system_key')
      .execute();
    return Object.fromEntries(rows.map((r) => [r.system_key!, Number(r.net)]));
  };
  const failuresAt = (rid: string) =>
    h.owner
      .selectFrom('event_consumer_failures as f')
      .innerJoin('outbox_events as o', 'o.id', 'f.event_id')
      .select(['o.event_type', 'f.attempts', 'f.dead_at', 'f.last_error'])
      .where('o.restaurant_id', '=', rid)
      .execute();
  const ledgerErrors = async (rid: string) =>
    (
      await sql`
      select b.inventory_item_id, b.on_hand, b.reserved
        from stock_balances b
        join stock_locations l on l.id = b.location_id
       where l.restaurant_id = ${rid}::uuid
         and (b.on_hand <> coalesce((select sum(m.quantity_delta) from stock_movements m
                where m.location_id = b.location_id and m.inventory_item_id = b.inventory_item_id), 0)
           or b.reserved <> coalesce((select sum(r.quantity) from stock_reservations r
                where r.location_id = b.location_id and r.inventory_item_id = b.inventory_item_id
                  and r.status = 'active'), 0))`.execute(h.owner)
    ).rows;
  const status = async (id: string) =>
    (
      await h.owner
        .selectFrom('stock_transfers')
        .select(['status', 'cancel_reason'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).status;
  /** Every reconciliation line agrees (not only `reconciled`, so a failure names the line). */
  const expectAllLinesAgree = (rec: LedgerReconciliation) => {
    expect({
      inventory: rec.stockMovementsValueCents,
      transit: rec.transitChangeCents,
      pending: rec.pendingEvents,
      dead: rec.deadLetteredEvents,
    }).toEqual({
      inventory: rec.journalInventoryCents,
      transit: rec.journalStockInTransitCents,
      pending: 0,
      dead: 0,
    });
    expect(rec.reconciled).toBe(true);
  };
  /** round(qty × cost) half away from zero, exactly: qty in milli-units, cost in micro-cents. */
  const exactValue = (qty: string, cost: string): number => {
    const [qi, qf = ''] = qty.split('.');
    const [ci, cf = ''] = cost.split('.');
    const q = BigInt(qi! + qf.padEnd(3, '0'));
    const c = BigInt(ci! + cf.padEnd(6, '0'));
    const p = q * c; // value × 10^9
    const scale = 1_000_000_000n;
    const whole = p / scale;
    const rem = p % scale;
    return Number(rem * 2n >= scale ? whole + 1n : whole);
  };

  // ------------------------------------------------------------------ 1. a later business day

  it('a cancel on a later business day than the dispatch: both days reconcile and close at the sender', async () => {
    const A = await newRestaurant('block');
    const B = await newRestaurant('allow_negative');
    const t0 = await today(A);
    const D1 = await addDays(t0, -30);
    const D2 = await addDays(t0, -29);
    const since = await dbNow();
    await stockIn(A, [
      { inventoryItemId: skus.bun, quantity: '20' },
      { inventoryItemId: skus.gram, quantity: '5000' },
    ]);
    const t = await sendOk(A, B, [
      { inventoryItemId: skus.bun, quantity: '7' },
      { inventoryItemId: skus.gram, quantity: '1234.567' },
    ]);
    const sent = 280 + exactValue('1234.567', '0.333333'); // 280 + 412
    expect(t.sentCents).toBe(sent);
    await backdateOrg(30, since);
    await drain();
    expect(await transferEntry(t.id, 'transfer_out')).toMatchObject([
      { restaurant_id: A, day: D1, late_from: null },
    ]);

    // The cancel happens the next day.
    const since2 = await dbNow();
    const c = await cancel(A, t.id, 'Driver never left the yard');
    expect(c.status).toBe(200);
    await backdateOrg(29, since2);
    await drain();
    expect(await failuresAt(A)).toEqual([]);

    const back = await movements(t.id);
    expect(back.filter((m) => m.movement_type === 'return_to_stock').map((m) => m.day)).toEqual([
      D2,
      D2,
    ]);
    expect(await transferEntry(t.id, 'transfer_cancel')).toMatchObject([
      { restaurant_id: A, day: D2, late_from: null },
    ]);
    expect(await entryNet(t.id, 'transfer_cancel')).toEqual({
      inventory: sent,
      stock_in_transit: -sent,
    });

    const r1 = await reconciliation(A, D1);
    expectAllLinesAgree(r1);
    expect(r1.transitChangeCents).toBe(sent);
    const r2 = await reconciliation(A, D2);
    expectAllLinesAgree(r2);
    expect(r2.transitChangeCents).toBe(-sent);
    expect(r2.stockMovementsValueCents).toBe(sent);
    expect(await accountNet(A, 'stock_in_transit')).toBe(0);
    // Nothing ever touched the receiver.
    expectAllLinesAgree(await reconciliation(B, D1));
    expectAllLinesAgree(await reconciliation(B, D2));
    expect(await accountNet(B, 'stock_in_transit')).toBe(0);

    expect((await close(A, D1)).status).toBe(200);
    expect((await close(A, D2)).status).toBe(200);
    expect((await close(B, D1)).status).toBe(200);
    expect((await close(B, D2)).status).toBe(200);
    expect((await onHand(A, skus.bun)).onHand).toBe(20);
    expect((await onHand(A, skus.gram)).onHand).toBe(5000);
  });

  // ------------------------------------------------------------------ 2. closed days

  it('a cancel after the dispatch day closed posts to its own day; one that outlives a close posts late, harmlessly', async () => {
    const A = await newRestaurant('block');
    const B = await newRestaurant('allow_negative');
    const t0 = await today(A);
    const D1 = await addDays(t0, -40);
    const D2 = await addDays(t0, -39);
    const since = await dbNow();
    await stockIn(A, [{ inventoryItemId: skus.bun, quantity: '20' }]);
    const t1 = await sendOk(A, B, [{ inventoryItemId: skus.bun, quantity: '10' }]);
    const t2 = await sendOk(A, B, [{ inventoryItemId: skus.bun, quantity: '5' }]);
    await backdateOrg(40, since);
    await drain();
    const closed = await close(A, D1);
    expect(closed.status).toBe(200);
    const snapshot = (closed.body as DayCloseView).totals;

    // (a) t1 is cancelled after D1 closed, on an ordinary later day (D2): nothing is late.
    await cancel(A, t1.id, 'Receiver closed for refit').expect(200);
    await moveCancelTo(t1.id, D2);
    // (b) t2's cancel began on D1 and committed after D1 closed (simulated): it posts late.
    await cancel(A, t2.id, 'Wrong store picked').expect(200);
    await moveCancelTo(t2.id, D1);
    await drain();
    expect(await failuresAt(A)).toEqual([]);

    expect(await transferEntry(t1.id, 'transfer_cancel')).toMatchObject([
      { restaurant_id: A, day: D2, late_from: null },
    ]);
    const late = await transferEntry(t2.id, 'transfer_cancel');
    expect(late).toHaveLength(1);
    expect(late[0]!.late_from).toBe(D1);
    const landing = late[0]!.day;
    expect(landing >= t0).toBe(true);
    // Nothing is left in transit at the sender, and the closed day's snapshot is untouched.
    expect(await accountNet(A, 'stock_in_transit')).toBe(0);
    expect(await accountNet(A, 'stock_in_transit', D1)).toBe(600);
    expect(
      (
        await h.owner
          .selectFrom('business_day_closes')
          .select('totals')
          .where('restaurant_id', '=', A)
          .where('business_date', '=', D1)
          .executeTakeFirstOrThrow()
      ).totals,
    ).toEqual(snapshot);

    // D2 reconciles and closes normally.
    const r2 = await reconciliation(A, D2);
    expectAllLinesAgree(r2);
    expect(r2.transitChangeCents).toBe(-400);
    expect((await close(A, D2)).status).toBe(200);

    // The landing day leaves the late entry out of both sides, so its transit line agrees and
    // nothing but "not ended" holds it; the late entry is flagged.
    const rl = await reconciliation(A, landing);
    expectAllLinesAgree(rl);
    const v = await view(A, landing);
    expect(v.blockers.map((b) => b.code)).toEqual(['DAY_NOT_ENDED']);
    expect(v.warnings.map((w) => w.code)).toContain('LATE_ENTRIES');

    // On the closed source day the live comparison now sees the late return in the stock ledger but
    // not in the journal (the entry is dated to the landing day). This is the existing late-posting
    // rule (ADR-0017), the same as for Inventory, and it cannot block anything: D1 is closed.
    const r1 = await reconciliation(A, D1);
    expect(r1.stockMovementsValueCents - r1.journalInventoryCents).toBe(200);
    expect(r1.transitChangeCents - r1.journalStockInTransitCents).toBe(-200);
    expect((await view(A, D1)).status).toBe('closed');
  });

  // ------------------------------------------------------------------ 3. rounding

  it('rounding: every returned line is exactly the negated dispatched line, and transit nets to zero', async () => {
    const A = await newRestaurant('allow_negative');
    const B = await newRestaurant('allow_negative');
    const cases: [string, string][] = [
      ['0.333333', '3.333'],
      ['0.005', '101'],
      ['1.999999', '7.777'],
      ['0.5', '1'],
      ['0.666667', '0.75'],
      ['12.345678', '0.001'],
      ['0.000001', '999999.999'],
      ['999.999999', '123.457'],
      ['0.25', '10'],
      ['0.333333', '1.5'],
      ['0.005', '0.1'],
      ['7.123457', '999999999.999'],
    ];
    const lines: { inventoryItemId: string; quantity: string }[] = [];
    const expected = new Map<string, number>();
    for (const [i, [cost, qty]] of cases.entries()) {
      const id = await inv(`RND-${i}-${randomUUID().slice(0, 6)}`, cost);
      lines.push({ inventoryItemId: id, quantity: qty });
      expected.set(id, exactValue(qty, cost));
    }
    const total = [...expected.values()].reduce((a, b) => a + b, 0);
    const t = await sendOk(A, B, lines);
    expect(t.sentCents).toBe(total);
    await drain();
    // Change every cost before cancelling: the return must not care.
    await h.owner
      .updateTable('inventory_items')
      .set({ standard_unit_cost: '3.141593' })
      .where('id', 'in', [...expected.keys()])
      .execute();
    const c = (await cancel(A, t.id).expect(200)).body as StockTransferView;
    expect(c.returnedCents).toBe(total);
    const ms = await movements(t.id);
    for (const [id, cents] of expected) {
      const out = ms.find((m) => m.inventory_item_id === id && m.movement_type === 'transfer_out')!;
      const ret = ms.find(
        (m) => m.inventory_item_id === id && m.movement_type === 'return_to_stock',
      )!;
      expect(Number(out.value_cents) + cents).toBe(0); // (avoids JS -0 for zero-value lines)
      expect(Number(ret.value_cents)).toBe(cents);
      expect(ret.quantity_delta).toBe(out.quantity_delta.replace('-', ''));
      expect((await onHand(A, id)).onHand).toBe(0);
    }
    await drain();
    expect(await failuresAt(A)).toEqual([]);
    expect(await entryNet(t.id, 'transfer_out')).toEqual({
      inventory: -total,
      stock_in_transit: total,
    });
    expect(await entryNet(t.id, 'transfer_cancel')).toEqual({
      inventory: total,
      stock_in_transit: -total,
    });
    expect(await accountNet(A, 'stock_in_transit')).toBe(0);
    expect(await accountNet(A, 'inventory')).toBe(0);
    expectAllLinesAgree(await reconciliation(A, c.cancelBusinessDate!));

    // A transfer worth nothing at all (every line rounds to 0 cents) cancels without any entry
    // and without failing the ledger.
    const z1 = await inv(`ZERO-${randomUUID().slice(0, 6)}`, '0.005');
    const z2 = await inv(`ZERO-${randomUUID().slice(0, 6)}`, '0.333333');
    const zero = await sendOk(A, B, [
      { inventoryItemId: z1, quantity: '0.001' },
      { inventoryItemId: z2, quantity: '1' },
    ]);
    expect(zero.sentCents).toBe(0);
    const zc = (await cancel(A, zero.id).expect(200)).body as StockTransferView;
    expect(zc.returnedCents).toBe(0);
    await drain();
    expect(await failuresAt(A)).toEqual([]);
    expect(await transferEntry(zero.id, 'transfer_out')).toEqual([]);
    expect(await transferEntry(zero.id, 'transfer_cancel')).toEqual([]);
    expectAllLinesAgree(await reconciliation(A, zc.cancelBusinessDate!));
  });

  // ------------------------------------------------------------------ 4. racing cancels

  it('two cancels with different keys and reasons race: one wins, one return, one entry', async () => {
    const A = await newRestaurant('block');
    const B = await newRestaurant('allow_negative');
    await stockIn(A, [
      { inventoryItemId: skus.bun, quantity: '100' },
      { inventoryItemId: skus.gram, quantity: '10000' },
    ]);
    for (let round = 0; round < 6; round++) {
      const t = await sendOk(A, B, [
        { inventoryItemId: skus.bun, quantity: '3' },
        { inventoryItemId: skus.gram, quantity: '333.3' },
      ]);
      const before = await onHand(A, skus.bun);
      const reasons = [`First reason ${round}`, `Second reason ${round}`];
      const [x, y] = await Promise.all([
        cancel(A, t.id, reasons[0]).then((r) => r),
        cancel(A, t.id, reasons[1], randomUUID(), tokens.managerB).then((r) => r),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      const [win, lose] = x.status === 200 ? [x, y] : [y, x];
      expect(lose.body.error.code).toBe('TRANSFER_CANCELLED');
      const row = await h.owner
        .selectFrom('stock_transfers')
        .select(['status', 'cancel_reason', 'version'])
        .where('id', '=', t.id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('cancelled');
      expect(row.cancel_reason).toBe((win.body as StockTransferView).cancelReason);
      expect(reasons).toContain(row.cancel_reason);
      expect(row.version).toBe(2);
      expect(
        (await movements(t.id)).filter((m) => m.movement_type === 'return_to_stock'),
      ).toHaveLength(2);
      expect((await onHand(A, skus.bun)).onHand).toBe(before.onHand + 3);
      const audits = await h.owner
        .selectFrom('audit_log')
        .select('reason')
        .where('entity_id', '=', t.id)
        .where('action', '=', 'inventory.transfer_cancel')
        .execute();
      expect(audits).toEqual([{ reason: row.cancel_reason }]);
      const events = await h.owner
        .selectFrom('outbox_events')
        .select('id')
        .where('aggregate_id', '=', t.id)
        .where('event_type', '=', 'inventory.transfer_cancelled')
        .execute();
      expect(events).toHaveLength(1);
    }

    // The same key twice at once: one cancel, the other a replay of it.
    const t = await sendOk(A, B, [{ inventoryItemId: skus.bun, quantity: '1' }]);
    const key = randomUUID();
    const [p, q] = await Promise.all([
      cancel(A, t.id, 'Same tap', key).then((r) => r),
      cancel(A, t.id, 'Same tap', key).then((r) => r),
    ]);
    expect([p.status, q.status]).toEqual([200, 200]);
    expect(
      [p.headers['idempotent-replayed'], q.headers['idempotent-replayed']].filter(
        (v) => v === 'true',
      ),
    ).toHaveLength(1);
    expect(
      (await movements(t.id)).filter((m) => m.movement_type === 'return_to_stock'),
    ).toHaveLength(1);

    // That key cannot cancel a different transfer.
    const other = await sendOk(A, B, [{ inventoryItemId: skus.bun, quantity: '1' }]);
    const reused = await cancel(A, other.id, 'Same tap', key);
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await status(other.id)).toBe('in_transit');
    await cancel(A, other.id, 'Tidy up').expect(200);

    await drain();
    expect(await failuresAt(A)).toEqual([]);
    const perTransfer = await h.owner
      .selectFrom('journal_entries')
      .select(['source_id', sql<string>`count(*)`.as('n')])
      .where('restaurant_id', '=', A)
      .where('entry_type', '=', 'transfer_cancel')
      .groupBy('source_id')
      .execute();
    expect(perTransfer).toHaveLength(8);
    expect(perTransfer.every((r) => Number(r.n) === 1)).toBe(true);
    expect(await accountNet(A, 'stock_in_transit')).toBe(0);
    expectAllLinesAgree(await reconciliation(A, await today(A)));
  });

  // ------------------------------------------------------------------ 5. racing dispatches and orders

  it('a cancel racing a new dispatch and orders under the block policy: no deadlock, nothing oversold', async () => {
    const A = await newRestaurant('block');
    const B = await newRestaurant('allow_negative');
    for (let round = 0; round < 5; round++) {
      // Exactly six of each available, then all of it sent away.
      for (const item of [skus.bun, skus.cup]) {
        const s = await onHand(A, item);
        const need = 6 - (s.onHand - s.reserved);
        if (need > 0) await stockIn(A, [{ inventoryItemId: item, quantity: String(need) }]);
        const n = await onHand(A, item);
        expect(n.onHand - n.reserved).toBe(6);
      }
      const t1 = await sendOk(A, B, [
        { inventoryItemId: skus.bun, quantity: '6' },
        { inventoryItemId: skus.cup, quantity: '6' },
      ]);
      const before = { bun: await onHand(A, skus.bun), cup: await onHand(A, skus.cup) };
      expect(before.bun.onHand - before.bun.reserved).toBe(0);

      const c = cancel(A, t1.id, `Race ${round}`).then((r) => r);
      // Lines in the opposite order to the first dispatch.
      const d = send(A, B, [
        { inventoryItemId: skus.cup, quantity: '6' },
        { inventoryItemId: skus.bun, quantity: '6' },
      ]).then((r) => r);
      const orders = Array.from({ length: 3 }, () =>
        h.http
          .post(`${api(A)}/orders`)
          .set(bearer(tokens.supervisor))
          .set('Idempotency-Key', randomUUID())
          .send({
            fulfilmentType: 'dine_in',
            lines: [{ menuItemId: menuItems.burger, quantity: 1 }],
          })
          .then((r) => r),
      );
      const [cr, dr, ...placed] = await Promise.all([c, d, ...orders]);
      expect(cr!.status).toBe(200);
      expect([201, 409]).toContain(dr!.status);
      if (dr!.status === 409) expect(dr!.body.error.code).toBe('INSUFFICIENT_STOCK');
      for (const o of placed) {
        expect([201, 409]).toContain(o.status);
        if (o.status === 409) expect(o.body.error.code).toBe('INSUFFICIENT_STOCK');
      }
      const won = placed.filter((o) => o.status === 201).length;
      const sent = dr!.status === 201 ? 6 : 0;
      const after = { bun: await onHand(A, skus.bun), cup: await onHand(A, skus.cup) };
      expect(after.bun.onHand).toBe(before.bun.onHand + 6 - sent);
      expect(after.cup.onHand).toBe(before.cup.onHand + 6 - sent);
      expect(after.bun.reserved).toBe(before.bun.reserved + won);
      expect(after.bun.onHand - after.bun.reserved).toBeGreaterThanOrEqual(0);
      expect(after.cup.onHand - after.cup.reserved).toBeGreaterThanOrEqual(0);
      expect(await ledgerErrors(A)).toEqual([]);
      // Give back whatever the second dispatch took, so the next round starts clean.
      if (dr!.status === 201) {
        await cancel(A, (dr!.body as StockTransferView).id, 'Reset').expect(200);
      }
    }
    await drain();
    expect(await failuresAt(A)).toEqual([]);
    expect(await accountNet(A, 'stock_in_transit')).toBe(0);
    const rec = await reconciliation(A, await today(A));
    expect(rec.transitChangeCents).toBe(rec.journalStockInTransitCents);
    expect(rec.stockMovementsValueCents).toBe(rec.journalInventoryCents);
    expect(rec.pendingEvents).toBe(0);
  });

  // ------------------------------------------------------------------ 6. redelivery

  it('a redelivered cancel event posts exactly once', async () => {
    const A = await newRestaurant('allow_negative');
    const B = await newRestaurant('allow_negative');
    const t = await sendOk(A, B, [
      { inventoryItemId: skus.bun, quantity: '2' },
      { inventoryItemId: skus.gram, quantity: '10' },
    ]);
    await cancel(A, t.id).expect(200);
    for (let i = 0; i < 5; i++) await drain();
    const first = await transferEntry(t.id, 'transfer_cancel');
    expect(first).toHaveLength(1);
    const net = await entryNet(t.id, 'transfer_cancel');
    expect(net).toEqual({ inventory: 83, stock_in_transit: -83 });

    // Forget that the ledger processed any of A's events, as a lost acknowledgement would.
    for (let i = 0; i < 3; i++) {
      await asOwnerRaw(async (tx) => {
        await sql`delete from inbox_events i using outbox_events o
                   where i.event_id = o.id and i.consumer = 'ledger'
                     and o.restaurant_id = ${A}::uuid`.execute(tx);
      });
      await drain();
    }
    expect(await failuresAt(A)).toEqual([]);
    expect(await transferEntry(t.id, 'transfer_cancel')).toEqual(first);
    expect(await transferEntry(t.id, 'transfer_out')).toHaveLength(1);
    expect(await entryNet(t.id, 'transfer_cancel')).toEqual(net);
    expect(await accountNet(A, 'stock_in_transit')).toBe(0);
    const claimed = await h.owner
      .selectFrom('inbox_events as i')
      .innerJoin('outbox_events as o', 'o.id', 'i.event_id')
      .select('o.event_type')
      .where('o.aggregate_id', '=', t.id)
      .where('i.consumer', '=', 'ledger')
      .orderBy('o.event_type')
      .execute();
    expect(claimed.map((c) => c.event_type)).toEqual([
      'inventory.transfer_cancelled',
      'inventory.transfer_dispatched',
    ]);
    expectAllLinesAgree(await reconciliation(A, await today(A)));
  });

  // ------------------------------------------------------------------ 7. a mixed day

  it('a day of dispatches, short receipts and cancels both ways reconciles and closes at both ends', async () => {
    const A = await newRestaurant('block');
    const B = await newRestaurant('allow_negative');
    const t0 = await today(A);
    const D = await addDays(t0, -20);
    const since = await dbNow();
    await stockIn(A, [
      { inventoryItemId: skus.bun, quantity: '50' },
      { inventoryItemId: skus.gram, quantity: '5000' },
      { inventoryItemId: skus.cup, quantity: '30' },
    ]);
    await stockIn(B, [{ inventoryItemId: skus.cup, quantity: '20' }]);
    // A → B, received short.
    const t1 = await sendOk(A, B, [
      { inventoryItemId: skus.bun, quantity: '10' },
      { inventoryItemId: skus.gram, quantity: '1000' },
    ]);
    expect(t1.sentCents).toBe(733);
    const r1 = (
      await receive(B, t1.id, [
        { inventoryItemId: skus.bun, quantityReceived: '9' },
        { inventoryItemId: skus.gram, quantityReceived: '999.5' },
      ]).expect(200)
    ).body as StockTransferView;
    expect(r1).toMatchObject({ receivedCents: 693, shortageCents: 40 });
    // A → B, cancelled by A.
    const t2 = await sendOk(A, B, [{ inventoryItemId: skus.cup, quantity: '5' }]);
    await cancel(A, t2.id, 'Not needed after all').expect(200);
    // B → A, received in full.
    const t3 = await sendOk(B, A, [{ inventoryItemId: skus.cup, quantity: '7' }], tokens.managerB);
    await receive(
      A,
      t3.id,
      [{ inventoryItemId: skus.cup, quantityReceived: '7' }],
      tokens.managerA,
    ).expect(200);
    // B → A, cancelled by B.
    const t4 = await sendOk(B, A, [{ inventoryItemId: skus.cup, quantity: '3' }], tokens.managerB);
    await cancel(B, t4.id, 'Courier no-show', randomUUID(), tokens.managerB).expect(200);
    // A → B, still in transit at the end of the day.
    const t5 = await sendOk(A, B, [{ inventoryItemId: skus.bun, quantity: '4' }]);
    // A → B, nothing arrived.
    const t6 = await sendOk(A, B, [{ inventoryItemId: skus.gram, quantity: '333.3' }]);
    expect(t6.sentCents).toBe(111);
    await receive(B, t6.id, [{ inventoryItemId: skus.gram, quantityReceived: '0' }]).expect(200);
    // A cancel refused on a received transfer leaves nothing behind.
    expect((await cancel(A, t1.id)).status).toBe(409);

    await backdateOrg(20, since);
    await drain();
    expect(await failuresAt(A)).toEqual([]);
    expect(await failuresAt(B)).toEqual([]);

    // A: dispatched 733 + 75 + 160 + 111, took back 75, received B's 105.
    const ra = await reconciliation(A, D);
    expectAllLinesAgree(ra);
    expect(ra.transitChangeCents).toBe(733 + 75 + 160 + 111 - 75 - 105);
    // B: dispatched 105 + 45, took back 45, received A's 733 + 111.
    const rb = await reconciliation(B, D);
    expectAllLinesAgree(rb);
    expect(rb.transitChangeCents).toBe(105 + 45 - 45 - 733 - 111);
    // Across the organisation only t5 is still in transit.
    expect(
      (await accountNet(A, 'stock_in_transit')) + (await accountNet(B, 'stock_in_transit')),
    ).toBe(160);
    for (const id of [t1.id, t2.id, t3.id, t4.id, t5.id, t6.id]) {
      for (const type of ['transfer_out', 'transfer_in', 'transfer_cancel']) {
        expect((await transferEntry(id, type)).length).toBeLessThanOrEqual(1);
      }
    }

    const ca = await close(A, D);
    expect(ca.status).toBe(200);
    const cb = await close(B, D);
    expect(cb.status).toBe(200);
    expect((cb.body as DayCloseView).totals.transferShortageCents).toBe(40 + 111);
    expect((ca.body as DayCloseView).totals.transferShortageCents).toBe(0);
    // t5 can still be cancelled the next (open) day, and lands there.
    const c5 = (await cancel(A, t5.id, 'Finally called off').expect(200)).body as StockTransferView;
    expect(c5.cancelBusinessDate).toBe(t0);
    await drain();
    expect(await transferEntry(t5.id, 'transfer_cancel')).toMatchObject([
      { day: t0, late_from: null },
    ]);
    expect(
      (await accountNet(A, 'stock_in_transit')) + (await accountNet(B, 'stock_in_transit')),
    ).toBe(0);
    expectAllLinesAgree(await reconciliation(A, t0));
  });

  // ------------------------------------------------------------------ 8. negative stock and range

  it('a cancel under allow_negative brings a negative balance back, at the dispatch cost', async () => {
    const A = await newRestaurant('allow_negative');
    const B = await newRestaurant('allow_negative');
    const t = await sendOk(A, B, [{ inventoryItemId: skus.bun, quantity: '5' }]);
    expect((await onHand(A, skus.bun)).onHand).toBe(-5);
    await h.owner
      .updateTable('inventory_items')
      .set({ standard_unit_cost: '77' })
      .where('id', '=', skus.bun)
      .execute();
    try {
      const c = (await cancel(A, t.id).expect(200)).body as StockTransferView;
      expect(c.returnedCents).toBe(200);
    } finally {
      await h.owner
        .updateTable('inventory_items')
        .set({ standard_unit_cost: '40' })
        .where('id', '=', skus.bun)
        .execute();
    }
    expect((await onHand(A, skus.bun)).onHand).toBe(0);
    await drain();
    expect(await accountNet(A, 'inventory')).toBe(0);
    expect(await accountNet(A, 'stock_in_transit')).toBe(0);
    expect(await ledgerErrors(A)).toEqual([]);
  });

  it('a cancel that would push the sender past the balance range is refused whole; receipt still works', async () => {
    const A = await newRestaurant('allow_negative');
    const B = await newRestaurant('allow_negative');
    const huge = await inv(`HUGE-${randomUUID().slice(0, 6)}`, '0.000001');
    const max = '999999999999.999';
    const t = await sendOk(A, B, [{ inventoryItemId: huge, quantity: max }]);
    // Fill A back up to just under the range limit (8e12): -max + 9 × max = 8 × max.
    for (let i = 0; i < 9; i++) await stockIn(A, [{ inventoryItemId: huge, quantity: max }]);
    const before = await onHand(A, huge);
    const refused = await cancel(A, t.id);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('QUANTITY_OUT_OF_RANGE');
    expect(await status(t.id)).toBe('in_transit');
    expect((await movements(t.id)).map((m) => m.movement_type)).toEqual(['transfer_out']);
    expect(await onHand(A, huge)).toEqual(before);
    expect(
      await h.owner
        .selectFrom('outbox_events')
        .select('id')
        .where('aggregate_id', '=', t.id)
        .where('event_type', '=', 'inventory.transfer_cancelled')
        .execute(),
    ).toEqual([]);
    // The receiver can still take it, and then the transfer is settled normally.
    await receive(B, t.id, [{ inventoryItemId: huge, quantityReceived: max }]).expect(200);
    await drain();
    expect(await failuresAt(A)).toEqual([]);
    expect(await failuresAt(B)).toEqual([]);
    expect(
      (await accountNet(A, 'stock_in_transit')) + (await accountNet(B, 'stock_in_transit')),
    ).toBe(0);
    expect(await ledgerErrors(A)).toEqual([]);
  });
});
