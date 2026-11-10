import { randomUUID } from 'node:crypto';
import type { DayCloseView, LedgerReconciliation } from '@kitchos/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/events/event-dispatcher.service.ts';
import { bearer, login, startHarness, type Harness } from './harness.ts';

/**
 * Adversarial tests for per-tender reconciliation (card clearing and cash on hand)
 * and its effect on business-day close.
 *
 * Correct days are built through the real API and must reconcile and close;
 * incorrect days are built the same way and then have their journal damaged
 * (an event marked consumed without posting, or an extra entry), and must not.
 *
 * Hygiene: everything runs in a throwaway organisation created here, with its own
 * restaurants. Only days at least 59 days back are closed. Every drawer session
 * opened is counted. No event is made to fail, so nothing dead-letters or retries;
 * the last test checks that.
 */
describe('per-tender reconciliation (adversarial)', () => {
  let h: Harness;
  let dispatcher: EventDispatcher;
  let orgId: string;
  let brandId: string;
  let regionId: string;
  let menuId: string;
  const items = {
    burger: '', // 1100
    cola: '', // 330, consumed at acceptance
    odd: '', // 1103 -> cash 1105 (up 2)
    p1101: '', // -> 1100 (down 1)
    p1102: '', // -> 1100 (down 2)
    p1104: '', // -> 1105 (up 1)
    mint: '', // 13 -> 15 (up 2)
    gum: '', // 12 -> 10 (down 2)
  };
  type Item = keyof typeof items;
  const tokens = { manager: '', supervisor: '', crew: '', crew2: '' };

  interface Rest {
    id: string;
    drawers: string[];
  }

  /** Cash due on a total: rounded half-up to 5c, computed here in integers, independently. */
  const r5 = (c: number) => Math.trunc((2 * c + 5) / 10) * 5;

  // ------------------------------------------------------------------ fixture

  const buildOrg = async () => {
    const tag = randomUUID().slice(0, 8);
    orgId = (
      await h.owner
        .insertInto('organisations')
        .values({ name: `Tender rec adversarial ${tag}`, slug: `tra-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await sql`select app.create_default_chart(${orgId}::uuid)`.execute(h.owner);
    brandId = (
      await h.owner
        .insertInto('brands')
        .values({ org_id: orgId, name: 'TRA', slug: `tra-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    regionId = (
      await h.owner
        .insertInto('regions')
        .values({ org_id: orgId, name: 'TRA region' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const bun = (
      await h.owner
        .insertInto('inventory_items')
        .values({
          org_id: orgId,
          sku: 'BUN',
          name: 'BUN',
          base_unit: 'each',
          category: 'ingredient',
          standard_unit_cost: '40',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const menu = await h.owner
      .insertInto('menus')
      .values({ org_id: orgId, brand_id: brandId, name: 'TRA menu' })
      .returning('id')
      .executeTakeFirstOrThrow();
    menuId = menu.id;
    const mv = await h.owner
      .insertInto('menu_versions')
      .values({ org_id: orgId, menu_id: menu.id, version: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const addItem = async (name: string, price: number, point: string) => {
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
        .values({ org_id: orgId, recipe_version_id: rv.id, inventory_item_id: bun, quantity: '1' })
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
    items.burger = await addItem('Burger', 1100, 'task_started');
    items.cola = await addItem('Cola', 330, 'order_accepted');
    items.odd = await addItem('Odd', 1103, 'task_started');
    items.p1101 = await addItem('P1101', 1101, 'task_started');
    items.p1102 = await addItem('P1102', 1102, 'task_started');
    items.p1104 = await addItem('P1104', 1104, 'task_started');
    items.mint = await addItem('Mint', 13, 'task_started');
    items.gum = await addItem('Gum', 12, 'task_started');
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
      supervisor: 'shift_supervisor',
      crew: 'crew_member',
      crew2: 'crew_member',
    };
    for (const [k, role] of Object.entries(roles) as [keyof typeof tokens, string][]) {
      const email = `${k}-${tag}@tra.test`;
      const user = await h.owner
        .insertInto('users')
        .values({ org_id: orgId, email, display_name: `TRA ${k}`, password_hash })
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
    const slug = `tra-${randomUUID().slice(0, 8)}`;
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
        [1, 2, 3].map((i) => ({
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
    return { id: r.id, drawers: drawers.map((d) => d.id) };
  };

  beforeAll(async () => {
    h = await startHarness();
    dispatcher = h.app.get(EventDispatcher);
    await buildOrg();
  });

  afterAll(async () => {
    await drain();
    await h.close();
  });

  // ------------------------------------------------------------------ helpers

  const api = (rid: string) => `/v1/restaurants/${rid}`;

  const drain = async () => {
    for (let i = 0; i < 30; i++) {
      const stats = await dispatcher.runOnce();
      if (stats.processed === 0) return;
    }
  };

  const asOwnerRaw = (fn: (tx: typeof h.owner) => Promise<void>) =>
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

  /** Moves everything recorded at this restaurant since `since` back by whole days (as day-close-adversarial). */
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
      await sql`update outbox_events set occurred_at = occurred_at - ${by}
                where restaurant_id = ${rid}::uuid and occurred_at >= ${since}`.execute(tx);
    });

  const noon = (day: string) => sql<Date>`((${day}::date + time '12:00') at time zone 'UTC')`;
  /** The instant a business day ends (default cutoff 04:00, UTC restaurant), offset by microseconds. */
  const cutoff = (nextDay: string, offsetMicros: number) =>
    sql<Date>`(((${nextDay}::date + time '04:00') at time zone 'UTC') + ${offsetMicros}::int * interval '1 microsecond')`;

  /** Re-times a source row and its event, before the ledger sees them. */
  const retime = (
    table: 'payments' | 'refunds',
    column: 'captured_at' | 'created_at',
    id: string,
    eventType: string,
    at: ReturnType<typeof noon>,
  ) =>
    asOwnerRaw(async (tx) => {
      await sql`update ${sql.table(table)} set ${sql.ref(column)} = ${at} where id = ${id}::uuid`.execute(
        tx,
      );
      await sql`update outbox_events set occurred_at = ${at}
                where event_type = ${eventType} and aggregate_id = ${id}::uuid`.execute(tx);
    });

  const rec = async (rid: string, day: string) =>
    (
      await h.http
        .get(`${api(rid)}/accounting/reconciliation?businessDate=${day}`)
        .set(bearer(tokens.manager))
        .expect(200)
    ).body as LedgerReconciliation;
  const tenders = (x: LedgerReconciliation) => ({
    reconciled: x.reconciled,
    cardNetCents: x.cardNetCents,
    journalCardClearingCents: x.journalCardClearingCents,
    cashNetCents: x.cashNetCents,
    journalCashOnHandCents: x.journalCashOnHandCents,
  });
  const view = async (rid: string, day: string) =>
    (
      await h.http
        .get(`${api(rid)}/days/${day}`)
        .set(bearer(tokens.manager))
        .expect(200)
    ).body as DayCloseView;
  const close = (rid: string, day: string) =>
    h.http
      .post(`${api(rid)}/days/${day}/close`)
      .set(bearer(tokens.manager))
      .send({});
  const blockers = (v: DayCloseView) => v.blockers.map((b) => b.code);

  const failuresInOrg = () =>
    h.owner
      .selectFrom('event_consumer_failures as f')
      .innerJoin('outbox_events as o', 'o.id', 'f.event_id')
      .select(['o.event_type', 'f.attempts', 'f.dead_at', 'f.last_error'])
      .where('o.org_id', '=', orgId)
      .execute();

  const entriesOf = (rid: string, sourceId: string) =>
    h.owner
      .selectFrom('journal_entries')
      .select([
        'entry_type',
        sql<string>`business_date::text`.as('day'),
        sql<string | null>`posted_late_from::text`.as('late'),
      ])
      .where('restaurant_id', '=', rid)
      .where('source_id', '=', sourceId)
      .orderBy('entry_type')
      .execute();

  // Staff flows, through the real API.

  const ring = async (rid: string, token: string, names: Item[]) => {
    const res = await h.http
      .post(`${api(rid)}/orders`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({
        fulfilmentType: 'dine_in',
        lines: names.map((n) => ({ menuItemId: items[n], quantity: 1 })),
      });
    if (res.status !== 201) throw new Error(`ring ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; totalCents: number; cashDueCents: number };
  };
  const payRaw = (rid: string, token: string, orderId: string, tender: object) =>
    h.http
      .post(`${api(rid)}/orders/${orderId}/payments`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send(tender);
  const pay = async (rid: string, token: string, orderId: string, tender: object) => {
    const res = await payRaw(rid, token, orderId, tender);
    if (res.status !== 200) throw new Error(`pay ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const CARD = { method: 'card', paymentToken: 'tok_sandbox_approve' };
  const DECLINE = { method: 'card', paymentToken: 'tok_sandbox_decline' };
  const CASH = { method: 'cash', tenderedCents: 5000 };
  const paymentOf = (orderId: string) =>
    h.owner
      .selectFrom('payments')
      .selectAll()
      .where('order_id', '=', orderId)
      .where('captured_at', 'is not', null)
      .executeTakeFirstOrThrow();
  const refundsOf = (orderId: string) =>
    h.owner
      .selectFrom('refunds')
      .selectAll()
      .where('order_id', '=', orderId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  const finish = async (rid: string, orderId: string) => {
    const tasks = await h.owner
      .selectFrom('kitchen_tasks')
      .select('id')
      .where('order_id', '=', orderId)
      .execute();
    for (const t of tasks) {
      await h.http
        .post(`${api(rid)}/kitchen/tasks/${t.id}/complete`)
        .set(bearer(tokens.supervisor))
        .send({})
        .expect(200);
    }
    await h.http
      .post(`${api(rid)}/orders/${orderId}/handoff`)
      .set(bearer(tokens.supervisor))
      .expect(200);
  };
  const discount = async (rid: string, orderId: string, body: object) => {
    const res = await h.http
      .post(`${api(rid)}/orders/${orderId}/discount`)
      .set(bearer(tokens.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send(body);
    if (res.status !== 200) throw new Error(`discount ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { totalCents: number; cashDueCents: number; status: string };
  };
  const cancel = (rid: string, orderId: string) =>
    h.http
      .post(`${api(rid)}/orders/${orderId}/cancel`)
      .set(bearer(tokens.supervisor))
      .send({ reason: 'Customer left' })
      .expect(200);
  const refund = async (rid: string, orderId: string, amountCents?: number) => {
    const res = await h.http
      .post(`${api(rid)}/orders/${orderId}/refunds`)
      .set(bearer(tokens.supervisor))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'quality', ...(amountCents ? { amountCents } : {}) });
    if (res.status !== 201) throw new Error(`refund ${res.status} ${JSON.stringify(res.body)}`);
  };
  const openSession = async (rid: string, drawerId: string, token: string, float: number) => {
    const res = await h.http
      .post(`${api(rid)}/cash/drawers/${drawerId}/sessions`)
      .set(bearer(token))
      .send({ openingFloatCents: float });
    if (res.status !== 201) throw new Error(`open ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  };
  /** Counts the drawer at the amount computed here; it must balance exactly. */
  const countExact = async (rid: string, token: string, sessionId: string, cents: number) => {
    const res = await h.http
      .post(`${api(rid)}/cash/sessions/${sessionId}/count`)
      .set(bearer(token))
      .set('Idempotency-Key', randomUUID())
      .send({ countedCents: cents });
    expect(res.status).toBe(200);
    expect({
      status: res.body.status,
      expected: res.body.expected.expectedCents,
      variance: res.body.varianceCents,
    }).toEqual({ status: 'closed', expected: cents, variance: 0 });
  };

  /** Marks the ledger as having consumed an event without posting it: the entry goes missing. */
  const skipLedger = async (eventType: string, aggregateId: string) => {
    const ev = await h.owner
      .selectFrom('outbox_events')
      .select('id')
      .where('aggregate_id', '=', aggregateId)
      .where('event_type', '=', eventType)
      .executeTakeFirstOrThrow();
    await h.owner
      .insertInto('inbox_events')
      .values({ consumer: 'ledger', event_id: ev.id, org_id: orgId })
      .execute();
  };
  /** Posts an extra, balanced entry straight into the journal: [account, debit, credit]. */
  const postEntry = (
    rid: string,
    day: string,
    entryType: 'payment_receipt' | 'refund',
    lines: [string, number, number][],
  ) =>
    h.owner.transaction().execute(async (tx) => {
      const accounts = await tx
        .selectFrom('accounts')
        .select(['id', 'system_key'])
        .where('org_id', '=', orgId)
        .where(
          'system_key',
          'in',
          lines.map((l) => l[0]),
        )
        .execute();
      const entry = await tx
        .insertInto('journal_entries')
        .values({
          org_id: orgId,
          restaurant_id: rid,
          business_date: day,
          entry_type: entryType,
          source_type: 'test',
          source_id: randomUUID(),
          description: 'Adversarial damage',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('journal_lines')
        .values(
          lines.map(([key, debit, credit]) => ({
            org_id: orgId,
            entry_id: entry.id,
            account_id: accounts.find((a) => a.system_key === key)!.id,
            debit_cents: debit,
            credit_cents: credit,
            memo: 'damage',
          })),
        )
        .execute();
    });

  // ------------------------------------------- 1. a correct two-day trading run

  describe('1. a realistic pair of days across three drawers and cashiers', () => {
    let r: Rest;
    let D1: string;
    let D2: string;
    const exp: Record<string, { card: number; cash: number }> = {};
    const declinedStatus: number[] = [];

    beforeAll(async () => {
      r = await newRestaurant();
      const t = await today(r.id);
      D1 = await addDays(t, -61);
      D2 = await addDays(t, -60);
      exp[D1] = { card: 0, cash: 0 };
      exp[D2] = { card: 0, cash: 0 };
      const e1 = exp[D1]!;
      const e2 = exp[D2]!;
      const sup = tokens.supervisor;

      // ---- Day 1
      const since1 = await dbNow();
      const s0 = await openSession(r.id, r.drawers[0]!, tokens.crew, 10_000);
      const s1 = await openSession(r.id, r.drawers[1]!, tokens.crew2, 10_000);
      const s2 = await openSession(r.id, r.drawers[2]!, sup, 20_000);
      const drawer = { s0: 10_000, s1: 10_000, s2: 20_000 };

      const cashSale = async (token: string, names: Item[], key: keyof typeof drawer) => {
        const o = await ring(r.id, token, names);
        await pay(r.id, token, o.id, CASH);
        await finish(r.id, o.id);
        drawer[key] += r5(o.totalCents);
        return o;
      };

      // crew, till 1: rounds up 2, rounds down 1; plus a card sale.
      const o1 = await cashSale(tokens.crew, ['odd'], 's0');
      const o2 = await cashSale(tokens.crew, ['p1101'], 's0');
      e1.cash += r5(1103) + r5(1101);
      const o3 = await ring(r.id, tokens.crew, ['burger']);
      await pay(r.id, tokens.crew, o3.id, CARD);
      await finish(r.id, o3.id);
      e1.card += 1100;

      // crew2, till 2: rounds down 2, up 1, a 10% discount (1287 -> 1285); a declined card then approval.
      await cashSale(tokens.crew2, ['p1102'], 's1');
      await cashSale(tokens.crew2, ['p1104'], 's1');
      const o6 = await ring(r.id, tokens.crew2, ['burger', 'cola']);
      const disc = await discount(r.id, o6.id, {
        kind: 'percent',
        value: 1000,
        reason: 'customer_service',
      });
      expect(disc).toMatchObject({ totalCents: 1287, cashDueCents: 1285 });
      await pay(r.id, tokens.crew2, o6.id, CASH);
      await finish(r.id, o6.id);
      drawer.s1 += 1285;
      e1.cash += r5(1102) + r5(1104) + 1285;
      const o7 = await ring(r.id, tokens.crew2, ['mint']);
      declinedStatus.push((await payRaw(r.id, tokens.crew2, o7.id, DECLINE)).status);
      declinedStatus.push((await payRaw(r.id, tokens.crew2, o7.id, DECLINE)).status);
      await pay(r.id, tokens.crew2, o7.id, CARD);
      await finish(r.id, o7.id);
      e1.card += 13;

      // supervisor, till 3: a comp, an amount discount, two cancellations, penny refunds.
      const comp = await ring(r.id, sup, ['burger']);
      const compView = await discount(r.id, comp.id, {
        kind: 'percent',
        value: 10_000,
        reason: 'complimentary',
      });
      expect(compView).toMatchObject({ totalCents: 0, status: 'accepted' });
      await finish(r.id, comp.id);

      const o9 = await ring(r.id, sup, ['burger']);
      expect(
        await discount(r.id, o9.id, { kind: 'amount', value: 3, reason: 'price_match' }),
      ).toMatchObject({ totalCents: 1097, cashDueCents: 1095 });
      await pay(r.id, sup, o9.id, CASH);
      await finish(r.id, o9.id);
      drawer.s2 += 1095;
      e1.cash += 1095;

      const o10 = await ring(r.id, sup, ['odd']); // card, cancelled, deposit released
      await pay(r.id, sup, o10.id, CARD);
      await cancel(r.id, o10.id);
      await refund(r.id, o10.id);
      e1.card += 1103 - 1103;

      const o11 = await ring(r.id, sup, ['odd']); // cash, cancelled, deposit released in cash
      await pay(r.id, sup, o11.id, CASH);
      await cancel(r.id, o11.id);
      await refund(r.id, o11.id);
      e1.cash += 1105 - 1105; // the customer gets back exactly what they handed over

      const o12 = await cashSale(sup, ['gum'], 's2'); // 12 -> 10 cash, refunded 1c at a time
      let gumBack = 0;
      for (let k = 1; k <= 12; k++) {
        await refund(r.id, o12.id, 1);
        gumBack = k === 12 ? 10 : Math.min(r5(k), 10);
      }
      drawer.s2 -= gumBack;
      e1.cash += 10 - gumBack;

      const o13 = await ring(r.id, sup, ['mint']); // card 13, 5 refunded today, 8 tomorrow
      await pay(r.id, sup, o13.id, CARD);
      await finish(r.id, o13.id);
      await refund(r.id, o13.id, 5);
      e1.card += 13 - 5;

      await countExact(r.id, tokens.crew, s0, drawer.s0);
      await countExact(r.id, tokens.crew2, s1, drawer.s1);
      await countExact(r.id, sup, s2, drawer.s2);
      await shift(r.id, 61, since1);

      // ---- Day 2: refunds of day-1 payments, plus a little trading.
      const since2 = await dbNow();
      const t0 = await openSession(r.id, r.drawers[0]!, tokens.crew, 5000);
      const t2 = await openSession(r.id, r.drawers[2]!, sup, 20_000);
      let till3 = 20_000;

      await refund(r.id, o3.id, 400); // card, captured yesterday
      e2.card -= 400;
      await refund(r.id, o1.id); // cash 1103 -> 1105 handed back
      till3 -= 1105;
      e2.cash -= 1105;
      // cash 1101 -> 1100: three pennies (0, 0, 5c back), then the rest (1095c back)
      for (const amount of [1, 1, 1, 1098]) {
        await refund(r.id, o2.id, amount);
      }
      const back = 0 + 0 + 5 + (1100 - 5);
      till3 -= back;
      e2.cash -= back;
      for (let k = 0; k < 8; k++) await refund(r.id, o13.id, 1); // card, to the cent
      e2.card -= 8;

      const o20 = await ring(r.id, tokens.crew, ['p1104']);
      await pay(r.id, tokens.crew, o20.id, CASH);
      await finish(r.id, o20.id);
      e2.cash += 1105;
      const o21 = await ring(r.id, tokens.crew, ['burger']);
      await pay(r.id, tokens.crew, o21.id, CARD);
      await finish(r.id, o21.id);
      await refund(r.id, o21.id, 1);
      e2.card += 1100 - 1;

      await countExact(r.id, tokens.crew, t0, 5000 + 1105);
      await countExact(r.id, sup, t2, till3);
      await shift(r.id, 60, since2);
      await drain();
    });

    it('declined cards are refused and leave no money behind', async () => {
      expect(declinedStatus).toEqual([402, 402]);
      const failed = await h.owner
        .selectFrom('payments')
        .select(['status', 'captured_at'])
        .where('restaurant_id', '=', r.id)
        .where('status', '=', 'failed')
        .execute();
      expect(failed).toHaveLength(2);
      expect(failed.every((f) => f.captured_at === null)).toBe(true);
    });

    it('each day reconciles per tender to the figures computed independently here', async () => {
      const got = { [D1]: tenders(await rec(r.id, D1)), [D2]: tenders(await rec(r.id, D2)) };
      expect(got).toEqual({
        [D1]: {
          reconciled: true,
          cardNetCents: exp[D1]!.card,
          journalCardClearingCents: exp[D1]!.card,
          cashNetCents: exp[D1]!.cash,
          journalCashOnHandCents: exp[D1]!.cash,
        },
        [D2]: {
          reconciled: true,
          cardNetCents: exp[D2]!.card,
          journalCardClearingCents: exp[D2]!.card,
          cashNetCents: exp[D2]!.cash,
          journalCashOnHandCents: exp[D2]!.cash,
        },
      });
      // Sanity of the hand computation: 6790 cash and 1121 card, then -1100 and 691.
      expect(exp).toEqual({ [D1]: { card: 1121, cash: 6790 }, [D2]: { card: 691, cash: -1100 } });
    });

    it('both days close, and the snapshot carries the same takings', async () => {
      expect(blockers(await view(r.id, D1))).toEqual([]);
      const c1 = await close(r.id, D1);
      expect(c1.status).toBe(200);
      const c2 = await close(r.id, D2);
      expect(c2.status).toBe(200);
      const t1 = (c1.body as DayCloseView).totals!;
      const t2 = (c2.body as DayCloseView).totals!;
      // Card takings and cash refunds as stored, against what was rung up.
      expect({
        card1: t1.cardTakenCents,
        cash1: t1.cashTakenCents - t1.cashRefundsCents,
        card2: t2.cardTakenCents,
        cash2: t2.cashTakenCents - t2.cashRefundsCents,
      }).toEqual({
        card1: 1100 + 13 + 1103 + 13,
        cash1: 6790,
        card2: 1100,
        cash2: -1100,
      });
    });
  });

  // ----------------------------------------------------- 2. the cutoff instant

  describe('2. payments and refunds either side of the cutoff, dispatched later', () => {
    let r: Rest;
    let D: string;
    let N: string;
    const ids: { [k: string]: string } = {};

    beforeAll(async () => {
      r = await newRestaurant();
      const t = await today(r.id);
      D = await addDays(t, -60);
      N = await addDays(t, -59);
      const since = await dbNow();
      const s = await openSession(r.id, r.drawers[0]!, tokens.supervisor, 5000);
      const a = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, a.id, CARD);
      await finish(r.id, a.id);
      const b = await ring(r.id, tokens.supervisor, ['odd']);
      await pay(r.id, tokens.supervisor, b.id, CASH);
      await finish(r.id, b.id);
      await refund(r.id, a.id, 300);
      await refund(r.id, b.id, 501); // 501 -> 500 handed back, rounding -1
      await countExact(r.id, tokens.supervisor, s, 5000 + 1105 - 500);
      await shift(r.id, 60, since);
      ids.payA = (await paymentOf(a.id)).id;
      ids.payB = (await paymentOf(b.id)).id;
      ids.refA = (await refundsOf(a.id))[0]!.id;
      ids.refB = (await refundsOf(b.id))[0]!.id;
      // Card payment and card refund in the last microsecond of D; cash ones at N's first instant.
      await retime('payments', 'captured_at', ids.payA, 'payment.captured', cutoff(N, -1));
      await retime('refunds', 'created_at', ids.refA, 'payment.refunded', cutoff(N, -1));
      await retime('payments', 'captured_at', ids.payB, 'payment.captured', cutoff(N, 0));
      await retime('refunds', 'created_at', ids.refB, 'payment.refunded', cutoff(N, 0));
    });

    it('D cannot close while its receipts are still to be posted', async () => {
      const res = await close(r.id, D);
      expect(res.status).toBe(409);
      expect(res.body.error.details.blockers.map((b: { code: string }) => b.code)).toContain(
        'LEDGER_BEHIND',
      );
      await drain();
    });

    it('each side of the cutoff reconciles on its own day and both close', async () => {
      expect({
        receiptA: await entriesOf(r.id, ids.payA!),
        refundA: await entriesOf(r.id, ids.refA!),
        receiptB: await entriesOf(r.id, ids.payB!),
        refundB: await entriesOf(r.id, ids.refB!),
      }).toEqual({
        receiptA: [{ entry_type: 'payment_receipt', day: D, late: null }],
        refundA: [{ entry_type: 'refund', day: D, late: null }],
        receiptB: [{ entry_type: 'payment_receipt', day: N, late: null }],
        refundB: [{ entry_type: 'refund', day: N, late: null }],
      });
      expect({ D: tenders(await rec(r.id, D)), N: tenders(await rec(r.id, N)) }).toEqual({
        D: {
          reconciled: true,
          cardNetCents: 800,
          journalCardClearingCents: 800,
          cashNetCents: 0,
          journalCashOnHandCents: 0,
        },
        N: {
          reconciled: true,
          cardNetCents: 0,
          journalCardClearingCents: 0,
          cashNetCents: 605,
          journalCashOnHandCents: 605,
        },
      });
      expect((await close(r.id, D)).status).toBe(200);
      expect((await close(r.id, N)).status).toBe(200);
    });
  });

  // ------------------------------------------------- 3. late entries (ADR-0017)

  describe('3. a day carrying late entries moved from a closed day', () => {
    let r: Rest;
    let D: string;
    let T: string;
    const ids: { [k: string]: string } = {};

    beforeAll(async () => {
      r = await newRestaurant();
      T = await today(r.id);
      D = await addDays(T, -60);
      expect((await close(r.id, D)).status).toBe(200);
      const s = await openSession(r.id, r.drawers[0]!, tokens.supervisor, 2000);
      // A: card sale and refund whose transactions began on D but committed after D closed.
      const a = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, a.id, CARD);
      await finish(r.id, a.id);
      await refund(r.id, a.id, 250);
      ids.payA = (await paymentOf(a.id)).id;
      ids.refA = (await refundsOf(a.id))[0]!.id;
      await retime('payments', 'captured_at', ids.payA, 'payment.captured', noon(D));
      await retime('refunds', 'created_at', ids.refA, 'payment.refunded', noon(D));
      // B: ordinary trading today, cash, with a 3c refund that hands back 5c.
      const b = await ring(r.id, tokens.supervisor, ['odd']);
      await pay(r.id, tokens.supervisor, b.id, CASH);
      await finish(r.id, b.id);
      await refund(r.id, b.id, 3);
      const c = await ring(r.id, tokens.supervisor, ['p1101']);
      await pay(r.id, tokens.supervisor, c.id, CARD);
      await finish(r.id, c.id);
      await countExact(r.id, tokens.supervisor, s, 2000 + 1105 - 5);
      await drain();
    });

    it('the late entries land on today, flagged with their own day', async () => {
      expect({
        receipt: await entriesOf(r.id, ids.payA!),
        refund: await entriesOf(r.id, ids.refA!),
      }).toEqual({
        receipt: [{ entry_type: 'payment_receipt', day: T, late: D }],
        refund: [{ entry_type: 'refund', day: T, late: D }],
      });
      expect((await view(r.id, T)).warnings.map((w) => w.code)).toContain('LATE_ENTRIES');
    });

    it("today reconciles per tender on today's own sources only", async () => {
      expect(tenders(await rec(r.id, T))).toEqual({
        reconciled: true,
        cardNetCents: 1101,
        journalCardClearingCents: 1101,
        cashNetCents: 1100,
        journalCashOnHandCents: 1100,
      });
    });

    it("the closed day's snapshot is untouched", async () => {
      const v = await view(r.id, D);
      expect(v.status).toBe('closed');
      expect(v.totals).toMatchObject({ cardTakenCents: 0, refundsCents: 0 });
    });
  });

  // -------------------------------------------------------- 4. incorrect days

  describe('4. incorrect days are caught and cannot close', () => {
    /** A day 60 back with one card sale (1100) and one cash sale (1103 -> 1105), each optionally refunded. */
    const day = async (opts: { refundCard?: number; refundCash?: number } = {}) => {
      const r = await newRestaurant();
      const D = await addDays(await today(r.id), -60);
      const since = await dbNow();
      const s = await openSession(r.id, r.drawers[0]!, tokens.supervisor, 3000);
      const card = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, card.id, CARD);
      await finish(r.id, card.id);
      const cash = await ring(r.id, tokens.supervisor, ['odd']);
      await pay(r.id, tokens.supervisor, cash.id, CASH);
      await finish(r.id, cash.id);
      let back = 0;
      if (opts.refundCard) await refund(r.id, card.id, opts.refundCard);
      if (opts.refundCash) {
        await refund(r.id, cash.id, opts.refundCash);
        back = opts.refundCash >= 1103 ? 1105 : Math.min(r5(opts.refundCash), 1105);
      }
      await countExact(r.id, tokens.supervisor, s, 3000 + 1105 - back);
      await shift(r.id, 60, since);
      return {
        r,
        D,
        card: (await paymentOf(card.id)).id,
        cash: (await paymentOf(cash.id)).id,
        cardRefund: (await refundsOf(card.id))[0]?.id,
        cashRefund: (await refundsOf(cash.id))[0]?.id,
        cardOrder: card.id,
      };
    };
    const refused = async (rid: string, D: string) => {
      const res = await close(rid, D);
      expect(res.status).toBe(409);
      expect(res.body.error.details.blockers.map((b: { code: string }) => b.code)).toEqual([
        'NOT_RECONCILED',
      ]);
    };

    it('control: the undamaged day reconciles and closes', async () => {
      const x = await day({ refundCard: 100, refundCash: 1103 });
      await drain();
      expect(tenders(await rec(x.r.id, x.D))).toEqual({
        reconciled: true,
        cardNetCents: 1000,
        journalCardClearingCents: 1000,
        cashNetCents: 0,
        journalCashOnHandCents: 0,
      });
      expect((await close(x.r.id, x.D)).status).toBe(200);
    });

    it('a missing card receipt', async () => {
      const x = await day();
      await skipLedger('payment.captured', x.card);
      await drain();
      expect(tenders(await rec(x.r.id, x.D))).toMatchObject({
        reconciled: false,
        cardNetCents: 1100,
        journalCardClearingCents: 0,
      });
      await refused(x.r.id, x.D);
    });

    it('a missing cash receipt', async () => {
      const x = await day();
      await skipLedger('payment.captured', x.cash);
      await drain();
      expect(tenders(await rec(x.r.id, x.D))).toMatchObject({
        reconciled: false,
        cashNetCents: 1105,
        journalCashOnHandCents: 0,
      });
      await refused(x.r.id, x.D);
    });

    it('a duplicated card receipt', async () => {
      const x = await day();
      await drain();
      await postEntry(x.r.id, x.D, 'payment_receipt', [
        ['card_clearing', 1100, 0],
        ['customer_deposits', 0, 1100],
      ]);
      expect(tenders(await rec(x.r.id, x.D))).toMatchObject({
        reconciled: false,
        cardNetCents: 1100,
        journalCardClearingCents: 2200,
      });
      await refused(x.r.id, x.D);
    });

    it('a cash receipt posted to card clearing', async () => {
      const x = await day();
      await skipLedger('payment.captured', x.cash);
      await drain();
      await postEntry(x.r.id, x.D, 'payment_receipt', [
        ['card_clearing', 1105, 0],
        ['customer_deposits', 0, 1103],
        ['cash_rounding', 0, 2],
      ]);
      expect(tenders(await rec(x.r.id, x.D))).toEqual({
        reconciled: false,
        cardNetCents: 1100,
        journalCardClearingCents: 2205,
        cashNetCents: 1105,
        journalCashOnHandCents: 0,
      });
      await refused(x.r.id, x.D);
    });

    it('cash rounding left out of the receipt', async () => {
      const x = await day();
      await skipLedger('payment.captured', x.cash);
      await drain();
      await postEntry(x.r.id, x.D, 'payment_receipt', [
        ['cash_on_hand', 1103, 0],
        ['customer_deposits', 0, 1103],
      ]);
      expect(tenders(await rec(x.r.id, x.D))).toMatchObject({
        reconciled: false,
        cashNetCents: 1105,
        journalCashOnHandCents: 1103,
      });
      await refused(x.r.id, x.D);
    });

    it('cash rounding posted the wrong way', async () => {
      const x = await day();
      await skipLedger('payment.captured', x.cash);
      await drain();
      await postEntry(x.r.id, x.D, 'payment_receipt', [
        ['cash_on_hand', 1101, 0],
        ['cash_rounding', 2, 0],
        ['customer_deposits', 0, 1103],
      ]);
      expect(tenders(await rec(x.r.id, x.D))).toMatchObject({
        reconciled: false,
        cashNetCents: 1105,
        journalCashOnHandCents: 1101,
      });
      await refused(x.r.id, x.D);
    });

    // Regression: cash rounding credited to the wrong account was not caught. The cash receipt
    // debits Cash on hand 1105 and credits Customer deposits 1103 correctly, but the 2c of
    // rounding goes to Sales revenue instead of Cash rounding. Nothing compares the Cash
    // rounding account with Σ payments.cash_rounding_cents (+ refunds), so the day reconciles
    // and closes, and its snapshot reports cashRoundingCents 0 against 2c actually rounded.
    // Repro: card+cash day, skip the cash receipt's ledger event, post the entry above.
    // reconciliation.service.ts:139-147 (no rounding comparison) and :156-166.
    it('cash rounding posted to the wrong account', async () => {
      const x = await day();
      await skipLedger('payment.captured', x.cash);
      await drain();
      await postEntry(x.r.id, x.D, 'payment_receipt', [
        ['cash_on_hand', 1105, 0],
        ['customer_deposits', 0, 1103],
        ['sales_revenue', 0, 2],
      ]);
      const got = await rec(x.r.id, x.D);
      const res = await close(x.r.id, x.D);
      expect({ reconciled: got.reconciled, close: res.status }).toEqual({
        reconciled: false,
        close: 409,
      });
    });

    it('a card refund posted to cash on hand', async () => {
      const x = await day({ refundCard: 300 });
      await skipLedger('payment.refunded', x.cardRefund!);
      await drain();
      await postEntry(x.r.id, x.D, 'refund', [
        ['sales_returns', 300, 0],
        ['cash_on_hand', 0, 300],
      ]);
      expect(tenders(await rec(x.r.id, x.D))).toEqual({
        reconciled: false,
        cardNetCents: 800,
        journalCardClearingCents: 1100,
        cashNetCents: 1105,
        journalCashOnHandCents: 805,
      });
      await refused(x.r.id, x.D);
    });

    it('a missing cash refund', async () => {
      const x = await day({ refundCash: 1103 });
      await skipLedger('payment.refunded', x.cashRefund!);
      await drain();
      expect(tenders(await rec(x.r.id, x.D))).toMatchObject({
        reconciled: false,
        cashNetCents: 0,
        journalCashOnHandCents: 1105,
      });
      await refused(x.r.id, x.D);
    });

    it('a cash refund with its rounding dropped', async () => {
      const x = await day({ refundCash: 3 }); // 3c refunded, 5c handed back
      await skipLedger('payment.refunded', x.cashRefund!);
      await drain();
      await postEntry(x.r.id, x.D, 'refund', [
        ['sales_returns', 3, 0],
        ['cash_on_hand', 0, 3],
      ]);
      expect(tenders(await rec(x.r.id, x.D))).toMatchObject({
        reconciled: false,
        cashNetCents: 1100,
        journalCashOnHandCents: 1102,
      });
      await refused(x.r.id, x.D);
    });

    it('a receipt posted to the following day breaks both days', async () => {
      const x = await day();
      const N = await addDays(x.D, 1);
      await skipLedger('payment.captured', x.card);
      await drain();
      await postEntry(x.r.id, N, 'payment_receipt', [
        ['card_clearing', 1100, 0],
        ['customer_deposits', 0, 1100],
      ]);
      expect((await rec(x.r.id, x.D)).reconciled).toBe(false);
      expect((await rec(x.r.id, N)).reconciled).toBe(false);
      await refused(x.r.id, x.D);
      await refused(x.r.id, N);
    });

    // Regression: a missing receipt and a duplicated receipt of the same tender and amount offset
    // each other. Card payments A and B of 1100 each: A's receipt is never posted, B's is posted
    // twice. Every total and both tenders agree (card 2200 vs 2200), so the day reconciles and
    // closes, though A has no receipt at all and B has two. This is the R-030 offsetting-error
    // class again, one level down: the check is per tender in aggregate, never per source.
    // Repro: two card sales, skip A's payment.captured, post a copy of B's receipt.
    // reconciliation.service.ts:31-43 and :140-143 (sums only; no per-payment receipt count).
    it('a missing receipt offset by a duplicated one of the same tender', async () => {
      const r = await newRestaurant();
      const D = await addDays(await today(r.id), -60);
      const since = await dbNow();
      const a = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, a.id, CARD);
      await finish(r.id, a.id);
      const b = await ring(r.id, tokens.supervisor, ['burger']);
      await pay(r.id, tokens.supervisor, b.id, CARD);
      await finish(r.id, b.id);
      await shift(r.id, 60, since);
      await skipLedger('payment.captured', (await paymentOf(a.id)).id);
      await drain();
      await postEntry(r.id, D, 'payment_receipt', [
        ['card_clearing', 1100, 0],
        ['customer_deposits', 0, 1100],
      ]);
      const got = await rec(r.id, D);
      const res = await close(r.id, D);
      expect({ reconciled: got.reconciled, close: res.status }).toEqual({
        reconciled: false,
        close: 409,
      });
    });

    // Regression: a late entry was reconciled nowhere. A receipt dated to a closed day moves to
    // today with posted_late_from set, today's totals leave it out, and the closed day is never
    // recomputed, so a stray receipt with no payment behind it passed. Late entries are now matched
    // to their source on the day they land, against the day they came from.
    // Repro: close D, insert a payment_receipt entry dated D with no payment, GET reconciliation for today.
    it('a stray receipt dated to a closed day is not reconciled anywhere', async () => {
      const r = await newRestaurant();
      const T = await today(r.id);
      const D = await addDays(T, -60);
      expect((await close(r.id, D)).status).toBe(200);
      await postEntry(r.id, D, 'payment_receipt', [
        ['card_clearing', 999, 0],
        ['customer_deposits', 0, 999],
      ]);
      const landed = await h.owner
        .selectFrom('journal_entries')
        .select([
          sql<string>`business_date::text`.as('day'),
          sql<string>`posted_late_from::text`.as('late'),
        ])
        .where('restaurant_id', '=', r.id)
        .execute();
      expect(landed).toEqual([{ day: T, late: D }]);
      const got = await rec(r.id, T);
      expect({ reconciled: got.reconciled, unmatched: got.unmatchedReceipts }).toEqual({
        reconciled: false,
        unmatched: 1,
      });
    });
  });

  // ----------------------------------------------------------------- hygiene

  it('hygiene: no failures, no dead letters, no open drawer sessions in this tenant', async () => {
    await drain();
    expect(await failuresInOrg()).toEqual([]);
    const open = await h.owner
      .selectFrom('drawer_sessions')
      .select('id')
      .where('org_id', '=', orgId)
      .where('status', '<>', 'closed')
      .execute();
    expect(open).toEqual([]);
  });
});
