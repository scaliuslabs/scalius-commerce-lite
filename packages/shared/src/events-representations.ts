// Sealed event representations (COMMERCE-HOOKS H5): the `data` of a webhook
// delivery, one schema per resource type under `EVENTS_API_VERSION`. Part of
// the public webhook API: within a version a representation only gains
// fields (events.representations.snapshot.json and its additive check gate
// it); a field is never removed, retyped or made nullable.
//
// Representations are resource-shaped, not dashboard-shaped: ids, states,
// ISO 8601 times, money as integer minor units beside its ISO 4217 currency,
// lines by id and quantity. Buyer contact fields are marked
// `x-scalius-protected` and read null unless the subscription opted in to
// their category (`customerData`). A receiver that needs more reads the
// resource through the API (the truncation shape names the operation).

import { z } from "zod";
import { PROTECTED_FIELD_KEYWORD, protectedPathsOf, redactProtectedData, type ProtectedCustomerData, type ProtectedPath } from "./plugins/protected-data";

const id = z.string().min(1).max(128);
const text = z.string().max(4000);
const state = z.string().min(1).max(64);
const iso = z.string().min(1).max(40);
const minor = z.number().int();
const currency = z.string().length(3);

function pii<T extends z.ZodType>(category: ProtectedCustomerData | readonly ProtectedCustomerData[], schema: T): T {
  return schema.meta({ [PROTECTED_FIELD_KEYWORD]: typeof category === "string" ? category : [...category] }) as T;
}

/** A postal address: the street and recipient are protected, the region is not. */
const postalAddressSchema = z.object({
  name: pii("name", text.nullable()),
  phone: pii("phone", text.nullable()),
  company: pii("address", text.nullable()),
  line1: pii("address", text.nullable()),
  line2: pii("address", text.nullable()),
  dependentLocality: pii("address", text.nullable()),
  locality: text.nullable(),
  adminArea: text.nullable(),
  postalCode: text.nullable(),
  /** ISO 3166-1 alpha-2. */
  countryCode: z.string().length(2).nullable(),
  /** The store's delivery place ids (Bangladesh City, Thana, Area). */
  placeIds: z.object({ city: id.nullable(), zone: id.nullable(), area: id.nullable() }),
});

const orderLineSchema = z.object({
  id,
  productId: id,
  variantId: id.nullable(),
  title: text.nullable(),
  variantLabel: text.nullable(),
  quantity: z.number().int(),
  fulfilledQuantity: z.number().int(),
  unitPriceMinor: minor,
  subtotalMinor: minor,
  discountMinor: minor,
  taxMinor: minor,
});

export const orderRepresentationSchema = z.object({
  id,
  orderNumber: z.number().int().nullable(),
  status: state,
  paymentStatus: state,
  fulfillmentStatus: state,
  channel: state,
  salesChannelId: id,
  marketId: id.nullable(),
  currency,
  subtotalMinor: minor,
  shippingMinor: minor,
  discountMinor: minor,
  taxMinor: minor,
  totalMinor: minor,
  paidMinor: minor,
  balanceDueMinor: minor,
  pricesIncludeTax: z.boolean(),
  paymentMethod: text.nullable(),
  customerId: id.nullable(),
  contact: z.object({
    name: pii("name", text.nullable()),
    email: pii("email", text.nullable()),
    phone: pii("phone", text.nullable()),
  }),
  requiresShipping: z.boolean(),
  shippingMethodId: id.nullable(),
  /** Null when nothing ships. */
  shippingAddress: postalAddressSchema.nullable(),
  /** Null when the shipping address bills too, or none was taken. */
  billingAddress: postalAddressSchema.nullable(),
  fulfillmentLocationId: id.nullable(),
  lines: z.array(orderLineSchema),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: iso.nullable(),
});

export const returnRepresentationSchema = z.object({
  id,
  orderId: id,
  status: state,
  reason: text,
  source: state,
  version: z.number().int(),
  requestedAt: iso,
  approvedAt: iso.nullable(),
  completedAt: iso.nullable(),
  rejectedAt: iso.nullable(),
  cancelledAt: iso.nullable(),
  lines: z.array(z.object({
    id,
    orderItemId: id,
    variantId: id.nullable(),
    requestedQuantity: z.number().int(),
    approvedQuantity: z.number().int(),
    receivedQuantity: z.number().int(),
    restockQuantity: z.number().int(),
    damagedQuantity: z.number().int(),
    rejectedQuantity: z.number().int(),
  })),
  createdAt: iso,
  updatedAt: iso,
});

