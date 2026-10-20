/**
 * Event outbox triggers (COMMERCE-HOOKS H3) for D1/Turso and PostgreSQL,
 * generated from one declarative table below. Each trigger writes one
 * `event_outbox` row when its topic has demand, in the same transaction as
 * the domain write. A rolled-back write leaves no event.
 *
 * SQLite (D1, Turso): the guard is the WHEN clause and the body is one
 * `INSERT ... VALUES` (no CASE anywhere: remote D1 rejects trigger bodies that
 * embed one). The facts are `json_object(...)`.
 *
 * PostgreSQL: an AFTER ROW trigger whose WHEN holds the column guard, with
 * demand checked in its function before `jsonb_build_object(...)::text`.
 * The generic SQLite-to-PostgreSQL trigger compiler cannot be used: the
 * PostgreSQL profile's `json_object` takes text only (numbers would become
 * strings) and PostgreSQL has no `randomblob`/`hex`. The canonical PostgreSQL
 * schema compiler takes these forms from `eventOutboxPostgresTrigger`.
 *
 * The migration that installs each (0103_order_channel_event_outbox, then the
 * ones named in `EVENT_TRIGGER_MIGRATIONS`) must contain every generated
 * statement verbatim (`__tests__/event-outbox.test.ts`).
 *
 * Event ids are `evt_` + milliseconds since the epoch (13 digits) + 12
 * random hex characters: unique, and sortable by time to the millisecond.
 */
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";

import * as schema from "../src/schema";
import { CUSTOMER_ADDRESS_ID_PREFIX } from "../src/schema/customers";
import {
  EVENT_TOPIC_RESOURCE,
  type EventTopic,
} from "../../shared/src/events";

/** Trigger name prefix of every generated event trigger. */
export const EVENT_OUTBOX_TRIGGER_PREFIX = "evt_";

// ---------------------------------------------------------------------------
// A tiny expression language rendered for both dialects
// ---------------------------------------------------------------------------

type Image = "NEW" | "OLD";

export type EventExpr =
  | { kind: "column"; image: Image; column: string }
  | { kind: "text"; value: string }
  | { kind: "int"; value: number }
  | { kind: "null" }
  | { kind: "negate"; expr: EventExpr }
  /** The text from the 1-based position `from` (`substr` in both dialects). */
  | { kind: "substr"; expr: EventExpr; from: number }
  | { kind: "lookup"; table: string; select: string; key: string; value: EventExpr };

export type EventCondition =
  | { kind: "eq" | "ne"; left: EventExpr; right: EventExpr }
  /** Null-safe: the two values differ (SQLite `IS NOT`, PostgreSQL `IS DISTINCT FROM`). */
  | { kind: "distinct"; left: EventExpr; right: EventExpr }
  | { kind: "null" | "not_null"; expr: EventExpr }
  | { kind: "in" | "not_in"; expr: EventExpr; values: readonly string[] }
  | { kind: "and" | "or"; conditions: readonly EventCondition[] };

const NEW = (column: string): EventExpr => ({ kind: "column", image: "NEW", column });
const OLD = (column: string): EventExpr => ({ kind: "column", image: "OLD", column });
const text = (value: string): EventExpr => ({ kind: "text", value });
const int = (value: number): EventExpr => ({ kind: "int", value });
const NULL: EventExpr = { kind: "null" };
const negate = (expr: EventExpr): EventExpr => ({ kind: "negate", expr });
const substr = (expr: EventExpr, from: number): EventExpr => ({ kind: "substr", expr, from });
const lookup = (table: string, select: string, key: string, value: EventExpr): EventExpr =>
  ({ kind: "lookup", table, select, key, value });

const eq = (left: EventExpr, right: EventExpr): EventCondition => ({ kind: "eq", left, right });
const ne = (left: EventExpr, right: EventExpr): EventCondition => ({ kind: "ne", left, right });
const isNull = (expr: EventExpr): EventCondition => ({ kind: "null", expr });
const notNull = (expr: EventExpr): EventCondition => ({ kind: "not_null", expr });
const oneOf = (expr: EventExpr, values: readonly string[]): EventCondition => ({ kind: "in", expr, values });
const noneOf = (expr: EventExpr, values: readonly string[]): EventCondition => ({ kind: "not_in", expr, values });
const and = (...conditions: EventCondition[]): EventCondition => ({ kind: "and", conditions });
const or = (...conditions: EventCondition[]): EventCondition => ({ kind: "or", conditions });
/** Any of the columns changed (null-safe). */
const changed = (...columns: string[]): EventCondition =>
  or(...columns.map((column): EventCondition => ({ kind: "distinct", left: OLD(column), right: NEW(column) })));

// ---------------------------------------------------------------------------
// The triggers
// ---------------------------------------------------------------------------

export interface EventTriggerSpec {
  /** Trigger name without the prefix. */
  name: string;
  table: string;
  event: "insert" | "update" | "delete";
  when?: EventCondition;
  topic: EventTopic;
  resourceId: EventExpr;
  /** Fact keys and values in output order (`EVENT_FACT_SCHEMAS[topic]`). */
  facts: ReadonlyArray<readonly [string, EventExpr]>;
}

/**
 * Order columns whose change is an `order.updated`: what a merchant, buyer
 * or integration can see. Bookkeeping (claims, inventory action, version,
 * updated_at) is excluded so internal writes do not emit noise.
 */
