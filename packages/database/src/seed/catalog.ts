/**
 * Synthetic demonstration catalog for the KitchOS demo organisation. All
 * names, people and quantities are fictional. Quantities are decimal strings
 * in the inventory item's base unit.
 */

export interface InventoryItemSeed {
  sku: string;
  name: string;
  baseUnit: 'each' | 'g' | 'ml';
  category: 'ingredient' | 'packaging';
}

export const INVENTORY_ITEMS: InventoryItemSeed[] = [
  { sku: 'BUN-REG', name: 'Burger bun', baseUnit: 'each', category: 'ingredient' },
  { sku: 'BUN-SES', name: 'Sesame bun', baseUnit: 'each', category: 'ingredient' },
  { sku: 'PATTY-BEEF', name: 'Beef patty 100 g', baseUnit: 'each', category: 'ingredient' },
  {
    sku: 'CHICKEN-FILLET',
    name: 'Crumbed chicken fillet',
    baseUnit: 'each',
    category: 'ingredient',
  },
  { sku: 'CHEESE-SLICE', name: 'Cheddar slice', baseUnit: 'each', category: 'ingredient' },
  { sku: 'BACON', name: 'Bacon rasher', baseUnit: 'each', category: 'ingredient' },
  { sku: 'LETTUCE', name: 'Shredded lettuce', baseUnit: 'g', category: 'ingredient' },
  { sku: 'TOMATO', name: 'Tomato slices', baseUnit: 'g', category: 'ingredient' },
  { sku: 'ONION', name: 'Diced onion', baseUnit: 'g', category: 'ingredient' },
  { sku: 'PICKLES', name: 'Pickles', baseUnit: 'g', category: 'ingredient' },
  { sku: 'SAUCE-BURGER', name: 'Burger sauce', baseUnit: 'ml', category: 'ingredient' },
  { sku: 'MAYO', name: 'Mayonnaise', baseUnit: 'ml', category: 'ingredient' },
  { sku: 'FRIES-FROZEN', name: 'Frozen fries', baseUnit: 'g', category: 'ingredient' },
  { sku: 'SYRUP-COLA', name: 'Cola syrup', baseUnit: 'ml', category: 'ingredient' },
  { sku: 'SYRUP-LEMONADE', name: 'Lemonade syrup', baseUnit: 'ml', category: 'ingredient' },
  { sku: 'COFFEE-BEANS', name: 'Espresso beans', baseUnit: 'g', category: 'ingredient' },
  { sku: 'MILK', name: 'Full cream milk', baseUnit: 'ml', category: 'ingredient' },
  { sku: 'MILK-OAT', name: 'Oat milk', baseUnit: 'ml', category: 'ingredient' },
  { sku: 'SOFTSERVE-MIX', name: 'Soft serve mix', baseUnit: 'ml', category: 'ingredient' },
  { sku: 'SAUCE-CHOC', name: 'Chocolate topping', baseUnit: 'ml', category: 'ingredient' },
  { sku: 'CROISSANT', name: 'Butter croissant', baseUnit: 'each', category: 'ingredient' },
  { sku: 'BANANA-BREAD', name: 'Banana bread slice', baseUnit: 'each', category: 'ingredient' },
  { sku: 'PKG-BURGER-WRAP', name: 'Burger wrapper', baseUnit: 'each', category: 'packaging' },
  { sku: 'PKG-CHICKEN-BOX', name: 'Chicken burger box', baseUnit: 'each', category: 'packaging' },
  { sku: 'PKG-FRY-M', name: 'Fry carton medium', baseUnit: 'each', category: 'packaging' },
  { sku: 'PKG-FRY-L', name: 'Fry carton large', baseUnit: 'each', category: 'packaging' },
  { sku: 'PKG-CUP-M', name: 'Cold cup medium', baseUnit: 'each', category: 'packaging' },
  { sku: 'PKG-CUP-L', name: 'Cold cup large', baseUnit: 'each', category: 'packaging' },
  { sku: 'PKG-LID-COLD', name: 'Cold cup lid', baseUnit: 'each', category: 'packaging' },
  { sku: 'PKG-COFFEE-CUP', name: 'Coffee cup 12 oz', baseUnit: 'each', category: 'packaging' },
  { sku: 'PKG-COFFEE-LID', name: 'Coffee lid', baseUnit: 'each', category: 'packaging' },
  { sku: 'PKG-DESSERT-CUP', name: 'Dessert cup', baseUnit: 'each', category: 'packaging' },
  { sku: 'PKG-PASTRY-BAG', name: 'Pastry bag', baseUnit: 'each', category: 'packaging' },
];

