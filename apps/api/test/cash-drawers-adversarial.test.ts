import { randomUUID } from 'node:crypto';
import type { DrawerSessionView, DrawerView, KitchenTaskView, OrderView } from '@kitchos/contracts';
import { createDb, withTenant, type Database } from '@kitchos/database';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
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
const EXPRESS = 'kitchos-express';
const RIVAL = 'rival-southbank';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Adversarial tests for cash drawers. Uses Drive staff (crew2, supervisor,
 * manager), who hold no long-lived sessions in other files; every session
 * opened here is counted (and approved if needed) after each test so the
 * shared drawers are free again.
 */
describe('cash drawers (adversarial)', () => {
  let h: Harness;
  let appDb: Database;
  let dispatcher: EventDispatcher;
  let driveId: string;
  let expressId: string;
  let rivalId: string;
  let demoOrgId: string;
  let rivalOrgId: string;
  let crew: string; // crew2@drive (crew_member)
  let supervisor: string; // supervisor@drive (cash.manage, refunds)
  let manager: string; // manager@drive
  const ids: Record<'crew' | 'supervisor' | 'manager', string> = {
    crew: '',
    supervisor: '',
    manager: '',
  };
  let mealId: string;
  let startedAt: Date;

  beforeAll(async () => {
    h = await startHarness();
    appDb = createDb({ connectionString: inject('appUrl'), max: 2 }).db;
    dispatcher = h.app.get(EventDispatcher);
    driveId = await restaurantId(h, DRIVE);
    expressId = await restaurantId(h, EXPRESS);
    rivalId = await restaurantId(h, RIVAL);
    crew = await login(h, 'crew2@drive.kitchos.test');
    supervisor = await login(h, 'supervisor@drive.kitchos.test');
    manager = await login(h, 'manager@drive.kitchos.test');
    for (const [k, email] of [
      ['crew', 'crew2@drive.kitchos.test'],
      ['supervisor', 'supervisor@drive.kitchos.test'],
      ['manager', 'manager@drive.kitchos.test'],
    ] as const) {
      ids[k] = (
        await h.owner
          .selectFrom('users')
          .select('id')
          .where('email', '=', email)
          .executeTakeFirstOrThrow()
      ).id;
    }
    demoOrgId = (
      await h.owner
        .selectFrom('restaurants')
        .select('org_id')
        .where('id', '=', driveId)
        .executeTakeFirstOrThrow()
    ).org_id;
    rivalOrgId = (
      await h.owner
        .selectFrom('restaurants')
        .select('org_id')
        .where('id', '=', rivalId)
        .executeTakeFirstOrThrow()
    ).org_id;
    mealId = item(await getMenu(h, DRIVE), 'Cheeseburger Meal').id; // 1190c at Drive
    startedAt = new Date(Date.now() - 1000);
    await freeMine(); // in case a previous file left one of ours open
  });

  afterEach(async () => {
    await freeMine();
  });

  afterAll(async () => {
    await freeMine();
    await appDb.destroy();
    await h.close();
  });

  const base = (rid = driveId) => `/v1/restaurants/${rid}/cash`;
  const drawers = async (token: string, rid = driveId) =>
    (
      await h.http
        .get(`${base(rid)}/drawers`)
        .set(bearer(token))
        .expect(200)
    ).body as DrawerView[];
  const freeDrawers = async (token: string, rid = driveId) =>
    (await drawers(token, rid)).filter((d) => !d.activeSession);
  const open = (token: string, drawerId: string, openingFloatCents: number, rid = driveId) =>
    h.http
      .post(`${base(rid)}/drawers/${drawerId}/sessions`)
      .set(bearer(token))
      .send({ openingFloatCents });
  const openFree = async (token: string, floatCents: number) => {
    const d = (await freeDrawers(token))[0];
    if (!d) throw new Error('no free drawer at Drive');
    const res = await open(token, d.id, floatCents);
    if (res.status !== 201)
      throw new Error(`open failed ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as DrawerSessionView;
  };
  const move = (
    token: string,
    sessionId: string,
    body: Record<string, unknown>,
    key: string = randomUUID(),
    rid = driveId,
  ) =>
    h.http
      .post(`${base(rid)}/sessions/${sessionId}/movements`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send(body);
  const count = (
    token: string,
    sessionId: string,
    countedCents: number,
    key: string = randomUUID(),
    rid = driveId,
  ) =>
    h.http
      .post(`${base(rid)}/sessions/${sessionId}/count`)
      .set(bearer(token))
      .set('Idempotency-Key', key)
      .send({ countedCents, notes: 'Adversarial count' });
  const approve = (token: string, sessionId: string, rid = driveId) =>
    h.http
      .post(`${base(rid)}/sessions/${sessionId}/approve`)
      .set(bearer(token))
      .send({ notes: 'Adversarial approval' });
  const getSession = (token: string, sessionId: string, rid = driveId) =>
    h.http.get(`${base(rid)}/sessions/${sessionId}`).set(bearer(token));
  /** Expected cash as seen by a manager who is not the session's own cashier. */
  const expectedOf = async (sessionId: string) => {
    const { opened_by } = await sessionRow(sessionId);
    const viewer = opened_by === ids.manager ? supervisor : manager;
    return ((await getSession(viewer, sessionId).expect(200)).body as DrawerSessionView).expected!
      .expectedCents;
  };
  const sessionRow = (id: string) =>
    h.owner
      .selectFrom('drawer_sessions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const closedEvents = async (sessionId: string) =>
    (
      await h.owner
        .selectFrom('outbox_events')
        .select('id')
        .where('aggregate_id', '=', sessionId)
        .where('event_type', '=', 'drawer.closed')
        .execute()
    ).length;

  const placeOrder = async (token: string) =>
    (
      await h.http
        .post(`/v1/restaurants/${driveId}/orders`)
        .set(bearer(token))
        .set('Idempotency-Key', randomUUID())
        .send({ fulfilmentType: 'takeaway', lines: [{ menuItemId: mealId, quantity: 1 }] })
        .expect(201)
    ).body as OrderView;
  const payCash = (token: string, orderId: string, extra: object = {}) =>
    h.http
      .post(`/v1/restaurants/${driveId}/orders/${orderId}/payments`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'cash', tenderedCents: 2000, ...extra });
  const cancel = (orderId: string) =>
    h.http
      .post(`/v1/restaurants/${driveId}/orders/${orderId}/cancel`)
      .set(bearer(supervisor))
      .send({ reason: 'Adversarial cleanup' });
  /** Ring, pay cash (through the token holder's own drawer), cook and hand over. */
  const soldAndHandedOver = async (token: string) => {
    const order = await placeOrder(token);
    await payCash(token, order.id).expect(200);
    const tasks = (
      await h.http.get(`/v1/restaurants/${driveId}/kitchen/tasks`).set(bearer(token)).expect(200)
    ).body as KitchenTaskView[];
    for (const t of tasks.filter((x) => x.orderId === order.id)) {
      await h.http
        .post(`/v1/restaurants/${driveId}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(token))
        .send({})
        .expect(200);
    }
    await h.http
      .post(`/v1/restaurants/${driveId}/orders/${order.id}/handoff`)
      .set(bearer(token))
      .expect(200);
    return order;
  };
  const refund = (token: string, orderId: string, extra: object = {}) =>
    h.http
      .post(`/v1/restaurants/${driveId}/orders/${orderId}/refunds`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'quality', ...extra });

  /**
   * Holds the restaurant's event-sequence row lock (taken last by every
   * command) while the given requests run, so they all pass their checks and
   * then wait at appendEvents; releasing it lets them commit together.
   */
  async function raceAtCommit<T>(
    rid: string,
    start: () => Promise<T>[],
    holdMs = 700,
  ): Promise<T[]> {
    let inflight: Promise<T>[] = [];
    await h.owner.transaction().execute(async (trx) => {
      await sql`select 1 from restaurant_event_sequences where restaurant_id = ${rid}::uuid for update`.execute(
        trx,
      );
      inflight = start();
      await sleep(holdMs);
    });
    return Promise.all(inflight);
  }
  const fire = <R>(req: PromiseLike<R>): Promise<R> => Promise.resolve(req).then((r) => r);

  /** Count (and approve if needed) every non-closed Drive session opened by our three users. */
  async function freeMine() {
    const rows = await h.owner
      .selectFrom('drawer_sessions')
      .select(['id', 'status', 'counted_by', 'opened_by'])
      .where('restaurant_id', '=', driveId)
      .where('opened_by', 'in', [ids.crew, ids.supervisor, ids.manager])
      .where('status', '<>', 'closed')
      .execute();
    for (const r of rows) {
      let status = r.status;
      let countedBy = r.counted_by;
      if (status === 'open') {
        let expected = await expectedOf(r.id);
        if (expected < 0) {
          await move(manager, r.id, {
            kind: 'paid_in',
            amountCents: -expected,
            reason: 'Cleanup top-up',
          }).expect(201);
          expected = 0;
        }
        const res = await count(manager, r.id, expected).expect(200);
        status = res.body.status;
        countedBy = ids.manager;
      }
      if (status === 'pending_approval') {
        // Neither the counter nor the drawer's own cashier may approve.
        const approver =
          countedBy !== ids.supervisor && r.opened_by !== ids.supervisor ? supervisor : manager;
        await approve(approver, r.id).expect(200);
      }
    }
  }

  // ------------------------------------------------------------------ opening

  // Regression for FINDING (failed on the first run; since fixed by the per-user partial unique
  // index): CashDrawerService.open checked "does this user already have a session?" with a plain
  // SELECT and nothing serialises it per user (the partial unique index is on drawer_id only), so
  // two concurrent opens of different drawers by the same cashier both succeed. One cashier then
  // owns two open drawers and implicit cash payments pick one arbitrarily.
  it('one cashier racing to open two different drawers ends up with at most one session', async () => {
    const free = await freeDrawers(crew);
    expect(free.length).toBeGreaterThanOrEqual(2);
    const results = await raceAtCommit(driveId, () => [
      fire(open(crew, free[0]!.id, 1_000)),
      fire(open(crew, free[1]!.id, 1_000)),
    ]);
    const statuses = results.map((r) => r.status).sort();
    const mine = await h.owner
      .selectFrom('drawer_sessions')
      .select('id')
      .where('opened_by', '=', ids.crew)
      .where('restaurant_id', '=', driveId)
      .where('status', '<>', 'closed')
      .execute();
    expect(mine).toHaveLength(1);
    expect(statuses).toEqual([201, 409]);
  });

  it('two people racing to open the same drawer: exactly one wins', async () => {
    const d = (await freeDrawers(crew))[0]!;
    const results = await Promise.all([
      fire(open(crew, d.id, 500)),
      fire(open(supervisor, d.id, 500)),
      fire(open(manager, d.id, 500)),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('DRAWER_IN_USE');
    }
    const active = await h.owner
      .selectFrom('drawer_sessions')
      .select('id')
      .where('drawer_id', '=', d.id)
      .where('status', '<>', 'closed')
      .execute();
    expect(active).toHaveLength(1);
  });

  it('rejects bad floats, unknown, foreign and deactivated drawers', async () => {
    const d = (await freeDrawers(crew))[0]!;
    for (const f of [-1, 1.5, 1_000_001, '100', null]) {
      expect((await open(crew, d.id, f as number)).status).toBe(400);
    }
    expect((await open(crew, randomUUID(), 100)).status).toBe(404);
    expect((await open(crew, 'not-a-uuid', 100)).status).toBe(400);
    // A drawer of another restaurant (same tenant) and of another tenant, via the Drive URL.
    const expressDrawer = await h.owner
      .selectFrom('cash_drawers')
      .select('id')
      .where('restaurant_id', '=', expressId)
      .executeTakeFirstOrThrow();
    const rivalDrawer = await h.owner
      .selectFrom('cash_drawers')
      .select('id')
      .where('restaurant_id', '=', rivalId)
      .executeTakeFirstOrThrow();
    expect((await open(crew, expressDrawer.id, 100)).status).toBe(404);
    expect((await open(crew, rivalDrawer.id, 100)).status).toBe(404);

    await h.owner
      .updateTable('cash_drawers')
      .set({ active: false })
      .where('id', '=', d.id)
      .execute();
    try {
      expect((await open(crew, d.id, 100)).status).toBe(404);
      expect((await drawers(crew)).some((x) => x.id === d.id)).toBe(false);
    } finally {
      await h.owner
        .updateTable('cash_drawers')
        .set({ active: true })
        .where('id', '=', d.id)
        .execute();
    }
    const none = await h.owner
      .selectFrom('drawer_sessions')
      .select('id')
      .where('opened_by', '=', ids.crew)
      .where('status', '<>', 'closed')
      .execute();
    expect(none).toHaveLength(0);
  });

  // ---------------------------------------------------------------- movements

  it('concurrent safe drops by a manager can never take more cash than the drawer holds', async () => {
    const s = await openFree(crew, 10_000);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        fire(
          move(supervisor, s.id, { kind: 'safe_drop', amountCents: 3_000, reason: 'Race drop' }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(r.body.error.code).toBe('INSUFFICIENT_DRAWER_CASH');
    }
    expect(await expectedOf(s.id)).toBe(1_000);
  });

  it('rejects malformed movements and nothing is persisted', async () => {
    const s = await openFree(crew, 5_000);
    const bad: Record<string, unknown>[] = [
      { kind: 'paid_in', amountCents: 0, reason: 'Zero' },
      { kind: 'paid_in', amountCents: -100, reason: 'Negative' },
      { kind: 'paid_in', amountCents: 10.5, reason: 'Fraction' },
      { kind: 'paid_in', amountCents: 1_000_001, reason: 'Huge' },
      { kind: 'paid_in', amountCents: '100', reason: 'String' },
      { kind: 'paid_in', amountCents: 100 },
      { kind: 'paid_in', amountCents: 100, reason: '  ' },
      { kind: 'paid_in', amountCents: 100, reason: 'x'.repeat(201) },
      { kind: 'tip_out', amountCents: 100, reason: 'Unknown kind' },
    ];
    for (const b of bad) expect((await move(crew, s.id, b)).status).toBe(400);
    const noKey = await h.http
      .post(`${base()}/sessions/${s.id}/movements`)
      .set(bearer(crew))
      .send({ kind: 'paid_in', amountCents: 100, reason: 'No key' });
    expect(noKey.status).toBe(400);
    expect(
      (await move(crew, randomUUID(), { kind: 'paid_in', amountCents: 100, reason: 'Ghost' }))
        .status,
    ).toBe(404);
    const moves = await h.owner
      .selectFrom('drawer_movements')
      .select('id')
      .where('session_id', '=', s.id)
      .execute();
    expect(moves).toHaveLength(0);
  });

  it('idempotency: replays are no-ops, reused keys with a different body are refused, scope is per session', async () => {
    const a = await openFree(crew, 5_000);
    const b = await openFree(supervisor, 5_000);
    const key = randomUUID();
    const body = { kind: 'paid_in', amountCents: 700, reason: 'Change top-up' };
    const first = await move(crew, a.id, body, key).expect(201);
    const again = await move(crew, a.id, body, key).expect(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.movements).toEqual(first.body.movements);
    expect((await move(crew, a.id, { ...body, amountCents: 701 }, key)).body.error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    // Same key on another session is a different command.
    await move(supervisor, b.id, body, key).expect(201);
    const counts = await h.owner
      .selectFrom('drawer_movements')
      .select(['session_id', sql<string>`count(*)`.as('n')])
      .where('session_id', 'in', [a.id, b.id])
      .groupBy('session_id')
      .execute();
    expect(Object.fromEntries(counts.map((c) => [c.session_id, Number(c.n)]))).toEqual({
      [a.id]: 1,
      [b.id]: 1,
    });
    const events = await h.owner
      .selectFrom('outbox_events')
      .select('id')
      .where('event_type', '=', 'drawer.movement_recorded')
      .where(sql<boolean>`payload->>'sessionId' in (${a.id}, ${b.id})`)
      .execute();
    expect(events).toHaveLength(2);
  });

  // Regression for FINDING (failed on the first run; since fixed by re-rendering replays for the
  // caller): movement idempotency is scoped per (restaurant, session, key) but not per user, and the
  // stored response is the original actor's view. A crew cashier who replays a supervisor's key and
  // body on their own drawer receives the supervisor's cached response, which includes the expected
  // cash figure that blind counting must hide from them (and a 201 for a paid-out they may not make).
  it('a crew cashier replaying a manager’s movement key does not get the hidden expected cash', async () => {
    const s = await openFree(crew, 5_000);
    const key = randomUUID();
    const body = { kind: 'paid_out', amountCents: 300, reason: 'Milk run' };
    const sup = await move(supervisor, s.id, body, key).expect(201);
    expect(sup.body.expected).not.toBeNull(); // the supervisor may see it
    const replay = await move(crew, s.id, body, key);
    // Correct behaviour: either refuse the foreign key or answer with the caller's (blind) view.
    if (replay.status < 300) expect(replay.body.expected).toBeNull();
    else expect(replay.status).toBeGreaterThanOrEqual(400);
    const moves = await h.owner
      .selectFrom('drawer_movements')
      .select('id')
      .where('session_id', '=', s.id)
      .execute();
    expect(moves).toHaveLength(1);
  });

  // ------------------------------------------------------------- blind counts

  it('the expected cash stays hidden from crew everywhere while the drawer is open', async () => {
    const s = await openFree(crew, 4_321);
    const supS = await openFree(supervisor, 1_234);
    expect(s.expected).toBeNull();
    const own = (await getSession(crew, s.id).expect(200)).body as DrawerSessionView;
    expect(own.expected).toBeNull();
    const other = (await getSession(crew, supS.id).expect(200)).body as DrawerSessionView;
    expect(other.expected).toBeNull();
    const list = await h.http.get(`${base()}/drawers`).set(bearer(crew)).expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(/expected|4321|counted|variance/i);
    expect((await h.http.get(`${base()}/sessions`).set(bearer(crew))).status).toBe(403);
    const paidIn = await move(crew, s.id, {
      kind: 'paid_in',
      amountCents: 100,
      reason: 'Coins',
    }).expect(201);
    expect(paidIn.body.expected).toBeNull();
    // No available-cash oracle for a blind cashier: probing safe drops of 4421 and 4422 must not
    // behave differently (a 422 on one but not the other would reveal the hidden figure).
    const probeAt = await move(crew, s.id, {
      kind: 'safe_drop',
      amountCents: 4_421,
      reason: 'Probe',
    });
    const probeOver = await move(crew, s.id, {
      kind: 'safe_drop',
      amountCents: 1,
      reason: 'Probe',
    });
    expect(probeAt.status).toBe(probeOver.status);
    for (const r of [probeAt, probeOver]) {
      expect(JSON.stringify(r.body)).not.toMatch(/expectedCents|INSUFFICIENT/);
    }
    // The count response is where it is revealed.
    const counted = await count(crew, s.id, 0).expect(200);
    expect(counted.body.expected.expectedCents).toBe(4_421 - 4_421 - 1);
    if (counted.body.status === 'pending_approval') await approve(supervisor, s.id).expect(200);
  });

  it('crew cannot move, count or take cash through someone else’s drawer', async () => {
    const supS = await openFree(supervisor, 3_000);
    await openFree(crew, 3_000);
    for (const kind of ['paid_in', 'safe_drop', 'paid_out']) {
      expect(
        (await move(crew, supS.id, { kind, amountCents: 100, reason: 'Not mine' })).status,
      ).toBe(403);
    }
    expect((await count(crew, supS.id, 3_000)).status).toBe(403);
    const order = await placeOrder(crew);
    expect((await payCash(crew, order.id, { drawerSessionId: supS.id })).status).toBe(403);
    expect((await approve(crew, supS.id)).status).toBe(403);
    const row = await sessionRow(supS.id);
    expect(row.status).toBe('open');
    expect(
      await h.owner
        .selectFrom('drawer_movements')
        .select('id')
        .where('session_id', '=', supS.id)
        .execute(),
    ).toHaveLength(0);
    expect(
      await h.owner.selectFrom('payments').select('id').where('order_id', '=', order.id).execute(),
    ).toHaveLength(0);
    await cancel(order.id).expect(200);
  });

  it('variance threshold boundary: exactly the threshold closes, one cent more waits for approval', async () => {
    const { cash_variance_threshold_cents: t } = await h.owner
      .selectFrom('restaurants')
      .select('cash_variance_threshold_cents')
      .where('id', '=', driveId)
      .executeTakeFirstOrThrow();
    const a = await openFree(crew, 10_000);
    const ca = await count(crew, a.id, 10_000 - Number(t)).expect(200);
    expect(ca.body).toMatchObject({ status: 'closed', varianceCents: -Number(t) });
    const b = await openFree(crew, 10_000);
    const cb = await count(crew, b.id, 10_000 + Number(t) + 1).expect(200);
    expect(cb.body).toMatchObject({ status: 'pending_approval', varianceCents: Number(t) + 1 });
    expect(await closedEvents(b.id)).toBe(0);
  });

  it('rejects malformed counts', async () => {
    const s = await openFree(crew, 1_000);
    for (const c of [-1, 0.5, 10_000_001, '1000', null]) {
      expect((await count(crew, s.id, c as number)).status).toBe(400);
    }
    const longNotes = await h.http
      .post(`${base()}/sessions/${s.id}/count`)
      .set(bearer(crew))
      .set('Idempotency-Key', randomUUID())
      .send({ countedCents: 1_000, notes: 'x'.repeat(501) });
    expect(longNotes.status).toBe(400);
    expect((await sessionRow(s.id)).status).toBe('open');
  });

  it('a huge over-count is held for approval and still journals cleanly', async () => {
    const s = await openFree(crew, 0);
    const c = await count(crew, s.id, 10_000_000).expect(200);
    expect(c.body).toMatchObject({ status: 'pending_approval', varianceCents: 10_000_000 });
    await approve(supervisor, s.id).expect(200);
  });

  it('count replay after close returns the same result and never emits a second close', async () => {
    const s = await openFree(crew, 2_000);
    const key = randomUUID();
    const first = await count(crew, s.id, 2_000, key).expect(200);
    expect(first.body.status).toBe('closed');
    const replay = await count(crew, s.id, 2_000, key).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect((await count(crew, s.id, 1_999, key)).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await count(crew, s.id, 2_000)).body.error.code).toBe('DRAWER_SESSION_CLOSED');
    expect((await count(manager, s.id, 2_000)).body.error.code).toBe('DRAWER_SESSION_CLOSED');
    expect(await closedEvents(s.id)).toBe(1);
  });

  it('two racing counts with different keys: one closes, the other is refused', async () => {
    const s = await openFree(crew, 3_000);
    const results = await Promise.all([
      fire(count(crew, s.id, 3_000)),
      fire(count(manager, s.id, 3_000)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await closedEvents(s.id)).toBe(1);
    const row = await sessionRow(s.id);
    expect(row.variance_cents).toBe(Number(row.counted_cents) - Number(row.expected_cents));
  });

  // ---------------------------------------------------------------- approvals

  it('approving twice concurrently closes once and posts one drawer_close entry', async () => {
    const s = await openFree(crew, 5_000);
    await count(crew, s.id, 0).expect(200);
    const results = await Promise.all([
      fire(approve(supervisor, s.id)),
      fire(approve(manager, s.id)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await closedEvents(s.id)).toBe(1);
    await dispatcher.runOnce();
    const entries = await h.owner
      .selectFrom('journal_entries')
      .select('id')
      .where('source_id', '=', s.id)
      .where('entry_type', '=', 'drawer_close')
      .execute();
    expect(entries).toHaveLength(1);
    expect((await approve(manager, s.id)).body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('approval: only for pending sessions, only at their restaurant and tenant', async () => {
    const s = await openFree(crew, 5_000);
    expect((await approve(supervisor, s.id)).body.error.code).toBe('INVALID_STATE_TRANSITION'); // still open
    await count(crew, s.id, 1_000).expect(200);
    // Another restaurant's URL (an org-wide admin with cash.manage there) and another tenant.
    const admin = await login(h, 'admin@kitchos.test');
    const rivalMgr = await login(h, 'manager@rival.test');
    const viaExpress = await approve(admin, s.id, expressId);
    expect(viaExpress.status).toBe(404);
    const viaRival = await approve(rivalMgr, s.id, rivalId);
    expect(viaRival.status).toBe(404);
    expect((await approve(rivalMgr, s.id)).status).toBeGreaterThanOrEqual(403);
    expect((await getSession(rivalMgr, s.id, rivalId)).status).toBe(404);
    expect((await getSession(admin, s.id, expressId)).status).toBe(404);
    const shortNotes = await h.http
      .post(`${base()}/sessions/${s.id}/approve`)
      .set(bearer(supervisor))
      .send({ notes: 'ok' });
    expect(shortNotes.status).toBe(400);
    expect((await sessionRow(s.id)).status).toBe('pending_approval');
    expect(await closedEvents(s.id)).toBe(0);
    await approve(supervisor, s.id).expect(200);
  });

  it('while a count awaits approval the cashier can neither take cash nor open another drawer', async () => {
    const s = await openFree(crew, 5_000);
    await count(crew, s.id, 0).expect(200);
    const order = await placeOrder(crew);
    expect((await payCash(crew, order.id)).body.error.code).toBe('DRAWER_SESSION_REQUIRED');
    expect((await payCash(crew, order.id, { drawerSessionId: s.id })).body.error.code).toBe(
      'DRAWER_SESSION_CLOSED',
    );
    expect(
      (await move(supervisor, s.id, { kind: 'paid_in', amountCents: 100, reason: 'Late' })).body
        .error.code,
    ).toBe('DRAWER_SESSION_CLOSED');
    const d = (await freeDrawers(crew))[0]!;
    expect((await open(crew, d.id, 0)).body.error.code).toBe('ALREADY_HAVE_DRAWER');
    await cancel(order.id).expect(200);
  });

  // ------------------------------------------------------------ cash payments

  it('cash payments refuse foreign, unknown and closed drawer sessions', async () => {
    await openFree(crew, 1_000);
    // Another restaurant of the same tenant.
    const expressMgr = await login(h, 'manager@express.kitchos.test');
    const expressFree = await freeDrawers(expressMgr, expressId);
    let expressSession: string | undefined;
    if (expressFree[0]) {
      expressSession = (await open(expressMgr, expressFree[0].id, 0, expressId).expect(201)).body
        .id;
    }
    // Another tenant.
    const rivalMgr = await login(h, 'manager@rival.test');
    const rivalFree = await freeDrawers(rivalMgr, rivalId);
    let rivalSession: string | undefined;
    if (rivalFree[0]) {
      rivalSession = (await open(rivalMgr, rivalFree[0].id, 0, rivalId).expect(201)).body.id;
    }
    const closed = await h.owner
      .selectFrom('drawer_sessions')
      .select('id')
      .where('restaurant_id', '=', driveId)
      .where('opened_by', '=', ids.crew)
      .where('status', '=', 'closed')
      .executeTakeFirstOrThrow();
    try {
      const order = await placeOrder(crew);
      const tries = [randomUUID(), closed.id, expressSession, rivalSession].filter(
        (x): x is string => !!x,
      );
      for (const id of tries) {
        const res = await payCash(crew, order.id, { drawerSessionId: id });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toMatch(/^DRAWER_SESSION_(REQUIRED|CLOSED)$/);
      }
      expect((await payCash(crew, order.id, { drawerSessionId: 'nope' })).status).toBe(400);
      expect(
        await h.owner
          .selectFrom('payments')
          .select('id')
          .where('order_id', '=', order.id)
          .execute(),
      ).toHaveLength(0);
      await cancel(order.id).expect(200);
    } finally {
      if (expressSession)
        await count(expressMgr, expressSession, 0, randomUUID(), expressId).expect(200);
      if (rivalSession) await count(rivalMgr, rivalSession, 0, randomUUID(), rivalId).expect(200);
    }
  });

  // ------------------------------------------------------------- cash refunds

  // Regression for FINDING (failed on the first run with expected cash -880; since fixed by
  // locking the session FOR UPDATE for refunds): cash refunds locked the drawer session only FOR SHARE (resolveCashSession) and check
  // "enough cash in the drawer" before inserting. Two concurrent cash refunds through the same
  // drawer (on different orders) do not block each other, both see the same available cash and
  // both commit, so the drawer's expected cash goes negative (more cash handed out than it held).
  it('two cash refunds racing through one drawer cannot hand out more cash than it holds', async () => {
    await openFree(crew, 5_000);
    const o1 = await soldAndHandedOver(crew);
    const o2 = await soldAndHandedOver(crew);
    const sup = await openFree(supervisor, 1_500); // room for one 1190 refund, not two
    const results = await raceAtCommit(driveId, () => [
      fire(refund(supervisor, o1.id)),
      fire(refund(supervisor, o2.id)),
    ]);
    const ok = results.filter((r) => r.status === 201);
    const expected = await expectedOf(sup.id);
    expect(expected).toBeGreaterThanOrEqual(0);
    expect(ok).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(r.body.error.code).toBe('INSUFFICIENT_DRAWER_CASH');
    }
  });

  it('a cash refund racing a safe drop never leaves the drawer negative', async () => {
    await openFree(crew, 5_000);
    const order = await soldAndHandedOver(crew);
    for (let round = 0; round < 3; round++) {
      const sup = await openFree(supervisor, 2_000);
      const [r, d] = await Promise.all([
        fire(refund(supervisor, order.id, { amountCents: 100 })),
        fire(move(supervisor, sup.id, { kind: 'safe_drop', amountCents: 1_950, reason: 'Race' })),
      ]);
      expect([r.status, d.status]).toContain(201);
      expect(await expectedOf(sup.id)).toBeGreaterThanOrEqual(0);
      await count(supervisor, sup.id, await expectedOf(sup.id)).expect(200);
    }
  });

  it('cash refunds refuse a drawer session of another restaurant or tenant', async () => {
    await openFree(crew, 5_000);
    const order = await soldAndHandedOver(crew);
    await openFree(supervisor, 5_000);
    const expressSession = await h.owner
      .selectFrom('drawer_sessions')
      .select('id')
      .where('restaurant_id', '=', expressId)
      .executeTakeFirst();
    const rivalSession = await h.owner
      .selectFrom('drawer_sessions')
      .select('id')
      .where('restaurant_id', '=', rivalId)
      .executeTakeFirst();
    for (const id of [expressSession?.id, rivalSession?.id, randomUUID()].filter(Boolean)) {
      const res = await refund(supervisor, order.id, { drawerSessionId: id });
      expect(res.status).toBe(409);
    }
    // Nor through the crew cashier's drawer (the refunder must own the drawer).
    const crewSession = await h.owner
      .selectFrom('drawer_sessions')
      .select('id')
      .where('opened_by', '=', ids.crew)
      .where('status', '=', 'open')
      .executeTakeFirstOrThrow();
    expect((await refund(supervisor, order.id, { drawerSessionId: crewSession.id })).status).toBe(
      403,
    );
    expect(
      await h.owner.selectFrom('refunds').select('id').where('order_id', '=', order.id).execute(),
    ).toHaveLength(0);
  });

  // ------------------------------------------------------------ business date

  it('the session list shows earlier days’ unclosed sessions until they close', async () => {
    const s = await openFree(crew, 800);
    await h.owner
      .updateTable('drawer_sessions')
      .set({ business_date: sql`business_date - 1` })
      .where('id', '=', s.id)
      .execute();
    const { business_date: yesterday } = await sessionRow(s.id);
    const listed = async (q = '') =>
      (
        (await h.http.get(`${base()}/sessions${q}`).set(bearer(manager)).expect(200))
          .body as DrawerSessionView[]
      ).map((x) => x.id);
    expect(await listed()).toContain(s.id);
    expect(await listed(`?businessDate=${yesterday}`)).toContain(s.id);
    expect(
      (await h.http.get(`${base()}/sessions?businessDate=2026-13-40`).set(bearer(manager))).status,
    ).toBe(400);
    await count(crew, s.id, 800).expect(200);
    expect(await listed()).not.toContain(s.id);
    expect(await listed(`?businessDate=${yesterday}`)).toContain(s.id);
  });

  // ---------------------------------------------------------------------- RLS

  it('the runtime role cannot see or touch another tenant’s drawers and cannot rewrite history', async () => {
    const s = await openFree(crew, 600);
    await move(crew, s.id, { kind: 'paid_in', amountCents: 100, reason: 'Coins' }).expect(201);
    const seen = await withTenant(appDb, { orgId: rivalOrgId }, (tx) =>
      tx.selectFrom('drawer_sessions').select('id').where('restaurant_id', '=', driveId).execute(),
    );
    expect(seen).toHaveLength(0);
    const seenDrawers = await withTenant(appDb, { orgId: rivalOrgId }, (tx) =>
      tx.selectFrom('cash_drawers').select('id').where('restaurant_id', '=', driveId).execute(),
    );
    expect(seenDrawers).toHaveLength(0);
    const rivalUser = await h.owner
      .selectFrom('users')
      .select('id')
      .where('email', '=', 'manager@rival.test')
      .executeTakeFirstOrThrow();
    await expect(
      withTenant(appDb, { orgId: rivalOrgId }, (tx) =>
        tx
          .insertInto('drawer_movements')
          .values({
            org_id: rivalOrgId,
            session_id: s.id,
            kind: 'safe_drop',
            amount_cents: 100,
            reason: 'Cross-tenant',
            recorded_by: rivalUser.id,
          })
          .execute(),
      ),
    ).rejects.toThrow();
    // Same tenant, but history is append-only and the float is immutable.
    await expect(
      withTenant(appDb, { orgId: demoOrgId }, (tx) =>
        tx
          .updateTable('drawer_movements')
          .set({ amount_cents: 1 })
          .where('session_id', '=', s.id)
          .execute(),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(appDb, { orgId: demoOrgId }, (tx) =>
        tx
          .updateTable('drawer_sessions')
          .set({ opening_float_cents: 999_999 })
          .where('id', '=', s.id)
          .execute(),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(appDb, { orgId: demoOrgId }, (tx) =>
        tx.deleteFrom('drawer_sessions').where('id', '=', s.id).execute(),
      ),
    ).rejects.toThrow();
    const row = await sessionRow(s.id);
    expect(Number(row.opening_float_cents)).toBe(600);
  });

  // ------------------------------------------------------------------ journal

  it('journal integrity: every session closed here nets cash on hand to zero, no duplicates, balanced', async () => {
    await freeMine();
    for (let i = 0; i < 5; i++) await dispatcher.runOnce();
    const sessions = await h.owner
      .selectFrom('drawer_sessions')
      .select(['id', 'opening_float_cents', 'status'])
      .where('restaurant_id', '=', driveId)
      .where('opened_by', 'in', [ids.crew, ids.supervisor, ids.manager])
      .where('opened_at', '>=', startedAt)
      .execute();
    expect(sessions.length).toBeGreaterThan(10);
    for (const s of sessions) {
      expect(s.status).toBe('closed');
      const { rows } = await sql<{ net: string }>`
        select coalesce(sum(l.debit_cents - l.credit_cents), 0) as net
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        join accounts a on a.id = l.account_id
        where a.system_key = 'cash_on_hand' and (
          e.source_id = ${s.id}::uuid
          or e.source_id in (select id from drawer_movements where session_id = ${s.id}::uuid)
          or e.source_id in (select id from payments where drawer_session_id = ${s.id}::uuid)
          or e.source_id in (select id from refunds where drawer_session_id = ${s.id}::uuid))`.execute(
        h.owner,
      );
      expect({ id: s.id, net: Number(rows[0]!.net) }).toEqual({ id: s.id, net: 0 });
      const perType = await h.owner
        .selectFrom('journal_entries')
        .select(['entry_type', sql<string>`count(*)`.as('n')])
        .where('source_id', '=', s.id)
        .groupBy('entry_type')
        .execute();
      for (const t of perType)
        expect({ id: s.id, type: t.entry_type, n: Number(t.n) }).toMatchObject({ n: 1 });
      expect(perType.some((t) => t.entry_type === 'drawer_float')).toBe(
        Number(s.opening_float_cents) > 0,
      );
    }
    const dupEvents = await sql<{ source_event_id: string }>`
      select source_event_id from journal_entries
      where source_event_id is not null and reverses_entry_id is null
      group by source_event_id having count(*) > 1`.execute(h.owner);
    expect(dupEvents.rows).toEqual([]);
    const unbalanced = await sql<{ entry_id: string }>`
      select entry_id from journal_lines group by entry_id
      having sum(debit_cents) <> sum(credit_cents)`.execute(h.owner);
    expect(unbalanced.rows).toEqual([]);
    const tb = await sql<{ org_id: string; d: string; c: string }>`
      select org_id, sum(debit_cents) as d, sum(credit_cents) as c from journal_lines group by org_id`.execute(
      h.owner,
    );
    for (const r of tb.rows) expect(r.d).toBe(r.c);
  });
});
