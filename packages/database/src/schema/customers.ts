// src/db/schema/customers.ts
// Customer domain tables: customers, customerHistory, customerAuthOtpChallenges,
// authOtpDeliveryReceipts, customerSessions.

import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";

export const customers = sqliteTable("customers", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone").notNull().unique("customer_phone_unique"),
    address: text("address"),
    city: text("city"),
    zone: text("zone"),
    area: text("area"),
    cityName: text("city_name"),
    zoneName: text("zone_name"),
    areaName: text("area_name"),
    totalOrders: integer("total_orders").notNull().default(0),
    totalSpent: real("total_spent").notNull().default(0),
    lastOrderAt: integer("last_order_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("customers_email_idx").on(table.email),
    index("customers_phone_idx").on(table.phone),
    index("customers_dashboard_activity_idx").on(table.deletedAt, table.createdAt),
]);

export const customerHistory = sqliteTable("customer_history", {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
        .notNull()
        .references(() => customers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone").notNull(),
    address: text("address"),
    city: text("city"),
    zone: text("zone"),
    area: text("area"),
    cityName: text("city_name"),
    zoneName: text("zone_name"),
    areaName: text("area_name"),
    changeType: text("change_type", { enum: ["created", "updated", "deleted"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("customer_history_customer_id_idx").on(table.customerId),
]);

export const customerAuthOtpChallenges = sqliteTable("customer_auth_otp_challenges", {
    otpKey: text("otp_key").primaryKey(),
    deliveryKey: text("delivery_key").notNull(),
    method: text("method", { enum: ["email", "phone"] }).notNull(),
    channel: text("channel", { enum: ["email", "sms", "whatsapp"] }).notNull(),
    intent: text("intent", { enum: ["sign_in", "sign_up"] }).notNull().default("sign_in"),
    identifier: text("identifier").notNull(),
    identifierHash: text("identifier_hash").notNull(),
    identifierMasked: text("identifier_masked").notNull(),
    contactEmail: text("contact_email"),
    phone: text("phone"),
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
    uniqueIndex("customer_auth_otp_challenges_delivery_key_unique").on(table.deliveryKey),
    index("customer_auth_otp_challenges_identifier_created_idx").on(table.identifierHash, table.createdAt),
    index("customer_auth_otp_challenges_status_expires_idx").on(table.status, table.expiresAt),
]);

export const customerSessions = sqliteTable("customer_sessions", {
    tokenHash: text("token_hash").primaryKey(),
    customerId: text("customer_id")
        .notNull()
        .references(() => customers.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("customer_sessions_customer_id_idx").on(table.customerId),
    index("customer_sessions_active_expiry_idx").on(table.revokedAt, table.expiresAt),
]);

export const customerAuthOtpRateLimits = sqliteTable("customer_auth_otp_rate_limits", {
    key: text("key").primaryKey(),
    scope: text("scope", { enum: ["ip"] }).notNull().default("ip"),
    attempts: integer("attempts").notNull().default(0),
    windowExpiresAt: integer("window_expires_at").notNull(),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("customer_auth_otp_rate_limits_window_idx").on(table.windowExpiresAt),
]);

export const authOtpDeliveryReceipts = sqliteTable("auth_otp_delivery_receipts", {
    id: text("id").primaryKey(),
    deliveryKey: text("delivery_key").notNull(),
    purpose: text("purpose").notNull().default("customer_login"),
    method: text("method").notNull(),
    channel: text("channel").notNull(),
    provider: text("provider").notNull(),
    identifierHash: text("identifier_hash").notNull(),
    identifierMasked: text("identifier_masked"),
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
    otpExpiresAt: integer("otp_expires_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("auth_otp_delivery_receipts_delivery_key_unique").on(table.deliveryKey),
    index("auth_otp_delivery_receipts_identifier_created_idx").on(table.identifierHash, table.createdAt),
    index("auth_otp_delivery_receipts_pending_idx").on(table.status, table.nextAttemptAt, table.createdAt),
    index("auth_otp_delivery_receipts_claim_idx").on(table.status, table.claimExpiresAt, table.createdAt),
    index("auth_otp_delivery_receipts_provider_message_idx").on(table.provider, table.providerMessageId),
]);

export type Customer = InferSelectModel<typeof customers>;
export type CustomerHistory = InferSelectModel<typeof customerHistory>;
export type CustomerAuthOtpChallenge = InferSelectModel<typeof customerAuthOtpChallenges>;
export type CustomerSessionRow = InferSelectModel<typeof customerSessions>;
export type CustomerAuthOtpRateLimit = InferSelectModel<typeof customerAuthOtpRateLimits>;
export type AuthOtpDeliveryReceipt = InferSelectModel<typeof authOtpDeliveryReceipts>;
