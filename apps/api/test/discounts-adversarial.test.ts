import { randomUUID } from 'node:crypto';
import type { OrderView } from '@kitchos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  getMenu,
  item,
  login,
  PASSWORD,
  reconciliationErrors,
  restaurantId,
  startHarness,
  type Harness,
} from './harness.ts';

const CENTRAL = 'kitchos-central';
const MANAGER = 'manager@central.kitchos.test';
const SUPERVISOR = 'supervisor@central.kitchos.test';

/**
 * Adversarial tests for order discounts and manager overrides. Every
 * override call is sent from its own (forwarded) client address so the
 * per-IP/per-account limiter buckets of independent scenarios do not
 * interfere; the brute-force scenario uses one fixed address.
 */
describe('discounts and overrides (adversarial)', () => {
  let h: Harness;
  let centralId: string;
  let driveId: string;
  let mealId: string;
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  const pending = new Set<string>();

  const tok = async (email: string) => (tokens[email] ??= await login(h, email));
  const uid = async (email: string) =>
    (userIds[email] ??= (
      await h.owner
        .selectFrom('users')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirstOrThrow()
    ).id);

  beforeAll(async () => {
    h = await startHarness();
    centralId = await restaurantId(h, CENTRAL);
    driveId = await restaurantId(h, 'kitchos-drive');
    mealId = item(await getMenu(h, CENTRAL), 'Cheeseburger Meal').id; // 1290c
  });

  afterAll(async () => {
    // Release reservations held by orders left awaiting payment.
    const sup = await tok(SUPERVISOR);
    for (const id of pending) {
      const row = await h.owner
        .selectFrom('orders')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirst();
      if (row?.status === 'pending_payment') {
        await h.http
          .post(`/v1/restaurants/${centralId}/orders/${id}/cancel`)
          .set(bearer(sup))
          .send({ reason: 'adversarial test cleanup' });
      }
    }
    await h.close();
  });

  const ring = async (quantity = 1, email = 'crew1@central.kitchos.test'): Promise<OrderView> => {
    const res = await h.http
      .post(`/v1/restaurants/${centralId}/orders`)
      .set(bearer(await tok(email)))
      .set('Idempotency-Key', randomUUID())
      .send({ fulfilmentType: 'dine_in', lines: [{ menuItemId: mealId, quantity }] });
    if (res.status !== 201)
      throw new Error(`ring failed ${res.status} ${JSON.stringify(res.body)}`);
    pending.add(res.body.id);
    return res.body as OrderView;
  };
  const discount = (
    token: string,
    orderId: string,
    body: object,
    key = randomUUID(),
    rid = centralId,
  ) =>
    h.http
      .post(`/v1/restaurants/${rid}/orders/${orderId}/discount`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send(body);
  const override = (
    token: string,
    orderId: string,
    email: string,
    opts: { password?: string; rid?: string; ip?: string; discount?: object } = {},
  ) =>
    h.http
      .post(`/v1/restaurants/${opts.rid ?? centralId}/overrides`)
      .set(bearer(token))
      .set(
        'X-Forwarded-For',
        opts.ip ?? `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      )
      .send({
        email,
        password: opts.password ?? PASSWORD,
        action: 'order.discount',
        orderId,
        discount: opts.discount ?? { kind: 'percent', value: 5000, reason: 'customer_service' },
      });
  const cashPay = async (orderId: string, key = randomUUID()) =>
    h.http
      .post(`/v1/restaurants/${centralId}/orders/${orderId}/payments`)
      .set(bearer(await tok('crew1@central.kitchos.test')))
      .set('Idempotency-Key', key)
      .send({ method: 'cash', tenderedCents: 10_000 });
  const orderRow = (id: string) =>
    h.owner
      .selectFrom('orders')
      .select(['status', 'subtotal_cents', 'discount_cents', 'total_cents', 'version'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const discountRows = (id: string) =>
    h.owner.selectFrom('order_discounts').selectAll().where('order_id', '=', id).execute();
  const overrideRow = (orderId: string) =>
    h.owner
      .selectFrom('manager_overrides')
      .selectAll()
      .where('order_id', '=', orderId)
      .executeTakeFirstOrThrow();

  // ------------------------------------------------------------ policy edges

  it('amount limit: 500c self-approves, 501c needs approval (order 5160c)', async () => {
    const crew = await tok('crew1@central.kitchos.test');
    const a = await ring(4);
    expect(a.subtotalCents).toBe(5160);
    const over = await discount(crew, a.id, { kind: 'amount', value: 501, reason: 'promotion' });
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe('OVERRIDE_REQUIRED');
    // 10% of 5160 = 516c: under the bp limit but over the cents limit.
    const pct = await discount(crew, a.id, { kind: 'percent', value: 1000, reason: 'promotion' });
    expect(pct.body.error.code).toBe('OVERRIDE_REQUIRED');
    expect(await discountRows(a.id)).toHaveLength(0);
    const ok = await discount(crew, a.id, { kind: 'amount', value: 500, reason: 'promotion' });
    expect(ok.status).toBe(200);
    expect(await orderRow(a.id)).toMatchObject({ discount_cents: 500, total_cents: 4660 });
  });

  it('percent rounding: 10.03% that rounds to 10% passes, 10.04% that rounds up to 130c does not', async () => {
    const crew = await tok('crew1@central.kitchos.test');
    const a = await ring(1); // 1290c; limit 10% = 129c
    const b = await ring(1);
    const over = await discount(crew, b.id, { kind: 'percent', value: 1004, reason: 'promotion' }); // 129.5 -> 130c
    expect(over.status).toBe(403);
    expect(over.body.error.details).toMatchObject({
      discountCents: 130,
      effectiveBasisPoints: 1008,
    });
    const ok = await discount(crew, a.id, { kind: 'percent', value: 1003, reason: 'promotion' }); // 129.39 -> 129c
    expect(ok.status).toBe(200);
    expect(ok.body.discountCents).toBe(129);
    // amount 130c is the same money as 10.04% and is likewise refused.
    expect(
      (await discount(crew, b.id, { kind: 'amount', value: 130, reason: 'promotion' })).status,
    ).toBe(403);
    // 129c exactly is within policy.
    expect(
      (await discount(crew, b.id, { kind: 'amount', value: 129, reason: 'promotion' })).status,
    ).toBe(200);
  });

  // ------------------------------------------------------------ override binding

  it('an override is bound to the approved amount (crew cannot turn a small approval into a 100% comp)', async () => {
    const crew = await tok('crew1@central.kitchos.test');
    const order = await ring(1);
    // Terminal shows a 15% request; manager re-authenticates to approve it.
    const small = { kind: 'percent', value: 1500, reason: 'customer_service' };
    expect((await discount(crew, order.id, small)).body.error.code).toBe('OVERRIDE_REQUIRED');
    const granted = await override(crew, order.id, MANAGER, { discount: small });
    expect(granted.status).toBe(201);
    expect(granted.body.discountCents).toBe(194); // the approver authorises exactly $1.94
    // The crew member instead submits a 100% complimentary discount with that token.
    const comp = await discount(crew, order.id, {
      kind: 'percent',
      value: 10_000,
      reason: 'complimentary',
      overrideToken: granted.body.overrideToken,
    });
    // Regression (found by adversarial testing): overrides were not bound to the
    // approved discount, so an approval for 15% authorised a 100% comp.
    expect(comp.status).toBe(403);
    expect(comp.body.error.code).toBe('OVERRIDE_INVALID');
    expect((await orderRow(order.id)).total_cents).toBe(1290);
  });

  it('one override token used by two concurrent requests authorises at most one discount', async () => {
    const crew = await tok('crew1@central.kitchos.test');
    const order = await ring(1);
    const spec = { kind: 'percent', value: 2000, reason: 'customer_service' };
    const token = (await override(crew, order.id, MANAGER, { discount: spec })).body
      .overrideToken as string;
    const body = { ...spec, overrideToken: token };
    const [r1, r2] = await Promise.all([
      discount(crew, order.id, body),
      discount(crew, order.id, body),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(['DISCOUNT_ALREADY_APPLIED', 'CONCURRENT_MODIFICATION']).toContain(
      loser.body.error.code,
    );
    expect(await discountRows(order.id)).toHaveLength(1);
    const ov = await overrideRow(order.id);
    expect(ov.consumed_at).not.toBeNull();
    expect((await discountRows(order.id))[0]!.override_id).toBe(ov.id);
  });

  it('two concurrent different discounts on one order: exactly one is persisted and totals match it', async () => {
    const sup = await tok(SUPERVISOR);
    const order = await ring(2); // 2580
    const [r1, r2] = await Promise.all([
      discount(sup, order.id, { kind: 'percent', value: 5000, reason: 'price_match' }),
      discount(sup, order.id, { kind: 'amount', value: 300, reason: 'promotion' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const rows = await discountRows(order.id);
    expect(rows).toHaveLength(1);
    const o = await orderRow(order.id);
    expect(o.discount_cents).toBe(rows[0]!.amount_cents);
    expect(o.total_cents).toBe(o.subtotal_cents - rows[0]!.amount_cents);
    const lines = await h.owner
      .selectFrom('order_lines')
      .select((eb) => eb.fn.sum<string>('discount_cents').as('s'))
      .where('order_id', '=', order.id)
      .executeTakeFirstOrThrow();
    expect(Number(lines.s)).toBe(rows[0]!.amount_cents);
  });

  it('discount racing a cash payment yields one consistent outcome (5 rounds)', async () => {
    const sup = await tok(SUPERVISOR);
    for (let i = 0; i < 5; i++) {
      const order = await ring(1);
      const [d, p] = await Promise.all([
        discount(sup, order.id, { kind: 'percent', value: 2500, reason: 'price_match' }),
        cashPay(order.id),
      ]);
      expect(p.status).toBe(200);
      const o = await orderRow(order.id);
      const rows = await discountRows(order.id);
      const payment = await h.owner
        .selectFrom('payments')
        .select(['amount_cents', 'status'])
        .where('order_id', '=', order.id)
        .execute();
      expect(payment).toHaveLength(1);
      expect(o.status).toBe('accepted');
      if (d.status === 200) {
        expect(rows).toHaveLength(1);
        expect(o.total_cents).toBe(1290 - rows[0]!.amount_cents);
      } else {
        expect(d.status).toBe(409);
        expect(d.body.error.code).toBe('ORDER_NOT_AWAITING_PAYMENT');
        expect(rows).toHaveLength(0);
        expect(o.total_cents).toBe(1290);
      }
      expect(o.total_cents).toBe(o.subtotal_cents - o.discount_cents);
      expect(payment[0]!.amount_cents).toBe(o.total_cents);
    }
  });

  // ------------------------------------------------------------ scope

  it('tokens and overrides do not cross restaurants or tenants', async () => {
    const crew = await tok('crew1@central.kitchos.test');
    const order = await ring(1);
    const token = (await override(crew, order.id, MANAGER)).body.overrideToken as string;
    const big = { kind: 'percent', value: 5000, reason: 'customer_service', overrideToken: token };

    // Same order through another restaurant's route: crew has no rights there (403 or hidden as 404).
    expect([403, 404]).toContain(
      (await discount(crew, order.id, big, randomUUID(), driveId)).status,
    );
    // Drive manager (has rights at Drive) cannot reach a Central order via Drive.
    const driveMgr = await tok('manager@drive.kitchos.test');
    expect((await discount(driveMgr, order.id, big, randomUUID(), driveId)).status).toBe(404);
    // Crew cannot request an override at another restaurant for a Central order.
    expect([403, 404]).toContain(
      (await override(crew, order.id, 'manager@drive.kitchos.test', { rid: driveId })).status,
    );
    // Other tenant: neither the discount nor the override endpoint reach Central.
    const rival = await tok('manager@rival.test');
    expect([403, 404]).toContain((await discount(rival, order.id, big)).status);
    expect([403, 404]).toContain((await override(rival, order.id, MANAGER)).status);
    // Read-only and approver-less roles cannot grant.
    expect((await override(crew, order.id, 'auditor@kitchos.test')).status).toBe(403);

    // The token is still unconsumed and works for the right user/order/restaurant.
    expect((await overrideRow(order.id)).consumed_at).toBeNull();
    const ok = await discount(crew, order.id, big);
    expect(ok.status).toBe(200);
    expect(ok.body.discount).toMatchObject({ viaOverride: true, approvedBy: 'Priya Natarajan' });
  });

  it('overrides are refused for paid and cancelled orders; a token for an order paid later is not consumed', async () => {
    const crew = await tok('crew1@central.kitchos.test');
    const sup = await tok(SUPERVISOR);
    const paid = await ring(1);
    expect((await cashPay(paid.id)).status).toBe(200);
    const r1 = await override(crew, paid.id, MANAGER);
    expect(r1.status).toBe(409);

    const cancelled = await ring(1);
    expect(
      (
        await h.http
          .post(`/v1/restaurants/${centralId}/orders/${cancelled.id}/cancel`)
          .set(bearer(sup))
          .send({ reason: 'customer left' })
      ).status,
    ).toBe(200);
    expect((await override(crew, cancelled.id, MANAGER)).status).toBe(409);

    const later = await ring(1);
    const token = (
      await override(crew, later.id, MANAGER, {
        discount: { kind: 'percent', value: 5000, reason: 'other' },
      })
    ).body.overrideToken as string;
    expect((await cashPay(later.id)).status).toBe(200);
    const res = await discount(crew, later.id, {
      kind: 'percent',
      value: 5000,
      reason: 'other',
      overrideToken: token,
    });
    expect(res.status).toBe(409);
    expect((await overrideRow(later.id)).consumed_at).toBeNull();
    expect(
      await h.owner
        .selectFrom('manager_overrides')
        .select('id')
        .where('order_id', 'in', [paid.id, cancelled.id])
        .execute(),
    ).toHaveLength(0);
  });

  // ------------------------------------------------------------ brute force

  it('the 11th bad approver password from one client is rate limited, even with the right password', async () => {
    const crew = await tok('crew2@central.kitchos.test');
    const order = await ring(1, 'crew2@central.kitchos.test');
    const ip = '10.77.0.1';
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (await override(crew, order.id, SUPERVISOR, { password: `wrong-${i}`, ip })).status,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await override(crew, order.id, SUPERVISOR, { ip })).status).toBe(429);
    expect(
      await h.owner
        .selectFrom('manager_overrides')
        .select('id')
        .where('order_id', '=', order.id)
        .execute(),
    ).toHaveLength(0);
  });

  it('the per-account limit cannot be reset by changing the client address', async () => {
    // A requester not used for overrides elsewhere (failed attempts also exhaust the
    // per-requester budget), so only the per-account budget is exercised.
    const crew = await tok(SUPERVISOR);
    const order = await ring(1, SUPERVISOR);
    for (let i = 0; i < 10; i++) {
      const res = await override(crew, order.id, 'area.cbd@kitchos.test', {
        password: `bad-${i}`,
        ip: '10.78.0.1',
      });
      expect(res.status).toBe(401);
    }
    const rotated = await override(crew, order.id, 'area.cbd@kitchos.test', {
      password: 'bad-x',
      ip: '10.78.0.2',
    });
    // Regression (found by adversarial testing): the account budget was keyed by
    // IP + email, so rotating X-Forwarded-For reset it.
    expect(rotated.status).toBe(429);
  });

  // ------------------------------------------------------------ comp + audit

  it('comp order: kitchen tasks and stock consumption happen exactly once, replay is a no-op, ledger reconciles', async () => {
    const sup = await tok(SUPERVISOR);
    const order = await ring(1);
    const key = randomUUID();
    const body = {
      kind: 'percent',
      value: 10_000,
      reason: 'complimentary',
      note: 'service recovery',
    };
    const [a, b] = await Promise.all([
      discount(sup, order.id, body, key),
      discount(sup, order.id, body, key),
    ]);
    const first = a.status === 200 && !a.headers['idempotent-replayed'] ? a : b;
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      status: 'accepted',
      totalCents: 0,
      taxCents: 0,
      payment: null,
    });
    const replay = await discount(sup, order.id, body, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const tasks = await h.owner
      .selectFrom('kitchen_tasks')
      .select('id')
      .where('order_id', '=', order.id)
      .execute();
    expect(tasks).toHaveLength(3);
    const events = await h.owner
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', order.id)
      .execute();
    expect(events.filter((e) => e.event_type === 'order.accepted')).toHaveLength(1);
    expect(events.filter((e) => e.event_type === 'order.discounted')).toHaveLength(1);
    const movements = await h.owner
      .selectFrom('stock_movements as m')
      .innerJoin('order_lines as l', 'l.id', 'm.source_id')
      .select(['m.source_id', 'm.inventory_item_id'])
      .where('l.order_id', '=', order.id)
      .execute();
    const keys = movements.map((m) => `${m.source_id}|${m.inventory_item_id}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(
      await h.owner.selectFrom('payments').select('id').where('order_id', '=', order.id).execute(),
    ).toHaveLength(0);
    // Nothing to pay: a payment attempt is rejected.
    expect((await cashPay(order.id)).status).toBe(409);
    expect(await reconciliationErrors(h)).toEqual([]);
  });

  it('audit log records the grant (approver as actor) and the discount (approver + override id)', async () => {
    const crew = await tok('crew1@central.kitchos.test');
    const order = await ring(1);
    const granted = await override(crew, order.id, MANAGER, {
      discount: { kind: 'amount', value: 400, reason: 'customer_service' },
    });
    expect(granted.status).toBe(201);
    const res = await discount(crew, order.id, {
      kind: 'amount',
      value: 400,
      reason: 'customer_service',
      overrideToken: granted.body.overrideToken,
    });
    expect(res.status).toBe(200);
    const ov = await overrideRow(order.id);
    const managerId = await uid(MANAGER);
    const crewId = await uid('crew1@central.kitchos.test');
    expect(ov).toMatchObject({
      approver_user_id: managerId,
      requested_by: crewId,
      restaurant_id: centralId,
    });

    const grant = await h.owner
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'override.granted')
      .where('entity_id', '=', ov.id)
      .execute();
    expect(grant).toHaveLength(1);
    expect(grant[0]).toMatchObject({ actor_user_id: managerId, restaurant_id: centralId });
    expect(grant[0]!.data).toMatchObject({ orderId: order.id, requestedBy: crewId });

    const applied = await h.owner
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'order.discount')
      .where('entity_id', '=', order.id)
      .execute();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ actor_user_id: crewId, reason: 'customer_service' });
    expect(applied[0]!.data).toMatchObject({
      approvedBy: managerId,
      overrideId: ov.id,
      discountCents: 400,
      requiredApproval: true,
      selfApproved: false,
    });
    expect((await discountRows(order.id))[0]).toMatchObject({
      applied_by: crewId,
      approved_by: managerId,
      override_id: ov.id,
    });
  });
});
