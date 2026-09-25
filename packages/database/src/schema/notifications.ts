// Generic notification outbox (Wave A §10). Every row is keyed by subject
// (an order, a conversation; Wave B adds gift cards and digital deliveries)
// and audience. It is written in the same batch as the fact it announces;
// queue messages carry only the outbox id, and recipients are resolved at
// send time. Replaces order_notification_outbox and its receipts, which stay
// until the Wave A contract migration.

import { sqliteTable, text, integer, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { orders } from "./orders";
import { conversations } from "./conversations";

const NOTIFICATION_SUBJECT_TYPES = ["order", "conversation", "gift_card", "digital"] as const;

export const notificationOutbox = sqliteTable("notification_outbox", {
    id: text("id").primaryKey(),
    dedupeKey: text("dedupe_key").notNull(),
    subjectType: text("subject_type", { enum: NOTIFICATION_SUBJECT_TYPES }).notNull(),
    subjectId: text("subject_id").notNull(),
    /** Equals subject_id for order subjects. */
    orderId: text("order_id")
        .references(() => orders.id, { onDelete: "cascade" }),
    /** Equals subject_id for conversation subjects. */
    conversationId: text("conversation_id")
        .references(() => conversations.id, { onDelete: "cascade" }),
    audience: text("audience", { enum: ["customer", "staff"] }).notNull(),
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
    uniqueIndex("notification_outbox_dedupe_key_unique").on(table.dedupeKey),
    index("notification_outbox_pending_idx").on(table.status, table.nextAttemptAt, table.createdAt),
    index("notification_outbox_claim_idx").on(table.status, table.claimExpiresAt),
    index("notification_outbox_queued_idx").on(table.status, table.queuedAt, table.createdAt),
    index("notification_outbox_subject_idx").on(table.subjectType, table.subjectId),
    index("notification_outbox_order_id_idx")
        .on(table.orderId)
        .where(sql`${table.orderId} IS NOT NULL`),
    index("notification_outbox_conversation_id_idx")
        .on(table.conversationId)
        .where(sql`${table.conversationId} IS NOT NULL`),
    check("notification_outbox_subject_type_check", sql`${table.subjectType} IN ('order', 'conversation', 'gift_card', 'digital')`),
    check("notification_outbox_audience_check", sql`${table.audience} IN ('customer', 'staff')`),
    check("notification_outbox_subject_shape", sql`(${table.subjectType} <> 'order' OR ${table.orderId} IS ${table.subjectId}) AND (${table.subjectType} <> 'conversation' OR ${table.conversationId} IS ${table.subjectId})`),
    check("notification_outbox_payload_json", sql`json_valid(${table.payload})`),
]);

export const notificationDeliveryReceipts = sqliteTable("notification_delivery_receipts", {
    id: text("id").primaryKey(),
    receiptKey: text("receipt_key").notNull(),
    outboxId: text("outbox_id")
        .notNull()
        .references(() => notificationOutbox.id, { onDelete: "cascade" }),
    subjectType: text("subject_type", { enum: NOTIFICATION_SUBJECT_TYPES }).notNull(),
    subjectId: text("subject_id").notNull(),
    orderId: text("order_id")
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
    uniqueIndex("notification_delivery_receipts_receipt_key_unique").on(table.receiptKey),
    index("notification_delivery_receipts_outbox_id_idx").on(table.outboxId),
    index("notification_delivery_receipts_outbox_status_idx").on(table.outboxId, table.status),
    index("notification_delivery_receipts_subject_created_idx").on(table.subjectType, table.subjectId, table.createdAt),
    index("notification_delivery_receipts_subject_channel_idx").on(
        table.subjectType,
        table.subjectId,
        table.channel,
        table.acceptedAt,
    ),
    index("notification_delivery_receipts_order_id_created_at_idx")
        .on(table.orderId, table.createdAt)
        .where(sql`${table.orderId} IS NOT NULL`),
    index("notification_delivery_receipts_pending_idx").on(table.status, table.nextAttemptAt, table.createdAt),
    index("notification_delivery_receipts_claim_idx").on(table.status, table.claimExpiresAt, table.createdAt),
    index("notification_delivery_receipts_provider_message_idx").on(table.provider, table.providerMessageId),
    index("notification_delivery_receipts_provider_status_updated_idx").on(
        table.channel,
        table.provider,
        table.status,
        table.updatedAt,
    ),
    check("notification_delivery_receipts_subject_type_check", sql`${table.subjectType} IN ('order', 'conversation', 'gift_card', 'digital')`),
    check("notification_delivery_receipts_order_shape", sql`${table.subjectType} <> 'order' OR ${table.orderId} IS ${table.subjectId}`),
]);

export type NotificationOutbox = InferSelectModel<typeof notificationOutbox>;
export type NotificationDeliveryReceipt = InferSelectModel<typeof notificationDeliveryReceipts>;
