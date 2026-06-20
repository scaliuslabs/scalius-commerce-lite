// src/db/schema/marketing.ts
// Marketing domain tables: discounts, discountProducts, discountCollections,
// discountUsage, metaConversionsSettings, metaConversionsLogs.

import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { products } from "./products";
import { collections } from "./products";
import { orders } from "./orders";
import { customers } from "./customers";
import { DiscountType, DiscountValueType } from "./enums";

export const discounts = sqliteTable("discounts", {
    id: text("id").primaryKey(),
    code: text("code").notNull(), // indexed below
    type: text("type", {
        enum: [
            DiscountType.AMOUNT_OFF_PRODUCTS,
            DiscountType.AMOUNT_OFF_ORDER,
            DiscountType.FREE_SHIPPING,
        ],
    }).notNull(),
    valueType: text("value_type", {
        enum: [
            DiscountValueType.PERCENTAGE,
            DiscountValueType.FIXED_AMOUNT,
            DiscountValueType.FREE,
        ],
    }).notNull(),
    discountValue: real("discount_value").notNull(),
    minPurchaseAmount: real("min_purchase_amount"),
    minQuantity: integer("min_quantity"),
    maxUsesPerOrder: integer("max_uses_per_order"),
    maxUses: integer("max_uses"),
    limitOnePerCustomer: integer("limit_one_per_customer", { mode: "boolean" }).notNull().default(false),
    // NOTE: combineWith* flags are reserved for future multi-discount support.
    // Currently the system supports only ONE discount code per order (single
    // discountCode field on checkout payload). These flags are not enforced.
    combineWithProductDiscounts: integer("combine_with_product_discounts", { mode: "boolean" }).notNull().default(false),
    combineWithOrderDiscounts: integer("combine_with_order_discounts", { mode: "boolean" }).notNull().default(false),
    combineWithShippingDiscounts: integer("combine_with_shipping_discounts", { mode: "boolean" }).notNull().default(false),
    customerSegment: text("customer_segment"),
    startDate: integer("start_date", { mode: "timestamp" }).notNull(),
    endDate: integer("end_date", { mode: "timestamp" }),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    uniqueIndex("discounts_code_unique_idx").on(table.code),
    index("discounts_deleted_at_idx").on(table.deletedAt),
]);

export const discountProducts = sqliteTable("discount_products", {
    id: text("id").primaryKey(),
    discountId: text("discount_id")
        .notNull()
        .references(() => discounts.id, { onDelete: "cascade" }),
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    applicationType: text("application_type", { enum: ["get"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("discount_products_discount_id_idx").on(table.discountId),
    index("discount_products_product_id_idx").on(table.productId),
]);

export const discountCollections = sqliteTable("discount_collections", {
    id: text("id").primaryKey(),
    discountId: text("discount_id")
        .notNull()
        .references(() => discounts.id, { onDelete: "cascade" }),
    collectionId: text("collection_id")
        .notNull()
        .references(() => collections.id, { onDelete: "cascade" }),
    applicationType: text("application_type", { enum: ["get"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("discount_collections_discount_id_idx").on(table.discountId),
    index("discount_collections_collection_id_idx").on(table.collectionId),
]);

export const discountUsage = sqliteTable("discount_usage", {
    id: text("id").primaryKey(),
    discountId: text("discount_id")
        .notNull()
        .references(() => discounts.id, { onDelete: "cascade" }),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    amountDiscounted: real("amount_discounted").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("discount_usage_discount_customer_idx").on(table.discountId, table.customerId),
    index("discount_usage_order_id_idx").on(table.orderId),
]);

export const discountCustomerRedemptions = sqliteTable("discount_customer_redemptions", {
    discountId: text("discount_id")
        .notNull()
        .references(() => discounts.id, { onDelete: "cascade" }),
    customerKey: text("customer_key").notNull(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.discountId, table.customerKey] }),
    index("discount_customer_redemptions_order_id_idx").on(table.orderId),
    index("discount_customer_redemptions_customer_id_idx").on(table.customerId),
]);

export const metaConversionsSettings = sqliteTable("meta_conversions_settings", {
    id: text("id").primaryKey(),
    singletonKey: text("singleton_key").notNull().default("default"),
    pixelId: text("pixel_id"),
    accessToken: text("access_token"),
    testEventCode: text("test_event_code"),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(false),
    logRetentionDays: integer("log_retention_days").notNull().default(30),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("meta_conversions_settings_singleton_idx").on(table.singletonKey),
]);

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

export type Discount = InferSelectModel<typeof discounts>;
export type DiscountProduct = InferSelectModel<typeof discountProducts>;
export type DiscountCollection = InferSelectModel<typeof discountCollections>;
export type DiscountUsage = InferSelectModel<typeof discountUsage>;
export type DiscountCustomerRedemption = InferSelectModel<typeof discountCustomerRedemptions>;
export type MetaConversionsSettings = InferSelectModel<typeof metaConversionsSettings>;
export type MetaConversionsLog = InferSelectModel<typeof metaConversionsLogs>;
