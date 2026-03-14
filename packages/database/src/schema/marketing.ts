// src/db/schema/marketing.ts
// Marketing domain tables: discounts, discountProducts, discountCollections,
// discountUsage, metaConversionsSettings, metaConversionsLogs.

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
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
    limitOnePerCustomer: integer("limit_one_per_customer", { mode: "boolean" }).default(false),
    combineWithProductDiscounts: integer("combine_with_product_discounts", { mode: "boolean" }).default(false),
    combineWithOrderDiscounts: integer("combine_with_order_discounts", { mode: "boolean" }).default(false),
    combineWithShippingDiscounts: integer("combine_with_shipping_discounts", { mode: "boolean" }).default(false),
    customerSegment: text("customer_segment"),
    startDate: integer("start_date", { mode: "timestamp" }).notNull(),
    endDate: integer("end_date", { mode: "timestamp" }),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("discounts_code_idx").on(table.code),
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
        .default(sql`CURRENT_TIMESTAMP`),
});

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
        .default(sql`CURRENT_TIMESTAMP`),
});

export const discountUsage = sqliteTable("discount_usage", {
    id: text("id").primaryKey(),
    discountId: text("discount_id")
        .notNull()
        .references(() => discounts.id, { onDelete: "cascade" }),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    customerId: text("customer_id").references(() => customers.id),
    amountDiscounted: real("amount_discounted").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
    index("discount_usage_discount_customer_idx").on(table.discountId, table.customerId),
]);

export const metaConversionsSettings = sqliteTable("meta_conversions_settings", {
    id: text("id").primaryKey(),
    pixelId: text("pixel_id"),
    accessToken: text("access_token"),
    testEventCode: text("test_event_code"),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(false),
    logRetentionDays: integer("log_retention_days").notNull().default(30),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(sql`(cast(strftime('%s','now') as int))`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(sql`(cast(strftime('%s','now') as int))`),
});

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
        .default(sql`(cast(strftime('%s','now') as int))`),
});

export type Discount = InferSelectModel<typeof discounts>;
export type DiscountProduct = InferSelectModel<typeof discountProducts>;
export type DiscountCollection = InferSelectModel<typeof discountCollections>;
export type DiscountUsage = InferSelectModel<typeof discountUsage>;
export type MetaConversionsSettings = InferSelectModel<typeof metaConversionsSettings>;
export type MetaConversionsLog = InferSelectModel<typeof metaConversionsLogs>;
