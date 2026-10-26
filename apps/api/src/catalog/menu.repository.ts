import { Injectable } from '@nestjs/common';
import type { Database, Tx } from '@kitchos/database';
import type { MenuItemView, ModifierGroupView } from '@kitchos/contracts';
import {
  parseDecimalQty,
  type ConsumptionPoint,
  type MenuCatalog,
  type MenuItemDef,
  type ModifierGroupDef,
  type RecipeDef,
} from '@kitchos/domain';
import { sql } from 'kysely';
import { notFound } from '../infra/http-errors.ts';

export interface RestaurantConfig {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  address: string | null;
  timezone: string;
  currency: string;
  taxRateBp: number;
  shortagePolicy: 'block' | 'allow_negative';
  openingHours: Record<string, [string, string]>;
  cashRoundingIncrementCents: number;
}

export interface LoadedMenu {
  restaurant: RestaurantConfig;
  catalog: MenuCatalog;
  items: MenuItemView[];
}

/** Resolves a public restaurant slug to its tenant without trusting any client-supplied tenant id. */
export async function resolvePublicRestaurant(
  db: Database,
  slug: string,
): Promise<{ restaurantId: string; orgId: string }> {
  const row = (
    await sql<{
      restaurant_id: string;
      org_id: string;
    }>`select * from app.lookup_restaurant(${slug})`.execute(db)
  ).rows[0];
  if (!row) throw notFound('Restaurant');
  return { restaurantId: row.restaurant_id, orgId: row.org_id };
}

@Injectable()
export class MenuRepository {
  async loadRestaurant(tx: Tx, restaurantId: string): Promise<RestaurantConfig> {
    const r = await tx
      .selectFrom('restaurants')
      .selectAll()
      .where('id', '=', restaurantId)
      .executeTakeFirst();
    if (!r) throw notFound('Restaurant');
    return {
      id: r.id,
      orgId: r.org_id,
      name: r.name,
      slug: r.slug,
      address: r.address,
      timezone: r.timezone,
      currency: r.currency,
      taxRateBp: r.tax_rate_bp,
      shortagePolicy: r.stock_shortage_policy as RestaurantConfig['shortagePolicy'],
      openingHours: r.opening_hours as Record<string, [string, string]>,
      cashRoundingIncrementCents: r.cash_rounding_increment_cents,
    };
  }