export const ORDER_UPDATED_COLUMNS = [
  "status",
  "payment_status",
  "fulfillment_status",
  "payment_method",
  "paid_amount_minor",
  "balance_due_minor",
  "subtotal_amount_minor",
  "shipping_amount_minor",
  "discount_amount_minor",
  "tax_amount_minor",
  "total_amount_minor",
  "customer_name",
  "customer_phone",
  "customer_email",
  "customer_whatsapp",
  "shipping_address",
  "shipping_address_line2",
  "shipping_country_code",
  "shipping_dependent_locality",
  "shipping_locality",
  "shipping_admin_area",
  "shipping_postal_code",
  "shipping_company",
  "shipping_name",
  "shipping_phone",
  "shipping_validation_skipped",
  "city",
  "zone",
  "area",
  // The billing address (0119).
  "billing_same_as_shipping",
  "billing_name",
  "billing_company",
  "billing_address",
  "billing_address_line2",
  "billing_country_code",
  "billing_dependent_locality",
  "billing_locality",
  "billing_admin_area",
  "billing_postal_code",
  "billing_phone",
  "billing_validation_skipped",
  "notes",
  "shipping_method_id",
  "pickup_ready_at",
  "expected_delivery",
  "customer_id",
  "channel_source",
  "invoice_number",
  "archived_at",
  "deleted_at",
] as const;

/**
 * Customer profile columns whose change is a `customer.updated` (not order
 * counters or sign-in times). Address-book writes (0113) are
 * `customer.updated` too, from `customer_addresses`.
 */
export const CUSTOMER_UPDATED_COLUMNS = [
  "name",
  "email",
  "phone",
  "account_claimed_at",
  "phone_verified_at",
  "email_verified_at",
  "origin",
  "merged_into_customer_id",
  "deleted_at",
] as const;

/** Address-book columns whose change is a `customer.updated` of its customer (not timestamps). */
export const CUSTOMER_ADDRESS_UPDATED_COLUMNS = [
  "customer_id",
  "is_default",
  // The default billing address (0119).
  "is_default_billing",
  "country_code",
  "name",
  "company",
  "line1",
  "line2",
  "dependent_locality",
  "locality",
  "admin_area",
  "postal_code",
  "phone_e164",
  "phone_raw",
  "city",
  "zone",
  "area",
  "city_name",
  "zone_name",
  "area_name",
  "validation_skipped",
] as const;

const INCOMPLETE = "incomplete";

/**
 * Created, changed (its revision advanced) and deleted (a draft) events of a
 * revisioned inventory document: facts `{ <idFact>, previousStatus, status,
 * revision }`, with status "deleted" when the row is gone.
 */
function documentRevisionEvents(
  table: "purchase_orders" | "inventory_transfers",
  topic: Extract<EventTopic, "purchase_order.updated" | "inventory_transfer.updated">,
  idFact: string,
): EventTriggerSpec[] {
  return [
    {
      name: `${table}_created`,
      table,
      event: "insert",
      topic,
      resourceId: NEW("id"),
      facts: [[idFact, NEW("id")], ["previousStatus", NULL], ["status", NEW("status")], ["revision", NEW("revision")]],
    },
    {
      name: `${table}_changed`,
      table,
      event: "update",
      when: changed("revision"),
      topic,
      resourceId: NEW("id"),
      facts: [[idFact, NEW("id")], ["previousStatus", OLD("status")], ["status", NEW("status")], ["revision", NEW("revision")]],
    },
    {
      name: `${table}_deleted`,
      table,
      event: "delete",
      topic,
      resourceId: OLD("id"),
      facts: [[idFact, OLD("id")], ["previousStatus", OLD("status")], ["status", text("deleted")], ["revision", OLD("revision")]],
    },
  ];
}

const orderCreatedFacts = [
  ["orderId", NEW("id")],
  ["status", NEW("status")],
  ["paymentStatus", NEW("payment_status")],
  ["channel", NEW("channel")],
] as const;

const productUpdatedFacts = [
  ["productId", NEW("id")],
  ["revision", NEW("aggregate_revision")],
] as const;

/**
 * Every event trigger. An `incomplete` order (online payment not finished)
 * is not yet an order: it emits `order.created` when it leaves that state
 * for anything but `cancelled`, and nothing while incomplete.
 */
