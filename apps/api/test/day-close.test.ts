import { randomUUID } from 'node:crypto';
import type { DayCloseView, DrawerAdminView } from '@kitchos/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import {
  bearer,
  getMenu,
  item,
  login,
  placeAndPay,
  restaurantId,
  startHarness,
  type Harness,
} from './harness.ts';

const CENTRAL = 'kitchos-central';
const DRIVE = 'kitchos-drive';

/**
 * Days under test are far in the past: other files post to today and yesterday,
 * and a closed day would refuse their entries.
 */
describe('business-day close and drawer administration', () => {
  let h: Harness;
  let driveId: string;
  let centralId: string;
  let manager: string;
  let supervisor: string;
  let crew: string;
  let dispatcher: EventDispatcher;
  let orgId: string;
  let managerId: string;

  beforeAll(async () => {
    h = await startHarness();
    driveId = await restaurantId(h, DRIVE);
    centralId = await restaurantId(h, CENTRAL);
    manager = await login(h, 'manager@central.kitchos.test');
    supervisor = await login(h, 'supervisor@central.kitchos.test');
    crew = await login(h, 'crew1@central.kitchos.test');
    dispatcher = h.app.get(EventDispatcher);
    const r = await h.owner
      .selectFrom('restaurants')
      .select('org_id')
      .where('id', '=', centralId)
      .executeTakeFirstOrThrow();
    orgId = r.org_id;
    managerId = (await h.http.get('/v1/me').set(bearer(manager))).body.user.id;
  });
  afterAll(() => h.close());

  const dayOffset = async (restId: string, days: number) => {
    const { rows } = await sql<{ d: string }>`
      select (app.business_date(${restId}::uuid, now()) - ${days}::int)::text as d`.execute(
      h.owner,
    );
    return rows[0]!.d;
  };
  const view = async (restId: string, day: string, token = manager) =>
    (await h.http.get(`/v1/restaurants/${restId}/days/${day}`).set(bearer(token)).expect(200))
      .body as DayCloseView;
  const close = (restId: string, day: string, token = manager, body: object = {}) =>
    h.http.post(`/v1/restaurants/${restId}/days/${day}/close`).set(bearer(token)).send(body);
  const blockerCodes = (v: DayCloseView) => v.blockers.map((b) => b.code);

  /** A drawer session on a past business day, in the state given (fixture: bypasses the API). */
  const pastSession = async (
    day: string,
    status: 'open' | 'pending_approval' | 'closed',
    drawerCode: string,
  ) => {
    const drawer = await h.owner
      .insertInto('cash_drawers')
      .values({ org_id: orgId, restaurant_id: centralId, code: drawerCode, name: drawerCode })
      .returning('id')
      .executeTakeFirstOrThrow();
    const counted = status !== 'open';
    const person = await h.owner
      .insertInto('users')
      .values({
        org_id: orgId,
        email: `${drawerCode}@central.kitchos.test`,
        display_name: `Cashier ${drawerCode}`,
        password_hash: 'x',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return h.owner
      .insertInto('drawer_sessions')
      .values({
        org_id: orgId,
        restaurant_id: centralId,
        drawer_id: drawer.id,
        opened_by: person.id,
        business_date: day,
        opening_float_cents: 10_000,
        status,
        ...(counted
          ? {
              counted_by: person.id,
              counted_at: new Date(),
              counted_cents: 10_000,
              expected_cents: 10_000,
              variance_cents: 0,
            }
          : {}),
        ...(status === 'closed' ? { closed_at: new Date() } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  };

  it('today cannot close, and the server says why', async () => {
    const today = await dayOffset(centralId, 0);
    const v = await view(centralId, today);
    expect(v.status).toBe('open');
    expect(blockerCodes(v)).toContain('DAY_NOT_ENDED');
    const res = await close(centralId, today);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DAY_NOT_READY');
    const stored = await h.owner
      .selectFrom('business_day_closes')
      .select('id')
      .where('restaurant_id', '=', centralId)
      .where('business_date', '=', today)
      .execute();
    expect(stored).toEqual([]);
  });

  it('an uncounted drawer, then a pending variance, each hold the day; an older one holds later days', async () => {
    const day = await dayOffset(centralId, 40);
    const s = await pastSession(day, 'open', 'dc-open');
    expect(blockerCodes(await view(centralId, day))).toEqual(['DRAWERS_OPEN']);
    expect((await close(centralId, day)).status).toBe(409);
    // A later day is held too: that cash has no home yet.
    const later = await dayOffset(centralId, 39);
    expect(blockerCodes(await view(centralId, later))).toEqual(['DRAWERS_OPEN']);
    // ...and an open drawer stays blind on this screen.
    const open = (await view(centralId, day)).drawers.find((d) => d.sessionId === s.id)!;
    expect(open).toMatchObject({ status: 'open', expectedCents: null, countedCents: null });

    await h.owner
      .updateTable('drawer_sessions')
      .set({
        status: 'pending_approval',
        counted_at: new Date(),
        counted_cents: 10_000,
        expected_cents: 10_000,
        variance_cents: 0,
      })
      .where('id', '=', s.id)
      .execute();
    expect(blockerCodes(await view(centralId, day))).toEqual(['VARIANCE_PENDING']);

    await h.owner
      .updateTable('drawer_sessions')
      .set({ status: 'closed', closed_at: new Date() })
      .where('id', '=', s.id)
      .execute();
    expect(blockerCodes(await view(centralId, day))).toEqual([]);
    expect(blockerCodes(await view(centralId, later))).toEqual([]);
  });

  it('events not yet posted hold the day until the ledger catches up', async () => {
    const day = await dayOffset(centralId, 35);
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Medium Cola').id, quantity: 1 },
    ]);
    await h.owner
      .updateTable('outbox_events')
      .set({ occurred_at: sql`${day}::date + time '12:00' at time zone 'UTC'` })
      .where('aggregate_id', '=', order.id)
      .execute();
    expect(blockerCodes(await view(centralId, day))).toEqual(['LEDGER_BEHIND']);
    expect((await close(centralId, day)).status).toBe(409);
    await dispatcher.runOnce();
    expect(blockerCodes(await view(centralId, day))).toEqual([]);
    await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/cancel`)
      .set(bearer(supervisor))
      .send({ reason: 'Test cleanup' });
    await dispatcher.runOnce();
  });

  it('closing stores an immutable snapshot and refuses a second close', async () => {
    const day = await dayOffset(centralId, 30);
    await pastSession(day, 'closed', 'dc-closed');
    const res = await close(centralId, day, manager, { notes: 'Quiet day' });
    expect(res.status).toBe(200);
    const closed = res.body as DayCloseView;
    expect(closed).toMatchObject({ status: 'closed', notes: 'Quiet day', blockers: [] });
    expect(closed.closedBy).toBeTruthy();
    expect(closed.drawers[0]).toMatchObject({ expectedCents: 10_000, varianceCents: 0 });

    const row = await h.owner
      .selectFrom('business_day_closes')
      .selectAll()
      .where('restaurant_id', '=', centralId)
      .where('business_date', '=', day)
      .executeTakeFirstOrThrow();
    expect(row.closed_by).toBe(managerId);
    expect(row.drawers).toEqual(closed.drawers);

    const again = await close(centralId, day);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DAY_ALREADY_CLOSED');

    await expect(
      h.owner
        .updateTable('business_day_closes')
        .set({ notes: 'rewritten' })
        .where('id', '=', row.id)
        .execute(),
    ).rejects.toThrow();
    await expect(
      h.owner.deleteFrom('business_day_closes').where('id', '=', row.id).execute(),
    ).rejects.toThrow();

    const auditRows = await h.owner
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', row.id)
      .execute();
    expect(auditRows.map((a) => a.action)).toEqual(['business_day.close']);
    const events = await h.owner
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', row.id)
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(['business_day.closed']);
  });

  it('a stored close keeps showing what was recorded, even if later facts differ', async () => {
    const day = await dayOffset(centralId, 29);
    const before = (await close(centralId, day)).body as DayCloseView;
    // A fixture entry on the following moment cannot land here; a later session on this date can.
    await pastSession(day, 'closed', 'dc-late');
    const after = await view(centralId, day);
    expect(after.drawers).toEqual(before.drawers);
    expect(after.totals).toEqual(before.totals);
  });

  it('an entry dated to a closed day moves to the first open day and names the day it came from', async () => {
    const day = await dayOffset(centralId, 28);
    expect((await close(centralId, day)).status).toBe(200);
    const today = await dayOffset(centralId, 0);
    // No lines, so these cannot commit (deferred balance check): look at them, then roll back.
    const attempt = (restId: string) =>
      h.owner
        .transaction()
        .execute(async (trx) => {
          const row = await trx
            .insertInto('journal_entries')
            .values({
              org_id: orgId,
              restaurant_id: restId,
              business_date: day,
              entry_type: 'adjustment',
              source_type: 'test',
              source_id: randomUUID(),
              description: 'Late entry',
            })
            .returning([
              sql<string>`business_date::text`.as('day'),
              sql<string | null>`posted_late_from::text`.as('late'),
            ])
            .executeTakeFirstOrThrow();
          throw Object.assign(new Error('rollback'), { row });
        })
        .catch((e: { row: { day: string; late: string | null } }) => e.row);
    expect(await attempt(centralId)).toEqual({ day: today, late: day });
    // Other restaurants' days are their own.
    expect(await attempt(driveId)).toEqual({ day, late: null });
  });

  it('a drawer variance missing from the books stops the day reconciling', async () => {
    const day = await dayOffset(centralId, 41);
    const s = await pastSession(day, 'closed', 'dc-unposted');
    expect(blockerCodes(await view(centralId, day))).toEqual([]);
    await h.owner
      .updateTable('drawer_sessions')
      .set({ expected_cents: 10_100, variance_cents: -100 })
      .where('id', '=', s.id)
      .execute();
    expect(blockerCodes(await view(centralId, day))).toEqual(['NOT_RECONCILED']);
    expect((await close(centralId, day)).status).toBe(409);
  });

  it('a day that only just ended cannot close yet', async () => {
    const day = await dayOffset(driveId, 0);
    const before = await h.owner
      .selectFrom('restaurants')
      .select('business_day_cutoff')
      .where('id', '=', driveId)
      .executeTakeFirstOrThrow();
    const setCutoff = (minutesAgo: number) =>
      sql`update restaurants set business_day_cutoff =
            ((now() at time zone timezone)::time - make_interval(mins => ${minutesAgo}))
           where id = ${driveId}::uuid`.execute(h.owner);
    const driveManager = await login(h, 'manager@drive.kitchos.test');
    try {
      await setCutoff(2);
      const { rows } = await sql<{ d: string }>`
        select (app.business_date(${driveId}::uuid, now()) - 1)::text as d`.execute(h.owner);
      const ended = rows[0]!.d;
      const v = await view(driveId, ended, driveManager);
      expect(blockerCodes(v)).toContain('DAY_SETTLING');
      expect((await close(driveId, ended, driveManager)).status).toBe(409);
      await setCutoff(6);
      expect(blockerCodes(await view(driveId, ended, driveManager))).not.toContain('DAY_SETTLING');
    } finally {
      await h.owner
        .updateTable('restaurants')
        .set({ business_day_cutoff: before.business_day_cutoff })
        .where('id', '=', driveId)
        .execute();
    }
    expect(day).toBeTruthy();
  });

  it('a dead-lettered event blocks its day, can be retried, and then posts', async () => {
    const day = await dayOffset(centralId, 0);
    const failed = `/v1/restaurants/${centralId}/accounting/failed-events`;
    const menu = await getMenu(h, CENTRAL);
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Medium Cola').id, quantity: 1 },
    ]);
    const event = await h.owner
      .selectFrom('outbox_events')
      .select(['id', 'aggregate_id'])
      .where('event_type', '=', 'payment.captured')
      .where('restaurant_id', '=', centralId)
      .orderBy('occurred_at', 'desc')
      .executeTakeFirstOrThrow();
    await h.owner
      .insertInto('event_consumer_failures')
      .values({
        consumer: 'ledger',
        event_id: event.id,
        org_id: orgId,
        attempts: 5,
        last_error: 'simulated',
        next_attempt_at: new Date(),
        dead_at: new Date(),
      })
      .execute();
    await dispatcher.runOnce();
    expect(blockerCodes(await view(centralId, day))).toContain('LEDGER_FAILED');
    const entries = () =>
      h.owner
        .selectFrom('journal_entries')
        .select('id')
        .where('source_event_id', '=', event.id)
        .execute();
    expect(await entries()).toEqual([]);

    const list = await h.http.get(failed).set(bearer(manager)).expect(200);
    expect(list.body.map((e: { eventId: string }) => e.eventId)).toContain(event.id);
    expect((await h.http.get(failed).set(bearer(crew))).status).toBe(403);
    // Reading is for reports; retrying is for whoever can close the day.
    const retry = (token: string, id = event.id) =>
      h.http.post(`${failed}/${id}/retry`).set(bearer(token));
    expect((await retry(supervisor)).status).toBe(403);
    const rival = await login(h, 'manager@rival.test');
    expect((await retry(rival)).status).toBe(404);
    const driveManager = await login(h, 'manager@drive.kitchos.test');
    expect(
      (
        await h.http
          .post(`/v1/restaurants/${driveId}/accounting/failed-events/${event.id}/retry`)
          .set(bearer(driveManager))
      ).status,
    ).toBe(404);
    expect((await retry(manager, randomUUID())).status).toBe(404);

    await retry(manager).expect(200);
    await dispatcher.runOnce();
    expect(await entries()).toHaveLength(1);
    expect(blockerCodes(await view(centralId, day))).not.toContain('LEDGER_FAILED');
    expect((await retry(manager)).status).toBe(404); // no longer dead
    const audited = await h.owner
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', event.id)
      .execute();
    expect(audited.map((x) => x.action)).toEqual(['ledger.retry_event']);
    await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/cancel`)
      .set(bearer(supervisor))
      .send({ reason: 'Test cleanup' });
    await dispatcher.runOnce();
  });

  it('a close waits for an entry being posted to that day', async () => {
    const day = await dayOffset(centralId, 27);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let posted!: () => void;
    const isPosted = new Promise<void>((r) => (posted = r));
    // Holds the same shared lock an insert into journal_entries takes.
    const holder = h.owner.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock_shared(app.business_day_lock_key(${centralId}::uuid, ${day}::date))`.execute(
        trx,
      );
      posted();
      await held;
    });
    await isPosted;
    let settled = false;
    const attempt = Promise.resolve(close(centralId, day)).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 750));
    expect(settled).toBe(false);
    release();
    await holder;
    expect((await attempt).status).toBe(200);
  });

  it('racing closes: exactly one wins and one row exists', async () => {
    const day = await dayOffset(centralId, 26);
    const results = await Promise.all([1, 2, 3, 4].map(() => close(centralId, day)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    const rows = await h.owner
      .selectFrom('business_day_closes')
      .select('id')
      .where('restaurant_id', '=', centralId)
      .where('business_date', '=', day)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('totals come from the journal and the payments of that day', async () => {
    const today = await dayOffset(centralId, 0);
    const menu = await getMenu(h, CENTRAL);
    const auditor = await login(h, 'auditor@kitchos.test');
    const before = (await view(centralId, today, auditor)).totals;
    const order = await placeAndPay(h, CENTRAL, [
      { menuItemId: item(menu, 'Medium Cola').id, quantity: 1 },
    ]);
    await dispatcher.runOnce();
    const after = (await view(centralId, today, auditor)).totals;
    expect(after!.cardTakenCents - before!.cardTakenCents).toBe(order.totalCents);
    await h.http
      .post(`/v1/restaurants/${centralId}/orders/${order.id}/cancel`)
      .set(bearer(supervisor))
      .send({ reason: 'Test cleanup' });
    await dispatcher.runOnce();
  });

  it('permissions and tenancy', async () => {
    const day = await dayOffset(centralId, 25);
    expect((await close(centralId, day, supervisor)).status).toBe(403);
    expect((await close(centralId, day, crew)).status).toBe(403);
    expect(
      (await h.http.get(`/v1/restaurants/${centralId}/days/${day}`).set(bearer(crew))).status,
    ).toBe(403);
    const rival = await login(h, 'manager@rival.test');
    expect((await close(centralId, day, rival)).status).toBe(404);
    expect(
      (await h.http.get(`/v1/restaurants/${centralId}/days/${day}`).set(bearer(rival))).status,
    ).toBe(404);
    expect((await close(centralId, 'not-a-date')).status).toBe(400);
    expect((await close(centralId, day, manager, { notes: 'x'.repeat(501) })).status).toBe(400);
    const rows = await h.owner
      .selectFrom('business_day_closes')
      .select('id')
      .where('restaurant_id', '=', centralId)
      .where('business_date', '=', day)
      .execute();
    expect(rows).toEqual([]);
  });

  describe('drawer administration', () => {
    const base = () => `/v1/restaurants/${centralId}/cash/drawers`;
    const find = (list: DrawerAdminView[], code: string) => list.find((d) => d.code === code)!;

    it('adds a drawer, refuses a duplicate code, and audits it', async () => {
      const res = await h.http
        .post(base())
        .set(bearer(manager))
        .send({ code: 'adm-new', name: 'New till' })
        .expect(201);
      const d = find(res.body, 'adm-new');
      expect(d).toMatchObject({ active: true, inUse: false, name: 'New till' });
      const dup = await h.http
        .post(base())
        .set(bearer(manager))
        .send({ code: 'adm-new', name: 'Other' });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('DRAWER_CODE_TAKEN');
      const a = await h.owner
        .selectFrom('audit_log')
        .select('action')
        .where('entity_id', '=', d.id)
        .execute();
      expect(a.map((x) => x.action)).toEqual(['drawer.create']);
      expect(
        (await h.http.post(base()).set(bearer(manager)).send({ code: 'BAD CODE', name: 'x' }))
          .status,
      ).toBe(400);
    });

    it('a retired drawer cannot open, and a drawer in use cannot retire', async () => {
      await h.http
        .post(base())
        .set(bearer(manager))
        .send({ code: 'adm-ret', name: 'Ret' })
        .expect(201);
      const all = (await h.http.get(`${base()}/all`).set(bearer(manager)).expect(200)).body;
      const id = find(all, 'adm-ret').id;

      // A fresh cashier: others in the shared database may already hold a drawer.
      const person = await h.owner
        .insertInto('users')
        .values({
          org_id: orgId,
          email: 'adm-ret@central.kitchos.test',
          display_name: 'Adm Ret',
          password_hash: 'x',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const session = await h.owner
        .insertInto('drawer_sessions')
        .values({
          org_id: orgId,
          restaurant_id: centralId,
          drawer_id: id,
          opened_by: person.id,
          business_date: await dayOffset(centralId, 0),
          opening_float_cents: 1000,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const busy = await h.http.post(`${base()}/${id}/retire`).set(bearer(manager));
      expect(busy.status).toBe(409);
      expect(busy.body.error.code).toBe('DRAWER_IN_USE');
      const inUse = await h.http.get(`${base()}/all`).set(bearer(manager));
      expect(find(inUse.body, 'adm-ret').inUse).toBe(true);
      await h.owner
        .updateTable('drawer_sessions')
        .set({
          status: 'closed',
          counted_at: new Date(),
          counted_by: person.id,
          counted_cents: 1000,
          expected_cents: 1000,
          variance_cents: 0,
          closed_at: new Date(),
        })
        .where('id', '=', session.id)
        .execute();

      const retired = await h.http.post(`${base()}/${id}/retire`).set(bearer(manager)).expect(200);
      expect(find(retired.body, 'adm-ret').active).toBe(false);
      const list = (await h.http.get(base()).set(bearer(crew)).expect(200)).body as {
        id: string;
      }[];
      expect(list.map((d) => d.id)).not.toContain(id);
      expect(
        (
          await h.http
            .post(`${base()}/${id}/sessions`)
            .set(bearer(crew))
            .send({ openingFloatCents: 100 })
        ).status,
      ).toBe(404);

      const back = await h.http.post(`${base()}/${id}/reactivate`).set(bearer(manager)).expect(200);
      expect(find(back.body, 'adm-ret').active).toBe(true);
    });

    it('needs cash.admin; another restaurant or tenant cannot touch it', async () => {
      const someDrawer = (await h.http.get(base()).set(bearer(crew)).expect(200)).body[0].id;
      expect((await h.http.get(`${base()}/all`).set(bearer(supervisor))).status).toBe(403);
      expect(
        (await h.http.post(base()).set(bearer(supervisor)).send({ code: 'nope', name: 'No' }))
          .status,
      ).toBe(403);
      expect((await h.http.post(`${base()}/${someDrawer}/retire`).set(bearer(crew))).status).toBe(
        403,
      );
      const driveManager = await login(h, 'manager@drive.kitchos.test');
      expect(
        (
          await h.http
            .post(`/v1/restaurants/${driveId}/cash/drawers/${someDrawer}/retire`)
            .set(bearer(driveManager))
        ).status,
      ).toBe(404);
      const rival = await login(h, 'manager@rival.test');
      expect((await h.http.post(`${base()}/${someDrawer}/retire`).set(bearer(rival))).status).toBe(
        404,
      );
    });
  });
});
