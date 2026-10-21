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
import { STABLE_APP_OPERATIONS, type StableAppOperationName } from "./plugins/app-operations";
import {
  FULFILLMENT_RECORD_STATUSES,
  FULFILLMENT_STATUSES,
  FULFILLMENT_TYPES,
  ORDER_CHANNELS,
  ORDER_STATUSES,
  PAYMENT_RECORD_STATUSES,
  PAYMENT_RECORD_TYPES,
  PAYMENT_STATUSES,
  REFUND_SETTLEMENTS,
  REFUND_STATUSES,
  RETURN_SOURCES,
  RETURN_STATUSES,
  SHIPMENT_STATUSES,
} from "./resource-states";

const id = z.string().min(1).max(128);
const text = z.string().max(4000);
const state = z.string().min(1).max(64);
/** An instant: ISO 8601 in UTC (`2026-10-21T09:30:00.000Z`), as every stable time is. */
const iso = z.string().min(1).max(40).meta({ format: "date-time" });
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
  /**
   * The SKU code the line was sold under, frozen when the line was created
   * (0179); for lines created before 0179, the SKU's current code. Null for a
   * line without a SKU.
   */
  sku: text.nullable(),
  quantity: z.number().int(),
  fulfilledQuantity: z.number().int(),
  unitPriceMinor: minor,
  subtotalMinor: minor,
  discountMinor: minor,
  taxMinor: minor,
  /**
   * The app purchase option the line was bought with (`<app id>.<key>`, a
   * subscription), frozen at checkout as its `_purchase_option` property;
   * null for a one-time purchase.
   */
  purchaseOption: z.string().min(1).max(160).nullable(),
});

export const orderRepresentationSchema = z.object({
  id,
  orderNumber: z.number().int().nullable(),
  /** The workflow stage. Money questions read `paymentStatus`, hand-over questions `fulfillmentStatus` (`resource-states.ts`). */
  status: z.enum(ORDER_STATUSES),
  /** The authority for money: paid, partly paid, refunded. */
  paymentStatus: z.enum(PAYMENT_STATUSES),
  /** The authority for hand-over, with the order's fulfilments. */
  fulfillmentStatus: z.enum(FULFILLMENT_STATUSES),
  channel: z.enum(ORDER_CHANNELS),
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
  /**
   * A deferred order's terms (an invoice, `net_terms` or an app's deferred
   * method): paid by `dueAt`. Null for every other order. The order is
   * overdue once `dueAt` passes with `balanceDueMinor` above zero.
   */
  paymentTerms: z.object({
    kind: z.literal("net"),
    days: z.number().int(),
    dueAt: iso,
  }).nullable(),
  customerId: id.nullable(),
  /** The buyer's storefront account when the order verifiably belongs to one; null for a guest order. */
  accountCustomerId: id.nullable(),
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
  /** Advances with every change: the `expectedRevision` an update takes. */
  revision: z.number().int(),
  lines: z.array(orderLineSchema),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: iso.nullable(),
});

export const returnRepresentationSchema = z.object({
  id,
  orderId: id,
  status: z.enum(RETURN_STATUSES),
  reason: text,
  source: z.enum(RETURN_SOURCES),
  /** Advances with every change: the `expectedRevision` a write takes. */
  revision: z.number().int(),
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
  /** The featured image (or the featured video's poster); null for none. */
  imageUrl: z.string().max(2048).nullable(),
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
    /** `ean13`, `upc`, `isbn`, `gtin`, `code128` or `custom`; null without a barcode. */
    barcodeType: state.nullable(),
    weightGrams: z.number().nullable(),
    /** One value of every option, by option name (`{ "Size": "M" }`); empty for a product without options. */
    optionValues: z.record(z.string().max(40), text),
    /** The media file of its own image; null shows the product's featured image. */
    mediaId: id.nullable(),
  })),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: iso.nullable(),
  /** The product page's description as the editor saved it (rich text); null for none. */
  description: z.string().nullable(),
  /** `new`, `refurbished` or `used`; null when not stated. */
  condition: state.nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  /** The sales channels it is published to, sorted. */
  salesChannelIds: z.array(id),
  /** The gallery in order; `featured` is its main image or video. */
  media: z.array(z.object({
    /** This product's use of the file. */
    id,
    mediaId: id,
    kind: state,
    url: z.string().max(2048),
    /** The alt text this product gives the file; null uses the file's own. */
    altText: z.string().nullable(),
    featured: z.boolean(),
  })),
  /** Merchant-named options (at most five) and their values, in order; empty for a product sold as one SKU. */
  options: z.array(z.object({
    id,
    name: text,
    /** `size`, `color`, `material`, `pattern` or `none`: which standard attribute it is for catalog feeds. */
    standardMapping: state,
    values: z.array(text),
  })),
});

