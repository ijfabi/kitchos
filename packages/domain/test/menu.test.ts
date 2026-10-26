import { describe, expect, it } from 'vitest';
import {
  aggregateRequirements,
  priceOrder,
  productionUnits,
  type MenuCatalog,
  type MenuItemDef,
  type RecipeDef,
} from '../src/menu.ts';
import { orderStateMachine, kitchenTaskStateMachine } from '../src/state-machine.ts';
import { DomainError } from '../src/errors.ts';

const BUN = 'inv-bun';
const PATTY = 'inv-patty';
const CHEESE = 'inv-cheese';
const ONION = 'inv-onion';
const WRAPPER = 'inv-wrapper';
const FRIES = 'inv-fries';
const FRY_BOX = 'inv-fry-box';
const SYRUP = 'inv-cola-syrup';
const CUP = 'inv-cup';

const burgerRecipe: RecipeDef = {
  recipeVersionId: 'rv-burger-1',
  stationType: 'grill',
  consumptionPoint: 'task_started',
  ingredients: [
    { inventoryItemId: BUN, quantityMilli: 1000 },
    { inventoryItemId: PATTY, quantityMilli: 1000 },
    { inventoryItemId: CHEESE, quantityMilli: 1000 },
    { inventoryItemId: ONION, quantityMilli: 15000 },
    { inventoryItemId: WRAPPER, quantityMilli: 1000 },
  ],
};
const burgerMods = [
  {
    id: 'grp-extras',
    name: 'Extras',
    minSelect: 0,
    maxSelect: 3,
    options: [
      {
        id: 'opt-extra-cheese',
        name: 'Extra cheese',
        priceDeltaCents: 100,
        ingredientDeltas: [{ inventoryItemId: CHEESE, quantityMilli: 1000 }],
      },
      {
        id: 'opt-no-onion',
        name: 'No onion',
        priceDeltaCents: 0,
        ingredientDeltas: [{ inventoryItemId: ONION, quantityMilli: -15000 }],
      },
      {
        id: 'opt-no-onion-dup',
        name: 'Really no onion',
        priceDeltaCents: 0,
        ingredientDeltas: [{ inventoryItemId: ONION, quantityMilli: -15000 }],
      },
    ],
  },
];
const friesRecipe: RecipeDef = {
  recipeVersionId: 'rv-fries-1',
  stationType: 'fry',
  consumptionPoint: 'task_completed',
  ingredients: [
    { inventoryItemId: FRIES, quantityMilli: 110000 },
    { inventoryItemId: FRY_BOX, quantityMilli: 1000 },
  ],
};
const colaRecipe: RecipeDef = {
  recipeVersionId: 'rv-cola-1',
  stationType: 'beverage',
  consumptionPoint: 'order_accepted',
  ingredients: [
    { inventoryItemId: SYRUP, quantityMilli: 60000 },
    { inventoryItemId: CUP, quantityMilli: 1000 },
  ],
};

const items: MenuItemDef[] = [
  {
    kind: 'item',
    menuItemId: 'mi-cheeseburger',
    productId: 'p-cheeseburger',
    name: 'Cheeseburger',
    priceCents: 790,
    taxable: true,
    available: true,
    modifierGroups: burgerMods,
    recipe: burgerRecipe,
  },
  {
    kind: 'combo',
    menuItemId: 'mi-cheeseburger-meal',
    productId: 'p-cheeseburger-meal',
    name: 'Cheeseburger Meal',
    priceCents: 1290,
    taxable: true,
    available: true,
    modifierGroups: [],
    components: [
      {
        id: 'cc-burger',
        productId: 'p-cheeseburger',
        name: 'Cheeseburger',
        quantity: 1,
        recipe: burgerRecipe,
        modifierGroups: burgerMods,
      },
      {
        id: 'cc-fries',
        productId: 'p-fries',
        name: 'Medium Fries',
        quantity: 1,
        recipe: friesRecipe,
        modifierGroups: [],
      },
      {
        id: 'cc-cola',
        productId: 'p-cola',
        name: 'Medium Cola',
        quantity: 1,
        recipe: colaRecipe,
        modifierGroups: [],
      },
    ],
  },
  {
    kind: 'item',
    menuItemId: 'mi-sold-out',
    productId: 'p-sold-out',
    name: 'Seasonal Pie',
    priceCents: 500,
    taxable: true,
    available: false,
    modifierGroups: [],
    recipe: { ...friesRecipe, recipeVersionId: 'rv-pie' },
  },
];
const catalog: MenuCatalog = {
  menuVersionId: 'mv-1',
  items: new Map(items.map((i) => [i.menuItemId, i])),
};
const ctx = { taxRateBasisPoints: 1000 };

const qtyOf = (reqs: { inventoryItemId: string; quantityMilli: number }[], id: string) =>
  reqs.find((r) => r.inventoryItemId === id)?.quantityMilli ?? 0;

