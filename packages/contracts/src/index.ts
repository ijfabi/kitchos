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
  /** What the line cost after the order discount: what refunding all of it returns. */
  netCents: cents,
  /** Units already refunded by item. */
  refundedQuantity: z.number().int(),
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

/**
 * Portions of prepared food to record as waste, per order line, when cancelling or refunding.
 * When given, it is the whole answer: unlisted lines record none. When omitted, the default
 * applies: all prepared portions for a cancellation; by reason for a refund.
 */
export const PreparedWasteInputSchema = z
  .array(z.object({ orderLineId: uuid, quantity: z.number().int().min(0).max(100) }))
  .max(40)
  .refine(
    (ls) => new Set(ls.map((l) => l.orderLineId)).size === ls.length,
    'Each line may appear once',
  );
export type PreparedWasteInput = z.input<typeof PreparedWasteInputSchema>;

/** A prepared order line and how many of its portions can still be recorded as waste. */
export const PreparedItemViewSchema = z.object({
  orderLineId: uuid,
  name: z.string(),
  quantity: z.number().int(),
  remaining: z.number().int(),
});
export type PreparedItemView = z.infer<typeof PreparedItemViewSchema>;

export const PreparedItemsViewSchema = z.object({
  /** Echo it back as preparedVersion: the request is refused if the list has changed since. */
  version: z.string(),
  items: z.array(PreparedItemViewSchema),
});
export type PreparedItemsView = z.infer<typeof PreparedItemsViewSchema>;

export const CancelOrderRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  waste: PreparedWasteInputSchema.optional(),
  preparedVersion: z.string().min(1).max(64).optional(),
});

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

/** What crew may pick from when recording waste: names only, no stock levels or costs. */
export const WasteItemViewSchema = z.object({
  inventoryItemId: uuid,
  sku: z.string(),
  name: z.string(),
  baseUnit: z.string(),
  category: z.string(),
});
export type WasteItemView = z.infer<typeof WasteItemViewSchema>;

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
  recordedById: uuid,
  reviewedBy: z.string().nullable(),
  reviewReason: z.string().nullable(),
  stationName: z.string().nullable(),
  /** The order the wasted item came from, when it was recorded against an order line. */
  orderId: uuid.nullable(),
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

// ---------------------------------------------------------------- stock transfers (ADR-0019)

const uniqueItems = (ls: { inventoryItemId: string }[]) =>
  new Set(ls.map((l) => l.inventoryItemId)).size === ls.length;

export const StockTransferRequestSchema = z.object({
  toRestaurantId: uuid,
  notes: z.string().trim().min(1).max(500).optional(),
  lines: z
    .array(z.object({ inventoryItemId: uuid, quantity: decimalQty }))
    .min(1)
    .max(200)
    .refine(uniqueItems, 'Each item may appear once'),
});
export type StockTransferRequest = z.input<typeof StockTransferRequestSchema>;

/** What arrived, for every line of the transfer (zero when nothing did). */
export const ReceiveTransferRequestSchema = z.object({
  notes: z.string().trim().min(1).max(500).optional(),
  lines: z
    .array(z.object({ inventoryItemId: uuid, quantityReceived: decimalQtyOrZero }))
    .min(1)
    .max(200)
    .refine(uniqueItems, 'Each item may appear once'),
});
export type ReceiveTransferRequest = z.input<typeof ReceiveTransferRequestSchema>;

const TransferPartySchema = z.object({ id: uuid, name: z.string() });

export const StockTransferViewSchema = z.object({
  id: uuid,
  status: z.enum(['in_transit', 'received']),
  from: TransferPartySchema,
  to: TransferPartySchema,
  dispatchedBy: z.string(),
  dispatchedAt: z.string(),
  dispatchBusinessDate: z.string(),
  notes: z.string().nullable(),
  receivedBy: z.string().nullable(),
  receivedAt: z.string().nullable(),
  receiveBusinessDate: z.string().nullable(),
  receiveNotes: z.string().nullable(),
  /** Value that left the sender, at the dispatch's recorded cost. */
  sentCents: cents,
  /** Value that arrived and was short; null until received. */
  receivedCents: cents.nullable(),
  shortageCents: cents.nullable(),
  lines: z.array(
    z.object({
      inventoryItemId: uuid,
      sku: z.string(),
      name: z.string(),
      baseUnit: z.string(),
      quantitySent: z.string(),
      quantityReceived: z.string().nullable(),
    }),
  ),
});
export type StockTransferView = z.infer<typeof StockTransferViewSchema>;