/** `variant.inventory_changed` is about one SKU: its on-hand units per location. */
export const variantRepresentationSchema = z.object({
  id,
  productId: id,
  sku: text,
  trackInventory: z.boolean(),
  onHand: z.number().int(),
  levels: z.array(z.object({ locationId: id, onHand: z.number().int() })),
  /** Advances with every stock change: the `expectedStockVersion` a stock write takes. */
  stockVersion: z.number().int(),
  updatedAt: iso,
  barcode: text.nullable(),
  /** When it was retired from its product (`variants.retire`; `variants.restore` brings it back); null while it sells. */
  retiredAt: iso.nullable(),
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
  /** The merchant's tags, normalised (trimmed, lower-case), in order. */
  tags: z.array(z.string().max(40)),
  /** Marketing consent per channel; the address it was given for is protected. */
  consents: z.array(z.object({
    channel: state,
    state,
    contact: pii(["email", "phone"], text.nullable()),
    updatedAt: iso,
  })),
  /**
   * The merchant (or an app) marked the buyer tax-exempt: their orders pay
   * no tax. `taxExemptionId` is the certificate or registration number,
   * null for none (and always null when not exempt).
   */
  taxExempt: z.boolean(),
  taxExemptionId: z.string().max(64).nullable(),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: iso.nullable(),
  /** When staff erased the customer's personal data (`customer.erased`); null otherwise. Its contact then reads null or "[erased]". */
  erasedAt: iso.nullable(),
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
  kind: z.enum(FULFILLMENT_TYPES),
  status: z.enum(FULFILLMENT_RECORD_STATUSES),
  shipmentId: id.nullable(),
  locationId: id.nullable(),
  currency,
  cashCollectedMinor: minor.nullable(),
  lines: z.array(z.object({ id, orderItemId: id, quantity: z.number().int() })),
  createdAt: iso,
  voidedAt: iso.nullable(),
});

/**
 * A refund command (0172): the money it gives back, where (`settlement`),
 * the order lines it is for, and the refund payments it became (one per
 * payment the money goes back to, `payments.list`).
 */
export const refundRepresentationSchema = z.object({
  id,
  orderId: id,
  /** `pending` until each of its payments settles; then `refunded`, `failed` or `partial`. */
  status: z.enum(REFUND_STATUSES),
  currency,
  amountMinor: minor,
  /** `original` (back to the payments) or `store_credit` (one new gift card). */
  settlement: z.enum(REFUND_SETTLEMENTS),
  lines: z.array(z.object({ orderItemId: id, variantId: id.nullable(), quantity: z.number().int() })),
  paymentIds: z.array(id),
  createdAt: iso,
  updatedAt: iso,
});

export const shipmentRepresentationSchema = z.object({
  id,
  orderId: id,
  /** A qualified app courier id (`<app id>:<provider id>`) or a built-in courier's. */
  providerId: id.nullable(),
  providerType: state,
  /** The normalized state; `rawStatus` is the courier's own word. */
  status: z.enum(SHIPMENT_STATUSES),
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
  status: z.enum(PAYMENT_RECORD_STATUSES),
  method: text,
  type: z.enum(PAYMENT_RECORD_TYPES),
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
  revision: z.number().int(),
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
  /** Advances with every change: the `expectedRevision` an update or adjustment takes. */
  revision: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
});

