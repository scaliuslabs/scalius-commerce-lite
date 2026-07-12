// src/db/schema/system.ts
// System/platform tables: settings, siteSettings, analytics, adminFcmTokens,
// shippingMethods, checkoutLanguages.

import { sqliteTable, text, integer, real, unique, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { user } from "./auth";

export const settings = sqliteTable(
    "settings",
    {
        id: text("id").primaryKey(),
        key: text("key").notNull(),
        value: text("value").notNull(),
        type: text("type").notNull(),
        category: text("category").notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
        expiresAt: integer("expires_at", { mode: "timestamp" }),
    },
    (table) => [unique("settings_key_category").on(table.key, table.category)],
);

/**
 * Published storefront theme document.
 *
 * Theme colors affect every buyer-facing route, so they need an explicit
 * revision instead of the generic settings row's second-granularity timestamp.
 * The singleton shape also leaves room for future semantic theme controls
 * without scattering more presentation authority across generic keys.
 */
export const themeSettings = sqliteTable("theme_settings", {
    id: text("id").primaryKey().default("default"),
    colors: text("colors").notNull().default("{}"),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    check("theme_settings_singleton", sql`${table.id} = 'default'`),
    check("theme_settings_revision_positive", sql`${table.revision} >= 1`),
]);

export const siteSettings = sqliteTable("site_settings", {
    id: text("id").primaryKey(),
    singletonKey: text("singleton_key").notNull().default("default"),
    logo: text("logo"),
    favicon: text("favicon"),
    siteName: text("site_name").notNull(),
    siteDescription: text("site_description"),
    headerConfig: text("header_config").notNull(),
    footerConfig: text("footer_config").notNull(),
    socialLinks: text("social_links"),
    contactInfo: text("contact_info"),
    siteTitle: text("site_title"),
    homepageTitle: text("homepage_title"),
    homepageMetaDescription: text("homepage_meta_description"),
    robotsTxt: text("robots_txt"),
    storefrontUrl: text("storefront_url").default("/"),
    authVerificationMethod: text("auth_verification_method", { enum: ["email", "both", "whatsapp_otp", "sms_otp"] }).notNull().default("email"),
    guestCheckoutEnabled: integer("guest_checkout_enabled", { mode: "boolean" }).notNull().default(true),
    checkoutMode: text("checkout_mode", { enum: ["guest_cod_only", "gateways_only", "all"] }).notNull().default("all"),
    partialPaymentEnabled: integer("partial_payment_enabled", { mode: "boolean" }).notNull().default(false),
    partialPaymentAmount: real("partial_payment_amount").notNull().default(0),
    whatsappAccessToken: text("whatsapp_access_token"),
    whatsappPhoneNumberId: text("whatsapp_phone_number_id"),
    whatsappTemplateName: text("whatsapp_template_name").default("auth_otp"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("site_settings_singleton_idx").on(table.singletonKey),
]);

export const analytics = sqliteTable("analytics", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    usePartytown: integer("use_partytown", { mode: "boolean" }).notNull().default(true),
    config: text("config").notNull(),
    location: text("location").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("analytics_type_idx").on(table.type),
    index("analytics_deleted_updated_idx").on(table.deletedAt, table.updatedAt),
    check("analytics_revision_positive", sql.raw(`"revision" >= 1`)),
]);

export const adminFcmTokens = sqliteTable("admin_fcm_tokens", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    deviceInfo: text("device_info"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    lastUsed: integer("last_used", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("admin_fcm_tokens_user_id_idx").on(table.userId),
]);

export const shippingMethods = sqliteTable("shipping_methods", {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    fee: real("fee").notNull().default(0),
    description: text("description"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("shipping_methods_deleted_at_idx").on(table.deletedAt),
]);

export const checkoutLanguages = sqliteTable("checkout_languages", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    code: text("code").notNull().unique(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    languageData: text("language_data").notNull(),
    fieldVisibility: text("field_visibility").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("checkout_languages_deleted_at_idx").on(table.deletedAt),
]);

export const storefrontCacheQueueFailures = sqliteTable("storefront_cache_queue_failures", {
    id: text("id").primaryKey(),
    queueName: text("queue_name").notNull(),
    queueMessageId: text("queue_message_id").notNull(),
    messageType: text("message_type").notNull(),
    operationId: text("operation_id"),
    source: text("source"),
    payload: text("payload").notNull(),
    attempts: integer("attempts").notNull().default(0),
    status: text("status").notNull().default("pending"),
    lastError: text("last_error"),
    replayCount: integer("replay_count").notNull().default(0),
    messageTimestamp: integer("message_timestamp"),
    failedAt: integer("failed_at").notNull().default(UNIX_NOW),
    replayedAt: integer("replayed_at"),
    replayedBy: text("replayed_by"),
    ignoredAt: integer("ignored_at"),
    ignoredBy: text("ignored_by"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("storefront_cache_queue_failures_message_unique").on(table.queueMessageId),
    index("storefront_cache_queue_failures_status_failed_idx").on(table.status, table.failedAt),
    index("storefront_cache_queue_failures_operation_idx").on(table.operationId),
]);

export type Setting = InferSelectModel<typeof settings>;
export type SiteSettings = InferSelectModel<typeof siteSettings>;
export type Analytics = InferSelectModel<typeof analytics>;
export type AdminFcmToken = InferSelectModel<typeof adminFcmTokens>;
export type ShippingMethod = InferSelectModel<typeof shippingMethods>;
export type CheckoutLanguage = InferSelectModel<typeof checkoutLanguages>;
export type StorefrontCacheQueueFailure = InferSelectModel<typeof storefrontCacheQueueFailures>;
