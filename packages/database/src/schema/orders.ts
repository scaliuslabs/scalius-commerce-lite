// src/db/schema/orders.ts
// Order domain tables: orders, checkoutAttempts, orderReceipts, orderItems, orderPayments, refundAttempts,
// orderSupportRequests, paymentPlans, codTracking, webhookEvents, abandonedCheckouts.
// The fulfilment ledger lives in fulfilment.ts, threads in conversations.ts
// and the generic outbox in notifications.ts.

import { sqliteTable, text, integer, unique, uniqueIndex, index, check, primaryKey } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { customers } from "./customers";
import { products, productVariants } from "./products";
import { media } from "./media";
import { inventoryLocations, inventoryMovements } from "./inventory";
import { UNIX_NOW, contactPhone } from "./shared";
import { user } from "./auth";
import { conversations } from "./conversations";
import { warrantyPolicyRevisions } from "./warranty";
import { markets } from "./markets";
import {
    OrderStatus,
    PaymentMethod,
    PaymentStatus,
    FulfillmentStatus,
    InventoryPool,
    PaymentRecordStatus,
    CodStatus,
    PaymentPlanStatus,
} from "./enums";

/** Mirrors `ORDER_CHANNELS` in `@scalius/shared/order-channel` (a test keeps them equal). */
export const ORDER_CHANNEL_VALUES = ["online_store", "admin", "pos", "agent", "app"] as const;

