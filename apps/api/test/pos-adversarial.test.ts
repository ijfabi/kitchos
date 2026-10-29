import { randomUUID } from 'node:crypto';
import type { OrderView } from '@kitchos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  ensureDrawer,
  consumptionForOrder,
  getMenu,
  item,
  login,
  reconciliationErrors,
  restaurantId,
  setAvailable,
  startHarness,
  type Harness,
} from './harness.ts';

const CENTRAL = 'kitchos-central';
const DRIVE = 'kitchos-drive';
const EXPRESS = 'kitchos-express';
const RIVAL = 'rival-southbank';

describe('POS adversarial: tenant isolation, idempotency abuse, races and tender edge cases', () => {
  let h: Harness;
  let centralId: string;
  let driveId: string;
  let expressId: string;
  let rivalId: string;
  let crew: string;
  let driveCrew: string;
  let expressManager: string;
  let rivalManager: string;
  let admin: string;

  beforeAll(async () => {
    h = await startHarness();
    centralId = await restaurantId(h, CENTRAL);
    driveId = await restaurantId(h, DRIVE);
    expressId = await restaurantId(h, EXPRESS);
    rivalId = await restaurantId(h, RIVAL);
    crew = await login(h, 'crew1@central.kitchos.test');
    driveCrew = await login(h, 'crew1@drive.kitchos.test');
    expressManager = await login(h, 'manager@express.kitchos.test');
    rivalManager = await login(h, 'manager@rival.test');
    admin = await login(h, 'admin@kitchos.test');
    await ensureDrawer(h, crew, CENTRAL);
    await ensureDrawer(h, driveCrew, DRIVE);
    await ensureDrawer(h, admin, EXPRESS);
  });
  afterAll(() => h.close());

  const ring = (
    token: string,
    rid: string,
    lines: object[],
    extra: object = {},
    key: string = randomUUID(),
  ) =>
    h.http
      .post(`/v1/restaurants/${rid}/orders`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send({ fulfilmentType: 'dine_in', lines, ...extra });
  const pay = (
    token: string,
    rid: string,
    orderId: string,
    tender: object,
    key: string = randomUUID(),
  ) =>
    h.http
      .post(`/v1/restaurants/${rid}/orders/${orderId}/payments`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send(tender);

  const paymentsFor = (orderId: string) =>
    h.owner.selectFrom('payments').selectAll().where('order_id', '=', orderId).execute();
  const orderRow = (orderId: string) =>
    h.owner.selectFrom('orders').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
  const tasksFor = (orderId: string) =>
    h.owner.selectFrom('kitchen_tasks').selectAll().where('order_id', '=', orderId).execute();
  const eventsFor = (aggregateId: string, eventType: string) =>
    h.owner
      .selectFrom('outbox_events')
      .select('id')
      .where('aggregate_id', '=', aggregateId)
      .where('event_type', '=', eventType)
      .execute();

  async function ringAt(
    token: string,
    slug: string,
    rid: string,
    name: string,
    qty = 1,
  ): Promise<OrderView> {
    const menu = await getMenu(h, slug);
    const res = await ring(token, rid, [{ menuItemId: item(menu, name).id, quantity: qty }]);
    if (res.status !== 201)
      throw new Error(`ring failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as OrderView;
  }

  it('rival tenant cannot pay a demo order via its own route or via the demo route', async () => {
    const order = await ringAt(crew, CENTRAL, centralId, 'Cheeseburger');
    const viaRival = await pay(rivalManager, rivalId, order.id, {
      method: 'cash',
      tenderedCents: 5000,
    });
    expect(viaRival.status).toBe(404);
    const viaDemo = await pay(rivalManager, centralId, order.id, {
      method: 'card',
      paymentToken: 'tok_sandbox_approve',
    });
    expect([403, 404]).toContain(viaDemo.status);
    expect(await paymentsFor(order.id)).toHaveLength(0);
    expect((await orderRow(order.id)).status).toBe('pending_payment');

    // Nor can the rival ring up at a demo restaurant, or at its own restaurant using demo menu items.
    const menu = await getMenu(h, CENTRAL);
    const burgerId = item(menu, 'Cheeseburger').id;
    expect([403, 404]).toContain(
      (await ring(rivalManager, centralId, [{ menuItemId: burgerId, quantity: 1 }])).status,
    );
    const crossMenu = await ring(rivalManager, rivalId, [{ menuItemId: burgerId, quantity: 1 }]);
    expect(crossMenu.status).toBeGreaterThanOrEqual(400);
    expect(crossMenu.status).toBeLessThan(500);

    // And a demo manager cannot pay a rival order through a demo route.
    const rivalMenu = await getMenu(h, RIVAL);
    await setAvailable(h, RIVAL, 'BUN', 10);
    const rivalOrder = await ring(rivalManager, rivalId, [
      { menuItemId: rivalMenu.items[0]!.id, quantity: 1 },
    ]);
    expect(rivalOrder.status, JSON.stringify(rivalOrder.body)).toBe(201);
    expect(
      (await pay(admin, centralId, rivalOrder.body.id, { method: 'cash', tenderedCents: 99_999 }))
        .status,
    ).toBe(404);
    expect(
      (await pay(admin, rivalId, rivalOrder.body.id, { method: 'cash', tenderedCents: 99_999 }))
        .status,
    ).toBe(404);
    expect(await paymentsFor(rivalOrder.body.id)).toHaveLength(0);
  });

  it('an order id from another restaurant in the same tenant is 404 even for an org-wide admin', async () => {
    const order = await ringAt(expressManager, EXPRESS, expressId, 'Latte');
    expect(
      (await pay(admin, centralId, order.id, { method: 'cash', tenderedCents: 5000 })).status,
    ).toBe(404);
    expect(
      (
        await pay(crew, centralId, order.id, {
          method: 'card',
          paymentToken: 'tok_sandbox_approve',
        })
      ).status,
    ).toBe(404);
    expect(await paymentsFor(order.id)).toHaveLength(0);
    // Paying through the right route still works afterwards.
    const ok = await pay(admin, expressId, order.id, { method: 'cash', tenderedCents: 5000 });
    expect(ok.status).toBe(200);
    expect(await paymentsFor(order.id)).toHaveLength(1);
  });

  it("replaying another restaurant's idempotency key does not bypass the restaurant scope check", async () => {
    // Regression (found by adversarial testing): idempotent() replays a stored response before
    // lockOrder() applies the restaurant filter, so the key scope must include the restaurant.
    const order = await ringAt(crew, CENTRAL, centralId, 'Cheeseburger');
    const key = randomUUID();
    const tender = { method: 'cash', tenderedCents: 5000 };
    expect((await pay(crew, centralId, order.id, tender, key)).status).toBe(200);
    const replay = await pay(expressManager, expressId, order.id, tender, key);
    expect(
      replay.status,
      `replayed=${replay.headers['idempotent-replayed']} restaurantId=${replay.body.restaurantId} id=${replay.body.id}`,
    ).toBe(404);
    expect(await paymentsFor(order.id)).toHaveLength(1);
  });

  it('reusing one Idempotency-Key for cash then card on the same order is rejected and takes no second payment', async () => {
    const order = await ringAt(crew, CENTRAL, centralId, 'Medium Fries');
    const key = randomUUID();
    const cash = await pay(crew, centralId, order.id, { method: 'cash', tenderedCents: 1000 }, key);
    expect(cash.status).toBe(200);
    const card = await pay(
      crew,
      centralId,
      order.id,
      { method: 'card', paymentToken: 'tok_sandbox_approve' },
      key,
    );
    expect(card.status).toBe(422);
    expect(card.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const rows = await paymentsFor(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: 'cash', status: 'captured' });

    // Same key, different tendered amount, is also a different request.
    const other = await pay(
      crew,
      centralId,
      order.id,
      { method: 'cash', tenderedCents: 2000 },
      key,
    );
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await paymentsFor(order.id)).toHaveLength(1);
  });

  it('a declined card key cannot be reused to approve; a fresh key can', async () => {
    const order = await ringAt(crew, CENTRAL, centralId, 'Latte');
    const key = randomUUID();
    expect(
      (
        await pay(
          crew,
          centralId,
          order.id,
          { method: 'card', paymentToken: 'tok_sandbox_decline' },
          key,
        )
      ).status,
    ).toBe(402);
    const reuse = await pay(
      crew,
      centralId,
      order.id,
      { method: 'card', paymentToken: 'tok_sandbox_approve' },
      key,
    );
    expect(reuse.status).toBe(422);
    expect(await paymentsFor(order.id)).toHaveLength(1);
    const ok = await pay(crew, centralId, order.id, { method: 'cash', tenderedCents: 1000 });
    expect(ok.status).toBe(200);
    const rows = await paymentsFor(order.id);
    expect(rows.filter((p) => p.status === 'captured')).toHaveLength(1);
    expect(rows.filter((p) => p.status === 'failed')).toHaveLength(1);
  });

  it('concurrent cash and card payments with different keys capture exactly once', async () => {
    const order = await ringAt(crew, CENTRAL, centralId, 'Cheeseburger Meal');
    const tenders = [
      { method: 'cash', tenderedCents: 2000 },
      { method: 'card', paymentToken: 'tok_sandbox_approve' },
      { method: 'cash', tenderedCents: 5000 },
      { method: 'card', paymentToken: 'tok_sandbox_approve' },
      { method: 'cash', tenderedCents: 1290 },
      { method: 'card', paymentToken: 'tok_sandbox_approve' },
    ];
    const results = await Promise.all(tenders.map((t) => pay(crew, centralId, order.id, t)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(tenders.length - 1);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(r.body.error.code).toBe('ORDER_NOT_AWAITING_PAYMENT');
    }
    const winner = results.find((r) => r.status === 200)!;

    const rows = await paymentsFor(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('captured');
    const o = await orderRow(order.id);
    expect(o.status).toBe('accepted');
    expect(o.accepted_at).not.toBeNull();
    const tasks = await tasksFor(order.id);
    expect(tasks.length).toBe(winner.body.tasks.length);
    expect(tasks.length).toBe(3);
    expect(await eventsFor(order.id, 'order.accepted')).toHaveLength(1);
    expect(await eventsFor(rows[0]!.id, 'payment.captured')).toHaveLength(1);
    // Consumption at acceptance recorded once per line/ingredient (no duplicates from the race).
    const consumption = await consumptionForOrder(h, order.id);
    const keys = consumption.map((c) => `${c.source_id}:${c.sku}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('cannot pay a cancelled order with either tender', async () => {
    const order = await ringAt(crew, CENTRAL, centralId, 'Cheeseburger');
    const supervisor = await login(h, 'supervisor@central.kitchos.test');
    const voided = await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/cancel`)
      .set(bearer(supervisor))
      .send({ reason: 'Adversarial test void' });
    expect(voided.status).toBe(200);
    expect(
      (await pay(crew, centralId, order.id, { method: 'cash', tenderedCents: 5000 })).status,
    ).toBe(409);
    expect(
      (
        await pay(crew, centralId, order.id, {
          method: 'card',
          paymentToken: 'tok_sandbox_approve',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await pay(crew, centralId, order.id, {
          method: 'card',
          paymentToken: 'tok_sandbox_decline',
        })
      ).status,
    ).toBe(409);
    expect(await paymentsFor(order.id)).toHaveLength(0);
    expect(await tasksFor(order.id)).toHaveLength(0);
    expect((await orderRow(order.id)).status).toBe('cancelled');
  });

  it('accepts a tender at the maximum bound with exact change and rejects one above it', async () => {
    const order = await ringAt(crew, CENTRAL, centralId, 'Cheeseburger');
    const over = await pay(crew, centralId, order.id, {
      method: 'cash',
      tenderedCents: 10_000_001,
    });
    expect(over.status).toBe(400);
    expect(
      (await pay(crew, centralId, order.id, { method: 'cash', tenderedCents: '5000' })).status,
    ).toBe(400);
    expect(
      (await pay(crew, centralId, order.id, { method: 'cash', tenderedCents: 1e21 })).status,
    ).toBe(400);
    expect((await pay(crew, centralId, order.id, { method: 'cash' })).status).toBe(400);
    expect(await paymentsFor(order.id)).toHaveLength(0);

    const max = await pay(crew, centralId, order.id, { method: 'cash', tenderedCents: 10_000_000 });
    expect(max.status).toBe(200);
    const [row] = await paymentsFor(order.id);
    expect(Number(row!.tendered_cents)).toBe(10_000_000);
    expect(Number(row!.amount_cents)).toBe(order.totalCents);
    expect(Number(row!.tendered_cents)).toBe(
      Number(row!.amount_cents) + Number(row!.cash_rounding_cents) + Number(row!.change_cents),
    );
    expect(max.body.payment.changeCents).toBe(Number(row!.change_cents));
  });

  it('missing or malformed Idempotency-Key is rejected without side effects', async () => {
    const order = await ringAt(crew, CENTRAL, centralId, 'Cheeseburger');
    const noKey = await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/payments`)
      .set(bearer(crew))
      .send({ method: 'cash', tenderedCents: 5000 });
    expect(noKey.status).toBe(400);
    expect(
      (await pay(crew, centralId, order.id, { method: 'cash', tenderedCents: 5000 }, 'short'))
        .status,
    ).toBe(400);
    const menu = await getMenu(h, CENTRAL);
    const countBefore = await h.owner
      .selectFrom('orders')
      .select(h.owner.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    const noKeyCreate = await h.http
      .post(`/v1/restaurants/${centralId}/orders`)
      .set(bearer(crew))
      .send({
        fulfilmentType: 'dine_in',
        lines: [{ menuItemId: item(menu, 'Cheeseburger').id, quantity: 1 }],
      });
    expect(noKeyCreate.status).toBe(400);
    const countAfter = await h.owner
      .selectFrom('orders')
      .select(h.owner.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(countAfter.n).toBe(countBefore.n);
    expect(await paymentsFor(order.id)).toHaveLength(0);
  });

  it('cash rounding edge: tender one cent below a rounded-up / rounded-down payable', async () => {
    // Seed prices are multiples of 10c; use larger increments on Drive to force rounding both ways.
    const setInc = (n: number) =>
      h.owner
        .updateTable('restaurants')
        .set({ cash_rounding_increment_cents: n })
        .where('id', '=', driveId)
        .execute();
    try {
      await setInc(20);
      const up = await ringAt(driveCrew, DRIVE, driveId, 'Cheeseburger Meal');
      const total = up.totalCents;
      const payable = Math.floor((total + 10) / 20) * 20; // half up to nearest 20
      if (payable !== total) {
        const short = await pay(driveCrew, driveId, up.id, {
          method: 'cash',
          tenderedCents: payable - 1,
        });
        expect(short.status).toBe(422);
        expect(short.body.error).toMatchObject({
          code: 'INSUFFICIENT_TENDER',
          details: { payableCents: payable },
        });
        expect(await paymentsFor(up.id)).toHaveLength(0);
      }
      const exact = await pay(driveCrew, driveId, up.id, {
        method: 'cash',
        tenderedCents: payable,
      });
      expect(exact.status).toBe(200);
      expect(exact.body.payment).toMatchObject({
        amountCents: total,
        changeCents: 0,
        cashRoundingCents: payable - total,
      });
      expect(exact.body.totalCents).toBe(total);

      await setInc(100);
      const down = await ringAt(driveCrew, DRIVE, driveId, 'Cheeseburger');
      const t2 = down.totalCents;
      const p2 = Math.floor((t2 + 50) / 100) * 100;
      const below = await pay(driveCrew, driveId, down.id, {
        method: 'cash',
        tenderedCents: p2 - 1,
      });
      expect(below.status).toBe(422);
      const ok = await pay(driveCrew, driveId, down.id, { method: 'cash', tenderedCents: p2 });
      expect(ok.status).toBe(200);
      const [row] = await paymentsFor(down.id);
      expect(Number(row!.cash_rounding_cents)).toBe(p2 - t2);
      expect(Number(row!.change_cents)).toBe(0);
      expect(Number(row!.amount_cents)).toBe(t2);
      expect(Number((await orderRow(down.id)).total_cents)).toBe(t2);

      // Card is never rounded, even with a large increment.
      const card = await ringAt(driveCrew, DRIVE, driveId, 'Cheeseburger');
      const paid = await pay(driveCrew, driveId, card.id, {
        method: 'card',
        paymentToken: 'tok_sandbox_approve',
      });
      expect(paid.status).toBe(200);
      const [cardRow] = await paymentsFor(card.id);
      expect(cardRow).toMatchObject({ tendered_cents: null, change_cents: null });
      expect(Number(cardRow!.cash_rounding_cents)).toBe(0);
    } finally {
      await setInc(5);
    }
  });

  it('staff create rejects web/kiosk channels and ignores client-supplied prices', async () => {
    const menu = await getMenu(h, CENTRAL);
    const burger = item(menu, 'Cheeseburger');
    for (const channel of ['web', 'kiosk', 'POS', '']) {
      expect(
        (await ring(crew, centralId, [{ menuItemId: burger.id, quantity: 1 }], { channel })).status,
      ).toBe(400);
    }
    const drive = await ring(crew, centralId, [{ menuItemId: burger.id, quantity: 1 }], {
      channel: 'drive_thru',
    });
    expect(drive.status).toBe(201);
    expect((await orderRow(drive.body.id)).channel).toBe('drive_thru');

    const injected = await ring(
      crew,
      centralId,
      [{ menuItemId: burger.id, quantity: 1, unitPriceCents: 1, priceCents: 1 }],
      { totalCents: 1, status: 'accepted', restaurantId: expressId, orgId: randomUUID() },
    );
    if (injected.status === 201) {
      const row = await orderRow(injected.body.id);
      expect(Number(row.total_cents)).toBe(burger.priceCents);
      expect(row.status).toBe('pending_payment');
      expect(row.restaurant_id).toBe(centralId);
    } else {
      expect(injected.status).toBe(400);
    }
  });

  it('stock ledger reconciles after all of the above', async () => {
    expect(await reconciliationErrors(h)).toEqual([]);
  });
});
