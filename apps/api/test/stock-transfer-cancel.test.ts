import { randomUUID } from 'node:crypto';
import type { LedgerReconciliation, StockTransferView } from '@kitchos/contracts';
import { createDb, type Database } from '@kitchos/database';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import { bearer, login, restaurantId, startHarness, type Harness } from './harness.ts';

/**
 * Cancelling a transfer in transit, and the Stock in transit line of the daily
 * reconciliation (ADR-0020).
 *
 * Runs in its own organisation and restaurants, so that a whole day's reconciliation at a
 * restaurant holds only this file's activity, whatever other files do at the same time.
 */
describe('stock transfer cancel and transit reconciliation (ADR-0020)', () => {
  let h: Harness;
  let appDb: Database;
  let dispatcher: EventDispatcher;
  let orgId: string;
  let sender: string;
  let receiver: string;
  let bystander: string;
  let each: string; // 125 cents each
  let grams: string; // a third of a cent per gram
  const tokens = { senderMgr: '', receiverMgr: '', bystanderMgr: '', crew: '' };

  beforeAll(async () => {
    h = await startHarness();
    appDb = createDb({ connectionString: inject('appUrl'), max: 2 }).db;
    dispatcher = h.app.get(EventDispatcher);
    const tag = randomUUID().slice(0, 8);
    orgId = (
      await h.owner
        .insertInto('organisations')
        .values({ name: `Transfer cancel ${tag}`, slug: `stc-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await sql`select app.create_default_chart(${orgId}::uuid)`.execute(h.owner);
    const brandId = (
      await h.owner
        .insertInto('brands')
        .values({ org_id: orgId, name: 'STC', slug: `stc-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const regionId = (
      await h.owner
        .insertInto('regions')
        .values({ org_id: orgId, name: 'STC region' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const menuId = (
      await h.owner
        .insertInto('menus')
        .values({ org_id: orgId, brand_id: brandId, name: 'STC menu' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const newRestaurant = async () => {
      const slug = `stc-${randomUUID().slice(0, 8)}`;
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
          stock_shortage_policy: 'block',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await h.owner
        .insertInto('stock_locations')
        .values({
          org_id: orgId,
          restaurant_id: r.id,
          code: 'main',
          name: 'Main',
          is_default: true,
        })
        .execute();
      await h.owner
        .insertInto('restaurant_event_sequences')
        .values({ org_id: orgId, restaurant_id: r.id })
        .execute();
      return r.id;
    };
    sender = await newRestaurant();
    receiver = await newRestaurant();
    bystander = await newRestaurant();
    const inv = async (sku: string, unit: string, cost: string) =>
      (
        await h.owner
          .insertInto('inventory_items')
          .values({
            org_id: orgId,
            sku,
            name: `STC ${sku}`,
            base_unit: unit,
            category: 'ingredient',
            standard_unit_cost: cost,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    each = await inv('EACH', 'each', '125');
    grams = await inv('GRAMS', 'g', '0.333333');

    const { password_hash } = await h.owner
      .selectFrom('users')
      .select('password_hash')
      .where('email', '=', 'manager@central.kitchos.test')
      .executeTakeFirstOrThrow();
    const person = async (key: keyof typeof tokens, role: string, scope: string) => {
      const email = `${key.toLowerCase()}-${tag}@stc.test`;
      const user = await h.owner
        .insertInto('users')
        .values({ org_id: orgId, email, display_name: `STC ${key}`, password_hash })
        .returning('id')
        .executeTakeFirstOrThrow();
      await h.owner
        .insertInto('role_assignments')
        .values({
          org_id: orgId,
          user_id: user.id,
          role,
          scope_type: 'restaurant',
          scope_id: scope,
        })
        .execute();
      tokens[key] = await login(h, email);
    };
    await person('senderMgr', 'restaurant_manager', sender);
    await person('receiverMgr', 'restaurant_manager', receiver);
    await person('bystanderMgr', 'restaurant_manager', bystander);
    await person('crew', 'crew_member', sender);

    await h.http
      .post(`/v1/restaurants/${sender}/inventory/receipts`)
      .set(bearer(tokens.senderMgr))
      .set('Idempotency-Key', randomUUID())
      .send({
        lines: [
          { inventoryItemId: each, quantity: '100' },
          { inventoryItemId: grams, quantity: '20000' },
        ],
      })
      .expect(201);
    await drain();
  });

  afterAll(async () => {
    await drain();
    await appDb.destroy();
    await h.close();
  });

  const drain = async () => {
    for (let i = 0; i < 30; i++) {
      if ((await dispatcher.runOnce()).processed === 0) return;
    }
  };
  const path = (rid: string) => `/v1/restaurants/${rid}/inventory/transfers`;
  const send = (lines: object[], key = randomUUID()) =>
    h.http
      .post(path(sender))
      .set(bearer(tokens.senderMgr))
      .set('Idempotency-Key', key)
      .send({ toRestaurantId: receiver, lines });
  const cancel = (token: string, at: string, id: string, body: object, key = randomUUID()) =>
    h.http
      .post(`${path(at)}/${id}/cancel`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send(body);
  const receive = (id: string, lines: object[], key = randomUUID()) =>
    h.http
      .post(`${path(receiver)}/${id}/receive`)
      .set(bearer(tokens.receiverMgr))
      .set('Idempotency-Key', key)
      .send({ lines });
  const onHand = async (rid: string, item: string) => {
    const r = await h.owner
      .selectFrom('stock_balances as b')
      .innerJoin('stock_locations as l', 'l.id', 'b.location_id')
      .select('b.on_hand')
      .where('l.restaurant_id', '=', rid)
      .where('b.inventory_item_id', '=', item)
      .executeTakeFirst();
    return Number(r?.on_hand ?? 0);
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
      ])
      .where('source_type', '=', 'stock_transfer')
      .where('source_id', '=', id)
      .orderBy('movement_type')
      .orderBy('inventory_item_id')
      .execute();
  /** Net debit per system account of the transfer's entries of one type. */
  const entries = async (id: string, entryType: string) => {
    const rows = await h.owner
      .selectFrom('journal_entries as e')
      .innerJoin('journal_lines as l', 'l.entry_id', 'e.id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select([
        'e.id',
        'e.restaurant_id',
        sql<string>`e.business_date::text`.as('day'),
        'a.system_key',
        sql<string>`l.debit_cents - l.credit_cents`.as('net'),
      ])
      .where('e.source_type', '=', 'stock_transfer')
      .where('e.source_id', '=', id)
      .where('e.entry_type', '=', entryType)
      .execute();
    return {
      count: new Set(rows.map((r) => r.id)).size,
      restaurantId: rows[0]?.restaurant_id,
      day: rows[0]?.day,
      net: Object.fromEntries(rows.map((r) => [r.system_key!, Number(r.net)])),
    };
  };
  const reconciliation = async (rid: string, token: string, day: string) =>
    (
      await h.http
        .get(`/v1/restaurants/${rid}/accounting/reconciliation?businessDate=${day}`)
        .set(bearer(token))
        .expect(200)
    ).body as LedgerReconciliation;
  /** All-time Stock in transit at a restaurant. */
  const transitBalance = async (rid: string) =>
    Number(
      (
        await h.owner
          .selectFrom('journal_lines as l')
          .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
          .innerJoin('accounts as a', 'a.id', 'l.account_id')
          .select(sql<string>`coalesce(sum(l.debit_cents - l.credit_cents), 0)`.as('n'))
          .where('e.restaurant_id', '=', rid)
          .where('a.system_key', '=', 'stock_in_transit')
          .executeTakeFirstOrThrow()
      ).n,
    );

  it('cancelling returns the stock at the dispatch cost and clears transit at the sender', async () => {
    const before = { each: await onHand(sender, each), grams: await onHand(sender, grams) };
    const sent = await send([
      { inventoryItemId: each, quantity: '10' },
      { inventoryItemId: grams, quantity: '1000' },
    ]).expect(201);
    const t = sent.body as StockTransferView;
    expect(t.sentCents).toBe(1583); // 10 × 125 + round(333.333)
    await drain();

    // The standard cost changes before the cancel: the return is still valued at what left.
    await h.owner
      .updateTable('inventory_items')
      .set({ standard_unit_cost: '999' })
      .where('id', '=', each)
      .execute();
    const res = await cancel(tokens.senderMgr, sender, t.id, {
      reason: 'Van broke down, stock unloaded',
    })
      .then((r) => r)
      .finally(() =>
        h.owner
          .updateTable('inventory_items')
          .set({ standard_unit_cost: '125' })
          .where('id', '=', each)
          .execute(),
      );
    expect(res.status).toBe(200);
    const c = res.body as StockTransferView;
    expect(c).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'STC senderMgr',
      cancelReason: 'Van broke down, stock unloaded',
      sentCents: 1583,
      returnedCents: 1583,
      receivedCents: null,
      shortageCents: null,
      receivedBy: null,
    });
    expect(c.cancelBusinessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.lines.every((l) => l.quantityReceived === null)).toBe(true);
    expect(await onHand(sender, each)).toBe(before.each);
    expect(await onHand(sender, grams)).toBe(before.grams);
    expect(await onHand(receiver, each)).toBe(0);
    expect(await movements(t.id)).toEqual([
      expect.objectContaining({
        restaurant_id: sender,
        movement_type: 'return_to_stock',
        inventory_item_id: [each, grams].sort()[0],
      }),
      expect.objectContaining({ movement_type: 'return_to_stock' }),
      expect.objectContaining({ movement_type: 'transfer_out' }),
      expect.objectContaining({ movement_type: 'transfer_out' }),
    ]);
    const values = (await movements(t.id)).reduce(
      (acc, m) => ({
        ...acc,
        [m.movement_type]: (acc[m.movement_type] ?? 0) + Number(m.value_cents),
      }),
      {} as Record<string, number>,
    );
    expect(values).toEqual({ transfer_out: -1583, return_to_stock: 1583 });

    await drain();
    const back = await entries(t.id, 'transfer_cancel');
    expect(back).toMatchObject({
      count: 1,
      restaurantId: sender,
      day: c.cancelBusinessDate,
      net: { inventory: 1583, stock_in_transit: -1583 },
    });
    expect((await entries(t.id, 'transfer_out')).net.stock_in_transit).toBe(1583);
    expect((await entries(t.id, 'transfer_in')).count).toBe(0);
    expect(await transitBalance(sender)).toBe(0);

    // Inventory and Stock in transit reconcile on the day, at the sender and the receiver.
    const rec = await reconciliation(sender, tokens.senderMgr, c.cancelBusinessDate!);
    expect(rec.stockMovementsValueCents).toBe(rec.journalInventoryCents);
    expect(rec.transitChangeCents).toBe(rec.journalStockInTransitCents);
    expect(rec.pendingEvents).toBe(0);

    // The receiver can no longer receive it, and it is gone from its Arriving list.
    const late = await receive(t.id, [
      { inventoryItemId: each, quantityReceived: '10' },
      { inventoryItemId: grams, quantityReceived: '1000' },
    ]);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('TRANSFER_CANCELLED');
    const arriving = await h.http
      .get(`${path(receiver)}?direction=incoming&status=in_transit`)
      .set(bearer(tokens.receiverMgr))
      .expect(200);
    expect((arriving.body as StockTransferView[]).map((x) => x.id)).not.toContain(t.id);
    const cancelled = await h.http
      .get(`${path(sender)}?direction=outgoing&status=cancelled`)
      .set(bearer(tokens.senderMgr))
      .expect(200);
    expect((cancelled.body as StockTransferView[]).map((x) => x.id)).toContain(t.id);
    // Both sides see it as cancelled.
    const seen = await h.http
      .get(`${path(receiver)}/${t.id}`)
      .set(bearer(tokens.receiverMgr))
      .expect(200);
    expect(seen.body.status).toBe('cancelled');

    const audit = await h.owner
      .selectFrom('audit_log')
      .select(['action', 'restaurant_id', 'reason'])
      .where('entity_type', '=', 'stock_transfer')
      .where('entity_id', '=', t.id)
      .orderBy('action')
      .execute();
    expect(audit).toEqual([
      {
        action: 'inventory.transfer_cancel',
        restaurant_id: sender,
        reason: 'Van broke down, stock unloaded',
      },
      { action: 'inventory.transfer_dispatch', restaurant_id: sender, reason: null },
    ]);
  });

  it('only the sender cancels, once, with a reason, and only before receipt', async () => {
    const t = (await send([{ inventoryItemId: each, quantity: '2' }]).expect(201))
      .body as StockTransferView;
    // The receiver, a restaurant on neither side and crew without inventory.adjust.
    expect((await cancel(tokens.receiverMgr, receiver, t.id, { reason: 'Not ours' })).status).toBe(
      404,
    );
    expect(
      (await cancel(tokens.bystanderMgr, bystander, t.id, { reason: 'Not ours' })).status,
    ).toBe(404);
    expect((await cancel(tokens.crew, sender, t.id, { reason: 'Changed mind' })).status).toBe(403);
    // The receiver's manager has no access to the sender's restaurant at all.
    expect(
      (await cancel(tokens.receiverMgr, sender, t.id, { reason: 'Changed mind' })).status,
    ).toBe(404);
    // Another organisation, at its own restaurant or at the sender's.
    const rivalMgr = await login(h, 'manager@rival.test');
    const rival = await restaurantId(h, 'rival-southbank');
    expect((await cancel(rivalMgr, rival, t.id, { reason: 'Not ours' })).status).toBe(404);
    expect((await cancel(rivalMgr, sender, t.id, { reason: 'Not ours' })).status).toBe(404);
    // A reason is required.
    for (const body of [{}, { reason: '' }, { reason: ' x ' }, { reason: 'x'.repeat(501) }]) {
      const r = await cancel(tokens.senderMgr, sender, t.id, body);
      expect(r.status).toBe(400);
    }
    const stillOpen = await h.owner
      .selectFrom('stock_transfers')
      .select('status')
      .where('id', '=', t.id)
      .executeTakeFirstOrThrow();
    expect(stillOpen.status).toBe('in_transit');

    // A double tap cancels once; a second cancel is refused.
    const key = randomUUID();
    const first = await cancel(tokens.senderMgr, sender, t.id, { reason: 'Sent by mistake' }, key);
    const again = await cancel(tokens.senderMgr, sender, t.id, { reason: 'Sent by mistake' }, key);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    const twice = await cancel(tokens.senderMgr, sender, t.id, { reason: 'Sent by mistake' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('TRANSFER_CANCELLED');
    const returned = (await movements(t.id)).filter((m) => m.movement_type === 'return_to_stock');
    expect(returned).toHaveLength(1);
    expect(returned[0]!.quantity_delta).toBe('2.000');

    // A received transfer cannot be cancelled: send it back as a new transfer instead.
    const r = (await send([{ inventoryItemId: each, quantity: '1' }]).expect(201))
      .body as StockTransferView;
    await receive(r.id, [{ inventoryItemId: each, quantityReceived: '1' }]).expect(200);
    const refused = await cancel(tokens.senderMgr, sender, r.id, { reason: 'Too late' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('TRANSFER_ALREADY_RECEIVED');
    expect((await movements(r.id)).some((m) => m.movement_type === 'return_to_stock')).toBe(false);
    await drain();
  });

  it('a cancel racing a receipt: exactly one wins and the books agree with what happened', async () => {
    for (let round = 0; round < 6; round++) {
      const t = (
        await send([
          { inventoryItemId: each, quantity: '3' },
          { inventoryItemId: grams, quantity: '300' },
        ]).expect(201)
      ).body as StockTransferView;
      const before = {
        senderEach: await onHand(sender, each),
        receiverEach: await onHand(receiver, each),
      };
      const [c, r] = await Promise.all([
        cancel(tokens.senderMgr, sender, t.id, { reason: `Race ${round}` }),
        receive(t.id, [
          { inventoryItemId: each, quantityReceived: '3' },
          { inventoryItemId: grams, quantityReceived: '300' },
        ]),
      ]);
      const wins = [c.status, r.status].filter((s) => s === 200);
      expect(wins).toHaveLength(1);
      const loser = c.status === 200 ? r : c;
      expect(loser.status).toBe(409);
      expect(['TRANSFER_CANCELLED', 'TRANSFER_ALREADY_RECEIVED']).toContain(loser.body.error.code);

      const types = (await movements(t.id)).map((m) => m.movement_type);
      if (c.status === 200) {
        expect(types.filter((x) => x === 'return_to_stock')).toHaveLength(2);
        expect(types).not.toContain('transfer_in');
        expect(await onHand(sender, each)).toBe(before.senderEach + 3);
        expect(await onHand(receiver, each)).toBe(before.receiverEach);
      } else {
        expect(types.filter((x) => x === 'transfer_in')).toHaveLength(2);
        expect(types).not.toContain('return_to_stock');
        expect(await onHand(sender, each)).toBe(before.senderEach);
        expect(await onHand(receiver, each)).toBe(before.receiverEach + 3);
      }
      await drain();
      expect((await entries(t.id, 'transfer_cancel')).count).toBe(c.status === 200 ? 1 : 0);
      expect((await entries(t.id, 'transfer_in')).count).toBe(r.status === 200 ? 1 : 0);
    }
    // Every transfer of this file is now cancelled or received, so nothing is in transit across
    // the organisation, and each restaurant's transit balance is what its transfers left there.
    expect((await transitBalance(sender)) + (await transitBalance(receiver))).toBe(0);
    const open = await h.owner
      .selectFrom('stock_transfers')
      .select(sql<string>`count(*)`.as('n'))
      .where('org_id', '=', orgId)
      .where('status', '=', 'in_transit')
      .executeTakeFirstOrThrow();
    expect(Number(open.n)).toBe(0);
    const day = (
      await sql<{ d: string }>`select app.business_date(${sender}::uuid, now())::text as d`.execute(
        h.owner,
      )
    ).rows[0]!.d;
    for (const [rid, token] of [
      [sender, tokens.senderMgr],
      [receiver, tokens.receiverMgr],
    ] as const) {
      const rec = await reconciliation(rid, token, day);
      expect(rec.transitChangeCents).toBe(rec.journalStockInTransitCents);
      expect(rec.stockMovementsValueCents).toBe(rec.journalInventoryCents);
      expect(rec.pendingEvents).toBe(0);
      expect(rec.deadLetteredEvents).toBe(0);
    }
  });

  it('the transit line catches a journal that disagrees with the transfers', async () => {
    const t = (await send([{ inventoryItemId: each, quantity: '4' }]).expect(201))
      .body as StockTransferView;
    await drain();
    const day = t.dispatchBusinessDate;
    const ok = await reconciliation(sender, tokens.senderMgr, day);
    expect(ok.transitChangeCents).toBe(ok.journalStockInTransitCents);
    // An entry that moves value out of transit with no transfer behind it.
    await h.owner.transaction().execute(async (tx) => {
      const acct = (key: string) =>
        tx
          .selectFrom('accounts')
          .select('id')
          .where('org_id', '=', orgId)
          .where('system_key', '=', key)
          .executeTakeFirstOrThrow();
      const e = await tx
        .insertInto('journal_entries')
        .values({
          org_id: orgId,
          restaurant_id: sender,
          business_date: day,
          entry_type: 'adjustment',
          source_type: 'test',
          source_id: randomUUID(),
          description: 'Stray transit adjustment',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('journal_lines')
        .values([
          {
            org_id: orgId,
            entry_id: e.id,
            account_id: (await acct('inventory')).id,
            debit_cents: 0,
            credit_cents: 77,
          },
          {
            org_id: orgId,
            entry_id: e.id,
            account_id: (await acct('stock_in_transit')).id,
            debit_cents: 77,
            credit_cents: 0,
          },
        ])
        .execute();
    });
    const bad = await reconciliation(sender, tokens.senderMgr, day);
    expect(bad.journalStockInTransitCents - bad.transitChangeCents).toBe(77);
    expect(bad.reconciled).toBe(false);
    // Put it right with an opposite entry, as the books would.
    await h.owner.transaction().execute(async (tx) => {
      const acct = (key: string) =>
        tx
          .selectFrom('accounts')
          .select('id')
          .where('org_id', '=', orgId)
          .where('system_key', '=', key)
          .executeTakeFirstOrThrow();
      const e = await tx
        .insertInto('journal_entries')
        .values({
          org_id: orgId,
          restaurant_id: sender,
          business_date: day,
          entry_type: 'adjustment',
          source_type: 'test',
          source_id: randomUUID(),
          description: 'Reverse stray transit adjustment',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('journal_lines')
        .values([
          {
            org_id: orgId,
            entry_id: e.id,
            account_id: (await acct('inventory')).id,
            debit_cents: 77,
            credit_cents: 0,
          },
          {
            org_id: orgId,
            entry_id: e.id,
            account_id: (await acct('stock_in_transit')).id,
            debit_cents: 0,
            credit_cents: 77,
          },
        ])
        .execute();
    });
    const fixed = await reconciliation(sender, tokens.senderMgr, day);
    expect(fixed.transitChangeCents).toBe(fixed.journalStockInTransitCents);
    await cancel(tokens.senderMgr, sender, t.id, { reason: 'Tidy up' }).expect(200);
    await drain();
  });

  it('the database allows one change only, and a cancel needs who, when and why', async () => {
    const t = (await send([{ inventoryItemId: each, quantity: '1' }]).expect(201))
      .body as StockTransferView;
    const asApp = (q: ReturnType<typeof sql>) =>
      appDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.org_id', ${orgId}, true)`.execute(tx);
        return q.execute(tx);
      });
    // Cancelled without a reason or a person.
    await expect(
      asApp(sql`update stock_transfers set status = 'cancelled', version = version + 1
                 where id = ${t.id}::uuid`),
    ).rejects.toThrow(/stock_transfers_cancel_complete/);
    // Cancelled with a line already recorded as arrived (transfer guard switched off to
    // record the line; the whole transaction is rolled back).
    await expect(
      h.owner.transaction().execute(async (trx) => {
        await sql`alter table stock_transfer_lines disable trigger stock_transfer_lines_guard`.execute(
          trx,
        );
        await sql`update stock_transfer_lines set quantity_received = 1
                   where stock_transfer_id = ${t.id}::uuid`.execute(trx);
        await sql`update stock_transfers set status = 'cancelled', cancelled_by = dispatched_by,
                   cancelled_at = now(), cancel_business_date = current_date, cancel_reason = 'test'
                   where id = ${t.id}::uuid`.execute(trx);
      }),
    ).rejects.toThrow(/lines recorded as arrived/);

    await cancel(tokens.senderMgr, sender, t.id, { reason: 'Stayed here' }).expect(200);
    // Once cancelled: never received, never back in transit, never rewritten or deleted.
    for (const q of [
      sql`update stock_transfers set status = 'in_transit' where id = ${t.id}::uuid`,
      sql`update stock_transfers set status = 'received', received_by = cancelled_by,
            received_at = now(), receive_business_date = current_date where id = ${t.id}::uuid`,
      sql`update stock_transfers set cancel_reason = 'Rewritten' where id = ${t.id}::uuid`,
      sql`update stock_transfer_lines set quantity_received = 1 where stock_transfer_id = ${t.id}::uuid`,
    ]) {
      await expect(asApp(q)).rejects.toThrow(/already cancelled/);
    }
    await expect(asApp(sql`delete from stock_transfers where id = ${t.id}::uuid`)).rejects.toThrow(
      /permission denied|never deleted/,
    );
    const row = await h.owner
      .selectFrom('stock_transfers')
      .select(['status', 'cancel_reason'])
      .where('id', '=', t.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'cancelled', cancel_reason: 'Stayed here' });
    await drain();
  });
});
