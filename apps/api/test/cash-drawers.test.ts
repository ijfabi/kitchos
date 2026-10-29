import { randomUUID } from 'node:crypto';
import type { DrawerSessionView, DrawerView, KitchenTaskView, OrderView } from '@kitchos/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import {
  bearer,
  getMenu,
  item,
  login,
  restaurantId,
  startHarness,
  type Harness,
} from './harness.ts';

const DRIVE = 'kitchos-drive';

describe('cash drawers: sessions, movements, blind counts and variance approval', () => {
  let h: Harness;
  let driveId: string;
  let cashier: string; // crew2@drive
  let supervisor: string;
  let manager: string;
  let dispatcher: EventDispatcher;
  let mealId: string;

  beforeAll(async () => {
    h = await startHarness();
    driveId = await restaurantId(h, DRIVE);
    cashier = await login(h, 'crew2@drive.kitchos.test');
    supervisor = await login(h, 'supervisor@drive.kitchos.test');
    manager = await login(h, 'manager@drive.kitchos.test');
    dispatcher = h.app.get(EventDispatcher);
    mealId = item(await getMenu(h, DRIVE), 'Cheeseburger Meal').id; // 1190c at Drive
  });
  afterAll(() => h.close());

  const base = () => `/v1/restaurants/${driveId}/cash`;
  const drawers = async (token: string) =>
    (await h.http.get(`${base()}/drawers`).set(bearer(token)).expect(200)).body as DrawerView[];
  const freeDrawer = async (token: string) => (await drawers(token)).find((d) => !d.activeSession)!;
  const open = (token: string, drawerId: string, openingFloatCents: number) =>
    h.http
      .post(`${base()}/drawers/${drawerId}/sessions`)
      .set(bearer(token))
      .send({ openingFloatCents });
  const move = (
    token: string,
    sessionId: string,
    kind: string,
    amountCents: number,
    reason = 'Test movement',
  ) =>
    h.http
      .post(`${base()}/sessions/${sessionId}/movements`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ kind, amountCents, reason });
  const count = (token: string, sessionId: string, countedCents: number) =>
    h.http
      .post(`${base()}/sessions/${sessionId}/count`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ countedCents, notes: 'End of shift' });
  const session = async (token: string, id: string) =>
    (await h.http.get(`${base()}/sessions/${id}`).set(bearer(token)).expect(200))
      .body as DrawerSessionView;
  const ringAndPayCash = async (token: string, tenderedCents = 2000, extra: object = {}) => {
    const order = (
      await h.http
        .post(`/v1/restaurants/${driveId}/orders`)
        .set(bearer(token))
        .set('Idempotency-Key', randomUUID())
        .send({ fulfilmentType: 'takeaway', lines: [{ menuItemId: mealId, quantity: 1 }] })
    ).body as OrderView;
    const paid = await h.http
      .post(`/v1/restaurants/${driveId}/orders/${order.id}/payments`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'cash', tenderedCents, ...extra });
    return { order, paid };
  };
  /** Net debit on cash on hand across all journal entries that belong to a drawer session. */
  const sessionCashOnHand = async (sessionId: string) => {
    const { rows } = await sql<{ net: string }>`
      select coalesce(sum(l.debit_cents - l.credit_cents), 0) as net
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      where a.system_key = 'cash_on_hand' and (
        e.source_id = ${sessionId}::uuid
        or e.source_id in (select id from drawer_movements where session_id = ${sessionId}::uuid)
        or e.source_id in (select id from payments where drawer_session_id = ${sessionId}::uuid)
        or e.source_id in (select id from refunds where drawer_session_id = ${sessionId}::uuid))`.execute(
      h.owner,
    );
    return Number(rows[0]!.net);
  };

  let sessionId: string;

  it('opens one session per drawer and per cashier; the cashier counts blind', async () => {
    const drawer = await freeDrawer(cashier);
    const res = await open(cashier, drawer.id, 20_000);
    expect(res.status).toBe(201);
    sessionId = res.body.id;
    expect(res.body).toMatchObject({ status: 'open', openingFloatCents: 20_000, expected: null }); // blind

    expect((await open(supervisor, drawer.id, 5_000)).body.error.code).toBe('DRAWER_IN_USE');
    const other = await freeDrawer(cashier);
    expect((await open(cashier, other.id, 5_000)).body.error.code).toBe('ALREADY_HAVE_DRAWER');
    expect((await session(supervisor, sessionId)).expected).toMatchObject({
      expectedCents: 20_000,
    }); // managers see it
  });

  it('cash sales, safe drops, paid-ins and paid-outs move the expected cash; rules are enforced', async () => {
    const { paid } = await ringAndPayCash(cashier, 2000);
    expect(paid.status).toBe(200);
    const pay = await h.owner
      .selectFrom('payments')
      .select('drawer_session_id')
      .where('order_id', '=', paid.body.id)
      .executeTakeFirstOrThrow();
    expect(pay.drawer_session_id).toBe(sessionId);

    expect((await move(cashier, sessionId, 'safe_drop', 10_000, 'Mid-shift drop')).status).toBe(
      201,
    );
    expect((await move(cashier, sessionId, 'paid_out', 500, 'Milk run')).status).toBe(403); // needs cash.manage
    expect((await move(supervisor, sessionId, 'paid_out', 500, 'Milk run')).status).toBe(201);
    expect((await move(cashier, sessionId, 'paid_in', 1_000, 'Change top-up')).status).toBe(201);
    // A manager (who can see expected cash) cannot remove more than the drawer holds.
    const tooMuch = await move(supervisor, sessionId, 'safe_drop', 999_999);
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_DRAWER_CASH');

    const view = await session(supervisor, sessionId);
    expect(view.expected).toEqual({
      cashSalesCents: 1_190,
      cashRefundsCents: 0,
      paidInsCents: 1_000,
      paidOutsCents: 500,
      safeDropsCents: 10_000,
      expectedCents: 20_000 + 1_190 + 1_000 - 500 - 10_000,
    });
  });

  it('cash only goes through your own open drawer', async () => {
    // Supervisor has no session yet.
    expect((await ringAndPayCash(supervisor)).paid.body.error.code).toBe('DRAWER_SESSION_REQUIRED');
    // ...and cannot push cash through the cashier's drawer either.
    expect(
      (await ringAndPayCash(supervisor, 2000, { drawerSessionId: sessionId })).paid.status,
    ).toBe(403);
  });

  it('a small variance closes the drawer; the journal moves counted cash to the safe and books the shortage', async () => {
    const expected = 20_000 + 1_190 + 1_000 - 500 - 10_000;
    const res = await count(cashier, sessionId, expected - 40);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'closed',
      countedCents: expected - 40,
      varianceCents: -40,
    });
    expect(res.body.expected.expectedCents).toBe(expected); // revealed only after counting

    await dispatcher.runOnce();
    const close = await h.owner
      .selectFrom('journal_entries as e')
      .innerJoin('journal_lines as l', 'l.entry_id', 'e.id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['a.system_key', 'l.debit_cents', 'l.credit_cents'])
      .where('e.source_id', '=', sessionId)
      .where('e.entry_type', '=', 'drawer_close')
      .execute();
    expect(
      Object.fromEntries(close.map((l) => [l.system_key, l.debit_cents - l.credit_cents])),
    ).toEqual({
      cash_in_safe: expected - 40,
      cash_over_short: 40,
      cash_on_hand: -expected,
    });
    expect(await sessionCashOnHand(sessionId)).toBe(0); // every cent in and out of the drawer accounted for

    // Closed: no more cash through it.
    expect((await ringAndPayCash(cashier)).paid.body.error.code).toBe('DRAWER_SESSION_REQUIRED');
    expect((await move(cashier, sessionId, 'paid_in', 100)).body.error.code).toBe(
      'DRAWER_SESSION_CLOSED',
    );
  });

  it('a large variance waits for approval by someone else with cash.manage', async () => {
    const drawer = await freeDrawer(cashier);
    const s = (await open(cashier, drawer.id, 10_000)).body as DrawerSessionView;
    // A blind cashier's safe drop is not checked against the hidden expected cash (a 422
    // would let them probe it); dropping more than the drawer held shows up at the count.
    expect((await move(cashier, s.id, 'safe_drop', 12_000, 'Big drop')).status).toBe(201);
    const counted = await count(cashier, s.id, 0);
    expect(counted.body).toMatchObject({ status: 'pending_approval', varianceCents: 2_000 });
    expect(counted.body.expected.expectedCents).toBe(-2_000);
    await dispatcher.runOnce();
    const noClose = await h.owner
      .selectFrom('journal_entries')
      .select('id')
      .where('source_id', '=', s.id)
      .where('entry_type', '=', 'drawer_close')
      .execute();
    expect(noClose).toHaveLength(0); // not posted until approved

    const approve = (token: string, id: string) =>
      h.http
        .post(`${base()}/sessions/${id}/approve`)
        .set(bearer(token))
        .send({ notes: 'Recounted with cashier' });
    expect((await approve(cashier, s.id)).status).toBe(403);
    const ok = await approve(supervisor, s.id);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'closed', approvedBy: 'Aisha Rahman' });
    await dispatcher.runOnce();
    expect(await sessionCashOnHand(s.id)).toBe(0);

    // A supervisor working a till counts blind like anyone else...
    const supDrawer = await freeDrawer(supervisor);
    const own = (await open(supervisor, supDrawer.id, 1_000)).body as DrawerSessionView;
    expect(own.expected).toBeNull();
    expect((await session(supervisor, own.id)).expected).toBeNull();
    expect((await session(manager, own.id)).expected).toMatchObject({ expectedCents: 1_000 });
    // ...and can never approve their own variance, whoever counted it.
    expect((await count(manager, own.id, 0)).body.status).toBe('pending_approval');
    expect((await approve(supervisor, own.id)).status).toBe(403);
    expect((await approve(manager, own.id)).status).toBe(403); // the counter
    const admin = await login(h, 'admin@kitchos.test');
    expect((await approve(admin, own.id)).status).toBe(200);
  });

  it('one person cannot open two drawers at once, even racing', async () => {
    const free = (await drawers(manager)).filter((d) => !d.activeSession);
    expect(free.length).toBeGreaterThanOrEqual(2);
    const results = await Promise.all([
      open(manager, free[0]!.id, 0),
      open(manager, free[1]!.id, 0),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('ALREADY_HAVE_DRAWER');
    const won = results.find((r) => r.status === 201)!.body as DrawerSessionView;
    // The database itself refuses a second active session for the same person.
    const row = await h.owner
      .selectFrom('drawer_sessions')
      .select(['org_id', 'opened_by', 'business_date'])
      .where('id', '=', won.id)
      .executeTakeFirstOrThrow();
    const other = free.find((d) => d.id !== results.find((r) => r.status === 201)!.body.drawerId)!;
    await expect(
      h.owner
        .insertInto('drawer_sessions')
        .values({
          org_id: row.org_id,
          restaurant_id: driveId,
          drawer_id: other.id,
          opened_by: row.opened_by,
          opening_float_cents: 0,
          business_date: row.business_date,
        })
        .execute(),
    ).rejects.toThrow(/drawer_sessions_one_per_user/);
    await count(manager, won.id, 0).expect(200);
  });

  it('a replayed movement is rendered for the caller, not the original (manager) actor', async () => {
    const s = (await open(cashier, (await freeDrawer(cashier)).id, 3_000))
      .body as DrawerSessionView;
    const key = randomUUID();
    const body = { kind: 'paid_in', amountCents: 500, reason: 'Change from safe' };
    const first = await h.http
      .post(`${base()}/sessions/${s.id}/movements`)
      .set(bearer(supervisor))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(first.body.expected).toMatchObject({ expectedCents: 3_500 });
    const replay = await h.http
      .post(`${base()}/sessions/${s.id}/movements`)
      .set(bearer(cashier))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.expected).toBeNull();
    expect(replay.body.movements).toHaveLength(1);
    await count(cashier, s.id, 3_500).expect(200);
  });

  it('cash refunds come out of the refunder’s own drawer and need enough cash in it', async () => {
    const mine = (await open(cashier, (await freeDrawer(cashier)).id, 5_000))
      .body as DrawerSessionView;
    const { order } = await ringAndPayCash(cashier, 2000);
    const tasks = (
      await h.http.get(`/v1/restaurants/${driveId}/kitchen/tasks`).set(bearer(cashier))
    ).body as KitchenTaskView[];
    for (const t of tasks.filter((x) => x.orderId === order.id)) {
      await h.http
        .post(`/v1/restaurants/${driveId}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(cashier))
        .send({})
        .expect(200);
    }
    await h.http
      .post(`/v1/restaurants/${driveId}/orders/${order.id}/handoff`)
      .set(bearer(cashier))
      .expect(200);

    const refund = (token: string) =>
      h.http
        .post(`/v1/restaurants/${driveId}/orders/${order.id}/refunds`)
        .set(bearer(token))
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'quality' });
    expect((await refund(manager)).body.error.code).toBe('DRAWER_SESSION_REQUIRED');
    const mgrDrawer = await freeDrawer(manager);
    await open(manager, mgrDrawer.id, 0).expect(201);
    expect((await refund(manager)).body.error.code).toBe('INSUFFICIENT_DRAWER_CASH');

    // The supervisor (who may refund) opens a drawer with enough cash: the refund comes out of it.
    const supDrawer = await freeDrawer(supervisor);
    const supSession = (await open(supervisor, supDrawer.id, 5_000)).body as DrawerSessionView;
    const ok = await refund(supervisor);
    expect(ok.status).toBe(201);
    const row = await h.owner
      .selectFrom('refunds')
      .select(['drawer_session_id', 'amount_cents'])
      .where('order_id', '=', order.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ drawer_session_id: supSession.id, amount_cents: 1_190 });
    expect((await session(manager, supSession.id)).expected).toMatchObject({
      cashRefundsCents: 1_190,
      expectedCents: 5_000 - 1_190,
    });

    // The cashier's sale is still in their own drawer.
    expect((await session(manager, mine.id)).expected).toMatchObject({
      cashSalesCents: 1_190,
      expectedCents: 5_000 + 1_190,
    });
    // Free the drawers again (the restaurant has only four, shared with other test files).
    await count(supervisor, supSession.id, 5_000 - 1_190).expect(200);
    const mgr = (await drawers(manager)).find(
      (d) => d.activeSession?.openedBy === 'Daniel Moretti',
    )!;
    await count(manager, mgr.activeSession!.id, 0).expect(200);
  });

  it('a cash payment taken before drawers existed can still be refunded', async () => {
    // Regression: a NOT VALID "cash needs a drawer" CHECK is re-checked on UPDATE, so
    // refunding (which updates the payment row) a legacy cash payment used to fail.
    const { order } = await ringAndPayCash(cashier, 2000); // the cashier's drawer from the previous test
    const tasks = (
      await h.http.get(`/v1/restaurants/${driveId}/kitchen/tasks`).set(bearer(cashier))
    ).body as KitchenTaskView[];
    for (const t of tasks.filter((x) => x.orderId === order.id)) {
      await h.http
        .post(`/v1/restaurants/${driveId}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(cashier))
        .send({})
        .expect(200);
    }
    await h.http
      .post(`/v1/restaurants/${driveId}/orders/${order.id}/handoff`)
      .set(bearer(cashier))
      .expect(200);
    // Make it look like a payment from before migration 0008.
    await h.owner
      .updateTable('payments')
      .set({ drawer_session_id: null })
      .where('order_id', '=', order.id)
      .execute();

    const supSession = (await open(supervisor, (await freeDrawer(supervisor)).id, 5_000))
      .body as DrawerSessionView;
    const res = await h.http
      .post(`/v1/restaurants/${driveId}/orders/${order.id}/refunds`)
      .set(bearer(supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'quality' });
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ status: 'refunded', refundedCents: 1_190 });
    await count(supervisor, supSession.id, 5_000 - 1_190).expect(200);
  });

  it('a count racing a cash payment never loses the payment from the expected cash', async () => {
    // Close the cashier's session left from the previous test.
    const current = (await drawers(cashier)).find(
      (d) => d.activeSession?.openedBy === 'Sofia Nguyen',
    );
    if (current?.activeSession) {
      const v = await session(supervisor, current.activeSession.id);
      await count(cashier, current.activeSession.id, v.expected!.expectedCents).expect(200);
    }
    for (let round = 0; round < 4; round++) {
      const s = (await open(cashier, (await freeDrawer(cashier)).id, 3_000))
        .body as DrawerSessionView;
      const [pay, closed] = await Promise.all([
        ringAndPayCash(cashier, 1190),
        count(cashier, s.id, 3_000),
      ]);
      expect(closed.status).toBe(200);
      const row = await h.owner
        .selectFrom('drawer_sessions')
        .select(['expected_cents', 'status'])
        .where('id', '=', s.id)
        .executeTakeFirstOrThrow();
      const linked = await h.owner
        .selectFrom('payments')
        .select(sql<string>`coalesce(sum(amount_cents + cash_rounding_cents), 0)`.as('cents'))
        .where('drawer_session_id', '=', s.id)
        .executeTakeFirstOrThrow();
      // Whatever the interleaving, the snapshot equals the float plus every payment linked to the session.
      expect(row.expected_cents).toBe(3_000 + Number(linked.cents));
      if (pay.paid.status === 200) {
        expect(Number(linked.cents)).toBe(1_190);
      } else {
        expect(pay.paid.body.error.code).toMatch(/^DRAWER_SESSION_(REQUIRED|CLOSED)$/);
        expect(Number(linked.cents)).toBe(0);
      }
      if (row.status === 'pending_approval') {
        await h.http
          .post(`${base()}/sessions/${s.id}/approve`)
          .set(bearer(manager))
          .send({ notes: 'Race test' })
          .expect(200);
      }
    }
  });

  it('a payment waits for an in-flight count and is refused once the session closes', async () => {
    // Deterministic version of the race: hold the count's row lock, start a cash payment,
    // then close the session. Without the FOR SHARE lock the payment would land on a
    // session whose expected cash was already fixed.
    const s = (await open(cashier, (await freeDrawer(cashier)).id, 2_000))
      .body as DrawerSessionView;
    const order = (
      await h.http
        .post(`/v1/restaurants/${driveId}/orders`)
        .set(bearer(cashier))
        .set('Idempotency-Key', randomUUID())
        .send({ fulfilmentType: 'takeaway', lines: [{ menuItemId: mealId, quantity: 1 }] })
    ).body as OrderView;
    let settled = false;
    let payment: Promise<{ status: number; body: { error?: { code: string } } }> | undefined;
    await h.owner.transaction().execute(async (trx) => {
      await sql`select id from drawer_sessions where id = ${s.id}::uuid for update`.execute(trx);
      payment = h.http
        .post(`/v1/restaurants/${driveId}/orders/${order.id}/payments`)
        .set(bearer(cashier))
        .set('Idempotency-Key', randomUUID())
        .send({ method: 'cash', tenderedCents: 2000 })
        .then((r) => {
          settled = true;
          return r;
        });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // blocked behind the count
      await sql`update drawer_sessions set status = 'closed', counted_at = now(), counted_cents = 2000,
        expected_cents = 2000, variance_cents = 0, closed_at = now() where id = ${s.id}::uuid`.execute(
        trx,
      );
    });
    const res = await payment!;
    expect(res.status).toBe(409);
    expect(res.body.error!.code).toMatch(/^DRAWER_SESSION_(REQUIRED|CLOSED)$/);
    expect(
      await h.owner.selectFrom('payments').select('id').where('order_id', '=', order.id).execute(),
    ).toHaveLength(0);
  });

  it('the database refuses cash on a closed session or another restaurant’s session', async () => {
    const closed = await h.owner
      .selectFrom('drawer_sessions')
      .select(['id', 'org_id'])
      .where('restaurant_id', '=', driveId)
      .where('status', '=', 'closed')
      .executeTakeFirstOrThrow();
    const user = await h.owner
      .selectFrom('users')
      .select('id')
      .where('email', '=', 'crew2@drive.kitchos.test')
      .executeTakeFirstOrThrow();
    await expect(
      h.owner
        .insertInto('drawer_movements')
        .values({
          org_id: closed.org_id,
          session_id: closed.id,
          kind: 'paid_in',
          amount_cents: 100,
          reason: 'Bypassing the API',
          recorded_by: user.id,
        })
        .execute(),
    ).rejects.toThrow(/is not open/);
    // A cash payment for a Central order cannot reference a Drive session.
    const centralCrew = await login(h, 'crew1@central.kitchos.test');
    const centralId = await restaurantId(h, 'kitchos-central');
    const latteId = item(await getMenu(h, 'kitchos-central'), 'Latte').id;
    const centralOrder = (
      await h.http
        .post(`/v1/restaurants/${centralId}/orders`)
        .set(bearer(centralCrew))
        .set('Idempotency-Key', randomUUID())
        .send({ fulfilmentType: 'dine_in', lines: [{ menuItemId: latteId, quantity: 1 }] })
        .expect(201)
    ).body as OrderView;
    const driveOpen = (await open(cashier, (await freeDrawer(cashier)).id, 0))
      .body as DrawerSessionView;
    await expect(
      sql`insert into payments (org_id, restaurant_id, order_id, method, provider, status, amount_cents, drawer_session_id)
          select org_id, restaurant_id, id, 'cash', 'cash', 'failed', 1, ${driveOpen.id}::uuid
          from orders where id = ${centralOrder.id}::uuid`.execute(h.owner),
    ).rejects.toThrow(/another restaurant/);
    await count(cashier, driveOpen.id, 0).expect(200);
    // Release the Central order's stock reservation.
    const centralSupervisor = await login(h, 'supervisor@central.kitchos.test');
    await h.http
      .post(`/v1/restaurants/${centralOrder.restaurantId}/orders/${centralOrder.id}/cancel`)
      .set(bearer(centralSupervisor))
      .send({ reason: 'Test cleanup' })
      .expect(200);
  });

  it('drawer access follows permissions and tenancy', async () => {
    const auditor = await login(h, 'auditor@kitchos.test');
    const rival = await login(h, 'manager@rival.test');
    expect((await h.http.get(`${base()}/drawers`).set(bearer(auditor))).status).toBe(403);
    expect((await h.http.get(`${base()}/drawers`).set(bearer(rival))).status).toBe(404);
    const { rows } = await sql<{
      d: string;
    }>`select app.business_date(${driveId}::uuid, now())::text as d`.execute(h.owner);
    expect(
      (await h.http.get(`${base()}/sessions?businessDate=${rows[0]!.d}`).set(bearer(cashier)))
        .status,
    ).toBe(403);
    const list = await h.http
      .get(`${base()}/sessions?businessDate=${rows[0]!.d}`)
      .set(bearer(manager))
      .expect(200);
    expect(
      (list.body as DrawerSessionView[]).some(
        (s) => s.varianceCents === 2_000 && s.approvedBy === 'Aisha Rahman',
      ),
    ).toBe(true);

    await dispatcher.runOnce();
    const rec = await h.http
      .get(`/v1/restaurants/${driveId}/accounting/reconciliation?businessDate=${rows[0]!.d}`)
      .set(bearer(manager))
      .expect(200);
    expect(rec.body).toMatchObject({ reconciled: true, pendingEvents: 0 });
  });
});
