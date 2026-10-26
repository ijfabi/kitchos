import { DomainError } from './errors.ts';
import { addCents, cents, inclusiveTax, mulCents, type Cents } from './money.ts';
import { milli, type MilliQty } from './quantity.ts';

/** When a producible line physically consumes its ingredients. Configurable per recipe version. */
export const CONSUMPTION_POINTS = ['order_accepted', 'task_started', 'task_completed'] as const;
export type ConsumptionPoint = (typeof CONSUMPTION_POINTS)[number];

export interface IngredientQty {
  readonly inventoryItemId: string;
  /** Milli-units of the inventory item's base unit. Negative only for modifier deltas. */
  readonly quantityMilli: number;
}

export interface RecipeDef {
  readonly recipeVersionId: string;
  readonly stationType: string;
  readonly consumptionPoint: ConsumptionPoint;
  readonly ingredients: readonly IngredientQty[];
}

export interface ModifierOptionDef {
  readonly id: string;
  readonly name: string;
  readonly priceDeltaCents: number;
  /** Signed deltas applied per unit: +1 cheese slice, -15 g onion. */
  readonly ingredientDeltas: readonly IngredientQty[];
}

export interface ModifierGroupDef {
  readonly id: string;
  readonly name: string;
  readonly minSelect: number;
  readonly maxSelect: number;
  readonly options: readonly ModifierOptionDef[];
}

export interface ComboComponentDef {
  readonly id: string;
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly recipe: RecipeDef;
  readonly modifierGroups: readonly ModifierGroupDef[];
}

interface MenuItemBase {
  readonly menuItemId: string;
  readonly productId: string;
  readonly name: string;
  readonly priceCents: number;
  readonly taxable: boolean;
  readonly available: boolean;
  readonly modifierGroups: readonly ModifierGroupDef[];
}

export interface SimpleMenuItemDef extends MenuItemBase {
  readonly kind: 'item';
  readonly recipe: RecipeDef;
}

export interface ComboMenuItemDef extends MenuItemBase {
  readonly kind: 'combo';
  readonly components: readonly ComboComponentDef[];
}

export type MenuItemDef = SimpleMenuItemDef | ComboMenuItemDef;

/** The effective, immutable published menu version for one restaurant. */
export interface MenuCatalog {
  readonly menuVersionId: string;
  readonly items: ReadonlyMap<string, MenuItemDef>;
}

export interface OrderLineRequest {
  readonly menuItemId: string;
  readonly quantity: number;
  readonly modifierOptionIds?: readonly string[];
  readonly components?: readonly { componentId: string; modifierOptionIds: readonly string[] }[];
}

export interface PricedModifier {
  readonly optionId: string;
  readonly name: string;
  readonly priceDeltaCents: Cents;
}

/** Everything the kitchen and inventory need for one producible unit of work. */
export interface ProductionSpec {
  readonly productId: string;
  readonly recipeVersionId: string;
  readonly stationType: string;
  readonly consumptionPoint: ConsumptionPoint;
  /** Total requirement for the whole line (already x quantity), one entry per item, all > 0, sorted by id. */
  readonly ingredients: readonly { inventoryItemId: string; quantityMilli: MilliQty }[];
}

export interface PricedComponent {
  readonly componentId: string;
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly modifiers: readonly PricedModifier[];
  readonly production: ProductionSpec;
}

export interface PricedLine {
  readonly lineNo: number;
  readonly menuItemId: string;
  readonly productId: string;
  readonly name: string;
  readonly kind: 'item' | 'combo';
  readonly quantity: number;
  readonly unitPriceCents: Cents;
  readonly lineTotalCents: Cents;
  readonly taxable: boolean;
  readonly modifiers: readonly PricedModifier[];
  /** Present for simple items; combos are produced through their components. */
  readonly production: ProductionSpec | null;
  readonly components: readonly PricedComponent[];
}

export interface PricedOrder {
  readonly menuVersionId: string;
  readonly lines: readonly PricedLine[];
  readonly subtotalCents: Cents;
  readonly discountCents: Cents;
  readonly totalCents: Cents;
  /** Tax contained within the (tax-inclusive) total. */
  readonly taxCents: Cents;
}

export interface PricingContext {
  readonly taxRateBasisPoints: number;
  readonly maxLineQuantity?: number;
}

const DEFAULT_MAX_LINE_QTY = 50;

