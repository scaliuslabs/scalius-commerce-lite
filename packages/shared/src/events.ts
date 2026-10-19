// Event catalog (COMMERCE-HOOKS H3). Part of the public plugin and webhook
// API: topics and payload shapes are versioned by `EVENTS_API_VERSION` and
// change only additively within a version (the one exception to the
// no-backward-compatibility rule).
//
// Events are written by SQL triggers in the same transaction as the domain
// write (packages/database/scripts/event-outbox-triggers.ts), so every topic's
// `facts` are thin, PII-free facts the trigger can read from the row: ids,
// from/to states, quantities. Money and contact details never appear here; a
// webhook body carries the resource's sealed representation in `data`
// (./events-representations.ts), versioned with the facts.

import { z } from "zod";
import { hmacSha256Hex } from "./hash";
import type { EventDataTruncation, EventRepresentation } from "./events-representations";

/** The payload version every delivery and plugin event declares. */
export const EVENTS_API_VERSION = "2026-10" as const;
export const SUPPORTED_EVENTS_API_VERSIONS = [EVENTS_API_VERSION] as const;
export type EventsApiVersion = (typeof SUPPORTED_EVENTS_API_VERSIONS)[number];

export const EVENT_TOPICS = [
  "order.created",
  "order.updated",
  "order.paid",
  "order.cancelled",
  "order.fulfilled",
  "order.refunded",
  "return.updated",
  "product.created",
  "product.updated",
  "product.deleted",
  "product.publication_changed",
  "inventory.level_changed",
  "inventory.purchase_order_updated",
  "inventory.transfer_updated",
  "customer.created",
  "customer.updated",
  "customer.consent_changed",
  "fulfillment.created",
  "fulfillment.voided",
  "shipment.updated",
  "payment.updated",
  "checkout.abandoned",
  "discount.created",
  "discount.updated",
  "discount.deleted",
  "discount.redeemed",
  "review.created",
  "review.updated",
  "gift_card.created",
  "gift_card.updated",
  "gift_card.transaction",
  "object.created",
  "object.updated",
  "object.deleted",
  "customer.redact_requested",
  "customer.data_requested",
] as const;
export type EventTopic = (typeof EVENT_TOPICS)[number];

/** What an event is about; `resourceId` is that resource's id. */
export const EVENT_RESOURCE_TYPES = [
  "order",
  "return",
  "product",
  "variant",
  "customer",
  "purchase_order",
  "inventory_transfer",
  "fulfillment",
  "shipment",
  "payment",
  "checkout",
  "discount",
  "review",
  "gift_card",
  "transaction",
  "object",
] as const;
export type EventResourceType = (typeof EVENT_RESOURCE_TYPES)[number];

/** Each topic's resource type (inventory levels are reported per variant). */
export const EVENT_TOPIC_RESOURCE: Readonly<Record<EventTopic, EventResourceType>> = {
  "order.created": "order",
  "order.updated": "order",
  "order.paid": "order",
  "order.cancelled": "order",
  "order.fulfilled": "order",
  "order.refunded": "order",
  "return.updated": "return",
  "product.created": "product",
  "product.updated": "product",
  "product.deleted": "product",
  "product.publication_changed": "product",
  "inventory.level_changed": "variant",
  "inventory.purchase_order_updated": "purchase_order",
  "inventory.transfer_updated": "inventory_transfer",
  "customer.created": "customer",
  "customer.updated": "customer",
  "customer.consent_changed": "customer",
  "fulfillment.created": "fulfillment",
  "fulfillment.voided": "fulfillment",
  "shipment.updated": "shipment",
  "payment.updated": "payment",
  "checkout.abandoned": "checkout",
  "discount.created": "discount",
  "discount.updated": "discount",
  "discount.deleted": "discount",
  "discount.redeemed": "discount",
  "review.created": "review",
  "review.updated": "review",
  "gift_card.created": "gift_card",
  "gift_card.updated": "gift_card",
  "gift_card.transaction": "transaction",
  "object.created": "object",
  "object.updated": "object",
  "object.deleted": "object",
  "customer.redact_requested": "customer",
  "customer.data_requested": "customer",
};