export const productRepresentationSchema = z.object({
  id,
  name: text,
  slug: text,
  status: z.enum(["active", "draft", "trashed"]),
  brandId: id.nullable(),
  categoryId: id.nullable(),
  revision: z.number().int(),
  isGiftCard: z.boolean(),
  /** The product's selling price in the store currency (each SKU carries its own). */
  currency,
  priceMinor: minor,
  variants: z.array(z.object({
    id,
    sku: text,
    priceMinor: minor,
    barcode: text.nullable(),
    trackInventory: z.boolean(),
    fulfillmentKind: state,
    isDefault: z.boolean(),
  })),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: iso.nullable(),
});

/** `inventory.level_changed` is about one SKU: its on-hand units per location. */
export const variantRepresentationSchema = z.object({
  id,
  productId: id,
  sku: text,
  trackInventory: z.boolean(),
  onHand: z.number().int(),
  levels: z.array(z.object({ locationId: id, onHand: z.number().int() })),
  updatedAt: iso,
});

export const customerRepresentationSchema = z.object({
  id,
  name: pii("name", text.nullable()),
  email: pii("email", text.nullable()),
  phone: pii("phone", text.nullable()),
  hasAccount: z.boolean(),
  totalOrders: z.number().int(),
  lastOrderAt: iso.nullable(),
  mergedIntoCustomerId: id.nullable(),
  /** Marketing consent per channel; the address it was given for is protected. */
  consents: z.array(z.object({
    channel: state,
    state,
    contact: pii(["email", "phone"], text.nullable()),
    updatedAt: iso,
  })),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: iso.nullable(),
});

const stockDocumentLine = z.object({
  id,
  variantId: id,
  quantity: z.number().int(),
  receivedQuantity: z.number().int(),
});

export const purchaseOrderRepresentationSchema = z.object({
  id,
  number: z.number().int(),
  status: state,
  supplierId: id.nullable(),
  destinationLocationId: id,
  reference: text.nullable(),
  expectedOn: text.nullable(),
  currency,
  shippingMinor: minor,
  otherCostsMinor: minor,
  taxMinor: minor,
  revision: z.number().int(),
  lines: z.array(stockDocumentLine.extend({ unitCostMinor: minor })),
  orderedAt: iso.nullable(),
  receivedAt: iso.nullable(),
  cancelledAt: iso.nullable(),
  createdAt: iso,
  updatedAt: iso,
});

export const inventoryTransferRepresentationSchema = z.object({
  id,
  number: z.number().int(),
  status: state,
  originLocationId: id,
  destinationLocationId: id,
  reference: text.nullable(),
  expectedOn: text.nullable(),
  revision: z.number().int(),
  lines: z.array(stockDocumentLine.extend({ shippedQuantity: z.number().int(), returnedQuantity: z.number().int() })),
  shippedAt: iso.nullable(),
  receivedAt: iso.nullable(),
  cancelledAt: iso.nullable(),
  createdAt: iso,
  updatedAt: iso,
});

export const fulfillmentRepresentationSchema = z.object({
  id,
  orderId: id,
  kind: state,
  status: state,
  shipmentId: id.nullable(),
  locationId: id.nullable(),
  currency,
  cashCollectedMinor: minor.nullable(),
  lines: z.array(z.object({ id, orderItemId: id, quantity: z.number().int() })),
  createdAt: iso,
  voidedAt: iso.nullable(),
});

export const shipmentRepresentationSchema = z.object({
  id,
  orderId: id,
  /** A qualified app courier id (`<app id>:<provider id>`) or a built-in courier's. */
  providerId: id.nullable(),
  providerType: state,
  status: state,
  rawStatus: text.nullable(),
  externalId: text.nullable(),
  trackingId: text.nullable(),
  trackingUrl: text.nullable(),
  courierName: text.nullable(),
  currency,
  amountMinor: minor.nullable(),
  isFinal: z.boolean(),
  lastCheckedAt: iso.nullable(),
  createdAt: iso,
  updatedAt: iso,
});

export const paymentRepresentationSchema = z.object({
  id,
  orderId: id,
  status: state,
  method: text,
  type: state,
  currency,
  amountMinor: minor,
  settlementCurrency: currency,
  settlementAmountMinor: minor,
  providerRef: text.nullable(),
  createdAt: iso,
  updatedAt: iso,
});

export const checkoutRepresentationSchema = z.object({
  id,
  checkoutId: id,
  /** The buyer's phone when they gave one before leaving. */
  phone: pii("phone", text.nullable()),
  abandonedAt: iso.nullable(),
  createdAt: iso,
  updatedAt: iso,
});