export type ConsumptionPointSeed = 'order_accepted' | 'task_started' | 'task_completed';

export interface ProductSeed {
  sku: string;
  name: string;
  description: string;
  kind: 'item' | 'combo';
  allergens: string[];
  energyKj?: number;
  taxable?: boolean;
  recipe?: {
    stationType: string;
    consumptionPoint: ConsumptionPointSeed;
    instructions: string;
    lines: [sku: string, quantity: string][];
  };
}

const BURGER_INSTRUCTIONS =
  'Toast bun 30 s. Grill patty to 71 °C core. Build: sauce, onion, pickles, cheese, patty.';

export const PRODUCTS: ProductSeed[] = [
  {
    sku: 'CHEESEBURGER',
    name: 'Cheeseburger',
    kind: 'item',
    description: 'Beef patty, cheddar, onion, pickles and burger sauce on a toasted bun.',
    allergens: ['gluten', 'milk', 'egg', 'sesame'],
    energyKj: 1250,
    recipe: {
      stationType: 'grill',
      consumptionPoint: 'task_started',
      instructions: BURGER_INSTRUCTIONS,
      lines: [
        ['BUN-REG', '1'],
        ['PATTY-BEEF', '1'],
        ['CHEESE-SLICE', '1'],
        ['ONION', '8'],
        ['PICKLES', '10'],
        ['SAUCE-BURGER', '15'],
        ['PKG-BURGER-WRAP', '1'],
      ],
    },
  },
  {
    sku: 'DOUBLE-CHEESEBURGER',
    name: 'Double Cheeseburger',
    kind: 'item',
    description: 'Two beef patties, two slices of cheddar, onion, pickles and sauce.',
    allergens: ['gluten', 'milk', 'egg', 'sesame'],
    energyKj: 1880,
    recipe: {
      stationType: 'grill',
      consumptionPoint: 'task_started',
      instructions: BURGER_INSTRUCTIONS,
      lines: [
        ['BUN-REG', '1'],
        ['PATTY-BEEF', '2'],
        ['CHEESE-SLICE', '2'],
        ['ONION', '8'],
        ['PICKLES', '10'],
        ['SAUCE-BURGER', '20'],
        ['PKG-BURGER-WRAP', '1'],
      ],
    },
  },
  {
    sku: 'BACON-DELUXE',
    name: 'Bacon Deluxe',
    kind: 'item',
    description: 'Beef patty, bacon, cheddar, lettuce, tomato and mayo on a sesame bun.',
    allergens: ['gluten', 'milk', 'egg', 'sesame'],
    energyKj: 2210,
    recipe: {
      stationType: 'grill',
      consumptionPoint: 'task_started',
      instructions: BURGER_INSTRUCTIONS,
      lines: [
        ['BUN-SES', '1'],
        ['PATTY-BEEF', '1'],
        ['BACON', '2'],
        ['CHEESE-SLICE', '1'],
        ['LETTUCE', '15'],
        ['TOMATO', '25'],
        ['MAYO', '15'],
        ['PKG-BURGER-WRAP', '1'],
      ],
    },
  },
  {
    sku: 'CHICKEN-BURGER',
    name: 'Crispy Chicken Burger',
    kind: 'item',
    description: 'Crumbed chicken fillet, lettuce and mayo on a sesame bun.',
    allergens: ['gluten', 'egg', 'sesame'],
    energyKj: 2030,
    recipe: {
      stationType: 'grill',
      consumptionPoint: 'task_started',
      instructions: 'Fry fillet 4 min to 74 °C core. Build: mayo, lettuce, fillet.',
      lines: [
        ['BUN-SES', '1'],
        ['CHICKEN-FILLET', '1'],
        ['LETTUCE', '20'],
        ['MAYO', '20'],
        ['PKG-CHICKEN-BOX', '1'],
      ],
    },
  },
  {
    sku: 'FRIES-M',
    name: 'Medium Fries',
    kind: 'item',
    description: 'Golden fries, lightly salted.',
    allergens: [],
    energyKj: 1350,
    recipe: {
      stationType: 'fry',
      consumptionPoint: 'task_completed',
      instructions: 'Fry 3 min at 175 °C. Salt and carton.',
      lines: [
        ['FRIES-FROZEN', '115'],
        ['PKG-FRY-M', '1'],
      ],
    },
  },
  {
    sku: 'FRIES-L',
    name: 'Large Fries',
    kind: 'item',
    description: 'Golden fries, lightly salted.',
    allergens: [],
    energyKj: 1740,
    recipe: {
      stationType: 'fry',
      consumptionPoint: 'task_completed',
      instructions: 'Fry 3 min at 175 °C. Salt and carton.',
      lines: [
        ['FRIES-FROZEN', '150'],
        ['PKG-FRY-L', '1'],
      ],
    },
  },
  {
    sku: 'COLA-M',
    name: 'Medium Cola',
    kind: 'item',
    description: 'Post-mix cola, 500 ml.',
    allergens: [],
    energyKj: 850,
    recipe: {
      stationType: 'beverage',
      consumptionPoint: 'order_accepted',
      instructions: 'Fill with ice to line, then cola.',
      lines: [
        ['SYRUP-COLA', '85'],
        ['PKG-CUP-M', '1'],
        ['PKG-LID-COLD', '1'],
      ],
    },
  },
  {
    sku: 'COLA-L',
    name: 'Large Cola',
    kind: 'item',
    description: 'Post-mix cola, 700 ml.',
    allergens: [],
    energyKj: 1190,
    recipe: {
      stationType: 'beverage',
      consumptionPoint: 'order_accepted',
      instructions: 'Fill with ice to line, then cola.',
      lines: [
        ['SYRUP-COLA', '120'],
        ['PKG-CUP-L', '1'],
        ['PKG-LID-COLD', '1'],
      ],
    },
  },
  {
    sku: 'LEMONADE-M',
    name: 'Medium Lemonade',
    kind: 'item',
    description: 'Post-mix lemonade, 500 ml.',
    allergens: [],
    energyKj: 800,
    recipe: {
      stationType: 'beverage',
      consumptionPoint: 'order_accepted',
      instructions: 'Fill with ice to line, then lemonade.',
      lines: [
        ['SYRUP-LEMONADE', '85'],
        ['PKG-CUP-M', '1'],
        ['PKG-LID-COLD', '1'],
      ],
    },
  },
  {
    sku: 'SUNDAE-CHOC',
    name: 'Chocolate Sundae',
    kind: 'item',
    description: 'Soft serve with chocolate topping.',
    allergens: ['milk', 'soy'],
    energyKj: 1150,
    recipe: {
      stationType: 'dessert',
      consumptionPoint: 'task_started',
      instructions: 'Swirl 150 ml soft serve, top with 30 ml chocolate.',
      lines: [
        ['SOFTSERVE-MIX', '150'],
        ['SAUCE-CHOC', '30'],
        ['PKG-DESSERT-CUP', '1'],
      ],
    },
  },
  {
    sku: 'FLAT-WHITE',
    name: 'Flat White',
    kind: 'item',
    description: 'Double shot with velvety milk, 12 oz.',
    allergens: ['milk'],
    energyKj: 560,
    recipe: {
      stationType: 'cafe',
      consumptionPoint: 'task_started',
      instructions: 'Double shot 18 g. Texture milk to 60 °C, thin microfoam.',
      lines: [
        ['COFFEE-BEANS', '18'],
        ['MILK', '220'],
        ['PKG-COFFEE-CUP', '1'],
        ['PKG-COFFEE-LID', '1'],
      ],
    },
  },
  {
    sku: 'LATTE',
    name: 'Latte',
    kind: 'item',
    description: 'Double shot with steamed milk, 12 oz.',
    allergens: ['milk'],
    energyKj: 610,
    recipe: {
      stationType: 'cafe',
      consumptionPoint: 'task_started',
      instructions: 'Double shot 18 g. Texture milk to 60 °C, 1 cm foam.',
      lines: [
        ['COFFEE-BEANS', '18'],
        ['MILK', '240'],
        ['PKG-COFFEE-CUP', '1'],
        ['PKG-COFFEE-LID', '1'],
      ],
    },
  },
  {
    sku: 'CAPPUCCINO',
    name: 'Cappuccino',
    kind: 'item',
    description: 'Double shot, airy foam and chocolate dusting, 12 oz.',
    allergens: ['milk'],
    energyKj: 540,
    recipe: {
      stationType: 'cafe',
      consumptionPoint: 'task_started',
      instructions: 'Double shot 18 g. Texture milk to 60 °C, 2 cm foam, dust.',
      lines: [
        ['COFFEE-BEANS', '18'],
        ['MILK', '200'],
        ['PKG-COFFEE-CUP', '1'],
        ['PKG-COFFEE-LID', '1'],
      ],
    },
  },
  {
    sku: 'CROISSANT-TOASTED',
    name: 'Toasted Croissant',
    kind: 'item',
    description: 'Butter croissant, warmed.',
    allergens: ['gluten', 'milk', 'egg'],
    energyKj: 1150,
    recipe: {
      stationType: 'bakery',
      consumptionPoint: 'task_started',
      instructions: 'Warm 90 s in oven. Bag.',
      lines: [
        ['CROISSANT', '1'],
        ['PKG-PASTRY-BAG', '1'],
      ],
    },
  },
  {
    sku: 'BANANA-BREAD',
    name: 'Banana Bread',
    kind: 'item',
    description: 'Thick slice of house banana bread.',
    allergens: ['gluten', 'milk', 'egg', 'tree nuts'],
    energyKj: 1420,
    recipe: {
      stationType: 'bakery',
      consumptionPoint: 'task_started',
      instructions: 'Toast 2 min. Bag.',
      lines: [
        ['BANANA-BREAD', '1'],
        ['PKG-PASTRY-BAG', '1'],
      ],
    },
  },
  {
    sku: 'CHEESEBURGER-MEAL',
    name: 'Cheeseburger Meal',
    kind: 'combo',
    description: 'Cheeseburger, medium fries and a medium cola.',
    allergens: ['gluten', 'milk', 'egg', 'sesame'],
  },
  {
    sku: 'DOUBLE-CHEESEBURGER-MEAL',
    name: 'Double Cheeseburger Meal',
    kind: 'combo',
    description: 'Double cheeseburger, large fries and a large cola.',
    allergens: ['gluten', 'milk', 'egg', 'sesame'],
  },
  {
    sku: 'CHICKEN-MEAL',
    name: 'Crispy Chicken Meal',
    kind: 'combo',
    description: 'Crispy chicken burger, medium fries and a medium lemonade.',
    allergens: ['gluten', 'egg', 'sesame'],
  },
  {
    sku: 'COFFEE-CROISSANT',
    name: 'Coffee & Croissant',
    kind: 'combo',
    description: 'Any-milk flat white with a toasted croissant.',
    allergens: ['gluten', 'milk', 'egg'],
  },
];