const id = z.string().min(1).max(128);
const state = z.string().min(1).max(64);
const nullableState = state.nullable();
const nullableId = id.nullable();

/**
 * Facts per topic, as the triggers write them. Every schema is strict about
 * types and lenient about extra keys so later additive facts never break an
 * older reader.
 */
export const EVENT_FACT_SCHEMAS = {
  "order.created": z.object({
    orderId: id,
    status: state,
    paymentStatus: state,
    channel: state,
  }),
  "order.updated": z.object({
    orderId: id,
    previousStatus: state,
    status: state,
    previousPaymentStatus: state,
    paymentStatus: state,
    previousFulfillmentStatus: state,
    fulfillmentStatus: state,
  }),
  "order.paid": z.object({
    orderId: id,
    /** Null when the order was placed already paid (a gift card covered it). */
    previousPaymentStatus: nullableState,
    paymentStatus: state,
  }),
  "order.cancelled": z.object({
    orderId: id,
    previousStatus: state,
  }),
  "order.fulfilled": z.object({
    orderId: id,
    fulfillmentId: id,
    kind: state,
    locationId: nullableId,
  }),
  "order.refunded": z.object({
    orderId: id,
    paymentId: id,
  }),
  "return.updated": z.object({
    returnId: id,
    orderId: id,
    previousStatus: nullableState,
    status: state,
  }),
  "product.created": z.object({
    productId: id,
  }),
  "product.updated": z.object({
    productId: id,
    revision: z.number().int(),
  }),
  "product.deleted": z.object({
    productId: id,
    /** `trashed` (restorable) or `permanent` (the row is gone). */
    deletion: z.enum(["trashed", "permanent"]),
  }),
  /**
   * A product was published to or unpublished from a sales channel (0122,
   * MARKETS-DESIGN D6): a sales-channel app keeps its listings with it
   * (Shopify's product listings). A new product is published to every
   * channel; deleting a product unpublishes it from each.
   */
  "product.publication_changed": z.object({
    productId: id,
    channelId: id,
    state: z.enum(["published", "unpublished"]),
  }),
  "inventory.level_changed": z.object({
    variantId: id,
    productId: nullableId,
    locationId: nullableId,
    /** Signed change in on-hand units at the location. */
    quantityDelta: z.number().int(),
    movementId: id,
    movementType: state,
  }),
  /**
   * A purchase order was created, changed (any write advances its revision:
   * edits, ordering, each receipt, cancelling) or a draft was deleted
   * (`status` "deleted"). `previousStatus` is null when it was created.
   * Receipts also emit `inventory.level_changed` per SKU.
   */
  "inventory.purchase_order_updated": z.object({
    purchaseOrderId: id,
    previousStatus: nullableState,
    status: state,
    revision: z.number().int(),
  }),
  /**
   * A transfer between locations was created, changed (edits, shipping, each
   * receipt, cancelling) or a draft was deleted (`status` "deleted").
   * Shipping and receiving also emit `inventory.level_changed` per SKU.
   */
  "inventory.transfer_updated": z.object({
    transferId: id,
    previousStatus: nullableState,
    status: state,
    revision: z.number().int(),
  }),
  "customer.created": z.object({
    customerId: id,
  }),
  "customer.updated": z.object({
    customerId: id,
  }),
  /**
   * Marketing consent for one channel changed state (0108). `previousState`
   * is null for the first consent fact on that channel. The address and the
   * consent text stay private; `data` carries the customer's consents.
   */
  "customer.consent_changed": z.object({
    customerId: id,
    channel: z.enum(["email", "sms", "whatsapp", "push"]),
    previousState: z.enum(["subscribed", "unsubscribed", "pending"]).nullable(),
    state: z.enum(["subscribed", "unsubscribed", "pending"]),
    source: state,
  }),
  "fulfillment.created": z.object({
    fulfillmentId: id,
    orderId: id,
    kind: state,
    locationId: nullableId,
  }),
  "fulfillment.voided": z.object({
    fulfillmentId: id,
    orderId: id,
    kind: state,
    locationId: nullableId,
  }),
  "shipment.updated": z.object({
    shipmentId: id,
    orderId: id,
    providerId: nullableId,
    previousStatus: state,
    status: state,
  }),
  "payment.updated": z.object({
    paymentId: id,
    orderId: id,
    provider: z.string().min(1).max(150),
    previousStatus: nullableState,
    status: state,
  }),
  "checkout.abandoned": z.object({
    abandonedCheckoutId: id,
    checkoutId: id,
  }),
  "discount.created": z.object({
    promotionId: id,
    previousStatus: nullableState,
    status: state,
  }),
  "discount.updated": z.object({
    promotionId: id,
    previousStatus: nullableState,
    status: state,
  }),
  "discount.deleted": z.object({
    promotionId: id,
    previousStatus: nullableState,
    status: state,
  }),
  "discount.redeemed": z.object({
    promotionId: id,
    orderId: id,
    codeId: nullableId,
  }),
  "review.created": z.object({
    reviewId: id,
    productId: id,
    previousStatus: nullableState,
    status: state,
    rating: z.number().int().min(1).max(5),
  }),
  "review.updated": z.object({
    reviewId: id,
    productId: id,
    previousStatus: nullableState,
    status: state,
    rating: z.number().int().min(1).max(5),
  }),
  "gift_card.created": z.object({
    giftCardId: id,
    previousStatus: nullableState,
    status: state,
  }),
  "gift_card.updated": z.object({
    giftCardId: id,
    previousStatus: nullableState,
    status: state,
  }),
  "gift_card.transaction": z.object({
    giftCardId: id,
    transactionId: id,
    kind: state,
    orderId: nullableId,
  }),
  "object.created": z.object({
    objectType: z.string().min(1).max(192),
    objectId: id,
    revision: z.number().int().positive(),
    status: state,
  }),
  "object.updated": z.object({
    objectType: z.string().min(1).max(192),
    objectId: id,
    revision: z.number().int().positive(),
    status: state,
  }),
  "object.deleted": z.object({
    objectType: z.string().min(1).max(192),
    objectId: id,
    revision: z.number().int().positive(),
    status: state,
  }),
  // Reserved until the core provides an erasure/data-request flow.
  "customer.redact_requested": z.object({
    customerId: id,
  }),
  "customer.data_requested": z.object({
    customerId: id,
  }),
} as const satisfies Record<EventTopic, z.ZodType>;