export const discountRepresentationSchema = z.object({
  id,
  name: text,
  title: text.nullable(),
  method: state,
  status: state,
  priority: z.number().int(),
  revision: z.number().int(),
  /** How many codes it answers to (a code list can be thousands long: read them through the API). */
  codeCount: z.number().int(),
  startsAt: iso.nullable(),
  endsAt: iso.nullable(),
  maxRedemptions: z.number().int().nullable(),
  redemptions: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: iso.nullable(),
});

export const reviewRepresentationSchema = z.object({
  id,
  productId: id,
  variantId: id.nullable(),
  orderId: id.nullable(),
  customerId: id.nullable(),
  status: state,
  rating: z.number().int().min(1).max(5),
  title: text.nullable(),
  body: text.nullable(),
  /** The name the review is shown under (what the buyer chose to publish). */
  authorDisplayName: text.nullable(),
  publishedAt: iso.nullable(),
  repliedAt: iso.nullable(),
  version: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
});

export const giftCardRepresentationSchema = z.object({
  id,
  /** The last four characters; the code itself never leaves the store. */
  last4: z.string().max(8),
  status: state,
  currency,
  initialAmountMinor: minor,
  balanceMinor: minor,
  source: state,
  sourceOrderId: id.nullable(),
  customerId: id.nullable(),
  recipient: z.object({
    name: pii("name", text.nullable()),
    email: pii("email", text.nullable()),
    phone: pii("phone", text.nullable()),
  }),
  expiresAt: iso.nullable(),
  version: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
});

export const transactionRepresentationSchema = z.object({
  id,
  giftCardId: id,
  kind: state,
  currency,
  amountMinor: minor,
  balanceAfterMinor: minor,
  orderId: id.nullable(),
  actorType: state,
  createdAt: iso,
});

export const objectRepresentationSchema = z.object({
  id,
  type: z.string().min(1).max(192),
  handle: text.nullable(),
  status: state,
  revision: z.number().int(),
  /** The record's fields as its type declares them. */
  data: z.record(z.string(), z.unknown()),
  createdAt: iso,
  updatedAt: iso,
});

/** One sealed representation per resource type (`EVENT_TOPIC_RESOURCE`). */
export const EVENT_REPRESENTATION_SCHEMAS = {
  order: orderRepresentationSchema,
  return: returnRepresentationSchema,
  product: productRepresentationSchema,
  variant: variantRepresentationSchema,
  customer: customerRepresentationSchema,
  purchase_order: purchaseOrderRepresentationSchema,
  inventory_transfer: inventoryTransferRepresentationSchema,
  fulfillment: fulfillmentRepresentationSchema,
  shipment: shipmentRepresentationSchema,
  payment: paymentRepresentationSchema,
  checkout: checkoutRepresentationSchema,
  discount: discountRepresentationSchema,
  review: reviewRepresentationSchema,
  gift_card: giftCardRepresentationSchema,
  transaction: transactionRepresentationSchema,
  object: objectRepresentationSchema,
} as const;

export type EventRepresentationType = keyof typeof EVENT_REPRESENTATION_SCHEMAS;
export type EventRepresentation<T extends EventRepresentationType = EventRepresentationType> =
  z.output<(typeof EVENT_REPRESENTATION_SCHEMAS)[T]>;
export type EventRepresentationInput<T extends EventRepresentationType> =
  z.input<(typeof EVENT_REPRESENTATION_SCHEMAS)[T]>;

/**
 * What a delivery carries in `data` when the whole body would pass 512 KiB:
 * the resource id and where to read it. `data: null` only ever means the
 * resource no longer exists.
 */
export const eventDataTruncationSchema = z.object({
  truncated: z.literal(true),
  id,
  fetch: z.object({
    operationId: z.string().min(1).max(128),
    method: z.literal("GET"),
    path: z.string().min(1).max(512),
  }),
});
export type EventDataTruncation = z.output<typeof eventDataTruncationSchema>;

const segment = (value: unknown) => encodeURIComponent(typeof value === "string" ? value : "");