export interface ModifierOptionSeed {
  name: string;
  priceDeltaCents: number;
  deltas: [sku: string, quantity: string][];
}
export interface ModifierGroupSeed {
  name: string;
  minSelect: number;
  maxSelect: number;
  options: ModifierOptionSeed[];
}

const BURGER_EXTRAS: ModifierGroupSeed = {
  name: 'Extras',
  minSelect: 0,
  maxSelect: 3,
  options: [
    { name: 'Extra cheese', priceDeltaCents: 100, deltas: [['CHEESE-SLICE', '1']] },
    { name: 'Add bacon', priceDeltaCents: 220, deltas: [['BACON', '2']] },
    { name: 'Extra patty', priceDeltaCents: 350, deltas: [['PATTY-BEEF', '1']] },
  ],
};
const BURGER_REMOVALS: ModifierGroupSeed = {
  name: 'Leave off',
  minSelect: 0,
  maxSelect: 3,
  options: [
    { name: 'No onion', priceDeltaCents: 0, deltas: [['ONION', '-8']] },
    { name: 'No pickles', priceDeltaCents: 0, deltas: [['PICKLES', '-10']] },
    { name: 'No sauce', priceDeltaCents: 0, deltas: [['SAUCE-BURGER', '-20']] },
  ],
};
const CHICKEN_REMOVALS: ModifierGroupSeed = {
  name: 'Leave off',
  minSelect: 0,
  maxSelect: 2,
  options: [
    { name: 'No mayo', priceDeltaCents: 0, deltas: [['MAYO', '-20']] },
    { name: 'No lettuce', priceDeltaCents: 0, deltas: [['LETTUCE', '-20']] },
  ],
};
const COFFEE_MILK: ModifierGroupSeed = {
  name: 'Milk',
  minSelect: 0,
  maxSelect: 1,
  options: [
    {
      name: 'Oat milk',
      priceDeltaCents: 80,
      deltas: [
        ['MILK', '-220'],
        ['MILK-OAT', '220'],
      ],
    },
  ],
};
const COFFEE_EXTRAS: ModifierGroupSeed = {
  name: 'Extras',
  minSelect: 0,
  maxSelect: 1,
  options: [{ name: 'Extra shot', priceDeltaCents: 60, deltas: [['COFFEE-BEANS', '9']] }],
};

