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
    /** Cash totals round to this many cents (5 in Australia); card totals never round. */
    cashRoundingIncrementCents: z.number().int().positive(),
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

/** Staff-entered orders (POS / drive-thru). Kiosk and web orders come through their own channels. */
export const StaffCreateOrderRequestSchema = CreateOrderRequestSchema.extend({
  channel: z.enum(['pos', 'drive_thru']).default('pos'),
});
export type StaffCreateOrderRequest = z.input<typeof StaffCreateOrderRequestSchema>;

/**
 * Card payments accept only a provider token produced client-side by the
 * (sandbox) payment SDK. Anything resembling a card number is rejected.
 */
export const PayOrderRequestSchema = z.object({
  method: z.literal('card'),
  paymentToken: z.string().regex(/^tok_[a-z0-9_]{3,64}$/, 'Expected a payment provider token'),
});
export type PayOrderRequest = z.infer<typeof PayOrderRequestSchema>;

/** Payment taken by staff at a terminal: cash with tendered amount, or a sandbox card token. */
export const StaffPaymentRequestSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('cash'),
    tenderedCents: z.number().int().min(0).max(10_000_000),
    /** Defaults to the cashier's own open drawer session at this restaurant. */
    drawerSessionId: uuid.optional(),
  }),
  PayOrderRequestSchema,
]);
export type StaffPaymentRequest = z.infer<typeof StaffPaymentRequestSchema>;

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
  /** Amount due if paid in cash (total rounded to the restaurant increment). */
  cashDueCents: cents,
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
      tenderedCents: cents.nullable(),
      changeCents: cents.nullable(),
      cashRoundingCents: cents,
      refundedCents: cents,
    })
    .nullable(),
  lines: z.array(OrderLineViewSchema),
  discount: z.lazy(() => OrderDiscountViewSchema).nullable(),
  refunds: z.array(z.lazy(() => RefundViewSchema)),
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

// ---------------------------------------------------------------- inventory operations

/** Positive decimal quantity in the item's base unit, up to 3 decimal places. */
const decimalQty = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,3})?$/, 'Expected a decimal quantity with up to 3 decimals')
  .refine((s) => /[1-9]/.test(s), 'Quantity must be greater than zero');
const decimalQtyOrZero = z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, 'Expected a decimal quantity');

export const WASTE_REASONS = [
  'expired',
  'spoiled',
  'dropped',
  'spilled',
  'burnt',
  'incorrect_order',
  'poor_quality',
  'overproduction',
  'equipment_failure',
  'temperature_breach',
  'cancelled_prepared_order',
  'other',
] as const;
export const WasteReasonSchema = z.enum(WASTE_REASONS);

const wasteCommon = {
  reason: WasteReasonSchema,
  stationId: uuid.optional(),
  notes: z.string().trim().max(1000).optional(),
};

export const RecordWasteRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('raw_ingredient'),
    inventoryItemId: uuid,
    quantity: decimalQty,
    ...wasteCommon,
  }),
  z
    .object({
      kind: z.literal('prepared_item'),
      /** The order line whose prepared item was wasted (preferred: enables exact recipe and no double deduction). */
      orderLineId: uuid.optional(),
      /** Or a menu item, for prepared food not tied to an order (e.g. overproduction). */
      menuItemId: uuid.optional(),
      quantity: z.number().int().min(1).max(100),
      /** Remake the item for the same order line (consumes a fresh portion). */
      remake: z.boolean().default(false),
      ...wasteCommon,
    })
    .refine((v) => (v.orderLineId ? 1 : 0) + (v.menuItemId ? 1 : 0) === 1, {
      message: 'Provide exactly one of orderLineId or menuItemId',
    })
    .refine((v) => !v.remake || !!v.orderLineId, { message: 'Remake requires an orderLineId' }),
]);
export type RecordWasteRequest = z.input<typeof RecordWasteRequestSchema>;

export const ReviewWasteRequestSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const WasteRecordViewSchema = z.object({
  id: uuid,
  kind: z.enum(['raw_ingredient', 'prepared_item']),
  itemName: z.string(),
  quantity: z.string(),
  reason: WasteReasonSchema,
  remake: z.boolean(),
  costCents: cents,
  status: z.enum(['recorded', 'pending_approval', 'approved', 'rejected']),
  recordedBy: z.string(),
  reviewedBy: z.string().nullable(),
  reviewReason: z.string().nullable(),
  stationName: z.string().nullable(),
  notes: z.string().nullable(),
  businessDate: z.string(),
  occurredAt: z.string(),
  lines: z.array(
    z.object({
      sku: z.string(),
      name: z.string(),
      quantity: z.string(),
      treatment: z.enum(['deducted_now', 'already_consumed']),
      costCents: cents,
    }),
  ),
});
export type WasteRecordView = z.infer<typeof WasteRecordViewSchema>;

