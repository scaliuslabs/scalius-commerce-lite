// src/db/schema/marketing.ts
// Marketing domain tables: Meta Conversions API logs and purchase outbox.

import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { orders } from "./orders";

export const metaConversionsLogs = sqliteTable("meta_conversions_logs", {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().unique(),
    eventName: text("event_name").notNull(),
    status: text("status", { enum: ["success", "failed"] }).notNull(),
    requestPayload: text("request_payload").notNull(),
    responsePayload: text("response_payload"),
    errorMessage: text("error_message"),
    eventTime: integer("event_time", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
});

export const metaCapiPurchaseOutbox = sqliteTable("meta_capi_purchase_outbox", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    source: text("source").notNull(),
    status: text("status", {
        enum: ["pending", "processing", "sent", "failed", "skipped"],
    }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(UNIX_NOW),
    claimId: text("claim_id"),
    claimExpiresAt: integer("claim_expires_at"),
    lastError: text("last_error"),
    sentAt: integer("sent_at"),
    skippedAt: integer("skipped_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("meta_capi_purchase_outbox_order_id_unique").on(table.orderId),
    uniqueIndex("meta_capi_purchase_outbox_event_id_unique").on(table.eventId),
    index("meta_capi_purchase_outbox_pending_idx").on(table.status, table.nextAttemptAt, table.createdAt),
    index("meta_capi_purchase_outbox_claim_idx").on(table.status, table.claimExpiresAt),
]);

export type MetaConversionsLog = InferSelectModel<typeof metaConversionsLogs>;
export type MetaCapiPurchaseOutbox = InferSelectModel<typeof metaCapiPurchaseOutbox>;
