import { randomUUID } from 'node:crypto';
import type { CurrentShift, DrawerSessionView, OrderView, ShiftView } from '@kitchos/contracts';
import { createDb, type Database, type Tx } from '@kitchos/database';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
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
 * Adversarial tests for shifts (ADR-0018). Expected figures are recomputed from the source rows
 * (payments, orders, refunds, order_discounts, drawer_sessions) over [opened_at, closed_at), not
 * by re-running the service. Runs in two restaurants of its own (same org/menu as Drive) and
 * leaves no drawer session open.
 */
describe('shifts: adversarial', () => {
  let h: Harness;
  let appDb: Database;
  let dispatcher: EventDispatcher;
  let orgId: string;
  let rid: string;
  let rid2: string;
  let rivalRid: string;
  let mealId: string;
  const t = {
    manager: '',
    supervisor: '',
    crewA: '',
    crewB: '',
    crewC: '',
    manager2: '',
    driveManager: '',
    rival: '',
  };
  const ids: Record<string, string> = {};

  const build = async (tag: string, driveId: string) => {
    const drive = await h.owner
      .selectFrom('restaurants')
      .selectAll()
      .where('id', '=', driveId)
      .executeTakeFirstOrThrow();
    orgId = drive.org_id;
    const id = (
      await h.owner
        .insertInto('restaurants')
        .values({
          org_id: drive.org_id,
          brand_id: drive.brand_id,
          region_id: drive.region_id,
          menu_id: drive.menu_id,
          name: `Shift adv ${tag}`,
          slug: `shift-adv-${tag}`,
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
      .values(stations.map((s) => ({ ...s, org_id: drive.org_id, restaurant_id: id })))
      .execute();
    await h.owner
      .insertInto('stock_locations')
      .values({
        org_id: drive.org_id,
        restaurant_id: id,
        code: 'main',
        name: 'Main',
        is_default: true,
      })
      .execute();
    await h.owner
      .insertInto('restaurant_event_sequences')
      .values({ org_id: drive.org_id, restaurant_id: id })
      .execute();
    await h.owner
      .insertInto('cash_drawers')
      .values(
        ['till-1', 'till-2', 'till-3', 'till-4', 'till-5'].map((code) => ({
          org_id: drive.org_id,
          restaurant_id: id,
          code,
          name: code.replace('till-', 'Till '),
        })),
      )
      .execute();
    return id;
  };

  beforeAll(async () => {
    h = await startHarness();
    appDb = createDb({ connectionString: inject('appUrl'), max: 2 }).db;
    dispatcher = h.app.get(EventDispatcher);
    const driveId = await restaurantId(h, 'kitchos-drive');
    rivalRid = await restaurantId(h, 'rival-southbank');
    const tag = randomUUID().slice(0, 8);
    rid = await build(tag, driveId);
    rid2 = await build(`${tag}-b`, driveId);
    // Coarse rounding so cash payments (not only refunds) carry rounding.
    await h.owner
      .updateTable('restaurants')
      .set({ cash_rounding_increment_cents: 20 })
      .where('id', '=', rid)
      .execute();
    const { password_hash } = await h.owner
      .selectFrom('users')
      .select('password_hash')
      .where('email', '=', 'manager@drive.kitchos.test')
      .executeTakeFirstOrThrow();
    const user = async (k: string, role: string, at = rid) => {
      const email = `${k}-${tag}@shift-adv.test`;
      const u = await h.owner
        .insertInto('users')
        .values({ org_id: orgId, email, display_name: `Adv ${k}`, password_hash })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids[k] = u.id;
      await h.owner
        .insertInto('role_assignments')
        .values({ org_id: orgId, user_id: u.id, role, scope_type: 'restaurant', scope_id: at })
        .execute();
      return login(h, email);
    };
    t.manager = await user('manager', 'restaurant_manager');
    t.supervisor = await user('supervisor', 'shift_supervisor');
    t.crewA = await user('crewA', 'crew_member');
    t.crewB = await user('crewB', 'crew_member');
    t.crewC = await user('crewC', 'crew_member');
    t.manager2 = await user('manager2', 'restaurant_manager', rid2);
    t.driveManager = await login(h, 'manager@drive.kitchos.test');
    t.rival = await login(h, 'manager@rival.test');
    mealId = item(await getMenu(h, 'kitchos-drive'), 'Cheeseburger Meal').id;
  });

  afterAll(async () => {
    while ((await dispatcher.runOnce()).processed > 0);
    const open = await h.owner
      .selectFrom('drawer_sessions')
      .select('id')
      .where('restaurant_id', 'in', [rid, rid2])
      .where('status', '<>', 'closed')
      .execute();
    await appDb.destroy();
    await h.close();
    expect(open).toEqual([]);
  });

  // ---------------------------------------------------------------- helpers
  const api = (r = rid) => `/v1/restaurants/${r}`;
  const current = async (token = t.supervisor, r = rid) =>
    (
      (
        await h.http
          .get(`${api(r)}/shifts/current`)
          .set(bearer(token))
          .expect(200)
      ).body as CurrentShift
    ).shift;
  const openShift = (token = t.supervisor, r = rid) =>
    h.http
      .post(`${api(r)}/shifts`)
      .set(bearer(token))
      .send();
  const closeShift = (id: string, token = t.supervisor, r = rid, body: object = {}) =>
    h.http
      .post(`${api(r)}/shifts/${id}/close`)
      .set(bearer(token))
      .send(body);
  const getShift = (id: string, token = t.manager, r = rid) =>
    h.http.get(`${api(r)}/shifts/${id}`).set(bearer(token));
  const freeDrawer = async (r = rid) =>
    (
      (
        await h.http
          .get(`${api(r)}/cash/drawers`)
          .set(bearer(r === rid ? t.manager : t.manager2))
          .expect(200)
      ).body as { id: string; activeSession: unknown }[]
    ).find((d) => !d.activeSession)!.id;
  const openDrawerReq = async (token: string, floatCents = 10_000, r = rid) =>
    h.http
      .post(`${api(r)}/cash/drawers/${await freeDrawer(r)}/sessions`)
      .set(bearer(token))
      .send({ openingFloatCents: floatCents });
  const openDrawer = async (token: string, floatCents = 10_000, r = rid) => {
    const res = await openDrawerReq(token, floatCents, r);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as DrawerSessionView;
  };
  const expectedOf = async (sessionId: string, mgr = t.manager, r = rid) =>
    (
      (
        await h.http
          .get(`${api(r)}/cash/sessions/${sessionId}`)
          .set(bearer(mgr))
          .expect(200)
      ).body as DrawerSessionView
    ).expected!.expectedCents;
  const count = async (token: string, sessionId: string, countedCents: number, r = rid) => {
    const res = await h.http
      .post(`${api(r)}/cash/sessions/${sessionId}/count`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ countedCents });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as DrawerSessionView;
  };
  const countExact = async (token: string, sessionId: string, mgr = t.manager, r = rid) =>
    count(token, sessionId, await expectedOf(sessionId, mgr, r), r);
  const ring = async (token: string, quantity = 1, r = rid) => {
    const res = await h.http
      .post(`${api(r)}/orders`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ fulfilmentType: 'takeaway', lines: [{ menuItemId: mealId, quantity }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as OrderView;
  };
  const payReq = (token: string, orderId: string, tender: object, r = rid) =>
    h.http
      .post(`${api(r)}/orders/${orderId}/payments`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send(tender);
  const pay = async (token: string, orderId: string, tender: object, r = rid) => {
    const res = await payReq(token, orderId, tender, r);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
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
  // Odd tender so cash rounding is exercised whatever the total.
  const cash = (o: OrderView) => ({ method: 'cash', tenderedCents: o.totalCents + 1003 });
  const shiftOf = async (sessionId: string) =>
    (
      await h.owner
        .selectFrom('drawer_sessions')
        .select('shift_id')
        .where('id', '=', sessionId)
        .executeTakeFirstOrThrow()
    ).shift_id;
  const openCount = async (r = rid) =>
    Number(
      (
        await h.owner
          .selectFrom('shifts')
          .select(sql<string>`count(*)`.as('n'))
          .where('restaurant_id', '=', r)
          .where('status', '=', 'open')
          .executeTakeFirstOrThrow()
      ).n,
    );

  /** Independent truth from source rows over [opened_at, closed_at). */
  const truth = async (shiftId: string, r = rid) => {
    const s = await h.owner
      .selectFrom('shifts')
      .select(['opened_at', 'closed_at'])
      .where('id', '=', shiftId)
      .executeTakeFirstOrThrow();
    const from = s.opened_at;
    const to = s.closed_at!;
    const pays = await h.owner
      .selectFrom('payments')
      .select(['id', 'method', 'amount_cents', 'cash_rounding_cents'])
      .where('restaurant_id', '=', r)
      .where('captured_at', 'is not', null)
      .where('captured_at', '>=', from)
      .where('captured_at', '<', to)
      .execute();
    const orders = await h.owner
      .selectFrom('orders')
      .select(['id', 'created_by_user_id', 'status', 'total_cents'])
      .where('restaurant_id', '=', r)
      .where('placed_at', '>=', from)
      .where('placed_at', '<', to)
      .execute();
    const refunds = await h.owner
      .selectFrom('refunds')
      .select(['requested_by', 'method', 'amount_cents', 'cash_rounding_cents'])
      .where('restaurant_id', '=', r)
      .where('created_at', '>=', from)
      .where('created_at', '<', to)
      .execute();
    const discounts = await h.owner
      .selectFrom('order_discounts as od')
      .innerJoin('orders as o', 'o.id', 'od.order_id')
      .select(['od.applied_by', 'od.amount_cents'])
      .where('o.restaurant_id', '=', r)
      .where('od.created_at', '>=', from)
      .where('od.created_at', '<', to)
      .execute();
    const sessions = await h.owner
      .selectFrom('drawer_sessions')
      .select(['id', 'opened_by', 'status', 'variance_cents'])
      .where('shift_id', '=', shiftId)
      .execute();
    const n = (v: unknown) => Number(v ?? 0);
    const S = <R>(rows: R[], f: (r: R) => unknown) => rows.reduce((a, x) => a + n(f(x)), 0);
    const salesOf = (u: string) =>
      S(
        orders.filter(
          (o) => o.created_by_user_id === u && !['pending_payment', 'cancelled'].includes(o.status),
        ),
        (o) => o.total_cents,
      );
    return {
      paymentIds: pays.map((p) => p.id),
      totals: {
        ordersPlaced: orders.length,
        ordersCancelled: orders.filter((o) => o.status === 'cancelled').length,
        cardTakenCents: S(
          pays.filter((p) => p.method === 'card'),
          (p) => p.amount_cents,
        ),
        cashTakenCents: S(
          pays.filter((p) => p.method === 'cash'),
          (p) => n(p.amount_cents) + n(p.cash_rounding_cents),
        ),
        cashRefundsCents: S(
          refunds.filter((x) => x.method === 'cash'),
          (x) => n(x.amount_cents) + n(x.cash_rounding_cents),
        ),
        refundsCents: S(refunds, (x) => x.amount_cents),
        discountsCents: S(discounts, (d) => d.amount_cents),
        cashVarianceCents: S(sessions, (x) => x.variance_cents),
      },
      sessions: sessions.map((x) => x.id).sort(),
      person: (u: string) => ({
        ordersPlaced: orders.filter((o) => o.created_by_user_id === u).length,
        salesCents: salesOf(u),
        discountsCents: S(
          discounts.filter((d) => d.applied_by === u),
          (d) => d.amount_cents,
        ),
        refundsCents: S(
          refunds.filter((x) => x.requested_by === u),
          (x) => x.amount_cents,
        ),
      }),
    };
  };
  const person = (v: ShiftView, userId: string) => v.people.find((p) => p.userId === userId);

  // ---------------------------------------------------------------- access
  it('access: crew 403; other restaurant / other org / foreign shift ids 404', async () => {
    const s = (await openShift(t.manager2, rid2)).body as ShiftView;
    expect(s.status).toBe('open');
    // Crew are refused everything.
    for (const req of [
      () => h.http.get(`${api()}/shifts/current`),
      () => h.http.get(`${api()}/shifts`),
      () => h.http.get(`${api()}/shifts/${s.id}`),
      () => h.http.post(`${api()}/shifts`),
      () => h.http.post(`${api()}/shifts/${s.id}/close`),
    ]) {
      expect((await req().set(bearer(t.crewA)).send()).status).toBe(403);
    }
    // A manager of rid2 cannot reach rid; rid's manager cannot reach rid2's shift through rid.
    expect((await h.http.get(`${api()}/shifts/current`).set(bearer(t.manager2))).status).toBe(404);
    expect((await openShift(t.manager2, rid)).status).toBe(404);
    expect((await getShift(s.id, t.manager, rid)).status).toBe(404);
    expect((await closeShift(s.id, t.manager, rid)).status).toBe(404);
    expect((await getShift(s.id, t.manager, rid2)).status).toBe(404);
    expect((await closeShift(s.id, t.manager, rid2)).status).toBe(404);
    // Drive's manager (same org, other restaurant) and the rival org.
    expect((await getShift(s.id, t.driveManager, rid2)).status).toBe(404);
    expect((await closeShift(s.id, t.driveManager, rid2)).status).toBe(404);
    expect((await getShift(s.id, t.rival, rid2)).status).toBe(404);
    expect((await getShift(s.id, t.rival, rivalRid)).status).toBe(404);
    expect((await closeShift(s.id, t.rival, rivalRid)).status).toBe(404);
    expect((await getShift(randomUUID(), t.manager)).status).toBe(404);
    expect((await getShift('not-a-uuid', t.manager)).status).toBe(400);
    // Still open and untouched.
    expect(await openCount(rid2)).toBe(1);
    expect(await openCount(rid)).toBe(0);
    const closed = await closeShift(s.id, t.manager2, rid2, { notes: 'x'.repeat(501) });
    expect(closed.status).toBe(400);
    expect((await closeShift(s.id, t.manager2, rid2)).status).toBe(200);
  });

  // ---------------------------------------------------------------- runtime role
  it('the runtime role cannot edit a closed shift, delete shifts, or move a session', async () => {
    const a = (await openShift()).body as ShiftView;
    expect((await closeShift(a.id)).status).toBe(200);
    const b = (await openShift()).body as ShiftView;
    const asApp = <T>(fn: (tx: Tx) => Promise<T>) =>
      appDb.transaction().execute(async (tx) => {
        await sql`select set_config('app.org_id', ${orgId}, true)`.execute(tx);
        return fn(tx);
      });
    await expect(
      asApp((tx) => sql`update shifts set notes = 'x' where id = ${a.id}::uuid`.execute(tx)),
    ).rejects.toThrow(/closed/);
    await expect(
      asApp((tx) =>
        sql`update shifts set summary = '{}'::jsonb, version = version + 1 where id = ${a.id}::uuid`.execute(
          tx,
        ),
      ),
    ).rejects.toThrow(/closed/);
    await expect(
      asApp((tx) => sql`update shifts set status = 'open' where id = ${a.id}::uuid`.execute(tx)),
    ).rejects.toThrow();
    await expect(
      asApp((tx) => sql`delete from shifts where id = ${b.id}::uuid`.execute(tx)),
    ).rejects.toThrow(/permission denied|never deleted/);
    await expect(
      asApp((tx) =>
        sql`update shifts set opened_at = now() - interval '1 day' where id = ${b.id}::uuid`.execute(
          tx,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp((tx) =>
        sql`update shifts set restaurant_id = ${rid2}::uuid where id = ${b.id}::uuid`.execute(tx),
      ),
    ).rejects.toThrow(/permission denied/);
    // A second open shift at the same restaurant, behind the service's back.
    await expect(
      asApp((tx) =>
        sql`insert into shifts (org_id, restaurant_id, opened_by, business_date)
            values (${orgId}::uuid, ${rid}::uuid, ${ids.manager}::uuid, current_date)`.execute(tx),
      ),
    ).rejects.toThrow(/shifts_one_open|duplicate/);
    // Close the open shift by hand without a summary: refused by the CHECKs.
    await expect(
      asApp((tx) =>
        sql`update shifts set status = 'closed', closed_at = now(), closed_by = ${ids.manager}::uuid
            where id = ${b.id}::uuid`.execute(tx),
      ),
    ).rejects.toThrow();
    // Move a session from one shift to another.
    const d = await openDrawer(t.crewC);
    expect(await shiftOf(d.id)).toBe(b.id);
    await expect(
      asApp((tx) =>
        sql`update drawer_sessions set shift_id = ${a.id}::uuid where id = ${d.id}::uuid`.execute(
          tx,
        ),
      ),
    ).rejects.toThrow(/cannot change shift/);
    // Other orgs' shifts are invisible to the runtime role.
    const rivalOrg = (
      await h.owner
        .selectFrom('restaurants')
        .select('org_id')
        .where('id', '=', rivalRid)
        .executeTakeFirstOrThrow()
    ).org_id;
    const seen = await appDb.transaction().execute(async (tx) => {
      await sql`select set_config('app.org_id', ${rivalOrg}, true)`.execute(tx);
      return (await sql`select id from shifts where id = ${b.id}::uuid`.execute(tx)).rows;
    });
    expect(seen).toEqual([]);
    await countExact(t.crewC, d.id);
    expect((await closeShift(b.id)).status).toBe(200);
  });

  // ---------------------------------------------------------------- concurrency
  it('racing opens: exactly one open shift each time (6 iterations, 3 racers)', async () => {
    for (let i = 0; i < 6; i++) {
      const rs = await Promise.all([
        openShift(t.supervisor),
        openShift(t.manager),
        openShift(t.supervisor),
      ]);
      const codes = rs.map((r) => r.status).sort();
      expect(codes).toEqual([201, 409, 409]);
      for (const r of rs.filter((x) => x.status === 409))
        expect(r.body.error.code).toBe('SHIFT_ALREADY_OPEN');
      expect(await openCount()).toBe(1);
      const s = rs.find((r) => r.status === 201)!.body as ShiftView;
      expect((await current())!.id).toBe(s.id);
      // Racing closes: one wins, the other sees it closed.
      const cs = await Promise.all([closeShift(s.id, t.supervisor), closeShift(s.id, t.manager)]);
      expect(cs.map((c) => c.status).sort()).toEqual([200, 409]);
      expect(cs.find((c) => c.status === 409)!.body.error.code).toBe('SHIFT_ALREADY_CLOSED');
      expect(await openCount()).toBe(0);
    }
  });

  it('a drawer opening while a shift opens always ends in that shift (6 iterations)', async () => {
    for (let i = 0; i < 6; i++) {
      const drawerId = await freeDrawer();
      const [shiftRes, drawerRes] = await Promise.all([
        openShift(),
        h.http
          .post(`${api()}/cash/drawers/${drawerId}/sessions`)
          .set(bearer(t.crewA))
          .send({ openingFloatCents: 3_000 }),
      ]);
      expect(shiftRes.status).toBe(201);
      expect(drawerRes.status).toBe(201);
      const s = shiftRes.body as ShiftView;
      expect(await shiftOf(drawerRes.body.id)).toBe(s.id);
      expect((await closeShift(s.id)).body.error.code).toBe('SHIFT_NOT_READY');
      await countExact(t.crewA, drawerRes.body.id);
      expect((await closeShift(s.id)).status).toBe(200);
    }
  });

  it('close vs drawer open vs count vs approve (6 iterations): never a closed shift with an unclosed drawer', async () => {
    for (let i = 0; i < 6; i++) {
      const s = (await openShift()).body as ShiftView;
      // crewB's drawer is counted short and pending approval; crewC opens a drawer concurrently.
      const pend = await openDrawer(t.crewB, 5_000);
      await count(t.crewB, pend.id, (await expectedOf(pend.id)) - 700);
      const drawerId = await freeDrawer();
      const [closing, opening, approving] = await Promise.all([
        closeShift(s.id),
        h.http
          .post(`${api()}/cash/drawers/${drawerId}/sessions`)
          .set(bearer(t.crewC))
          .send({ openingFloatCents: 2_000 }),
        h.http
          .post(`${api()}/cash/sessions/${pend.id}/approve`)
          .set(bearer(t.manager))
          .send({ notes: 'race check' }),
      ]);
      expect(opening.status).toBe(201);
      expect(approving.status).toBe(200);
      const joined = await shiftOf(opening.body.id);
      if (closing.status === 200) {
        const v = closing.body as ShiftView;
        expect(joined).toBeNull();
        expect(v.drawers.every((d) => d.status === 'closed')).toBe(true);
        expect(v.drawers.map((d) => d.sessionId)).toEqual([pend.id]);
        // Snapshot drawer agrees with the persisted session.
        const row = await h.owner
          .selectFrom('drawer_sessions')
          .selectAll()
          .where('id', '=', pend.id)
          .executeTakeFirstOrThrow();
        expect(v.drawers[0]).toMatchObject({
          status: row.status,
          varianceCents: Number(row.variance_cents),
        });
        await countExact(t.crewC, opening.body.id);
      } else {
        expect(closing.status).toBe(409);
        expect(closing.body.error.code).toBe('SHIFT_NOT_READY');
        if (joined === s.id) await countExact(t.crewC, opening.body.id);
        else {
          expect(joined).toBeNull();
          await countExact(t.crewC, opening.body.id);
        }
        const again = await closeShift(s.id);
        expect(again.status, JSON.stringify(again.body)).toBe(200);
        expect((again.body as ShiftView).drawers.every((d) => d.status === 'closed')).toBe(true);
      }
      // Invariant on persisted state: no closed shift owns an unclosed session.
      const bad = await h.owner
        .selectFrom('drawer_sessions as d')
        .innerJoin('shifts as s', 's.id', 'd.shift_id')
        .select('d.id')
        .where('s.status', '=', 'closed')
        .where('d.status', '<>', 'closed')
        .execute();
      expect(bad).toEqual([]);
    }
  });

  // ---------------------------------------------------------------- adoption
  it('a pending_approval session opened between shifts is adopted and blocks the close', async () => {
    expect(await current()).toBeNull();
    const d = await openDrawer(t.crewA, 4_000);
    expect(await shiftOf(d.id)).toBeNull();
    const o = await ring(t.crewA);
    await pay(t.crewA, o.id, cash(o));
    await count(t.crewA, d.id, (await expectedOf(d.id)) + 900);
    const s = (await openShift()).body as ShiftView;
    expect(await shiftOf(d.id)).toBe(s.id);
    expect(s.drawers.map((x) => [x.sessionId, x.status])).toEqual([[d.id, 'pending_approval']]);
    expect(s.blockers.map((b) => b.code)).toEqual(['VARIANCE_PENDING']);
    // Cash taken before the shift opened is not the shift's.
    expect(s.totals.cashTakenCents).toBe(0);
    expect(s.totals.ordersPlaced).toBe(0);
    const res = await closeShift(s.id);
    expect(res.status).toBe(409);
    expect(res.body.error.details.blockers.map((b: { code: string }) => b.code)).toEqual([
      'VARIANCE_PENDING',
    ]);
    await h.http
      .post(`${api()}/cash/sessions/${d.id}/approve`)
      .set(bearer(t.manager))
      .send({ notes: 'checked ok' })
      .expect(200);
    const closed = (await closeShift(s.id)).body as ShiftView;
    expect(closed.totals.cashVarianceCents).toBe(900);
    expect(person(closed, ids.crewA!)?.cashVarianceCents).toBe(900);
  });

  // ---------------------------------------------------------------- figures and blind counts
  let big: ShiftView;
  let supDrawer: DrawerSessionView;
  it('multi-crew shift: blind while any drawer is uncounted, figures equal source rows at close', async () => {
    const s = (await openShift()).body as ShiftView;
    supDrawer = await openDrawer(t.supervisor, 20_000);
    const dA = await openDrawer(t.crewA, 10_000);
    const dB = await openDrawer(t.crewB, 10_000);
    // Crew A: two cash, one card. Crew B: card with a discount, cash. Crew C (no drawer): card + cancelled.
    const a1 = await ring(t.crewA);
    const a1p = await pay(t.crewA, a1.id, cash(a1));
    const a2 = await ring(t.crewA, 3);
    await pay(t.crewA, a2.id, cash(a2));
    const a3 = await ring(t.crewA);
    await pay(t.crewA, a3.id, CARD);
    const b1 = await ring(t.crewB, 2);
    await h.http
      .post(`${api()}/orders/${b1.id}/discount`)
      .set(bearer(t.crewB))
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'percent', value: 1000, reason: 'customer_service' })
      .expect(200);
    await pay(t.crewB, b1.id, CARD);
    const b2 = await ring(t.crewB);
    await pay(t.crewB, b2.id, cash(b2));
    const c1 = await ring(t.crewC);
    await pay(t.crewC, c1.id, CARD);
    const c2 = await ring(t.crewC);
    await h.http
      .post(`${api()}/orders/${c2.id}/cancel`)
      .set(bearer(t.supervisor))
      .send({ reason: 'customer_left' })
      .expect((r) => expect(r.status).toBeLessThan(300));
    // Supervisor rings one, takes cash, then refunds 3.33 of crew A's cash order from their own drawer.
    const s1 = await ring(t.supervisor);
    await pay(t.supervisor, s1.id, cash(s1));
    await handOver(a1.id);
    await handOver(b1.id);
    await handOver(c1.id);
    const refund = await h.http
      .post(`${api()}/orders/${a1.id}/refunds`)
      .set(bearer(t.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'other', amountCents: 333 });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(a1p.payment!.method).toBe('cash');
    const rf = await h.owner
      .selectFrom('refunds')
      .selectAll()
      .where('order_id', '=', a1.id)
      .executeTakeFirstOrThrow();
    expect(rf.method).toBe('cash');
    expect(rf.drawer_session_id).toBe(supDrawer.id);
    // Cash rounding is in play on both sides.
    expect(Number(rf.cash_rounding_cents)).not.toBe(0);
    const rounding = await h.owner
      .selectFrom('payments')
      .select('cash_rounding_cents')
      .where('order_id', 'in', [a1.id, a2.id, b2.id, s1.id])
      .execute();
    expect(rounding.some((x) => Number(x.cash_rounding_cents) !== 0)).toBe(true);
    // Card refund too, by crew B's supervisor on b1.
    await h.http
      .post(`${api()}/orders/${b1.id}/refunds`)
      .set(bearer(t.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'quality', amountCents: 120 })
      .expect(201);

    // Blind-count leak attempts by the supervisor who runs a till: every view, every route.
    const blind = (v: ShiftView) => {
      expect(v.totals.cashTakenCents).toBeNull();
      expect(v.totals.cashRefundsCents).toBeNull();
      expect(v.totals.cashVarianceCents).toBeNull();
      expect(v.people.every((p) => p.salesCents === null)).toBe(true);
      for (const d of v.drawers.filter((x) => x.status === 'open')) {
        expect(d.expectedCents).toBeNull();
        expect(d.varianceCents).toBeNull();
      }
    };
    blind((await current())!);
    blind((await getShift(s.id, t.supervisor)).body);
    const listed = (await h.http.get(`${api()}/shifts`).set(bearer(t.supervisor)).expect(200))
      .body as ShiftView[];
    blind(listed.find((x) => x.id === s.id)!);
    // Count everyone else exactly; supervisor's own still open: still blind.
    await countExact(t.crewA, dA.id);
    await countExact(t.crewB, dB.id);
    const partly = (await current())!;
    blind(partly);
    expect(partly.drawers.find((d) => d.sessionId === supDrawer.id)!.expectedCents).toBeNull();
    // The supervisor cannot see their own expected cash on the drawer route either.
    const own = (
      await h.http
        .get(`${api()}/cash/sessions/${supDrawer.id}`)
        .set(bearer(t.supervisor))
        .expect(200)
    ).body as DrawerSessionView;
    expect(own.expected ?? null).toBeNull();
    // Supervisor counts 2.00 over (under threshold, auto-closes or pending either way).
    const sup = await count(t.supervisor, supDrawer.id, (await expectedOf(supDrawer.id)) + 200);
    if (sup.status === 'pending_approval')
      await h.http
        .post(`${api()}/cash/sessions/${supDrawer.id}/approve`)
        .set(bearer(t.manager))
        .send({ notes: 'checked ok' })
        .expect(200);

    const res = await closeShift(s.id, t.supervisor, rid, { notes: 'adv close' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    big = res.body as ShiftView;
    const tr = await truth(s.id);
    expect(big.totals).toEqual(tr.totals);
    expect(big.totals.cashRefundsCents).toBe(
      Number(rf.amount_cents) + Number(rf.cash_rounding_cents),
    );
    expect(big.drawers.map((d) => d.sessionId).sort()).toEqual(tr.sessions);
    expect(tr.sessions).toEqual([supDrawer.id, dA.id, dB.id].sort());
    for (const k of ['crewA', 'crewB', 'crewC', 'supervisor'] as const) {
      expect(person(big, ids[k]!), k).toMatchObject(tr.person(ids[k]!));
    }
    expect(person(big, ids.crewC!)!.cashVarianceCents).toBeNull();
    expect(person(big, ids.supervisor!)!.cashVarianceCents).toBe(200);
    expect(big.totals.ordersCancelled).toBe(1);
  });

  it('the closed view equals the close snapshot after later trade, refunds and cancellations', async () => {
    const d = await openDrawer(t.crewA);
    const o = await ring(t.crewA);
    await pay(t.crewA, o.id, cash(o));
    // Refund an order that was in the closed shift.
    const inShift = await h.owner
      .selectFrom('orders')
      .select('id')
      .where('restaurant_id', '=', rid)
      .where('created_by_user_id', '=', ids.crewC!)
      .where('status', '<>', 'cancelled')
      .orderBy('placed_at', 'desc')
      .executeTakeFirstOrThrow();
    await h.http
      .post(`${api()}/orders/${inShift.id}/refunds`)
      .set(bearer(t.manager))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'other', amountCents: 50 })
      .expect(201);
    const again = (await getShift(big.id)).body as ShiftView;
    expect(again).toEqual(big);
    const listed = (
      await h.http
        .get(`${api()}/shifts?businessDate=${big.businessDate}`)
        .set(bearer(t.manager))
        .expect(200)
    ).body as ShiftView[];
    expect(listed.find((x) => x.id === big.id)).toEqual(big);
    await countExact(t.crewA, d.id);
  });

  // ---------------------------------------------------------------- consecutive shifts
  it('two consecutive shifts: no payment in both; payments taken during a shift are in it', async () => {
    const during1: string[] = [];
    const during2: string[] = [];
    const between: string[] = [];
    const payIdOf = async (orderId: string) =>
      (
        await h.owner
          .selectFrom('payments')
          .select('id')
          .where('order_id', '=', orderId)
          .where('captured_at', 'is not', null)
          .executeTakeFirstOrThrow()
      ).id;

    const s1 = (await openShift()).body as ShiftView;
    const dA = await openDrawer(t.crewA);
    for (let i = 0; i < 3; i++) {
      const o = await ring(t.crewA);
      await pay(t.crewA, o.id, i % 2 ? CARD : cash(o));
      during1.push(await payIdOf(o.id));
    }
    await countExact(t.crewA, dA.id);
    const c1 = (await closeShift(s1.id)).body as ShiftView;
    // Between shifts: a card sale and a drawer opened with a cash sale.
    const g = await ring(t.crewC);
    await pay(t.crewC, g.id, CARD);
    between.push(await payIdOf(g.id));
    const dB = await openDrawer(t.crewB);
    expect(await shiftOf(dB.id)).toBeNull();
    const gb = await ring(t.crewB);
    await pay(t.crewB, gb.id, cash(gb));
    between.push(await payIdOf(gb.id));

    const s2 = (await openShift(t.manager)).body as ShiftView;
    expect(s2.drawers.map((d) => d.sessionId)).toEqual([dB.id]);
    for (let i = 0; i < 3; i++) {
      const o = await ring(t.crewB);
      await pay(t.crewB, o.id, i % 2 ? cash(o) : CARD);
      during2.push(await payIdOf(o.id));
    }
    await countExact(t.crewB, dB.id);
    const c2 = (await closeShift(s2.id, t.manager)).body as ShiftView;
    const t1 = await truth(s1.id);
    const t2 = await truth(s2.id);
    expect(c1.totals).toEqual(t1.totals);
    expect(c2.totals).toEqual(t2.totals);
    expect(t1.paymentIds.filter((p) => t2.paymentIds.includes(p))).toEqual([]);
    expect([...t1.paymentIds].sort()).toEqual([...during1].sort());
    expect([...t2.paymentIds].sort()).toEqual([...during2].sort());
    for (const b of between) {
      expect(t1.paymentIds).not.toContain(b);
      expect(t2.paymentIds).not.toContain(b);
    }
  });

  // ---------------------------------------------------------------- commit-time races
  // Rows are stamped with the shift open when they are written (ADR-0018), under the shift lock.
  /** Waits until some transaction is blocked on a lock of this kind (pg_locks needs no privilege). */
  const waitFor = async (kind: 'row' | 'advisory') => {
    const types = kind === 'row' ? ['transactionid', 'tuple'] : ['advisory'];
    for (let i = 0; i < 200; i++) {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from pg_locks
         where not granted and locktype = any(${types}::text[])`.execute(h.owner);
      if (Number(rows[0]!.n) > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`nothing waited on a ${kind} lock`);
  };
  const stampedCard = async (shiftId: string) =>
    Number(
      (
        await sql<{ c: string }>`
          select coalesce(sum(amount_cents), 0)::text as c from payments
           where shift_id = ${shiftId}::uuid and method = 'card' and captured_at is not null`.execute(
          h.owner,
        )
      ).rows[0]!.c,
    );

  it('a card payment written before the close is waited for and counted in the shift', async () => {
    const s = (await openShift()).body as ShiftView;
    const o = await ring(t.crewC);
    const restaurant = (
      await h.owner
        .selectFrom('orders')
        .select('restaurant_id')
        .where('id', '=', o.id)
        .executeTakeFirstOrThrow()
    ).restaurant_id;
    let closing: Promise<{ status: number; body: ShiftView }> | undefined;
    let paying: Promise<{ status: number }> | undefined;
    await h.owner.transaction().execute(async (trx) => {
      // The payment row is written (stamped, shift lock held shared), then its events wait here.
      await sql`select 1 from restaurant_event_sequences
                 where restaurant_id = ${restaurant}::uuid for update`.execute(trx);
      paying = payReq(t.crewC, o.id, CARD).then((r) => r);
      await waitFor('row');
      closing = closeShift(s.id).then((r) => r as never);
      await waitFor('advisory');
    });
    expect((await paying!).status).toBe(200);
    const c = await closing!;
    expect(c.status).toBe(200);
    const p = await h.owner
      .selectFrom('payments')
      .select(['shift_id', 'amount_cents'])
      .where('order_id', '=', o.id)
      .executeTakeFirstOrThrow();
    expect(p.shift_id).toBe(s.id);
    expect(c.body.totals.cardTakenCents).toBe(await stampedCard(s.id));
    expect(c.body.totals.cardTakenCents).toBeGreaterThanOrEqual(Number(p.amount_cents));
  });

  it('a card payment not yet written when the shift closes belongs to no closed shift', async () => {
    const s = (await openShift()).body as ShiftView;
    const o = await ring(t.crewC);
    let paying: Promise<{ status: number }> | undefined;
    let closed: ShiftView | undefined;
    await h.owner.transaction().execute(async (trx) => {
      // The payment transaction has started but cannot reach its insert until this commits.
      await sql`select id from orders where id = ${o.id}::uuid for update`.execute(trx);
      paying = payReq(t.crewC, o.id, CARD).then((r) => r);
      await waitFor('row');
      const c = await closeShift(s.id);
      expect(c.status).toBe(200);
      closed = c.body as ShiftView;
    });
    expect((await paying!).status).toBe(200);
    const p = await h.owner
      .selectFrom('payments')
      .select('shift_id')
      .where('order_id', '=', o.id)
      .executeTakeFirstOrThrow();
    // Written after the close with no shift open: between shifts, in none.
    expect(p.shift_id).toBeNull();
    // The snapshot is exactly the rows stamped with the shift, and still is.
    expect(closed!.totals.cardTakenCents).toBe(await stampedCard(s.id));
  });
});