export const WasteSummarySchema = z.object({
  from: z.string(),
  to: z.string(),
  totalCostCents: cents,
  /** Cost of waste whose ingredients were already in production consumption (reclassified, not double counted). */
  reclassifiedFromConsumptionCents: cents,
  /** Cost of waste that removed stock directly. */
  deductedDirectlyCents: cents,
  byReason: z.array(z.object({ reason: z.string(), records: z.number().int(), costCents: cents })),
  byStation: z.array(
    z.object({ station: z.string(), records: z.number().int(), costCents: cents }),
  ),
  byEmployee: z.array(
    z.object({ employee: z.string(), records: z.number().int(), costCents: cents }),
  ),
});
export type WasteSummary = z.infer<typeof WasteSummarySchema>;

export const GoodsReceiptRequestSchema = z.object({
  supplierName: z.string().trim().max(120).optional(),
  reference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z
    .array(
      z.object({
        inventoryItemId: uuid,
        quantity: decimalQty,
        unitCost: z
          .string()
          .regex(/^\d{1,10}(\.\d{1,6})?$/)
          .optional(),
        lotCode: z.string().trim().max(64).optional(),
        expiresOn: z.iso.date().optional(),
      }),
    )
    .min(1)
    .max(200)
    .refine(
      (ls) => new Set(ls.map((l) => l.inventoryItemId)).size === ls.length,
      'Each item may appear once',
    ),
});
export type GoodsReceiptRequest = z.input<typeof GoodsReceiptRequestSchema>;

export const StockCountRequestSchema = z.object({
  notes: z.string().trim().max(1000).optional(),
  lines: z
    .array(z.object({ inventoryItemId: uuid, counted: decimalQtyOrZero }))
    .min(1)
    .max(500)
    .refine(
      (ls) => new Set(ls.map((l) => l.inventoryItemId)).size === ls.length,
      'Each item may appear once',
    ),
});
export type StockCountRequest = z.input<typeof StockCountRequestSchema>;

export const StockCountViewSchema = z.object({
  id: uuid,
  businessDate: z.string(),
  varianceCents: cents,
  approvedBy: z.string().nullable(),
  lines: z.array(
    z.object({
      sku: z.string(),
      name: z.string(),
      expected: z.string(),
      counted: z.string(),
      variance: z.string(),
      varianceCents: cents,
    }),
  ),
});
export type StockCountView = z.infer<typeof StockCountViewSchema>;

export const GoodsReceiptViewSchema = z.object({
  id: uuid,
  businessDate: z.string(),
  lines: z.array(z.object({ sku: z.string(), name: z.string(), quantity: z.string() })),
});
export type GoodsReceiptView = z.infer<typeof GoodsReceiptViewSchema>;

// ---------------------------------------------------------------- discounts & manager overrides

export const DISCOUNT_REASONS = [
  'customer_service',
  'promotion',
  'staff_meal',
  'complimentary',
  'price_match',
  'other',
] as const;

export const ApplyDiscountRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('percent'),
    /** Basis points: 1000 = 10%, 10000 = 100%. */
    value: z.number().int().min(1).max(10_000),
    reason: z.enum(DISCOUNT_REASONS),
    note: z.string().trim().max(500).optional(),
    overrideToken: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
  z.object({
    kind: z.literal('amount'),
    /** Cents off the order. */
    value: z.number().int().min(1).max(10_000_000),
    reason: z.enum(DISCOUNT_REASONS),
    note: z.string().trim().max(500).optional(),
    overrideToken: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
]);
export type ApplyDiscountRequest = z.input<typeof ApplyDiscountRequestSchema>;

/** A manager re-authenticates at the terminal to authorise one action for one order. */
export const CreateOverrideRequestSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
  action: z.literal('order.discount'),
  orderId: uuid,
  /** The exact discount being approved; the override only authorises this discount. */
  discount: z.object({
    kind: z.enum(['percent', 'amount']),
    value: z.number().int().min(1).max(10_000_000),
    reason: z.enum(DISCOUNT_REASONS),
  }),
});
export type CreateOverrideRequest = z.infer<typeof CreateOverrideRequestSchema>;

export const OverrideResponseSchema = z.object({
  overrideToken: z.string(),
  expiresAt: z.string(),
  approverName: z.string(),
  /** Amount the approver authorised, computed by the server. */
  discountCents: cents,
});
export type OverrideResponse = z.infer<typeof OverrideResponseSchema>;

export const OrderDiscountViewSchema = z.object({
  kind: z.enum(['percent', 'amount']),
  value: z.number().int(),
  amountCents: cents,
  reason: z.enum(DISCOUNT_REASONS),
  appliedBy: z.string(),
  approvedBy: z.string(),
  viaOverride: z.boolean(),
});
export type OrderDiscountView = z.infer<typeof OrderDiscountViewSchema>;

// ---------------------------------------------------------------- accounting

export const JournalEntryViewSchema = z.object({
  id: uuid,
  businessDate: z.string(),
  entryType: z.string(),
  description: z.string(),
  sourceType: z.string(),
  sourceId: uuid,
  postedAt: z.string(),
  lines: z.array(
    z.object({
      accountCode: z.string(),
      accountName: z.string(),
      debitCents: cents,
      creditCents: cents,
      memo: z.string().nullable(),
    }),
  ),
});
export type JournalEntryView = z.infer<typeof JournalEntryViewSchema>;

