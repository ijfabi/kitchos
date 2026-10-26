import { hash } from '@node-rs/argon2';
import { sql } from 'kysely';
import { createDb, type Database } from '../client.ts';
import {
  COMBOS,
  DEMO_PASSWORD,
  HEAD_OFFICE_STAFF,
  INVENTORY_ITEMS,
  MODIFIERS,
  PRODUCTS,
  RESTAURANTS,
  STANDARD_COSTS,
  type RestaurantSeed,
} from './catalog.ts';

export const DEMO_ORG_SLUG = 'kitchos-demo';
export const RIVAL_ORG_SLUG = 'rival-foods';

/**
 * Seeds the synthetic demo organisation (three restaurants) plus a second,
 * unrelated tenant used to prove cross-tenant isolation. Runs as the table
 * owner. Refuses to run twice; use `pnpm db:reset` to start over.
 */
export async function seedDemo(
  ownerUrl: string,
  log: (m: string) => void = console.log,
): Promise<void> {
  const { db } = createDb({ connectionString: ownerUrl, max: 2, applicationName: 'kitchos-seed' });
  try {
    const existing = await db
      .selectFrom('organisations')
      .select('id')
      .where('slug', '=', DEMO_ORG_SLUG)
      .executeTakeFirst();
    if (existing) {
      log('demo data already present; skipping (use db:reset to reseed)');
      return;
    }
    await db.transaction().execute(async (tx) => {
      await seedDemoOrg(tx, log);
      await seedRivalOrg(tx, log);
    });
    log('seed complete');
  } finally {
    await db.destroy();
  }
}

async function passwordHash(): Promise<string> {
  return hash(DEMO_PASSWORD);
}