/** Modifier groups per product SKU; applied identically on every menu that sells the product. */
export const MODIFIERS: Record<string, ModifierGroupSeed[]> = {
  CHEESEBURGER: [BURGER_EXTRAS, BURGER_REMOVALS],
  'DOUBLE-CHEESEBURGER': [BURGER_EXTRAS, BURGER_REMOVALS],
  'BACON-DELUXE': [BURGER_EXTRAS],
  'CHICKEN-BURGER': [CHICKEN_REMOVALS],
  'FLAT-WHITE': [COFFEE_MILK, COFFEE_EXTRAS],
  LATTE: [COFFEE_MILK, COFFEE_EXTRAS],
  CAPPUCCINO: [COFFEE_MILK, COFFEE_EXTRAS],
};

export const COMBOS: Record<string, [sku: string, qty: number][]> = {
  'CHEESEBURGER-MEAL': [
    ['CHEESEBURGER', 1],
    ['FRIES-M', 1],
    ['COLA-M', 1],
  ],
  'DOUBLE-CHEESEBURGER-MEAL': [
    ['DOUBLE-CHEESEBURGER', 1],
    ['FRIES-L', 1],
    ['COLA-L', 1],
  ],
  'CHICKEN-MEAL': [
    ['CHICKEN-BURGER', 1],
    ['FRIES-M', 1],
    ['LEMONADE-M', 1],
  ],
  'COFFEE-CROISSANT': [
    ['FLAT-WHITE', 1],
    ['CROISSANT-TOASTED', 1],
  ],
};