const LEGACY_EVENT_TRIGGER_SPECS: readonly EventTriggerSpec[] = [
  // ── orders ────────────────────────────────────────────────────────────
  {
    name: "orders_created",
    table: "orders",
    event: "insert",
    when: ne(NEW("status"), text(INCOMPLETE)),
    topic: "order.created",
    resourceId: NEW("id"),
    facts: orderCreatedFacts,
  },
  {
    name: "orders_created_from_incomplete",
    table: "orders",
    event: "update",
    when: and(eq(OLD("status"), text(INCOMPLETE)), noneOf(NEW("status"), [INCOMPLETE, "cancelled"])),
    topic: "order.created",
    resourceId: NEW("id"),
    facts: orderCreatedFacts,
  },
  {
    name: "orders_updated",
    table: "orders",
    event: "update",
    when: and(
      ne(OLD("status"), text(INCOMPLETE)),
      ne(NEW("status"), text(INCOMPLETE)),
      changed(...ORDER_UPDATED_COLUMNS),
    ),
    topic: "order.updated",
    resourceId: NEW("id"),
    facts: [
      ["orderId", NEW("id")],
      ["previousStatus", OLD("status")],
      ["status", NEW("status")],
      ["previousPaymentStatus", OLD("payment_status")],
      ["paymentStatus", NEW("payment_status")],
      ["previousFulfillmentStatus", OLD("fulfillment_status")],
      ["fulfillmentStatus", NEW("fulfillment_status")],
    ],
  },
  {
    name: "orders_paid_insert",
    table: "orders",
    event: "insert",
    when: and(eq(NEW("payment_status"), text("paid")), ne(NEW("status"), text(INCOMPLETE))),
    topic: "order.paid",
    resourceId: NEW("id"),
    facts: [
      ["orderId", NEW("id")],
      ["previousPaymentStatus", NULL],
      ["paymentStatus", NEW("payment_status")],
    ],
  },
  {
    name: "orders_paid",
    table: "orders",
    event: "update",
    when: and(
      eq(NEW("payment_status"), text("paid")),
      { kind: "distinct", left: OLD("payment_status"), right: text("paid") },
      ne(NEW("status"), text(INCOMPLETE)),
    ),
    topic: "order.paid",
    resourceId: NEW("id"),
    facts: [
      ["orderId", NEW("id")],
      ["previousPaymentStatus", OLD("payment_status")],
      ["paymentStatus", NEW("payment_status")],
    ],
  },
  {
    name: "orders_cancelled",
    table: "orders",
    event: "update",
    when: and(eq(NEW("status"), text("cancelled")), noneOf(OLD("status"), ["cancelled", INCOMPLETE])),
    topic: "order.cancelled",
    resourceId: NEW("id"),
    facts: [
      ["orderId", NEW("id")],
      ["previousStatus", OLD("status")],
    ],
  },
  // ── fulfilments, refunds, returns ─────────────────────────────────────
  {
    name: "order_fulfillments_created",
    table: "order_fulfillments",
    event: "insert",
    when: eq(NEW("status"), text("active")),
    topic: "order.fulfilled",
    resourceId: NEW("order_id"),
    facts: [
      ["orderId", NEW("order_id")],
      ["fulfillmentId", NEW("id")],
      ["kind", NEW("kind")],
      ["locationId", NEW("location_id")],
    ],
  },
  {
    name: "order_payments_refunded_insert",
    table: "order_payments",
    event: "insert",
    when: and(eq(NEW("payment_type"), text("refund")), eq(NEW("status"), text("refunded"))),
    topic: "order.refunded",
    resourceId: NEW("order_id"),
    facts: [
      ["orderId", NEW("order_id")],
      ["paymentId", NEW("id")],
    ],
  },
  {
    name: "order_payments_refunded",
    table: "order_payments",
    event: "update",
    when: and(
      eq(NEW("payment_type"), text("refund")),
      eq(NEW("status"), text("refunded")),
      { kind: "distinct", left: OLD("status"), right: text("refunded") },
    ),
    topic: "order.refunded",
    resourceId: NEW("order_id"),
    facts: [
      ["orderId", NEW("order_id")],
      ["paymentId", NEW("id")],
    ],
  },
  {
    name: "order_returns_created",
    table: "order_returns",
    event: "insert",
    topic: "return.updated",
    resourceId: NEW("id"),
    facts: [
      ["returnId", NEW("id")],
      ["orderId", NEW("order_id")],
      ["previousStatus", NULL],
      ["status", NEW("status")],
    ],
  },
  {
    name: "order_returns_status",
    table: "order_returns",
    event: "update",
    when: changed("status"),
    topic: "return.updated",
    resourceId: NEW("id"),
    facts: [
      ["returnId", NEW("id")],
      ["orderId", NEW("order_id")],
      ["previousStatus", OLD("status")],
      ["status", NEW("status")],
    ],
  },
  // ── products ──────────────────────────────────────────────────────────
  {
    name: "products_created",
    table: "products",
    event: "insert",
    topic: "product.created",
    resourceId: NEW("id"),
    facts: [["productId", NEW("id")]],
  },
  {
    // Every product edit advances the aggregate revision exactly once (tax
    // classification has its own version); a restore from trash is an update.
    name: "products_updated",
    table: "products",
    event: "update",
    when: and(
      isNull(NEW("deleted_at")),
      or(changed("aggregate_revision", "tax_classification_version"), notNull(OLD("deleted_at"))),
    ),
    topic: "product.updated",
    resourceId: NEW("id"),
    facts: productUpdatedFacts,
  },
  {
    name: "products_trashed",
    table: "products",
    event: "update",
    when: and(isNull(OLD("deleted_at")), notNull(NEW("deleted_at"))),
    topic: "product.deleted",
    resourceId: NEW("id"),
    facts: [
      ["productId", NEW("id")],
      ["deletion", text("trashed")],
    ],
  },
  {
    name: "products_deleted",
    table: "products",
    event: "delete",
    topic: "product.deleted",
    resourceId: OLD("id"),
    facts: [
      ["productId", OLD("id")],
      ["deletion", text("permanent")],
    ],
  },
  // ── product publications (0122) ───────────────────────────────────────
  // A row without unpublished_at is a publication; an insert of an
  // unpublished row was never published and emits nothing.
  {
    name: "product_channel_publications_published",
    table: "product_channel_publications",
    event: "insert",
    when: isNull(NEW("unpublished_at")),
    topic: "product.publication_changed",
    resourceId: NEW("product_id"),
    facts: [
      ["productId", NEW("product_id")],
      ["channelId", NEW("channel_id")],
      ["state", text("published")],
    ],
  },
  {
    name: "product_channel_publications_republished",
    table: "product_channel_publications",
    event: "update",
    when: and(notNull(OLD("unpublished_at")), isNull(NEW("unpublished_at"))),
    topic: "product.publication_changed",
    resourceId: NEW("product_id"),
    facts: [
      ["productId", NEW("product_id")],
      ["channelId", NEW("channel_id")],
      ["state", text("published")],
    ],
  },
  {
    name: "product_channel_publications_unpublished",
    table: "product_channel_publications",
    event: "update",
    when: and(isNull(OLD("unpublished_at")), notNull(NEW("unpublished_at"))),
    topic: "product.publication_changed",
    resourceId: NEW("product_id"),
    facts: [
      ["productId", NEW("product_id")],
      ["channelId", NEW("channel_id")],
      ["state", text("unpublished")],
    ],
  },
  {
    name: "product_channel_publications_removed",
    table: "product_channel_publications",
    event: "delete",
    when: isNull(OLD("unpublished_at")),
    topic: "product.publication_changed",
    resourceId: OLD("product_id"),
    facts: [
      ["productId", OLD("product_id")],
      ["channelId", OLD("channel_id")],
      ["state", text("unpublished")],
    ],
  },
  // ── inventory ─────────────────────────────────────────────────────────
  {
    // On-hand stock moved at a location (ledger movements with a stock
    // delta); reservations move no physical stock and emit nothing.
    name: "inventory_movements_stock",
    table: "inventory_movements",
    event: "insert",
    when: ne(NEW("stock_delta"), int(0)),
    topic: "variant.inventory_changed",
    resourceId: NEW("variant_id"),
    facts: [
      ["variantId", NEW("variant_id")],
      ["productId", lookup("product_variants", "product_id", "id", NEW("variant_id"))],
      ["locationId", NEW("location_id")],
      ["quantityDelta", NEW("stock_delta")],
      ["movementId", NEW("id")],
      ["movementType", NEW("type")],
    ],
  },
  {
    // A compensating delete reverses its movement's stock.
    name: "inventory_movements_reverted",
    table: "inventory_movements",
    event: "delete",
    when: ne(OLD("stock_delta"), int(0)),
    topic: "variant.inventory_changed",
    resourceId: OLD("variant_id"),
    facts: [
      ["variantId", OLD("variant_id")],
      ["productId", lookup("product_variants", "product_id", "id", OLD("variant_id"))],
      ["locationId", OLD("location_id")],
      ["quantityDelta", negate(OLD("stock_delta"))],
      ["movementId", OLD("id")],
      ["movementType", text("reversal")],
    ],
  },
  // ── purchase orders and transfers (0109) ──────────────────────────────
  // Every write advances `revision` exactly once, so one event per write.
  ...documentRevisionEvents("purchase_orders", "purchase_order.updated", "purchaseOrderId"),
  ...documentRevisionEvents("inventory_transfers", "inventory_transfer.updated", "transferId"),
  // ── customers ─────────────────────────────────────────────────────────
  {
    name: "customers_created",
    table: "customers",
    event: "insert",
    topic: "customer.created",
    resourceId: NEW("id"),
    facts: [["customerId", NEW("id")]],
  },
  {
    name: "customers_updated",
    table: "customers",
    event: "update",
    when: changed(...CUSTOMER_UPDATED_COLUMNS),
    topic: "customer.updated",
    resourceId: NEW("id"),
    facts: [["customerId", NEW("id")]],
  },
  // ── the address book (0113): any change is its customer's update ─────
  {
    name: "customer_addresses_created",
    table: "customer_addresses",
    event: "insert",
    // Not a record's first address, written with it (`caddr_<customer id>`:
    // a new record's address, an order's seed): its `customer.created`
    // carries it, as when the address was a customer column.
    when: ne(substr(NEW("id"), CUSTOMER_ADDRESS_ID_PREFIX.length + 1), NEW("customer_id")),
    topic: "customer.updated",
    resourceId: NEW("customer_id"),
    facts: [["customerId", NEW("customer_id")]],
  },
  {
    name: "customer_addresses_changed",
    table: "customer_addresses",
    event: "update",
    when: changed(...CUSTOMER_ADDRESS_UPDATED_COLUMNS),
    topic: "customer.updated",
    resourceId: NEW("customer_id"),
    facts: [["customerId", NEW("customer_id")]],
  },
  {
    name: "customer_addresses_deleted",
    table: "customer_addresses",
    event: "delete",
    // Not when its customer is being deleted (the cascade): that is no update.
    when: notNull(lookup("customers", "id", "id", OLD("customer_id"))),
    topic: "customer.updated",
    resourceId: OLD("customer_id"),
    facts: [["customerId", OLD("customer_id")]],
  },
  // ── marketing consent (0108) ──────────────────────────────────────────
  {
    name: "customer_marketing_consents_created",
    table: "customer_marketing_consents",
    event: "insert",
    topic: "customer.consent_changed",
    resourceId: NEW("customer_id"),
    facts: [
      ["customerId", NEW("customer_id")],
      ["channel", NEW("channel")],
      ["previousState", NULL],
      ["state", NEW("state")],
      ["source", NEW("source")],
    ],
  },
  {
    name: "customer_marketing_consents_changed",
    table: "customer_marketing_consents",
    event: "update",
    when: changed("state"),
    topic: "customer.consent_changed",
    resourceId: NEW("customer_id"),
    facts: [
      ["customerId", NEW("customer_id")],
      ["channel", NEW("channel")],
      ["previousState", OLD("state")],
      ["state", NEW("state")],
      ["source", NEW("source")],
    ],
  },
];