/**
 * Prices an order entirely from the server-side catalog. Client-supplied
 * prices are never an input. Throws DomainError on any invalid selection.
 */
export function priceOrder(
  catalog: MenuCatalog,
  request: readonly OrderLineRequest[],
  ctx: PricingContext,
): PricedOrder {
  if (request.length === 0) {
    throw new DomainError('INVALID_QUANTITY', 'An order needs at least one line');
  }
  const maxQty = ctx.maxLineQuantity ?? DEFAULT_MAX_LINE_QTY;

  const lines = request.map((req, index): PricedLine => {
    if (!Number.isSafeInteger(req.quantity) || req.quantity < 1 || req.quantity > maxQty) {
      throw new DomainError('INVALID_QUANTITY', `Line ${index + 1}: quantity must be 1-${maxQty}`);
    }
    const item = catalog.items.get(req.menuItemId);
    if (!item) {
      throw new DomainError(
        'MENU_ITEM_NOT_FOUND',
        `Menu item ${req.menuItemId} is not on this menu`,
        {
          menuItemId: req.menuItemId,
        },
      );
    }
    if (!item.available) {
      throw new DomainError('MENU_ITEM_UNAVAILABLE', `${item.name} is currently unavailable`, {
        menuItemId: item.menuItemId,
      });
    }

    const lineModifiers = resolveModifiers(
      item.name,
      item.modifierGroups,
      req.modifierOptionIds ?? [],
    );
    let unitPrice = addCents(item.priceCents, ...lineModifiers.map((m) => m.priceDeltaCents));
    let production: ProductionSpec | null = null;
    const components: PricedComponent[] = [];

    if (item.kind === 'item') {
      if (req.components && req.components.length > 0) {
        throw new DomainError('COMBO_COMPONENT_INVALID', `${item.name} is not a combo`);
      }
      production = buildProduction(
        item.productId,
        item.recipe,
        lineModifiers,
        item.modifierGroups,
        req.quantity,
      );
    } else {
      // Combo-level modifiers (if any) affect price only; ingredients come from components.
      const requested = new Map<string, readonly string[]>();
      for (const c of req.components ?? []) {
        if (requested.has(c.componentId)) {
          throw new DomainError(
            'COMBO_COMPONENT_INVALID',
            `Component ${c.componentId} specified twice`,
          );
        }
        if (!item.components.some((def) => def.id === c.componentId)) {
          throw new DomainError(
            'COMBO_COMPONENT_INVALID',
            `Component ${c.componentId} is not part of ${item.name}`,
          );
        }
        requested.set(c.componentId, c.modifierOptionIds);
      }
      for (const def of item.components) {
        const mods = resolveModifiers(def.name, def.modifierGroups, requested.get(def.id) ?? []);
        unitPrice = addCents(unitPrice, mulCents(sumDeltas(mods), def.quantity));
        const qty = def.quantity * req.quantity;
        components.push({
          componentId: def.id,
          productId: def.productId,
          name: def.name,
          quantity: qty,
          modifiers: mods,
          production: buildProduction(def.productId, def.recipe, mods, def.modifierGroups, qty),
        });
      }
    }

    return {
      lineNo: index + 1,
      menuItemId: item.menuItemId,
      productId: item.productId,
      name: item.name,
      kind: item.kind,
      quantity: req.quantity,
      unitPriceCents: unitPrice,
      lineTotalCents: mulCents(unitPrice, req.quantity),
      taxable: item.taxable,
      modifiers: lineModifiers,
      production,
      components,
    };
  });

  const subtotal = addCents(...lines.map((l) => l.lineTotalCents));
  const discount = cents(0);
  const total = addCents(subtotal, -discount);
  const taxableTotal = addCents(0, ...lines.filter((l) => l.taxable).map((l) => l.lineTotalCents));
  return {
    menuVersionId: catalog.menuVersionId,
    lines,
    subtotalCents: subtotal,
    discountCents: discount,
    totalCents: total,
    taxCents: inclusiveTax(taxableTotal, ctx.taxRateBasisPoints),
  };
}

function sumDeltas(mods: readonly PricedModifier[]): Cents {
  return addCents(0, ...mods.map((m) => m.priceDeltaCents));
}

