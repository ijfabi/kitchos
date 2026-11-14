import { randomUUID } from 'node:crypto';
import type {
  DayCloseView,
  DrawerAdminView,
  DrawerSessionView,
  LedgerReconciliation,
} from '@kitchos/contracts';
import { createDb, withTenant, type Database } from '@kitchos/database';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { EventDispatcher, MAX_ATTEMPTS } from '../src/events/event-dispatcher.service.ts';
import { bearer, login, restaurantId, startHarness, type Harness } from './harness.ts';

const CENTRAL = 'kitchos-central';
const DRIVE = 'kitchos-drive';
const RIVAL = 'rival-southbank';

/**
 * Adversarial tests for business-day close and drawer administration.
 *
 * Hygiene: everything that closes a day, dead-letters an event or opens a drawer
 * runs in a throwaway organisation with its own restaurants, created here. A
 * throwaway restaurant in the demo organisation would break the restaurant counts
 * other files assert. Central, Drive and Rival are only read, or receive requests
 * that must be refused. afterAll retires any failure still retrying (so no later
 * file sees it in `stats.failed`) and closes every session left open.
 *
 * Backdating moves rows to a past day with `session_replication_role = replica`
 * for one owner transaction, because stock movements are append-only. It runs
 * before dispatch, so the real consumer computes the real posting date.
 */