/** Additive beta catalog; facts deliberately exclude contact, amount and object data fields. */
const BETA_EVENT_TRIGGER_SPECS: EventTriggerSpec[] = [
  ...(["insert", "update"] as const).map((event): EventTriggerSpec => ({
    name: `fulfillments_${event === "insert" ? "created" : "voided"}`,
    table: "order_fulfillments", event,
    when: event === "insert" ? eq(NEW("status"), text("active")) : and(eq(OLD("status"), text("active")), eq(NEW("status"), text("voided"))),
    topic: event === "insert" ? "fulfillment.created" : "fulfillment.voided",
    resourceId: NEW("id"),
    facts: [["fulfillmentId", NEW("id")], ["orderId", NEW("order_id")], ["kind", NEW("kind")], ["locationId", NEW("location_id")]],
  })),
  {
    name: "shipments_status", table: "delivery_shipments", event: "update", when: changed("status"),
    topic: "shipment.updated", resourceId: NEW("id"),
    facts: [["shipmentId", NEW("id")], ["orderId", NEW("order_id")], ["providerId", NEW("provider_id")], ["previousStatus", OLD("status")], ["status", NEW("status")]],
  },
  ...(["insert", "update"] as const).map((event): EventTriggerSpec => ({
    name: `payments_${event}`, table: "order_payments", event,
    ...(event === "update" ? { when: changed("status") } : {}),
    topic: "payment.updated", resourceId: NEW("id"),
    facts: [["paymentId", NEW("id")], ["orderId", NEW("order_id")], ["provider", NEW("payment_method")], ["previousStatus", event === "insert" ? NULL : OLD("status")], ["status", NEW("status")]],
  })),
  {
    name: "checkouts_abandoned", table: "abandoned_checkouts", event: "update",
    when: and(isNull(OLD("abandoned_at")), notNull(NEW("abandoned_at"))),
    topic: "checkout.abandoned", resourceId: NEW("id"),
    facts: [["abandonedCheckoutId", NEW("id")], ["checkoutId", NEW("checkout_id")]],
  },
  {
    name: "promotions_created", table: "promotions", event: "insert", when: isNull(NEW("deleted_at")),
    topic: "discount.created", resourceId: NEW("id"),
    facts: [["promotionId", NEW("id")], ["previousStatus", NULL], ["status", NEW("status")]],
  },
  {
    name: "promotions_updated", table: "promotions", event: "update",
    when: and(isNull(NEW("deleted_at")), changed("revision", "status", "deleted_at")),
    topic: "discount.updated", resourceId: NEW("id"),
    facts: [["promotionId", NEW("id")], ["previousStatus", OLD("status")], ["status", NEW("status")]],
  },
  ...(["update", "delete"] as const).map((event): EventTriggerSpec => ({
    name: `promotions_${event === "update" ? "trashed" : "deleted"}`, table: "promotions", event,
    ...(event === "update" ? { when: and(isNull(OLD("deleted_at")), notNull(NEW("deleted_at"))) } : {}),
    topic: "discount.deleted", resourceId: OLD("id"),
    facts: [["promotionId", OLD("id")], ["previousStatus", OLD("status")], ["status", text("deleted")]],
  })),
  {
    name: "promotions_redeemed", table: "promotion_redemptions", event: "insert",
    topic: "discount.redeemed", resourceId: NEW("promotion_id"),
    facts: [["promotionId", NEW("promotion_id")], ["orderId", NEW("order_id")], ["codeId", lookup("promotion_codes", "id", "normalized_code", NEW("promotion_code"))]],
  },
  ...(["insert", "update"] as const).map((event): EventTriggerSpec => ({
    name: `reviews_${event}`, table: "product_reviews", event,
    ...(event === "update" ? { when: changed("status") } : {}),
    topic: event === "insert" ? "review.created" : "review.updated", resourceId: NEW("id"),
    facts: [["reviewId", NEW("id")], ["productId", NEW("product_id")], ["previousStatus", event === "insert" ? NULL : OLD("status")], ["status", NEW("status")], ["rating", NEW("rating")]],
  })),
  ...(["insert", "update"] as const).map((event): EventTriggerSpec => ({
    name: `gift_cards_${event}`, table: "gift_cards", event,
    ...(event === "update" ? { when: changed("status") } : {}),
    topic: event === "insert" ? "gift_card.created" : "gift_card.updated", resourceId: NEW("id"),
    facts: [["giftCardId", NEW("id")], ["previousStatus", event === "insert" ? NULL : OLD("status")], ["status", NEW("status")]],
  })),
  {
    name: "gift_card_transactions_created", table: "gift_card_transactions", event: "insert",
    topic: "gift_card_transaction.created", resourceId: NEW("id"),
    facts: [["giftCardId", NEW("gift_card_id")], ["transactionId", NEW("id")], ["kind", NEW("kind")], ["orderId", NEW("order_id")]],
  },
  ...(["insert", "update", "delete"] as const).map((event): EventTriggerSpec => {
    const row = event === "delete" ? OLD : NEW;
    return {
      name: `objects_${event}`, table: "object_records", event,
      when: event === "update" ? and(eq(row("ev"), int(1)), changed("revision")) : eq(row("ev"), int(1)),
      topic: event === "insert" ? "object.created" : event === "update" ? "object.updated" : "object.deleted",
      resourceId: row("id"),
      facts: [["objectType", row("type_id")], ["objectId", row("id")], ["revision", row("revision")], ["status", event === "delete" ? text("deleted") : row("status")]],
    };
  }),
];

