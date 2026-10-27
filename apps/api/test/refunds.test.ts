import { randomUUID } from 'node:crypto';
import type { KitchenTaskView, OrderView } from '@kitchos/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
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

describe('refunds and payment reversal', () => {
  let h: Harness;
  let centralId: string;
  let crew: string;
  let supervisor: string;
  let manager: string;
  let dispatcher: EventDispatcher;

  beforeAll(async () => {
    h = await startHarness();
    centralId = await restaurantId(h, CENTRAL);
    crew = await login(h, 'crew1@central.kitchos.test');
    supervisor = await login(h, 'supervisor@central.kitchos.test');
    manager = await login(h, 'manager@central.kitchos.test');
    dispatcher = h.app.get(EventDispatcher);
  });
  afterAll(() => h.close());

  const refund = (token: string, orderId: string, body: object, key = randomUUID()) =>
    h.http
      .post(`/v1/restaurants/${centralId}/orders/${orderId}/refunds`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send(body);
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
  /** Journal lines of refund entries for an order, keyed by refund id. */
  const refundEntries = async (orderId: string) => {
    const rows = await h.owner
      .selectFrom('journal_entries as e')
      .innerJoin('refunds as f', 'f.id', 'e.source_id')
      .innerJoin('journal_lines as l', 'l.entry_id', 'e.id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['f.id', 'a.system_key', 'l.debit_cents', 'l.credit_cents'])
      .where('e.entry_type', '=', 'refund')
      .where('f.order_id', '=', orderId)
      .orderBy('f.id')
      .execute();
    const out = new Map<string, Record<string, number>>();
    for (const r of rows) {
      out.set(r.id, { ...(out.get(r.id) ?? {}), [r.system_key!]: r.debit_cents - r.credit_cents });
    }
    return [...out.values()];
  };
  const movementCount = async () =>
    Number(
      (
        await h.owner
          .selectFrom('stock_movements')
          .select((x) => x.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );

  it('refunding a cancelled paid order returns the deposit and nothing else', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Cheeseburger').id, quantity: 1 },
    ]);
    await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/cancel`)
      .set(bearer(supervisor))
      .send({ reason: 'Customer left' })
      .expect(200);
    const movementsBefore = await movementCount();

    const res = await refund(supervisor, order.id, { reason: 'cancelled_order' });
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({
      status: 'refunded',
      amountCents: 790,
      refundedCents: 790,
    });
    expect(res.body.refunds).toEqual([
      expect.objectContaining({
        amountCents: 790,
        method: 'card',
        treatment: 'deposit_release',
        requestedBy: 'Tom Okafor',
      }),
    ]);
    expect(await movementCount()).toBe(movementsBefore); // refunds never touch stock

    await dispatcher.runOnce();
    expect(await refundEntries(order.id)).toEqual([
      { customer_deposits: 790, card_clearing: -790 },
    ]);
    const deposits = await h.owner
      .selectFrom('journal_lines as l')
      .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(sql<number>`sum(l.credit_cents - l.debit_cents)`.as('net'))
      .where('a.system_key', '=', 'customer_deposits')
      .where('e.source_id', 'in', [
        res.body.refunds[0].id,
        (
          await h.owner
            .selectFrom('payments')
            .select('id')
            .where('order_id', '=', order.id)
            .executeTakeFirstOrThrow()
        ).id,
      ])
      .executeTakeFirstOrThrow();
    expect(Number(deposits.net)).toBe(0); // the liability is cleared
  });

  it('partial refunds after handover are sales returns whose GST shares add up to the order GST', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Bacon Deluxe').id, quantity: 1 },
    ]);
    await complete(order);
    const baconAfterCooking = await balance(h, CENTRAL, 'BACON');

    const first = await refund(supervisor, order.id, {
      amountCents: 500,
      reason: 'quality',
      note: 'Bun was stale',
    });
    expect(first.status).toBe(201);
    expect(first.body.payment).toMatchObject({ status: 'partially_refunded', refundedCents: 500 });
    const rest = await refund(supervisor, order.id, { reason: 'quality' }); // defaults to the remainder
    expect(rest.body.payment).toMatchObject({ status: 'refunded', refundedCents: 1290 });
    expect(
      rest.body.refunds.map((r: { amountCents: number; treatment: string }) => [
        r.amountCents,
        r.treatment,
      ]),
    ).toEqual([
      [500, 'sales_return'],
      [790, 'sales_return'],
    ]);
    const third = await refund(supervisor, order.id, { amountCents: 1, reason: 'quality' });
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('ALREADY_REFUNDED');
    expect(await balance(h, CENTRAL, 'BACON')).toEqual(baconAfterCooking); // invariant 11

    await dispatcher.runOnce();
    // GST 117 on 1290: first share round(500Ã—117/1290)=45, second 117âˆ’45=72.
    expect(await refundEntries(order.id)).toEqual([
      { sales_returns: 455, gst_payable: 45, card_clearing: -500 },
      { sales_returns: 718, gst_payable: 72, card_clearing: -790 },
    ]);
  });

  it('cash refunds hand back the rounded amount and post the rounding', async () => {
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

    const res = await refund(manager, order.id, { reason: 'order_error' });
    expect(res.status).toBe(201);
    expect(res.body.refunds[0]).toMatchObject({
      method: 'cash',
      amountCents: 1161,
      cashReturnedCents: 1160,
    });
    await dispatcher.runOnce();
    expect(await refundEntries(order.id)).toEqual([
      { sales_returns: 1055, gst_payable: 106, cash_on_hand: -1160, cash_rounding: -1 },
    ]);
  });

  it('never refunds more than was captured, even under concurrent requests', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Bacon Deluxe').id, quantity: 1 },
    ]);
    await complete(order);
    expect(
      (await refund(supervisor, order.id, { amountCents: 1291, reason: 'quality' })).body.error,
    ).toMatchObject({
      code: 'REFUND_EXCEEDS_PAYMENT',
      details: { refundableCents: 1290 },
    });
    const results = await Promise.all([
      refund(supervisor, order.id, { amountCents: 700, reason: 'quality' }),
      refund(manager, order.id, { amountCents: 700, reason: 'quality' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    const payment = await h.owner
      .selectFrom('payments')
      .select(['refunded_cents', 'status'])
      .where('order_id', '=', order.id)
      .executeTakeFirstOrThrow();
    expect(payment).toEqual({ refunded_cents: 700, status: 'partially_refunded' });
    const rows = await h.owner
      .selectFrom('refunds')
      .select('id')
      .where('order_id', '=', order.id)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('refunds need a paid, finished order and the right permission, and are idempotent', async () => {
    const menu = await getMenu(h, CENTRAL);
    const unpaid = (
      await h.http
        .post(`/v1/restaurants/${centralId}/orders`)
        .set(bearer(crew))
        .set('Idempotency-Key', randomUUID())
        .send({
          fulfilmentType: 'dine_in',
          lines: [{ menuItemId: item(menu, 'Medium Fries').id, quantity: 1 }],
        })
    ).body as OrderView;
    expect((await refund(supervisor, unpaid.id, { reason: 'other' })).body.error.code).toBe(
      'REFUND_NOT_ALLOWED',
    );
    const inKitchen = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Medium Fries').id, quantity: 1 },
    ]);
    expect((await refund(supervisor, inKitchen.id, { reason: 'other' })).body.error.code).toBe(
      'REFUND_NOT_ALLOWED',
    );

    await complete(inKitchen);
    expect((await refund(crew, inKitchen.id, { reason: 'other' })).status).toBe(403);
    const expressManager = await login(h, 'manager@express.kitchos.test');
    const expressId = await restaurantId(h, 'kitchos-express');
    const cross = await h.http
      .post(`/v1/restaurants/${expressId}/orders/${inKitchen.id}/refunds`)
      .set(bearer(expressManager))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'other' });
    expect(cross.status).toBe(404);

    const key = randomUUID();
    expect(
      (await refund(supervisor, inKitchen.id, { amountCents: 100, reason: 'other' }, key)).status,
    ).toBe(201);
    const replay = await refund(
      supervisor,
      inKitchen.id,
      { amountCents: 100, reason: 'other' },
      key,
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(
      await h.owner
        .selectFrom('refunds')
        .select('id')
        .where('order_id', '=', inKitchen.id)
        .execute(),
    ).toHaveLength(1);
    const auditRow = await h.owner
      .selectFrom('audit_log')
      .select(['action', 'reason'])
      .where('action', '=', 'payment.refund')
      .where('entity_id', '=', replay.body.refunds[0].id)
      .executeTakeFirstOrThrow();
    expect(auditRow).toEqual({ action: 'payment.refund', reason: 'other' });
  });

  it('the journal reconciles refunds for the day and the stock ledger is untouched', async () => {
    await dispatcher.runOnce();
    const { rows } = await sql<{
      d: string;
    }>`select app.business_date(${centralId}::uuid, now())::text as d`.execute(h.owner);
    const rec = await h.http
      .get(`/v1/restaurants/${centralId}/accounting/reconciliation?businessDate=${rows[0]!.d}`)
      .set(bearer(manager))
      .expect(200);
    expect(rec.body.refundsCents).toBeGreaterThan(0);
    expect(rec.body).toMatchObject({ reconciled: true, pendingEvents: 0 });
    expect(rec.body.journalRefundsCents).toBe(rec.body.refundsCents);
    expect(await reconciliationErrors(h)).toEqual([]);
  });
});
