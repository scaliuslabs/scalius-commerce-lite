// src/db/schema/products.ts
// Product domain tables: products, media associations, variants, categories, collections,
// attributes, attribute values, and rich content.

import { sqliteTable, text, integer, real, unique, index, uniqueIndex, check, primaryKey } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { taxClasses } from "./tax";
import { media } from "./media";

export const products = sqliteTable(
    "products",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
        description: text("description"),
        price: real("price").notNull(),
        categoryId: text("category_id")
            .references(() => categories.id, { onDelete: "set null" }),
        slug: text("slug").notNull(),
        metaTitle: text("meta_title"),
        metaDescription: text("meta_description"),
        canonicalPath: text("canonical_path"),
        noIndex: integer("no_index", { mode: "boolean" }).notNull().default(false),
        excludeFromSitemap: integer("exclude_from_sitemap", { mode: "boolean" }).notNull().default(false),
        excludeFromProductFeed: integer("exclude_from_product_feed", { mode: "boolean" }).notNull().default(false),
        productCondition: text("product_condition", { enum: ["new", "refurbished", "used"] }),
        aggregateRevision: integer("aggregate_revision").notNull().default(1),
        createdAt: integer("created_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
        updatedAt: integer("updated_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
        deletedAt: integer("deleted_at", { mode: "timestamp" }),
        isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
        discountPercentage: real("discount_percentage").default(0),
        discountType: text("discount_type", { enum: ["percentage", "flat"] }).default("percentage"),
        discountAmount: real("discount_amount").default(0),
        freeDelivery: integer("free_delivery", { mode: "boolean" }).notNull().default(false),
        taxClassId: text("tax_class_id")
            .references(() => taxClasses.id, { onDelete: "set null" }),
        taxClassificationVersion: integer("tax_classification_version").notNull().default(1),
    },
    (table) => [
        uniqueIndex("products_slug_idx").on(table.slug),
        index("products_category_id_idx").on(table.categoryId),
        index("products_active_idx").on(table.isActive, table.deletedAt),
        index("products_public_newest_idx").on(table.isActive, table.deletedAt, sql`${table.createdAt} DESC`),
        index("products_public_category_newest_idx").on(
            table.categoryId,
            table.isActive,
            table.deletedAt,
            sql`${table.createdAt} DESC`,
        ),
        index("products_deleted_at_idx").on(table.deletedAt),
    ],
);

export const productMedia = sqliteTable("product_media", {
    id: text("id").primaryKey(),
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    mediaId: text("media_id")
        .notNull()
        .references(() => media.id, { onDelete: "restrict" }),
    altText: text("alt_text"),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    check(
        "product_media_id_valid",
        sql`substr(${table.id}, 1, 5) = 'pmed_' AND length(${table.id}) BETWEEN 10 AND 80 AND ${table.id} NOT GLOB '*[^A-Za-z0-9_-]*'`,
    ),
    check(
        "product_media_alt_text_valid",
        sql`${table.altText} IS NULL OR (${table.altText} = trim(${table.altText}) AND length(${table.altText}) <= 500)`,
    ),
    check("product_media_primary_valid", sql`${table.isPrimary} IN (0, 1)`),
    check("product_media_sort_order_valid", sql`${table.sortOrder} >= 0`),
    uniqueIndex("product_media_product_asset_uidx").on(table.productId, table.mediaId),
    uniqueIndex("product_media_product_order_uidx").on(table.productId, table.sortOrder),
    uniqueIndex("product_media_one_primary_uidx")
        .on(table.productId)
        .where(sql`${table.isPrimary} = 1`),
    index("product_media_product_order_idx").on(table.productId, table.sortOrder, table.id),
    index("product_media_asset_product_idx").on(table.mediaId, table.productId),
    index("product_media_primary_lookup_idx")
        .on(table.productId, table.id)
        .where(sql`${table.isPrimary} = 1`),
]);

export const productOptionDefinitions = sqliteTable("product_option_definitions", {
    id: text("id").primaryKey(),
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    position: integer("position").notNull(),
    standardMapping: text("standard_mapping", { enum: ["size", "color", "material", "pattern", "none"] })
        .notNull()
        .default("none"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    check("product_option_definitions_name_check", sql`${table.name} = trim(${table.name}) AND ${table.name} <> ''`),
    check("product_option_definitions_normalized_name_check", sql`${table.normalizedName} = lower(trim(${table.name}))`),
    check("product_option_definitions_position_check", sql`${table.position} >= 0 AND ${table.position} < 5`),
    uniqueIndex("product_option_definitions_name_uidx")
        .on(table.productId, table.normalizedName)
        .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("product_option_definitions_position_uidx")
        .on(table.productId, table.position)
        .where(sql`${table.deletedAt} IS NULL`),
    index("product_option_definitions_product_idx").on(table.productId, table.deletedAt, table.position),
]);

export const productOptionValues = sqliteTable("product_option_values", {
    id: text("id").primaryKey(),
    optionDefinitionId: text("option_definition_id")
        .notNull()
        .references(() => productOptionDefinitions.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    position: integer("position").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    check("product_option_values_value_check", sql`${table.value} = trim(${table.value}) AND ${table.value} <> ''`),
    check("product_option_values_normalized_value_check", sql`${table.normalizedValue} = lower(trim(${table.value}))`),
    check("product_option_values_position_check", sql`${table.position} >= 0`),
    uniqueIndex("product_option_values_value_uidx")
        .on(table.optionDefinitionId, table.normalizedValue)
        .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("product_option_values_position_uidx")
        .on(table.optionDefinitionId, table.position)
        .where(sql`${table.deletedAt} IS NULL`),
    index("product_option_values_definition_idx").on(table.optionDefinitionId, table.deletedAt, table.position),
]);

export const productVariants = sqliteTable("product_variants", {
    id: text("id").primaryKey(),
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    optionCombinationKey: text("option_combination_key"),
    imageId: text("image_id")
        .references(() => productMedia.id, { onDelete: "set null" }),
    weight: real("weight"),
    sku: text("sku").notNull(),
    price: real("price").notNull(),
    stock: integer("stock").notNull().default(0),
    reservedStock: integer("reserved_stock").notNull().default(0),
    preorderStock: integer("preorder_stock").notNull().default(0),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    trackInventory: integer("track_inventory", { mode: "boolean" }).notNull().default(true),
    version: integer("version").notNull().default(1), // Optimistic locking
    /** Optimistic locking for stock-specific operations (separate from general version) */
    stockVersion: integer("stock_version").notNull().default(1),
    lowStockThreshold: integer("low_stock_threshold"),
    allowPreorder: integer("allow_preorder", { mode: "boolean" }).notNull().default(false),
    preorderDate: text("preorder_date"),
    preorderMessage: text("preorder_message"),
    allowBackorder: integer("allow_backorder", { mode: "boolean" }).notNull().default(false),
    backorderLimit: integer("backorder_limit").notNull().default(0),
    taxClassId: text("tax_class_id")
        .references(() => taxClasses.id, { onDelete: "set null" }),
    taxClassificationVersion: integer("tax_classification_version").notNull().default(1),
    discountPercentage: real("discount_percentage").default(0),
    discountType: text("discount_type", { enum: ["percentage", "flat"] }).default("percentage"),
    discountAmount: real("discount_amount").default(0),
    barcode: text("barcode"),
    barcodeType: text("barcode_type", { enum: ["ean13", "upc", "isbn", "gtin", "code128", "custom"] }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("product_variants_product_id_idx").on(table.productId),
    uniqueIndex("product_variants_sku_identity_uidx")
        .on(sql`lower(trim(${table.sku}))`),
    uniqueIndex("product_variants_barcode_identity_uidx")
        .on(sql`lower(trim(${table.barcode}))`)
        .where(sql`${table.barcode} IS NOT NULL AND trim(${table.barcode}) <> ''`),
    check(
        "product_variants_option_topology_check",
        sql`(
            (${table.isDefault} = true AND ${table.optionCombinationKey} IS NULL)
            OR
            (${table.isDefault} = false AND trim(coalesce(${table.optionCombinationKey}, '')) <> '')
        )`,
    ),
    uniqueIndex("product_variants_active_option_identity_uidx")
        .on(table.productId, table.optionCombinationKey)
        .where(sql`${table.deletedAt} IS NULL AND ${table.isDefault} = false`),
    index("product_variants_default_idx").on(table.productId, table.isDefault, table.deletedAt),
    index("product_variants_image_idx").on(table.imageId),
    index("product_variants_track_inventory_idx").on(table.trackInventory, table.deletedAt),
    // Manual migration 0055 also creates this partial unique index (not expressible in Drizzle):
    // product_variants_one_default_per_product_idx ON (product_id) WHERE is_default = true AND deleted_at IS NULL
]);

export const productVariantOptionValues = sqliteTable("product_variant_option_values", {
    variantId: text("variant_id")
        .notNull()
        .references(() => productVariants.id, { onDelete: "cascade" }),
    optionDefinitionId: text("option_definition_id")
        .notNull()
        .references(() => productOptionDefinitions.id, { onDelete: "cascade" }),
    optionValueId: text("option_value_id")
        .notNull()
        .references(() => productOptionValues.id, { onDelete: "cascade" }),
}, (table) => [
    primaryKey({ columns: [table.variantId, table.optionDefinitionId] }),
    uniqueIndex("product_variant_option_values_value_uidx").on(table.variantId, table.optionValueId),
    index("product_variant_option_values_definition_idx").on(table.optionDefinitionId, table.optionValueId),
    index("product_variant_option_values_value_idx").on(table.optionValueId, table.variantId),
]);

export const categories = sqliteTable(
    "categories",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
        slug: text("slug").notNull(),
        description: text("description"),
        content: text("content"),
        imageUrl: text("image_url"),
        metaTitle: text("meta_title"),
        metaDescription: text("meta_description"),
        canonicalPath: text("canonical_path"),
        noIndex: integer("no_index", { mode: "boolean" }).notNull().default(false),
        excludeFromSitemap: integer("exclude_from_sitemap", { mode: "boolean" }).notNull().default(false),
        status: text("status", { enum: ["draft", "published", "internal"] })
            .notNull()
            .default("draft"),
        revision: integer("revision").notNull().default(1),
        createdAt: integer("created_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
        updatedAt: integer("updated_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
        deletedAt: integer("deleted_at", { mode: "timestamp" }),
    },
    (table) => [
        uniqueIndex("categories_slug_idx").on(table.slug),
        index("categories_deleted_at_idx").on(table.deletedAt),
        index("categories_public_idx").on(table.status, table.deletedAt),
        check("categories_status_valid", sql.raw(`"status" IN ('draft', 'published', 'internal')`)),
        check("categories_revision_positive", sql.raw(`"revision" >= 1`)),
    ],
);

export const collections = sqliteTable("collections", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    content: text("content"),
    presentation: text("presentation", { enum: ["grid", "carousel"] }).notNull(),
    config: text("config").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    /** Optimistic concurrency token for every admin collection mutation. */
    version: integer("version").notNull().default(1),
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    canonicalPath: text("canonical_path"),
    noIndex: integer("no_index", { mode: "boolean" }).notNull().default(false),
    excludeFromSitemap: integer("exclude_from_sitemap", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("collections_deleted_at_idx").on(table.deletedAt),
    check("collections_version_positive", sql`${table.version} >= 1`),
]);

export const productAttributes = sqliteTable("product_attributes", {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    slug: text("slug").notNull().unique(),
    filterable: integer("filterable", { mode: "boolean" }).notNull().default(true),
    options: text("options", { mode: "json" }).$type<string[]>(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("product_attributes_slug_idx").on(table.slug),
]);

export const productAttributeValues = sqliteTable(
    "product_attribute_values",
    {
        id: text("id").primaryKey(),
        productId: text("product_id")
            .notNull()
            .references(() => products.id, { onDelete: "cascade" }),
        attributeId: text("attribute_id")
            .notNull()
            .references(() => productAttributes.id, { onDelete: "cascade" }),
        value: text("value").notNull(),
        createdAt: integer("created_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
    },
    (table) => [
        unique().on(table.productId, table.attributeId),
        index("product_attribute_values_product_id_idx").on(table.productId),
        index("product_attribute_values_attribute_id_idx").on(table.attributeId),
        index("product_attribute_values_attr_value_product_idx").on(
            table.attributeId,
            table.value,
            table.productId,
        ),
    ],
);

export const productRichContent = sqliteTable("product_rich_content", {
    id: text("id").primaryKey(),
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("product_rich_content_product_id_idx").on(table.productId),
]);

export type Product = InferSelectModel<typeof products>;
export type ProductMedia = InferSelectModel<typeof productMedia>;
export type ProductOptionDefinition = InferSelectModel<typeof productOptionDefinitions>;
export type ProductOptionValue = InferSelectModel<typeof productOptionValues>;
export type ProductVariant = InferSelectModel<typeof productVariants>;
export type ProductVariantOptionValue = InferSelectModel<typeof productVariantOptionValues>;
export type Category = InferSelectModel<typeof categories>;
export type Collection = InferSelectModel<typeof collections>;
export type ProductAttribute = InferSelectModel<typeof productAttributes>;
export type ProductAttributeValue = InferSelectModel<typeof productAttributeValues>;
export type ProductRichContent = InferSelectModel<typeof productRichContent>;
