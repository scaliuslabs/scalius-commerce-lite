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

/**
 * The match signals and consent snapshot of one storefront order, written in
 * the checkout commit batch when a server destination (Meta CAPI, GA4
 * Measurement Protocol, TikTok Events API) is enabled. It holds no PII beyond
 * what those senders need, is not an event fact, and is purged after 8 days
 * (Meta accepts `event_time` up to 7 days old).
 */
export const orderTrackingSignals = sqliteTable("order_tracking_signals", {
    orderId: text("order_id")
        .primaryKey()
        .references(() => orders.id, { onDelete: "cascade" }),
    consentAnalytics: integer("consent_analytics", { mode: "boolean" }).notNull(),
    consentMarketing: integer("consent_marketing", { mode: "boolean" }).notNull(),
    consentSaleOfData: integer("consent_sale_of_data", { mode: "boolean" }).notNull(),
    /** `banner`, `default` or `gpc`. */
    consentSource: text("consent_source").notNull(),
    fbp: text("fbp"),
    fbc: text("fbc"),
    ttp: text("ttp"),
    ttclid: text("ttclid"),
    gaClientId: text("ga_client_id"),
    gaSessionId: text("ga_session_id"),
    gclid: text("gclid"),
    clientIp: text("client_ip"),
    userAgent: text("user_agent"),
    /** The commit time: every server Purchase reports it as its event time. */
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("order_tracking_signals_created_idx").on(table.createdAt),
]);

/**
 * Server deliveries to GA4 (Measurement Protocol) and TikTok (Events API):
 * one row per destination and dedup key (`purchase:<orderId>`,
 * `refund:<paymentId>`), so each is sent at most once. Meta's Purchase keeps
 * its own outbox (meta_capi_purchase_outbox).
 */
export const trackingDeliveries = sqliteTable("tracking_deliveries", {
    id: text("id").primaryKey(),
    /** `ga4` or `tiktok`. */
    destination: text("destination").notNull(),
    /** `purchase` or `refund`. */
    eventName: text("event_name").notNull(),
    dedupKey: text("dedup_key").notNull(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    paymentId: text("payment_id"),
    status: text("status", {
        enum: ["pending", "processing", "sent", "failed", "skipped"],
    }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(UNIX_NOW),
    claimId: text("claim_id"),
    claimExpiresAt: integer("claim_expires_at"),
    /** Comma-separated names of the match signals the sent event carried. */
    matchSignals: text("match_signals"),
    /** A fixed reason (`consent_denied`, `not_eligible`, ...) or a bounded provider error. */
    lastError: text("last_error"),
    sentAt: integer("sent_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("tracking_deliveries_dedup_unique").on(table.destination, table.dedupKey),
    index("tracking_deliveries_due_idx").on(table.status, table.nextAttemptAt),
    index("tracking_deliveries_claim_idx").on(table.status, table.claimExpiresAt),
    index("tracking_deliveries_created_idx").on(table.createdAt),
    // The order's deliveries (payment confirmation) and the orders foreign key.
    index("tracking_deliveries_order_idx").on(table.orderId),
]);

export type MetaConversionsLog = InferSelectModel<typeof metaConversionsLogs>;
export type MetaCapiPurchaseOutbox = InferSelectModel<typeof metaCapiPurchaseOutbox>;
export type OrderTrackingSignals = InferSelectModel<typeof orderTrackingSignals>;
export type TrackingDelivery = InferSelectModel<typeof trackingDeliveries>;
