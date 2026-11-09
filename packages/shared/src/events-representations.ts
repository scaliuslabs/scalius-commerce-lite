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
import { APP_OWNED_FIELD_KEYWORD, appOwnedPathsOf, projectAppOwnedData, type AppOwnedMode, type AppOwnedPath } from "./plugins/app-owned-data";
import {
  FULFILLMENT_RECORD_STATUSES,
  FULFILLMENT_STATUSES,
  FULFILLMENT_TYPES,
  GIFT_CARD_ACTOR_TYPES,
  GIFT_CARD_SOURCES,
  GIFT_CARD_STATUSES,
  GIFT_CARD_TRANSACTION_KINDS,
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
import { REVIEW_LIMITS, REVIEW_REJECTION_REASONS, REVIEW_STATUSES } from "./reviews";
import { POINT_OF_SALE_TENDER_VIAS } from "./payment-terms";
import { OBJECT_STATUSES } from "./plugins/objects";

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

/** A buyer's answers to apps: an app reads only its own (plugins/app-owned-data.ts). */
function appOwned<T extends z.ZodType>(mode: AppOwnedMode, schema: T): T {
  return schema.meta({ [APP_OWNED_FIELD_KEYWORD]: mode }) as T;
}

/** An app-scoped key: `<app id>.<key>`. */
const appScopedKey = z.string().min(1).max(160);

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
   * The app purchase options the line was bought with (`<app id>.<key>`: a
   * subscription, a rental), one per app, sorted by id, frozen at checkout;
   * empty for a one-time purchase. Test for yours with `includes`.
   */
  purchaseOptions: z.array(appScopedKey).max(10),
  /**
   * What the buyer entered for the line, frozen at checkout: the product's
   * own inputs (`appId` null: an engraving, a fit choice) and the apps' line
   * inputs (`checkout.lineInputs`, `key` `<app id>.<key>`). An app reading
   * the order sees the product's inputs and its own, never another app's.
   * A gift card's recipient is not listed (the gift card carries it).
   */
  properties: appOwned("items", z.array(z.object({
    key: appScopedKey,
    label: text,
    value: text,
    /** What the buyer saw: a choice's label, "Yes" for a ticked box. */
    displayValue: text,
    /** What the input added to one unit (the product's own surcharge); 0 for an app's input, which the app prices with an add-on. */
    priceMinor: minor,
    /** The app that asked for it; null for the product's own input. */
    appId: id.nullable(),
  })).max(60)),
  /**
   * Apps' add-ons to each unit of the line (`cart.line_prices` adjustments: a
   * protection plan, gift wrap), already inside `unitPriceMinor`. `appId` is
   * null for add-ons frozen before apps were named on them.
   */
  adjustments: z.array(z.object({
    appId: id.nullable(),
    title: text,
    /** Added to each unit. */
    amountMinor: minor,
  })).max(10),
});

/**
 * One discount the order used and what it took from which lines (Shopify's
 * discount applications): a store discount (`discountId`, its code when it
 * was entered) or an app's (`appId`, from `checkout.discounts`). Line
 * amounts are integer minor units of the order currency and add up to
 * `amountMinor`; `shippingAmountMinor` came off delivery.
 */
