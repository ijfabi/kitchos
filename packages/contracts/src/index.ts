import { z } from 'zod';

/**
 * Wire contracts shared by the API (runtime validation at the trust boundary)
 * and the web apps (typed clients). Money is integer cents; quantities in
 * responses are decimal strings in the item's base unit.
 */

const uuid = z.uuid();
const cents = z.number().int().safe();

// ---------------------------------------------------------------- errors

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------- auth

export const LoginRequestSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RoleAssignmentViewSchema = z.object({
  role: z.string(),
  scopeType: z.enum(['organisation', 'brand', 'region', 'restaurant']),
  scopeId: uuid,
});

export const AccessibleRestaurantSchema = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  permissions: z.array(z.string()),
});
export type AccessibleRestaurant = z.infer<typeof AccessibleRestaurantSchema>;

export const MeResponseSchema = z.object({
  user: z.object({ id: uuid, email: z.string(), displayName: z.string(), orgId: uuid }),
  roles: z.array(RoleAssignmentViewSchema),
  restaurants: z.array(AccessibleRestaurantSchema),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string(),
  me: MeResponseSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// ---------------------------------------------------------------- menu

export const ModifierOptionViewSchema = z.object({
  id: uuid,
  name: z.string(),
  priceDeltaCents: cents,
});
export const ModifierGroupViewSchema = z.object({
  id: uuid,
  name: z.string(),
  minSelect: z.number().int(),
  maxSelect: z.number().int(),
  options: z.array(ModifierOptionViewSchema),
});
export type ModifierGroupView = z.infer<typeof ModifierGroupViewSchema>;

export const ComboComponentViewSchema = z.object({
  id: uuid,
  name: z.string(),
  quantity: z.number().int(),
  modifierGroups: z.array(ModifierGroupViewSchema),
});

export const MenuItemViewSchema = z.object({
  id: uuid,
  productId: uuid,
  name: z.string(),
  description: z.string(),
  category: z.string(),
  kind: z.enum(['item', 'combo']),
  priceCents: cents,
  available: z.boolean(),
  allergens: z.array(z.string()),
  energyKj: z.number().int().nullable(),
  imageUrl: z.string().nullable(),
  modifierGroups: z.array(ModifierGroupViewSchema),
  components: z.array(ComboComponentViewSchema),
});
export type MenuItemView = z.infer<typeof MenuItemViewSchema>;

export const PublicRestaurantSchema = z.object({
  slug: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  timezone: z.string(),
});
export type PublicRestaurant = z.infer<typeof PublicRestaurantSchema>;

export const MenuResponseSchema = z.object({
  restaurant: PublicRestaurantSchema.extend({
    currency: z.string(),
    openingHours: z.record(z.string(), z.tuple([z.string(), z.string()])),
  }),
  menuVersionId: uuid,
  items: z.array(MenuItemViewSchema),
});
export type MenuResponse = z.infer<typeof MenuResponseSchema>;

// ---------------------------------------------------------------- orders

export const OrderChannelSchema = z.enum(['web', 'pos', 'kiosk', 'drive_thru']);
export const FulfilmentTypeSchema = z.enum(['dine_in', 'takeaway', 'pickup', 'drive_thru']);

export const OrderLineInputSchema = z.object({
  menuItemId: uuid,
  quantity: z.number().int().min(1).max(50),
  modifierOptionIds: z.array(uuid).max(20).default([]),
  components: z
    .array(z.object({ componentId: uuid, modifierOptionIds: z.array(uuid).max(20).default([]) }))
    .max(10)
    .default([]),
});
export type OrderLineInput = z.input<typeof OrderLineInputSchema>;

/** Note the absence of any price field: prices are computed on the server. */
export const CreateOrderRequestSchema = z.object({
  fulfilmentType: FulfilmentTypeSchema,
  customerName: z.string().trim().min(1).max(60).optional(),
  lines: z.array(OrderLineInputSchema).min(1).max(40),
});
export type CreateOrderRequest = z.input<typeof CreateOrderRequestSchema>;

export const StaffCreateOrderRequestSchema = CreateOrderRequestSchema.extend({
  channel: OrderChannelSchema.default('pos'),
});

/**
 * Card payments accept only a provider token produced client-side by the
 * (sandbox) payment SDK. Anything resembling a card number is rejected.
 */
export const PayOrderRequestSchema = z.object({
  method: z.literal('card'),
  paymentToken: z.string().regex(/^tok_[a-z0-9_]{3,64}$/, 'Expected a payment provider token'),
});
export type PayOrderRequest = z.infer<typeof PayOrderRequestSchema>;

export const OrderStatusSchema = z.enum([
  'pending_payment',
  'accepted',
  'in_preparation',
  'ready',
  'completed',
  'cancelled',
]);
export type OrderStatusView = z.infer<typeof OrderStatusSchema>;

export const KitchenTaskStatusSchema = z.enum(['queued', 'in_progress', 'done', 'cancelled']);

export const OrderLineViewSchema = z.object({
  id: uuid,
  name: z.string(),
  kind: z.enum(['item', 'combo', 'component']),
  quantity: z.number().int(),
  unitPriceCents: cents,
  lineTotalCents: cents,
  modifiers: z.array(z.object({ name: z.string(), priceDeltaCents: cents })),
  components: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      quantity: z.number().int(),
      modifiers: z.array(z.object({ name: z.string(), priceDeltaCents: cents })),
    }),
  ),
});