function resolveModifiers(
  itemName: string,
  groups: readonly ModifierGroupDef[],
  optionIds: readonly string[],
): PricedModifier[] {
  if (new Set(optionIds).size !== optionIds.length) {
    throw new DomainError(
      'MODIFIER_SELECTION_INVALID',
      `${itemName}: a modifier was selected twice`,
    );
  }
  const chosen: PricedModifier[] = [];
  const perGroup = new Map<string, number>();
  for (const id of optionIds) {
    let found: { group: ModifierGroupDef; option: ModifierOptionDef } | undefined;
    for (const group of groups) {
      const option = group.options.find((o) => o.id === id);
      if (option) found = { group, option };
    }
    if (!found) {
      throw new DomainError('MODIFIER_NOT_FOUND', `${itemName}: modifier ${id} is not available`, {
        optionId: id,
      });
    }
    perGroup.set(found.group.id, (perGroup.get(found.group.id) ?? 0) + 1);
    chosen.push({
      optionId: id,
      name: found.option.name,
      priceDeltaCents: cents(found.option.priceDeltaCents),
    });
  }
  for (const group of groups) {
    const n = perGroup.get(group.id) ?? 0;
    if (n < group.minSelect || n > group.maxSelect) {
      throw new DomainError(
        'MODIFIER_SELECTION_INVALID',
        `${itemName}: choose ${group.minSelect}-${group.maxSelect} from "${group.name}"`,
        { groupId: group.id },
      );
    }
  }
  return chosen;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Explodes a recipe into total ingredient requirements: base recipe plus
 * modifier deltas per unit, clamped at zero per ingredient ("no onion" removes
 * onion but never creates negative consumption), multiplied by quantity.
 */
export function buildProduction(
  productId: string,
  recipe: RecipeDef,
  modifiers: readonly PricedModifier[],
  groups: readonly ModifierGroupDef[],
  quantity: number,
): ProductionSpec {
  const perUnit = new Map<string, number>();
  const add = (q: IngredientQty) =>
    perUnit.set(q.inventoryItemId, (perUnit.get(q.inventoryItemId) ?? 0) + q.quantityMilli);
  recipe.ingredients.forEach(add);
  const optionById = new Map(groups.flatMap((g) => g.options.map((o) => [o.id, o] as const)));
  for (const m of modifiers) optionById.get(m.optionId)?.ingredientDeltas.forEach(add);

  const ingredients = [...perUnit.entries()]
    .map(([inventoryItemId, q]) => ({
      inventoryItemId,
      quantityMilli: milli(Math.max(0, q) * quantity),
    }))
    .filter((i) => i.quantityMilli > 0)
    .sort((a, b) => byId(a.inventoryItemId, b.inventoryItemId));

  return {
    productId,
    recipeVersionId: recipe.recipeVersionId,
    stationType: recipe.stationType,
    consumptionPoint: recipe.consumptionPoint,
    ingredients,
  };
}

export interface ProductionUnit {
  readonly lineNo: number;
  readonly componentId: string | null;
  readonly name: string;
  readonly quantity: number;
  readonly modifiers: readonly PricedModifier[];
  readonly spec: ProductionSpec;
}

/** All producible units in an order, in line order (simple items and combo components). */
export function productionUnits(order: PricedOrder): ProductionUnit[] {
  return order.lines.flatMap((l): ProductionUnit[] =>
    l.production
      ? [
          {
            lineNo: l.lineNo,
            componentId: null,
            name: l.name,
            quantity: l.quantity,
            modifiers: l.modifiers,
            spec: l.production,
          },
        ]
      : l.components.map((c) => ({
          lineNo: l.lineNo,
          componentId: c.componentId,
          name: c.name,
          quantity: c.quantity,
          modifiers: c.modifiers,
          spec: c.production,
        })),
  );
}

/** Aggregated requirement across the whole order, sorted by item id (deterministic lock order). */
export function aggregateRequirements(
  order: PricedOrder,
): { inventoryItemId: string; quantityMilli: MilliQty }[] {
  const totals = new Map<string, number>();
  for (const u of productionUnits(order)) {
    for (const i of u.spec.ingredients) {
      totals.set(i.inventoryItemId, (totals.get(i.inventoryItemId) ?? 0) + i.quantityMilli);
    }
  }
  return [...totals.entries()]
    .sort(([a], [b]) => byId(a, b))
    .map(([inventoryItemId, q]) => ({ inventoryItemId, quantityMilli: milli(q) }));
}