export const TransferDestinationSchema = TransferPartySchema;
export type TransferDestination = z.infer<typeof TransferDestinationSchema>;

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
  /** Σ value recorded on that day's stock movements vs the journal's net change in Inventory. */
  stockMovementsValueCents: cents,
  journalInventoryCents: cents,
  /** Card payments less card refunds vs the net change in Card clearing from receipts and refunds. */
  cardNetCents: cents,
  journalCardClearingCents: cents,
  /** Cash taken less cash refunded (with rounding) vs the net change in Cash on hand from them. */
  cashNetCents: cents,
  journalCashOnHandCents: cents,
  /** Cash rounding on payments less refunds vs the journal's Cash rounding from them. */
  cashRoundingCents: cents,
  journalCashRoundingCents: cents,
  /** Receipt and refund entries that do not belong to a source of that amount and day. */
  unmatchedReceipts: z.number().int().nonnegative(),
  unmatchedRefunds: z.number().int().nonnegative(),
  /** Σ variance of drawers closed for that day vs the journal's Cash over/short (over is positive). */
  drawerVarianceCents: cents,
  journalCashOverShortCents: cents,
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

export const RefundRequestSchema = z
  .object({
    /**
     * Items to refund in full: order lines (an item, or a whole meal) and how many of each. The
     * amount is then their net price, worked out by the server, and their prepared food is
     * recorded as waste. Leave out for a refund by amount.
     */
    items: z
      .array(z.object({ orderLineId: uuid, quantity: z.number().int().min(1).max(50) }))
      .min(1)
      .max(40)
      .refine(
        (ls) => new Set(ls.map((l) => l.orderLineId)).size === ls.length,
        'Each line may appear once',
      )
      .optional(),
    /** What the screen showed for the items; refused with 409 if the price has changed since. */
    expectedAmountCents: z.number().int().min(0).max(10_000_000).optional(),
    /** A refund by amount (e.g. a duplicate charge); defaults to everything still refundable. */
    amountCents: z.number().int().min(1).max(10_000_000).optional(),
    reason: z.enum(REFUND_REASONS),
    note: z.string().trim().max(500).optional(),
    /** Cash refunds: defaults to the refunder's own open drawer session. */
    drawerSessionId: uuid.optional(),
    /**
     * Prepared food to record as waste, entered by hand. When omitted: the refunded items' food for
     * a refund by item, none for a refund by amount.
     */
    waste: PreparedWasteInputSchema.optional(),
    preparedVersion: z.string().min(1).max(64).optional(),
  })
  .refine((r) => !(r.items && r.amountCents !== undefined), {
    message: 'Refund by items or by amount, not both',
  })
  .refine((r) => !(r.items && r.reason === 'duplicate_charge'), {
    message: 'A duplicate charge is refunded by amount: no food came back',
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
  /** The items refunded, for a refund by item; empty for a refund by amount. */
  items: z.array(z.object({ name: z.string(), quantity: z.number().int(), amountCents: cents })),
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

export const CreateDrawerRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,32}$/),
  name: z.string().trim().min(2).max(60),
});

/** A drawer as an administrator sees it, including retired ones. */
export const DrawerAdminViewSchema = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
  inUse: z.boolean(),
});
export type DrawerAdminView = z.infer<typeof DrawerAdminViewSchema>;

// ---------------------------------------------------------------- business-day close

export const CloseDayRequestSchema = z.object({
  notes: z.string().trim().min(1).max(500).optional(),
});

export const DayCloseIssueSchema = z.object({ code: z.string(), message: z.string() });
export type DayCloseIssue = z.infer<typeof DayCloseIssueSchema>;

