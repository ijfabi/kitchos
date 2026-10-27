import { randomUUID } from 'node:crypto';
import type { JournalEntryView, KitchenTaskView, OrderView } from '@kitchos/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher, MAX_ATTEMPTS } from '../src/events/event-dispatcher.service.ts';
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

describe('double-entry journal from domain events', () => {
  let h: Harness;
  let centralId: string;
  let crew: string;
  let manager: string;
  let dispatcher: EventDispatcher;

  beforeAll(async () => {
    h = await startHarness();
    centralId = await restaurantId(h, CENTRAL);
    crew = await login(h, 'crew1@central.kitchos.test');
    manager = await login(h, 'manager@central.kitchos.test');
    dispatcher = h.app.get(EventDispatcher);
  });
  afterAll(() => h.close());

  /** Drives an accepted order through every kitchen task and hands it off. */
  const complete = async (order: OrderView) => {
    const tasks = (await h.http.get(`/v1/restaurants/${centralId}/kitchen/tasks`).set(bearer(crew)))
      .body as KitchenTaskView[];
    for (const t of tasks.filter((x) => x.orderId === order.id)) {
      await h.http
        .post(`/v1/restaurants/${centralId}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(crew))
        .send({})
        .expect(200);
    }
    await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/handoff`)
      .set(bearer(crew))
      .expect(200);
  };
  const entriesFor = async (sourceId: string) => {
    const entries = await h.owner
      .selectFrom('journal_entries')
      .select(['id', 'entry_type', 'business_date'])
      .where('source_id', '=', sourceId)
      .execute();
    const out: Record<string, Record<string, number>> = {};
    for (const e of entries) {
      const lines = await h.owner
        .selectFrom('journal_lines as l')
        .innerJoin('accounts as a', 'a.id', 'l.account_id')
        .select(['a.system_key', 'l.debit_cents', 'l.credit_cents'])
        .where('l.entry_id', '=', e.id)
        .execute();
      out[e.entry_type] = Object.fromEntries(
        lines.map((l) => [l.system_key!, l.debit_cents - l.credit_cents]),
      );
    }
    return out;
  };
  const paymentId = async (orderId: string) =>
    (
      await h.owner
        .selectFrom('payments')
        .select('id')
        .where('order_id', '=', orderId)
        .where('status', '=', 'captured')
        .executeTakeFirstOrThrow()
    ).id;
  const today = async () =>
    (
      await sql<{
        d: string;
      }>`select app.business_date(${centralId}::uuid, now())::text as d`.execute(h.owner)
    ).rows[0]!.d;

  it('card sale: payment is a deposit liability; revenue and GST are recognised at handoff', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Bacon Deluxe').id, quantity: 1 },
    ]);
    expect((await dispatcher.runOnce()).processed).toBeGreaterThan(0);

    const pid = await paymentId(order.id);
    expect(await entriesFor(pid)).toEqual({
      payment_receipt: { card_clearing: 1290, customer_deposits: -1290 },
    });
    expect(await entriesFor(order.id)).toEqual({}); // not yet earned

    await complete(order);
    await dispatcher.runOnce();
    // 1290 incl. GST 117 -> revenue 1173 ex GST.
    expect(await entriesFor(order.id)).toEqual({
      sale_recognition: { customer_deposits: 1290, sales_revenue: -1173, gst_payable: -117 },
    });
  });

  it('discounted cash sale with rounding posts rounding and discount ex GST', async () => {
    const menu = await getMenu(h, CENTRAL);
    const placed = await h.http
      .post(`/v1/restaurants/${centralId}/orders`)
      .set(bearer(crew))
      .set('Idempotency-Key', randomUUID())
      .send({
        fulfilmentType: 'dine_in',
        lines: [{ menuItemId: item(menu, 'Cheeseburger Meal').id, quantity: 1 }],
      })
      .expect(201);
    const order = placed.body as OrderView;
    await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/discount`)
      .set(bearer(crew))
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'percent', value: 1000, reason: 'customer_service' })
      .expect(200);
    await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/payments`)
      .set(bearer(crew))
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'cash', tenderedCents: 2000 })
      .expect(200);
    await complete(order);
    await dispatcher.runOnce();

    expect(await entriesFor(await paymentId(order.id))).toEqual({
      payment_receipt: { cash_on_hand: 1160, cash_rounding: 1, customer_deposits: -1161 },
    });
    expect(await entriesFor(order.id)).toEqual({
      sale_recognition: {
        customer_deposits: 1161,
        sales_discounts: 118,
        sales_revenue: -1173,
        gst_payable: -106,
      },
    });
  });

  it('redelivery is a no-op: the inbox and the journal source key both prevent double posting', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Medium Fries').id, quantity: 1 },
    ]);
    await dispatcher.runOnce();
    const count = async () =>
      Number(
        (
          await h.owner
            .selectFrom('journal_entries')
            .select((x) => x.fn.countAll<string>().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      );
    const before = await count();
    expect((await dispatcher.runOnce()).processed).toBe(0);

    // Simulate at-least-once redelivery: forget that the consumer saw the event.
    const evt = await h.owner
      .selectFrom('outbox_events')
      .select('id')
      .where('aggregate_id', '=', await paymentId(order.id))
      .where('event_type', '=', 'payment.captured')
      .executeTakeFirstOrThrow();
    await h.owner.deleteFrom('inbox_events').where('event_id', '=', evt.id).execute();
    expect((await dispatcher.runOnce()).processed).toBe(1); // handled again...
    expect(await count()).toBe(before); // ...but nothing new was posted
  });

  it('the database rejects unbalanced, edited or closed-period entries — even from the owner', async () => {
    const accounts = await h.owner
      .selectFrom('accounts as a')
      .innerJoin('restaurants as r', 'r.org_id', 'a.org_id')
      .select(['a.id', 'a.org_id', 'a.system_key'])
      .where('r.id', '=', centralId)
      .execute();
    const acct = (k: string) => accounts.find((a) => a.system_key === k)!;
    const orgId = accounts[0]!.org_id;

    const attempt = (date: string, lines: [string, number, number][]) =>
      h.owner.transaction().execute(async (tx) => {
        const e = await tx
          .insertInto('journal_entries')
          .values({
            org_id: orgId,
            restaurant_id: centralId,
            business_date: date,
            entry_type: 'adjustment',
            source_type: 'test',
            source_id: randomUUID(),
            description: 'test',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        for (const [k, d, c] of lines) {
          await tx
            .insertInto('journal_lines')
            .values({
              org_id: orgId,
              entry_id: e.id,
              account_id: acct(k).id,
              debit_cents: d,
              credit_cents: c,
            })
            .execute();
        }
      });
    const day = await today();
    await expect(
      attempt(day, [
        ['cash_on_hand', 100, 0],
        ['sales_revenue', 0, 99],
      ]),
    ).rejects.toThrow(/KITCHOS_UNBALANCED/);
    await expect(attempt(day, [['cash_on_hand', 100, 0]])).rejects.toThrow(/KITCHOS_UNBALANCED/);
    await expect(
      h.owner.updateTable('journal_lines').set({ memo: 'edited' }).execute(),
    ).rejects.toThrow(/KITCHOS_APPEND_ONLY/);

    await h.owner
      .insertInto('accounting_periods')
      .values({
        org_id: orgId,
        period_start: '2020-01-01',
        period_end: '2020-01-31',
        status: 'closed',
        closed_at: new Date(),
      })
      .execute();
    try {
      await expect(
        attempt('2020-01-15', [
          ['cash_on_hand', 100, 0],
          ['sales_revenue', 0, 100],
        ]),
      ).rejects.toThrow(/KITCHOS_PERIOD_CLOSED/);
    } finally {
      await h.owner
        .deleteFrom('accounting_periods')
        .where('org_id', '=', orgId)
        .where('period_start', '=', '2020-01-01')
        .execute();
    }
    await expect(
      attempt(day, [
        ['cash_on_hand', 100, 0],
        ['sales_revenue', 0, 100],
      ]),
    ).resolves.toBeUndefined();

    // A posted entry can never gain lines later — not even balanced pairs, not even by the owner.
    const posted = await h.owner
      .selectFrom('journal_entries')
      .select('id')
      .where('org_id', '=', orgId)
      .limit(1)
      .executeTakeFirstOrThrow();
    await expect(
      h.owner.transaction().execute(async (tx) => {
        for (const [k, d, c] of [
          ['cash_on_hand', 500, 0],
          ['sales_revenue', 0, 500],
        ] as const) {
          await tx
            .insertInto('journal_lines')
            .values({
              org_id: orgId,
              entry_id: posted.id,
              account_id: acct(k).id,
              debit_cents: d,
              credit_cents: c,
            })
            .execute();
        }
      }),
    ).rejects.toThrow(/KITCHOS_APPEND_ONLY/);
    // ...and the runtime role is held to the same rule.
    const { createDb, withTenant } = await import('@kitchos/database');
    const { inject } = await import('vitest');
    const { db: app } = createDb({ connectionString: inject('appUrl'), max: 1 });
    try {
      await expect(
        withTenant(app, { orgId }, (tx) =>
          tx
            .insertInto('journal_lines')
            .values({
              org_id: orgId,
              entry_id: posted.id,
              account_id: acct('cash_on_hand').id,
              debit_cents: 1,
              credit_cents: 0,
            })
            .execute(),
        ),
      ).rejects.toThrow(/KITCHOS_APPEND_ONLY/);
    } finally {
      await app.destroy();
    }
  });

  it('reconciliation of a past day is not affected by today’s backlog', async () => {
    const menu = await getMenu(h, CENTRAL);
    await placeAndPay(h, CENTRAL, [{ menuItemId: item(menu, 'Medium Lemonade').id, quantity: 1 }]); // pending today
    const past = await h.http
      .get(`/v1/restaurants/${centralId}/accounting/reconciliation?businessDate=2026-01-15`)
      .set(bearer(manager))
      .expect(200);
    expect(past.body).toMatchObject({ pendingEvents: 0, deadLetteredEvents: 0, reconciled: true });
    await dispatcher.runOnce();
  });

  it('a failing event retries with backoff, is dead-lettered after the limit and never blocks others', async () => {
    const rivalId = await restaurantId(h, 'rival-southbank');
    const rivalOrg = (
      await h.owner
        .selectFrom('restaurants')
        .select('org_id')
        .where('id', '=', rivalId)
        .executeTakeFirstOrThrow()
    ).org_id;
    const poison = await h.owner
      .insertInto('outbox_events')
      .values({
        org_id: rivalOrg,
        restaurant_id: rivalId,
        store_sequence: 900_000 + Math.floor(Math.random() * 99_999),
        aggregate_type: 'payment',
        aggregate_id: randomUUID(), // no such payment
        aggregate_version: 1,
        event_type: 'payment.captured',
        payload: JSON.stringify({}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const failure = () =>
      h.owner
        .selectFrom('event_consumer_failures')
        .selectAll()
        .where('event_id', '=', poison.id)
        .executeTakeFirst();

    // A healthy event in another tenant is processed in the same pass.
    const menu = await getMenu(h, CENTRAL);
    const healthy = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Medium Cola').id, quantity: 1 },
    ]);
    const first = await dispatcher.runOnce();
    expect(first.failed).toBe(1);
    expect(Object.keys(await entriesFor(await paymentId(healthy.id)))).toEqual(['payment_receipt']);
    expect(await failure()).toMatchObject({ attempts: 1, dead_at: null });
    expect((await failure())!.last_error).toMatch(/not found/);

    expect((await dispatcher.runOnce()).failed).toBe(0); // backing off
    for (let i = 2; i <= MAX_ATTEMPTS; i++) {
      await h.owner
        .updateTable('event_consumer_failures')
        .set({ next_attempt_at: new Date(Date.now() - 1000) })
        .where('event_id', '=', poison.id)
        .execute();
      const s = await dispatcher.runOnce();
      expect(s.failed).toBe(1);
      expect(s.deadLettered).toBe(i === MAX_ATTEMPTS ? 1 : 0);
    }
    const dead = await failure();
    expect(dead!.attempts).toBe(MAX_ATTEMPTS);
    expect(dead!.dead_at).not.toBeNull();
    await h.owner
      .updateTable('event_consumer_failures')
      .set({ next_attempt_at: new Date(Date.now() - 1000) })
      .where('event_id', '=', poison.id)
      .execute();
    expect((await dispatcher.runOnce()).failed).toBe(0); // dead letters are not retried
  });

  it('trial balance balances and the journal reconciles to orders and payments', async () => {
    await dispatcher.runOnce();
    const day = await today();
    const tb = await h.http
      .get(`/v1/restaurants/${centralId}/accounting/trial-balance?from=${day}&to=${day}`)
      .set(bearer(manager))
      .expect(200);
    expect(tb.body.balanced).toBe(true);
    expect(tb.body.totalDebitCents).toBeGreaterThan(0);
    expect(tb.body.totalDebitCents).toBe(tb.body.totalCreditCents);

    const rec = await h.http
      .get(`/v1/restaurants/${centralId}/accounting/reconciliation?businessDate=${day}`)
      .set(bearer(manager))
      .expect(200);
    expect(rec.body).toMatchObject({ pendingEvents: 0, deadLetteredEvents: 0, reconciled: true });
    expect(rec.body.journalNetSalesCents).toBe(rec.body.completedOrdersNetCents);
    expect(rec.body.journalReceiptsCents).toBe(rec.body.capturedPaymentsCents);

    // A captured payment whose event has not been processed shows up as a backlog.
    const menu = await getMenu(h, CENTRAL);
    await placeAndPay(h, CENTRAL, [{ menuItemId: item(menu, 'Latte').id, quantity: 1 }]);
    const stale = await h.http
      .get(`/v1/restaurants/${centralId}/accounting/reconciliation?businessDate=${day}`)
      .set(bearer(manager))
      .expect(200);
    expect(stale.body).toMatchObject({ pendingEvents: 1, reconciled: false });
    await dispatcher.runOnce();

    const journal = await h.http
      .get(`/v1/restaurants/${centralId}/accounting/journal?from=${day}&to=${day}&limit=5`)
      .set(bearer(manager))
      .expect(200);
    for (const e of journal.body as JournalEntryView[]) {
      const d = e.lines.reduce((s, l) => s + l.debitCents, 0);
      const c = e.lines.reduce((s, l) => s + l.creditCents, 0);
      expect(d).toBe(c);
    }
  });

  it('journal access follows reporting permissions and tenant boundaries', async () => {
    const day = await today();
    const path = `/v1/restaurants/${centralId}/accounting/journal?from=${day}&to=${day}`;
    const rival = await login(h, 'manager@rival.test');
    const area = await login(h, 'area.cbd@kitchos.test');
    expect((await h.http.get(path).set(bearer(crew))).status).toBe(403);
    expect((await h.http.get(path).set(bearer(rival))).status).toBe(404);
    expect((await h.http.get(path).set(bearer(area))).status).toBe(200);
    expect(
      (
        await h.http
          .get(`/v1/restaurants/${centralId}/accounting/trial-balance?from=${day}&to=2000-01-01`)
          .set(bearer(manager))
      ).status,
    ).toBe(400);
  });
});