const discountApplicationSchema = z.object({
  source: z.enum(["store", "app"]),
  /** The store discount; null for an app's. */
  discountId: id.nullable(),
  /** The app that gave it; null for the store's. */
  appId: id.nullable(),
  title: text,
  /** The code it answered to, when one was entered. */
  code: z.string().max(64).nullable(),
  method: z.enum(["automatic", "code"]),
  /** Off the items. */
  amountMinor: minor,
  /** Off delivery. */
  shippingAmountMinor: minor,
  lines: z.array(z.object({ orderItemId: id, amountMinor: minor })).max(500),
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
  /**
   * The buyer's answers to the apps' checkout attributes, by `<app id>.<key>`
   * (`checkout.attributes`: a delivery note, a gift message). An app reading
   * the order sees only its own keys; the store's endpoints see all.
   */
  attributes: appOwned("keys", z.record(appScopedKey, z.string().max(500))),
  /**
   * The discounts the order used, store discounts first, then apps' in the
   * order they applied. Unbounded like `lines`: it lists what checkout
   * committed (up to 50 automatic discounts and the codes, and up to 10 per
   * app that discounts), never a page of it.
   */
  discountApplications: z.array(discountApplicationSchema),
  /**
   * An in-person sale's receipt facts (`channel: "pos"`): the location the
   * goods left from, the staff member who rang it up, each tender as paid
   * and the change given back (`tenderedMinor - changeMinor = totalMinor`).
   * Null for every other order.
   */
  pointOfSale: z.object({
    locationId: id,
    staffMemberId: id.nullable(),
    tenders: z.array(z.object({
      via: z.enum(POINT_OF_SALE_TENDER_VIAS),
      /** What the buyer handed over, before change. */
      amountMinor: minor,
      reference: text.nullable(),
    })),
    tenderedMinor: minor,
    changeMinor: minor,
  }).nullable(),
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
  /** The app that requested it (`source: "app"`); null for any other source. */
  appId: id.nullable(),
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
    /** Received units of an item whose stock isn't tracked: neither restocked nor damaged. */
    untrackedQuantity: z.number().int(),
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

/** One line of a checkout as the buyer last saw it. */
const checkoutLineSchema = z.object({
  productId: id,
  variantId: id.nullable(),
  title: text,
  /** The variant's option labels the buyer picked (`Size: M`). */
  options: z.array(z.object({ name: z.string().max(100), value: z.string().max(200) })),
  quantity: z.number().int(),
  unitPriceMinor: minor,
  totalMinor: minor,
});

/**
 * A storefront checkout the buyer left (`abandoned_checkouts`): what was in
 * it, as they last saw it (an estimate: checkout prices again), in the
 * page's currency, market presence and language. `customerId` is the store's
 * customer record for the phone the buyer typed (null for a new buyer), so a
 * marketing message goes through `ctx.messaging` with that id and the
 * platform's consent check; `marketingConsents` is that record's consent per
 * channel, with its source (a guest who ticked the checkout's consent box
 * and left has a record and an `unsubmitted_checkout` consent). `recoveryUrl` opens the store with the cart filled again: a
 * signed, expiring link that carries no contact or cart values.
 */
export const checkoutRepresentationSchema = z.object({
  id,
  /** The browser's checkout session (the order it becomes ends this checkout). */
  checkoutId: id,
  /** `open` while the buyer may still be filling it in; `abandoned` once idle an hour (`checkout.abandoned`). */
  status: z.enum(["open", "abandoned"]),
  customerId: id.nullable(),
  name: pii("name", text.nullable()),
  email: pii("email", text.nullable()),
  /** The buyer's phone when they gave one before leaving. */
  phone: pii("phone", text.nullable()),
  currency,
  /** The market presence the buyer shopped in (`en-in`), null at the store's root. */
  presence: z.string().max(64).nullable(),
  /** The page language (`en`, `bn`), null when unknown. */
  language: z.string().max(16).nullable(),
  lines: z.array(checkoutLineSchema),
  subtotalMinor: minor,
  discountMinor: minor,
  shippingMinor: minor.nullable(),
  totalMinor: minor,
  marketingConsents: z.array(z.object({
    channel: state,
    state,
    /**
     * Where the consent came from (`checkout`, `newsletter`, …;
     * `unsubmitted_checkout`: the box ticked on a checkout never placed,
     * which allows one marketing message, the cart reminder).
     */
    source: state,
    /** When the current subscription began; null unless subscribed. */
    consentedAt: iso.nullable(),
    /** Whether a marketing message may go on this consent now (an unsubmitted checkout's one reminder spent reads false). */
    messageAllowed: z.boolean(),
  })),
  /** The buyer's way back to this cart, or null when the store cannot sign one (no store URL). */
  recoveryUrl: z.string().max(2048).nullable(),
  /** When the link stops working. */
  recoveryExpiresAt: iso.nullable(),
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
  /** `pending` waits for moderation; only `published` is on the product page. */
  status: z.enum(REVIEW_STATUSES),
  rating: z.number().int().min(1).max(5),
  title: text.nullable(),
  body: z.string().max(REVIEW_LIMITS.bodyLength).nullable(),
  /** The name the review is shown under (what the buyer chose to publish): a buyer's name, so protected. */
  authorDisplayName: pii("name", text.nullable()),
  publishedAt: iso.nullable(),
  repliedAt: iso.nullable(),
  /** Advances with every change: the `expectedRevision` a status change takes. */
  revision: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
  /** The order line reviewed; null for an app's review that names none. */
  orderItemId: id.nullable(),
  /** A verified purchase: the review is on a delivered order line (`orderItemId`). */
  verified: z.boolean(),
  /** The app that wrote it (an import or a reviews app); null for a buyer's own review. */
  appId: id.nullable(),
  /** Why it was rejected (`status: "rejected"`): a content reason, never the rating. */
  moderationReason: z.enum(REVIEW_REJECTION_REASONS).nullable(),
  /** The store's public reply ("Response from <store>"), shown with the published review; null when there is none. */
  reply: z.string().max(REVIEW_LIMITS.replyLength).nullable(),
});

/**
 * A gift card (`gift_cards.get` answers it as `giftCard`). The code itself
 * never leaves the store; `last4` names it. `expired` is whether `expiresAt`
 * has passed when the card is read. Its ledger is `gift_card_transaction`.
 */
export const giftCardRepresentationSchema = z.object({
  id,
  /** The last four characters; the code itself never leaves the store. */
  last4: z.string().max(8),
  status: z.enum(GIFT_CARD_STATUSES),
  currency,
  /** The value it was issued with, in minor units of `currency`. */
  initialAmountMinor: minor,
  /** What is left to spend, in minor units of `currency`. */
  balanceMinor: minor,
  source: z.enum(GIFT_CARD_SOURCES),
  /** The order it was bought or refunded on, if any. */
  sourceOrderId: id.nullable(),
  /** The customer who owns it, if any. */
  customerId: id.nullable(),
  recipient: z.object({
    name: pii("name", text.nullable()),
    email: pii("email", text.nullable()),
    phone: pii("phone", text.nullable()),
  }),
  /** The message the recipient reads with the card. */
  message: text.nullable(),
  /** The store's own note; buyers never see it. */
  note: text.nullable(),
  expiresAt: iso.nullable(),
  expired: z.boolean(),
  /** Advances with every change: the `expectedRevision` an update or adjustment takes. */
  revision: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
});

/**
 * One gift card ledger entry (`gift_cards.get` lists the card's newest in
 * `transactions`). `amountMinor` is signed: positive adds value, negative
 * spends it, in minor units of `currency`.
 */
export const giftCardTransactionRepresentationSchema = z.object({
  id,
  giftCardId: id,
  kind: z.enum(GIFT_CARD_TRANSACTION_KINDS),
  currency,
  amountMinor: minor,
  balanceAfterMinor: minor,
  orderId: id.nullable(),
  actorType: z.enum(GIFT_CARD_ACTOR_TYPES),
  reason: text.nullable(),
  createdAt: iso,
});

/**
 * An object record (`objects.get` answers it as `record`): `typeId` is its
 * type's id (`objects.get` takes it or the type's handle), `data` the record's fields as
 * the type declares them, in the custom-field wire values (money as
 * `{ amountMinor, currency }`), and `displayName` its title.
 */
export const objectRepresentationSchema = z.object({
  id,
  typeId: z.string().min(1).max(192),
  handle: text.nullable(),
  status: z.enum(OBJECT_STATUSES),
  displayName: text,
  data: z.record(z.string(), z.unknown()).meta({ description: "Field values by key, typed as the custom-field HTTP contract: money as { amountMinor, currency } (integer minor units of the store currency)." }),
  position: z.number().int(),
  revision: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
});

/**
 * One line of a conversation. `author` is who wrote it: the buyer
 * (`customer`), the store's staff (`staff`), an app replying for the store
 * (`app`, with its `appId`) or the platform (`system`, an event line).
 * `internal` lines are staff notes the buyer never sees. Attachments are
 * references: a storefront image by its id, a chat channel's media by the
 * provider's `ref` or an https `url`. `delivery` is how a chat channel
 * carried the line (null on storefront threads).
 */
export const conversationMessageRepresentationSchema = z.object({
  id,
  seq: z.number().int(),
  kind: z.enum(["message", "event"]),
  visibility: z.enum(["public", "internal"]),
  author: z.enum(["customer", "staff", "app", "system"]),
  appId: id.nullable(),
  body: text.nullable(),
  eventKind: state.nullable(),
  attachments: z.array(z.object({
    kind: state,
    mediaType: text.nullable(),
    name: text.nullable(),
    sizeBytes: z.number().int().nullable(),
    ref: text.nullable(),
    url: text.nullable(),
  })).max(10),
  delivery: z.object({
    direction: z.enum(["inbound", "outbound"]),
    /** `received` (inbound), or `pending`, `sent`, `delivered`, `read`, `failed`. */
    status: state,
    providerId: id,
  }).nullable(),
  createdAt: iso,
});

/**
 * A thread of the inbox: an order's, a buyer account's, or a chat channel's
 * (`channel`: whatsapp, messenger, …, or a messaging app's own channel
 * `<app id>:<key>`), whose `contact` is where replies go
 * (the address is protected as a phone on every channel). `status` is
 * `open` (waits on the store), `pending` (waits on the buyer) or `closed`.
 * `lastMessage` is its newest line; `conversations.list_messages` pages the rest.
 */
export const conversationRepresentationSchema = z.object({
  id,
  subjectType: state,
  status: z.enum(["open", "pending", "closed"]),
  channel: state.nullable(),
  orderId: id.nullable(),
  customerId: id.nullable(),
  subject: text.nullable(),
  contact: z.object({
    name: pii("name", text.nullable()),
    address: pii("phone", text.nullable()),
    /** The messaging app provider replies go out through (`<app id>:<provider id>`). */
    providerId: id,
  }).nullable(),
  assigneeUserId: id.nullable(),
  lastSeq: z.number().int(),
  lastMessageAt: iso.nullable(),
  lastMessage: conversationMessageRepresentationSchema.nullable(),
  /** Advances with every change of the thread. */
  revision: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
  closedAt: iso.nullable(),
});

/**
 * Money an app sent to a payee through a payout provider. `status`:
 * `pending` (recorded, the provider has not answered: send the same
 * `payouts.create` again to resubmit it), `processing`, then `paid` or
 * `failed` (final, with `failureCode`). A paid payout may be reversed in
 * part or whole (`reversals`).
 */
export const payoutRepresentationSchema = z.object({
  id,
  appId: id,
  providerId: id,
  payeeRef: text,
  payeeAccountRef: text.nullable(),
  amountMinor: minor,
  currency,
  description: text.nullable(),
  status: z.enum(["pending", "processing", "paid", "failed"]),
  providerRef: text.nullable(),
  failureCode: state.nullable(),
  failureMessage: text.nullable(),
  /** What the payout's reversals took back (those `reversed`), in minor units of `currency`. */
  reversedMinor: minor,
  /**
   * Money taken back from the paid payout (`payouts.reverse`), oldest first:
   * `pending` (recorded, the provider has not answered: send the same
   * request again to resubmit it), `processing`, then `reversed` or `failed`
   * (final, with `failureCode`).
   */
  reversals: z.array(z.object({
    id,
    amountMinor: minor,
    currency,
    reason: text.nullable(),
    status: z.enum(["pending", "processing", "reversed", "failed"]),
    providerRef: text.nullable(),
    failureCode: state.nullable(),
    failureMessage: text.nullable(),
    createdAt: iso,
    updatedAt: iso,
    settledAt: iso.nullable(),
  })).max(20),
  /** Advances with every change of the payout, its reversals included. */
  revision: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
  settledAt: iso.nullable(),
});

/**
 * A warranty record (0214): the store's own warranty of a handed-over
 * fulfilment line, or an app's coverage of one unit (`appId`, issued with
 * `warranties.issue`). `policy` is the frozen revision the record holds: a
 * lifetime one has `durationUnit: "lifetime"`, `durationValue` null and no
 * `expiresAt`. `status`: `active`, `expired` (a period that ended) or
 * `voided` (its fulfilment was voided, or its app voided the unit). `code`
 * is an app record's buyer-facing id (`8K4-XP2-MN9`). `claim` is the latest
 * claim on it (an open one first); buyers and staff claim through the
 * store's own warranty claims.
 */
export const warrantyRepresentationSchema = z.object({
  id,
  code: z.string().max(16).nullable(),
  appId: id.nullable(),
  orderId: id,
  orderItemId: id,
  /** An app record's unit of its line (1 to the line's quantity); null for the store's own warranty. */
  unitNumber: z.number().int().positive().nullable(),
  quantity: z.number().int().positive(),
  policy: z.object({
    id,
    /** The app's plan key (`warranties.issue` `policy.key`); null for the store's own policy. */
    key: z.string().max(64).nullable(),
    revisionId: id,
    revision: z.number().int().positive(),
    name: text,
    provider: z.enum(["brand", "store"]),
    durationValue: z.number().int().positive().nullable(),
    durationUnit: z.enum(["days", "months", "years", "lifetime"]),
    replacementDays: z.number().int().nullable(),
    terms: text.nullable(),
  }),
  status: z.enum(["active", "expired", "voided"]),
  startsAt: iso,
  expiresAt: iso.nullable(),
  replacementUntil: iso.nullable(),
  voidedAt: iso.nullable(),
  claim: z.object({
    id,
    status: z.enum(["open", "in_progress", "resolved", "rejected"]),
    resolution: z.enum(["repair", "replacement", "refund", "other"]).nullable(),
  }).nullable(),
  createdAt: iso,
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
  conversation: conversationRepresentationSchema,
  payout: payoutRepresentationSchema,
  warranty: warrantyRepresentationSchema,
} as const;

export type EventRepresentationType = keyof typeof EVENT_REPRESENTATION_SCHEMAS;
export type EventRepresentation<T extends EventRepresentationType = EventRepresentationType> =
  z.output<(typeof EVENT_REPRESENTATION_SCHEMAS)[T]>;
export type EventRepresentationInput<T extends EventRepresentationType> =
  z.input<(typeof EVENT_REPRESENTATION_SCHEMAS)[T]>;

/**
 * What a delivery carries in `data` when the whole body would pass 512 KiB:
 * the resource id and where to read it. `data: null` only ever means the
 * resource no longer exists. `fetch` names a stable app API read whose
 * answer carries the same representation, the resource itself or the list
 * it is in, by its `id`: `appOperation` is what an app passes to
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
 * API, under its API credential): a stable read whose answer carries the
 * same representation (an order is `order`; a refund is in `refunds`, a
 * gift card ledger entry in the card's `transactions`), by its sealed app
 * name. Null where none exists yet. The SDK's contract guard checks each
 * against the read's response schema.
 */
const FETCH_HINTS: Record<EventRepresentationType, ((resourceId: string, facts: Record<string, unknown>) => { appOperation: StableAppOperationName; path: string }) | null> = {
  order: (resource) => ({ appOperation: "orders.get", path: `/api/v1/admin/resources/orders/${segment(resource)}` }),
  return: (resource) => ({ appOperation: "returns.get", path: `/api/v1/admin/resources/returns/${segment(resource)}` }),
  product: (resource) => ({ appOperation: "products.get", path: `/api/v1/admin/resources/products/${segment(resource)}` }),
  variant: (resource) => ({ appOperation: "variants.get", path: `/api/v1/admin/resources/variants/${segment(resource)}` }),
  customer: (resource) => ({ appOperation: "customers.get", path: `/api/v1/admin/resources/customers/${segment(resource)}` }),
  purchase_order: (resource) => ({ appOperation: "purchase_orders.get", path: `/api/v1/admin/resources/purchase-orders/${segment(resource)}` }),
  inventory_transfer: (resource) => ({ appOperation: "inventory_transfers.get", path: `/api/v1/admin/resources/inventory-transfers/${segment(resource)}` }),
  fulfillment: (_resource, facts) => ({ appOperation: "fulfillments.list", path: `/api/v1/admin/resources/orders/${segment(facts.orderId)}/fulfillments` }),
  refund: (_resource, facts) => ({ appOperation: "refunds.list", path: `/api/v1/admin/resources/orders/${segment(facts.orderId)}/refunds` }),
  shipment: (resource) => ({ appOperation: "shipments.get", path: `/api/v1/admin/resources/shipments/${segment(resource)}` }),
  payment: (_resource, facts) => ({ appOperation: "payments.list", path: `/api/v1/admin/resources/orders/${segment(facts.orderId)}/payments` }),
  checkout: (resource) => ({ appOperation: "abandoned_checkouts.get", path: `/api/v1/admin/resources/abandoned-checkouts/${segment(resource)}` }),
  // A delivery carries the summary (codes are bearer values, unbounded): the list read by id answers it; discounts.get adds the rules and codes.
  discount: (resource) => ({ appOperation: "discounts.list", path: `/api/v1/admin/resources/discounts?ids=${segment(resource)}` }),
  review: (resource) => ({ appOperation: "reviews.get", path: `/api/v1/admin/resources/reviews/${segment(resource)}` }),
  gift_card: (resource) => ({ appOperation: "gift_cards.get", path: `/api/v1/admin/resources/gift-cards/${segment(resource)}` }),
  gift_card_transaction: (_resource, facts) => ({ appOperation: "gift_cards.get", path: `/api/v1/admin/resources/gift-cards/${segment(facts.giftCardId)}` }),
  object: (resource, facts) => ({ appOperation: "objects.get", path: `/api/v1/admin/objects/${segment(facts.objectType)}/${segment(resource)}` }),
  conversation: (resource) => ({ appOperation: "conversations.get", path: `/api/v1/admin/resources/conversations/${segment(resource)}` }),
  payout: (resource) => ({ appOperation: "payouts.get", path: `/api/v1/admin/resources/payouts/${segment(resource)}` }),
  warranty: (resource) => ({ appOperation: "warranties.get", path: `/api/v1/admin/resources/warranties/${segment(resource)}` }),
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

/**
 * A copy of a sealed representation as one reader may see it (per
 * subscription): the protected fields outside `customerData` as null, and,
 * for an app's reader, the app-owned answers narrowed to that app's own.
 */
export function projectEventRepresentation<T extends EventRepresentationType>(
  type: T,
  representation: EventRepresentation<T>,
  customerData: ReadonlySet<ProtectedCustomerData>,
  appId: string | null = null,
): EventRepresentation<T> {
  const projected = redactProtectedData(structuredClone(representation), eventRepresentationProtectedPaths(type), customerData);
  return projectAppOwnedData(projected, eventRepresentationAppOwnedPaths(type), appId);
}

const appOwnedPathsByType = new Map<EventRepresentationType, readonly AppOwnedPath[]>();

/** The app-owned fields of a representation (derived once per type from its schema). */
export function eventRepresentationAppOwnedPaths(type: EventRepresentationType): readonly AppOwnedPath[] {
  let paths = appOwnedPathsByType.get(type);
  if (!paths) {
    paths = appOwnedPathsOf(z.toJSONSchema(EVENT_REPRESENTATION_SCHEMAS[type], { io: "output", unrepresentable: "any" }));
    appOwnedPathsByType.set(type, paths);
  }
  return paths;
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
