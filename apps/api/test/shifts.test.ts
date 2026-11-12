import { randomUUID } from 'node:crypto';
import type { CurrentShift, DrawerSessionView, OrderView, ShiftView } from '@kitchos/contracts';
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

/**
 * Shifts across drawers and people (ADR-0018). Runs in a restaurant of its own (same org and
 * menu as Drive) so no other file's drawers or sales fall into its shifts, and every drawer it
 * opens is closed again.
 */
describe('shifts and shift close', () => {
  let h: Harness;
  let dispatcher: EventDispatcher;
  let rid: string;
  let mealId: string;
  const t = { manager: '', supervisor: '', crewA: '', crewB: '', otherManager: '', rival: '' };
  const names = { crewA: '', crewB: '' };

  beforeAll(async () => {
    h = await startHarness();
    dispatcher = h.app.get(EventDispatcher);
    const driveId = await restaurantId(h, 'kitchos-drive');
    const drive = await h.owner
      .selectFrom('restaurants')
      .selectAll()
      .where('id', '=', driveId)
      .executeTakeFirstOrThrow();
    const tag = randomUUID().slice(0, 8);
    rid = (
      await h.owner
        .insertInto('restaurants')
        .values({
          org_id: drive.org_id,
          brand_id: drive.brand_id,
          region_id: drive.region_id,
          menu_id: drive.menu_id,
          name: `Shift test ${tag}`,
          slug: `shift-${tag}`,
          ownership: 'company',
          timezone: drive.timezone,
          stock_shortage_policy: 'allow_negative',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const stations = await h.owner
      .selectFrom('stations')
      .select(['code', 'name', 'station_types'])
      .where('restaurant_id', '=', driveId)
      .execute();
    await h.owner
      .insertInto('stations')
      .values(stations.map((s) => ({ ...s, org_id: drive.org_id, restaurant_id: rid })))
      .execute();
    await h.owner
      .insertInto('stock_locations')
      .values({
        org_id: drive.org_id,
        restaurant_id: rid,
        code: 'main',
        name: 'Main',
        is_default: true,
      })
      .execute();
    await h.owner
      .insertInto('restaurant_event_sequences')
      .values({ org_id: drive.org_id, restaurant_id: rid })
      .execute();
    await h.owner
      .insertInto('cash_drawers')
      .values(
        ['till-1', 'till-2', 'till-3'].map((code) => ({
          org_id: drive.org_id,
          restaurant_id: rid,
          code,
          name: code.replace('till-', 'Till '),
        })),
      )
      .execute();
    const { password_hash } = await h.owner
      .selectFrom('users')
      .select('password_hash')
      .where('email', '=', 'manager@drive.kitchos.test')
      .executeTakeFirstOrThrow();
    const user = async (k: string, role: string) => {
      const email = `${k}-${tag}@shift.test`;
      const u = await h.owner
        .insertInto('users')
        .values({ org_id: drive.org_id, email, display_name: `Shift ${k}`, password_hash })
        .returning(['id', 'display_name'])
        .executeTakeFirstOrThrow();
      await h.owner
        .insertInto('role_assignments')
        .values({
          org_id: drive.org_id,
          user_id: u.id,
          role,
          scope_type: 'restaurant',
          scope_id: rid,
        })
        .execute();
      return { token: await login(h, email), name: u.display_name };
    };
    t.manager = (await user('manager', 'restaurant_manager')).token;
    t.supervisor = (await user('supervisor', 'shift_supervisor')).token;
    const a = await user('crew-a', 'crew_member');
    const b = await user('crew-b', 'crew_member');
    [t.crewA, names.crewA, t.crewB, names.crewB] = [a.token, a.name, b.token, b.name];
    t.otherManager = await login(h, 'manager@drive.kitchos.test');
    t.rival = await login(h, 'manager@rival.test');
    mealId = item(await getMenu(h, 'kitchos-drive'), 'Cheeseburger Meal').id;
  });

  afterAll(async () => {
    while ((await dispatcher.runOnce()).processed > 0);
    const open = await h.owner
      .selectFrom('drawer_sessions')
      .select('id')
      .where('restaurant_id', '=', rid)
      .where('status', '<>', 'closed')
      .execute();
    await h.close();
    expect(open).toEqual([]);
  });

  const api = () => `/v1/restaurants/${rid}`;
  const current = async (token = t.supervisor) =>
    (
      (await h.http.get(`${api()}/shifts/current`).set(bearer(token)).expect(200))
        .body as CurrentShift
    ).shift;
  const openShift = (token = t.supervisor) =>
    h.http.post(`${api()}/shifts`).set(bearer(token)).send();
  const closeShift = (id: string, body: object = {}, token = t.supervisor) =>
    h.http.post(`${api()}/shifts/${id}/close`).set(bearer(token)).send(body);
  const freeDrawer = async () =>
    (
      (await h.http.get(`${api()}/cash/drawers`).set(bearer(t.manager)).expect(200)).body as {
        id: string;
        activeSession: unknown;
      }[]
    ).find((d) => !d.activeSession)!.id;
  const openDrawer = async (token: string, floatCents = 10_000) => {
    const res = await h.http
      .post(`${api()}/cash/drawers/${await freeDrawer()}/sessions`)
      .set(bearer(token))
      .send({ openingFloatCents: floatCents });
    expect(res.status).toBe(201);
    return res.body as DrawerSessionView;
  };
  const count = async (token: string, sessionId: string, countedCents: number) => {
    const res = await h.http
      .post(`${api()}/cash/sessions/${sessionId}/count`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ countedCents });
    expect(res.status).toBe(200);
    return res.body as DrawerSessionView;
  };
  /** Counts a drawer exactly (the manager can see its expected cash). */
  const countExact = async (token: string, sessionId: string) => {
    const s = (
      await h.http.get(`${api()}/cash/sessions/${sessionId}`).set(bearer(t.manager)).expect(200)
    ).body as DrawerSessionView;
    return count(token, sessionId, s.expected!.expectedCents);
  };
  const ring = async (token: string, quantity = 1) => {
    const res = await h.http
      .post(`${api()}/orders`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ fulfilmentType: 'takeaway', lines: [{ menuItemId: mealId, quantity }] });
    expect(res.status).toBe(201);
    return res.body as OrderView;
  };
  const pay = async (token: string, orderId: string, tender: object) => {
    const res = await h.http
      .post(`${api()}/orders/${orderId}/payments`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send(tender);
    expect(res.status).toBe(200);
    return res.body as OrderView;
  };
  const handOver = async (orderId: string) => {
    const tasks = (
      (await h.http.get(`${api()}/kitchen/tasks`).set(bearer(t.crewB)).expect(200)).body as {
        id: string;
        orderId: string;
      }[]
    ).filter((k) => k.orderId === orderId);
    for (const k of tasks) {
      await h.http
        .post(`${api()}/kitchen/tasks/${k.id}/complete`)
        .set(bearer(t.crewB))
        .send({})
        .expect(200);
    }
    await h.http.post(`${api()}/orders/${orderId}/handoff`).set(bearer(t.crewB)).expect(200);
  };
  const CARD = { method: 'card', paymentToken: 'tok_sandbox_approve' };
  const cash = (o: OrderView) => ({ method: 'cash', tenderedCents: o.totalCents + 1000 });
  const shiftOf = async (sessionId: string) =>
    (
      await h.owner
        .selectFrom('drawer_sessions')
        .select('shift_id')
        .where('id', '=', sessionId)
        .executeTakeFirstOrThrow()
    ).shift_id;

  it('needs shift.run at this restaurant', async () => {
    expect((await h.http.get(`${api()}/shifts/current`).set(bearer(t.crewA))).status).toBe(403);
    expect((await openShift(t.crewA)).status).toBe(403);
    expect((await h.http.get(`${api()}/shifts/current`).set(bearer(t.otherManager))).status).toBe(
      404,
    );
    expect((await h.http.get(`${api()}/shifts/current`).set(bearer(t.rival))).status).toBe(404);
    expect((await openShift(t.rival)).status).toBe(404);
    expect(await current()).toBeNull();
  });

  let shift: ShiftView;
  let early: DrawerSessionView;
  let late: DrawerSessionView;
  const sold = { cashA: 0, cardA: 0, cardB: 0, discountB: 0, refundB: 0 };

  it('a shift takes in drawers already running, and drawers opened during it join it', async () => {
    // Sold before the shift: not the shift's.
    const before = await ring(t.crewA);
    early = await openDrawer(t.crewA);
    await pay(t.crewA, before.id, cash(before));

    const res = await openShift();
    expect(res.status).toBe(201);
    shift = res.body as ShiftView;
    expect(shift).toMatchObject({ status: 'open', openedBy: 'Shift supervisor' });
    expect(shift.blockers.map((b) => b.code)).toEqual(['DRAWERS_OPEN']);
    expect(shift.drawers.map((d) => d.sessionId)).toEqual([early.id]);
    expect(await shiftOf(early.id)).toBe(shift.id);
    expect((await openShift(t.manager)).body.error.code).toBe('SHIFT_ALREADY_OPEN');

    late = await openDrawer(t.crewB);
    expect(await shiftOf(late.id)).toBe(shift.id);
    expect((await current())!.drawers.map((d) => d.sessionId)).toEqual([early.id, late.id]);
  });

  it('cash and each person’s sales stay hidden while a drawer is uncounted', async () => {
    const a1 = await ring(t.crewA);
    sold.cashA += (await pay(t.crewA, a1.id, cash(a1))).payment!.amountCents;
    const a2 = await ring(t.crewA);
    sold.cardA += (await pay(t.crewA, a2.id, CARD)).payment!.amountCents;
    const b1 = await ring(t.crewB, 2);
    const discounted = await h.http
      .post(`${api()}/orders/${b1.id}/discount`)
      .set(bearer(t.crewB))
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'percent', value: 1000, reason: 'customer_service' });
    expect(discounted.status).toBe(200);
    sold.discountB = (discounted.body as OrderView).discountCents;
    sold.cardB += (await pay(t.crewB, b1.id, CARD)).payment!.amountCents;
    const b2 = await ring(t.crewB);
    sold.cardB += (await pay(t.crewB, b2.id, CARD)).payment!.amountCents;
    // Handed over, then a card refund by amount, made by the supervisor.
    await handOver(b2.id);
    const refund = await h.http
      .post(`${api()}/orders/${b2.id}/refunds`)
      .set(bearer(t.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'other', amountCents: 250 });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    sold.refundB = 250;
    // Placed but never paid, then cancelled.
    const c = await ring(t.crewA);
    expect(
      (
        await h.http
          .post(`${api()}/orders/${c.id}/cancel`)
          .set(bearer(t.supervisor))
          .send({ reason: 'customer_left' })
      ).status,
    ).toBeLessThan(300);

    const live = (await current())!;
    expect(live.totals).toMatchObject({
      ordersPlaced: 5,
      ordersCancelled: 1,
      cardTakenCents: sold.cardA + sold.cardB,
      cashTakenCents: null,
      cashRefundsCents: null,
      refundsCents: 250,
      discountsCents: sold.discountB,
      cashVarianceCents: null,
    });
    expect(live.people.every((p) => p.salesCents === null)).toBe(true);
    expect(live.drawers.every((d) => d.expectedCents === null)).toBe(true);
    expect(live.blockers.map((b) => b.code)).toEqual(['DRAWERS_OPEN']);
  });

  it('cannot close until every drawer is counted and its variance approved', async () => {
    const blocked = await closeShift(shift.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SHIFT_NOT_READY');
    expect(blocked.body.error.details.blockers[0].message).toContain(names.crewA);

    await countExact(t.crewA, early.id);
    // Crew B is 10.00 short: over the 5.00 threshold, so it needs approval.
    const s = (
      await h.http.get(`${api()}/cash/sessions/${late.id}`).set(bearer(t.manager)).expect(200)
    ).body as DrawerSessionView;
    expect((await count(t.crewB, late.id, s.expected!.expectedCents - 1000)).status).toBe(
      'pending_approval',
    );
    const pending = await closeShift(shift.id);
    expect(pending.body.error.details.blockers.map((b: { code: string }) => b.code)).toEqual([
      'VARIANCE_PENDING',
    ]);
    // Counted now: the live view shows cash again.
    expect((await current())!.totals.cashVarianceCents).toBe(-1000);

    expect(
      (
        await h.http
          .post(`${api()}/cash/sessions/${late.id}/approve`)
          .set(bearer(t.manager))
          .send({ notes: 'Short change given, confirmed on camera' })
      ).status,
    ).toBe(200);
  });

  let closed: ShiftView;

  it('closes with a snapshot of its drawers, people and totals', async () => {
    const before = (await current())!;
    const res = await closeShift(shift.id, { notes: 'Lunch handover' });
    expect(res.status).toBe(200);
    closed = res.body as ShiftView;
    expect(closed).toMatchObject({
      status: 'closed',
      closedBy: 'Shift supervisor',
      notes: 'Lunch handover',
      blockers: [],
    });
    expect(closed.totals).toEqual({ ...before.totals });
    expect(closed.totals).toMatchObject({
      ordersPlaced: 5,
      cashTakenCents: sold.cashA,
      cashRefundsCents: 0,
      cashVarianceCents: -1000,
    });
    const person = (n: string) => closed.people.find((p) => p.name === n)!;
    expect(person(names.crewA)).toMatchObject({
      ordersPlaced: 3,
      salesCents: sold.cashA + sold.cardA,
      discountsCents: 0,
      cashVarianceCents: 0,
    });
    expect(person(names.crewB)).toMatchObject({
      ordersPlaced: 2,
      // Sales are what was charged; the refund is shown against the person who made it.
      salesCents: sold.cardB,
      discountsCents: sold.discountB,
      refundsCents: 0,
      cashVarianceCents: -1000,
    });
    expect(person('Shift supervisor')).toMatchObject({
      ordersPlaced: 0,
      refundsCents: sold.refundB,
      cashVarianceCents: null,
    });
    expect(closed.drawers.find((d) => d.sessionId === late.id)).toMatchObject({
      status: 'closed',
      varianceCents: -1000,
      approvedBy: 'Shift manager',
    });
    expect(await current()).toBeNull();
    expect((await closeShift(shift.id)).body.error.code).toBe('SHIFT_ALREADY_CLOSED');
  });

  it('a closed shift is a record: later trade does not change it, and the database refuses edits', async () => {
    const next = await openDrawer(t.crewA);
    expect(await shiftOf(next.id)).toBeNull(); // no shift open
    const o = await ring(t.crewA);
    await pay(t.crewA, o.id, cash(o));
    const again = (
      await h.http.get(`${api()}/shifts/${shift.id}`).set(bearer(t.manager)).expect(200)
    ).body as ShiftView;
    expect(again).toEqual(closed);

    await expect(
      sql`update shifts set notes = 'edited' where id = ${shift.id}::uuid`.execute(h.owner),
    ).rejects.toThrow(/closed/);
    await expect(
      sql`delete from shifts where id = ${shift.id}::uuid`.execute(h.owner),
    ).rejects.toThrow(/never deleted/);
    await expect(
      sql`update drawer_sessions set shift_id = null where id = ${early.id}::uuid`.execute(h.owner),
    ).rejects.toThrow(/cannot change shift/);

    // The next shift takes the drawer in, and it must be counted before that shift closes.
    const second = (await openShift(t.manager)).body as ShiftView;
    expect(second.drawers.map((d) => d.sessionId)).toEqual([next.id]);
    expect(second.totals.ordersPlaced).toBe(0);
    await countExact(t.crewA, next.id);
    expect((await closeShift(second.id, {}, t.manager)).status).toBe(200);
    const list = (await h.http.get(`${api()}/shifts`).set(bearer(t.manager)).expect(200))
      .body as ShiftView[];
    expect(list.map((s) => s.id)).toEqual([second.id, shift.id]);
  });

  it('a cash payment waits for a shift change before locking its drawer, so they cannot deadlock', async () => {
    // A shift opening holds the shift lock and then updates running drawer sessions; a cash
    // payment must therefore not hold its session while it waits for that lock.
    const session = await openDrawer(t.crewA);
    const o = await ring(t.crewA);
    let paying: Promise<{ status: number }> | undefined;
    await h.owner.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(app.shift_lock_key(${rid}::uuid))`.execute(trx);
      paying = h.http
        .post(`${api()}/orders/${o.id}/payments`)
        .set(bearer(t.crewA))
        .set('Idempotency-Key', randomUUID())
        .send(cash(o))
        .then((r) => r);
      for (let i = 0; ; i++) {
        const { rows } = await sql<{ n: string }>`
          select count(*) as n from pg_locks where not granted and locktype = 'advisory'`.execute(
          h.owner,
        );
        if (Number(rows[0]!.n) > 0) break;
        if (i > 200) throw new Error('the payment never waited for the shift lock');
        await new Promise((r) => setTimeout(r, 25));
      }
      // The waiting payment holds no lock on its session.
      await sql`select id from drawer_sessions where id = ${session.id}::uuid for update nowait`.execute(
        trx,
      );
    });
    expect((await paying!).status).toBe(200);
    await countExact(t.crewA, session.id);
  });

  it('racing opens leave one shift open', async () => {
    const results = await Promise.all([openShift(t.supervisor), openShift(t.manager)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const s = (await current())!;
    expect((await closeShift(s.id)).status).toBe(200);
  });

  it('a drawer opening while the shift closes either blocks the close or misses the shift', async () => {
    for (let i = 0; i < 4; i++) {
      const s = (await openShift()).body as ShiftView;
      const drawerId = await freeDrawer();
      const [closing, opening] = await Promise.all([
        closeShift(s.id),
        h.http
          .post(`${api()}/cash/drawers/${drawerId}/sessions`)
          .set(bearer(t.crewB))
          .send({ openingFloatCents: 5_000 }),
      ]);
      expect(opening.status).toBe(201);
      const joined = await shiftOf(opening.body.id);
      if (closing.status === 200) {
        // Closed first: the drawer must not belong to the closed shift.
        expect(joined).toBeNull();
      } else {
        expect(closing.body.error.code).toBe('SHIFT_NOT_READY');
        expect(joined).toBe(s.id);
        await countExact(t.crewB, opening.body.id);
        expect((await closeShift(s.id)).status).toBe(200);
        continue;
      }
      await countExact(t.crewB, opening.body.id);
    }
  });
});