async function seedDemoOrg(db: Database, log: (m: string) => void): Promise<void> {
  const org = await db
    .insertInto('organisations')
    .values({ name: 'KitchOS Demo Group', slug: DEMO_ORG_SLUG })
    .returning('id')
    .executeTakeFirstOrThrow();
  const orgId = org.id;
  const brand = await db
    .insertInto('brands')
    .values({ org_id: orgId, name: 'KitchOS', slug: 'kitchos' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const regionIds = new Map<string, string>();
  for (const name of ['Sydney CBD', 'Western Sydney']) {
    const r = await db
      .insertInto('regions')
      .values({ org_id: orgId, name })
      .returning('id')
      .executeTakeFirstOrThrow();
    regionIds.set(name, r.id);
  }

  // Inventory catalog
  const itemIds = new Map<string, string>();
  for (const item of INVENTORY_ITEMS) {
    const row = await db
      .insertInto('inventory_items')
      .values({
        org_id: orgId,
        sku: item.sku,
        name: item.name,
        base_unit: item.baseUnit,
        category: item.category,
        standard_unit_cost: STANDARD_COSTS[item.sku] ?? '0',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    itemIds.set(item.sku, row.id);
  }
  const itemId = (sku: string) => {
    const id = itemIds.get(sku);
    if (!id) throw new Error(`Unknown inventory SKU ${sku}`);
    return id;
  };

  // Products and published recipe versions
  const productIds = new Map<string, string>();
  const recipeVersionIds = new Map<string, string>();
  for (const p of PRODUCTS) {
    const product = await db
      .insertInto('products')
      .values({
        org_id: orgId,
        brand_id: brand.id,
        sku: p.sku,
        name: p.name,
        description: p.description,
        kind: p.kind,
        taxable: p.taxable ?? true,
        allergens: p.allergens,
        energy_kj: p.energyKj ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    productIds.set(p.sku, product.id);
    if (!p.recipe) continue;
    const recipe = await db
      .insertInto('recipes')
      .values({ org_id: orgId, product_id: product.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    const rv = await db
      .insertInto('recipe_versions')
      .values({
        org_id: orgId,
        recipe_id: recipe.id,
        version: 1,
        station_type: p.recipe.stationType,
        consumption_point: p.recipe.consumptionPoint,
        instructions: p.recipe.instructions,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('recipe_lines')
      .values(
        p.recipe.lines.map(([sku, quantity]) => ({
          org_id: orgId,
          recipe_version_id: rv.id,
          inventory_item_id: itemId(sku),
          quantity,
        })),
      )
      .execute();
    await db
      .updateTable('recipe_versions')
      .set({ status: 'published', published_at: sql<Date>`now()` })
      .where('id', '=', rv.id)
      .execute();
    recipeVersionIds.set(p.sku, rv.id);
  }
  const productId = (sku: string) => {
    const id = productIds.get(sku);
    if (!id) throw new Error(`Unknown product SKU ${sku}`);
    return id;
  };
  const recipeVersionId = (sku: string) => {
    const id = recipeVersionIds.get(sku);
    if (!id) throw new Error(`Product ${sku} has no recipe`);
    return id;
  };

  const hashed = await passwordHash();

  for (const r of RESTAURANTS) {
    const restaurantId = await seedRestaurant(db, {
      orgId,
      brandId: brand.id,
      regionId: regionIds.get(r.region)!,
      seed: r,
      itemId,
      productId,
      recipeVersionId,
    });
    for (const s of r.staff) {
      const user = await db
        .insertInto('users')
        .values({ org_id: orgId, email: s.email, display_name: s.name, password_hash: hashed })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('role_assignments')
        .values(
          s.roles.map((role) => ({
            org_id: orgId,
            user_id: user.id,
            role,
            scope_type: 'restaurant',
            scope_id: restaurantId,
          })),
        )
        .execute();
    }
    log(`seeded ${r.name}`);
  }

  for (const s of HEAD_OFFICE_STAFF) {
    const user = await db
      .insertInto('users')
      .values({ org_id: orgId, email: s.email, display_name: s.name, password_hash: hashed })
      .returning('id')
      .executeTakeFirstOrThrow();
    const scope =
      s.scope === 'organisation'
        ? { scope_type: 'organisation', scope_id: orgId }
        : { scope_type: 'region', scope_id: regionIds.get(s.scope)! };
    await db
      .insertInto('role_assignments')
      .values(s.roles.map((role) => ({ org_id: orgId, user_id: user.id, role, ...scope })))
      .execute();
  }
}

interface RestaurantSeedContext {
  orgId: string;
  brandId: string;
  regionId: string;
  seed: RestaurantSeed;
  itemId: (sku: string) => string;
  productId: (sku: string) => string;
  recipeVersionId: (sku: string) => string;
}

async function seedRestaurant(db: Database, c: RestaurantSeedContext): Promise<string> {
  const { orgId, seed: r } = c;
  const menu = await db
    .insertInto('menus')
    .values({ org_id: orgId, brand_id: c.brandId, name: r.menu.name })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mv = await db
    .insertInto('menu_versions')
    .values({ org_id: orgId, menu_id: menu.id, version: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();

  const productsNeedingModifiers = new Set<string>();
  for (const [index, [category, sku, priceCents]] of r.menu.items.entries()) {
    const isCombo = sku in COMBOS;
    const mi = await db
      .insertInto('menu_items')
      .values({
        org_id: orgId,
        menu_version_id: mv.id,
        product_id: c.productId(sku),
        category,
        display_order: index,
        price_cents: priceCents,
        recipe_version_id: isCombo ? null : c.recipeVersionId(sku),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (isCombo) {
      for (const [ci, [componentSku, qty]] of (COMBOS[sku] ?? []).entries()) {
        await db
          .insertInto('combo_components')
          .values({
            org_id: orgId,
            menu_item_id: mi.id,
            product_id: c.productId(componentSku),
            quantity: qty,
            recipe_version_id: c.recipeVersionId(componentSku),
            display_order: ci,
          })
          .execute();
        productsNeedingModifiers.add(componentSku);
      }
    } else {
      productsNeedingModifiers.add(sku);
    }
  }

  for (const sku of productsNeedingModifiers) {
    for (const [gi, group] of (MODIFIERS[sku] ?? []).entries()) {
      const g = await db
        .insertInto('modifier_groups')
        .values({
          org_id: orgId,
          menu_version_id: mv.id,
          product_id: c.productId(sku),
          name: group.name,
          min_select: group.minSelect,
          max_select: group.maxSelect,
          display_order: gi,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const [oi, option] of group.options.entries()) {
        const o = await db
          .insertInto('modifier_options')
          .values({
            org_id: orgId,
            modifier_group_id: g.id,
            name: option.name,
            price_delta_cents: option.priceDeltaCents,
            display_order: oi,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await db
          .insertInto('modifier_option_ingredients')
          .values(
            option.deltas.map(([itemSku, delta]) => ({
              org_id: orgId,
              modifier_option_id: o.id,
              inventory_item_id: c.itemId(itemSku),
              quantity_delta: delta,
            })),
          )
          .execute();
      }
    }
  }

  await db
    .updateTable('menu_versions')
    .set({ status: 'published', published_at: sql<Date>`now()` })
    .where('id', '=', mv.id)
    .execute();

  const restaurant = await db
    .insertInto('restaurants')
    .values({
      org_id: orgId,
      brand_id: c.brandId,
      region_id: c.regionId,
      menu_id: menu.id,
      name: r.name,
      slug: r.slug,
      ownership: r.ownership,
      timezone: r.timezone,
      stock_shortage_policy: r.shortagePolicy,
      address: r.address,
      opening_hours: JSON.stringify(r.openingHours),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db
    .insertInto('stations')
    .values(
      r.stations.map((s, i) => ({
        org_id: orgId,
        restaurant_id: restaurant.id,
        code: s.code,
        name: s.name,
        station_types: s.types,
        display_order: i,
      })),
    )
    .execute();

  const location = await db
    .insertInto('stock_locations')
    .values({
      org_id: orgId,
      restaurant_id: restaurant.id,
      code: 'main',
      name: 'Main store room',
      is_default: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  // Opening stock is recorded as receipts through the ledger, like any other movement.
  const openingId = crypto.randomUUID();
  const stockEntries = Object.entries(r.openingStock);
  if (stockEntries.length > 0) {
    await db
      .insertInto('stock_movements')
      .values(
        stockEntries.map(([sku, qty]) => ({
          org_id: orgId,
          restaurant_id: restaurant.id,
          location_id: location.id,
          inventory_item_id: c.itemId(sku),
          movement_type: 'receipt',
          quantity_delta: qty,
          source_type: 'opening_stock',
          source_id: openingId,
          occurred_at: sql<Date>`now()`,
          business_date: sql<string>`app.business_date(${restaurant.id}::uuid, now())`,
          notes: 'Seeded opening stock',
        })),
      )
      .execute();
  }

  await db
    .insertInto('restaurant_event_sequences')
    .values({ org_id: orgId, restaurant_id: restaurant.id })
    .execute();
  return restaurant.id;
}

/** A second tenant with a restaurant whose slug and data must never be reachable from the demo org. */
async function seedRivalOrg(db: Database, log: (m: string) => void): Promise<void> {
  const org = await db
    .insertInto('organisations')
    .values({ name: 'Rival Foods Pty Ltd', slug: RIVAL_ORG_SLUG })
    .returning('id')
    .executeTakeFirstOrThrow();
  const brand = await db
    .insertInto('brands')
    .values({ org_id: org.id, name: 'Rival Burgers', slug: 'rival-burgers' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const region = await db
    .insertInto('regions')
    .values({ org_id: org.id, name: 'Melbourne' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const item = await db
    .insertInto('inventory_items')
    .values({ org_id: org.id, sku: 'BUN', name: 'Bun', base_unit: 'each', category: 'ingredient' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const product = await db
    .insertInto('products')
    .values({
      org_id: org.id,
      brand_id: brand.id,
      sku: 'PLAIN-BURGER',
      name: 'Plain Burger',
      kind: 'item',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const recipe = await db
    .insertInto('recipes')
    .values({ org_id: org.id, product_id: product.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  const rv = await db
    .insertInto('recipe_versions')
    .values({
      org_id: org.id,
      recipe_id: recipe.id,
      version: 1,
      station_type: 'grill',
      consumption_point: 'task_started',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('recipe_lines')
    .values({ org_id: org.id, recipe_version_id: rv.id, inventory_item_id: item.id, quantity: '1' })
    .execute();
  await db
    .updateTable('recipe_versions')
    .set({ status: 'published', published_at: sql<Date>`now()` })
    .where('id', '=', rv.id)
    .execute();
  const menu = await db
    .insertInto('menus')
    .values({ org_id: org.id, brand_id: brand.id, name: 'Rival Menu' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mv = await db
    .insertInto('menu_versions')
    .values({ org_id: org.id, menu_id: menu.id, version: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('menu_items')
    .values({
      org_id: org.id,
      menu_version_id: mv.id,
      product_id: product.id,
      category: 'Burgers',
      price_cents: 900,
      recipe_version_id: rv.id,
    })
    .execute();
  await db
    .updateTable('menu_versions')
    .set({ status: 'published', published_at: sql<Date>`now()` })
    .where('id', '=', mv.id)
    .execute();
  const restaurant = await db
    .insertInto('restaurants')
    .values({
      org_id: org.id,
      brand_id: brand.id,
      region_id: region.id,
      menu_id: menu.id,
      name: 'Rival Burgers Southbank',
      slug: 'rival-southbank',
      ownership: 'company',
      timezone: 'Australia/Melbourne',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('stations')
    .values({
      org_id: org.id,
      restaurant_id: restaurant.id,
      code: 'grill',
      name: 'Grill',
      station_types: ['grill', 'expo'],
    })
    .execute();
  await db
    .insertInto('stock_locations')
    .values({
      org_id: org.id,
      restaurant_id: restaurant.id,
      code: 'main',
      name: 'Main',
      is_default: true,
    })
    .execute();
  await db
    .insertInto('restaurant_event_sequences')
    .values({ org_id: org.id, restaurant_id: restaurant.id })
    .execute();
  const user = await db
    .insertInto('users')
    .values({
      org_id: org.id,
      email: 'manager@rival.test',
      display_name: 'Rival Manager',
      password_hash: await passwordHash(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('role_assignments')
    .values({
      org_id: org.id,
      user_id: user.id,
      role: 'restaurant_manager',
      scope_type: 'restaurant',
      scope_id: restaurant.id,
    })
    .execute();
  log('seeded Rival Foods (isolation test tenant)');
}
