import { randomUUID } from 'node:crypto';
import type { KitchenTaskView, OrderLineInput, OrderView } from '@kitchos/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import {
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

describe('refunds under adversarial conditions', () => {
  let h: Harness;
  let dispatcher: EventDispatcher;
  let centralId: string;
  let expressId: string;
  let rivalId: string;
  let crew: string;
  let supervisor: string;
  let manager: string;
  let expressManager: string;
  let rivalManager: string;
  let auditor: string;
  let menu: Awaited<ReturnType<typeof getMenu>>;

  beforeAll(async () => {
    h = await startHarness();
    dispatcher = h.app.get(EventDispatcher);
    centralId = await restaurantId(h, CENTRAL);
    expressId = await restaurantId(h, 'kitchos-express');
    rivalId = await restaurantId(h, 'rival-southbank');
    crew = await login(h, 'crew1@central.kitchos.test');
    supervisor = await login(h, 'supervisor@central.kitchos.test');
    manager = await login(h, 'manager@central.kitchos.test');
    expressManager = await login(h, 'manager@express.kitchos.test');
    rivalManager = await login(h, 'manager@rival.test');
    auditor = await login(h, 'auditor@kitchos.test');
    menu = await getMenu(h, CENTRAL);
    await dispatcher.runOnce();
  });
  afterAll(() => h.close());

  // ------------------------------------------------------------------ helpers

  const refund = (
    token: string,
    orderId: string,
    body: object,
    key = randomUUID(),
    rid = centralId,
  ) =>
    h.http
      .post(`/v1/restaurants/${rid}/orders/${orderId}/refunds`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send(body);

  const staffOrder = async (lines: OrderLineInput[]): Promise<OrderView> => {
    const res = await h.http
      .post(`/v1/restaurants/${centralId}/orders`)
      .set(bearer(supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({ fulfilmentType: 'dine_in', lines });
    expect(res.status).toBe(201);
    return res.body as OrderView;
  };
  const discount = (orderId: string, body: object) =>
    h.http
      .post(`/v1/restaurants/${centralId}/orders/${orderId}/discount`)
      .set(bearer(supervisor))
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const cashPay = (orderId: string, tenderedCents: number) =>
    h.http
      .post(`/v1/restaurants/${centralId}/orders/${orderId}/payments`)
      .set(bearer(supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'cash', tenderedCents });

  /** Completes every kitchen task of the order, leaving it 'ready'. */
  const makeReady = async (orderId: string) => {
    const tasks = (await h.http.get(`/v1/restaurants/${centralId}/kitchen/tasks`).set(bearer(crew)))
      .body as KitchenTaskView[];
    for (const t of tasks.filter((x) => x.orderId === orderId)) {
      await h.http
        .post(`/v1/restaurants/${centralId}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(crew))
        .send({})
        .expect(200);
    }
    expect(await orderStatus(orderId)).toBe('ready');
  };
  const handoff = (orderId: string) =>
    h.http.post(`/v1/restaurants/${centralId}/orders/${orderId}/handoff`).set(bearer(crew));
  const complete = async (orderId: string) => {
    await makeReady(orderId);
    await handoff(orderId).expect(200);
  };
  const orderStatus = async (orderId: string) =>
    (
      await h.owner
        .selectFrom('orders')
        .select('status')
        .where('id', '=', orderId)
        .executeTakeFirstOrThrow()
    ).status;

  const cardOrder = (name: string) =>
    placeAndPay(h, CENTRAL, [{ menuItemId: item(menu, name).id, quantity: 1 }]);

  const refundRows = (orderId: string) =>
    h.owner
      .selectFrom('refunds')
      .select(['id', 'amount_cents', 'cash_rounding_cents', 'treatment', 'method'])
      .where('order_id', '=', orderId)
      .orderBy('id')
      .execute();
  const paymentRow = (orderId: string) =>
    h.owner
      .selectFrom('payments')
      .select([
        'id',
        'amount_cents',
        'refunded_cents',
        'status',
        'cash_rounding_cents',
        'tendered_cents',
        'change_cents',
      ])
      .where('order_id', '=', orderId)
      .where('status', 'in', ['captured', 'partially_refunded', 'refunded'])
      .executeTakeFirstOrThrow();
  const orderRow = (orderId: string) =>
    h.owner
      .selectFrom('orders')
      .select(['total_cents', 'tax_cents', 'discount_cents', 'status'])
      .where('id', '=', orderId)
      .executeTakeFirstOrThrow();

  /** Net balance (debit − credit) by account for the refund entries of an order. */
  const refundJournal = async (orderId: string) => {
    const rows = await h.owner
      .selectFrom('journal_entries as e')
      .innerJoin('refunds as f', 'f.id', 'e.source_id')
      .innerJoin('journal_lines as l', 'l.entry_id', 'e.id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['e.id as entry_id', 'a.system_key', 'l.debit_cents', 'l.credit_cents'])
      .where('e.entry_type', '=', 'refund')
      .where('f.order_id', '=', orderId)
      .execute();
    const byKey: Record<string, number> = {};
    for (const r of rows)
      byKey[r.system_key!] =
        (byKey[r.system_key!] ?? 0) + Number(r.debit_cents) - Number(r.credit_cents);
    return { entries: new Set(rows.map((r) => r.entry_id)).size, byKey };
  };

  /** Customer deposits liability for one order (credit − debit) across receipt, sale and refund entries. */
  const depositsNet = async (orderId: string) => {
    const payments = await h.owner
      .selectFrom('payments')
      .select('id')
      .where('order_id', '=', orderId)
      .execute();
    const refunds = await h.owner
      .selectFrom('refunds')
      .select('id')
      .where('order_id', '=', orderId)
      .execute();
    const sources = [orderId, ...payments.map((p) => p.id), ...refunds.map((r) => r.id)];
    const row = await h.owner
      .selectFrom('journal_lines as l')
      .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(sql<string>`coalesce(sum(l.credit_cents - l.debit_cents), 0)`.as('net'))
      .where('a.system_key', '=', 'customer_deposits')
      .where('e.source_id', 'in', sources)
      .executeTakeFirstOrThrow();
    return Number(row.net);
  };

  /** Snapshot of the stock ledger: movement count plus every balance at central. */
  const stockSnapshot = async () => {
    const n = await h.owner
      .selectFrom('stock_movements')
      .select((x) => x.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    const balances = await h.owner
      .selectFrom('stock_balances as b')
      .innerJoin('stock_locations as l', 'l.id', 'b.location_id')
      .select(['b.inventory_item_id', 'b.on_hand', 'b.reserved'])
      .where('l.restaurant_id', '=', centralId)
      .orderBy('b.inventory_item_id')
      .execute();
    return { movements: Number(n.n), balances };
  };

  // Scoped to Central: other test files deliberately dead-letter poison events in other tenants.
  const deadLettered = async () =>
    Number(
      (
        await h.owner
          .selectFrom('event_consumer_failures as f')
          .innerJoin('outbox_events as o', 'o.id', 'f.event_id')
          .select((x) => x.fn.countAll<string>().as('n'))
          .where('f.dead_at', 'is not', null)
          .where('o.restaurant_id', '=', centralId)
          .executeTakeFirstOrThrow()
      ).n,
    );

  // ------------------------------------------------------------------ scenarios

  it('8 concurrent 200c refunds on a 1290c order never over-refund and the journal ties out', async () => {
    const order = await cardOrder('Bacon Deluxe');
    await complete(order.id);
    const { total_cents: total, tax_cents: tax } = await orderRow(order.id);
    expect(total).toBe(1290);
    const before = await stockSnapshot();

    const tokens = [supervisor, manager];
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        refund(tokens[i % 2]!, order.id, {
          amountCents: 200,
          reason: 'quality',
          note: `attempt ${i}`,
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 201, 201, 201, 201, 422, 422]);
    for (const r of results.filter((x) => x.status === 422)) {
      expect(r.body.error).toMatchObject({
        code: 'REFUND_EXCEEDS_PAYMENT',
        details: { refundableCents: 90 },
      });
    }

    const rows = await refundRows(order.id);
    const payment = await paymentRow(order.id);
    expect(rows).toHaveLength(6);
    expect(payment.refunded_cents).toBe(rows.reduce((s, r) => s + Number(r.amount_cents), 0));
    expect(payment).toMatchObject({ refunded_cents: 1200, status: 'partially_refunded' });
    expect(rows.every((r) => r.treatment === 'sales_return')).toBe(true);
    expect(await stockSnapshot()).toEqual(before); // invariant 11

    await dispatcher.runOnce();
    let j = await refundJournal(order.id);
    expect(j.entries).toBe(6);
    expect(j.byKey.gst_payable ?? 0).toBeLessThanOrEqual(tax);
    expect(-(j.byKey.card_clearing ?? 0)).toBe(1200);

    // Remainder; GST shares must then add up to exactly the order GST.
    const rest = await refund(manager, order.id, { reason: 'quality' });
    expect(rest.status).toBe(201);
    expect(rest.body.payment).toMatchObject({ status: 'refunded', refundedCents: 1290 });
    await dispatcher.runOnce();
    j = await refundJournal(order.id);
    expect(j.entries).toBe(7);
    expect(j.byKey.gst_payable).toBe(tax);
    expect(j.byKey.sales_returns).toBe(total - tax);
    expect(await depositsNet(order.id)).toBe(0);
  });

  it('concurrent duplicates with one Idempotency-Key refund exactly once', async () => {
    const order = await cardOrder('Cheeseburger');
    await complete(order.id);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        refund(supervisor, order.id, { amountCents: 100, reason: 'other' }, key),
      ),
    );
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(await refundRows(order.id)).toHaveLength(1);
    expect((await paymentRow(order.id)).refunded_cents).toBe(100);
  });

  it('refund racing handoff on a ready order is rejected or a sales return, and deposits never go negative', async () => {
    for (let i = 0; i < 4; i++) {
      const order = await cardOrder('Cheeseburger');
      await makeReady(order.id);
      const [ho, rf] = await Promise.all([
        handoff(order.id),
        refund(supervisor, order.id, { reason: 'quality' }),
      ]);
      expect(ho.status).toBe(200);
      expect(await orderStatus(order.id)).toBe('completed');
      if (rf.status === 201) {
        expect(rf.body.refunds).toEqual([
          expect.objectContaining({ amountCents: 790, treatment: 'sales_return' }),
        ]);
      } else {
        expect(rf.status).toBe(409);
        expect(rf.body.error.code).toBe('REFUND_NOT_ALLOWED');
        expect(await refundRows(order.id)).toHaveLength(0);
      }
      const rows = await refundRows(order.id);
      expect(rows.every((r) => r.treatment === 'sales_return')).toBe(true);
      await dispatcher.runOnce();
      const net = await depositsNet(order.id);
      expect(net).toBeGreaterThanOrEqual(0);
      expect(net).toBe(0); // completed: receipt credited, sale debited, returns do not touch deposits
    }
  });

  it('refund racing cancel on a ready order is rejected or a deposit release', async () => {
    for (let i = 0; i < 4; i++) {
      const order = await cardOrder('Cheeseburger');
      await makeReady(order.id);
      const before = await stockSnapshot();
      const [cx, rf] = await Promise.all([
        h.http
          .post(`/v1/restaurants/${centralId}/orders/${order.id}/cancel`)
          .set(bearer(manager))
          .send({ reason: 'Customer walked out' }),
        refund(manager, order.id, { reason: 'cancelled_order' }),
      ]);
      expect(cx.status).toBe(200);
      expect(await orderStatus(order.id)).toBe('cancelled');
      if (rf.status === 201) {
        expect(rf.body.refunds).toEqual([
          expect.objectContaining({ amountCents: 790, treatment: 'deposit_release' }),
        ]);
      } else {
        expect(rf.status).toBe(409);
        expect(rf.body.error.code).toBe('REFUND_NOT_ALLOWED');
        // Cancelled now: a follow-up refund is a deposit release.
        const later = await refund(manager, order.id, { reason: 'cancelled_order' });
        expect(later.status).toBe(201);
        expect(later.body.refunds[0]).toMatchObject({
          treatment: 'deposit_release',
          amountCents: 790,
        });
      }
      // Cancelling a ready order does not touch on-hand stock either way; refunds certainly not.
      const after = await stockSnapshot();
      expect(after.movements).toBe(before.movements);
      await dispatcher.runOnce();
      expect(await depositsNet(order.id)).toBe(0);
      const j = await refundJournal(order.id);
      expect(j.byKey).toEqual({ customer_deposits: 790, card_clearing: -790 });
    }
  });

  it('idempotency keys are scoped per order, reject a changed body and replay the stored result', async () => {
    const a = await cardOrder('Cheeseburger');
    const b = await cardOrder('Bacon Deluxe');
    await complete(a.id);
    await complete(b.id);
    const key = randomUUID();

    const first = await refund(supervisor, a.id, { amountCents: 150, reason: 'quality' }, key);
    expect(first.status).toBe(201);
    expect(first.body.id).toBe(a.id);

    // Same key + same body against another order: must not replay order A's response or touch A.
    const other = await refund(supervisor, b.id, { amountCents: 150, reason: 'quality' }, key);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(other.status).toBe(201);
    expect(other.body.id).toBe(b.id);
    expect(other.body.refunds).toHaveLength(1);
    expect((await paymentRow(a.id)).refunded_cents).toBe(150);
    expect((await paymentRow(b.id)).refunded_cents).toBe(150);

    // Same key, different amount on A -> 422, nothing changes.
    const changed = await refund(supervisor, a.id, { amountCents: 151, reason: 'quality' }, key);
    expect(changed.status).toBe(422);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await refundRows(a.id)).toHaveLength(1);

    // Another refund, then replay the first key: stored response, no new row.
    expect((await refund(supervisor, a.id, { amountCents: 200, reason: 'quality' })).status).toBe(
      201,
    );
    const replay = await refund(supervisor, a.id, { amountCents: 150, reason: 'quality' }, key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(a.id);
    expect(replay.body.refunds[0]).toMatchObject({
      id: first.body.refunds[0].id,
      amountCents: 150,
    });
    expect(await refundRows(a.id)).toHaveLength(2);
    expect((await paymentRow(a.id)).refunded_cents).toBe(350);

    // Same key used by another user in the same org on the same order: still the same request.
    const byManager = await refund(manager, a.id, { amountCents: 150, reason: 'quality' }, key);
    expect(byManager.headers['idempotent-replayed']).toBe('true');
    expect(await refundRows(a.id)).toHaveLength(2);
  });

  it('a discounted cash order fully refunded hands back exactly the cash the customer paid', async () => {
    const order = await staffOrder([{ menuItemId: item(menu, 'Bacon Deluxe').id, quantity: 1 }]);
    expect(
      (await discount(order.id, { kind: 'amount', value: 333, reason: 'customer_service' })).status,
    ).toBe(200);
    const paid = await cashPay(order.id, 2000);
    expect(paid.status).toBe(200);
    await complete(order.id);
    const o = await orderRow(order.id);
    expect(o.total_cents).toBe(957);
    const p = await paymentRow(order.id);
    const cashTakenIn = Number(p.tendered_cents) - Number(p.change_cents);
    expect(cashTakenIn).toBe(p.amount_cents + p.cash_rounding_cents);

    const res = await refund(manager, order.id, { reason: 'order_error' });
    expect(res.status).toBe(201);
    expect(res.body.refunds[0]).toMatchObject({
      method: 'cash',
      amountCents: 957,
      cashReturnedCents: cashTakenIn,
    });

    await dispatcher.runOnce();
    const j = await refundJournal(order.id);
    expect(j.entries).toBe(1);
    expect(j.byKey.gst_payable).toBe(o.tax_cents);
    expect(-(j.byKey.cash_on_hand ?? 0)).toBe(cashTakenIn);
  });

  it('partial cash refunds never hand back more cash than the customer paid', async () => {
    const order = await staffOrder([{ menuItemId: item(menu, 'Cheeseburger').id, quantity: 1 }]);
    expect((await cashPay(order.id, 1000)).status).toBe(200);
    await complete(order.id);
    const p = await paymentRow(order.id);
    const cashTakenIn = Number(p.tendered_cents) - Number(p.change_cents);
    expect(cashTakenIn).toBe(790);

    for (const amountCents of [3, 3]) {
      expect((await refund(manager, order.id, { amountCents, reason: 'order_error' })).status).toBe(
        201,
      );
    }
    const last = await refund(manager, order.id, { reason: 'order_error' });
    expect(last.status).toBe(201);
    const returned = (last.body as OrderView).refunds.reduce(
      (s, r) => s + (r.cashReturnedCents ?? 0),
      0,
    );
    // Regression (found by adversarial testing): each cash refund used to be rounded
    // independently, so 3c + 3c + 784c handed back 5 + 5 + 785 = 795c against 790c received.
    await dispatcher.runOnce();
    expect(returned).toBeLessThanOrEqual(cashTakenIn);
    expect(returned).toBe(cashTakenIn); // fully refunded: exactly the cash taken
  });

  it('a comp order (100% discount, no payment) cannot be refunded', async () => {
    const order = await staffOrder([{ menuItemId: item(menu, 'Medium Fries').id, quantity: 1 }]);
    const comp = await discount(order.id, {
      kind: 'percent',
      value: 10_000,
      reason: 'complimentary',
    });
    expect(comp.status).toBe(200);
    expect(comp.body.totalCents).toBe(0);
    expect(comp.body.payment).toBeNull();
    await complete(order.id);
    const res = await refund(manager, order.id, { reason: 'other' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_REFUNDABLE_PAYMENT');
    const tiny = await refund(manager, order.id, { amountCents: 1, reason: 'other' });
    expect(tiny.status).toBe(409);
    expect(await refundRows(order.id)).toHaveLength(0);
  });

  it('cross-tenant, cross-restaurant, under-privileged and malformed refunds create nothing', async () => {
    const order = await cardOrder('Cheeseburger');
    await complete(order.id);
    const before = await stockSnapshot();

    const attempts = [
      { name: 'crew', res: await refund(crew, order.id, { reason: 'other' }), expect: [403] },
      { name: 'auditor', res: await refund(auditor, order.id, { reason: 'other' }), expect: [403] },
      {
        name: 'express manager on central',
        res: await refund(expressManager, order.id, { reason: 'other' }),
        expect: [404],
      },
      {
        name: 'express manager via express path',
        res: await refund(expressManager, order.id, { reason: 'other' }, randomUUID(), expressId),
        expect: [404],
      },
      {
        name: 'rival on central',
        res: await refund(rivalManager, order.id, { reason: 'other' }),
        expect: [404],
      },
      {
        name: 'rival via own path',
        res: await refund(rivalManager, order.id, { reason: 'other' }, randomUUID(), rivalId),
        expect: [404],
      },
      {
        name: 'zero',
        res: await refund(manager, order.id, { amountCents: 0, reason: 'other' }),
        expect: [400],
      },
      {
        name: 'negative',
        res: await refund(manager, order.id, { amountCents: -500, reason: 'other' }),
        expect: [400],
      },
      {
        name: 'fraction',
        res: await refund(manager, order.id, { amountCents: 10.5, reason: 'other' }),
        expect: [400],
      },
      {
        name: 'string',
        res: await refund(manager, order.id, { amountCents: '100', reason: 'other' }),
        expect: [400],
      },
      {
        name: 'bad reason',
        res: await refund(manager, order.id, { reason: 'because' }),
        expect: [400],
      },
      {
        name: 'long note',
        res: await refund(manager, order.id, { reason: 'other', note: 'x'.repeat(501) }),
        expect: [400],
      },
      {
        name: 'no key',
        res: await h.http
          .post(`/v1/restaurants/${centralId}/orders/${order.id}/refunds`)
          .set(bearer(manager))
          .send({ reason: 'other' }),
        expect: [400],
      },
      {
        name: 'unknown order',
        res: await refund(manager, randomUUID(), { reason: 'other' }),
        expect: [404],
      },
    ];
    for (const a of attempts)
      expect({
        name: a.name,
        status: a.res.status,
        ok: a.expect.includes(a.res.status),
      }).toMatchObject({ name: a.name, ok: true });
    expect(await refundRows(order.id)).toHaveLength(0);
    expect(await paymentRow(order.id)).toMatchObject({ refunded_cents: 0, status: 'captured' });
    expect(await stockSnapshot()).toEqual(before);
  });

  it('after all of the above the books balance and reconcile for the day', async () => {
    await dispatcher.runOnce();
    expect(await deadLettered()).toBe(0);
    const { rows } = await sql<{
      d: string;
    }>`select app.business_date(${centralId}::uuid, now())::text as d`.execute(h.owner);
    const day = rows[0]!.d;
    const tb = await h.http
      .get(`/v1/restaurants/${centralId}/accounting/trial-balance?from=${day}&to=${day}`)
      .set(bearer(manager))
      .expect(200);
    expect(tb.body.balanced).toBe(true);
    const rec = await h.http
      .get(`/v1/restaurants/${centralId}/accounting/reconciliation?businessDate=${day}`)
      .set(bearer(manager))
      .expect(200);
    expect(rec.body).toMatchObject({ reconciled: true, pendingEvents: 0, deadLetteredEvents: 0 });
    expect(rec.body.journalRefundsCents).toBe(rec.body.refundsCents);
    // No order may have refunded more than it captured.
    const { rows: over } = await sql<{ id: string }>`
      select p.id from payments p
      where p.refunded_cents <> coalesce((select sum(f.amount_cents) from refunds f where f.payment_id = p.id), 0)
         or p.refunded_cents > p.amount_cents`.execute(h.owner);
    expect(over).toEqual([]);
    expect(await reconciliationErrors(h)).toEqual([]);
  });
});