export const OrderViewSchema = z.object({
  id: uuid,
  orderNumber: z.number().int(),
  businessDate: z.string(),
  restaurantId: uuid,
  restaurantName: z.string(),
  channel: z.string(),
  fulfilmentType: z.string(),
  status: OrderStatusSchema,
  customerName: z.string().nullable(),
  currency: z.string(),
  subtotalCents: cents,
  discountCents: cents,
  taxCents: cents,
  totalCents: cents,
  placedAt: z.string(),
  acceptedAt: z.string().nullable(),
  readyAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  publicToken: z.string().optional(),
  payment: z
    .object({
      status: z.string(),
      method: z.string(),
      amountCents: cents,
      cardBrand: z.string().nullable(),
      cardLast4: z.string().nullable(),
      failureReason: z.string().nullable(),
    })
    .nullable(),
  lines: z.array(OrderLineViewSchema),
  tasks: z.array(
    z.object({
      id: uuid,
      label: z.string(),
      stationName: z.string(),
      status: KitchenTaskStatusSchema,
    }),
  ),
});
export type OrderView = z.infer<typeof OrderViewSchema>;

export const CancelOrderRequestSchema = z.object({ reason: z.string().trim().min(3).max(500) });

// ---------------------------------------------------------------- kitchen

export const KitchenTaskViewSchema = z.object({
  id: uuid,
  orderId: uuid,
  orderNumber: z.number().int(),
  fulfilmentType: z.string(),
  customerName: z.string().nullable(),
  stationId: uuid,
  stationCode: z.string(),
  label: z.string(),
  quantity: z.number().int(),
  modifiers: z.array(z.string()),
  instructions: z.string(),
  status: KitchenTaskStatusSchema,
  version: z.number().int(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type KitchenTaskView = z.infer<typeof KitchenTaskViewSchema>;

export const StationViewSchema = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  stationTypes: z.array(z.string()),
});
export type StationView = z.infer<typeof StationViewSchema>;

export const TaskCommandSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------- inventory

export const StockBalanceViewSchema = z.object({
  inventoryItemId: uuid,
  sku: z.string(),
  name: z.string(),
  baseUnit: z.string(),
  category: z.string(),
  onHand: z.string(),
  reserved: z.string(),
  available: z.string(),
});
export type StockBalanceView = z.infer<typeof StockBalanceViewSchema>;

export const StockMovementViewSchema = z.object({
  id: uuid,
  sku: z.string(),
  name: z.string(),
  movementType: z.string(),
  quantityDelta: z.string(),
  sourceType: z.string(),
  sourceId: uuid,
  occurredAt: z.string(),
  businessDate: z.string(),
});
export type StockMovementView = z.infer<typeof StockMovementViewSchema>;

// ---------------------------------------------------------------- live events

/** Minimal notification pushed to live screens; clients refetch authoritative state. */
export const LiveEventSchema = z.object({
  seq: z.number().int(),
  type: z.string(),
  aggregateType: z.string(),
  aggregateId: uuid,
});
export type LiveEvent = z.infer<typeof LiveEventSchema>;