export const EVENT_TRIGGER_SPECS: readonly EventTriggerSpec[] = [...LEGACY_EVENT_TRIGGER_SPECS, ...BETA_EVENT_TRIGGER_SPECS];

/**
 * The migration that installed each trigger: 0103 installed the first set;
 * later migrations add theirs and must contain each generated statement
 * verbatim (`__tests__/event-outbox.test.ts`).
 */
const HISTORICAL_EVENT_TRIGGER_MIGRATIONS: Readonly<Record<string, string>> = {
  customer_marketing_consents_created: "0108_customer_marketing",
  customer_marketing_consents_changed: "0108_customer_marketing",
  purchase_orders_created: "0109_inventory_purchasing",
  purchase_orders_changed: "0109_inventory_purchasing",
  purchase_orders_deleted: "0109_inventory_purchasing",
  inventory_transfers_created: "0109_inventory_purchasing",
  inventory_transfers_changed: "0109_inventory_purchasing",
  inventory_transfers_deleted: "0109_inventory_purchasing",
  // 0113 (country-aware addresses) re-creates these two with the new column
  // lists and adds the address book's.
  customers_updated: "0113_country_aware_addresses",
  customer_addresses_created: "0113_country_aware_addresses",
  customer_addresses_deleted: "0113_country_aware_addresses",
  // 0119 (billing addresses) re-creates these with the billing columns.
  orders_updated: "0119_billing_addresses",
  customer_addresses_changed: "0119_billing_addresses",
  product_channel_publications_published: "0122_sales_channels",
  product_channel_publications_republished: "0122_sales_channels",
  product_channel_publications_unpublished: "0122_sales_channels",
  product_channel_publications_removed: "0122_sales_channels",
};