describe('priceOrder', () => {
  it('prices a plain cheeseburger from the catalog with GST included', () => {
    const order = priceOrder(catalog, [{ menuItemId: 'mi-cheeseburger', quantity: 2 }], ctx);
    expect(order.totalCents).toBe(1580);
    expect(order.taxCents).toBe(144); // 1580 / 11 = 143.6
    expect(order.menuVersionId).toBe('mv-1');
    expect(aggregateRequirements(order)).toEqual([
      { inventoryItemId: BUN, quantityMilli: 2000 },
      { inventoryItemId: CHEESE, quantityMilli: 2000 },
      { inventoryItemId: ONION, quantityMilli: 30000 },
      { inventoryItemId: PATTY, quantityMilli: 2000 },
      { inventoryItemId: WRAPPER, quantityMilli: 2000 },
    ]);
  });

  it('extra cheese consumes the additional cheese and adds its price', () => {
    const order = priceOrder(
      catalog,
      [{ menuItemId: 'mi-cheeseburger', quantity: 3, modifierOptionIds: ['opt-extra-cheese'] }],
      ctx,
    );
    expect(order.lines[0]?.unitPriceCents).toBe(890);
    expect(order.totalCents).toBe(2670);
    expect(qtyOf(aggregateRequirements(order), CHEESE)).toBe(6000);
  });

  it('removal modifiers clamp at zero rather than producing negative consumption', () => {
    const order = priceOrder(
      catalog,
      [
        {
          menuItemId: 'mi-cheeseburger',
          quantity: 1,
          modifierOptionIds: ['opt-no-onion', 'opt-no-onion-dup'],
        },
      ],
      ctx,
    );
    const reqs = aggregateRequirements(order);
    expect(qtyOf(reqs, ONION)).toBe(0);
    expect(reqs.every((r) => r.quantityMilli > 0)).toBe(true);
  });

  it('decomposes a meal into components routed to their own stations', () => {
    const order = priceOrder(
      catalog,
      [
        {
          menuItemId: 'mi-cheeseburger-meal',
          quantity: 2,
          components: [{ componentId: 'cc-burger', modifierOptionIds: ['opt-extra-cheese'] }],
        },
      ],
      ctx,
    );
    expect(order.lines[0]?.unitPriceCents).toBe(1390);
    expect(order.totalCents).toBe(2780);
    const units = productionUnits(order);
    expect(units.map((u) => [u.componentId, u.spec.stationType, u.spec.consumptionPoint])).toEqual([
      ['cc-burger', 'grill', 'task_started'],
      ['cc-fries', 'fry', 'task_completed'],
      ['cc-cola', 'beverage', 'order_accepted'],
    ]);
    const reqs = aggregateRequirements(order);
    expect(qtyOf(reqs, CHEESE)).toBe(4000);
    expect(qtyOf(reqs, FRIES)).toBe(220000);
    expect(qtyOf(reqs, FRY_BOX)).toBe(2000);
    expect(qtyOf(reqs, CUP)).toBe(2000);
  });

  it('ignores any notion of client price: unknown or unavailable items are rejected', () => {
    expect(() => priceOrder(catalog, [{ menuItemId: 'nope', quantity: 1 }], ctx)).toThrow(
      DomainError,
    );
    expect(() => priceOrder(catalog, [{ menuItemId: 'mi-sold-out', quantity: 1 }], ctx)).toThrow(
      /unavailable/,
    );
  });

  it('validates quantities, duplicate modifiers and foreign modifiers', () => {
    expect(() =>
      priceOrder(catalog, [{ menuItemId: 'mi-cheeseburger', quantity: 0 }], ctx),
    ).toThrow(/quantity/);
    expect(() =>
      priceOrder(catalog, [{ menuItemId: 'mi-cheeseburger', quantity: 1.5 }], ctx),
    ).toThrow(/quantity/);
    expect(() =>
      priceOrder(
        catalog,
        [
          {
            menuItemId: 'mi-cheeseburger',
            quantity: 1,
            modifierOptionIds: ['opt-extra-cheese', 'opt-extra-cheese'],
          },
        ],
        ctx,
      ),
    ).toThrow(/twice/);
    expect(() =>
      priceOrder(
        catalog,
        [{ menuItemId: 'mi-cheeseburger', quantity: 1, modifierOptionIds: ['opt-from-elsewhere'] }],
        ctx,
      ),
    ).toThrow(/not available/);
    expect(() =>
      priceOrder(
        catalog,
        [
          {
            menuItemId: 'mi-cheeseburger-meal',
            quantity: 1,
            components: [{ componentId: 'cc-x', modifierOptionIds: [] }],
          },
        ],
        ctx,
      ),
    ).toThrow(/not part of/);
    expect(() => priceOrder(catalog, [], ctx)).toThrow(/at least one/);
  });
});

describe('state machines', () => {
  it('orders cannot skip back or leave terminal states', () => {
    expect(orderStateMachine.canTransition('accepted', 'in_preparation')).toBe(true);
    expect(orderStateMachine.canTransition('completed', 'cancelled')).toBe(false);
    expect(orderStateMachine.canTransition('ready', 'accepted')).toBe(false);
    expect(() => orderStateMachine.assertTransition('cancelled', 'accepted')).toThrow(DomainError);
    expect(orderStateMachine.isTerminal('completed')).toBe(true);
  });

  it('kitchen tasks progress queued -> in_progress -> done only', () => {
    expect(kitchenTaskStateMachine.canTransition('queued', 'done')).toBe(false);
    expect(kitchenTaskStateMachine.canTransition('in_progress', 'done')).toBe(true);
    expect(kitchenTaskStateMachine.canTransition('done', 'in_progress')).toBe(false);
  });
});