export interface StationSeed {
  code: string;
  name: string;
  types: string[];
}

export interface StaffSeed {
  name: string;
  email: string;
  roles: string[];
}

export interface RestaurantSeed {
  slug: string;
  name: string;
  region: 'Sydney CBD' | 'Western Sydney';
  ownership: 'company' | 'franchise';
  address: string;
  timezone: string;
  shortagePolicy: 'block' | 'allow_negative';
  openingHours: Record<string, [open: string, close: string]>;
  stations: StationSeed[];
  menu: { name: string; items: [category: string, sku: string, priceCents: number][] };
  /** Opening stock per inventory SKU (decimal string in base unit). Items not listed start empty. */
  openingStock: Record<string, string>;
  staff: StaffSeed[];
}

const EVERY_DAY = (open: string, close: string) =>
  Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [open, close]]),
  ) as Record<string, [string, string]>;

const BURGER_STOCK = {
  'BUN-REG': '400',
  'BUN-SES': '240',
  'PATTY-BEEF': '600',
  'CHICKEN-FILLET': '180',
  'CHEESE-SLICE': '700',
  BACON: '300',
  LETTUCE: '6000',
  TOMATO: '5000',
  ONION: '5000',
  PICKLES: '5000',
  'SAUCE-BURGER': '8000',
  MAYO: '6000',
  'FRIES-FROZEN': '60000',
  'SYRUP-COLA': '40000',
  'SYRUP-LEMONADE': '20000',
  'SOFTSERVE-MIX': '20000',
  'SAUCE-CHOC': '5000',
  'PKG-BURGER-WRAP': '900',
  'PKG-CHICKEN-BOX': '250',
  'PKG-FRY-M': '500',
  'PKG-FRY-L': '400',
  'PKG-CUP-M': '500',
  'PKG-CUP-L': '400',
  'PKG-LID-COLD': '900',
  'PKG-DESSERT-CUP': '200',
};