describe('business-day close and drawer administration (adversarial)', () => {
  let h: Harness;
  let h2: Harness;
  let appDb: Database;
  let dispatcher: EventDispatcher;
  let dispatcher2: EventDispatcher;
  let orgId: string;
  let brandId: string;
  let regionId: string;
  let menuId: string;
  const menuItems: Record<'burger' | 'cola' | 'odd', string> = { burger: '', cola: '', odd: '' };
  const skus: Record<'bun' | 'cup', string> = { bun: '', cup: '' };
  const tokens = {
    manager: '',
    manager2: '',
    supervisor: '',
    crew: '',
    crew2: '',
    auditor: '',
    area: '',
    inventory: '',
  };

  interface Rest {
    id: string;
    slug: string;
    drawers: string[];
  }

  // ------------------------------------------------------------------ fixture

  /** A private tenant, built like seedRivalOrg: chart, catalogue, published menu, org-wide staff. */
  const buildOrg = async () => {
    const tag = randomUUID().slice(0, 8);
    const org = await h.owner
      .insertInto('organisations')
      .values({ name: `Day close adversarial ${tag}`, slug: `dca-${tag}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    orgId = org.id;
    await sql`select app.create_default_chart(${orgId}::uuid)`.execute(h.owner);
    brandId = (
      await h.owner
        .insertInto('brands')
        .values({ org_id: orgId, name: 'DCA', slug: `dca-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    regionId = (
      await h.owner
        .insertInto('regions')
        .values({ org_id: orgId, name: 'DCA region' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const inv = async (sku: string, cost: string) =>
      (
        await h.owner
          .insertInto('inventory_items')
          .values({
            org_id: orgId,
            sku,
            name: sku,
            base_unit: 'each',
            category: 'ingredient',
            standard_unit_cost: cost,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    skus.bun = await inv('BUN', '40');
    skus.cup = await inv('CUP', '15');
    const menu = await h.owner
      .insertInto('menus')
      .values({ org_id: orgId, brand_id: brandId, name: 'DCA menu' })
      .returning('id')
      .executeTakeFirstOrThrow();
    menuId = menu.id;
    const mv = await h.owner
      .insertInto('menu_versions')
      .values({ org_id: orgId, menu_id: menu.id, version: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const addItem = async (name: string, price: number, ingredient: string, point: string) => {
      const product = await h.owner
        .insertInto('products')
        .values({ org_id: orgId, brand_id: brandId, sku: name, name, kind: 'item' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const recipe = await h.owner
        .insertInto('recipes')
        .values({ org_id: orgId, product_id: product.id })
        .returning('id')
        .executeTakeFirstOrThrow();
      const rv = await h.owner
        .insertInto('recipe_versions')
        .values({
          org_id: orgId,
          recipe_id: recipe.id,
          version: 1,
          station_type: 'grill',
          consumption_point: point,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await h.owner
        .insertInto('recipe_lines')
        .values({
          org_id: orgId,
          recipe_version_id: rv.id,
          inventory_item_id: ingredient,
          quantity: '1',
        })
        .execute();
      await h.owner
        .updateTable('recipe_versions')
        .set({ status: 'published', published_at: sql<Date>`now()` })
        .where('id', '=', rv.id)
        .execute();
      return (
        await h.owner
          .insertInto('menu_items')
          .values({
            org_id: orgId,
            menu_version_id: mv.id,
            product_id: product.id,
            category: 'All',
            price_cents: price,
            recipe_version_id: rv.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    };
    menuItems.burger = await addItem('Burger', 1100, skus.bun, 'task_started');
    menuItems.cola = await addItem('Cola', 330, skus.cup, 'order_accepted');
    menuItems.odd = await addItem('Odd', 1103, skus.bun, 'task_started');
    await h.owner
      .updateTable('menu_versions')
      .set({ status: 'published', published_at: sql<Date>`now()` })
      .where('id', '=', mv.id)
      .execute();

    const { password_hash } = await h.owner
      .selectFrom('users')
      .select('password_hash')
      .where('email', '=', 'manager@central.kitchos.test')
      .executeTakeFirstOrThrow();
    const roles: Record<keyof typeof tokens, string> = {
      manager: 'restaurant_manager',
      manager2: 'restaurant_manager',
      supervisor: 'shift_supervisor',
      crew: 'crew_member',
      crew2: 'crew_member',
      auditor: 'auditor',
      area: 'area_manager',
      inventory: 'inventory_controller',
    };
    for (const [k, role] of Object.entries(roles) as [keyof typeof tokens, string][]) {
      const email = `${k}-${tag}@dca.test`;
      const user = await h.owner
        .insertInto('users')
        .values({ org_id: orgId, email, display_name: `DCA ${k}`, password_hash })
        .returning('id')
        .executeTakeFirstOrThrow();
      await h.owner
        .insertInto('role_assignments')
        .values({
          org_id: orgId,
          user_id: user.id,
          role,
          scope_type: 'organisation',
          scope_id: orgId,
        })
        .execute();
      tokens[k] = await login(h, email);
    }
  };

  const newRestaurant = async (): Promise<Rest> => {
    const slug = `dca-${randomUUID().slice(0, 8)}`;
    const r = await h.owner
      .insertInto('restaurants')
      .values({
        org_id: orgId,
        brand_id: brandId,
        region_id: regionId,
        menu_id: menuId,
        name: slug,
        slug,
        ownership: 'company',
        timezone: 'UTC',
        stock_shortage_policy: 'allow_negative',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await h.owner
      .insertInto('stations')
      .values({
        org_id: orgId,
        restaurant_id: r.id,
        code: 'grill',
        name: 'Grill',
        station_types: ['grill', 'expo'],
      })
      .execute();
    const drawers = await h.owner
      .insertInto('cash_drawers')
      .values(
        [1, 2].map((i) => ({
          org_id: orgId,
          restaurant_id: r.id,
          code: `till-${i}`,
          name: `Till ${i}`,
        })),
      )
      .returning('id')
      .execute();
    await h.owner
      .insertInto('stock_locations')
      .values({ org_id: orgId, restaurant_id: r.id, code: 'main', name: 'Main', is_default: true })
      .execute();
    await h.owner
      .insertInto('restaurant_event_sequences')
      .values({ org_id: orgId, restaurant_id: r.id })
      .execute();
    return { id: r.id, slug, drawers: drawers.map((d) => d.id) };
  };

  beforeAll(async () => {
    h = await startHarness();
    h2 = await startHarness();
    appDb = createDb({ connectionString: inject('appUrl'), max: 3 }).db;
    dispatcher = h.app.get(EventDispatcher);
    dispatcher2 = h2.app.get(EventDispatcher);
    await buildOrg();
  });

  afterAll(async () => {
    await drain();
    await asOwnerRaw(async (tx) => {
      await sql`update event_consumer_failures set dead_at = now()
                 where org_id = ${orgId}::uuid and dead_at is null`.execute(tx);
      await sql`update drawer_sessions
                   set status = 'closed', counted_at = now(), counted_by = opened_by,
                       counted_cents = 0, expected_cents = 0, variance_cents = 0, closed_at = now()
                 where org_id = ${orgId}::uuid and status <> 'closed'`.execute(tx);
    });
    await appDb.destroy();
    await h2.close();
    await h.close();
  });

  // ------------------------------------------------------------------ helpers

  const api = (rid: string) => `/v1/restaurants/${rid}`;

  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      const stats = await dispatcher.runOnce();
      if (stats.processed === 0) return;
    }
  };

  const asOwnerRaw = (fn: (tx: Database) => Promise<void>) =>
    h.owner.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = replica`.execute(tx);
      await fn(tx);
    });

  const dbNow = async () => (await sql<{ n: Date }>`select now() as n`.execute(h.owner)).rows[0]!.n;

  const today = async (rid: string) =>
    (
      await sql<{ d: string }>`select app.business_date(${rid}::uuid, now())::text as d`.execute(
        h.owner,
      )
    ).rows[0]!.d;

  const addDays = async (day: string, n: number) =>
    (await sql<{ d: string }>`select (${day}::date + ${n}::int)::text as d`.execute(h.owner))
      .rows[0]!.d;

  /** Moves everything recorded at this restaurant since `since` back by whole days. */
  const shift = (rid: string, days: number, since: Date) =>
    asOwnerRaw(async (tx) => {
      const by = sql`(${days}::int * interval '1 day')`;
      const prior = sql`${days}::int`;
      await sql`update orders set placed_at = placed_at - ${by}, accepted_at = accepted_at - ${by},
                  ready_at = ready_at - ${by}, completed_at = completed_at - ${by},
                  cancelled_at = cancelled_at - ${by}, business_date = business_date - ${prior}
                where restaurant_id = ${rid}::uuid and placed_at >= ${since}`.execute(tx);
      await sql`update payments set created_at = created_at - ${by}, captured_at = captured_at - ${by}
                where restaurant_id = ${rid}::uuid and created_at >= ${since}`.execute(tx);
      await sql`update refunds set created_at = created_at - ${by}
                where restaurant_id = ${rid}::uuid and created_at >= ${since}`.execute(tx);
      await sql`update drawer_movements m set created_at = m.created_at - ${by}
                from drawer_sessions s
                where s.id = m.session_id and s.restaurant_id = ${rid}::uuid and m.created_at >= ${since}`.execute(
        tx,
      );
      await sql`update drawer_sessions set opened_at = opened_at - ${by}, counted_at = counted_at - ${by},
                  closed_at = closed_at - ${by}, business_date = business_date - ${prior}
                where restaurant_id = ${rid}::uuid and opened_at >= ${since}`.execute(tx);
      await sql`update stock_movements set occurred_at = occurred_at - ${by},
                  recorded_at = recorded_at - ${by}, business_date = business_date - ${prior}
                where restaurant_id = ${rid}::uuid and occurred_at >= ${since}`.execute(tx);
      await sql`update waste_records set occurred_at = occurred_at - ${by},
                  reviewed_at = reviewed_at - ${by}, business_date = business_date - ${prior}
                where restaurant_id = ${rid}::uuid and occurred_at >= ${since}`.execute(tx);
      await sql`update stock_counts set counted_at = counted_at - ${by},
                  business_date = business_date - ${prior}
                where restaurant_id = ${rid}::uuid and counted_at >= ${since}`.execute(tx);
      await sql`update goods_receipts set received_at = received_at - ${by},
                  business_date = business_date - ${prior}
                where restaurant_id = ${rid}::uuid and received_at >= ${since}`.execute(tx);
      await sql`update outbox_events set occurred_at = occurred_at - ${by}
                where restaurant_id = ${rid}::uuid and occurred_at >= ${since}`.execute(tx);
    });

  const noon = (day: string) => sql<Date>`((${day}::date + time '12:00') at time zone 'UTC')`;

  /** One event, moved so that it occurred at noon on `day`. */
  const moveEvent = (eventType: string, aggregateId: string, day: string) =>
    asOwnerRaw(async (tx) => {
      await sql`update outbox_events set occurred_at = ${noon(day)}
                where event_type = ${eventType} and aggregate_id = ${aggregateId}::uuid`.execute(
        tx,
      );
    });

  const insertEvent = (rid: string, eventType: string, aggregateId: string, day: string) =>
    h.owner.transaction().execute(async (tx) => {
      const { last_sequence } = await tx
        .updateTable('restaurant_event_sequences')
        .set((eb) => ({ last_sequence: eb('last_sequence', '+', 1) }))
        .where('restaurant_id', '=', rid)
        .returning('last_sequence')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('outbox_events')
        .values({
          org_id: orgId,
          restaurant_id: rid,
          store_sequence: last_sequence,
          aggregate_type: 'payment',
          aggregate_id: aggregateId,
          aggregate_version: 1,
          event_type: eventType,
          payload: JSON.stringify({ poison: true }),
          occurred_at: noon(day),
        })
        .execute();
    });

  const view = async (rid: string, day: string, token = tokens.manager) =>
    (
      await h.http
        .get(`${api(rid)}/days/${day}`)
        .set(bearer(token))
        .expect(200)
    ).body as DayCloseView;
  const close = (rid: string, day: string, token = tokens.manager, http = h.http) =>
    http
      .post(`${api(rid)}/days/${day}/close`)
      .set(bearer(token))
      .send({});
  const blockers = (v: DayCloseView) => v.blockers.map((b) => b.code);
  const reconciliation = async (rid: string, day: string) =>
    (
      await h.http
        .get(`${api(rid)}/accounting/reconciliation?businessDate=${day}`)
        .set(bearer(tokens.manager))
        .expect(200)
    ).body as LedgerReconciliation;

  const failuresAt = (rid: string) =>
    h.owner
      .selectFrom('event_consumer_failures as f')
      .innerJoin('outbox_events as o', 'o.id', 'f.event_id')
      .select(['o.event_type', 'f.attempts', 'f.dead_at', 'f.last_error'])
      .where('o.restaurant_id', '=', rid)
      .orderBy('o.store_sequence')
      .execute();

  /** Runs out every retry of every event failing at this restaurant. */
  const exhaustRetries = async (rid: string) => {
    for (let i = 0; i <= MAX_ATTEMPTS; i++) {
      await sql`update event_consumer_failures f set next_attempt_at = now() - interval '1 second'
                from outbox_events o
                where o.id = f.event_id and o.restaurant_id = ${rid}::uuid and f.dead_at is null`.execute(
        h.owner,
      );
      await dispatcher.runOnce();
    }
  };

  /** Net debit − credit on one account at a restaurant, for one day or all time. */
  const accountNet = async (rid: string, key: string, day?: string) => {
    let q = h.owner
      .selectFrom('journal_lines as l')
      .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(sql<string>`coalesce(sum(l.debit_cents - l.credit_cents), 0)`.as('net'))
      .where('e.restaurant_id', '=', rid)
      .where('a.system_key', '=', key);
    if (day) q = q.where('e.business_date', '=', day);
    return Number((await q.executeTakeFirstOrThrow()).net);
  };

  const entries = (rid: string, day?: string) => {
    let q = h.owner
      .selectFrom('journal_entries')
      .select(['id', 'entry_type', 'business_date', 'source_id'])
      .where('restaurant_id', '=', rid);
    if (day) q = q.where('business_date', '=', day);
    return q.execute();
  };

  // Staff flows, all through the real API.

  const ring = async (rid: string, token: string, names: (keyof typeof menuItems)[]) => {
    const res = await h.http
      .post(`${api(rid)}/orders`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({
        fulfilmentType: 'dine_in',
        lines: names.map((n) => ({ menuItemId: menuItems[n], quantity: 1 })),
      });
    if (res.status !== 201) throw new Error(`ring ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; totalCents: number; cashDueCents: number };
  };
  const pay = async (rid: string, token: string, orderId: string, tender: object) => {
    const res = await h.http
      .post(`${api(rid)}/orders/${orderId}/payments`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send(tender);
    if (res.status !== 200) throw new Error(`pay ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const CARD = { method: 'card', paymentToken: 'tok_sandbox_approve' };
  const CASH = { method: 'cash', tenderedCents: 5000 };
  const paymentOf = (orderId: string) =>
    h.owner
      .selectFrom('payments')
      .selectAll()
      .where('order_id', '=', orderId)
      .executeTakeFirstOrThrow();
  /** Completes the order's kitchen tasks, then hands it over. */
  const finish = async (rid: string, orderId: string, token = tokens.supervisor) => {
    const tasks = await h.owner
      .selectFrom('kitchen_tasks')
      .select('id')
      .where('order_id', '=', orderId)
      .execute();
    for (const t of tasks) {
      await h.http
        .post(`${api(rid)}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(token))
        .send({})
        .expect(200);
    }
    await h.http
      .post(`${api(rid)}/orders/${orderId}/handoff`)
      .set(bearer(token))
      .expect(200);
  };
  const openSession = async (rid: string, drawerId: string, token: string, float: number) => {
    const res = await h.http
      .post(`${api(rid)}/cash/drawers/${drawerId}/sessions`)
      .set(bearer(token))
      .send({ openingFloatCents: float });
    if (res.status !== 201) throw new Error(`open ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as DrawerSessionView;
  };
  const movement = (
    rid: string,
    token: string,
    sessionId: string,
    kind: string,
    amountCents: number,
  ) =>
    h.http
      .post(`${api(rid)}/cash/sessions/${sessionId}/movements`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ kind, amountCents, reason: 'Adversarial test' });
  const countDrawer = (
    rid: string,
    token: string,
    sessionId: string,
    countedCents: number,
    http = h.http,
  ) =>
    http
      .post(`${api(rid)}/cash/sessions/${sessionId}/count`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ countedCents });
  const approveVariance = (rid: string, token: string, sessionId: string, http = h.http) =>
    http
      .post(`${api(rid)}/cash/sessions/${sessionId}/approve`)
      .set(bearer(token))
      .send({ notes: 'Adversarial approval' });
  // Money only unless a test says otherwise: these tests pin money and cost, and a quality refund
  // would otherwise also record the food as waste (Milestone 14).
  const refund = (rid: string, token: string, orderId: string, body: object) =>
    h.http
      .post(`${api(rid)}/orders/${orderId}/refunds`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ waste: [], ...body });
  const recordWaste = (rid: string, token: string, inventoryItemId: string, quantity: string) =>
    h.http
      .post(`${api(rid)}/inventory/waste`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'raw_ingredient', inventoryItemId, quantity, reason: 'spoiled' });

  // ------------------------------------------------------------- 1. closed days

  describe('1a. a drawer session that outlives its business day', () => {
    let r: Rest;
    let D: string;
    let Dnext: string;
    let sessionId: string;
    let closeStatus: number;
    let pendingOnD: number;
    let controlOrderId: string;

    beforeAll(async () => {
      r = await newRestaurant();
      const t = await today(r.id);
      D = await addDays(t, -60);
      Dnext = await addDays(t, -59);
      const since = await dbNow();
      const s = await openSession(r.id, r.drawers[0]!, tokens.crew, 10_000);
      sessionId = s.id;
      const order = await ring(r.id, tokens.crew, ['burger']);
      await pay(r.id, tokens.crew, order.id, CASH);
      await finish(r.id, order.id, tokens.crew);
      await shift(r.id, 60, since);
      await drain();
    });

    it('D and later days cannot close while the session is open, and it holds them', async () => {
      expect(blockers(await view(r.id, D))).toEqual(['DRAWERS_OPEN']);
      expect(blockers(await view(r.id, Dnext))).toEqual(['DRAWERS_OPEN']);
      const res = await close(r.id, D);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DAY_NOT_READY');
      const n = await h.owner
        .selectFrom('business_day_closes')
        .select('id')
        .where('restaurant_id', '=', r.id)
        .execute();
      expect(n).toEqual([]);
    });

    it('arrange: a safe drop and a short count on D+1, not yet dispatched, then D closes', async () => {
      expect((await movement(r.id, tokens.crew, sessionId, 'safe_drop', 1000)).status).toBe(201);
      const counted = await countDrawer(r.id, tokens.crew, sessionId, 9900);
      expect(counted.status).toBe(200);
      expect(counted.body).toMatchObject({
        status: 'closed',
        countedCents: 9900,
        varianceCents: -200,
      });
      // float 10000 + sale 1100 - drop 1000 = 10100 expected; counted 9900.
      expect(counted.body.expected.expectedCents).toBe(10_100);
      const moved = await h.owner
        .selectFrom('outbox_events')
        .select(['event_type', 'aggregate_id'])
        .where('restaurant_id', '=', r.id)
        .where('event_type', 'in', ['drawer.closed', 'drawer.movement_recorded'])
        .execute();
      expect(moved).toHaveLength(2);
      for (const m of moved) await moveEvent(m.event_type, m.aggregate_id, Dnext);

      const control = await ring(r.id, tokens.supervisor, ['burger']);
      controlOrderId = control.id;
      await pay(r.id, tokens.supervisor, control.id, CARD);

      // The fallback would hide a wrong backlog: pin the backlog and the refusal directly.
      const rec = await h.http
        .get(`${api(r.id)}/accounting/reconciliation?businessDate=${D}`)
        .set(bearer(tokens.manager))
        .expect(200);
      pendingOnD = rec.body.pendingEvents;
      closeStatus = (await close(r.id, D)).status;
      await dispatcher.runOnce();
      await exhaustRetries(r.id);
    });

    it('events behind the stranded ones are still processed', async () => {
      const p = await paymentOf(controlOrderId);
      const posted = (await entries(r.id)).filter((e) => e.source_id === p.id);
      expect(posted.map((e) => e.entry_type)).toEqual(['payment_receipt']);
    });

    it('a day after the stranded business day can still close when nothing relates to it', async () => {
      const later = await addDays(D, 2);
      expect(blockers(await view(r.id, later))).toEqual([]);
    });

    // Regression: closing D strands the drawer entries of a session counted after D ended.
    // Repro: open a session on D; on D+1 record a safe drop and count it (status closed);
    // POST /days/D/close before the dispatcher runs: 200, because the backlog check keys
    // on outbox occurred_at (D+1) while the consumer posts on the session's business_date (D).
    // reconciliation.service.ts:86 versus ledger.consumer.ts:96 and :116.
    it('every event of a closed session posts instead of dead-lettering', async () => {
      const failures = await failuresAt(r.id);
      expect({ closeStatus, pendingOnD, failures }).toEqual({
        closeStatus: 409,
        pendingOnD: 2,
        failures: [],
      });
    });

    // Regression: same repro. Cash on hand keeps the whole session balance on the books for ever,
    // the safe is understated and the short never reaches Cash over/short.
    it('the books carry the counted drawer: cash on hand 0, safe and over/short correct', async () => {
      const books = {
        cashOnHand: await accountNet(r.id, 'cash_on_hand'),
        cashOverShort: await accountNet(r.id, 'cash_over_short'),
        cashInSafe: await accountNet(r.id, 'cash_in_safe'),
      };
      // float -10000, drop +1000, counted +9900.
      expect(books).toEqual({ cashOnHand: 0, cashOverShort: 200, cashInSafe: 900 });
    });

    // Regression: same repro. The dead letter's occurred_at is D+1, so D+1 now shows LEDGER_FAILED
    // with no way to clear it: dead letters are never retried and D is immutable.
    it('D+1 is not held hostage by entries that belong to D', async () => {
      const v = await view(r.id, Dnext);
      const rec = await reconciliation(r.id, Dnext);
      expect({ blockers: blockers(v), dead: rec.deadLetteredEvents }).toEqual({
        blockers: [],
        dead: 0,
      });
      expect((await close(r.id, Dnext)).status).toBe(200);
    });

    // Regression: same repro. The snapshot's drawer row shows the -200 variance while its totals
    // say the drawers balanced, so the stored close disagrees with itself.
    it("the closed day's snapshot totals include the drawer's short", async () => {
      await close(r.id, D); // refused until those events posted; they have now
      const v = await view(r.id, D);
      expect(v.status).toBe('closed');
      expect(v.drawers[0]).toMatchObject({ varianceCents: -200 });
      expect(v.totals!.cashOverShortCents).toBe(200);
    });
  });

  describe('1b. events whose posting date equals a closed day', () => {
    const posted = async (rid: string, entryType: string, sourceId: string) =>
      (await entries(rid)).filter((e) => e.entry_type === entryType && e.source_id === sourceId);

    // Regression: an event committed after its posting day closed is dead-lettered and the entry is lost.
    // Reachable through a transaction that starts before the cutoff and commits after a close
    // (outbox occurred_at and the source timestamps are both now() = transaction start, and an
    // uncommitted event is invisible to the backlog check at day-close.service.ts:53).
    // Repro: close D, record the operation, move its source timestamp and event onto D, dispatch.
    // ledger.service.ts:49 raises KITCHOS_DAY_CLOSED; nothing reposts it on an open day.
    it('a late sale still reaches the books', async () => {
      const r = await newRestaurant();
      const D = await addDays(await today(r.id), -60);
      expect((await close(r.id, D)).status).toBe(200);
      const o = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      const tasks = await h.owner
        .selectFrom('kitchen_tasks')
        .select('id')
        .where('order_id', '=', o.id)
        .execute();
      for (const t of tasks) {
        await h.http
          .post(`${api(r.id)}/kitchen/tasks/${t.id}/complete`)
          .set(bearer(tokens.supervisor))
          .send({})
          .expect(200);
      }
      await drain();
      await h.http
        .post(`${api(r.id)}/orders/${o.id}/handoff`)
        .set(bearer(tokens.supervisor))
        .expect(200);
      await asOwnerRaw(async (tx) => {
        await sql`update orders set completed_at = ${noon(D)} where id = ${o.id}::uuid`.execute(tx);
      });
      await moveEvent('order.completed', o.id, D);
      await dispatcher.runOnce();
      await exhaustRetries(r.id);
      expect({
        failures: (await failuresAt(r.id)).map((f) => f.event_type),
        posted: (await posted(r.id, 'sale_recognition', o.id)).length,
      }).toEqual({ failures: [], posted: 1 });
      // It lands on today, flagged, and does not unbalance today: its source is dated to D.
      const day = await today(r.id);
      const rec = await h.http
        .get(`${api(r.id)}/accounting/reconciliation?businessDate=${day}`)
        .set(bearer(tokens.manager))
        .expect(200);
      expect(rec.body.reconciled).toBe(true);
      expect((await view(r.id, day)).warnings.map((w) => w.code)).toContain('LATE_ENTRIES');
    });

    // Regression: as above, for a payment. Card clearing and customer deposits stay understated.
    it('a late payment still reaches the books', async () => {
      const r = await newRestaurant();
      const D = await addDays(await today(r.id), -60);
      expect((await close(r.id, D)).status).toBe(200);
      const o = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      const p = await paymentOf(o.id);
      await asOwnerRaw(async (tx) => {
        await sql`update payments set captured_at = ${noon(D)} where id = ${p.id}::uuid`.execute(
          tx,
        );
      });
      await moveEvent('payment.captured', p.id, D);
      await dispatcher.runOnce();
      await exhaustRetries(r.id);
      expect({
        failures: (await failuresAt(r.id)).map((f) => f.event_type),
        posted: (await posted(r.id, 'payment_receipt', p.id)).length,
        cardClearing: await accountNet(r.id, 'card_clearing'),
      }).toEqual({ failures: [], posted: 1, cardClearing: 1100 });
      // It landed on today but its source is dated D: today's card comparison must not count it.
      expect(await reconciliation(r.id, await today(r.id))).toMatchObject({
        reconciled: true,
        cardNetCents: 0,
        journalCardClearingCents: 0,
      });
    });

    // Regression: as above, for a refund.
    it('a late refund still reaches the books', async () => {
      const r = await newRestaurant();
      const D = await addDays(await today(r.id), -60);
      expect((await close(r.id, D)).status).toBe(200);
      const o = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      await finish(r.id, o.id);
      await drain();
      const res = await refund(r.id, tokens.supervisor, o.id, {
        amountCents: 100,
        reason: 'quality',
      });
      expect(res.status).toBe(201);
      const f = await h.owner
        .selectFrom('refunds')
        .select('id')
        .where('order_id', '=', o.id)
        .executeTakeFirstOrThrow();
      await asOwnerRaw(async (tx) => {
        await sql`update refunds set created_at = ${noon(D)} where id = ${f.id}::uuid`.execute(tx);
      });
      await moveEvent('payment.refunded', f.id, D);
      await dispatcher.runOnce();
      await exhaustRetries(r.id);
      expect({
        failures: (await failuresAt(r.id)).map((x) => x.event_type),
        posted: (await posted(r.id, 'refund', f.id)).length,
        // Today holds the 1100 sale; the 100 refund is dated D, so neither side counts it today.
        today: await reconciliation(r.id, await today(r.id)).then((x) => ({
          reconciled: x.reconciled,
          card: x.cardNetCents,
          journalCard: x.journalCardClearingCents,
        })),
      }).toEqual({
        failures: [],
        posted: 1,
        today: { reconciled: true, card: 1100, journalCard: 1100 },
      });
    });

    // Regression: as above, for a waste rejection. Stock goes back but the Inventory account does not,
    // so the inventory sub-ledger stops reconciling.
    it('a late waste review still reaches the books', async () => {
      const r = await newRestaurant();
      const D = await addDays(await today(r.id), -60);
      expect((await close(r.id, D)).status).toBe(200);
      await h.owner
        .updateTable('restaurants')
        .set({ waste_approval_threshold_cents: 0 })
        .where('id', '=', r.id)
        .execute();
      const w = await recordWaste(r.id, tokens.crew, skus.bun, '2');
      expect(w.status).toBe(201);
      expect(w.body.status).toBe('pending_approval');
      await drain();
      await h.http
        .post(`${api(r.id)}/inventory/waste/${w.body.id}/reject`)
        .set(bearer(tokens.manager))
        .send({ reason: 'Adversarial rejection' })
        .expect(200);
      await asOwnerRaw(async (tx) => {
        await sql`update waste_records set reviewed_at = ${noon(D)} where id = ${w.body.id}::uuid`.execute(
          tx,
        );
        await sql`update stock_movements set business_date = ${D}::date
                  where source_id = ${w.body.id}::uuid and movement_type = 'correction'`.execute(
          tx,
        );
      });
      await moveEvent('inventory.waste_rejected', w.body.id, D);
      await dispatcher.runOnce();
      await exhaustRetries(r.id);
      expect({
        failures: (await failuresAt(r.id)).map((x) => x.event_type),
        posted: (await posted(r.id, 'waste_reversal', w.body.id)).length,
      }).toEqual({ failures: [], posted: 1 });
    });

    it('ordinary late activity after a close posts on the day it happens', async () => {
      const r = await newRestaurant();
      await h.owner
        .updateTable('restaurants')
        .set({ waste_approval_threshold_cents: 0 })
        .where('id', '=', r.id)
        .execute();
      const t = await today(r.id);
      const D = await addDays(t, -60);
      const since = await dbNow();
      const o = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      const w = await recordWaste(r.id, tokens.crew, skus.bun, '1');
      expect(w.body.status).toBe('pending_approval');
      await shift(r.id, 60, since);
      await drain();

      const closed = await close(r.id, D);
      expect(closed.status).toBe(200);
      expect((closed.body as DayCloseView).warnings.map((x) => x.code).sort()).toEqual([
        'ORDERS_UNFINISHED',
        'WASTE_PENDING',
      ]);
      const onD = (await entries(r.id, D)).length;

      await finish(r.id, o.id);
      await drain();
      await refund(r.id, tokens.supervisor, o.id, { amountCents: 110, reason: 'quality' });
      await h.http
        .post(`${api(r.id)}/inventory/waste/${w.body.id}/reject`)
        .set(bearer(tokens.manager))
        .send({ reason: 'Adversarial rejection' })
        .expect(200);
      await drain();

      expect(await failuresAt(r.id)).toEqual([]);
      expect((await entries(r.id, D)).length).toBe(onD);
      const types = (await entries(r.id, t)).map((e) => e.entry_type).sort();
      expect(types).toEqual(['cogs', 'refund', 'sale_recognition', 'waste_reversal']);
      expect(await reconciliation(r.id, t)).toMatchObject({
        reconciled: true,
        pendingEvents: 0,
        deadLetteredEvents: 0,
      });
    });
  });

  // ------------------------------------------------------------------ 2. races

  describe('2. races', () => {
    const STAGGER_MS = [0, 5, 10, 20, 40, 80];
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('close against both dispatchers: never a lost or stranded entry, snapshot equals the journal', async () => {
      const r = await newRestaurant();
      const t = await today(r.id);
      for (let i = 0; i < 5; i++) {
        const days = 60 + i;
        const D = await addDays(t, -days);
        const since = await dbNow();
        const o = await ring(r.id, tokens.supervisor, ['burger']);
        await pay(r.id, tokens.supervisor, o.id, CARD);
        await shift(r.id, days, since);
        const [res] = await Promise.all([
          close(r.id, D, tokens.manager, h2.http),
          dispatcher.runOnce(),
          dispatcher2.runOnce(),
        ]);
        expect([200, 409]).toContain(res.status);
        if (res.status === 409) {
          expect(res.body.error.code).toBe('DAY_NOT_READY');
          await drain();
          expect((await close(r.id, D)).status).toBe(200);
        }
        await drain();
        const stored = await view(r.id, D);
        expect(stored.status).toBe('closed');
        expect(stored.totals!.cardTakenCents).toBe(1100);
        expect(await accountNet(r.id, 'card_clearing', D)).toBe(1100);
        expect(await failuresAt(r.id)).toEqual([]);
      }
    });

    // The close starts a little later each round, so both orderings occur: simultaneous requests
    // alone returned 409 in every round of three runs.
    // Regression (same root as 1a): when the close reads the session after the count
    // committed but before the dispatcher ran, the drawer entry is stranded.
    it('close racing a count: no 5xx, a consistent snapshot, no stranded entry', async () => {
      const r = await newRestaurant();
      const t = await today(r.id);
      const outcomes: number[] = [];
      for (let i = 0; i < STAGGER_MS.length; i++) {
        const days = 70 + i;
        const D = await addDays(t, -days);
        const since = await dbNow();
        const s = await openSession(r.id, r.drawers[0]!, tokens.crew, 1000);
        await shift(r.id, days, since);
        await drain();
        const [counted, closed] = await Promise.all([
          countDrawer(r.id, tokens.crew, s.id, 900),
          sleep(STAGGER_MS[i]!).then(() => close(r.id, D, tokens.manager, h2.http)),
        ]);
        expect(counted.status).toBe(200);
        expect([200, 409]).toContain(closed.status);
        outcomes.push(closed.status);
        if (closed.status === 200) {
          const row = (closed.body as DayCloseView).drawers.find((d) => d.sessionId === s.id)!;
          expect(row).toMatchObject({ status: 'closed', countedCents: 900 });
        } else {
          await drain();
          expect((await close(r.id, D)).status).toBe(200);
        }
        await drain();
      }
      await exhaustRetries(r.id);
      console.log(`close racing count: close statuses ${outcomes.join(',')}`);
      expect((await failuresAt(r.id)).map((f) => f.event_type)).toEqual([]);
      expect(await accountNet(r.id, 'cash_over_short')).toBe(100 * STAGGER_MS.length);
    });

    // Regression (timing dependent, same root as 1a): as above for a variance approval.
    it('close racing a variance approval: no 5xx, a consistent snapshot, no stranded entry', async () => {
      const r = await newRestaurant();
      const t = await today(r.id);
      const outcomes: number[] = [];
      for (let i = 0; i < STAGGER_MS.length; i++) {
        const days = 80 + i;
        const D = await addDays(t, -days);
        const since = await dbNow();
        const s = await openSession(r.id, r.drawers[0]!, tokens.crew, 2000);
        await shift(r.id, days, since);
        await drain();
        expect((await countDrawer(r.id, tokens.crew, s.id, 1000)).body.status).toBe(
          'pending_approval',
        );
        expect(blockers(await view(r.id, D))).toEqual(['VARIANCE_PENDING']);
        const [approved, closed] = await Promise.all([
          approveVariance(r.id, tokens.manager2, s.id),
          sleep(STAGGER_MS[i]!).then(() => close(r.id, D, tokens.manager, h2.http)),
        ]);
        expect(approved.status).toBe(200);
        expect([200, 409]).toContain(closed.status);
        outcomes.push(closed.status);
        if (closed.status === 200) {
          const row = (closed.body as DayCloseView).drawers.find((d) => d.sessionId === s.id)!;
          expect(row.status).toBe('closed');
        } else {
          await drain();
          expect((await close(r.id, D)).status).toBe(200);
        }
        await drain();
      }
      await exhaustRetries(r.id);
      console.log(`close racing approval: close statuses ${outcomes.join(',')}`);
      expect((await failuresAt(r.id)).map((f) => f.event_type)).toEqual([]);
      expect(await accountNet(r.id, 'cash_over_short')).toBe(1000 * STAGGER_MS.length);
    });

    it('many closes across both instances: one wins, one row, one audit, one event', async () => {
      const r = await newRestaurant();
      const D = await addDays(await today(r.id), -60);
      const results = await Promise.all(
        [h, h2, h, h2, h, h2, h, h2].map((x) => close(r.id, D, tokens.manager, x.http)),
      );
      expect(results.map((x) => x.status).sort()).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
      for (const x of results.filter((y) => y.status === 409)) {
        expect(x.body.error.code).toBe('DAY_ALREADY_CLOSED');
      }
      const rows = await h.owner
        .selectFrom('business_day_closes')
        .select('id')
        .where('restaurant_id', '=', r.id)
        .execute();
      expect(rows).toHaveLength(1);
      const audits = await h.owner
        .selectFrom('audit_log')
        .select('action')
        .where('entity_id', '=', rows[0]!.id)
        .execute();
      expect(audits).toEqual([{ action: 'business_day.close' }]);
      const events = await h.owner
        .selectFrom('outbox_events')
        .select('event_type')
        .where('aggregate_id', '=', rows[0]!.id)
        .execute();
      expect(events).toEqual([{ event_type: 'business_day.closed' }]);
    });

    it('retire racing session opens: one side wins and no active session is on a retired drawer', async () => {
      const r = await newRestaurant();
      const openers = [tokens.crew, tokens.crew2, tokens.supervisor];
      for (let i = 0; i < 8; i++) {
        const code = `race-${i}`;
        const created = await h.http
          .post(`${api(r.id)}/cash/drawers`)
          .set(bearer(tokens.manager))
          .send({ code, name: `Race ${i}` })
          .expect(201);
        const drawer = (created.body as DrawerAdminView[]).find((d) => d.code === code)!;
        const [retire, ...opens] = await Promise.all([
          h2.http.post(`${api(r.id)}/cash/drawers/${drawer.id}/retire`).set(bearer(tokens.manager)),
          ...openers.map((t, j) =>
            (j % 2 ? h2 : h).http
              .post(`${api(r.id)}/cash/drawers/${drawer.id}/sessions`)
              .set(bearer(t))
              .send({ openingFloatCents: 100 }),
          ),
        ]);
        const row = await h.owner
          .selectFrom('cash_drawers')
          .select('active')
          .where('id', '=', drawer.id)
          .executeTakeFirstOrThrow();
        const active = await h.owner
          .selectFrom('drawer_sessions')
          .select(['id', 'opened_by'])
          .where('drawer_id', '=', drawer.id)
          .where('status', '<>', 'closed')
          .execute();
        const won = opens.filter((o) => o.status === 201);
        expect(opens.every((o) => [201, 404, 409].includes(o.status))).toBe(true);
        if (retire.status === 200) {
          expect({ row: row.active, won: won.length, active: active.length }).toEqual({
            row: false,
            won: 0,
            active: 0,
          });
        } else {
          expect(retire.status).toBe(409);
          expect(retire.body.error.code).toBe('DRAWER_IN_USE');
          expect({ row: row.active, won: won.length, active: active.length }).toEqual({
            row: true,
            won: 1,
            active: 1,
          });
          const winner = openers[opens.findIndex((o) => o.status === 201)]!;
          await countDrawer(r.id, winner, active[0]!.id, 100).expect(200);
        }
      }
      await drain();
      expect(await failuresAt(r.id)).toEqual([]);
    });

    it('creates of one code across instances: one wins, one row, one audit', async () => {
      const r = await newRestaurant();
      const results = await Promise.all(
        [h, h2, h, h2, h, h2].map((x, i) =>
          x.http
            .post(`${api(r.id)}/cash/drawers`)
            .set(bearer(tokens.manager))
            .send({ code: 'same-code', name: `Name ${i}` }),
        ),
      );
      expect(results.map((x) => x.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
      for (const x of results.filter((y) => y.status === 409)) {
        expect(x.body.error.code).toBe('DRAWER_CODE_TAKEN');
      }
      const rows = await h.owner
        .selectFrom('cash_drawers')
        .select('id')
        .where('restaurant_id', '=', r.id)
        .where('code', '=', 'same-code')
        .execute();
      expect(rows).toHaveLength(1);
      const audits = await h.owner
        .selectFrom('audit_log')
        .select('action')
        .where('entity_id', '=', rows[0]!.id)
        .execute();
      expect(audits).toEqual([{ action: 'drawer.create' }]);
    });
  });

  // --------------------------------------------------------------- 3. blockers

  describe('3. blockers', () => {
    it('an open drawer that appears after the preview still refuses the close', async () => {
      const r = await newRestaurant();
      const D = await addDays(await today(r.id), -60);
      expect(blockers(await view(r.id, D))).toEqual([]); // the stale read
      const since = await dbNow();
      const s = await openSession(r.id, r.drawers[0]!, tokens.crew, 1000);
      await shift(r.id, 60, since);
      await drain();
      const res = await close(r.id, D);
      expect(res.status).toBe(409);
      expect(res.body.error.details.blockers.map((b: { code: string }) => b.code)).toEqual([
        'DRAWERS_OPEN',
      ]);
      await countDrawer(r.id, tokens.crew, s.id, 1000).expect(200);
      await drain();
      expect((await close(r.id, D)).status).toBe(200);
    });

    it('a pending variance found after the preview refuses the close, and approval releases it', async () => {
      const r = await newRestaurant();
      const D = await addDays(await today(r.id), -60);
      const since = await dbNow();
      const s = await openSession(r.id, r.drawers[0]!, tokens.crew, 2000);
      await shift(r.id, 60, since);
      await drain();
      expect(blockers(await view(r.id, D))).toEqual(['DRAWERS_OPEN']);
      await countDrawer(r.id, tokens.crew, s.id, 1000).expect(200);
      const res = await close(r.id, D);
      expect(res.status).toBe(409);
      expect(res.body.error.details.blockers.map((b: { code: string }) => b.code)).toEqual([
        'VARIANCE_PENDING',
      ]);
      await approveVariance(r.id, tokens.manager2, s.id).expect(200);
      await drain();
      expect((await close(r.id, D)).status).toBe(200);
      expect(await accountNet(r.id, 'cash_over_short', D)).toBe(1000);
    });

    it('an unposted event found after the preview refuses the close', async () => {
      const r = await newRestaurant();
      const D = await addDays(await today(r.id), -60);
      expect(blockers(await view(r.id, D))).toEqual([]);
      const since = await dbNow();
      const o = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      await shift(r.id, 60, since);
      const res = await close(r.id, D);
      expect(res.status).toBe(409);
      expect(res.body.error.details.blockers.map((b: { code: string }) => b.code)).toEqual([
        'LEDGER_BEHIND',
      ]);
      await drain();
      expect((await close(r.id, D)).status).toBe(200);
    });

    it('a retrying event holds as LEDGER_BEHIND; dead-lettered it holds as LEDGER_FAILED; only its day', async () => {
      const r = await newRestaurant();
      const t = await today(r.id);
      const D = await addDays(t, -60);
      const before = await addDays(t, -61);
      expect(blockers(await view(r.id, D))).toEqual([]); // the stale read
      await insertEvent(r.id, 'payment.captured', randomUUID(), D);
      await dispatcher.runOnce();
      const failing = await failuresAt(r.id);
      expect(failing).toHaveLength(1);
      expect(failing[0]!.dead_at).toBeNull();
      expect(blockers(await view(r.id, D))).toEqual(['LEDGER_BEHIND']);

      await exhaustRetries(r.id);
      const dead = await failuresAt(r.id);
      expect(dead[0]!.attempts).toBe(MAX_ATTEMPTS);
      expect(dead[0]!.dead_at).not.toBeNull();
      expect(blockers(await view(r.id, D))).toEqual(['LEDGER_FAILED']);
      const res = await close(r.id, D);
      expect(res.status).toBe(409);
      expect(res.body.error.details.blockers[0].code).toBe('LEDGER_FAILED');
      expect(await reconciliation(r.id, D)).toMatchObject({
        reconciled: false,
        deadLetteredEvents: 1,
      });
      expect((await close(r.id, before)).status).toBe(200);
    });

    it('books that do not reconcile refuse the close', async () => {
      const r = await newRestaurant();
      const D = await addDays(await today(r.id), -60);
      const o = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      await drain();
      expect(blockers(await view(r.id, D))).toEqual([]); // the stale read
      const p = await paymentOf(o.id);
      await asOwnerRaw(async (tx) => {
        await sql`update payments set captured_at = ${noon(D)} where id = ${p.id}::uuid`.execute(
          tx,
        );
      });
      const res = await close(r.id, D);
      expect(res.status).toBe(409);
      expect(res.body.error.details.blockers.map((b: { code: string }) => b.code)).toEqual([
        'NOT_RECONCILED',
      ]);
    });

    // Regression (R-030): a missing card receipt plus a bogus cash receipt of the same amount used to
    // reconcile, because both credit Customer deposits. Each tender is now compared on its own.
    it('a day with offsetting errors between tenders does not reconcile or close', async () => {
      const r = await newRestaurant();
      const D = await addDays(await today(r.id), -60);
      const since = await dbNow();
      const o = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      await shift(r.id, 60, since);
      const p = await paymentOf(o.id);
      const ev = await h.owner
        .selectFrom('outbox_events')
        .select('id')
        .where('aggregate_id', '=', p.id)
        .where('event_type', '=', 'payment.captured')
        .executeTakeFirstOrThrow();
      await h.owner
        .insertInto('inbox_events')
        .values({ consumer: 'ledger', event_id: ev.id, org_id: orgId })
        .execute();
      await h.owner.transaction().execute(async (tx) => {
        const accounts = await tx
          .selectFrom('accounts')
          .select(['id', 'system_key'])
          .where('org_id', '=', orgId)
          .where('system_key', 'in', ['cash_on_hand', 'customer_deposits'])
          .execute();
        const account = (k: string) => accounts.find((a) => a.system_key === k)!.id;
        const entry = await tx
          .insertInto('journal_entries')
          .values({
            org_id: orgId,
            restaurant_id: r.id,
            business_date: D,
            entry_type: 'payment_receipt',
            source_type: 'test',
            source_id: randomUUID(),
            description: 'Offsetting error',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('journal_lines')
          .values([
            {
              org_id: orgId,
              entry_id: entry.id,
              account_id: account('cash_on_hand'),
              debit_cents: 1100,
              credit_cents: 0,
              memo: 'wrong',
            },
            {
              org_id: orgId,
              entry_id: entry.id,
              account_id: account('customer_deposits'),
              debit_cents: 0,
              credit_cents: 1100,
              memo: 'wrong',
            },
          ])
          .execute();
      });
      await drain();
      expect(await reconciliation(r.id, D)).toMatchObject({
        reconciled: false,
        capturedPaymentsCents: 1100,
        journalReceiptsCents: 1100, // the totals still agree...
        cardNetCents: 1100,
        journalCardClearingCents: 0, // ...but the card takings are missing
        cashNetCents: 0,
        journalCashOnHandCents: 1100, // and cash appears that nobody took
      });
      const refused = await close(r.id, D);
      expect(refused.status).toBe(409);
      expect(blockers(await view(r.id, D))).toContain('NOT_RECONCILED');
      expect(await accountNet(r.id, 'card_clearing')).toBe(0); // the card takings are missing
      expect(await accountNet(r.id, 'cash_on_hand')).toBe(1100); // cash nobody took
    });

    // Each tender is checked on its own: an extra line in a real card receipt that moves only one
    // tender, offset to an account no receipt check looks at, must still stop the day reconciling.
    for (const [tender, account] of [
      ['card', 'card_clearing'],
      ['cash', 'cash_on_hand'],
      ['cash rounding', 'cash_rounding'],
    ] as const) {
      it(`an error in ${tender} alone stops the day reconciling`, async () => {
        const r = await newRestaurant();
        const o = await ring(r.id, tokens.supervisor, ['burger']);
        await pay(r.id, tokens.supervisor, o.id, CARD);
        await drain();
        const day = await today(r.id);
        const clean = await reconciliation(r.id, day);
        expect(clean).toMatchObject({ unmatchedReceipts: 0, cardNetCents: 1100 });
        const p = await paymentOf(o.id);
        await asOwnerRaw(async (tx) => {
          const entry = await tx
            .selectFrom('journal_entries')
            .select('id')
            .where('source_id', '=', p.id)
            .where('entry_type', '=', 'payment_receipt')
            .executeTakeFirstOrThrow();
          const accounts = await tx
            .selectFrom('accounts')
            .select(['id', 'system_key'])
            .where('org_id', '=', orgId)
            .where('system_key', 'in', [account, 'sales_revenue'])
            .execute();
          const id = (k: string) => accounts.find((a) => a.system_key === k)!.id;
          await tx
            .insertInto('journal_lines')
            .values([
              {
                org_id: orgId,
                entry_id: entry.id,
                account_id: id(account),
                debit_cents: 5,
                credit_cents: 0,
                memo: 'stray',
              },
              {
                org_id: orgId,
                entry_id: entry.id,
                account_id: id('sales_revenue'),
                debit_cents: 0,
                credit_cents: 5,
                memo: 'stray',
              },
            ])
            .execute();
        });
        const rec = await reconciliation(r.id, day);
        expect(rec).toMatchObject({
          reconciled: false,
          unmatchedReceipts: 0,
          capturedPaymentsCents: clean.capturedPaymentsCents,
          journalReceiptsCents: clean.journalReceiptsCents,
          // A debit on cash rounding lowers its net credit.
          journalCashRoundingCents:
            clean.journalCashRoundingCents - (tender === 'cash rounding' ? 5 : 0),
          journalCardClearingCents: clean.journalCardClearingCents + (tender === 'card' ? 5 : 0),
          journalCashOnHandCents: clean.journalCashOnHandCents + (tender === 'cash' ? 5 : 0),
        });
      });
    }

    // Two real receipts wrong by equal and opposite amounts: totals and tenders agree, each entry does not.
    it('receipts with offsetting wrong amounts do not reconcile', async () => {
      const r = await newRestaurant();
      const payments: { id: string }[] = [];
      for (let i = 0; i < 2; i++) {
        const o = await ring(r.id, tokens.supervisor, ['burger']);
        await pay(r.id, tokens.supervisor, o.id, CARD);
        payments.push(await paymentOf(o.id));
      }
      await drain();
      const day = await today(r.id);
      expect(await reconciliation(r.id, day)).toMatchObject({ unmatchedReceipts: 0 });
      await asOwnerRaw(async (tx) => {
        const accounts = await tx
          .selectFrom('accounts')
          .select(['id', 'system_key'])
          .where('org_id', '=', orgId)
          .where('system_key', 'in', ['card_clearing', 'customer_deposits'])
          .execute();
        const id = (k: string) => accounts.find((a) => a.system_key === k)!.id;
        for (const [p, sign] of [
          [payments[0]!, 1],
          [payments[1]!, -1],
        ] as const) {
          const entry = await tx
            .selectFrom('journal_entries')
            .select('id')
            .where('source_id', '=', p.id)
            .where('entry_type', '=', 'payment_receipt')
            .executeTakeFirstOrThrow();
          await tx
            .insertInto('journal_lines')
            .values([
              {
                org_id: orgId,
                entry_id: entry.id,
                account_id: id(sign > 0 ? 'card_clearing' : 'customer_deposits'),
                debit_cents: 7,
                credit_cents: 0,
                memo: 'wrong',
              },
              {
                org_id: orgId,
                entry_id: entry.id,
                account_id: id(sign > 0 ? 'customer_deposits' : 'card_clearing'),
                debit_cents: 0,
                credit_cents: 7,
                memo: 'wrong',
              },
            ])
            .execute();
        }
      });
      const rec = await reconciliation(r.id, day);
      expect(rec).toMatchObject({ reconciled: false, unmatchedReceipts: 2 });
      expect(rec.journalReceiptsCents).toBe(rec.capturedPaymentsCents);
      expect(rec.journalCardClearingCents).toBe(rec.cardNetCents);
    });

    // Two real refund entries wrong by equal and opposite amounts: totals and tenders agree.
    it('refunds with offsetting wrong amounts do not reconcile', async () => {
      const r = await newRestaurant();
      const o = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      await finish(r.id, o.id);
      await drain();
      for (let i = 0; i < 2; i++) {
        const res = await refund(r.id, tokens.supervisor, o.id, {
          amountCents: 100,
          reason: 'quality',
        });
        expect(res.status).toBe(201);
      }
      await drain();
      const day = await today(r.id);
      expect(await reconciliation(r.id, day)).toMatchObject({
        reconciled: true,
        unmatchedRefunds: 0,
      });
      await asOwnerRaw(async (tx) => {
        const entries = await tx
          .selectFrom('journal_entries')
          .select('id')
          .where('restaurant_id', '=', r.id)
          .where('entry_type', '=', 'refund')
          .orderBy('id')
          .execute();
        expect(entries).toHaveLength(2);
        const accounts = await tx
          .selectFrom('accounts')
          .select(['id', 'system_key'])
          .where('org_id', '=', orgId)
          .where('system_key', 'in', ['card_clearing', 'sales_returns'])
          .execute();
        const id = (k: string) => accounts.find((a) => a.system_key === k)!.id;
        for (const [entry, sign] of [
          [entries[0]!, 1],
          [entries[1]!, -1],
        ] as const) {
          await tx
            .insertInto('journal_lines')
            .values([
              {
                org_id: orgId,
                entry_id: entry.id,
                account_id: id(sign > 0 ? 'sales_returns' : 'card_clearing'),
                debit_cents: 7,
                credit_cents: 0,
                memo: 'wrong',
              },
              {
                org_id: orgId,
                entry_id: entry.id,
                account_id: id(sign > 0 ? 'card_clearing' : 'sales_returns'),
                debit_cents: 0,
                credit_cents: 7,
                memo: 'wrong',
              },
            ])
            .execute();
        }
      });
      const rec = await reconciliation(r.id, day);
      expect(rec.journalRefundsCents).toBe(rec.refundsCents);
      expect(rec.journalCardClearingCents).toBe(rec.cardNetCents);
      expect(rec).toMatchObject({ reconciled: false, unmatchedRefunds: 2 });
    });

    // A refund whose entry never posted, hidden by an orphan refund entry of the same amount.
    it('a missing refund entry offset by an orphan one does not reconcile', async () => {
      const r = await newRestaurant();
      const o = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      await finish(r.id, o.id);
      await drain();
      const first = await refund(r.id, tokens.supervisor, o.id, {
        amountCents: 100,
        reason: 'quality',
      });
      expect(first.status).toBe(201);
      const missing = await h.owner
        .selectFrom('refunds')
        .select('id')
        .where('order_id', '=', o.id)
        .executeTakeFirstOrThrow();
      const ev = await h.owner
        .selectFrom('outbox_events')
        .select('id')
        .where('aggregate_id', '=', missing.id)
        .where('event_type', '=', 'payment.refunded')
        .executeTakeFirstOrThrow();
      // The ledger is told it handled this refund, so its entry never posts.
      await h.owner
        .insertInto('inbox_events')
        .values({ consumer: 'ledger', event_id: ev.id, org_id: orgId })
        .execute();
      expect(
        (await refund(r.id, tokens.supervisor, o.id, { amountCents: 100, reason: 'quality' }))
          .status,
      ).toBe(201);
      await drain();
      const day = await today(r.id);
      const before = await reconciliation(r.id, day);
      expect(before.reconciled).toBe(false); // the refund totals disagree on their own
      await h.owner.transaction().execute(async (tx) => {
        const model = await tx
          .selectFrom('journal_entries as e')
          .innerJoin('journal_lines as l', 'l.entry_id', 'e.id')
          .select(['l.account_id', 'l.debit_cents', 'l.credit_cents'])
          .where('e.restaurant_id', '=', r.id)
          .where('e.entry_type', '=', 'refund')
          .execute();
        const entry = await tx
          .insertInto('journal_entries')
          .values({
            org_id: orgId,
            restaurant_id: r.id,
            business_date: day,
            entry_type: 'refund',
            source_type: 'refund',
            source_id: randomUUID(),
            description: 'Orphan refund',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('journal_lines')
          .values(model.map((l) => ({ org_id: orgId, entry_id: entry.id, ...l, memo: 'orphan' })))
          .execute();
      });
      const rec = await reconciliation(r.id, day);
      expect(rec.journalRefundsCents).toBe(rec.refundsCents); // totals now agree...
      expect(rec.journalCardClearingCents).toBe(rec.cardNetCents);
      expect(rec).toMatchObject({ reconciled: false, unmatchedRefunds: 1 }); // ...the orphan does not
    });

    it('the boundary of the business date is exact', async () => {
      const r = await newRestaurant();
      const at = async (ts: string) =>
        (
          await sql<{
            d: string;
          }>`select app.business_date(${r.id}::uuid, ${ts}::timestamptz)::text as d`.execute(
            h.owner,
          )
        ).rows[0]!.d;
      expect(await at('2026-03-10 03:59:59.999999+00')).toBe('2026-03-09');
      expect(await at('2026-03-10 04:00:00+00')).toBe('2026-03-10');
    });

    it('the current business date cannot close either side of a moved cutoff or timezone', async () => {
      const r = await newRestaurant();
      const setCutoff = (expr: 'later' | 'earlier') =>
        sql`update restaurants set business_day_cutoff =
              ((now() at time zone 'UTC')::time ${
                expr === 'later' ? sql`+ interval '2 minutes'` : sql`- interval '10 minutes'`
              }) where id = ${r.id}::uuid`.execute(h.owner);
      const expected = async () =>
        (
          await sql<{ d: string }>`
            select ((now() at time zone timezone) - business_day_cutoff)::date::text as d
              from restaurants where id = ${r.id}::uuid`.execute(h.owner)
        ).rows[0]!.d;
      const original = await h.owner
        .selectFrom('restaurants')
        .select(['business_day_cutoff', 'timezone'])
        .where('id', '=', r.id)
        .executeTakeFirstOrThrow();
      try {
        // Just before the cutoff: yesterday is still the current day.
        await setCutoff('later');
        const before = await expected();
        expect((await view(r.id, before)).currentBusinessDate).toBe(before);
        expect(blockers(await view(r.id, before))).toContain('DAY_NOT_ENDED');
        expect((await close(r.id, before)).status).toBe(409);
        expect(blockers(await view(r.id, await addDays(before, -1)))).not.toContain(
          'DAY_NOT_ENDED',
        );

        // Just after it: that day has ended and can close, and the new one cannot.
        await setCutoff('earlier');
        const after = await expected();
        expect(after).toBe(await addDays(before, 1));
        expect(blockers(await view(r.id, after))).toContain('DAY_NOT_ENDED');
        expect((await close(r.id, after)).status).toBe(409);
        expect((await close(r.id, before)).status).toBe(200);

        // A timezone far ahead moves the current date forward; the server follows it.
        await h.owner
          .updateTable('restaurants')
          .set({ timezone: 'Pacific/Kiritimati' })
          .where('id', '=', r.id)
          .execute();
        const ahead = await expected();
        expect((await view(r.id, ahead)).currentBusinessDate).toBe(ahead);
        expect((await close(r.id, ahead)).status).toBe(409);
      } finally {
        await h.owner
          .updateTable('restaurants')
          .set({ business_day_cutoff: original.business_day_cutoff, timezone: original.timezone })
          .where('id', '=', r.id)
          .execute();
      }
    });

    // Regression: moving a cutoff or timezone can make a closed day current again. Everything then
    // posted was refused and dead-lettered. Only reachable by changing restaurant settings, which have
    // no API today (direct database change). Repro: close D just after the cutoff, move the cutoff
    // two minutes later so D is current again, take a card sale, dispatch.
    // Dates are recomputed from the live settings at app.business_date (0001_foundation.sql:109).
    it('a closed day that becomes current again through settings loses nothing', async () => {
      const r = await newRestaurant();
      const setCutoff = (dir: 'later' | 'earlier') =>
        sql`update restaurants set business_day_cutoff =
              ((now() at time zone 'UTC')::time ${
                dir === 'later' ? sql`+ interval '2 minutes'` : sql`- interval '10 minutes'`
              }) where id = ${r.id}::uuid`.execute(h.owner);
      await setCutoff('earlier');
      const D = await addDays(await today(r.id), -1);
      expect((await close(r.id, D)).status).toBe(200);
      await setCutoff('later');
      const current = (await view(r.id, D)).currentBusinessDate;
      const o = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, o.id, CARD);
      await dispatcher.runOnce();
      await exhaustRetries(r.id);
      // Changing settings can make a closed day current again (R-029). Nothing is lost: the
      // sale posts to the next open day.
      expect(current).toBe(D);
      expect((await failuresAt(r.id)).map((f) => f.event_type)).toEqual([]);
    });

    it('a future date cannot close', async () => {
      const r = await newRestaurant();
      for (const day of [await addDays(await today(r.id), 1), '2099-01-01', '9999-12-31']) {
        expect(blockers(await view(r.id, day))).toContain('DAY_NOT_ENDED');
        const res = await close(r.id, day);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('DAY_NOT_READY');
      }
    });

    // NOTE (accepted, R-029): a date before the restaurant existed can close, leaving a harmless empty
    // row. A real lower bound needs a trading-start date, which restaurants do not have yet.
    it('a date long before the restaurant existed closes with empty totals', async () => {
      const r = await newRestaurant();
      const res = await close(r.id, '2000-01-01');
      expect(res.status).toBe(200);
      expect(res.body.totals.netSalesCents).toBe(0);
    });

    it('impossible dates are refused on both routes and store nothing', async () => {
      const r = await newRestaurant();
      for (const bad of [
        '2026-02-30',
        '2026-02-29',
        '2026-13-01',
        '2026-00-10',
        '2026-1-1',
        '20260101',
        'today',
        '2026-01-01T00:00:00Z',
      ]) {
        expect(
          (await h.http.get(`${api(r.id)}/days/${bad}`).set(bearer(tokens.manager))).status,
        ).toBe(400);
        expect((await close(r.id, bad)).status).toBe(400);
      }
      const rows = await h.owner
        .selectFrom('business_day_closes')
        .select('id')
        .where('restaurant_id', '=', r.id)
        .execute();
      expect(rows).toEqual([]);
    });

    // Regression: year 0000 passes z.iso.date but PostgreSQL has no such date, so the request reaches the
    // database and fails there. Repro: GET /days/0000-06-15 and POST /days/0000-06-15/close.
    // day-close.controller.ts:9 and the same schema at accounting.controller.ts:19.
    it('year 0000 is a client error, not a server error', async () => {
      const r = await newRestaurant();
      const got = await h.http.get(`${api(r.id)}/days/0000-06-15`).set(bearer(tokens.manager));
      const posted = await close(r.id, '0000-06-15');
      expect({ get: got.status, post: posted.status }).toEqual({ get: 400, post: 400 });
    });
  });

  // ------------------------------------------------- 4. snapshot of a real day

  describe('4. a realistic day, compared with its source rows', () => {
    let r: Rest;
    let D: string;
    let closed: DayCloseView;
    let unfinished: string;
    let expectedCash: number;

    const n = (v: unknown) => Number(v ?? 0);

    beforeAll(async () => {
      r = await newRestaurant();
      await h.owner
        .updateTable('restaurants')
        .set({ cash_variance_threshold_cents: 100 })
        .where('id', '=', r.id)
        .execute();
      const t = await today(r.id);
      D = await addDays(t, -60);
      const since = await dbNow();
      const sup = tokens.supervisor;

      const receipt = await h.http
        .post(`${api(r.id)}/inventory/receipts`)
        .set(bearer(tokens.manager))
        .set('Idempotency-Key', randomUUID())
        .send({
          lines: [
            { inventoryItemId: skus.bun, quantity: '100' },
            { inventoryItemId: skus.cup, quantity: '50' },
          ],
        });
      expect(receipt.status).toBe(201);

      const session = await openSession(r.id, r.drawers[0]!, sup, 20_000);

      const a = await ring(r.id, sup, ['burger']); // card
      await pay(r.id, sup, a.id, CARD);
      await finish(r.id, a.id);

      const b = await ring(r.id, sup, ['odd']); // cash, rounded up 2c
      expect(b.cashDueCents).toBe(1105);
      await pay(r.id, sup, b.id, CASH);
      await finish(r.id, b.id);

      const c = await ring(r.id, sup, ['burger', 'cola']); // cash, 10% off, rounded down 2c
      const discounted = await h.http
        .post(`${api(r.id)}/orders/${c.id}/discount`)
        .set(bearer(sup))
        .set('Idempotency-Key', randomUUID())
        .send({ kind: 'percent', value: 1000, reason: 'customer_service' });
      expect(discounted.status).toBe(200);
      expect(discounted.body).toMatchObject({ totalCents: 1287, cashDueCents: 1285 });
      await pay(r.id, sup, c.id, CASH);
      await finish(r.id, c.id);

      const d = await ring(r.id, sup, ['cola']); // card, partly refunded
      await pay(r.id, sup, d.id, CARD);
      await finish(r.id, d.id);
      expect((await refund(r.id, sup, d.id, { amountCents: 100, reason: 'quality' })).status).toBe(
        201,
      );

      const e = await ring(r.id, sup, ['burger']); // cash, fully refunded
      await pay(r.id, sup, e.id, CASH);
      await finish(r.id, e.id);
      expect((await refund(r.id, sup, e.id, { reason: 'quality' })).status).toBe(201);

      const f = await ring(r.id, sup, ['burger']); // card, still unfinished at close
      await pay(r.id, sup, f.id, CARD);
      unfinished = f.id;

      const w = await recordWaste(r.id, tokens.crew, skus.bun, '2');
      expect(w.status).toBe(201);

      const { on_hand } = await h.owner
        .selectFrom('stock_balances as b')
        .innerJoin('stock_locations as l', 'l.id', 'b.location_id')
        .select('b.on_hand')
        .where('l.restaurant_id', '=', r.id)
        .where('b.inventory_item_id', '=', skus.bun)
        .executeTakeFirstOrThrow();
      const counted = await h.http
        .post(`${api(r.id)}/inventory/counts`)
        .set(bearer(tokens.manager))
        .set('Idempotency-Key', randomUUID())
        .send({
          lines: [{ inventoryItemId: skus.bun, counted: (Number(on_hand) - 1).toFixed(3) }],
        });
      expect(counted.status).toBe(201);

      expect((await movement(r.id, sup, session.id, 'safe_drop', 500)).status).toBe(201);
      expect((await movement(r.id, sup, session.id, 'paid_out', 300)).status).toBe(201);

      // float + (1105 + 1285 + 1100) cash in - 1100 refunded - 300 paid out - 500 dropped.
      expectedCash = 20_000 + 1105 + 1285 + 1100 - 1100 - 300 - 500;
      const count = await countDrawer(r.id, sup, session.id, expectedCash - 150);
      expect(count.body).toMatchObject({ status: 'pending_approval', varianceCents: -150 });
      await approveVariance(r.id, tokens.manager, session.id).expect(200);

      await shift(r.id, 60, since);
      await drain();
      expect(await failuresAt(r.id)).toEqual([]);
      const res = await close(r.id, D);
      expect(res.status).toBe(200);
      closed = res.body as DayCloseView;
    });

    it('totals equal values computed independently from source rows', async () => {
      const orders = await h.owner
        .selectFrom('orders')
        .select(['id', 'total_cents', 'tax_cents'])
        .where('restaurant_id', '=', r.id)
        .where('status', '=', 'completed')
        .execute();
      const refunds = await h.owner
        .selectFrom('refunds')
        .select([
          'order_id',
          'method',
          'amount_cents',
          'cash_rounding_cents',
          'refunded_before_cents',
        ])
        .where('restaurant_id', '=', r.id)
        .execute();
      const payments = await h.owner
        .selectFrom('payments')
        .select(['method', 'amount_cents', 'cash_rounding_cents'])
        .where('restaurant_id', '=', r.id)
        .where('captured_at', 'is not', null)
        .execute();
      const movementValue = async (type: string) =>
        Number(
          (
            await h.owner
              .selectFrom('stock_movements')
              .select(sql<string>`coalesce(sum(value_cents), 0)`.as('v'))
              .where('restaurant_id', '=', r.id)
              .where('movement_type', '=', type)
              .executeTakeFirstOrThrow()
          ).v,
        );
      // GST inside a refund: the order's GST pro rata, rounded half up on the running total.
      let refundGst = 0;
      for (const f of refunds) {
        const o = orders.find((x) => x.id === f.order_id)!;
        const share = (cents: number) => Math.floor((cents * o.tax_cents) / o.total_cents + 0.5);
        refundGst +=
          share(f.refunded_before_cents + f.amount_cents) - share(f.refunded_before_cents);
      }
      const refunded = refunds.reduce((s, f) => s + f.amount_cents, 0);
      const orderTax = orders.reduce((s, o) => s + o.tax_cents, 0);
      const orderNet = orders.reduce((s, o) => s + o.total_cents - o.tax_cents, 0);
      const taken = (m: string) =>
        payments
          .filter((p) => p.method === m)
          .reduce((s, p) => s + p.amount_cents + p.cash_rounding_cents, 0);
      const paidRounding = payments.reduce((s, p) => s + p.cash_rounding_cents, 0);
      const refundRounding = refunds.reduce((s, f) => s + f.cash_rounding_cents, 0);
      const cashRefunded = refunds
        .filter((f) => f.method === 'cash')
        .reduce((s, f) => s + f.amount_cents + f.cash_rounding_cents, 0);

      // Literal check of the arithmetic above: 100 + 100 + 117 + 30 + 100 GST on the five sales.
      expect(orderTax).toBe(447);
      expect(refundGst).toBe(9 + 100);
      expect(closed.totals).toEqual({
        netSalesCents: orderNet - (refunded - refundGst),
        gstCents: orderTax - refundGst,
        cashTakenCents: taken('cash'),
        cardTakenCents: taken('card'),
        cashRoundingCents: paidRounding - refundRounding,
        refundsCents: refunded,
        cashRefundsCents: cashRefunded,
        cogsCents: -(await movementValue('production_consumption')),
        wasteCents: -(await movementValue('waste_raw')),
        stockVarianceCents: -(await movementValue('count_adjustment')),
        transferShortageCents: 0, // this day has no transfers
        cashOverShortCents: 150,
        pettyCashCents: 300,
      });
      expect(closed.totals).toMatchObject({
        cashTakenCents: 1105 + 1285 + 1100,
        cardTakenCents: 1100 + 330 + 1100,
        refundsCents: 1200,
        cogsCents: 40 + 40 + 55 + 15 + 40, // the unfinished burger has not been started
        wasteCents: 80,
        stockVarianceCents: 40,
      });
    });

    it('the drawer row equals the count and the books hold no cash for the closed session', async () => {
      expect(closed.drawers).toHaveLength(1);
      expect(closed.drawers[0]).toMatchObject({
        status: 'closed',
        openingFloatCents: 20_000,
        expectedCents: expectedCash,
        countedCents: expectedCash - 150,
        varianceCents: -150,
      });
      expect(await accountNet(r.id, 'cash_on_hand', D)).toBe(0);
      // Rounding: +2 on the odd item and -2 on the discounted order net to zero.
      expect(await accountNet(r.id, 'cash_rounding', D)).toBe(0);
      expect(await accountNet(r.id, 'petty_cash', D)).toBe(300);
      expect(await accountNet(r.id, 'cash_over_short', D)).toBe(150);
    });

    it('the day is reconciled and warns about the unfinished order', async () => {
      expect(closed.warnings.map((w) => w.code)).toEqual(['ORDERS_UNFINISHED']);
      const rec = await reconciliation(r.id, D);
      expect(rec).toMatchObject({ reconciled: true, pendingEvents: 0, deadLetteredEvents: 0 });
      expect(rec.stockMovementsValueCents).toBe(rec.journalInventoryCents);
      const lines = await h.owner
        .selectFrom('journal_lines as l')
        .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
        .select(sql<string>`sum(l.debit_cents - l.credit_cents)`.as('net'))
        .where('e.restaurant_id', '=', r.id)
        .executeTakeFirstOrThrow();
      expect(n(lines.net)).toBe(0);
    });

    it('later activity does not alter the closed view, row or journal day', async () => {
      const entriesOnD = (await entries(r.id, D)).length;
      const stored = await h.owner
        .selectFrom('business_day_closes')
        .selectAll()
        .where('restaurant_id', '=', r.id)
        .where('business_date', '=', D)
        .executeTakeFirstOrThrow();

      await h.http
        .post(`${api(r.id)}/orders/${unfinished}/cancel`)
        .set(bearer(tokens.supervisor))
        .send({ reason: 'Adversarial later change' })
        .expect(200);
      expect(
        (await refund(r.id, tokens.supervisor, unfinished, { reason: 'cancelled_order' })).status,
      ).toBe(201);
      const s = await openSession(r.id, r.drawers[1]!, tokens.crew, 500);
      await countDrawer(r.id, tokens.crew, s.id, 500).expect(200);
      await drain();
      expect(await failuresAt(r.id)).toEqual([]);

      const after = await view(r.id, D);
      expect(after.totals).toEqual(closed.totals);
      expect(after.drawers).toEqual(closed.drawers);
      expect(after.warnings).toEqual(closed.warnings);
      expect(after.status).toBe('closed');
      expect((await entries(r.id, D)).length).toBe(entriesOnD);
      const unchanged = await h.owner
        .selectFrom('business_day_closes')
        .selectAll()
        .where('id', '=', stored.id)
        .executeTakeFirstOrThrow();
      expect(unchanged).toEqual(stored);
      // The auditor sees what the manager sees.
      expect((await view(r.id, D, tokens.auditor)).totals).toEqual(closed.totals);
    });
  });

  // ---------------------------------------------------------- 5. blind counting

  describe('5. blind counting', () => {
    const FLOAT = 10_000;
    const SALE = 1100;
    const EXPECTED = FLOAT + SALE;

    /** A single open session, run by the manager, with one cash sale. */
    const managerSession = async (r: Rest) => {
      const s = await openSession(r.id, r.drawers[0]!, tokens.manager, FLOAT);
      const o = await ring(r.id, tokens.manager, ['burger']);
      await pay(r.id, tokens.manager, o.id, CASH);
      await drain();
      return s;
    };

    it('no route here states expected cash while a session is open, for anyone allowed to call it', async () => {
      const r = await newRestaurant();
      const s = await managerSession(r);
      const t = await today(r.id);
      for (const token of [tokens.manager, tokens.manager2, tokens.auditor, tokens.area]) {
        const v = await view(r.id, t, token);
        const row = v.drawers.find((d) => d.sessionId === s.id)!;
        expect(row).toMatchObject({
          status: 'open',
          expectedCents: null,
          countedCents: null,
          varianceCents: null,
        });
        expect(JSON.stringify(v)).not.toContain(String(EXPECTED));
      }
      const all = await h.http
        .get(`${api(r.id)}/cash/drawers/all`)
        .set(bearer(tokens.manager))
        .expect(200);
      expect(JSON.stringify(all.body)).not.toContain(String(EXPECTED));
      for (const b of (await close(r.id, t)).body.error.details.blockers) {
        expect(b.message).not.toContain(String(EXPECTED));
      }
      // The drawer's own manager cashier stays blind on the session itself.
      const mine = await h.http
        .get(`${api(r.id)}/cash/sessions/${s.id}`)
        .set(bearer(tokens.manager))
        .expect(200);
      expect(mine.body.expected).toBeNull();
    });

    it('crew and supervisors cannot read the day at all, open or pending', async () => {
      const r = await newRestaurant();
      const t = await today(r.id);
      const s = await openSession(r.id, r.drawers[0]!, tokens.crew, 2000);
      for (const token of [tokens.crew, tokens.crew2, tokens.supervisor]) {
        expect((await h.http.get(`${api(r.id)}/days/${t}`).set(bearer(token))).status).toBe(403);
      }
      const counted = await countDrawer(r.id, tokens.crew, s.id, 1000);
      expect(counted.body.status).toBe('pending_approval');
      for (const token of [tokens.crew, tokens.crew2, tokens.supervisor]) {
        expect((await h.http.get(`${api(r.id)}/days/${t}`).set(bearer(token))).status).toBe(403);
      }
      // Counted: the figures are now part of the review, for those who review.
      const row = (await view(r.id, t)).drawers.find((d) => d.sessionId === s.id)!;
      expect(row).toMatchObject({
        status: 'pending_approval',
        expectedCents: 2000,
        countedCents: 1000,
        varianceCents: -1000,
      });
      await approveVariance(r.id, tokens.manager, s.id).expect(200);
      await drain();
    });

    // Product decision (R-028): department managers see live figures at any time, their own till
    // open or not. The drawer's own expected cash still stays hidden until it is counted.
    it("managers see the day's live totals even with their own till open; the drawer stays blind", async () => {
      const r = await newRestaurant();
      const s = await managerSession(r);
      const v = await view(r.id, await today(r.id), tokens.manager);
      const row = v.drawers.find((d) => d.sessionId === s.id)!;
      expect(row.expectedCents).toBeNull();
      expect(row.countedCents).toBeNull();
      expect(v.totals).not.toBeNull();
      expect(v.totals!.cashTakenCents).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------------ 6. access

  describe('6. access', () => {
    let central: string;
    let drive: string;
    let rival: string;
    let centralDrawer: string;
    let driveDrawer: string;
    let t: Record<
      'crew' | 'supervisor' | 'manager' | 'auditor' | 'inventory' | 'driveManager' | 'rivalManager',
      string
    >;
    const DAY = '2026-01-15';

    beforeAll(async () => {
      central = await restaurantId(h, CENTRAL);
      drive = await restaurantId(h, DRIVE);
      rival = await restaurantId(h, RIVAL);
      t = {
        crew: await login(h, 'crew1@central.kitchos.test'),
        supervisor: await login(h, 'supervisor@central.kitchos.test'),
        manager: await login(h, 'manager@central.kitchos.test'),
        auditor: await login(h, 'auditor@kitchos.test'),
        inventory: await login(h, 'inventory@kitchos.test'),
        driveManager: await login(h, 'manager@drive.kitchos.test'),
        rivalManager: await login(h, 'manager@rival.test'),
      };
      const drawerOf = async (rid: string) =>
        (
          await h.owner
            .selectFrom('cash_drawers')
            .select('id')
            .where('restaurant_id', '=', rid)
            .where('code', '=', 'till-4')
            .executeTakeFirstOrThrow()
        ).id;
      centralDrawer = await drawerOf(central);
      driveDrawer = await drawerOf(drive);
    });

    /** Every route, by name. None of these may succeed for the callers that use `denied`. */
    const call = (name: string, token: string, rid: string, drawerId: string) => {
      const a = api(rid);
      switch (name) {
        case 'view':
          return h.http.get(`${a}/days/${DAY}`).set(bearer(token));
        case 'close':
          return h.http.post(`${a}/days/${DAY}/close`).set(bearer(token)).send({});
        case 'list':
          return h.http.get(`${a}/cash/drawers/all`).set(bearer(token));
        case 'create':
          return h.http
            .post(`${a}/cash/drawers`)
            .set(bearer(token))
            .send({ code: 'dca-denied', name: 'Denied' });
        case 'retire':
          return h.http.post(`${a}/cash/drawers/${drawerId}/retire`).set(bearer(token));
        default:
          return h.http.post(`${a}/cash/drawers/${drawerId}/reactivate`).set(bearer(token));
      }
    };
    const ROUTES = ['view', 'close', 'list', 'create', 'retire', 'reactivate'];

    const assertUntouched = async () => {
      const closes = await h.owner
        .selectFrom('business_day_closes')
        .select('id')
        .where('restaurant_id', 'in', [central, drive])
        .where('business_date', '=', DAY)
        .execute();
      expect(closes).toEqual([]);
      const created = await h.owner
        .selectFrom('cash_drawers')
        .select('id')
        .where('code', '=', 'dca-denied')
        .execute();
      expect(created).toEqual([]);
      const active = await h.owner
        .selectFrom('cash_drawers')
        .select('active')
        .where('id', 'in', [centralDrawer, driveDrawer])
        .execute();
      expect(active.every((d) => d.active)).toBe(true);
    };

    it.each([
      ['crew', { view: 403, close: 403, list: 403, create: 403, retire: 403, reactivate: 403 }],
      [
        'supervisor',
        { view: 403, close: 403, list: 403, create: 403, retire: 403, reactivate: 403 },
      ],
      ['auditor', { view: 200, close: 403, list: 403, create: 403, retire: 403, reactivate: 403 }],
      [
        'inventory',
        { view: 403, close: 403, list: 403, create: 403, retire: 403, reactivate: 403 },
      ],
      [
        'driveManager',
        { view: 404, close: 404, list: 404, create: 404, retire: 404, reactivate: 404 },
      ],
      [
        'rivalManager',
        { view: 404, close: 404, list: 404, create: 404, retire: 404, reactivate: 404 },
      ],
    ] as const)('%s at Central', async (who, expected) => {
      const got: Record<string, number> = {};
      for (const route of ROUTES) {
        got[route] = (await call(route, t[who], central, centralDrawer)).status;
      }
      expect(got).toEqual(expected);
      await assertUntouched();
    });

    it('the Central manager may read here; writes are proved on a throwaway restaurant', async () => {
      expect((await call('view', t.manager, central, centralDrawer)).status).toBe(200);
      expect((await call('list', t.manager, central, centralDrawer)).status).toBe(200);
      const r = await newRestaurant();
      const res = await h.http
        .post(`${api(r.id)}/cash/drawers/${r.drawers[1]}/retire`)
        .set(bearer(tokens.manager));
      expect(res.status).toBe(200);
      expect((await close(r.id, DAY, tokens.manager)).status).toBe(200);
    });

    it('no token, a malformed id, and an unknown drawer', async () => {
      expect((await h.http.get(`${api(central)}/days/${DAY}`)).status).toBe(401);
      expect((await h.http.post(`${api(central)}/days/${DAY}/close`).send({})).status).toBe(401);
      expect((await h.http.get(`${api(central)}/cash/drawers/all`)).status).toBe(401);
      expect(
        (await h.http.post(`${api(central)}/cash/drawers/${centralDrawer}/retire`)).status,
      ).toBe(401);
      expect((await call('view', t.manager, 'not-a-uuid', centralDrawer)).status).toBe(404);
      expect((await call('retire', t.manager, central, 'not-a-uuid')).status).toBe(400);
      expect((await call('retire', t.manager, central, randomUUID())).status).toBe(404);
      await assertUntouched();
    });

    it("another restaurant's or tenant's drawer id in my path is a 404 and changes nothing", async () => {
      for (const route of ['retire', 'reactivate']) {
        // Central manager, Central path, Drive's drawer.
        expect((await call(route, t.manager, central, driveDrawer)).status).toBe(404);
        // Drive manager, Drive path, Central's drawer.
        expect((await call(route, t.driveManager, drive, centralDrawer)).status).toBe(404);
        // Rival manager, Rival path, Central's drawer.
        expect((await call(route, t.rivalManager, rival, centralDrawer)).status).toBe(404);
        // Central manager at Rival's path.
        expect((await call(route, t.manager, rival, centralDrawer)).status).toBe(404);
      }
      expect((await call('close', t.manager, drive, driveDrawer)).status).toBe(404);
      await assertUntouched();
    });

    describe('runtime role (RLS and grants)', () => {
      let r: Rest;
      let closeId: string;
      let rivalOrg: string;
      let demoOrg: string;
      let closerId: string;
      const D = '2026-01-20';

      beforeAll(async () => {
        r = await newRestaurant();
        expect((await close(r.id, D)).status).toBe(200);
        const row = await h.owner
          .selectFrom('business_day_closes')
          .select(['id', 'closed_by'])
          .where('restaurant_id', '=', r.id)
          .executeTakeFirstOrThrow();
        closeId = row.id;
        closerId = row.closed_by;
        const org = async (rid: string) =>
          (
            await h.owner
              .selectFrom('restaurants')
              .select('org_id')
              .where('id', '=', rid)
              .executeTakeFirstOrThrow()
          ).org_id;
        rivalOrg = await org(rival);
        demoOrg = await org(central);
      });

      const closeValues = (org: string, restaurant: string, closedBy: string, day: string) => ({
        org_id: org,
        restaurant_id: restaurant,
        business_date: day,
        closed_by: closedBy,
        totals: '{}',
        drawers: '[]',
        warnings: '[]',
      });

      it('another tenant cannot see a close; its own tenant can', async () => {
        for (const other of [rivalOrg, demoOrg]) {
          const seen = await withTenant(appDb, { orgId: other }, (tx) =>
            tx.selectFrom('business_day_closes').select('id').where('id', '=', closeId).execute(),
          );
          expect(seen).toEqual([]);
        }
        const mine = await withTenant(appDb, { orgId }, (tx) =>
          tx.selectFrom('business_day_closes').select('id').where('id', '=', closeId).execute(),
        );
        expect(mine).toEqual([{ id: closeId }]);
      });

      it('with no tenant set nothing is visible', async () => {
        const rows = await appDb
          .selectFrom('business_day_closes')
          .select('id')
          .execute()
          .catch(() => []);
        expect(rows).toEqual([]);
      });

      it('update and delete are denied by grant, even for the owning tenant', async () => {
        await expect(
          withTenant(appDb, { orgId }, (tx) =>
            tx
              .updateTable('business_day_closes')
              .set({ notes: 'rewritten' })
              .where('id', '=', closeId)
              .execute(),
          ),
        ).rejects.toThrow(/permission denied/);
        await expect(
          withTenant(appDb, { orgId }, (tx) =>
            tx.deleteFrom('business_day_closes').where('id', '=', closeId).execute(),
          ),
        ).rejects.toThrow(/permission denied/);
      });

      it('another tenant cannot write a close for a restaurant it does not own', async () => {
        const day = '2026-01-21';
        // Rival session claiming the throwaway org's identity: refused by the WITH CHECK.
        await expect(
          withTenant(appDb, { orgId: rivalOrg }, (tx) =>
            tx
              .insertInto('business_day_closes')
              .values(closeValues(orgId, r.id, closerId, day))
              .execute(),
          ),
        ).rejects.toThrow();
        // Rival org id with a foreign restaurant: refused by the composite foreign key.
        await expect(
          withTenant(appDb, { orgId: rivalOrg }, (tx) =>
            tx
              .insertInto('business_day_closes')
              .values(closeValues(rivalOrg, r.id, closerId, day))
              .execute(),
          ),
        ).rejects.toThrow();
        const rows = await h.owner
          .selectFrom('business_day_closes')
          .select('id')
          .where('restaurant_id', '=', r.id)
          .where('business_date', '=', day)
          .execute();
        expect(rows).toEqual([]);
      });

      it("a drawer's name and code cannot be changed by the runtime role, nor a drawer deleted", async () => {
        const id = r.drawers[0]!;
        for (const set of [{ name: 'Renamed' }, { code: 'renamed' }]) {
          await expect(
            withTenant(appDb, { orgId }, (tx) =>
              tx.updateTable('cash_drawers').set(set).where('id', '=', id).execute(),
            ),
          ).rejects.toThrow(/permission denied/);
        }
        await expect(
          withTenant(appDb, { orgId }, (tx) =>
            tx.deleteFrom('cash_drawers').where('id', '=', id).execute(),
          ),
        ).rejects.toThrow(/permission denied/);
        const row = await h.owner
          .selectFrom('cash_drawers')
          .select(['name', 'code'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        expect(row).toEqual({ name: 'Till 1', code: 'till-1' });
      });

      it("another tenant cannot retire or add a drawer in someone else's restaurant", async () => {
        const updated = await withTenant(appDb, { orgId: rivalOrg }, (tx) =>
          tx
            .updateTable('cash_drawers')
            .set({ active: false })
            .where('id', '=', centralDrawer)
            .executeTakeFirst(),
        );
        expect(Number(updated.numUpdatedRows)).toBe(0);
        await expect(
          withTenant(appDb, { orgId: rivalOrg }, (tx) =>
            tx
              .insertInto('cash_drawers')
              .values({
                org_id: demoOrg,
                restaurant_id: central,
                code: 'dca-rls',
                name: 'RLS',
              })
              .execute(),
          ),
        ).rejects.toThrow();
        await expect(
          withTenant(appDb, { orgId: rivalOrg }, (tx) =>
            tx
              .insertInto('cash_drawers')
              .values({
                org_id: rivalOrg,
                restaurant_id: central,
                code: 'dca-rls',
                name: 'RLS',
              })
              .execute(),
          ),
        ).rejects.toThrow();
        await assertUntouched();
      });
    });
  });

  it('afterwards: nothing was left failing at Central or Drive by this file', async () => {
    await drain();
    const central = await restaurantId(h, CENTRAL);
    const drive = await restaurantId(h, DRIVE);
    expect(await failuresAt(central)).toEqual([]);
    expect(await failuresAt(drive)).toEqual([]);
  });
});
