import type { KitchenTaskView, OrderView } from '@kitchos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  balance,
  bearer,
  consumptionForOrder,
  getMenu,
  item,
  login,
  option,
  pay,
  placeAndPay,
  placeOrder,
  reconciliationErrors,
  restaurantId,
  startHarness,
  type Harness,
} from './harness.ts';

const CENTRAL = 'kitchos-central';

describe('order lifecycle: customer order -> kitchen -> pickup', () => {
  let h: Harness;
  let crew: string;
  let centralId: string;

  beforeAll(async () => {
    h = await startHarness();
    crew = await login(h, 'crew1@central.kitchos.test');
    centralId = await restaurantId(h, CENTRAL);
  });
  afterAll(() => h.close());

  const tasksFor = async (orderId: string): Promise<KitchenTaskView[]> => {
    const res = await h.http
      .get(`/v1/restaurants/${centralId}/kitchen/tasks?recentDoneMinutes=60`)
      .set(bearer(crew))
      .expect(200);
    return (res.body as KitchenTaskView[]).filter((t) => t.orderId === orderId);
  };
  const task = (tasks: KitchenTaskView[], station: string) => {
    const t = tasks.find((x) => x.stationCode === station);
    if (!t) throw new Error(`no task at ${station}`);
    return t;
  };
  const kitchen = (taskId: string, action: 'start' | 'complete') =>
    h.http
      .post(`/v1/restaurants/${centralId}/kitchen/tasks/${taskId}/${action}`)
      .set(bearer(crew))
      .send({});

  it('runs a customised meal end to end, consuming each ingredient exactly once at its configured point', async () => {
    const menu = await getMenu(h, CENTRAL);
    const meal = item(menu, 'Cheeseburger Meal');
    const burgerComponent = meal.components.find((c) => c.name === 'Cheeseburger')!;
    const extraCheese = option(burgerComponent, 'Extra cheese');
    const cheeseBefore = await balance(h, CENTRAL, 'CHEESE-SLICE');

    // 1. Place: priced on the server, stock reserved, awaiting payment.
    const placed = await placeOrder(h, CENTRAL, [
      {
        menuItemId: meal.id,
        quantity: 1,
        components: [{ componentId: burgerComponent.id, modifierOptionIds: [extraCheese] }],
      },
    ]);
    expect(placed.status).toBe(201);
    const order = placed.body as OrderView;
    expect(order.status).toBe('pending_payment');
    expect(order.totalCents).toBe(1390); // 12.90 meal + 1.00 extra cheese
    expect(order.taxCents).toBe(126); // GST = 1/11 of 13.90, rounded
    expect(order.lines[0]!.components.map((c) => c.name)).toEqual([
      'Cheeseburger',
      'Medium Fries',
      'Medium Cola',
    ]);
    expect((await balance(h, CENTRAL, 'CHEESE-SLICE')).reserved - cheeseBefore.reserved).toBe(2);
    expect(await consumptionForOrder(h, order.id)).toHaveLength(0);

    // 2. Pay: payment captured (separate state machine), order accepted, tasks routed.
    const paid = await pay(h, order.publicToken!);
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('accepted');
    expect(paid.body.payment).toMatchObject({
      status: 'captured',
      amountCents: 1390,
      cardLast4: '4242',
    });
    const tasks = await tasksFor(order.id);
    expect(tasks.map((t) => t.stationCode).sort()).toEqual(['beverage', 'fry', 'grill']);
    expect(task(tasks, 'grill').modifiers).toEqual(['Extra cheese']);

    // Cola is configured to consume on acceptance; nothing else yet.
    let consumed = await consumptionForOrder(h, order.id);
    expect(consumed.map((c) => c.sku).sort()).toEqual(['PKG-CUP-M', 'PKG-LID-COLD', 'SYRUP-COLA']);

    // 3. Grill starts the burger — three duplicate taps race; consumption happens once.
    const grill = task(tasks, 'grill');
    const starts = await Promise.all([
      kitchen(grill.id, 'start'),
      kitchen(grill.id, 'start'),
      kitchen(grill.id, 'start'),
    ]);
    for (const s of starts) expect(s.status).toBe(200);
    consumed = await consumptionForOrder(h, order.id);
    const burgerRows = consumed.filter((c) => c.line_name === 'Cheeseburger');
    expect(burgerRows).toHaveLength(7);
    expect(Number(burgerRows.find((c) => c.sku === 'CHEESE-SLICE')!.quantity_delta)).toBe(-2);
    expect((await h.http.get(`/v1/public/orders/${order.publicToken}`)).body.status).toBe(
      'in_preparation',
    );

    // 4. Fries bumped straight from the queue: consumption on completion, once.
    expect((await kitchen(task(tasks, 'fry').id, 'complete')).status).toBe(200);
    expect((await kitchen(task(tasks, 'fry').id, 'complete')).status).toBe(200); // idempotent repeat
    consumed = await consumptionForOrder(h, order.id);
    expect(
      consumed
        .filter((c) => c.line_name === 'Medium Fries')
        .map((c) => c.sku)
        .sort(),
    ).toEqual(['FRIES-FROZEN', 'PKG-FRY-M']);

    // 5. Finish remaining tasks -> order becomes ready.
    expect((await kitchen(grill.id, 'complete')).status).toBe(200);
    expect((await h.http.get(`/v1/public/orders/${order.publicToken}`)).body.status).toBe(
      'in_preparation',
    );
    expect((await kitchen(task(tasks, 'beverage').id, 'complete')).status).toBe(200);
    expect((await h.http.get(`/v1/public/orders/${order.publicToken}`)).body.status).toBe('ready');

    // 6. Hand off exactly once.
    const handoff = await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/handoff`)
      .set(bearer(crew));
    expect(handoff.status).toBe(200);
    expect(handoff.body.status).toBe('completed');
    const again = await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/handoff`)
      .set(bearer(crew));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Final ledger state: 12 movements, one per (line, ingredient); reservations fully closed.
    consumed = await consumptionForOrder(h, order.id);
    expect(consumed).toHaveLength(12);
    expect(new Set(consumed.map((c) => `${c.source_id}:${c.sku}`)).size).toBe(12);
    const cheeseAfter = await balance(h, CENTRAL, 'CHEESE-SLICE');
    expect(cheeseAfter.reserved).toBe(cheeseBefore.reserved);
    expect(cheeseBefore.onHand - cheeseAfter.onHand).toBe(2);
    expect(await reconciliationErrors(h)).toEqual([]);

    // Order retains the menu and recipe versions it was priced and produced with.
    const persisted = await h.owner
      .selectFrom('orders')
      .select('menu_version_id')
      .where('id', '=', order.id)
      .executeTakeFirstOrThrow();
    expect(persisted.menu_version_id).toBe(menu.menuVersionId);
    const lines = await h.owner
      .selectFrom('order_lines')
      .select(['kind', 'recipe_version_id'])
      .where('order_id', '=', order.id)
      .execute();
    expect(
      lines.filter((l) => l.kind === 'component').every((l) => l.recipe_version_id !== null),
    ).toBe(true);

    // Events were written to the outbox with a gap-free store sequence.
    const events = await h.owner
      .selectFrom('outbox_events')
      .select(['event_type', 'store_sequence'])
      .where('restaurant_id', '=', centralId)
      .orderBy('store_sequence')
      .execute();
    const seqs = events.map((e) => Number(e.store_sequence));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(events.map((e) => e.event_type)).toEqual(
      expect.arrayContaining([
        'order.placed',
        'payment.captured',
        'order.accepted',
        'kitchen.task.started',
        'order.ready',
        'order.completed',
      ]),
    );
  });

  it('declined payments leave the order awaiting payment with nothing sent to the kitchen', async () => {
    const menu = await getMenu(h, CENTRAL);
    const placed = await placeOrder(h, CENTRAL, [
      { menuItemId: item(menu, 'Cheeseburger').id, quantity: 1 },
    ]);
    const declined = await pay(h, placed.body.publicToken, 'tok_sandbox_decline');
    expect(declined.status).toBe(402);
    expect(declined.body.status).toBe('pending_payment');
    expect(declined.body.payment).toMatchObject({
      status: 'failed',
      failureReason: 'card_declined',
    });
    expect(await tasksFor(placed.body.id)).toHaveLength(0);

    const retry = await pay(h, placed.body.publicToken, 'tok_sandbox_approve');
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('accepted');
    const paidAgain = await pay(h, placed.body.publicToken, 'tok_sandbox_approve');
    expect(paidAgain.status).toBe(409);
    expect(paidAgain.body.error.code).toBe('ORDER_NOT_AWAITING_PAYMENT');
  });

  it('never trusts client prices and rejects card numbers in place of tokens', async () => {
    const menu = await getMenu(h, CENTRAL);
    const burger = item(menu, 'Cheeseburger');
    const tampered = await h.http
      .post(`/v1/public/restaurants/${CENTRAL}/orders`)
      .set('Idempotency-Key', 'tamper-test-0001')
      .send({
        fulfilmentType: 'takeaway',
        lines: [{ menuItemId: burger.id, quantity: 1, priceCents: 1 }],
        totalCents: 1,
      });
    expect(tampered.status).toBe(201);
    expect(tampered.body.totalCents).toBe(burger.priceCents);

    const pan = await h.http
      .post(`/v1/public/orders/${tampered.body.publicToken}/payments`)
      .set('Idempotency-Key', 'pan-test-00001')
      .send({ method: 'card', paymentToken: '4242424242424242' });
    expect(pan.status).toBe(400);
    expect(pan.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects items from another restaurant menu and unknown modifiers', async () => {
    const express = await getMenu(h, 'kitchos-express');
    const res = await placeOrder(h, CENTRAL, [
      { menuItemId: item(express, 'Toasted Croissant').id, quantity: 1 },
    ]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MENU_ITEM_NOT_FOUND');

    const central = await getMenu(h, CENTRAL);
    const fries = item(central, 'Medium Fries');
    const burger = item(central, 'Cheeseburger');
    const bad = await placeOrder(h, CENTRAL, [
      { menuItemId: fries.id, quantity: 1, modifierOptionIds: [option(burger, 'Extra cheese')] },
    ]);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('MODIFIER_NOT_FOUND');
  });

  it('serves a public pickup board without customer data', async () => {
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Medium Cola').id, quantity: 1 },
    ]);
    const board = await h.http.get(`/v1/public/restaurants/${CENTRAL}/pickup-board`).expect(200);
    expect(board.body.preparing).toContain(order.orderNumber);
    expect(JSON.stringify(board.body)).not.toContain('Test Guest');
  });
});