export const DayCloseTotalsSchema = z.object({
  netSalesCents: cents,
  gstCents: cents,
  /** Cash actually collected, including rounding: what the drawers' expected cash uses. */
  cashTakenCents: cents,
  cardTakenCents: cents,
  /** Net effect of cash rounding on revenue. */
  cashRoundingCents: cents,
  /** All refunds, by the amount owed to customers. */
  refundsCents: cents,
  /** Cash actually handed back, including rounding. */
  cashRefundsCents: cents,
  cogsCents: cents,
  wasteCents: cents,
  stockVarianceCents: cents,
  /** Stock sent here that did not arrive (ADR-0019). Absent on days closed before transfers existed. */
  transferShortageCents: cents.optional(),
  /** Positive when drawers came up short. */
  cashOverShortCents: cents,
  pettyCashCents: cents,
});
export type DayCloseTotals = z.infer<typeof DayCloseTotalsSchema>;

export const DayDrawerResultSchema = z.object({
  sessionId: uuid,
  drawerName: z.string(),
  openedBy: z.string(),
  status: z.enum(['open', 'pending_approval', 'closed']),
  openingFloatCents: cents,
  /** Null until the drawer is counted: an open drawer stays blind. */
  expectedCents: cents.nullable(),
  countedCents: cents.nullable(),
  varianceCents: cents.nullable(),
});
export type DayDrawerResult = z.infer<typeof DayDrawerResultSchema>;

export const DayCloseViewSchema = z.object({
  businessDate: z.string(),
  currentBusinessDate: z.string(),
  status: z.enum(['open', 'closed']),
  /** Anything here stops the day closing; the server enforces the same list. */
  blockers: z.array(DayCloseIssueSchema),
  warnings: z.array(DayCloseIssueSchema),
  /** Live for an open day (managers see them at any time, R-028); as recorded for a closed one. */
  totals: DayCloseTotalsSchema,
  drawers: z.array(DayDrawerResultSchema),
  closedBy: z.string().nullable(),
  closedAt: z.string().nullable(),
  notes: z.string().nullable(),
});
export type DayCloseView = z.infer<typeof DayCloseViewSchema>;

// ---------------------------------------------------------------- shifts

/** What was recorded under the shift: rows written while it was open are stamped with it (ADR-0018). */
export const ShiftTotalsSchema = z.object({
  /** Orders placed during the shift, cancelled ones included. */
  ordersPlaced: z.number().int(),
  ordersCancelled: z.number().int(),
  /** Card payments captured during the shift. */
  cardTakenCents: cents,
  /** Cash collected (with rounding) and cash refunded; null while any of its drawers is uncounted. */
  cashTakenCents: cents.nullable(),
  cashRefundsCents: cents.nullable(),
  /** All refunds made during the shift, any tender. */
  refundsCents: cents,
  /** Discounts and comps applied during the shift (GST inclusive). */
  discountsCents: cents,
  /** Σ variance of its drawers; null while any is uncounted. */
  cashVarianceCents: cents.nullable(),
});
export type ShiftTotals = z.infer<typeof ShiftTotalsSchema>;

export const ShiftDrawerSchema = z.object({
  sessionId: uuid,
  drawerName: z.string(),
  cashier: z.string(),
  status: z.enum(['open', 'pending_approval', 'closed']),
  openingFloatCents: cents,
  /** From the count's snapshot: empty until counted, so the cashier still counts blind. */
  expectedCents: cents.nullable(),
  countedCents: cents.nullable(),
  varianceCents: cents.nullable(),
  approvedBy: z.string().nullable(),
});
export type ShiftDrawer = z.infer<typeof ShiftDrawerSchema>;

/** One person's part in the shift. */
export const ShiftPersonSchema = z.object({
  userId: uuid,
  name: z.string(),
  ordersPlaced: z.number().int(),
  /**
   * Their orders placed during the shift that were paid and not cancelled (GST inclusive); null
   * while any drawer of the shift is uncounted (it would reveal a till's expected cash).
   */
  salesCents: cents.nullable(),
  discountsCents: cents,
  refundsCents: cents,
  /** Σ variance of the drawers they ran; null if they ran none or one is uncounted. */
  cashVarianceCents: cents.nullable(),
});
export type ShiftPerson = z.infer<typeof ShiftPersonSchema>;