export const RESTAURANTS: RestaurantSeed[] = [
  {
    slug: 'kitchos-central',
    name: 'KitchOS Central',
    region: 'Sydney CBD',
    ownership: 'company',
    address: '100 George Street, Sydney NSW 2000',
    timezone: 'Australia/Sydney',
    shortagePolicy: 'block',
    openingHours: EVERY_DAY('06:00', '23:00'),
    stations: [
      { code: 'grill', name: 'Burger Grill', types: ['grill'] },
      { code: 'fry', name: 'Fry Station', types: ['fry'] },
      { code: 'beverage', name: 'Beverages', types: ['beverage'] },
      { code: 'dessert', name: 'Desserts', types: ['dessert'] },
      { code: 'barista', name: 'Café / Barista', types: ['cafe', 'bakery'] },
      { code: 'expo', name: 'Expo / Front Counter', types: ['expo'] },
    ],
    menu: {
      name: 'Central Menu',
      items: [
        ['Burgers', 'CHEESEBURGER', 790],
        ['Burgers', 'DOUBLE-CHEESEBURGER', 1090],
        ['Burgers', 'BACON-DELUXE', 1290],
        ['Burgers', 'CHICKEN-BURGER', 1150],
        ['Meals', 'CHEESEBURGER-MEAL', 1290],
        ['Meals', 'CHICKEN-MEAL', 1550],
        ['Sides', 'FRIES-M', 450],
        ['Sides', 'FRIES-L', 550],
        ['Drinks', 'COLA-M', 420],
        ['Drinks', 'LEMONADE-M', 420],
        ['Desserts', 'SUNDAE-CHOC', 450],
        ['Coffee', 'FLAT-WHITE', 520],
        ['Coffee', 'LATTE', 520],
      ],
    },
    openingStock: {
      ...BURGER_STOCK,
      'COFFEE-BEANS': '5000',
      MILK: '30000',
      'MILK-OAT': '8000',
      'PKG-COFFEE-CUP': '300',
      'PKG-COFFEE-LID': '300',
    },
    staff: [
      {
        name: 'Priya Natarajan',
        email: 'manager@central.kitchos.test',
        roles: ['restaurant_manager'],
      },
      { name: 'Tom Okafor', email: 'supervisor@central.kitchos.test', roles: ['shift_supervisor'] },
      { name: 'Mia Chen', email: 'crew1@central.kitchos.test', roles: ['crew_member'] },
      { name: 'Lachlan Reid', email: 'crew2@central.kitchos.test', roles: ['crew_trainer'] },
    ],
  },
  {
    slug: 'kitchos-drive',
    name: 'KitchOS Drive',
    region: 'Western Sydney',
    ownership: 'franchise',
    address: '45 Great Western Highway, Parramatta NSW 2150',
    timezone: 'Australia/Sydney',
    shortagePolicy: 'block',
    openingHours: EVERY_DAY('05:00', '02:00'),
    stations: [
      { code: 'grill', name: 'Burger Grill', types: ['grill'] },
      { code: 'fry', name: 'Fry Station', types: ['fry'] },
      { code: 'bev-dessert', name: 'Drinks & Desserts', types: ['beverage', 'dessert'] },
      { code: 'drive-assembly', name: 'Drive-Thru Assembly', types: ['expo'] },
    ],
    menu: {
      name: 'Drive Menu',
      items: [
        ['Burgers', 'CHEESEBURGER', 750],
        ['Burgers', 'DOUBLE-CHEESEBURGER', 1030],
        ['Burgers', 'CHICKEN-BURGER', 1090],
        ['Meals', 'CHEESEBURGER-MEAL', 1190],
        ['Meals', 'DOUBLE-CHEESEBURGER-MEAL', 1490],
        ['Meals', 'CHICKEN-MEAL', 1450],
        ['Sides', 'FRIES-M', 420],
        ['Sides', 'FRIES-L', 520],
        ['Drinks', 'COLA-M', 390],
        ['Drinks', 'COLA-L', 460],
        ['Drinks', 'LEMONADE-M', 390],
        ['Desserts', 'SUNDAE-CHOC', 420],
      ],
    },
    openingStock: { ...BURGER_STOCK, 'PATTY-BEEF': '900', 'FRIES-FROZEN': '90000' },
    staff: [
      {
        name: 'Daniel Moretti',
        email: 'manager@drive.kitchos.test',
        roles: ['restaurant_manager', 'franchise_owner'],
      },
      { name: 'Aisha Rahman', email: 'supervisor@drive.kitchos.test', roles: ['shift_supervisor'] },
      { name: 'Jack Thompson', email: 'crew1@drive.kitchos.test', roles: ['crew_member'] },
      { name: 'Sofia Nguyen', email: 'crew2@drive.kitchos.test', roles: ['crew_member'] },
    ],
  },
  {
    slug: 'kitchos-express',
    name: 'KitchOS Express',
    region: 'Sydney CBD',
    ownership: 'company',
    address: 'Shop 3, 1 Martin Place, Sydney NSW 2000',
    timezone: 'Australia/Sydney',
    shortagePolicy: 'allow_negative',
    openingHours: {
      mon: ['06:30', '15:00'],
      tue: ['06:30', '15:00'],
      wed: ['06:30', '15:00'],
      thu: ['06:30', '15:00'],
      fri: ['06:30', '15:00'],
    },
    stations: [
      { code: 'barista', name: 'Espresso Bar', types: ['cafe', 'beverage'] },
      { code: 'pantry', name: 'Pantry & Bakery', types: ['bakery', 'dessert'] },
      { code: 'counter', name: 'Counter Pickup', types: ['expo'] },
    ],
    menu: {
      name: 'Express Menu',
      items: [
        ['Coffee', 'FLAT-WHITE', 550],
        ['Coffee', 'LATTE', 550],
        ['Coffee', 'CAPPUCCINO', 550],
        ['Bakery', 'CROISSANT-TOASTED', 600],
        ['Bakery', 'BANANA-BREAD', 650],
        ['Deals', 'COFFEE-CROISSANT', 990],
        ['Cold drinks', 'LEMONADE-M', 450],
      ],
    },
    openingStock: {
      'COFFEE-BEANS': '8000',
      MILK: '50000',
      'MILK-OAT': '15000',
      CROISSANT: '60',
      'BANANA-BREAD': '40',
      'SYRUP-LEMONADE': '5000',
      'PKG-COFFEE-CUP': '500',
      'PKG-COFFEE-LID': '500',
      'PKG-PASTRY-BAG': '200',
      'PKG-CUP-M': '100',
      'PKG-LID-COLD': '100',
    },
    staff: [
      {
        name: 'Grace Wilson',
        email: 'manager@express.kitchos.test',
        roles: ['restaurant_manager'],
      },
      { name: 'Hamish Brown', email: 'crew1@express.kitchos.test', roles: ['crew_member'] },
    ],
  },
];

export const HEAD_OFFICE_STAFF: (StaffSeed & {
  scope: 'organisation' | 'Sydney CBD' | 'Western Sydney';
})[] = [
  {
    name: 'Elena Kovacs',
    email: 'admin@kitchos.test',
    roles: ['head_office_administrator'],
    scope: 'organisation',
  },
  {
    name: 'Marcus Lee',
    email: 'area.cbd@kitchos.test',
    roles: ['area_manager'],
    scope: 'Sydney CBD',
  },
  {
    name: 'Ruth Adeyemi',
    email: 'inventory@kitchos.test',
    roles: ['inventory_controller'],
    scope: 'organisation',
  },
  { name: 'Owen Price', email: 'auditor@kitchos.test', roles: ['auditor'], scope: 'organisation' },
];

/** Shared development password for every synthetic account. Never used outside local/dev. */
export const DEMO_PASSWORD = 'kitchos-demo-pass';