export const giftCardTransactionRepresentationSchema = z.object({
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
  refund: refundRepresentationSchema,
  shipment: shipmentRepresentationSchema,
  payment: paymentRepresentationSchema,
  checkout: checkoutRepresentationSchema,
  discount: discountRepresentationSchema,
  review: reviewRepresentationSchema,
  gift_card: giftCardRepresentationSchema,
  gift_card_transaction: giftCardTransactionRepresentationSchema,
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
 * resource no longer exists. `fetch` names a stable app API read that
 * returns the same representation: `appOperation` is what an app passes to
 * `ctx.api.call`, `operationId`/`method`/`path` what an HTTP or agent caller
 * uses. It is null for a resource no stable operation reads; the receiver
 * keeps the `id`.
 */
export const eventDataTruncationSchema = z.object({
  truncated: z.literal(true),
  id,
  fetch: z.object({
    appOperation: z.string().min(1).max(128),
    operationId: z.string().min(1).max(128),
    method: z.literal("GET"),
    path: z.string().min(1).max(512),
  }).nullable(),
});
export type EventDataTruncation = z.output<typeof eventDataTruncationSchema>;

const segment = (value: unknown) => encodeURIComponent(typeof value === "string" ? value : "");

/**
 * Where a receiver reads a resource the delivery could not carry (the admin
 * API, under its API credential): a stable read of the same representation,
 * by its sealed app name. Null where none exists yet.
 */
const FETCH_HINTS: Record<EventRepresentationType, ((resourceId: string, facts: Record<string, unknown>) => { appOperation: StableAppOperationName; path: string }) | null> = {
  order: (resource) => ({ appOperation: "orders.get", path: `/api/v1/admin/resources/orders/${segment(resource)}` }),
  return: (resource) => ({ appOperation: "returns.get", path: `/api/v1/admin/resources/returns/${segment(resource)}` }),
  product: (resource) => ({ appOperation: "products.get", path: `/api/v1/admin/resources/products/${segment(resource)}` }),
  variant: (resource) => ({ appOperation: "variants.get", path: `/api/v1/admin/resources/variants/${segment(resource)}` }),
  customer: (resource) => ({ appOperation: "customers.get", path: `/api/v1/admin/resources/customers/${segment(resource)}` }),
  purchase_order: null,
  inventory_transfer: null,
  fulfillment: (_resource, facts) => ({ appOperation: "fulfillments.list", path: `/api/v1/admin/resources/orders/${segment(facts.orderId)}/fulfillments` }),
  refund: (_resource, facts) => ({ appOperation: "refunds.list", path: `/api/v1/admin/resources/orders/${segment(facts.orderId)}/refunds` }),
  shipment: (resource) => ({ appOperation: "shipments.get", path: `/api/v1/admin/resources/shipments/${segment(resource)}` }),
  payment: (_resource, facts) => ({ appOperation: "payments.list", path: `/api/v1/admin/resources/orders/${segment(facts.orderId)}/payments` }),
  checkout: null,
  discount: (resource) => ({ appOperation: "discounts.get", path: `/api/v1/admin/discounts/${segment(resource)}` }),
  review: null,
  gift_card: (resource) => ({ appOperation: "gift_cards.get", path: `/api/v1/admin/resources/gift-cards/${segment(resource)}` }),
  gift_card_transaction: (_resource, facts) => ({ appOperation: "gift_cards.get", path: `/api/v1/admin/resources/gift-cards/${segment(facts.giftCardId)}` }),
  object: (resource, facts) => ({ appOperation: "objects.get", path: `/api/v1/admin/objects/${segment(facts.objectType)}/${segment(resource)}` }),
};

/** The `data` of a delivery too large to carry its representation. */
export function eventDataTruncation(type: EventRepresentationType, resourceId: string, facts: Record<string, unknown>): EventDataTruncation {
  const hint = FETCH_HINTS[type]?.(resourceId, facts) ?? null;
  return eventDataTruncationSchema.parse({
    truncated: true,
    id: resourceId,
    fetch: hint && { appOperation: hint.appOperation, operationId: STABLE_APP_OPERATIONS[hint.appOperation], method: "GET", path: hint.path },
  });
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