/**
 * Earlier forms of triggers a later migration re-created, with the migration
 * that installed them: a schema compiled before the re-creation (the
 * PostgreSQL upgrade path starts from the fresh 0103 schema) keeps the form
 * it really has. Their columns may no longer exist, so they are not checked
 * against today's schema; their migration must still carry them verbatim.
 */
export const SUPERSEDED_EVENT_TRIGGER_SPECS: ReadonlyArray<{ migration: string; spec: EventTriggerSpec }> = [
  {
    migration: "0103_order_channel_event_outbox",
    spec: {
      ...EVENT_TRIGGER_SPECS.find((spec) => spec.name === "orders_updated")!,
      when: and(
        ne(OLD("status"), text(INCOMPLETE)),
        ne(NEW("status"), text(INCOMPLETE)),
        changed(
          "status", "payment_status", "fulfillment_status", "payment_method", "paid_amount_minor", "balance_due_minor",
          "subtotal_amount_minor", "shipping_amount_minor", "discount_amount_minor", "tax_amount_minor", "total_amount_minor",
          "customer_name", "customer_phone", "customer_email", "customer_whatsapp", "shipping_address", "city", "zone", "area",
          "notes", "shipping_method_id", "pickup_ready_at", "expected_delivery", "customer_id", "channel_source",
          "invoice_number", "archived_at", "deleted_at",
        ),
      ),
    },
  },
  {
    migration: "0103_order_channel_event_outbox",
    spec: {
      ...EVENT_TRIGGER_SPECS.find((spec) => spec.name === "customers_updated")!,
      when: changed(
        "name", "email", "phone", "address", "city", "zone", "area", "city_name", "zone_name", "area_name",
        "account_claimed_at", "phone_verified_at", "email_verified_at", "origin", "merged_into_customer_id", "deleted_at",
      ),
    },
  },
  // The 0113 forms, before 0119 added the billing columns.
  {
    migration: "0113_country_aware_addresses",
    spec: {
      ...EVENT_TRIGGER_SPECS.find((spec) => spec.name === "orders_updated")!,
      when: and(
        ne(OLD("status"), text(INCOMPLETE)),
        ne(NEW("status"), text(INCOMPLETE)),
        changed(...ORDER_UPDATED_COLUMNS.filter((column) => !column.startsWith("billing_"))),
      ),
    },
  },
  {
    migration: "0113_country_aware_addresses",
    spec: {
      ...EVENT_TRIGGER_SPECS.find((spec) => spec.name === "customer_addresses_changed")!,
      when: changed(...CUSTOMER_ADDRESS_UPDATED_COLUMNS.filter((column) => column !== "is_default_billing")),
    },
  },
];

export const EVENT_DEMAND_MIGRATION = "0155_v2_beta_contract";

/**
 * 0164 renamed four topics so each prefix names its resource; it re-creates
 * their triggers and rewrites the stored names. Each renamed topic's earlier
 * name and resource type, as the migrations before it installed them.
 */
export const EVENT_TOPIC_RENAME_MIGRATION = "0164_event_topic_names";
export const EVENT_TOPICS_BEFORE_0164: Readonly<Partial<Record<EventTopic, { topic: string; resourceType: string }>>> = {
  "variant.inventory_changed": { topic: "inventory.level_changed", resourceType: "variant" },
  "purchase_order.updated": { topic: "inventory.purchase_order_updated", resourceType: "purchase_order" },
  "inventory_transfer.updated": { topic: "inventory.transfer_updated", resourceType: "inventory_transfer" },
  "gift_card_transaction.created": { topic: "gift_card.transaction", resourceType: "transaction" },
};

/** A spec as rendered: its topic and resource type may be ones a later migration renamed. */
interface RenderedSpec extends Omit<EventTriggerSpec, "topic"> {
  topic: string;
  resourceType: string;
}

const current = (spec: EventTriggerSpec): RenderedSpec => ({ ...spec, resourceType: EVENT_TOPIC_RESOURCE[spec.topic] });
const before0164 = (spec: EventTriggerSpec): RenderedSpec => ({ ...current(spec), ...EVENT_TOPICS_BEFORE_0164[spec.topic] });
const renamedIn0164 = (name: string) => {
  const spec = EVENT_TRIGGER_SPECS.find((candidate) => candidate.name === name);
  return spec !== undefined && EVENT_TOPICS_BEFORE_0164[spec.topic] !== undefined;
};

export const EVENT_TRIGGER_MIGRATIONS: Readonly<Record<string, string>> = Object.fromEntries(
  EVENT_TRIGGER_SPECS.map((spec) => [spec.name, eventTriggerMigration(spec)]),
);