export const orders = sqliteTable("orders", {
    id: text("id").primaryKey(),
    /**
     * Sequential per-store number shown as "#1001". Every order-creating write
     * allocates it in the same INSERT (`nextOrderNumberSql`); the unique index
     * makes a concurrent duplicate fail instead of committing.
     */
    orderNumber: integer("order_number"),
    customerName: text("customer_name").notNull(),
    /** Null for an order placed without a phone (stored as '', `contactPhone`). */
    customerPhone: contactPhone("customer_phone").notNull(),
    customerEmail: text("customer_email"),
    /** Separate WhatsApp number, when Customer accounts collects one; null means the phone. */
    customerWhatsapp: text("customer_whatsapp"),
    /**
     * The shipping address snapshot (MARKETS-DESIGN D7, migration 0113),
     * present exactly when something ships (`requiresShipping`); pickup,
     * service-only and digital orders carry none. `shippingAddress` is the
     * first street line. Triggers `orders_shipping_address_required_*` check
     * it per country: Bangladesh needs its city and thana; another country
     * needs what its rules require unless staff skipped validation.
     */
    shippingAddress: text("shipping_address"),
    shippingAddressLine2: text("shipping_address_line2"),
    /**
     * ISO 3166-1 alpha-2; it decides the order's market. Every order writer
     * sets it when something ships; a shipped row written by raw SQL without
     * one counts as Bangladesh (the delivery hierarchy), as before 0113.
     */
    shippingCountryCode: text("shipping_country_code"),
    shippingDependentLocality: text("shipping_dependent_locality"),
    shippingLocality: text("shipping_locality"),
    shippingAdminArea: text("shipping_admin_area"),
    shippingPostalCode: text("shipping_postal_code"),
    shippingCompany: text("shipping_company"),
    /** The recipient when it is not the order contact; null means `customerName`. */
    shippingName: text("shipping_name"),
    /** The recipient's phone (E.164) when it is not the order contact's; null means `customerPhone`. */
    shippingPhone: text("shipping_phone"),
    shippingValidationSkipped: integer("shipping_validation_skipped", { mode: "boolean" }).notNull().default(false),
    /** Bangladesh adapter: delivery location ids couriers book with, and their names. */
    city: text("city"),
    zone: text("zone"),
    area: text("area"),
    cityName: text("city_name"),
    zoneName: text("zone_name"),
    areaName: text("area_name"),
    /**
     * The billing address (MARKETS-DESIGN D7, migration 0119). True: the
     * shipping address is the billing address (Shopify's default for an
     * order that ships) and the billing columns stay null. False with a
     * billing country: the separate billing address below. False without
     * one: no billing address (every order placed before 0119).
     */
    billingSameAsShipping: integer("billing_same_as_shipping", { mode: "boolean" }).notNull().default(false),
    /** The billing name when it is not the order contact; null means `customerName`. */
    billingName: text("billing_name"),
    billingCompany: text("billing_company"),
    /** The first street line (null for a minimal billing address: country, region and postal code only). */
    billingAddress: text("billing_address"),
    billingAddressLine2: text("billing_address_line2"),
    /** ISO 3166-1 alpha-2. An order that ships nothing is taxed and placed in this country. */
    billingCountryCode: text("billing_country_code"),
    billingDependentLocality: text("billing_dependent_locality"),
    billingLocality: text("billing_locality"),
    billingAdminArea: text("billing_admin_area"),
    billingPostalCode: text("billing_postal_code"),
    /** E.164 when given and not the contact's. */
    billingPhone: text("billing_phone"),
    billingValidationSkipped: integer("billing_validation_skipped", { mode: "boolean" }).notNull().default(false),
    /**
     * Every amount is an integer in minor units of the order's own currency
     * (paisa for BDT); `currencyDecimalPlaces` converts it at the HTTP edge.
     */
    currencyCode: text("currency_code").notNull().default("BDT"),
    currencyDecimalPlaces: integer("currency_decimal_places").notNull().default(2),
    subtotalAmountMinor: integer("subtotal_amount_minor").notNull().default(0),
    shippingAmountMinor: integer("shipping_amount_minor").notNull().default(0),
    /** Immutable storefront delivery-method snapshot. Null means historical/manual method unknown. */
    shippingMethodId: text("shipping_method_id"),
    shippingMethodName: text("shipping_method_name"),
    shippingMethodDescription: text("shipping_method_description"),
    shippingMethodBaseAmountMinor: integer("shipping_method_base_amount_minor"),
    shippingFeeWaived: integer("shipping_fee_waived", { mode: "boolean" }),
    /** Snapshot of `shipping_methods.kind`; null for historical orders and orders with nothing physical. */
    shippingMethodKind: text("shipping_method_kind", { enum: ["delivery", "pickup"] }),
    /** Pickup location and hours shown to the buyer, frozen at checkout. */
    pickupAddress: text("pickup_address"),
    pickupHours: text("pickup_hours"),
    /** Staff marked a pickup order ready; a notification-only fact. */
    pickupReadyAt: integer("pickup_ready_at", { mode: "timestamp" }),
    /** Some line has fulfilment type `ship`, so the order needs an address. */
    requiresShipping: integer("requires_shipping", { mode: "boolean" }).notNull().default(true),
    discountAmountMinor: integer("discount_amount_minor").notNull().default(0),
    taxAmountMinor: integer("tax_amount_minor").notNull().default(0),
    totalAmountMinor: integer("total_amount_minor").notNull().default(0),
    /**
     * The order money chain (MARKETS-DESIGN D3, migration 0111): `currencyCode`
     * is the presentment currency (what the buyer sees and pays); the shop
     * currency is the store's reporting currency when the order was placed,
     * and `fxRate` (a decimal string: shop units per presentment unit) is the
     * rate locked when checkout priced the cart. A same-currency order has
     * rate "1", source `same_currency`, no quote times, and shop amounts equal
     * to its presentment amounts. Every writer of the presentment totals
     * writes these in the same statement (`orderMoneyChainColumns`);
     * analytics sum the shop amounts, never mixed currencies.
     */
    shopCurrency: text("shop_currency").notNull().default("BDT"),
    fxRate: text("fx_rate").notNull().default("1"),
    fxSource: text("fx_source").notNull().default("same_currency"),
    fxAsOf: integer("fx_as_of", { mode: "timestamp" }),
    fxLockedUntil: integer("fx_locked_until", { mode: "timestamp" }),
    subtotalShopMinor: integer("subtotal_shop_minor").notNull().default(0),
    shippingShopMinor: integer("shipping_shop_minor").notNull().default(0),
    discountShopMinor: integer("discount_shop_minor").notNull().default(0),
    taxShopMinor: integer("tax_shop_minor").notNull().default(0),
    totalShopMinor: integer("total_shop_minor").notNull().default(0),
    taxLabel: text("tax_label"),
    pricesIncludeTax: integer("prices_include_tax", { mode: "boolean" }).notNull().default(false),
    /** Valid: pending | processing | confirmed | shipped | delivered | completed | cancelled | refunded | returned | incomplete (see OrderStatus enum) */
    status: text("status").notNull().default(OrderStatus.PENDING),
    notes: text("notes"),
    /** Validated app checkout attributes; private, never part of events. */
    attributes: text("attributes").notNull().default("{}"),
    paymentMethod: text("payment_method").notNull().default(PaymentMethod.COD),
    /** Valid: unpaid | partial | paid | partially_refunded | refunded | failed (see PaymentStatus enum) */
    paymentStatus: text("payment_status").notNull().default(PaymentStatus.UNPAID),
    paymentIntentId: text("payment_intent_id"),
    paidAmountMinor: integer("paid_amount_minor").notNull().default(0),
    balanceDueMinor: integer("balance_due_minor").notNull().default(0),
    /** Valid: pending | partial | complete (see FulfillmentStatus enum) */
    fulfillmentStatus: text("fulfillment_status").notNull().default(FulfillmentStatus.PENDING),
    /** Valid: regular | preorder | backorder (see InventoryPool enum) */
    inventoryPool: text("inventory_pool").notNull().default(InventoryPool.REGULAR),
    inventoryAction: text("inventory_action").notNull().default("none"),
    /**
     * Where this order's physical stock is deducted from (and, absent a deduct
     * movement, restored to). Null means the store's default location. It can
     * change only before anything has left: no stock deducted and no active
     * ship/pickup fulfilment.
     */
    fulfillmentLocationId: text("fulfillment_location_id")
        .references(() => inventoryLocations.id, { onDelete: "restrict" }),
    shipmentClaimId: text("shipment_claim_id"),
    shipmentClaimExpiresAt: integer("shipment_claim_expires_at", { mode: "timestamp" }),
    expectedDelivery: text("expected_delivery"),
    version: integer("version").notNull().default(1),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    /** Verified storefront account ownership. Guest orders deliberately keep this null. */
    accountOwnerCustomerId: text("account_owner_customer_id").references(() => customers.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    /** Merchant workspace visibility only; never changes buyer, payment, inventory, or reporting truth. */
    archivedAt: integer("archived_at", { mode: "timestamp" }),
    /** Legacy lifecycle cleanup marker used by abandoned/incomplete-order cleanup. */
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
    invoiceNumber: integer("invoice_number"),
    /**
     * Where the order came from (COMMERCE-HOOKS H2), set once by the creating
     * path: `online_store` (storefront checkout), `admin` (dashboard), `agent`
     * (a buyer agent's checkout), later `pos` and `app`. It never changes
     * after insert (trigger `orders_channel_immutable`).
     */
    channel: text("channel", { enum: ORDER_CHANNEL_VALUES }).notNull().default("online_store"),
    /** Merchant label within the channel (`facebook`, `walk_in`, a plugin id): a lowercase slug of at most 64. */
    channelSource: text("channel_source"),
    /**
     * The market the order was placed in (MARKETS-DESIGN D4, migration 0112):
     * the market of the shipping country, else the backup market. Every
     * order writer sets it in the insert (null only on a row written by raw
     * SQL, which counts as the backup market). A market with orders cannot be
     * deleted.
     */
    marketId: text("market_id").references(() => markets.id, { onDelete: "restrict" }),
    /**
     * The sales channel the order sold from (MARKETS-DESIGN D6, migration
     * 0122): the storefront checkout sells the online store's catalogue, a
     * buyer agent the agents channel's, staff the channel they pick (the
     * online store by default). Beside the attribution `channel`. A row
     * inserted without one (raw SQL) is the online store's, and it never
     * changes (`orders_sales_channel_immutable`). Triggers keep it a known
     * channel and keep a channel with orders from being deleted (an FK added
     * by ALTER TABLE could not carry the default).
     */
    salesChannelId: text("sales_channel_id").notNull().default("sc_online_store"),
}, (table) => [
    check("orders_requires_shipping_check", sql`${table.requiresShipping} IN (0, 1)`),
    check(
        "orders_shipping_method_kind_check",
        sql`${table.shippingMethodKind} IS NULL OR ${table.shippingMethodKind} IN ('delivery', 'pickup')`,
    ),
    // Column checks added by 0103 (ALTER TABLE ADD ... CHECK), not a rebuild.
    check("orders_channel_check", sql`${table.channel} IN ('online_store', 'admin', 'pos', 'agent', 'app')`),
    check(
        "orders_channel_source_shape",
        sql`${table.channelSource} IS NULL OR (length(${table.channelSource}) BETWEEN 1 AND 64 AND ${table.channelSource} = lower(trim(${table.channelSource})))`,
    ),
    // Column checks added by 0113 (ALTER TABLE ADD ... CHECK).
    check(
        "orders_shipping_country_shape",
        sql`${table.shippingCountryCode} IS NULL OR (length(${table.shippingCountryCode}) = 2 AND ${table.shippingCountryCode} NOT GLOB '*[^A-Z]*')`,
    ),
    check("orders_shipping_validation_skipped_flag", sql`${table.shippingValidationSkipped} IN (0, 1)`),
    // Column checks added by 0119 (ALTER TABLE ADD ... CHECK).
    check("orders_billing_same_as_shipping_flag", sql`${table.billingSameAsShipping} IN (0, 1)`),
    check(
        "orders_billing_country_shape",
        sql`${table.billingCountryCode} IS NULL OR (length(${table.billingCountryCode}) = 2 AND ${table.billingCountryCode} NOT GLOB '*[^A-Z]*')`,
    ),
    check("orders_billing_validation_skipped_flag", sql`${table.billingValidationSkipped} IN (0, 1)`),
    // Triggers orders_shipping_address_required_{insert,update} require a
    // shipped order's address per country (0113).
    uniqueIndex("orders_order_number_unique").on(table.orderNumber),
    index("orders_status_idx").on(table.status),
    index("orders_payment_status_idx").on(table.paymentStatus),
    index("orders_customer_activity_idx").on(
        table.customerId,
        table.deletedAt,
        table.createdAt,
    ).where(sql`${table.customerId} IS NOT NULL`),
    index("orders_account_owner_customer_id_idx")
        .on(table.accountOwnerCustomerId)
        .where(sql`${table.accountOwnerCustomerId} IS NOT NULL`),
    index("orders_created_at_idx").on(table.createdAt),
    // The dashboard list (orders/admin/list.ts): every sort and filter it
    // offers walks one of these in order, ending with the keyset tiebreaker
    // `id`, inside the live (`deleted_at`) and archive (`archived_at`) state.
    index("orders_list_updated_idx").on(table.deletedAt, table.archivedAt, table.updatedAt, table.id),
    index("orders_list_created_idx").on(table.deletedAt, table.archivedAt, table.createdAt, table.id),
    index("orders_list_total_idx").on(table.deletedAt, table.archivedAt, table.totalAmountMinor, table.id),
    index("orders_list_customer_name_idx").on(table.deletedAt, table.archivedAt, table.customerName, table.id),
    index("orders_list_status_idx").on(table.deletedAt, table.archivedAt, table.status, table.createdAt, table.id),
    index("orders_list_payment_status_idx").on(
        table.deletedAt,
        table.archivedAt,
        table.paymentStatus,
        table.createdAt,
        table.id,
    ),
    index("orders_list_payment_method_idx").on(
        table.deletedAt,
        table.archivedAt,
        table.paymentMethod,
        table.createdAt,
        table.id,
    ),
    index("orders_list_fulfillment_idx").on(
        table.deletedAt,
        table.archivedAt,
        table.fulfillmentStatus,
        table.createdAt,
        table.id,
    ),
    // Archived orders only, newest first: the Archived view.
    index("orders_list_archived_idx")
        .on(table.deletedAt, table.createdAt, table.id)
        .where(sql`${table.archivedAt} IS NOT NULL`),
    // Pickup orders only: the Ready for pickup tab and the pickup filter.
    index("orders_list_pickup_idx")
        .on(table.deletedAt, table.archivedAt, table.createdAt, table.id)
        .where(sql`${table.shippingMethodKind} = 'pickup'`),
    index("orders_list_updated_at_idx").on(table.deletedAt, table.updatedAt),
    index("orders_payment_queue_idx").on(
        table.deletedAt,
        table.paymentMethod,
        table.paymentStatus,
        table.updatedAt,
    ),
    index("orders_fulfillment_queue_idx").on(
        table.deletedAt,
        table.fulfillmentStatus,
        table.paymentStatus,
        table.updatedAt,
    ),
    // Home and activity sum a period from the index alone (migration 0128).
    index("orders_sales_rollup_idx").on(table.deletedAt, table.createdAt, table.status, table.totalShopMinor, table.shopCurrency),
    // Proven-contact sign-in must seek the latest live order without planner statistics.
    index("orders_customer_phone_lookup_idx").on(table.customerPhone, table.deletedAt, table.createdAt, table.id),
    index("orders_customer_email_lookup_idx").on(sql`lower(trim(${table.customerEmail}))`, table.deletedAt, table.createdAt, table.id),
    index("orders_shipment_claim_idx")
        .on(table.shipmentClaimId, table.shipmentClaimExpiresAt)
        .where(sql`${table.shipmentClaimId} IS NOT NULL`),
    index("orders_fulfillment_location_idx")
        .on(table.fulfillmentLocationId, table.inventoryAction)
        .where(sql`${table.fulfillmentLocationId} IS NOT NULL`),
    index("orders_list_channel_idx").on(table.deletedAt, table.archivedAt, table.channel, table.createdAt, table.id),
    // Orders of channels other than the online store (an app channel's
    // delete guard; small: most orders are the online store's).
    index("orders_sales_channel_idx")
        .on(table.salesChannelId)
        .where(sql`${table.salesChannelId} <> 'sc_online_store'`),
    index("orders_market_idx").on(table.marketId, table.createdAt),
]);

export const checkoutAttempts = sqliteTable("checkout_attempts", {
    id: text("id").primaryKey(),
    requestKey: text("request_key").notNull(),
    requestHash: text("request_hash").notNull(),
    checkoutToken: text("checkout_token").notNull(),
    orderId: text("order_id").notNull(),
    status: text("status").notNull().default("processing"),
    paymentMethod: text("payment_method"),
    totalAmountMinor: integer("total_amount_minor"),
    responsePayload: text("response_payload"),
    attempts: integer("attempts").notNull().default(0),
    claimId: text("claim_id"),
    claimExpiresAt: integer("claim_expires_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("checkout_attempts_request_key_unique").on(table.requestKey),
    uniqueIndex("checkout_attempts_checkout_token_unique").on(table.checkoutToken),
    index("checkout_attempts_order_id_idx").on(table.orderId),
    index("checkout_attempts_status_claim_idx").on(table.status, table.claimExpiresAt),
]);

/**
 * Durable idempotency authority for manual admin order creation.
 *
 * Request keys are hashed before persistence. A committed row and its response
 * are written in the same D1 batch as the order/customer/item facts, so a lost
 * HTTP response can replay the original order without reserving or deducting
 * stock again.
 */
export const adminOrderCreateAttempts = sqliteTable("admin_order_create_attempts", {
    id: text("id").primaryKey(),
    actorId: text("actor_id"),
    requestKeyHash: text("request_key_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    orderId: text("order_id").notNull(),
    status: text("status", { enum: ["processing", "committed", "failed"] })
        .notNull()
        .default("processing"),
    responsePayload: text("response_payload"),
    attempts: integer("attempts").notNull().default(0),
    claimId: text("claim_id"),
    claimExpiresAt: integer("claim_expires_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("admin_order_create_attempts_key_unique").on(table.requestKeyHash),
    uniqueIndex("admin_order_create_attempts_order_unique").on(table.orderId),
    index("admin_order_create_attempts_status_claim_idx").on(table.status, table.claimExpiresAt),
    index("admin_order_create_attempts_actor_created_idx").on(table.actorId, table.createdAt),
]);

/** Immutable evidence and replay authority for a confirmed manual-order amendment. */
export const orderAmendments = sqliteTable("order_amendments", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
    actorId: text("actor_id"),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    expectedVersion: integer("expected_version").notNull(),
    resultingVersion: integer("resulting_version").notNull(),
    beforeSnapshot: text("before_snapshot").notNull(),
    afterSnapshot: text("after_snapshot").notNull(),
    responsePayload: text("response_payload").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("order_amendments_idempotency_key_unique").on(table.idempotencyKeyHash),
    uniqueIndex("order_amendments_order_version_unique").on(table.orderId, table.resultingVersion),
    index("order_amendments_order_created_idx").on(table.orderId, table.createdAt),
    check("order_amendments_version_sequence", sql`${table.expectedVersion} >= 1 AND ${table.resultingVersion} = ${table.expectedVersion} + 1`),
    check("order_amendments_snapshot_bounds", sql`length(${table.beforeSnapshot}) BETWEEN 2 AND 200000 AND length(${table.afterSnapshot}) BETWEEN 2 AND 200000`),
]);

export const orderReceipts = sqliteTable("order_receipts", {
    tokenHash: text("token_hash").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("checkout"),
    status: text("status").notNull().default("active"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("order_receipts_order_id_idx").on(table.orderId),
    index("order_receipts_status_expires_idx").on(table.status, table.expiresAt),
]);

export const orderPaymentRecoveryChallenges = sqliteTable("order_payment_recovery_challenges", {
    challengeKey: text("challenge_key").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    deliveryKey: text("delivery_key").notNull(),
    method: text("method", { enum: ["email", "phone"] }).notNull(),
    channel: text("channel", { enum: ["email", "sms", "whatsapp"] }).notNull(),
    identifierHash: text("identifier_hash").notNull(),
    identifierMasked: text("identifier_masked").notNull(),
    deliveryTargetEncrypted: text("delivery_target_encrypted"),
    deliveryNameEncrypted: text("delivery_name_encrypted"),
    codeHash: text("code_hash").notNull(),
    status: text("status", { enum: ["pending", "consumed", "locked"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    resendAvailableAt: integer("resend_available_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("order_payment_recovery_delivery_key_unique").on(table.deliveryKey),
    index("order_payment_recovery_order_status_expires_idx").on(table.orderId, table.status, table.expiresAt),
    index("order_payment_recovery_identifier_created_idx").on(table.identifierHash, table.createdAt),
]);

export const orderItems = sqliteTable("order_items", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "set null" }),
    variantId: text("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    /** Historical image/poster asset resolved at order commit; never a video asset. */
    productImageMediaId: text("product_image_media_id")
        .references(() => media.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    productName: text("product_name"),
    variantLabel: text("variant_label"),
    inventoryTracked: integer("inventory_tracked", { mode: "boolean" }).notNull().default(true),
    /** Integer minor units of the order currency. */
    unitPriceMinor: integer("unit_price_minor").notNull().default(0),
    /**
     * The SKU's `cost_minor` when this line was created (migration 0109), so
     * a later cost change never rewrites past margins. Written by the
     * `order_items_unit_cost_snapshot` trigger on every insert path (checkout,
     * staff orders, amendments); NULL when the SKU had no cost. Immutable once
     * set. Staff and analytics only: never in a buyer-facing projection.
     */
    unitCostMinor: integer("unit_cost_minor"),
    lineSubtotalMinor: integer("line_subtotal_minor").notNull().default(0),
    discountAmountMinor: integer("discount_amount_minor").notNull().default(0),
    taxableAmountMinor: integer("taxable_amount_minor").notNull().default(0),
    taxAmountMinor: integer("tax_amount_minor").notNull().default(0),
    /** How this line reaches the buyer; frozen at commit (trigger-enforced). */
    fulfillmentType: text("fulfillment_type", { enum: ["ship", "pickup", "digital", "gift_card", "service"] })
        .notNull()
        .default("ship"),
    /**
     * Units handed over: a trigger projection of active `order_fulfillment_lines`.
     * Only the ledger moves it; never write it directly.
     */
    fulfilledQuantity: integer("fulfilled_quantity").notNull().default(0),
    /** Frozen buyer inputs `[{key,type,label,value,displayValue,priceMinor}]` (JSON); immutable. */
    properties: text("properties"),
    /** Sum of the property surcharges in `unitPriceMinor`; immutable. */
    propertiesPriceMinor: integer("properties_price_minor").notNull().default(0),
    /** Unit price before surcharges (the product/variant sale applies to it only). */
    baseUnitPriceMinor: integer("base_unit_price_minor"),
    /** The warranty revision frozen at commit (Wave B); NULL = no warranty. Immutable (trigger). */
    warrantyRevisionId: text("warranty_revision_id")
        .references(() => warrantyPolicyRevisions.id, { onDelete: "restrict" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    check(
        "order_items_fulfillment_type_check",
        sql`${table.fulfillmentType} IN ('ship', 'pickup', 'digital', 'gift_card', 'service')`,
    ),
    check(
        "order_items_fulfilled_quantity_bounds",
        sql`${table.fulfilledQuantity} >= 0 AND ${table.fulfilledQuantity} <= ${table.quantity}`,
    ),
    check(
        "order_items_properties_check",
        sql`${table.properties} IS NULL OR (json_valid(${table.properties}) AND length(${table.properties}) <= 65536)`,
    ),
    check("order_items_properties_price_nonnegative", sql`${table.propertiesPriceMinor} >= 0`),
    // Live recommendations read a co-buy order's products from this covering index.
    index("order_items_order_product_idx").on(table.orderId, table.productId),
    // Also the order's lines lookup (order_id leads).
    index("order_items_sales_idx").on(table.orderId, table.id, table.quantity,
      table.lineSubtotalMinor, table.discountAmountMinor, table.taxAmountMinor, table.fulfillmentType),
    // A product's lines, newest first: "also bought" reads only the latest (0128).
    index("order_items_product_recent_idx").on(table.productId, table.createdAt, table.orderId),
    index("order_items_variant_id_idx").on(table.variantId),
    index("order_items_product_image_media_id_idx").on(table.productImageMediaId),
    // Drives the auto-fulfil sweep: only lines an automatic fulfiller still owes.
    index("order_items_auto_pending_idx")
        .on(table.orderId)
        .where(sql`${table.fulfillmentType} IN ('digital', 'gift_card') AND ${table.fulfilledQuantity} < ${table.quantity}`),
    // Trigger: order_items_warranty_immutable.
]);

/** One live real-order/product pair, independent of duplicate order lines. */
export const recommendationOrderProducts = sqliteTable("recommendation_order_products", {
    orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    productId: text("product_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    buyer: text("buyer"),
}, (table) => [
    primaryKey({ columns: [table.orderId, table.productId] }),
    index("recommendation_order_products_created_idx").on(table.createdAt, table.productId, table.buyer),
    index("recommendation_order_products_product_idx").on(table.productId, table.createdAt, table.buyer),
]);

/** Monotonic authority for invoice numbering. Updated only with invoice issuance. */
export const invoiceSequences = sqliteTable("invoice_sequences", {
    key: text("key").primaryKey(),
    currentValue: integer("current_value").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    check("invoice_sequences_value_nonnegative", sql`${table.currentValue} >= 0`),
]);

/** Immutable issued invoice identity and complete render snapshot. */
export const orderInvoices = sqliteTable("order_invoices", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
    invoiceNumber: integer("invoice_number").notNull(),
    prefix: text("prefix").notNull(),
    formattedNumber: text("formatted_number").notNull(),
    orderVersion: integer("order_version").notNull(),
    snapshot: text("snapshot").notNull(),
    contentHash: text("content_hash").notNull(),
    renderVersion: text("render_version").notNull(),
    issuedBy: text("issued_by"),
    issuedAt: integer("issued_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("order_invoices_order_unique").on(table.orderId),
    uniqueIndex("order_invoices_number_unique").on(table.invoiceNumber),
    uniqueIndex("order_invoices_formatted_unique").on(table.formattedNumber),
    index("order_invoices_issued_at_idx").on(table.issuedAt),
    check("order_invoices_number_positive", sql`${table.invoiceNumber} > 0`),
    check("order_invoices_order_version_positive", sql`${table.orderVersion} >= 1`),
    check("order_invoices_prefix_length", sql`length(trim(${table.prefix})) BETWEEN 1 AND 40`),
    check("order_invoices_snapshot_bounded", sql`length(${table.snapshot}) BETWEEN 2 AND 200000`),
    check("order_invoices_content_hash_shape", sql`length(${table.contentHash}) = 64`),
]);

/** Idempotency evidence for explicit invoice issuance commands. */
export const invoiceIssueCommands = sqliteTable("invoice_issue_commands", {
    id: text("id").primaryKey(),
    operationKey: text("operation_key").notNull(),
    requestHash: text("request_hash").notNull(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
    invoiceId: text("invoice_id")
        .notNull()
        .references(() => orderInvoices.id, { onDelete: "restrict" }),
    actorId: text("actor_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("invoice_issue_commands_operation_key_unique").on(table.operationKey),
    index("invoice_issue_commands_order_created_idx").on(table.orderId, table.createdAt),
    check("invoice_issue_commands_key_length", sql`length(trim(${table.operationKey})) BETWEEN 8 AND 200`),
    check("invoice_issue_commands_request_hash_shape", sql`length(${table.requestHash}) = 64`),
]);

export const orderReturns = sqliteTable("order_returns", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
    status: text("status", {
        enum: ["requested", "approved", "receiving", "completed", "rejected", "cancelled"],
    }).notNull().default("requested"),
    reason: text("reason").notNull(),
    notes: text("notes"),
    actorType: text("actor_type", { enum: ["admin", "customer", "guest_receipt", "system"] }).notNull(),
    actorId: text("actor_id"),
    source: text("source", { enum: ["admin", "support_request", "cod_return_to_sender"] }).notNull().default("admin"),
    sourceReferenceId: text("source_reference_id"),
    version: integer("version").notNull().default(1),
    activeOrderKey: text("active_order_key"),
    activeCommandKey: text("active_command_key"),
    activeCommandHash: text("active_command_hash"),
    activeCommandType: text("active_command_type"),
    activeCommandStartedAt: integer("active_command_started_at"),
    requestedAt: integer("requested_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    receivingStartedAt: integer("receiving_started_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    rejectedAt: integer("rejected_at", { mode: "timestamp" }),
    cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    index("order_returns_order_created_idx").on(table.orderId, table.createdAt),
    index("order_returns_order_status_idx").on(table.orderId, table.status),
    uniqueIndex("order_returns_source_reference_unique").on(table.source, table.sourceReferenceId),
    uniqueIndex("order_returns_active_order_key_unique").on(table.activeOrderKey),
    check("order_returns_version_positive", sql`${table.version} >= 1`),
    check("order_returns_reason_length", sql`length(trim(${table.reason})) BETWEEN 1 AND 500`),
    check("order_returns_active_claim_shape", sql`(
        (${table.activeOrderKey} IS NULL
            AND ${table.activeCommandKey} IS NULL
            AND ${table.activeCommandHash} IS NULL
            AND ${table.activeCommandType} IS NULL
            AND ${table.activeCommandStartedAt} IS NULL)
        OR
        (${table.activeOrderKey} = ${table.orderId}
            AND ${table.activeCommandKey} IS NOT NULL
            AND ${table.activeCommandHash} IS NOT NULL
            AND ${table.activeCommandType} = 'receive'
            AND ${table.activeCommandStartedAt} IS NOT NULL)
    )`),
]);

export const orderReturnLines = sqliteTable("order_return_lines", {
    id: text("id").primaryKey(),
    returnId: text("return_id")
        .notNull()
        .references(() => orderReturns.id, { onDelete: "restrict" }),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
    orderItemId: text("order_item_id")
        .notNull()
        .references(() => orderItems.id, { onDelete: "restrict" }),
    variantId: text("variant_id")
        .references(() => productVariants.id, { onDelete: "restrict" }),
    inventoryTracked: integer("inventory_tracked", { mode: "boolean" }).notNull().default(true),
    requestedQuantity: integer("requested_quantity").notNull(),
    approvedQuantity: integer("approved_quantity").notNull().default(0),
    receivedQuantity: integer("received_quantity").notNull().default(0),
    restockQuantity: integer("restock_quantity").notNull().default(0),
    damagedQuantity: integer("damaged_quantity").notNull().default(0),
    rejectedQuantity: integer("rejected_quantity").notNull().default(0),
    reason: text("reason"),
    notes: text("notes"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("order_return_lines_return_item_unique").on(table.returnId, table.orderItemId),
    index("order_return_lines_order_item_idx").on(table.orderId, table.orderItemId),
    index("order_return_lines_sales_idx").on(table.orderId, table.orderItemId, table.returnId, table.approvedQuantity),
    index("order_return_lines_variant_idx").on(table.variantId),
    check("order_return_lines_requested_positive", sql`${table.requestedQuantity} > 0`),
    check("order_return_lines_quantities_nonnegative", sql`(
        ${table.approvedQuantity} >= 0
        AND ${table.receivedQuantity} >= 0
        AND ${table.restockQuantity} >= 0
        AND ${table.damagedQuantity} >= 0
        AND ${table.rejectedQuantity} >= 0
    )`),
    check("order_return_lines_approval_bounded", sql`(
        ${table.approvedQuantity} + ${table.rejectedQuantity} <= ${table.requestedQuantity}
    )`),
    check("order_return_lines_receipt_bounded", sql`(
        ${table.receivedQuantity} <= ${table.approvedQuantity}
        AND ${table.restockQuantity} + ${table.damagedQuantity} = ${table.receivedQuantity}
    )`),
]);

export const orderReturnCommands = sqliteTable("order_return_commands", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
    returnId: text("return_id")
        .notNull()
        .references(() => orderReturns.id, { onDelete: "restrict" }),
    commandKey: text("command_key").notNull(),
    commandType: text("command_type", { enum: ["create", "approve", "receive", "cancel"] }).notNull(),
    requestHash: text("request_hash").notNull(),
    /** Canonical bounded input for server-owned recovery of multi-batch inventory receipts. */
    requestPayload: text("request_payload"),
    status: text("status", { enum: ["processing", "committed"] }).notNull().default("processing"),
    responsePayload: text("response_payload"),
    actorType: text("actor_type", { enum: ["admin", "customer", "guest_receipt", "system"] }).notNull(),
    actorId: text("actor_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("order_return_commands_order_key_unique").on(table.orderId, table.commandKey),
    index("order_return_commands_return_created_idx").on(table.returnId, table.createdAt),
    index("order_return_commands_status_created_idx").on(table.status, table.createdAt),
    check("order_return_commands_key_length", sql`length(trim(${table.commandKey})) BETWEEN 8 AND 200`),
    check("order_return_commands_request_payload_bounded", sql`${table.requestPayload} IS NULL OR length(${table.requestPayload}) <= 200000`),
    check("order_return_commands_processing_recovery_payload", sql`${table.status} <> 'processing' OR (${table.commandType} = 'receive' AND ${table.requestPayload} IS NOT NULL)`),
]);

/**
 * Immutable warehouse evidence for each received/dispositioned return line.
 * The counters on order_return_lines are projections of these command rows.
 */
export const orderReturnReceiptLines = sqliteTable("order_return_receipt_lines", {
    id: text("id").primaryKey(),
    commandId: text("command_id")
        .notNull()
        .references(() => orderReturnCommands.id, { onDelete: "restrict" }),
    returnId: text("return_id")
        .notNull()
        .references(() => orderReturns.id, { onDelete: "restrict" }),
    returnLineId: text("return_line_id")
        .notNull()
        .references(() => orderReturnLines.id, { onDelete: "restrict" }),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
    variantId: text("variant_id")
        .references(() => productVariants.id, { onDelete: "restrict" }),
    receivedQuantity: integer("received_quantity").notNull(),
    restockQuantity: integer("restock_quantity").notNull(),
    damagedQuantity: integer("damaged_quantity").notNull(),
    actorType: text("actor_type", { enum: ["admin", "customer", "guest_receipt", "system"] }).notNull(),
    actorId: text("actor_id"),
    inventoryMovementId: text("inventory_movement_id")
        .references(() => inventoryMovements.id, { onDelete: "restrict" }),
    notes: text("notes"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    /**
     * Where restocked units went (set exactly when `restock_quantity` > 0).
     * Keep it the last column: receipt lines are inserted by position.
     */
    restockLocationId: text("restock_location_id")
        .references(() => inventoryLocations.id, { onDelete: "restrict" }),
}, (table) => [
    uniqueIndex("order_return_receipt_lines_command_line_unique").on(table.commandId, table.returnLineId),
    index("order_return_receipt_lines_return_created_idx").on(table.returnId, table.createdAt),
    index("order_return_receipt_lines_order_created_idx").on(table.orderId, table.createdAt),
    index("order_return_receipt_lines_movement_idx").on(table.inventoryMovementId),
    check("order_return_receipt_lines_received_positive", sql`${table.receivedQuantity} > 0`),
    check("order_return_receipt_lines_disposition_exact", sql`(
        ${table.restockQuantity} >= 0
        AND ${table.damagedQuantity} >= 0
        AND ${table.restockQuantity} + ${table.damagedQuantity} = ${table.receivedQuantity}
    )`),
    check("order_return_receipt_lines_movement_shape", sql`(
        (${table.restockQuantity} = 0 AND ${table.inventoryMovementId} IS NULL)
        OR (${table.restockQuantity} > 0 AND ${table.inventoryMovementId} IS NOT NULL)
    )`),
]);

/**
 * Tax calculation context captured when an order is committed or amended.
 * Amounts live only on `orders` / `order_items`; this keeps the rules used.
 */
export const orderTaxSnapshots = sqliteTable("order_tax_snapshots", {
    orderId: text("order_id")
        .primaryKey()
        .references(() => orders.id, { onDelete: "cascade" }),
    currencyCode: text("currency_code").notNull(),
    decimalPlaces: integer("decimal_places").notNull(),
    displayLabel: text("display_label").notNull(),
    pricesIncludeTax: integer("prices_include_tax", { mode: "boolean" }).notNull(),
    shippingTaxed: integer("shipping_taxed", { mode: "boolean" }).notNull(),
    settingsVersion: integer("settings_version").notNull(),
    calculationVersion: text("calculation_version").notNull(),
    destinationSnapshot: text("destination_snapshot").notNull(),
    rateSnapshot: text("rate_snapshot").notNull(),
    /** The tax provider that calculated (`system` or an app's id), migration 0116. */
    providerId: text("provider_id").notNull().default("system"),
    /** An app provider's calculation, committed or voided with the order; null for `system`. */
    providerCalculationId: text("provider_calculation_id"),
    /**
     * The address taxed (migration 0119): `shipping` for an order that ships,
     * `billing` for one that ships nothing, `origin` where the store ships
     * from (pickup, or no address). Null on orders placed before 0119.
     */
    addressSource: text("address_source", { enum: ["shipping", "billing", "origin"] }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    index("order_tax_snapshots_created_idx").on(table.createdAt),
    check(
        "order_tax_snapshots_address_source_check",
        sql`${table.addressSource} IS NULL OR ${table.addressSource} IN ('shipping', 'billing', 'origin')`,
    ),
    check("order_tax_snapshots_decimal_places_range", sql`${table.decimalPlaces} BETWEEN 0 AND 3`),
    check("order_tax_snapshots_display_label_length", sql`length(${table.displayLabel}) BETWEEN 1 AND 80`),
    check("order_tax_snapshots_settings_version_nonnegative", sql`${table.settingsVersion} >= 0`),
]);

/** Per-line tax class and rate snapshot; the line amounts live on `order_items`. */
export const orderItemTaxSnapshots = sqliteTable("order_item_tax_snapshots", {
    orderItemId: text("order_item_id")
        .primaryKey()
        .references(() => orderItems.id, { onDelete: "cascade" }),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    taxClassId: text("tax_class_id"),
    taxClassName: text("tax_class_name"),
    /** The order's market's flag when it was placed. */
    pricesIncludeTax: integer("prices_include_tax", { mode: "boolean" }).notNull(),
    rateSnapshot: text("rate_snapshot").notNull(),
    /**
     * The jurisdiction (migration 0116): the country taxed and the region
     * whose rates applied (null: no region matched, or an app provider
     * decided). Null on lines placed before 0116.
     */
    countryCode: text("country_code"),
    taxRegionId: text("tax_region_id"),
    /** The tax provider that calculated (`system` or an app's id). */
    providerId: text("provider_id").notNull().default("system"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    index("order_item_tax_snapshots_order_idx").on(table.orderId),
]);

export const orderPayments = sqliteTable("order_payments", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    amountMinor: integer("amount_minor").notNull().default(0),
    /** The presentment currency: the order's, the one refunds are made in. */
    currency: text("currency").notNull().default("BDT"),
    /**
     * Settlement (MARKETS-DESIGN D2, migration 0111): what reaches the
     * merchant, in which currency, at which presentment → settlement rate (a
     * decimal string). A provider that reports settlement fills them;
     * every other movement records settlement = presentment at rate "1".
     * `exchangeAdjustmentMinor` (settlement currency minor units) is the gain
     * or loss against the order's locked rate when the payment settled in the
     * shop currency through a conversion, else 0.
     */
    settlementCurrency: text("settlement_currency").notNull().default("BDT"),
    settlementAmountMinor: integer("settlement_amount_minor").notNull().default(0),
    settlementRate: text("settlement_rate").notNull().default("1"),
    exchangeAdjustmentMinor: integer("exchange_adjustment_minor").notNull().default(0),
    paymentMethod: text("payment_method").notNull(),
    paymentType: text("payment_type").notNull().default("full"),
    /** Valid: pending | confirmed | failed | refunded | cancelled (see PaymentRecordStatus enum) */
    status: text("status").notNull().default(PaymentRecordStatus.PENDING),
    /** The gateway's unique payment reference (Stripe PaymentIntent, SSLCommerz val_id). Null on refund rows. */
    providerRef: text("provider_ref"),
    /** The captured-transaction reference refunds are issued against (Stripe charge, SSLCommerz bank_tran_id). */
    providerSecondaryRef: text("provider_secondary_ref"),
    codCollectedBy: text("cod_collected_by"),
    codCollectedAt: integer("cod_collected_at", { mode: "timestamp" }),
    codReceiptUrl: text("cod_receipt_url"),
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("order_payments_order_id_idx").on(table.orderId),
    index("order_payments_refund_sum_idx").on(table.orderId, table.paymentType, table.status, table.amountMinor)
      .where(sql`${table.paymentType} = 'refund' AND ${table.status} = 'refunded'`),
    // One captured payment per provider reference: a replayed webhook or a
    // webhook racing the buyer return can never credit an order twice.
    uniqueIndex("order_payments_provider_ref_unique")
        .on(table.paymentMethod, table.providerRef)
        .where(sql`${table.providerRef} IS NOT NULL`),
    index("order_payments_provider_secondary_ref_idx").on(table.paymentMethod, table.providerSecondaryRef),
]);

export const refundAttempts = sqliteTable("refund_attempts", {
    id: text("id").primaryKey(),
    attemptKey: text("attempt_key").notNull(),
    refundGroupId: text("refund_group_id").notNull(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    sourcePaymentId: text("source_payment_id")
        .notNull()
        .references(() => orderPayments.id, { onDelete: "cascade" }),
    refundPaymentId: text("refund_payment_id")
        .notNull()
        .references(() => orderPayments.id, { onDelete: "cascade" }),
    gateway: text("gateway").notNull(),
    amountMinor: integer("amount_minor").notNull().default(0),
    currency: text("currency").notNull().default("BDT"),
    reason: text("reason").notNull(),
    requestHash: text("request_hash").notNull(),
    providerIdempotencyKey: text("provider_idempotency_key").notNull(),
    refundReference: text("refund_reference").notNull(),
    allocationIndex: integer("allocation_index").notNull().default(0),
    allocationCount: integer("allocation_count").notNull().default(1),
    sourceTransactionId: text("source_transaction_id"),
    providerRefundId: text("provider_refund_id"),
    providerCorrelationId: text("provider_correlation_id"),
    providerStatus: text("provider_status"),
    requestPayload: text("request_payload"),
    responsePayload: text("response_payload"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextProbeAt: integer("next_probe_at").notNull().default(UNIX_NOW),
    claimId: text("claim_id"),
    claimExpiresAt: integer("claim_expires_at"),
    lastProbeAt: integer("last_probe_at"),
    lastError: text("last_error"),
    metadata: text("metadata"),
    refundedAt: integer("refunded_at"),
    failedAt: integer("failed_at"),
    cancelledAt: integer("cancelled_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("refund_attempts_attempt_key_unique").on(table.attemptKey),
    uniqueIndex("refund_attempts_provider_idempotency_key_unique").on(table.providerIdempotencyKey),
    uniqueIndex("refund_attempts_reference_unique").on(table.refundReference),
    uniqueIndex("refund_attempts_group_allocation_unique").on(table.refundGroupId, table.allocationIndex),
    index("refund_attempts_order_id_idx").on(table.orderId),
    index("refund_attempts_order_status_idx").on(table.orderId, table.status),
    index("refund_attempts_status_probe_idx").on(table.status, table.nextProbeAt, table.createdAt),
    index("refund_attempts_status_claim_idx").on(table.status, table.claimExpiresAt, table.createdAt),
    index("refund_attempts_source_payment_id_idx").on(table.sourcePaymentId),
    index("refund_attempts_source_payment_status_idx").on(table.sourcePaymentId, table.status),
    index("refund_attempts_refund_payment_id_idx").on(table.refundPaymentId),
    index("refund_attempts_provider_refund_idx").on(table.gateway, table.providerRefundId),
    // Manual migration also creates these partial unique indexes (not expressible in Drizzle):
    // refund_attempts_provider_refund_unique ON (gateway, provider_refund_id) WHERE provider_refund_id IS NOT NULL
    // refund_attempts_live_source_payment_singleflight ON (source_payment_id) WHERE status IN ('pending','processing','provider_unknown','reconcile_required')
]);

export const orderSupportRequests = sqliteTable("order_support_requests", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    customerId: text("customer_id")
        .references(() => customers.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    status: text("status").notNull().default("submitted"),
    reason: text("reason").notNull(),
    activeKey: text("active_key"),
    returnId: text("return_id")
        .references(() => orderReturns.id, { onDelete: "set null" }),
    /** The order thread this case lives on (always set by the service from Wave A). */
    conversationId: text("conversation_id")
        .references(() => conversations.id, { onDelete: "restrict" }),
    submittedAt: integer("submitted_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("order_support_requests_active_key_unique").on(table.activeKey),
    index("order_support_requests_order_created_idx").on(table.orderId, table.createdAt),
    index("order_support_requests_customer_created_idx").on(table.customerId, table.createdAt),
    index("order_support_requests_status_created_idx").on(table.status, table.createdAt),
    index("order_support_requests_type_status_idx").on(table.type, table.status),
    index("order_support_requests_return_id_idx").on(table.returnId),
    index("order_support_requests_conversation_idx").on(table.conversationId),
]);

/** The order timeline: staff comments and what happened to the order, newest first. */
export const orderEvents = sqliteTable("order_events", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    body: text("body"),
    /** JSON facts for the event (amounts in major units, labels are rendered by the dashboard). */
    data: text("data"),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("order_events_order_created_idx").on(table.orderId, table.createdAt),
]);

export const paymentSessionAttempts = sqliteTable("payment_session_attempts", {
    id: text("id").primaryKey(),
    attemptKey: text("attempt_key").notNull(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    gateway: text("gateway").notNull(),
    paymentType: text("payment_type").notNull(),
    amountMinor: integer("amount_minor").notNull().default(0),
    currency: text("currency").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull().default("processing"),
    providerSessionId: text("provider_session_id"),
    providerCorrelationId: text("provider_correlation_id"),
    responsePayload: text("response_payload"),
    attempts: integer("attempts").notNull().default(0),
    claimId: text("claim_id"),
    claimExpiresAt: integer("claim_expires_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("payment_session_attempts_attempt_key_unique").on(table.attemptKey),
    index("payment_session_attempts_order_id_idx").on(table.orderId),
    index("payment_session_attempts_status_claim_idx").on(table.status, table.claimExpiresAt),
    index("payment_session_attempts_provider_session_idx").on(table.gateway, table.providerSessionId),
    // Manual migration 0063 also creates this partial unique index (not expressible in Drizzle):
    // payment_session_attempts_live_order_singleflight ON (order_id, gateway, payment_type) WHERE status = 'processing'
]);

/**
 * A hold on an order's fulfilment, placed by an app's `order.risk` answer
 * (`action: "hold"`). While any hold is open, no shipment is booked and
 * the order cannot move to shipped or delivered; staff review it and release
 * the hold. One row per order and app, ever: a re-run of the same check
 * after a release adds nothing.
 */
export const orderHolds = sqliteTable("order_holds", {
    /** `ohd_` + a hash of (order, plugin): the idempotency of the app's answer. */
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    /** The app's name as the merchant saw it when the hold was placed. */
    appName: text("app_name").notNull(),
    /** The app's reasons, joined for staff (buyer-free text, at most 5 lines). */
    reason: text("reason").notNull(),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    releasedAt: integer("released_at"),
    releasedBy: text("released_by").references(() => user.id, { onDelete: "set null" }),
}, (table) => [
    index("order_holds_open_idx").on(table.orderId).where(sql`${table.releasedAt} IS NULL`),
    check("order_holds_id_shape", sql`length(${table.id}) = 36 AND substr(${table.id}, 1, 4) = 'ohd_'`),
    check("order_holds_app_name_length", sql`length(${table.appName}) BETWEEN 1 AND 80`),
    check("order_holds_reason_length", sql`length(${table.reason}) BETWEEN 1 AND 1200`),
    check("order_holds_release_pair", sql`(${table.releasedAt} IS NULL) OR (${table.releasedAt} >= ${table.createdAt})`),
]);

export const paymentPlans = sqliteTable("payment_plans", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" })
        .unique(),
    totalAmountMinor: integer("total_amount_minor").notNull().default(0),
    depositAmountMinor: integer("deposit_amount_minor").notNull().default(0),
    balanceDueMinor: integer("balance_due_minor").notNull().default(0),
    depositPaidAt: integer("deposit_paid_at", { mode: "timestamp" }),
    balancePaidAt: integer("balance_paid_at", { mode: "timestamp" }),
    balanceDueDate: text("balance_due_date"),
    /** Valid: pending | deposit_paid | completed | cancelled (see PaymentPlanStatus enum) */
    status: text("status").notNull().default(PaymentPlanStatus.PENDING),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
});

export const codTracking = sqliteTable("cod_tracking", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" })
        .unique(),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    lastAttemptAt: integer("last_attempt_at", { mode: "timestamp" }),
    /** Valid: pending | collected | failed | returned (see CodStatus enum) */
    codStatus: text("cod_status").notNull().default(CodStatus.PENDING),
    failureReason: text("failure_reason"),
    failureNote: text("failure_note"),
    collectedBy: text("collected_by"),
    collectedAmountMinor: integer("collected_amount_minor"),
    collectedAt: integer("collected_at", { mode: "timestamp" }),
    receiptUrl: text("receipt_url"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    // Cash on delivery still out: the order list's COD tabs read it first.
    index("cod_tracking_status_idx").on(table.codStatus, table.orderId),
]);

export const webhookEvents = sqliteTable("webhook_events", {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    eventType: text("event_type").notNull(),
    orderId: text("order_id"),
    status: text("status").notNull().default("processed"),
    result: text("result"),
    /** Payment events: the normalized provider event a retry applies (ids, refs and amounts; no buyer data). */
    payload: text("payload"),
    /** Payment events: attempts made, counted at claim. */
    attempts: integer("attempts").notNull().default(0),
    /** Payment events in `retrying`: when the next attempt is due (epoch seconds). */
    nextAttemptAt: integer("next_attempt_at"),
    processedAt: integer("processed_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("webhook_events_provider_idx").on(table.provider),
    index("webhook_events_order_id_idx").on(table.orderId),
    index("webhook_events_status_processed_at_idx").on(table.status, table.processedAt),
]);

export const abandonedCheckouts = sqliteTable(
    "abandoned_checkouts",
    {
        id: text("id").primaryKey(),
        checkoutId: text("checkout_id").notNull(),
        customerPhone: text("customer_phone"),
        checkoutData: text("checkout_data").notNull(),
        abandonedAt: integer("abandoned_at", { mode: "timestamp" }),
        createdAt: integer("created_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
        updatedAt: integer("updated_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
    },
    (table) => [
        unique("ab_checkout_id_unique").on(table.checkoutId),
        index("abandoned_checkouts_created_at_idx").on(table.createdAt, table.id),
        index("abandoned_checkouts_empty_candidate_idx").on(table.customerPhone, table.updatedAt, table.id),
        index("abandoned_checkouts_pending_idx").on(table.abandonedAt, table.updatedAt, table.id),
    ],
);

export type Order = InferSelectModel<typeof orders>;
export type CheckoutAttempt = InferSelectModel<typeof checkoutAttempts>;
export type AdminOrderCreateAttempt = InferSelectModel<typeof adminOrderCreateAttempts>;
export type OrderAmendment = InferSelectModel<typeof orderAmendments>;
export type OrderItem = InferSelectModel<typeof orderItems>;
export type InvoiceSequence = InferSelectModel<typeof invoiceSequences>;
export type OrderInvoice = InferSelectModel<typeof orderInvoices>;
export type InvoiceIssueCommand = InferSelectModel<typeof invoiceIssueCommands>;
export type OrderReturn = InferSelectModel<typeof orderReturns>;
export type OrderReturnLine = InferSelectModel<typeof orderReturnLines>;
export type OrderReturnCommand = InferSelectModel<typeof orderReturnCommands>;
export type OrderReturnReceiptLine = InferSelectModel<typeof orderReturnReceiptLines>;
export type OrderTaxSnapshot = InferSelectModel<typeof orderTaxSnapshots>;
export type OrderItemTaxSnapshot = InferSelectModel<typeof orderItemTaxSnapshots>;
export type OrderPayment = InferSelectModel<typeof orderPayments>;
export type RefundAttempt = InferSelectModel<typeof refundAttempts>;
export type OrderSupportRequest = InferSelectModel<typeof orderSupportRequests>;
export type OrderEvent = InferSelectModel<typeof orderEvents>;
export type PaymentSessionAttempt = InferSelectModel<typeof paymentSessionAttempts>;
export type OrderHold = InferSelectModel<typeof orderHolds>;
export type PaymentPlan = InferSelectModel<typeof paymentPlans>;
export type CodTracking = InferSelectModel<typeof codTracking>;
export type WebhookEvent = InferSelectModel<typeof webhookEvents>;
export type AbandonedCheckout = InferSelectModel<typeof abandonedCheckouts>;