export const TrialBalanceSchema = z.object({
  from: z.string(),
  to: z.string(),
  accounts: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      type: z.string(),
      debitCents: cents,
      creditCents: cents,
      /** Positive = balance on the account's normal side. */
      balanceCents: cents,
    }),
  ),
  totalDebitCents: cents,
  totalCreditCents: cents,
  balanced: z.boolean(),
});
export type TrialBalance = z.infer<typeof TrialBalanceSchema>;

export const LedgerReconciliationSchema = z.object({
  businessDate: z.string(),
  /** Σ(total − GST) of orders handed over that business day. */
  completedOrdersNetCents: cents,
  /** Net sales posted to the journal (revenue − discounts) for that day. */
  journalNetSalesCents: cents,
  /** Σ captured payments that business day. */
  capturedPaymentsCents: cents,
  /** Customer deposits credited by payment receipts that day. */
  journalReceiptsCents: cents,
  /** GST on orders handed over vs GST payable posted. */
  completedOrdersGstCents: cents,
  journalGstCents: cents,
  /** Refunds made that business day vs refund amounts posted to the journal. */
  refundsCents: cents,
  journalRefundsCents: cents,
  /** Events for this restaurant the ledger has not processed yet. */
  pendingEvents: z.number().int(),
  deadLetteredEvents: z.number().int(),
  reconciled: z.boolean(),
});
export type LedgerReconciliation = z.infer<typeof LedgerReconciliationSchema>;

// ---------------------------------------------------------------- refunds

export const REFUND_REASONS = [
  'cancelled_order',
  'order_error',
  'quality',
  'customer_complaint',
  'duplicate_charge',
  'other',
] as const;

export const RefundRequestSchema = z.object({
  /** Cents to refund; defaults to everything still refundable on the payment. */
  amountCents: z.number().int().min(1).max(10_000_000).optional(),
  reason: z.enum(REFUND_REASONS),
  note: z.string().trim().max(500).optional(),
  /** Cash refunds: defaults to the refunder's own open drawer session. */
  drawerSessionId: uuid.optional(),
});
export type RefundRequest = z.input<typeof RefundRequestSchema>;

export const RefundViewSchema = z.object({
  id: uuid,
  method: z.enum(['card', 'cash']),
  amountCents: cents,
  /** Cash actually handed back (amount plus cash rounding). */
  cashReturnedCents: cents.nullable(),
  treatment: z.enum(['deposit_release', 'sales_return']),
  reason: z.enum(REFUND_REASONS),
  requestedBy: z.string(),
  createdAt: z.string(),
});
export type RefundView = z.infer<typeof RefundViewSchema>;

// ---------------------------------------------------------------- cash drawers

export const OpenDrawerSessionRequestSchema = z.object({
  openingFloatCents: z.number().int().min(0).max(1_000_000),
});

export const DrawerMovementRequestSchema = z.object({
  kind: z.enum(['paid_in', 'paid_out', 'safe_drop']),
  amountCents: z.number().int().min(1).max(1_000_000),
  reason: z.string().trim().min(3).max(200),
});
export type DrawerMovementRequest = z.infer<typeof DrawerMovementRequestSchema>;

/** Blind count: the cashier states what they counted without seeing what was expected. */
export const DrawerCountRequestSchema = z.object({
  countedCents: z.number().int().min(0).max(10_000_000),
  notes: z.string().trim().max(500).optional(),
});

export const DrawerApproveRequestSchema = z.object({ notes: z.string().trim().min(3).max(500) });

export const DrawerSessionViewSchema = z.object({
  id: uuid,
  drawerId: uuid,
  drawerName: z.string(),
  status: z.enum(['open', 'pending_approval', 'closed']),
  openedBy: z.string(),
  openedById: uuid,
  openedAt: z.string(),
  businessDate: z.string(),
  openingFloatCents: cents,
  /**
   * Expected cash and its breakdown are hidden while a session is open unless
   * the viewer may manage cash (blind counting).
   */
  expected: z
    .object({
      cashSalesCents: cents,
      cashRefundsCents: cents,
      paidInsCents: cents,
      paidOutsCents: cents,
      safeDropsCents: cents,
      expectedCents: cents,
    })
    .nullable(),
  countedCents: cents.nullable(),
  varianceCents: cents.nullable(),
  countedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  closedAt: z.string().nullable(),
  movements: z.array(
    z.object({
      id: uuid,
      kind: z.string(),
      amountCents: cents,
      reason: z.string(),
      recordedBy: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export type DrawerSessionView = z.infer<typeof DrawerSessionViewSchema>;

export const DrawerViewSchema = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  activeSession: z
    .object({ id: uuid, status: z.string(), openedBy: z.string(), openedById: uuid })
    .nullable(),
});
export type DrawerView = z.infer<typeof DrawerViewSchema>;
