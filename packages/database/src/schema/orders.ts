// src/db/schema/orders.ts
// Order domain tables: orders, checkoutAttempts, orderReceipts, orderItems, orderPayments, refundAttempts,
// orderSupportRequests, orderSupportRequestEvents, paymentPlans,
// codTracking, webhookEvents, orderNotificationOutbox,
// orderNotificationDeliveryReceipts, abandonedCheckouts.

import { sqliteTable, text, integer, real, unique, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { customers } from "./customers";
import { products, productVariants } from "./products";
import { media } from "./media";
import { inventoryMovements } from "./inventory";
import { UNIX_NOW } from "./shared";
import {
    OrderStatus,
    PaymentMethod,
    PaymentStatus,
    FulfillmentStatus,
    InventoryPool,
    ItemFulfillmentStatus,
    PaymentRecordStatus,
    CodStatus,
    PaymentPlanStatus,
} from "./enums";

export const orders = sqliteTable("orders", {
    id: text("id").primaryKey(),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    customerEmail: text("customer_email"),
    shippingAddress: text("shipping_address").notNull(),
    city: text("city").notNull(),
    zone: text("zone").notNull(),
    area: text("area"),
    cityName: text("city_name"),
    zoneName: text("zone_name"),
    areaName: text("area_name"),
    totalAmount: real("total_amount").notNull(),
    shippingCharge: real("shipping_charge").notNull(),
    discountAmount: real("discount_amount").default(0),
    currencyCode: text("currency_code"),
    currencyDecimalPlaces: integer("currency_decimal_places"),
    subtotalAmountMinor: integer("subtotal_amount_minor"),
    shippingAmountMinor: integer("shipping_amount_minor"),
    discountAmountMinor: integer("discount_amount_minor"),
    taxAmountMinor: integer("tax_amount_minor").notNull().default(0),
    totalAmountMinor: integer("total_amount_minor"),
    taxLabel: text("tax_label"),
    pricesIncludeTax: integer("prices_include_tax", { mode: "boolean" }).notNull().default(false),
    /** Valid: pending | processing | confirmed | shipped | delivered | completed | cancelled | refunded | returned | partially_refunded | incomplete (see OrderStatus enum) */
    status: text("status").notNull().default(OrderStatus.PENDING),
    notes: text("notes"),
    paymentMethod: text("payment_method").notNull().default(PaymentMethod.COD),
    /** Valid: unpaid | partial | paid | refunded | failed (see PaymentStatus enum) */
    paymentStatus: text("payment_status").notNull().default(PaymentStatus.UNPAID),
    paymentIntentId: text("payment_intent_id"),
    paidAmount: real("paid_amount").notNull().default(0),
    balanceDue: real("balance_due").notNull().default(0),
    /** Valid: pending | partial | complete (see FulfillmentStatus enum) */
    fulfillmentStatus: text("fulfillment_status").notNull().default(FulfillmentStatus.PENDING),
    /** Valid: regular | preorder | backorder (see InventoryPool enum) */
    inventoryPool: text("inventory_pool").notNull().default(InventoryPool.REGULAR),
    inventoryAction: text("inventory_action").notNull().default("none"),
    shipmentClaimId: text("shipment_claim_id"),
    shipmentClaimExpiresAt: integer("shipment_claim_expires_at", { mode: "timestamp" }),
    expectedDelivery: text("expected_delivery"),
    version: integer("version").notNull().default(1),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
    invoiceNumber: integer("invoice_number"),
}, (table) => [
    index("orders_status_idx").on(table.status),
    index("orders_payment_status_idx").on(table.paymentStatus),
    index("orders_customer_id_idx").on(table.customerId),
    index("orders_created_at_idx").on(table.createdAt),
    index("orders_deleted_at_idx").on(table.deletedAt),
    index("orders_list_updated_at_idx").on(table.deletedAt, table.updatedAt),
    index("orders_payment_status_list_idx").on(
        table.deletedAt,
        table.paymentStatus,
        table.updatedAt,
    ),
    index("orders_payment_method_list_idx").on(
        table.deletedAt,
        table.paymentMethod,
        table.updatedAt,
    ),
    index("orders_fulfillment_list_idx").on(
        table.deletedAt,
        table.fulfillmentStatus,
        table.updatedAt,
    ),
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
    index("orders_dashboard_agg_idx").on(table.deletedAt, table.createdAt, table.status),
    index("orders_customer_phone_idx").on(table.customerPhone),
    index("orders_shipment_claim_idx").on(table.shipmentClaimId, table.shipmentClaimExpiresAt),
]);

export const checkoutAttempts = sqliteTable("checkout_attempts", {
    id: text("id").primaryKey(),
    requestKey: text("request_key").notNull(),
    requestHash: text("request_hash").notNull(),
    checkoutToken: text("checkout_token").notNull(),
    orderId: text("order_id").notNull(),
    status: text("status").notNull().default("processing"),
    paymentMethod: text("payment_method"),
    totalAmount: real("total_amount"),
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
    price: real("price").notNull(),
    productName: text("product_name"),
    variantLabel: text("variant_label"),
    inventoryTracked: integer("inventory_tracked", { mode: "boolean" }).notNull().default(true),
    unitPriceMinor: integer("unit_price_minor"),
    lineSubtotalMinor: integer("line_subtotal_minor"),
    discountAmountMinor: integer("discount_amount_minor"),
    taxableAmountMinor: integer("taxable_amount_minor"),
    taxAmountMinor: integer("tax_amount_minor").notNull().default(0),
    fulfillmentStatus: text("fulfillment_status").notNull().default(ItemFulfillmentStatus.PENDING),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("order_items_order_id_idx").on(table.orderId),
    index("order_items_product_id_idx").on(table.productId),
    index("order_items_variant_id_idx").on(table.variantId),
    index("order_items_product_image_media_id_idx").on(table.productImageMediaId),
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

/** Immutable calculation context captured when an order is committed. */
export const orderTaxSnapshots = sqliteTable("order_tax_snapshots", {
    orderId: text("order_id")
        .primaryKey()
        .references(() => orders.id, { onDelete: "cascade" }),
    currencyCode: text("currency_code").notNull(),
    decimalPlaces: integer("decimal_places").notNull(),
    displayLabel: text("display_label").notNull(),
    pricesIncludeTax: integer("prices_include_tax", { mode: "boolean" }).notNull(),
    shippingTaxed: integer("shipping_taxed", { mode: "boolean" }).notNull(),
    subtotalMinor: integer("subtotal_minor").notNull(),
    shippingMinor: integer("shipping_minor").notNull(),
    discountMinor: integer("discount_minor").notNull(),
    taxableMinor: integer("taxable_minor").notNull(),
    taxMinor: integer("tax_minor").notNull(),
    totalMinor: integer("total_minor").notNull(),
    settingsVersion: integer("settings_version").notNull(),
    calculationVersion: text("calculation_version").notNull(),
    destinationSnapshot: text("destination_snapshot").notNull(),
    rateSnapshot: text("rate_snapshot").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    index("order_tax_snapshots_created_idx").on(table.createdAt),
    check("order_tax_snapshots_decimal_places_range", sql`${table.decimalPlaces} BETWEEN 0 AND 3`),
    check("order_tax_snapshots_display_label_length", sql`length(${table.displayLabel}) BETWEEN 1 AND 80`),
    check("order_tax_snapshots_settings_version_nonnegative", sql`${table.settingsVersion} >= 0`),
    check("order_tax_snapshots_minor_amounts_nonnegative", sql`(
        ${table.subtotalMinor} >= 0
        AND ${table.shippingMinor} >= 0
        AND ${table.discountMinor} >= 0
        AND ${table.taxableMinor} >= 0
        AND ${table.taxMinor} >= 0
        AND ${table.totalMinor} >= 0
    )`),
]);

/** Immutable per-line allocation and rate snapshot captured with the order. */
export const orderItemTaxSnapshots = sqliteTable("order_item_tax_snapshots", {
    orderItemId: text("order_item_id")
        .primaryKey()
        .references(() => orderItems.id, { onDelete: "cascade" }),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    taxClassId: text("tax_class_id"),
    taxClassName: text("tax_class_name"),
    unitPriceMinor: integer("unit_price_minor").notNull(),
    quantity: integer("quantity").notNull(),
    grossAmountMinor: integer("gross_amount_minor").notNull(),
    discountMinor: integer("discount_minor").notNull(),
    taxableAmountMinor: integer("taxable_amount_minor").notNull(),
    taxMinor: integer("tax_minor").notNull(),
    pricesIncludeTax: integer("prices_include_tax", { mode: "boolean" }).notNull(),
    rateSnapshot: text("rate_snapshot").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    index("order_item_tax_snapshots_order_idx").on(table.orderId),
    check("order_item_tax_snapshots_quantity_positive", sql`${table.quantity} > 0`),
    check("order_item_tax_snapshots_minor_amounts_nonnegative", sql`(
        ${table.unitPriceMinor} >= 0
        AND ${table.grossAmountMinor} >= 0
        AND ${table.discountMinor} >= 0
        AND ${table.taxableAmountMinor} >= 0
        AND ${table.taxMinor} >= 0
    )`),
]);

export const orderPayments = sqliteTable("order_payments", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    amount: real("amount").notNull(),
    currency: text("currency").notNull().default("BDT"),
    paymentMethod: text("payment_method").notNull(),
    paymentType: text("payment_type").notNull().default("full"),
    /** Valid: pending | confirmed | failed | refunded | cancelled (see PaymentRecordStatus enum) */
    status: text("status").notNull().default(PaymentRecordStatus.PENDING),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeChargeId: text("stripe_charge_id"),
    sslcommerzTranId: text("sslcommerz_tran_id"),
    sslcommerzValId: text("sslcommerz_val_id"),
    sslcommerzBankTranId: text("sslcommerz_bank_tran_id"),
    polarCheckoutId: text("polar_checkout_id"),
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
    index("order_payments_stripe_pi_idx").on(table.stripePaymentIntentId),
    index("order_payments_ssl_tran_idx").on(table.sslcommerzTranId),
    index("order_payments_polar_checkout_idx").on(table.polarCheckoutId),
    // Manual migrations also create these unique partial indexes (not expressible in Drizzle):
    // idx_order_payments_stripe_unique ON (order_id, stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL
    // idx_order_payments_polar_unique ON (order_id, polar_checkout_id) WHERE polar_checkout_id IS NOT NULL
    // idx_order_payments_sslcommerz_val_unique ON (order_id, sslcommerz_val_id) WHERE sslcommerz_val_id IS NOT NULL
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
    amount: real("amount").notNull(),
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
    message: text("message"),
    activeKey: text("active_key"),
    returnId: text("return_id")
        .references(() => orderReturns.id, { onDelete: "set null" }),
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
]);

export const orderSupportRequestEvents = sqliteTable("order_support_request_events", {
    id: text("id").primaryKey(),
    requestId: text("request_id")
        .notNull()
        .references(() => orderSupportRequests.id, { onDelete: "cascade" }),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    customerId: text("customer_id")
        .references(() => customers.id, { onDelete: "set null" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("order_support_request_events_request_created_idx").on(table.requestId, table.createdAt),
    index("order_support_request_events_order_created_idx").on(table.orderId, table.createdAt),
]);

export const paymentSessionAttempts = sqliteTable("payment_session_attempts", {
    id: text("id").primaryKey(),
    attemptKey: text("attempt_key").notNull(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    gateway: text("gateway").notNull(),
    paymentType: text("payment_type").notNull(),
    amount: real("amount").notNull(),
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

export const paymentPlans = sqliteTable("payment_plans", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" })
        .unique(),
    totalAmount: real("total_amount").notNull(),
    depositAmount: real("deposit_amount").notNull(),
    balanceDue: real("balance_due").notNull(),
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
    collectedBy: text("collected_by"),
    collectedAmount: real("collected_amount"),
    collectedAt: integer("collected_at", { mode: "timestamp" }),
    receiptUrl: text("receipt_url"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
});

export const webhookEvents = sqliteTable("webhook_events", {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    eventType: text("event_type").notNull(),
    orderId: text("order_id"),
    status: text("status").notNull().default("processed"),
    result: text("result"),
    processedAt: integer("processed_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("webhook_events_provider_idx").on(table.provider),
    index("webhook_events_order_id_idx").on(table.orderId),
    index("webhook_events_status_processed_at_idx").on(table.status, table.processedAt),
]);

export const orderNotificationOutbox = sqliteTable("order_notification_outbox", {
    id: text("id").primaryKey(),
    dedupeKey: text("dedupe_key").notNull(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    notificationType: text("notification_type").notNull(),
    source: text("source").notNull(),
    payload: text("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(UNIX_NOW),
    claimId: text("claim_id"),
    claimExpiresAt: integer("claim_expires_at"),
    lastError: text("last_error"),
    queuedAt: integer("queued_at"),
    sentAt: integer("sent_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("order_notification_outbox_dedupe_key_unique").on(table.dedupeKey),
    index("order_notification_outbox_pending_idx").on(table.status, table.nextAttemptAt, table.createdAt),
    index("order_notification_outbox_claim_idx").on(table.status, table.claimExpiresAt),
    index("order_notification_outbox_queued_idx").on(table.status, table.queuedAt, table.createdAt),
    index("order_notification_outbox_order_id_idx").on(table.orderId),
]);

export const orderNotificationDeliveryReceipts = sqliteTable("order_notification_delivery_receipts", {
    id: text("id").primaryKey(),
    receiptKey: text("receipt_key").notNull(),
    outboxId: text("outbox_id")
        .notNull()
        .references(() => orderNotificationOutbox.id, { onDelete: "cascade" }),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    notificationType: text("notification_type").notNull(),
    channel: text("channel").notNull(),
    provider: text("provider").notNull(),
    recipientHash: text("recipient_hash").notNull(),
    recipientMasked: text("recipient_masked"),
    status: text("status").notNull().default("pending"),
    providerMessageId: text("provider_message_id"),
    providerStatus: text("provider_status"),
    rawResponse: text("raw_response"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(UNIX_NOW),
    claimId: text("claim_id"),
    claimExpiresAt: integer("claim_expires_at"),
    lastError: text("last_error"),
    lastAttemptAt: integer("last_attempt_at"),
    acceptedAt: integer("accepted_at"),
    deliveredAt: integer("delivered_at"),
    failedAt: integer("failed_at"),
    skippedAt: integer("skipped_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("order_notification_delivery_receipts_receipt_key_unique").on(table.receiptKey),
    index("order_notification_delivery_receipts_outbox_id_idx").on(table.outboxId),
    index("order_notification_delivery_receipts_outbox_status_idx").on(table.outboxId, table.status),
    index("order_notification_delivery_receipts_order_id_created_at_idx").on(table.orderId, table.createdAt),
    index("order_notification_delivery_receipts_pending_idx").on(table.status, table.nextAttemptAt, table.createdAt),
    index("order_notification_delivery_receipts_claim_idx").on(table.status, table.claimExpiresAt, table.createdAt),
    index("order_notification_delivery_receipts_provider_message_idx").on(table.provider, table.providerMessageId),
    index("order_notification_delivery_receipts_provider_status_updated_idx").on(
        table.channel,
        table.provider,
        table.status,
        table.updatedAt,
    ),
]);

export const abandonedCheckouts = sqliteTable(
    "abandoned_checkouts",
    {
        id: text("id").primaryKey(),
        checkoutId: text("checkout_id").notNull(),
        customerPhone: text("customer_phone"),
        checkoutData: text("checkout_data").notNull(),
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
    ],
);

export type Order = InferSelectModel<typeof orders>;
export type CheckoutAttempt = InferSelectModel<typeof checkoutAttempts>;
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
export type OrderSupportRequestEvent = InferSelectModel<typeof orderSupportRequestEvents>;
export type PaymentSessionAttempt = InferSelectModel<typeof paymentSessionAttempts>;
export type PaymentPlan = InferSelectModel<typeof paymentPlans>;
export type CodTracking = InferSelectModel<typeof codTracking>;
export type WebhookEvent = InferSelectModel<typeof webhookEvents>;
export type OrderNotificationOutbox = InferSelectModel<typeof orderNotificationOutbox>;
export type OrderNotificationDeliveryReceipt = InferSelectModel<typeof orderNotificationDeliveryReceipts>;
export type AbandonedCheckout = InferSelectModel<typeof abandonedCheckouts>;
