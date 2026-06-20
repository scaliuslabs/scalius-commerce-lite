// src/db/schema/system.ts
// System/platform tables: settings, siteSettings, analytics, adminFcmTokens,
// shippingMethods, checkoutLanguages.

import { sqliteTable, text, integer, real, unique, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
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
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("analytics_type_idx").on(table.type),
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

export type Setting = InferSelectModel<typeof settings>;
export type SiteSettings = InferSelectModel<typeof siteSettings>;
export type Analytics = InferSelectModel<typeof analytics>;
export type AdminFcmToken = InferSelectModel<typeof adminFcmTokens>;
export type ShippingMethod = InferSelectModel<typeof shippingMethods>;
export type CheckoutLanguage = InferSelectModel<typeof checkoutLanguages>;
