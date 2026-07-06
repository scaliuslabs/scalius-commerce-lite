// src/db/schema/orders.ts
// Order domain tables: orders, checkoutAttempts, orderReceipts, orderItems, orderPayments, refundAttempts,
// orderSupportRequests, orderSupportRequestEvents, paymentPlans,
// codTracking, webhookEvents, orderNotificationOutbox,
// orderNotificationDeliveryReceipts, abandonedCheckouts.

import { sqliteTable, text, integer, real, unique, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { customers } from "./customers";
import { products, productVariants } from "./products";
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
    quantity: integer("quantity").notNull(),
    price: real("price").notNull(),
    productName: text("product_name"),
    variantLabel: text("variant_label"),
    inventoryTracked: integer("inventory_tracked", { mode: "boolean" }).notNull().default(true),
    fulfillmentStatus: text("fulfillment_status").notNull().default(ItemFulfillmentStatus.PENDING),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("order_items_order_id_idx").on(table.orderId),
    index("order_items_product_id_idx").on(table.productId),
    index("order_items_variant_id_idx").on(table.variantId),
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