  /** Loads the restaurant's current published menu version with pinned recipes and modifiers. */
  async loadMenu(tx: Tx, restaurantId: string): Promise<LoadedMenu> {
    const restaurant = await this.loadRestaurant(tx, restaurantId);
    const menuRow = await tx
      .selectFrom('restaurants as r')
      .innerJoin('menu_versions as mv', 'mv.menu_id', 'r.menu_id')
      .select('mv.id')
      .where('r.id', '=', restaurantId)
      .where('mv.status', '=', 'published')
      .orderBy('mv.version', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!menuRow) throw notFound('Published menu');
    const menuVersionId = menuRow.id;

    const items = await tx
      .selectFrom('menu_items as mi')
      .innerJoin('products as p', 'p.id', 'mi.product_id')
      .select([
        'mi.id',
        'mi.product_id',
        'mi.category',
        'mi.display_order',
        'mi.price_cents',
        'mi.recipe_version_id',
        'p.name',
        'p.description',
        'p.kind',
        'p.taxable',
        'p.allergens',
        'p.energy_kj',
        'p.image_url',
      ])
      .where('mi.menu_version_id', '=', menuVersionId)
      .orderBy('mi.display_order')
      .execute();
    const itemIds = items.map((i) => i.id);
    const components = itemIds.length
      ? await tx
          .selectFrom('combo_components as cc')
          .innerJoin('products as p', 'p.id', 'cc.product_id')
          .select([
            'cc.id',
            'cc.menu_item_id',
            'cc.product_id',
            'cc.quantity',
            'cc.recipe_version_id',
            'cc.display_order',
            'p.name',
          ])
          .where('cc.menu_item_id', 'in', itemIds)
          .orderBy('cc.display_order')
          .execute()
      : [];

    const recipeVersionIds = [
      ...new Set(
        [
          ...items.map((i) => i.recipe_version_id),
          ...components.map((c) => c.recipe_version_id),
        ].filter((x): x is string => !!x),
      ),
    ];
    const recipeVersions = recipeVersionIds.length
      ? await tx
          .selectFrom('recipe_versions')
          .select(['id', 'station_type', 'consumption_point'])
          .where('id', 'in', recipeVersionIds)
          .execute()
      : [];
    const recipeLines = recipeVersionIds.length
      ? await tx
          .selectFrom('recipe_lines')
          .select(['recipe_version_id', 'inventory_item_id', 'quantity'])
          .where('recipe_version_id', 'in', recipeVersionIds)
          .execute()
      : [];
    const recipes = new Map<string, RecipeDef>(
      recipeVersions.map((rv) => [
        rv.id,
        {
          recipeVersionId: rv.id,
          stationType: rv.station_type,
          consumptionPoint: rv.consumption_point as ConsumptionPoint,
          ingredients: recipeLines
            .filter((l) => l.recipe_version_id === rv.id)
            .map((l) => ({
              inventoryItemId: l.inventory_item_id,
              quantityMilli: parseDecimalQty(l.quantity),
            })),
        },
      ]),
    );
    const recipe = (id: string | null): RecipeDef => {
      const r = id ? recipes.get(id) : undefined;
      if (!r) throw new Error(`Menu ${menuVersionId} references missing recipe version ${id}`);
      return r;
    };

    const groups = await tx
      .selectFrom('modifier_groups')
      .select(['id', 'product_id', 'name', 'min_select', 'max_select'])
      .where('menu_version_id', '=', menuVersionId)
      .orderBy('display_order')
      .execute();
    const groupIds = groups.map((g) => g.id);
    const options = groupIds.length
      ? await tx
          .selectFrom('modifier_options')
          .select(['id', 'modifier_group_id', 'name', 'price_delta_cents'])
          .where('modifier_group_id', 'in', groupIds)
          .orderBy('display_order')
          .execute()
      : [];
    const optionIds = options.map((o) => o.id);
    const optionIngredients = optionIds.length
      ? await tx
          .selectFrom('modifier_option_ingredients')
          .select(['modifier_option_id', 'inventory_item_id', 'quantity_delta'])
          .where('modifier_option_id', 'in', optionIds)
          .execute()
      : [];
    const groupsByProduct = new Map<string, ModifierGroupDef[]>();
    for (const g of groups) {
      const def: ModifierGroupDef = {
        id: g.id,
        name: g.name,
        minSelect: g.min_select,
        maxSelect: g.max_select,
        options: options
          .filter((o) => o.modifier_group_id === g.id)
          .map((o) => ({
            id: o.id,
            name: o.name,
            priceDeltaCents: o.price_delta_cents,
            ingredientDeltas: optionIngredients
              .filter((oi) => oi.modifier_option_id === o.id)
              .map((oi) => ({
                inventoryItemId: oi.inventory_item_id,
                quantityMilli: parseDecimalQty(oi.quantity_delta),
              })),
          })),
      };
      groupsByProduct.set(g.product_id, [...(groupsByProduct.get(g.product_id) ?? []), def]);
    }

    const unavailable = new Set(
      (
        await tx
          .selectFrom('product_availability')
          .select('product_id')
          .where('restaurant_id', '=', restaurantId)
          .where('available', '=', false)
          .execute()
      ).map((a) => a.product_id),
    );

    const defs: MenuItemDef[] = [];
    const views: MenuItemView[] = [];
    for (const i of items) {
      const modifierGroups = groupsByProduct.get(i.product_id) ?? [];
      const base = {
        menuItemId: i.id,
        productId: i.product_id,
        name: i.name,
        priceCents: i.price_cents,
        taxable: i.taxable,
        modifierGroups,
      };
      let def: MenuItemDef;
      if (i.kind === 'combo') {
        const comps = components.filter((c) => c.menu_item_id === i.id);
        def = {
          ...base,
          kind: 'combo',
          available:
            !unavailable.has(i.product_id) && comps.every((c) => !unavailable.has(c.product_id)),
          components: comps.map((c) => ({
            id: c.id,
            productId: c.product_id,
            name: c.name,
            quantity: c.quantity,
            recipe: recipe(c.recipe_version_id),
            modifierGroups: groupsByProduct.get(c.product_id) ?? [],
          })),
        };
      } else {
        def = {
          ...base,
          kind: 'item',
          available: !unavailable.has(i.product_id),
          recipe: recipe(i.recipe_version_id),
        };
      }
      defs.push(def);
      views.push({
        id: i.id,
        productId: i.product_id,
        name: i.name,
        description: i.description,
        category: i.category,
        kind: def.kind,
        priceCents: i.price_cents,
        available: def.available,
        allergens: i.allergens,
        energyKj: i.energy_kj,
        imageUrl: i.image_url,
        modifierGroups: modifierGroups.map(toGroupView),
        components:
          def.kind === 'combo'
            ? def.components.map((c) => ({
                id: c.id,
                name: c.name,
                quantity: c.quantity,
                modifierGroups: c.modifierGroups.map(toGroupView),
              }))
            : [],
      });
    }

    return {
      restaurant,
      catalog: { menuVersionId, items: new Map(defs.map((d) => [d.menuItemId, d])) },
      items: views,
    };
  }
}

function toGroupView(g: ModifierGroupDef): ModifierGroupView {
  return {
    id: g.id,
    name: g.name,
    minSelect: g.minSelect,
    maxSelect: g.maxSelect,
    options: g.options.map((o) => ({ id: o.id, name: o.name, priceDeltaCents: o.priceDeltaCents })),
  };
}
