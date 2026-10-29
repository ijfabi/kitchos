import { randomUUID } from 'node:crypto';
import type { OrderView } from '@kitchos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  balance,
  bearer,
  ensureDrawer,
  getMenu,
  item,
  login,
  option,
  reconciliationErrors,
  restaurantId,
  startHarness,
  type Harness,
} from './harness.ts';

const CENTRAL = 'kitchos-central';

describe('POS: staff order entry, cash and card tender, park / recall / void', () => {
  let h: Harness;
  let centralId: string;
  let crew: string;

  beforeAll(async () => {
    h = await startHarness();
    centralId = await restaurantId(h, CENTRAL);
    crew = await login(h, 'crew1@central.kitchos.test');
    await ensureDrawer(h, crew, CENTRAL);
  });
  afterAll(() => h.close());

  const ring = (
    token: string,
    rid: string,
    lines: object[],
    extra: object = {},
    key = randomUUID(),
  ) =>
    h.http
      .post(`/v1/restaurants/${rid}/orders`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send({ fulfilmentType: 'dine_in', lines, ...extra });
  const pay = (token: string, rid: string, orderId: string, tender: object, key = randomUUID()) =>
    h.http
      .post(`/v1/restaurants/${rid}/orders/${orderId}/payments`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send(tender);

  it('rings up a customised meal, takes cash with change, and attributes the sale to the crew member', async () => {
    const menu = await getMenu(h, CENTRAL);
    const meal = item(menu, 'Cheeseburger Meal');
    const burger = meal.components.find((c) => c.name === 'Cheeseburger')!;
    const placed = await ring(crew, centralId, [
      {
        menuItemId: meal.id,
        quantity: 1,
        components: [
          { componentId: burger.id, modifierOptionIds: [option(burger, 'Extra cheese')] },
        ],
      },
    ]);
    expect(placed.status).toBe(201);
    const order = placed.body as OrderView;
    expect(order).toMatchObject({ channel: 'pos', status: 'pending_payment', totalCents: 1390 });
    // Returned so the receipt can carry a "track your order" link for the customer.
    expect(order.publicToken).toMatch(/^[0-9a-f]{32}$/);

    const paid = await pay(crew, centralId, order.id, { method: 'cash', tenderedCents: 2000 });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('accepted');
    expect(paid.body.payment).toMatchObject({
      method: 'cash',
      status: 'captured',
      amountCents: 1390,
      tenderedCents: 2000,
      changeCents: 610,
      cashRoundingCents: 0,
    });
    expect(paid.body.tasks).toHaveLength(3);

    const crewUser = await h.owner
      .selectFrom('users')
      .select('id')
      .where('email', '=', 'crew1@central.kitchos.test')
      .executeTakeFirstOrThrow();
    const row = await h.owner
      .selectFrom('orders')
      .select('created_by_user_id')
      .where('id', '=', order.id)
      .executeTakeFirstOrThrow();
    expect(row.created_by_user_id).toBe(crewUser.id);
    const payment = await h.owner
      .selectFrom('payments')
      .select(['id', 'received_by', 'provider'])
      .where('order_id', '=', order.id)
      .executeTakeFirstOrThrow();
    expect(payment).toMatchObject({ received_by: crewUser.id, provider: 'cash' });
    const evt = await h.owner
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'payment.captured')
      .where('aggregate_id', '=', payment.id)
      .executeTakeFirstOrThrow();
    expect(evt.payload).toMatchObject({
      orderId: order.id,
      method: 'cash',
      receivedBy: crewUser.id,
    });
  });

  it('rounds cash to the restaurant increment and records the difference on the payment only', async () => {
    // Seed prices are multiples of 10c, so demonstrate rounding with a dollar increment.
    await h.owner
      .updateTable('restaurants')
      .set({ cash_rounding_increment_cents: 100 })
      .where('id', '=', centralId)
      .execute();
    try {
      const menu = await getMenu(h, CENTRAL);
      const order = (
        await ring(crew, centralId, [
          { menuItemId: item(menu, 'Cheeseburger Meal').id, quantity: 1 },
        ])
      ).body as OrderView;
      expect(order.totalCents).toBe(1290);
      expect(order.cashDueCents).toBe(1300); // the POS shows this as the cash amount due
      const short = await pay(crew, centralId, order.id, { method: 'cash', tenderedCents: 1290 });
      expect(short.status).toBe(422);
      expect(short.body.error).toMatchObject({
        code: 'INSUFFICIENT_TENDER',
        details: { payableCents: 1300 },
      });

      const paid = await pay(crew, centralId, order.id, { method: 'cash', tenderedCents: 1500 });
      expect(paid.status).toBe(200);
      expect(paid.body.payment).toMatchObject({
        amountCents: 1290,
        cashRoundingCents: 10,
        tenderedCents: 1500,
        changeCents: 200,
      });
      expect(paid.body.totalCents).toBe(1290); // revenue unchanged by cash rounding
    } finally {
      await h.owner
        .updateTable('restaurants')
        .set({ cash_rounding_increment_cents: 5 })
        .where('id', '=', centralId)
        .execute();
    }
  });

  it('insufficient tender leaves the order parked; a retried payment with the same key is not taken twice', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = (
      await ring(crew, centralId, [{ menuItemId: item(menu, 'Medium Fries').id, quantity: 2 }])
    ).body as OrderView;
    expect(
      (await pay(crew, centralId, order.id, { method: 'cash', tenderedCents: 500 })).status,
    ).toBe(422);
    expect(
      (await h.http.get(`/v1/restaurants/${centralId}/orders/${order.id}`).set(bearer(crew))).body
        .status,
    ).toBe('pending_payment');

    const key = randomUUID();
    const [a, b] = await Promise.all([
      pay(crew, centralId, order.id, { method: 'cash', tenderedCents: 1000 }, key),
      pay(crew, centralId, order.id, { method: 'cash', tenderedCents: 1000 }, key),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.headers['idempotent-replayed'], b.headers['idempotent-replayed']]).toContain('true');
    const payments = await h.owner
      .selectFrom('payments')
      .select('id')
      .where('order_id', '=', order.id)
      .execute();
    expect(payments).toHaveLength(1);
    expect(
      (await pay(crew, centralId, order.id, { method: 'cash', tenderedCents: 1000 })).status,
    ).toBe(409);
  });

  it('takes sandbox card payments at the terminal, including declines', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = (
      await ring(crew, centralId, [{ menuItemId: item(menu, 'Latte').id, quantity: 1 }])
    ).body as OrderView;
    const declined = await pay(crew, centralId, order.id, {
      method: 'card',
      paymentToken: 'tok_sandbox_decline',
    });
    expect(declined.status).toBe(402);
    expect(declined.body).toMatchObject({
      status: 'pending_payment',
      payment: { status: 'failed', tenderedCents: null },
    });
    const ok = await pay(crew, centralId, order.id, {
      method: 'card',
      paymentToken: 'tok_sandbox_approve',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.payment).toMatchObject({
      method: 'card',
      status: 'captured',
      cashRoundingCents: 0,
      changeCents: null,
    });
  });

  it('parks, recalls and voids orders with the right permissions', async () => {
    const menu = await getMenu(h, CENTRAL);
    const pattyBefore = await balance(h, CENTRAL, 'PATTY-BEEF');
    const parked = (
      await ring(
        crew,
        centralId,
        [{ menuItemId: item(menu, 'Double Cheeseburger').id, quantity: 1 }],
        { customerName: 'Table 7' },
      )
    ).body as OrderView;
    const recalled = await h.http
      .get(`/v1/restaurants/${centralId}/orders?status=pending_payment&channel=pos`)
      .set(bearer(crew))
      .expect(200);
    expect((recalled.body as OrderView[]).map((o) => o.id)).toContain(parked.id);
    expect((await balance(h, CENTRAL, 'PATTY-BEEF')).reserved - pattyBefore.reserved).toBe(2);

    const voidIt = (token: string) =>
      h.http
        .post(`/v1/restaurants/${centralId}/orders/${parked.id}/cancel`)
        .set(bearer(token))
        .send({ reason: 'Customer left before paying' });
    expect((await voidIt(crew)).status).toBe(403);
    const supervisor = await login(h, 'supervisor@central.kitchos.test');
    const voided = await voidIt(supervisor);
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe('cancelled');
    expect(await balance(h, CENTRAL, 'PATTY-BEEF')).toEqual(pattyBefore);
    expect(
      (await pay(crew, centralId, parked.id, { method: 'cash', tenderedCents: 5000 })).status,
    ).toBe(409);
    expect(await reconciliationErrors(h)).toEqual([]);
  });

  it('enforces restaurant scope, permissions and input validation', async () => {
    const menu = await getMenu(h, CENTRAL);
    const burgerId = item(menu, 'Cheeseburger').id;
    const order = (await ring(crew, centralId, [{ menuItemId: burgerId, quantity: 1 }]))
      .body as OrderView;

    // An order from Central cannot be paid through another restaurant's route.
    const expressManager = await login(h, 'manager@express.kitchos.test');
    const expressId = await restaurantId(h, 'kitchos-express');
    expect(
      (await pay(expressManager, expressId, order.id, { method: 'cash', tenderedCents: 5000 }))
        .status,
    ).toBe(404);
    // Nor can staff ring up at a restaurant they are not assigned to.
    expect((await ring(crew, expressId, [{ menuItemId: burgerId, quantity: 1 }])).status).toBe(404);

    const auditor = await login(h, 'auditor@kitchos.test');
    expect((await ring(auditor, centralId, [{ menuItemId: burgerId, quantity: 1 }])).status).toBe(
      403,
    );
    expect(
      (await pay(auditor, centralId, order.id, { method: 'cash', tenderedCents: 5000 })).status,
    ).toBe(403);

    expect(
      (await pay(crew, centralId, order.id, { method: 'cash', tenderedCents: -100 })).status,
    ).toBe(400);
    expect(
      (await pay(crew, centralId, order.id, { method: 'cash', tenderedCents: 10.5 })).status,
    ).toBe(400);
    expect((await pay(crew, centralId, order.id, { method: 'cheque' })).status).toBe(400);
    expect(
      (await ring(crew, centralId, [{ menuItemId: burgerId, quantity: 1 }], { channel: 'web' }))
        .status,
    ).toBe(400);
    // The public endpoint never accepts cash.
    const publicOrder = await h.http
      .post(`/v1/public/restaurants/${CENTRAL}/orders`)
      .set('Idempotency-Key', randomUUID())
      .send({ fulfilmentType: 'takeaway', lines: [{ menuItemId: burgerId, quantity: 1 }] });
    const publicCash = await h.http
      .post(`/v1/public/orders/${publicOrder.body.publicToken}/payments`)
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'cash', tenderedCents: 5000 });
    expect(publicCash.status).toBe(400);
  });
});