export const ShiftViewSchema = z.object({
  id: uuid,
  status: z.enum(['open', 'closed']),
  businessDate: z.string(),
  openedBy: z.string(),
  openedAt: z.string(),
  closedBy: z.string().nullable(),
  closedAt: z.string().nullable(),
  notes: z.string().nullable(),
  /** Empty once closed. */
  blockers: z.array(DayCloseIssueSchema),
  warnings: z.array(DayCloseIssueSchema),
  /** Live while open; as recorded at the close once closed. */
  totals: ShiftTotalsSchema,
  drawers: z.array(ShiftDrawerSchema),
  people: z.array(ShiftPersonSchema),
});
export type ShiftView = z.infer<typeof ShiftViewSchema>;

export const CurrentShiftSchema = z.object({ shift: ShiftViewSchema.nullable() });
export type CurrentShift = z.infer<typeof CurrentShiftSchema>;

export const CloseShiftRequestSchema = z.object({
  notes: z.string().trim().min(1).max(500).optional(),
});

// ---------------------------------------------------------------- food cost

const foodCostFigures = {
  netSalesCents: cents,
  /**
   * Cost of food produced (COGS): consumption at standard cost, dated by when it was made. It
   * includes food later cancelled, comped or refunded, so it is not a recipe-to-price ratio.
   */
  cogsCents: cents,
  wasteCents: cents,
  /** Stock count shortfall; negative when a count found more than the books. */
  stockVarianceCents: cents,
  /** COGS + waste + stock count shortfall. */
  actualFoodCostCents: cents,
  /** Net sales less actual food cost. */
  grossProfitCents: cents,
  /** Shares of net sales in basis points, rounded half away from zero; null without positive sales. */
  cogsBps: z.number().int().nullable(),
  actualFoodCostBps: z.number().int().nullable(),
  grossMarginBps: z.number().int().nullable(),
  /**
   * Recipe cost of what was sold: the cost sold lines were consumed at, on the day the sale posted,
   * less items refunded by item that day. Comps count here at zero revenue. Its share of net sales
   * is the theoretical food cost.
   */
  soldRecipeCents: cents,
  theoreticalFoodCostBps: z.number().int().nullable(),
  /**
   * COGS less recipe cost of sales: produced but not sold that day, e.g. cancelled food kept in COGS,
   * or cooked on one day and sold on another (then negative on the selling day). A refund by amount
   * that records waste also makes it negative. Read it over a range, not a single day.
   */
  unsoldProductionCents: cents,
};

export const FoodCostReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  days: z.array(
    z.object({
      businessDate: z.string(),
      /** Closed days are final; open ones can still change. */
      closed: z.boolean(),
      ...foodCostFigures,
    }),
  ),
  /** Computed from the summed figures, not by averaging the days' percentages. */
  totals: z.object(foodCostFigures),
});
export type FoodCostReport = z.infer<typeof FoodCostReportSchema>;

const itemFigures = {
  /** Units sold less units refunded by item. */
  unitsSold: z.number().int(),
  /** Net price ex GST (after discount), less refunds by item. */
  netSalesCents: cents,
  /** What the units sold were consumed at (a meal: its components), less refunds by item. */
  recipeCostCents: cents,
  grossProfitCents: cents,
  /** Recipe cost as basis points of net sales; null without positive sales. */
  recipeCostBps: z.number().int().nullable(),
};

/** Food cost per menu item and category, dated like the food cost report. */
export const MenuItemReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  items: z.array(
    z.object({ productId: uuid, name: z.string(), category: z.string(), ...itemFigures }),
  ),
  categories: z.array(z.object({ category: z.string(), ...itemFigures })),
  /** Refunds by amount name no items, so they are not in any row (ex GST). */
  refundsByAmountCents: cents,
  /** Items less refunds by amount: equals the food cost report's net sales for the range. */
  totals: z.object({
    netSalesCents: cents,
    recipeCostCents: cents,
    grossProfitCents: cents,
    recipeCostBps: z.number().int().nullable(),
  }),
});
export type MenuItemReport = z.infer<typeof MenuItemReportSchema>;

/** An event the ledger gave up on after repeated failures. */
export const FailedEventViewSchema = z.object({
  eventId: uuid,
  eventType: z.string(),
  occurredAt: z.string(),
  attempts: z.number().int(),
  lastError: z.string(),
});
export type FailedEventView = z.infer<typeof FailedEventViewSchema>;
