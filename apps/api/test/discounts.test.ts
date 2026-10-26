import { randomUUID } from 'node:crypto';
import type { OrderView } from '@kitchos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  getMenu,
  item,
  login,
  PASSWORD,
  restaurantId,
  startHarness,
  type Harness,
} from './harness.ts';

const CENTRAL = 'kitchos-central';

describe('POS discounts and manager overrides', () => {
  let h: Harness;
  let centralId: string;
  let crew: string;
  let mealId: string;

  beforeAll(async () => {
    h = await startHarness();
    centralId = await restaurantId(h, CENTRAL);
    crew = await login(h, 'crew1@central.kitchos.test');
    mealId = item(await getMenu(h, CENTRAL), 'Cheeseburger Meal').id;
  });
  afterAll(() => h.close());

  const ring = async (token = crew): Promise<OrderView> => {
    const res = await h.http
      .post(`/v1/restaurants/${centralId}/orders`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ fulfilmentType: 'dine_in', lines: [{ menuItemId: mealId, quantity: 1 }] });
    if (res.status !== 201)
      throw new Error(`ring failed ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as OrderView;
  };
  const discount = (token: string, orderId: string, body: object, key = randomUUID()) =>
    h.http
      .post(`/v1/restaurants/${centralId}/orders/${orderId}/discount`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send(body);
  const override = (
    token: string,
    orderId: string,
    email: string,
    password = PASSWORD,
    discount: object = { kind: 'percent', value: 5000, reason: 'customer_service' },
  ) =>
    h.http
      .post(`/v1/restaurants/${centralId}/overrides`)
      .set(bearer(token))
      .send({ email, password, action: 'order.discount', orderId, discount });
  const audits = (orderId: string) =>
    h.owner
      .selectFrom('audit_log')
      .select(['action', 'data'])
      .where('entity_id', '=', orderId)
      .execute();

  it('crew self-approve a discount within limits; GST and cash due follow the discounted total', async () => {
    const order = await ring();
    const key = randomUUID();
    const res = await discount(
      crew,
      order.id,
      { kind: 'percent', value: 1000, reason: 'customer_service' },
      key,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      subtotalCents: 1290,
      discountCents: 129,
      totalCents: 1161,
      taxCents: 106, // 1161 / 11 = 105.5 -> 106
      cashDueCents: 1160,
      discount: {
        kind: 'percent',
        value: 1000,
        amountCents: 129,
        appliedBy: 'Mia Chen',
        approvedBy: 'Mia Chen',
        viaOverride: false,
      },
    });
    const replay = await discount(
      crew,
      order.id,
      { kind: 'percent', value: 1000, reason: 'customer_service' },
      key,
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const line = await h.owner
      .selectFrom('order_lines')
      .select('discount_cents')
      .where('order_id', '=', order.id)
      .where('kind', '=', 'combo')
      .executeTakeFirstOrThrow();
    expect(line.discount_cents).toBe(129);
    expect((await audits(order.id)).find((a) => a.action === 'order.discount')?.data).toMatchObject(
      { selfApproved: true, requiredApproval: false },
    );

    const paid = await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/payments`)
      .set(bearer(crew))
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'cash', tenderedCents: 2000 });
    expect(paid.status).toBe(200);
    expect(paid.body.payment).toMatchObject({
      amountCents: 1161,
      cashRoundingCents: -1,
      changeCents: 840,
    });

    const again = await discount(crew, order.id, {
      kind: 'amount',
      value: 100,
      reason: 'promotion',
    });
    expect(again.status).toBe(409); // paid orders cannot be discounted
  });

  it('a large discount needs a manager override that is bound to requester, order and restaurant', async () => {
    const order = await ring();
    const big = { kind: 'percent', value: 5000, reason: 'customer_service' };
    const denied = await discount(crew, order.id, big);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({
      code: 'OVERRIDE_REQUIRED',
      details: { discountCents: 645, limitBasisPoints: 1000 },
    });

    const granted = await override(crew, order.id, 'manager@central.kitchos.test');
    expect(granted.status).toBe(201);
    expect(granted.body).toMatchObject({ approverName: 'Priya Natarajan', discountCents: 645 });
    const token = granted.body.overrideToken as string;
    const stored = await h.owner
      .selectFrom('manager_overrides')
      .select(['secret_hash', 'consumed_at'])
      .where('order_id', '=', order.id)
      .executeTakeFirstOrThrow();
    expect(stored.secret_hash).not.toContain(token); // only a hash is stored
    expect(stored.consumed_at).toBeNull();

    // Another crew member cannot use an override granted to someone else.
    const crew2 = await login(h, 'crew2@central.kitchos.test');
    expect(
      (await discount(crew2, order.id, { ...big, overrideToken: token })).body.error.code,
    ).toBe('OVERRIDE_INVALID');
    // Nor can it authorise a different order.
    const other = await ring();
    expect((await discount(crew, other.id, { ...big, overrideToken: token })).body.error.code).toBe(
      'OVERRIDE_INVALID',
    );

    const ok = await discount(crew, order.id, { ...big, overrideToken: token });
    expect(ok.status).toBe(200);
    expect(ok.body.discount).toMatchObject({
      amountCents: 645,
      appliedBy: 'Mia Chen',
      approvedBy: 'Priya Natarajan',
      viaOverride: true,
    });
    expect(
      (
        await h.owner
          .selectFrom('manager_overrides')
          .select('consumed_at')
          .where('order_id', '=', order.id)
          .executeTakeFirstOrThrow()
      ).consumed_at,
    ).not.toBeNull();
    // Single use: the same secret cannot authorise anything again.
    const third = await ring();
    expect((await discount(crew, third.id, { ...big, overrideToken: token })).body.error.code).toBe(
      'OVERRIDE_INVALID',
    );
    const actions = (await audits(order.id)).map((a) => a.action);
    expect(actions).toContain('order.discount');
    expect(
      (
        await h.owner
          .selectFrom('audit_log')
          .select('action')
          .where('action', '=', 'override.granted')
          .execute()
      ).length,
    ).toBeGreaterThan(0);
  });

  it('an override authorises only the exact discount the approver saw', async () => {
    const order = await ring();
    const approved = { kind: 'percent', value: 2000, reason: 'customer_service' };
    const token = (
      await override(crew, order.id, 'manager@central.kitchos.test', PASSWORD, approved)
    ).body.overrideToken as string;
    for (const tampered of [
      { ...approved, value: 10_000 },
      { ...approved, value: 1900 }, // even a smaller one: the approval is for this discount only
      { ...approved, kind: 'amount', value: 258 }, // same $2.58, expressed differently
      { ...approved, reason: 'complimentary' },
    ]) {
      const res = await discount(crew, order.id, { ...tampered, overrideToken: token });
      expect(res.body.error.code).toBe('OVERRIDE_INVALID');
    }
    expect((await discount(crew, order.id, { ...approved, overrideToken: token })).status).toBe(
      200,
    );
  });

  it('denied approvals are audited and successful ones never lock an approver out', async () => {
    const order = await ring();
    expect(
      (await override(crew, order.id, 'manager@central.kitchos.test', 'wrong-password')).status,
    ).toBe(401);
    const denied = await h.owner
      .selectFrom('audit_log')
      .select(['reason', 'data'])
      .where('action', '=', 'override.denied')
      .where('entity_id', '=', order.id)
      .executeTakeFirstOrThrow();
    expect(denied).toMatchObject({
      reason: 'INVALID_CREDENTIALS',
      data: { approverEmail: 'manager@central.kitchos.test' },
    });
    // A busy manager approving many requests is not throttled: only failures count.
    for (let i = 0; i < 12; i++) {
      expect((await override(crew, order.id, 'manager@central.kitchos.test')).status).toBe(201);
    }
  });

  it('overrides expire', async () => {
    const order = await ring();
    const token = (await override(crew, order.id, 'manager@central.kitchos.test')).body
      .overrideToken as string;
    await h.owner
      .updateTable('manager_overrides')
      .set({
        created_at: new Date(Date.now() - 600_000),
        expires_at: new Date(Date.now() - 480_000),
      })
      .where('order_id', '=', order.id)
      .execute();
    const res = await discount(crew, order.id, {
      kind: 'percent',
      value: 5000,
      reason: 'customer_service',
      overrideToken: token,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('OVERRIDE_INVALID');
  });

  it('only authorised approvers, other than the requester, in this restaurant and tenant can grant overrides', async () => {
    const order = await ring();
    expect((await override(crew, order.id, 'crew2@central.kitchos.test')).status).toBe(403); // no discount.approve
    expect((await override(crew, order.id, 'manager@central.kitchos.test', 'wrong')).status).toBe(
      401,
    );
    expect((await override(crew, order.id, 'manager@rival.test')).status).toBe(401); // other tenant
    expect((await override(crew, order.id, 'manager@express.kitchos.test')).status).toBe(403); // not scoped to Central
    const manager = await login(h, 'manager@central.kitchos.test');
    const own = await ring(manager);
    expect((await override(manager, own.id, 'manager@central.kitchos.test')).status).toBe(403); // self
    // A supervisor (discount.approve) can approve directly without an override.
    const supervisor = await login(h, 'supervisor@central.kitchos.test');
    const direct = await discount(supervisor, order.id, {
      kind: 'percent',
      value: 2500,
      reason: 'price_match',
    });
    expect(direct.status).toBe(200);
    expect(direct.body.discount).toMatchObject({
      appliedBy: 'Tom Okafor',
      approvedBy: 'Tom Okafor',
      viaOverride: false,
    });
    expect((await audits(order.id)).find((a) => a.action === 'order.discount')?.data).toMatchObject(
      { requiredApproval: true, selfApproved: true },
    );
  });

  it('a complimentary order needs authority, then goes straight to the kitchen with nothing to pay', async () => {
    const order = await ring();
    const comp = {
      kind: 'percent',
      value: 10_000,
      reason: 'complimentary',
      note: 'Service recovery',
    };
    expect(
      (await discount(crew, order.id, { kind: 'amount', value: 50, reason: 'complimentary' })).body
        .error.code,
    ).toBe('OVERRIDE_REQUIRED');
    const supervisor = await login(h, 'supervisor@central.kitchos.test');
    const res = await discount(supervisor, order.id, comp);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalCents: 0,
      taxCents: 0,
      status: 'accepted',
      payment: null,
    });
    expect(res.body.tasks).toHaveLength(3);
    const events = await h.owner
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', order.id)
      .orderBy('store_sequence')
      .execute();
    expect(events.map((e) => e.event_type)).toEqual([
      'order.placed',
      'order.discounted',
      'order.accepted',
    ]);
  });

  it('rejects invalid, duplicate and unauthorised discounts', async () => {
    const order = await ring();
    expect(
      (await discount(crew, order.id, { kind: 'amount', value: 2000, reason: 'promotion' })).body
        .error.code,
    ).toBe('DISCOUNT_INVALID');
    expect(
      (await discount(crew, order.id, { kind: 'percent', value: 10_001, reason: 'promotion' }))
        .status,
    ).toBe(400);
    expect(
      (await discount(crew, order.id, { kind: 'percent', value: 500, reason: 'because' })).status,
    ).toBe(400);
    expect(
      (await discount(crew, order.id, { kind: 'percent', value: 500, reason: 'promotion' })).status,
    ).toBe(200);
    expect(
      (await discount(crew, order.id, { kind: 'percent', value: 500, reason: 'promotion' })).body
        .error.code,
    ).toBe('DISCOUNT_ALREADY_APPLIED');
    const auditor = await login(h, 'auditor@kitchos.test');
    expect(
      (await discount(auditor, order.id, { kind: 'percent', value: 500, reason: 'promotion' }))
        .status,
    ).toBe(403);
    const area = await login(h, 'area.cbd@kitchos.test');
    expect(
      (await discount(area, order.id, { kind: 'percent', value: 500, reason: 'promotion' })).status,
    ).toBe(403);
    const expressManager = await login(h, 'manager@express.kitchos.test');
    const expressId = await restaurantId(h, 'kitchos-express');
    const cross = await h.http
      .post(`/v1/restaurants/${expressId}/orders/${order.id}/discount`)
      .set(bearer(expressManager))
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'percent', value: 500, reason: 'promotion' });
    expect(cross.status).toBe(404);
  });
});