export type EventFacts<T extends EventTopic = EventTopic> = z.infer<(typeof EVENT_FACT_SCHEMAS)[T]>;

export function isEventTopic(value: unknown): value is EventTopic {
  return typeof value === "string" && (EVENT_TOPICS as readonly string[]).includes(value);
}

export function isEventResourceType(value: unknown): value is EventResourceType {
  return typeof value === "string" && (EVENT_RESOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * Parses stored facts for a topic. Unknown topics and malformed facts return
 * null; callers treat that row as unreadable instead of guessing.
 */
export function parseEventFacts<T extends EventTopic>(topic: T, raw: unknown): EventFacts<T> | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = EVENT_FACT_SCHEMAS[topic].safeParse(value);
  return parsed.success ? parsed.data as EventFacts<T> : null;
}

// ── Subscription topic filters ────────────────────────────────────────────

/**
 * A subscription filter is an exact topic, a resource prefix (`order.*`) or
 * `*` (every topic). Prefixes are limited to the catalog's resource prefixes
 * so a typo never subscribes to nothing silently.
 */
export const EVENT_TOPIC_PREFIXES = [
  "order", "return", "product", "inventory", "customer", "fulfillment",
  "shipment", "payment", "checkout", "discount", "review", "gift_card", "object",
] as const;
export type EventTopicPrefix = (typeof EVENT_TOPIC_PREFIXES)[number];
export type EventTopicFilter = EventTopic | `${EventTopicPrefix}.*` | "*";

export const EVENT_TOPIC_FILTERS: readonly EventTopicFilter[] = [
  "*",
  ...EVENT_TOPIC_PREFIXES.map((prefix) => `${prefix}.*` as const),
  ...EVENT_TOPICS,
];

export function isEventTopicFilter(value: unknown): value is EventTopicFilter {
  return typeof value === "string" && (EVENT_TOPIC_FILTERS as readonly string[]).includes(value);
}

export function topicMatchesFilter(topic: EventTopic, filter: string): boolean {
  if (filter === "*") return true;
  if (filter.endsWith(".*")) return topic.startsWith(filter.slice(0, -1));
  return topic === filter;
}

export function topicMatchesAnyFilter(topic: EventTopic, filters: readonly string[]): boolean {
  return filters.some((filter) => topicMatchesFilter(topic, filter));
}

/**
 * Sorted, de-duplicated filters with exact topics already covered by a
 * prefix (or by `*`) removed. Returns null when any entry is not a filter.
 */
export function normalizeEventTopicFilters(values: readonly unknown[]): EventTopicFilter[] | null {
  if (!values.every(isEventTopicFilter)) return null;
  const unique = [...new Set(values as EventTopicFilter[])];
  if (unique.includes("*")) return ["*"];
  const prefixes = unique.filter((filter) => filter.endsWith(".*"));
  return unique
    .filter((filter) => filter.endsWith(".*") || !prefixes.some((prefix) => topicMatchesFilter(filter as EventTopic, prefix)))
    .sort((left, right) => EVENT_TOPIC_FILTERS.indexOf(left) - EVENT_TOPIC_FILTERS.indexOf(right));
}

// ── Delivery envelope ─────────────────────────────────────────────────────

/** The JSON body of every webhook delivery (and the event a plugin receives). */
export interface EventEnvelope<T extends EventTopic = EventTopic> {
  /** The event id: stable across retries, the receiver's idempotency key. */
  id: string;
  topic: T;
  apiVersion: EventsApiVersion;
  /** ISO 8601 time of the domain write. */
  occurredAt: string;
  resource: { type: EventResourceType; id: string };
  /** Thin facts written with the event (the transition it reports). */
  facts: EventFacts<T>;
  /**
   * The resource's sealed representation at delivery time
   * (`EVENT_REPRESENTATION_SCHEMAS[resource.type]`); the truncation shape when
   * the body would pass 512 KiB (`{ truncated: true, id, fetch }`); null only
   * when the resource no longer exists (a permanently deleted product).
   */
  data: EventRepresentation | EventDataTruncation | null;
}

// Sealed representations of each resource type (the delivery `data`).
export * from "./events-representations";

/** The synthetic topic of a dashboard "Send test" delivery; not subscribable. */
export const WEBHOOK_TEST_TOPIC = "webhook.test" as const;

// ── Delivery headers and signature ─────────────────────────────────────────

export const WEBHOOK_EVENT_ID_HEADER = "Scalius-Event-Id";
export const WEBHOOK_TOPIC_HEADER = "Scalius-Topic";
export const WEBHOOK_API_VERSION_HEADER = "Scalius-Api-Version";
export const WEBHOOK_SIGNATURE_HEADER = "Scalius-Signature";
/** Receivers should reject signatures older than this (replay window). */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
export const WEBHOOK_SECRET_PREFIX = "whsec_";

/**
 * `Scalius-Signature` value for a body: `t=<unix seconds>,v1=<hex>` where
 * the hex is HMAC-SHA256 keyed by the whole secret string (`whsec_…`) over
 * `<t>.<raw body>`.
 */
export async function signWebhookPayload(secret: string, timestamp: number, body: string): Promise<string> {
  const t = Math.floor(timestamp);
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Receiver-side check: the header parses, its timestamp is within the
 * tolerance, and one `v1` signature matches the raw body. Several `v1`
 * entries are accepted so a sender may sign with two secrets while rotating.
 */
export async function verifyWebhookSignature(options: {
  secret: string;
  header: string | null | undefined;
  body: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): Promise<boolean> {
  const header = options.header?.trim();
  if (!header) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((piece) => piece?.trim() ?? "");
    if (key === "t" && /^\d{1,12}$/.test(value ?? "")) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/.test(value ?? "")) signatures.push(value!);
  }
  if (timestamp === null || signatures.length === 0) return false;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return false;
  const expected = await hmacSha256Hex(options.secret, `${timestamp}.${options.body}`);
  return signatures.some((signature) => constantTimeEqual(signature, expected));
}