/** Where a receiver reads a resource the delivery could not carry (the admin API, under its API credential). */
const FETCH_HINTS: Record<EventRepresentationType, (resourceId: string, facts: Record<string, unknown>) => { operationId: string; path: string }> = {
  order: (resource) => ({ operationId: "dashboard.orders.get", path: `/api/v1/admin/orders/${segment(resource)}` }),
  return: (resource, facts) => ({ operationId: "dashboard.orders.return_get", path: `/api/v1/admin/orders/${segment(facts.orderId)}/returns/${segment(resource)}` }),
  product: (resource) => ({ operationId: "dashboard.products.get_by_ids", path: `/api/v1/admin/products/by-ids?ids=${segment(resource)}` }),
  variant: (resource) => ({ operationId: "dashboard.inventory.levels", path: `/api/v1/admin/inventory/${segment(resource)}/levels` }),
  customer: (resource) => ({ operationId: "dashboard.customers.get", path: `/api/v1/admin/customers/${segment(resource)}` }),
  purchase_order: (resource) => ({ operationId: "dashboard.purchase_orders.get", path: `/api/v1/admin/inventory/purchase-orders/${segment(resource)}` }),
  inventory_transfer: (resource) => ({ operationId: "dashboard.inventory_transfers.get", path: `/api/v1/admin/inventory/transfers/${segment(resource)}` }),
  fulfillment: (_resource, facts) => ({ operationId: "dashboard.orders.get", path: `/api/v1/admin/orders/${segment(facts.orderId)}` }),
  shipment: (resource, facts) => ({ operationId: "dashboard.orders.shipment_get", path: `/api/v1/admin/orders/${segment(facts.orderId)}/shipments/${segment(resource)}` }),
  payment: (_resource, facts) => ({ operationId: "dashboard.orders.payments", path: `/api/v1/admin/orders/${segment(facts.orderId)}/payments` }),
  checkout: () => ({ operationId: "dashboard.abandoned_checkouts.summaries_list", path: "/api/v1/admin/abandoned-checkouts/summaries" }),
  discount: (resource) => ({ operationId: "dashboard.discounts.get", path: `/api/v1/admin/discounts/${segment(resource)}` }),
  review: (resource) => ({ operationId: "dashboard.reviews.get", path: `/api/v1/admin/reviews/${segment(resource)}` }),
  gift_card: (resource) => ({ operationId: "dashboard.gift_cards.get", path: `/api/v1/admin/gift-cards/${segment(resource)}` }),
  transaction: (_resource, facts) => ({ operationId: "dashboard.gift_cards.get", path: `/api/v1/admin/gift-cards/${segment(facts.giftCardId)}` }),
  object: (resource, facts) => ({ operationId: "objects.get", path: `/api/v1/admin/objects/${segment(facts.objectType)}/${segment(resource)}` }),
};

/** The `data` of a delivery too large to carry its representation. */
export function eventDataTruncation(type: EventRepresentationType, resourceId: string, facts: Record<string, unknown>): EventDataTruncation {
  const hint = FETCH_HINTS[type](resourceId, facts);
  return eventDataTruncationSchema.parse({ truncated: true, id: resourceId, fetch: { operationId: hint.operationId, method: "GET", path: hint.path } });
}

/** A copy of a sealed representation with the protected fields outside `customerData` as null (per subscription). */
export function projectEventRepresentation<T extends EventRepresentationType>(
  type: T,
  representation: EventRepresentation<T>,
  customerData: ReadonlySet<ProtectedCustomerData>,
): EventRepresentation<T> {
  return redactProtectedData(structuredClone(representation), eventRepresentationProtectedPaths(type), customerData);
}

const pathsByType = new Map<EventRepresentationType, readonly ProtectedPath[]>();

/** The protected fields of a representation (derived once per type from its schema). */
export function eventRepresentationProtectedPaths(type: EventRepresentationType): readonly ProtectedPath[] {
  let paths = pathsByType.get(type);
  if (!paths) {
    paths = protectedPathsOf(z.toJSONSchema(EVENT_REPRESENTATION_SCHEMAS[type], { io: "output", unrepresentable: "any" }));
    pathsByType.set(type, paths);
  }
  return paths;
}

/**
 * The one way to build a delivery's `data`: parsed through the sealed schema
 * (fields it does not declare are dropped, a mismatch throws: a bug, never a
 * guess), then protected fields outside `customerData` read null.
 */
export function buildEventRepresentation<T extends EventRepresentationType>(
  type: T,
  value: EventRepresentationInput<T>,
  customerData: ReadonlySet<ProtectedCustomerData>,
): EventRepresentation<T> {
  const sealed = EVENT_REPRESENTATION_SCHEMAS[type].parse(value) as EventRepresentation<T>;
  return redactProtectedData(sealed, eventRepresentationProtectedPaths(type), customerData);
}
