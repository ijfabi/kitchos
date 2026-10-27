import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { MenuItemView, MenuResponse, OrderLineInput, OrderView } from '@kitchos/contracts';
import { createDb, type Database } from '@kitchos/database';
import { sql } from 'kysely';
import request from 'supertest';
import { inject } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/create-app.ts';

export const PASSWORD = 'kitchos-demo-pass';

export interface Harness {
  app: INestApplication;
  http: ReturnType<typeof request>;
  /** Owner connection (bypasses RLS) for verifying persisted state and arranging fixtures. */
  owner: Database;
  close: () => Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const config = loadConfig({
    DATABASE_URL: inject('appUrl'),
    AUTH_JWT_SECRET: 'test-secret-that-is-at-least-32-characters',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    EVENT_DISPATCH_INTERVAL_MS: '0',
  });
  const created = await createApp(config);
  const { db: owner } = createDb({ connectionString: inject('ownerUrl'), max: 4 });
  return {
    app: created.app,
    http: request(created.app.getHttpServer()),
    owner,
    close: async () => {
      await created.close();
      await owner.destroy();
    },
  };
}

export async function login(h: Harness, email: string): Promise<string> {
  const res = await h.http.post('/v1/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200)
    throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken as string;
}

export async function restaurantId(h: Harness, slug: string): Promise<string> {
  const r = await h.owner
    .selectFrom('restaurants')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirstOrThrow();
  return r.id;
}

export async function getMenu(h: Harness, slug: string): Promise<MenuResponse> {
  const res = await h.http.get(`/v1/public/restaurants/${slug}/menu`).expect(200);
  return res.body as MenuResponse;
}

export function item(menu: MenuResponse, name: string): MenuItemView {
  const found = menu.items.find((i) => i.name === name);
  if (!found) throw new Error(`menu item ${name} not found`);
  return found;
}

export function option(
  menuItem: { modifierGroups: MenuItemView['modifierGroups'] },
  name: string,
): string {
  for (const g of menuItem.modifierGroups) {
    const o = g.options.find((x) => x.name === name);
    if (o) return o.id;
  }
  throw new Error(`modifier ${name} not found`);
}

export function placeOrder(
  h: Harness,
  slug: string,
  lines: OrderLineInput[],
  opts: { key?: string; fulfilmentType?: string; customerName?: string } = {},
) {
  return h.http
    .post(`/v1/public/restaurants/${slug}/orders`)
    .set('Idempotency-Key', opts.key ?? randomUUID())
    .send({
      fulfilmentType: opts.fulfilmentType ?? 'takeaway',
      customerName: opts.customerName ?? 'Test Guest',
      lines,
    });
}

export function pay(
  h: Harness,
  token: string,
  paymentToken = 'tok_sandbox_approve',
  key = randomUUID(),
) {
  return h.http
    .post(`/v1/public/orders/${token}/payments`)
    .set('Idempotency-Key', key)
    .send({ method: 'card', paymentToken });
}

export async function placeAndPay(
  h: Harness,
  slug: string,
  lines: OrderLineInput[],
): Promise<OrderView> {
  const placed = await placeOrder(h, slug, lines);
  if (placed.status !== 201)
    throw new Error(`place failed: ${placed.status} ${JSON.stringify(placed.body)}`);
  const paid = await pay(h, placed.body.publicToken);
  if (paid.status !== 200)
    throw new Error(`pay failed: ${paid.status} ${JSON.stringify(paid.body)}`);
  return paid.body as OrderView;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Consumption movements recorded against an order's lines, by SKU. */
export async function consumptionForOrder(h: Harness, orderId: string) {
  return h.owner
    .selectFrom('stock_movements as m')
    .innerJoin('order_lines as l', 'l.id', 'm.source_id')
    .innerJoin('inventory_items as i', 'i.id', 'm.inventory_item_id')
    .select(['i.sku', 'm.quantity_delta', 'm.source_id', 'l.name as line_name'])
    .where('l.order_id', '=', orderId)
    .where('m.source_type', '=', 'order_line')
    .where('m.movement_type', '=', 'production_consumption')
    .execute();
}

export async function balance(
  h: Harness,
  slug: string,
  sku: string,
): Promise<{ onHand: number; reserved: number }> {
  const row = await h.owner
    .selectFrom('stock_balances as b')
    .innerJoin('stock_locations as l', 'l.id', 'b.location_id')
    .innerJoin('restaurants as r', 'r.id', 'l.restaurant_id')
    .innerJoin('inventory_items as i', 'i.id', 'b.inventory_item_id')
    .select(['b.on_hand', 'b.reserved'])
    .where('r.slug', '=', slug)
    .where('i.sku', '=', sku)
    .executeTakeFirst();
  return { onHand: Number(row?.on_hand ?? 0), reserved: Number(row?.reserved ?? 0) };
}

/** Sets available stock (on hand − reserved) to exactly `available` via an audited count adjustment movement. */
export async function setAvailable(
  h: Harness,
  slug: string,
  sku: string,
  available: number,
): Promise<void> {
  const current = await balance(h, slug, sku);
  const delta = available - (current.onHand - current.reserved);
  if (delta === 0) return;
  const loc = await h.owner
    .selectFrom('stock_locations as l')
    .innerJoin('restaurants as r', 'r.id', 'l.restaurant_id')
    .select(['l.id', 'l.org_id', 'r.id as restaurant_id'])
    .where('r.slug', '=', slug)
    .where('l.is_default', '=', true)
    .executeTakeFirstOrThrow();
  const inv = await h.owner
    .selectFrom('inventory_items')
    .select('id')
    .where('org_id', '=', loc.org_id)
    .where('sku', '=', sku)
    .executeTakeFirstOrThrow();
  await h.owner
    .insertInto('stock_movements')
    .values({
      org_id: loc.org_id,
      restaurant_id: loc.restaurant_id,
      location_id: loc.id,
      inventory_item_id: inv.id,
      movement_type: 'count_adjustment',
      quantity_delta: String(delta),
      source_type: 'test_fixture',
      source_id: randomUUID(),
      occurred_at: sql<Date>`now()`,
      business_date: sql<string>`current_date`,
    })
    .execute();
}

/** Ledger reconciliation: every balance equals the sum of its movements and active reservations. */
export async function reconciliationErrors(h: Harness): Promise<unknown[]> {
  const { rows } = await sql<{ location_id: string; inventory_item_id: string }>`
    select b.location_id, b.inventory_item_id, b.on_hand, b.reserved
    from stock_balances b
    where b.on_hand <> coalesce((select sum(m.quantity_delta) from stock_movements m
                                 where m.location_id = b.location_id and m.inventory_item_id = b.inventory_item_id), 0)
       or b.reserved <> coalesce((select sum(r.quantity) from stock_reservations r
                                  where r.location_id = b.location_id and r.inventory_item_id = b.inventory_item_id
                                    and r.status = 'active'), 0)`.execute(h.owner);
  return rows;
}
