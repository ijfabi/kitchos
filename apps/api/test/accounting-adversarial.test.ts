import { randomUUID } from 'node:crypto';
import type { KitchenTaskView, OrderView } from '@kitchos/contracts';
import { inclusiveTax } from '@kitchos/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher, MAX_ATTEMPTS } from '../src/events/event-dispatcher.service.ts';
import {
  balance,
  bearer,
  ensureDrawer,
  getMenu,
  item,
  login,
  option,
  placeAndPay,
  restaurantId,
  setAvailable,
  startHarness,
  type Harness,
} from './harness.ts';

const CENTRAL = 'kitchos-central';
const DRIVE = 'kitchos-drive';
const RIVAL = 'rival-southbank';
const LEDGER_TYPES = ['payment.captured', 'order.completed'];

describe('ledger under adversarial conditions', () => {
  let h: Harness;
  let dispatcher: EventDispatcher;
  let centralId: string;
  let driveId: string;
  let rivalId: string;
  let centralOrg: string;
  let rivalOrg: string;
  let crew: string;
  let supervisor: string;
  let manager: string;
  let driveManager: string;
  let rivalManager: string;

  beforeAll(async () => {
    h = await startHarness();
    dispatcher = h.app.get(EventDispatcher);
    centralId = await restaurantId(h, CENTRAL);
    driveId = await restaurantId(h, DRIVE);
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
    crew = await login(h, 'crew1@central.kitchos.test');
    supervisor = await login(h, 'supervisor@central.kitchos.test');
    manager = await login(h, 'manager@central.kitchos.test');
    driveManager = await login(h, 'manager@drive.kitchos.test');
    rivalManager = await login(h, 'manager@rival.test');
    for (const t of [crew, supervisor, manager]) await ensureDrawer(h, t, CENTRAL);
    // Start from a drained queue so deltas below are attributable to this file.
    await dispatcher.runOnce();
  });
  afterAll(() => h.close());

  // ------------------------------------------------------------------ helpers

  const complete = async (restId: string, token: string, orderId: string) => {
    const tasks = (await h.http.get(`/v1/restaurants/${restId}/kitchen/tasks`).set(bearer(token)))
      .body as KitchenTaskView[];
    for (const t of tasks.filter((x) => x.orderId === orderId)) {
      await h.http
        .post(`/v1/restaurants/${restId}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(token))
        .send({})
        .expect(200);
    }
    await h.http
      .post(`/v1/restaurants/${restId}/orders/${orderId}/handoff`)
      .set(bearer(token))
      .expect(200);
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

  const discount = (token: string, orderId: string, body: object) =>
    h.http
      .post(`/v1/restaurants/${centralId}/orders/${orderId}/discount`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send(body);

  const entryRows = (sourceId: string) =>
    h.owner
      .selectFrom('journal_entries')
      .select(['id', 'entry_type', 'org_id', 'restaurant_id'])
      .where('source_id', '=', sourceId)
      .execute();

  /** Net debit (debit − credit) per system account, per entry type, for one source. */
  const entriesFor = async (sourceId: string) => {
    const out: Record<string, Record<string, number>> = {};
    for (const e of await entryRows(sourceId)) {
      const lines = await h.owner
        .selectFrom('journal_lines as l')
        .innerJoin('accounts as a', 'a.id', 'l.account_id')
        .select(['a.system_key', 'l.debit_cents', 'l.credit_cents'])
        .where('l.entry_id', '=', e.id)
        .execute();
      const d = lines.reduce((s, l) => s + Number(l.debit_cents), 0);
      const c = lines.reduce((s, l) => s + Number(l.credit_cents), 0);
      expect(d, `entry ${e.id} balances`).toBe(c);
      expect(d).toBeGreaterThan(0);
      out[e.entry_type] = {};
      for (const l of lines) {
        out[e.entry_type]![l.system_key!] =
          (out[e.entry_type]![l.system_key!] ?? 0) + Number(l.debit_cents) - Number(l.credit_cents);
      }
    }
    return out;
  };

  const capturedPayments = (orderId: string) =>
    h.owner
      .selectFrom('payments')
      .select(['id', 'amount_cents'])
      .where('order_id', '=', orderId)
      .where('status', '=', 'captured')
      .execute();

  /** Sale entry must equal the order: revenue − discounts = total − GST, GST = tax. */
  const assertSaleMatchesOrder = async (orderId: string) => {
    const o = await h.owner
      .selectFrom('orders')
      .select(['total_cents', 'tax_cents', 'discount_cents', 'subtotal_cents', 'status'])
      .where('id', '=', orderId)
      .executeTakeFirstOrThrow();
    expect(o.status).toBe('completed');
    const sale = (await entriesFor(orderId)).sale_recognition;
    expect(sale, 'sale_recognition entry').toBeDefined();
    const revenue = 0 - (sale!.sales_revenue ?? 0);
    const discounts = sale!.sales_discounts ?? 0;
    expect(revenue - discounts).toBe(Number(o.total_cents) - Number(o.tax_cents));
    expect(0 - (sale!.gst_payable ?? 0)).toBe(Number(o.tax_cents));
    expect(sale!.customer_deposits ?? 0).toBe(Number(o.total_cents));
    return { order: o, sale: sale! };
  };

  const businessDate = async (restId: string) =>
    (
      await sql<{
        d: string;
      }>`select app.business_date(${restId}::uuid, now())::text as d`.execute(h.owner)
    ).rows[0]!.d;

  const ledgerEventIds = async (aggregateIds: string[]) =>
    (
      await h.owner
        .selectFrom('outbox_events')
        .select('id')
        .where('aggregate_id', 'in', aggregateIds)
        .where('event_type', 'in', LEDGER_TYPES)
        .execute()
    ).map((r) => r.id);

  const journalCount = async () =>
    Number(
      (
        await h.owner
          .selectFrom('journal_entries')
          .select((x) => x.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );

  const ensureRivalStock = async () => {
    const b = await balance(h, RIVAL, 'BUN');
    if (b.onHand - b.reserved < 5) await setAvailable(h, RIVAL, 'BUN', 20);
  };

  const rivalCompletedOrder = async () => {
    const menu = await getMenu(h, RIVAL);
    const order = await placeAndPay(h, RIVAL, [
      { menuItemId: item(menu, 'Plain Burger').id, quantity: 1 },
    ]);
    await complete(rivalId, rivalManager, order.id);
    return order;
  };

  // ---------------------------------------------------------------- concurrency

  it('two app instances dispatching concurrently post each source exactly once', async () => {
    const menu = await getMenu(h, CENTRAL);
    const orders: OrderView[] = [];
    for (let i = 0; i < 10; i++) {
      orders.push(
        await placeAndPay(h, CENTRAL, [{ menuItemId: item(menu, 'Medium Cola').id, quantity: 1 }]),
      );
    }
    // Half of them are handed over too, so both event types race.
    for (const o of orders.slice(0, 5)) await complete(centralId, crew, o.id);

    const h2 = await startHarness();
    try {
      const d2 = h2.app.get(EventDispatcher);
      // runOnce coalesces within one instance.
      const a1 = dispatcher.runOnce();
      const a2 = dispatcher.runOnce();
      expect(a1).toBe(a2);
      const b1 = d2.runOnce();
      const [sa, sb] = await Promise.all([a1, b1, a2, d2.runOnce()]);
      const myEvents = await ledgerEventIds([
        ...orders.map((o) => o.id),
        ...(await Promise.all(orders.map(async (o) => (await capturedPayments(o.id))[0]!.id))),
      ]);
      expect(myEvents).toHaveLength(15);
      expect(sa!.processed + sb!.processed).toBeGreaterThanOrEqual(15);

      // None missed: every event claimed after one concurrent pass.
      const inbox = await h.owner
        .selectFrom('inbox_events')
        .select('event_id')
        .where('consumer', '=', 'ledger')
        .where('event_id', 'in', myEvents)
        .execute();
      expect(inbox).toHaveLength(15);

      // No duplicates: exactly one entry per (source, type).
      for (const [i, o] of orders.entries()) {
        const [p] = await capturedPayments(o.id);
        const pe = await entryRows(p!.id);
        expect(pe.map((e) => e.entry_type)).toEqual(['payment_receipt']);
        const oe = await entryRows(o.id);
        expect(oe.map((e) => e.entry_type)).toEqual(i < 5 ? ['sale_recognition'] : []);
        if (i < 5) await assertSaleMatchesOrder(o.id);
      }
    } finally {
      await h2.close();
    }
    // Hand over the rest so nothing is left half-done.
    for (const o of orders.slice(5)) await complete(centralId, crew, o.id);
    await dispatcher.runOnce();
    for (const o of orders) await assertSaleMatchesOrder(o.id);
  });

  it('a replay storm (inbox wiped for many events, two workers) posts nothing new', async () => {
    const menu = await getMenu(h, CENTRAL);
    const orders: OrderView[] = [];
    for (let i = 0; i < 6; i++) {
      const o = await placeAndPay(h, CENTRAL, [
        { menuItemId: item(menu, 'Medium Fries').id, quantity: 1 },
      ]);
      await complete(centralId, crew, o.id);
      orders.push(o);
    }
    await dispatcher.runOnce();
    const payIds = (await Promise.all(orders.map((o) => capturedPayments(o.id)))).map(
      (p) => p[0]!.id,
    );
    const events = await ledgerEventIds([...orders.map((o) => o.id), ...payIds]);
    expect(events).toHaveLength(12);
    const before = await journalCount();
    const linesBefore = Number(
      (
        await h.owner
          .selectFrom('journal_lines')
          .select((x) => x.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );

    const h2 = await startHarness();
    try {
      for (let round = 0; round < 3; round++) {
        await h.owner
          .deleteFrom('inbox_events')
          .where('consumer', '=', 'ledger')
          .where('event_id', 'in', events)
          .execute();
        const [a, b] = await Promise.all([
          dispatcher.runOnce(),
          h2.app.get(EventDispatcher).runOnce(),
        ]);
        expect(a.processed + b.processed).toBeGreaterThanOrEqual(12);
        expect(a.failed + b.failed).toBe(0);
        expect(await journalCount()).toBe(before);
      }
    } finally {
      await h2.close();
    }
    const linesAfter = Number(
      (
        await h.owner
          .selectFrom('journal_lines')
          .select((x) => x.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );
    expect(linesAfter).toBe(linesBefore);
    for (const o of orders) await assertSaleMatchesOrder(o.id);
  });

  // ---------------------------------------------------------------------- money

  it('cash rounding down with an amount discount: rounding is a debit, revenue stays exact', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await ring([{ menuItemId: item(menu, 'Cheeseburger Meal').id, quantity: 1 }]);
    const d = await discount(crew, order.id, {
      kind: 'amount',
      value: 3,
      reason: 'customer_service',
    });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ subtotalCents: 1290, discountCents: 3, totalCents: 1287 });
    await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/payments`)
      .set(bearer(crew))
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'cash', tenderedCents: 2000 })
      .expect(200);
    await complete(centralId, crew, order.id);
    await dispatcher.runOnce();

    const [p] = await capturedPayments(order.id);
    // 1287 rounds down to 1285: customer pays 2c less, a rounding expense.
    expect(await entriesFor(p!.id)).toEqual({
      payment_receipt: { cash_on_hand: 1285, cash_rounding: 2, customer_deposits: -1287 },
    });
    const { sale } = await assertSaleMatchesOrder(order.id);
    expect(sale).toEqual({
      customer_deposits: 1287,
      sales_discounts: 3,
      sales_revenue: -1173,
      gst_payable: -117,
    });
  });

  it('a 100% complimentary order handed over posts discount = revenue and no receipt', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await ring([{ menuItemId: item(menu, 'Cheeseburger Meal').id, quantity: 2 }]);
    const res = await discount(supervisor, order.id, {
      kind: 'percent',
      value: 10_000,
      reason: 'complimentary',
      note: 'adversarial ledger test',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalCents: 0, taxCents: 0, status: 'accepted' });
    await complete(centralId, crew, order.id);
    await dispatcher.runOnce();

    expect(await capturedPayments(order.id)).toHaveLength(0);
    const { sale } = await assertSaleMatchesOrder(order.id);
    // 2580 incl. GST 235 -> 2345 ex GST, fully discounted.
    expect(sale).toEqual({ sales_discounts: 2345, sales_revenue: -2345 });
  });

  it('paid then cancelled: receipt posted, no sale, the deposit stays a liability', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Bacon Deluxe').id, quantity: 1 },
    ]);
    await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/cancel`)
      .set(bearer(manager))
      .send({ reason: 'customer left' })
      .expect(200);
    await dispatcher.runOnce();
    const [p] = await capturedPayments(order.id);
    expect(await entriesFor(p!.id)).toEqual({
      payment_receipt: { card_clearing: 1290, customer_deposits: -1290 },
    });
    expect(await entriesFor(order.id)).toEqual({});
    const orderEvents = await h.owner
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', order.id)
      .execute();
    expect(orderEvents.map((e) => e.event_type)).toContain('order.cancelled');
    expect(orderEvents.map((e) => e.event_type)).not.toContain('order.completed');
  });

  it('multi-line order with modifiers, combos and quantities: GST cross-check holds', async () => {
    const menu = await getMenu(h, CENTRAL);
    const bacon = item(menu, 'Bacon Deluxe');
    const latte = item(menu, 'Latte');
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: bacon.id, quantity: 3, modifierOptionIds: [option(bacon, 'Extra cheese')] },
      { menuItemId: item(menu, 'Cheeseburger Meal').id, quantity: 2 },
      { menuItemId: latte.id, quantity: 1, modifierOptionIds: [option(latte, 'Oat milk')] },
      { menuItemId: item(menu, 'Medium Fries').id, quantity: 7 },
    ]);
    await complete(centralId, crew, order.id);
    await dispatcher.runOnce();
    const { order: o, sale } = await assertSaleMatchesOrder(order.id);
    expect(Number(o.tax_cents)).toBe(inclusiveTax(Number(o.total_cents), 1000));
    expect(sale.sales_discounts).toBeUndefined();
    const [p] = await capturedPayments(order.id);
    expect((await entriesFor(p!.id)).payment_receipt).toEqual({
      card_clearing: Number(o.total_cents),
      customer_deposits: -Number(o.total_cents),
    });
  });

  // ------------------------------------------------------------ failure handling

  it('a poison event does not block later events of the same restaurant', async () => {
    await ensureRivalStock();
    const poison = await h.owner
      .insertInto('outbox_events')
      .values({
        org_id: rivalOrg,
        restaurant_id: rivalId,
        // Sorts BEFORE every real event of the restaurant.
        store_sequence: -1 - Math.floor(Math.random() * 1_000_000_000),
        aggregate_type: 'order',
        aggregate_id: randomUUID(),
        aggregate_version: 1,
        event_type: 'order.completed',
        payload: JSON.stringify({}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    try {
      const order = await rivalCompletedOrder();
      const s = await dispatcher.runOnce();
      expect(s.failed).toBe(1);
      const f = await h.owner
        .selectFrom('event_consumer_failures')
        .selectAll()
        .where('event_id', '=', poison.id)
        .executeTakeFirstOrThrow();
      expect(f).toMatchObject({ attempts: 1, dead_at: null, org_id: rivalOrg });
      expect(Object.keys(await entriesFor((await capturedPayments(order.id))[0]!.id))).toEqual([
        'payment_receipt',
      ]);
      await assertSaleMatchesOrder(order.id);
    } finally {
      // Dead-letter it so no later pass (in any test file) keeps failing on it.
      await h.owner
        .updateTable('event_consumer_failures')
        .set({ attempts: MAX_ATTEMPTS, dead_at: new Date(), updated_at: new Date() })
        .where('event_id', '=', poison.id)
        .execute();
    }
  });

  it('events in a closed period fail and retry (never silently dropped), then post once reopened', async () => {
    await ensureRivalStock();
    await dispatcher.runOnce(); // drain
    const day = await businessDate(rivalId);
    const period = await h.owner
      .insertInto('accounting_periods')
      .values({
        org_id: rivalOrg,
        period_start: day,
        period_end: day,
        status: 'closed',
        closed_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    let order: OrderView | undefined;
    let events: string[] = [];
    try {
      order = await rivalCompletedOrder();
      const [p] = await capturedPayments(order.id);
      events = await ledgerEventIds([order.id, p!.id]);
      expect(events).toHaveLength(2);

      const s = await dispatcher.runOnce();
      expect(s.failed).toBe(2);
      expect(s.deadLettered).toBe(0);
      const failures = await h.owner
        .selectFrom('event_consumer_failures')
        .selectAll()
        .where('event_id', 'in', events)
        .execute();
      expect(failures).toHaveLength(2);
      for (const f of failures) {
        expect(f.last_error).toMatch(/KITCHOS_PERIOD_CLOSED/);
        expect(f.dead_at).toBeNull();
      }
      // Not claimed and not posted: still pending.
      expect(
        await h.owner
          .selectFrom('inbox_events')
          .select('event_id')
          .where('event_id', 'in', events)
          .execute(),
      ).toHaveLength(0);
      expect(await entryRows(order.id)).toHaveLength(0);
      expect(await entryRows(p!.id)).toHaveLength(0);

      // Reconciliation reports the backlog instead of claiming success.
      const rec = await h.http
        .get(`/v1/restaurants/${rivalId}/accounting/reconciliation?businessDate=${day}`)
        .set(bearer(rivalManager))
        .expect(200);
      expect(rec.body.pendingEvents).toBeGreaterThanOrEqual(2);
      expect(rec.body.reconciled).toBe(false);

      // Retrying while still closed keeps failing.
      await h.owner
        .updateTable('event_consumer_failures')
        .set({ next_attempt_at: new Date(Date.now() - 1000) })
        .where('event_id', 'in', events)
        .execute();
      expect((await dispatcher.runOnce()).failed).toBe(2);
    } finally {
      await h.owner.deleteFrom('accounting_periods').where('id', '=', period.id).execute();
      if (events.length) {
        await h.owner
          .updateTable('event_consumer_failures')
          .set({ next_attempt_at: new Date(Date.now() - 1000) })
          .where('event_id', 'in', events)
          .where('dead_at', 'is', null)
          .execute();
        await dispatcher.runOnce();
      }
    }
    const [p] = await capturedPayments(order!.id);
    expect((await entryRows(p!.id)).map((e) => e.entry_type)).toEqual(['payment_receipt']);
    await assertSaleMatchesOrder(order!.id);
    // Rival-sourced entries carry only Rival's tenant ids.
    for (const e of [...(await entryRows(order!.id)), ...(await entryRows(p!.id))]) {
      expect(e.org_id).toBe(rivalOrg);
      expect(e.restaurant_id).toBe(rivalId);
    }
  });

  // ------------------------------------------------------------ tenant isolation

  it('rival staff cannot read Central accounting', async () => {
    const day = await businessDate(centralId);
    for (const path of [
      `journal?from=${day}&to=${day}`,
      `trial-balance?from=${day}&to=${day}`,
      `reconciliation?businessDate=${day}`,
      `business-date`,
    ]) {
      const res = await h.http
        .get(`/v1/restaurants/${centralId}/accounting/${path}`)
        .set(bearer(rivalManager));
      expect(res.status, path).toBe(404);
    }
    // And Rival's own trial balance shows only Rival's chart.
    const tb = await h.http
      .get(`/v1/restaurants/${rivalId}/accounting/trial-balance?from=2020-01-01&to=${day}`)
      .set(bearer(rivalManager))
      .expect(200);
    expect(tb.body.balanced).toBe(true);
    const rivalCodes = await h.owner
      .selectFrom('accounts')
      .select('code')
      .where('org_id', '=', rivalOrg)
      .where('active', '=', true)
      .execute();
    expect(tb.body.accounts).toHaveLength(rivalCodes.length);
  });

  it('every journal row references only its own tenant', async () => {
    const q = async (query: ReturnType<typeof sql<{ n: string }>>) =>
      Number((await query.execute(h.owner)).rows[0]!.n);
    expect(
      await q(sql`select count(*) as n from journal_entries e join restaurants r on r.id = e.restaurant_id
                  where r.org_id <> e.org_id`),
    ).toBe(0);
    expect(
      await q(sql`select count(*) as n from journal_lines l join accounts a on a.id = l.account_id
                  where a.org_id <> l.org_id`),
    ).toBe(0);
    expect(
      await q(sql`select count(*) as n from journal_lines l join journal_entries e on e.id = l.entry_id
                  where e.org_id <> l.org_id`),
    ).toBe(0);
    expect(
      await q(sql`select count(*) as n from journal_entries e join outbox_events o on o.id = e.source_event_id
                  where o.org_id <> e.org_id or o.restaurant_id <> e.restaurant_id`),
    ).toBe(0);
    expect(
      await q(sql`select count(*) as n from journal_entries e join payments p on p.id = e.source_id
                  where e.source_type = 'payment'
                    and (p.org_id <> e.org_id or p.restaurant_id <> e.restaurant_id)`),
    ).toBe(0);
    expect(
      await q(sql`select count(*) as n from journal_entries e join orders o on o.id = e.source_id
                  where e.source_type = 'order'
                    and (o.org_id <> e.org_id or o.restaurant_id <> e.restaurant_id)`),
    ).toBe(0);
    // Rival's events were posted under Rival only; Central's org never appears on them.
    expect(
      await q(sql`select count(*) as n from journal_entries e join outbox_events o on o.id = e.source_event_id
                  where o.org_id = ${rivalOrg}::uuid and e.org_id = ${centralOrg}::uuid`),
    ).toBe(0);
    expect(
      await q(sql`select count(*) as n from journal_entries e
                  where e.org_id = ${rivalOrg}::uuid and e.restaurant_id <> ${rivalId}::uuid`),
    ).toBe(0);
  });

  // ------------------------------------------------------------ global invariant

  it('globally: debits equal credits per restaurant; TB balanced; Central and Drive reconcile today', async () => {
    await dispatcher.runOnce();
    const { rows } = await sql<{ restaurant_id: string; d: string; c: string }>`
      select e.restaurant_id, sum(l.debit_cents)::text as d, sum(l.credit_cents)::text as c
      from journal_lines l join journal_entries e on e.id = l.entry_id
      group by e.restaurant_id`.execute(h.owner);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.d, `restaurant ${r.restaurant_id}`).toBe(r.c);

    for (const [restId, token] of [
      [centralId, manager],
      [driveId, driveManager],
    ] as const) {
      const day = await businessDate(restId);
      const tb = await h.http
        .get(`/v1/restaurants/${restId}/accounting/trial-balance?from=2020-01-01&to=${day}`)
        .set(bearer(token))
        .expect(200);
      expect(tb.body.balanced).toBe(true);
      expect(tb.body.totalDebitCents).toBe(tb.body.totalCreditCents);
      const rec = await h.http
        .get(`/v1/restaurants/${restId}/accounting/reconciliation?businessDate=${day}`)
        .set(bearer(token))
        .expect(200);
      expect(rec.body, restId).toMatchObject({
        pendingEvents: 0,
        deadLetteredEvents: 0,
        reconciled: true,
      });
    }
  });
});