/** The migration file name (without `.sql`) that installs the current trigger. */
export function eventTriggerMigration(spec: Pick<EventTriggerSpec, "name">): string {
  return renamedIn0164(spec.name) ? EVENT_TOPIC_RENAME_MIGRATION : EVENT_DEMAND_MIGRATION;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type Dialect = "sqlite" | "postgres";

const id = (dialect: Dialect, name: string) => (dialect === "sqlite" ? `\`${name}\`` : `"${name}"`);
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function renderExpr(dialect: Dialect, expr: EventExpr): string {
  switch (expr.kind) {
    case "column":
      return `${expr.image}.${id(dialect, expr.column)}`;
    case "text":
      return literal(expr.value);
    case "int":
      if (!Number.isSafeInteger(expr.value)) throw new Error(`Invalid integer literal ${expr.value}.`);
      return String(expr.value);
    case "null":
      return "NULL";
    case "negate":
      return `-${renderExpr(dialect, expr.expr)}`;
    case "substr":
      if (!Number.isSafeInteger(expr.from) || expr.from < 1) throw new Error(`Invalid substr position ${expr.from}.`);
      return `substr(${renderExpr(dialect, expr.expr)}, ${expr.from})`;
    case "lookup":
      return `(SELECT ${id(dialect, expr.select)} FROM ${id(dialect, expr.table)} WHERE ${id(dialect, expr.key)} = ${renderExpr(dialect, expr.value)})`;
  }
}

function renderCondition(dialect: Dialect, condition: EventCondition): string {
  switch (condition.kind) {
    case "eq":
      return `${renderExpr(dialect, condition.left)} = ${renderExpr(dialect, condition.right)}`;
    case "ne":
      return `${renderExpr(dialect, condition.left)} <> ${renderExpr(dialect, condition.right)}`;
    case "distinct":
      return `${renderExpr(dialect, condition.left)} ${dialect === "sqlite" ? "IS NOT" : "IS DISTINCT FROM"} ${renderExpr(dialect, condition.right)}`;
    case "null":
      return `${renderExpr(dialect, condition.expr)} IS NULL`;
    case "not_null":
      return `${renderExpr(dialect, condition.expr)} IS NOT NULL`;
    case "in":
    case "not_in":
      return `${renderExpr(dialect, condition.expr)} ${condition.kind === "in" ? "IN" : "NOT IN"} (${condition.values.map(literal).join(", ")})`;
    case "and":
    case "or":
      return `(${condition.conditions.map((part) => renderCondition(dialect, part)).join(condition.kind === "and" ? " AND " : " OR ")})`;
  }
}

function eventIdSql(dialect: Dialect): string {
  return dialect === "sqlite"
    ? "'evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6)))"
    : "'evt_' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || substr(md5(random()::text || clock_timestamp()::text), 1, 12)";
}

function factsSql(dialect: Dialect, facts: EventTriggerSpec["facts"]): string {
  const pairs = facts.map(([key, value]) => `${literal(key)}, ${renderExpr(dialect, value)}`).join(", ");
  return dialect === "sqlite" ? `json_object(${pairs})` : `jsonb_build_object(${pairs})::text`;
}

function insertSql(dialect: Dialect, spec: RenderedSpec): string {
  const resourceType = spec.resourceType;
  const columns = ["id", "topic", "resource_type", "resource_id", "data"].map((column) => id(dialect, column)).join(", ");
  return `INSERT INTO ${id(dialect, "event_outbox")} (${columns}) VALUES (${[
    eventIdSql(dialect),
    literal(spec.topic),
    literal(resourceType),
    renderExpr(dialect, spec.resourceId),
    factsSql(dialect, spec.facts),
  ].join(", ")})`;
}

export function eventTriggerName(spec: Pick<EventTriggerSpec, "name">): string {
  return `${EVENT_OUTBOX_TRIGGER_PREFIX}${spec.name}`;
}

function demandGuard(spec: RenderedSpec): string {
  return `EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', ${literal(`${spec.topic.split(".")[0]}.*`)}, ${literal(spec.topic)}))`;
}

function sqliteTrigger(spec: RenderedSpec, demandGated = false): string {
  return [
    `CREATE TRIGGER ${id("sqlite", eventTriggerName(spec))} AFTER ${spec.event.toUpperCase()} ON ${id("sqlite", spec.table)}`,
    ...((spec.when || demandGated) ? [`WHEN ${[spec.when && renderCondition("sqlite", spec.when), demandGated && demandGuard(spec)].filter(Boolean).join(" AND ")}`] : []),
    "BEGIN",
    `  ${insertSql("sqlite", spec)};`,
    "END",
  ].join("\n");
}

/** Whether a condition reads another table (PostgreSQL forbids a subquery in a trigger's WHEN). */
function conditionHasLookup(condition: EventCondition): boolean {
  const exprHasLookup = (expr: EventExpr): boolean =>
    expr.kind === "lookup" || (expr.kind === "negate" && exprHasLookup(expr.expr));
  switch (condition.kind) {
    case "and":
    case "or":
      return condition.conditions.some(conditionHasLookup);
    case "eq":
    case "ne":
    case "distinct":
      return exprHasLookup(condition.left) || exprHasLookup(condition.right);
    default:
      return exprHasLookup(condition.expr);
  }
}

function postgresTrigger(spec: RenderedSpec, demandGated = false): string {
  const name = eventTriggerName(spec);
  const fn = `scalius_compat.${id("postgres", `${name}_fn`)}`;
  // A guard that reads another table runs inside the function instead.
  const inBody = spec.when !== undefined && conditionHasLookup(spec.when);
  return [
    `CREATE OR REPLACE FUNCTION ${fn}()`,
    "RETURNS trigger",
    "LANGUAGE plpgsql",
    "AS $trigger_function$",
    "BEGIN",
    ...(inBody ? [`  IF NOT coalesce((${renderCondition("postgres", spec.when!)}), false) THEN`, "    RETURN NULL;", "  END IF;"] : []),
    ...(demandGated ? [`  IF NOT ${demandGuard(spec)} THEN`, "    RETURN NULL;", "  END IF;"] : []),
    `  ${insertSql("postgres", spec)};`,
    "  RETURN NULL;",
    "END",
    "$trigger_function$;",
    `CREATE TRIGGER ${id("postgres", name)}`,
    `AFTER ${spec.event.toUpperCase()} ON ${id("postgres", spec.table)}`,
    "FOR EACH ROW",
    ...(spec.when && !inBody ? [`WHEN (${renderCondition("postgres", spec.when)})`] : []),
    `EXECUTE FUNCTION ${fn}()`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Schema checks
// ---------------------------------------------------------------------------

const tableColumns = new Map<string, string[]>();
for (const value of Object.values(schema)) {
  if (!value || typeof value !== "object") continue;
  try {
    const config = getTableConfig(value as SQLiteTable);
    if (config?.name) tableColumns.set(config.name, config.columns.map((column) => column.name));
  } catch {
    // Not a table.
  }
}

function assertColumn(table: string, column: string, trigger: string): void {
  const columns = tableColumns.get(table);
  if (!columns) throw new Error(`${trigger}: unknown table ${table}.`);
  if (!columns.includes(column)) throw new Error(`${trigger}: unknown column ${table}.${column}.`);
}

function exprColumns(table: string, expr: EventExpr, trigger: string, event: EventTriggerSpec["event"]): void {
  switch (expr.kind) {
    case "column":
      if (event === "insert" && expr.image === "OLD") throw new Error(`${trigger}: an insert has no OLD row.`);
      if (event === "delete" && expr.image === "NEW") throw new Error(`${trigger}: a delete has no NEW row.`);
      assertColumn(table, expr.column, trigger);
      return;
    case "negate":
    case "substr":
      exprColumns(table, expr.expr, trigger, event);
      return;
    case "lookup":
      assertColumn(expr.table, expr.select, trigger);
      assertColumn(expr.table, expr.key, trigger);
      exprColumns(table, expr.value, trigger, event);
      return;
    default:
      return;
  }
}

function conditionColumns(table: string, condition: EventCondition, trigger: string, event: EventTriggerSpec["event"]): void {
  switch (condition.kind) {
    case "and":
    case "or":
      for (const part of condition.conditions) conditionColumns(table, part, trigger, event);
      return;
    case "null":
    case "not_null":
    case "in":
    case "not_in":
      exprColumns(table, condition.expr, trigger, event);
      return;
    default:
      exprColumns(table, condition.left, trigger, event);
      exprColumns(table, condition.right, trigger, event);
  }
}

export interface GeneratedEventTrigger {
  name: string;
  table: string;
  topic: EventTopic;
  sqlite: string;
  postgres: string;
}

export function generateEventOutboxTriggers(): GeneratedEventTrigger[] {
  const names = new Set<string>();
  return EVENT_TRIGGER_SPECS.map((spec) => {
    const name = eventTriggerName(spec);
    if (names.has(name)) throw new Error(`Duplicate event trigger ${name}.`);
    names.add(name);
    exprColumns(spec.table, spec.resourceId, name, spec.event);
    for (const [, value] of spec.facts) exprColumns(spec.table, value, name, spec.event);
    if (spec.when) conditionColumns(spec.table, spec.when, name, spec.event);
    return { name, table: spec.table, topic: spec.topic, sqlite: sqliteTrigger(current(spec), true), postgres: postgresTrigger(current(spec), true) };
  });
}

const generated = generateEventOutboxTriggers();
const postgresByName = new Map(generated.map((trigger) => [trigger.name, trigger.postgres]));
const normalizeTriggerSql = (sql: string) => sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
const superseded = [
  ...SUPERSEDED_EVENT_TRIGGER_SPECS.map(({ migration, spec }) => ({ migration, spec: before0164(spec), demandGated: false })),
  ...LEGACY_EVENT_TRIGGER_SPECS.map((spec) => ({
    migration: HISTORICAL_EVENT_TRIGGER_MIGRATIONS[spec.name] ?? "0103_order_channel_event_outbox",
    spec: before0164(spec),
    demandGated: false,
  })),
  // The demand-gated forms 0155 installed for the topics 0164 renamed.
  ...EVENT_TRIGGER_SPECS.filter((spec) => renamedIn0164(spec.name)).map((spec) => ({
    migration: EVENT_DEMAND_MIGRATION,
    spec: before0164(spec),
    demandGated: true,
  })),
].map(({ migration, spec, demandGated }) => ({
  migration,
  name: eventTriggerName(spec),
  sqlite: sqliteTrigger(spec, demandGated),
  postgres: postgresTrigger(spec, demandGated),
}));

/** The superseded SQLite statements (each ends with `;`) a migration installed. */
export function supersededEventOutboxSqliteStatements(migration: string): string[] {
  return superseded.filter((trigger) => trigger.migration === migration).map((trigger) => `${trigger.sqlite};`);
}

/** The superseded PostgreSQL statements (each ends with `;`) a migration installed. */
export function supersededEventOutboxPostgresStatements(migration: string): string[] {
  return superseded.filter((trigger) => trigger.migration === migration).map((trigger) => `${trigger.postgres};`);
}

/**
 * The PostgreSQL form of a generated event trigger for the canonical
 * PostgreSQL schema compiler, or `undefined` for any other trigger.
 */
export function eventOutboxPostgresTrigger(name: string, sqliteSql?: string): string | undefined {
  // A schema from before a re-creation holds the earlier form: compile that one.
  const earlier = sqliteSql === undefined
    ? undefined
    : superseded.find((trigger) => trigger.name === name && normalizeTriggerSql(trigger.sqlite) === normalizeTriggerSql(sqliteSql));
  const postgresSql = earlier?.postgres ?? postgresByName.get(name);
  return postgresSql === undefined ? undefined : `${postgresSql};`;
}

const inMigration = (migration: string | undefined) => (trigger: GeneratedEventTrigger) =>
  migration === undefined || eventTriggerMigration({ name: trigger.name.slice(EVENT_OUTBOX_TRIGGER_PREFIX.length) }) === migration;

/** The SQLite statements (each ends with `;`) in declaration order, optionally of one migration. */
export function eventOutboxSqliteStatements(migration?: string): string[] {
  return generated.filter(inMigration(migration)).map((trigger) => `${trigger.sqlite};`);
}

/** The PostgreSQL statements (each ends with `;`) in declaration order, optionally of one migration. */
export function eventOutboxPostgresStatements(migration?: string): string[] {
  return generated.filter(inMigration(migration)).map((trigger) => `${trigger.postgres};`);
}
