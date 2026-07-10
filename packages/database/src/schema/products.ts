// src/db/schema/products.ts
// Product domain tables: products, images, variants, categories, collections,
// attributes, attribute values, rich content, and media.

import { sqliteTable, text, integer, real, unique, index, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { taxClasses } from "./tax";

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
        variantOption1Label: text("variant_option_1_label").notNull().default("Size"),
        variantOption2Label: text("variant_option_2_label").notNull().default("Color"),
        variantOption1Schema: text("variant_option_1_schema", { enum: ["size", "color", "material", "pattern", "none"] }).notNull().default("size"),
        variantOption2Schema: text("variant_option_2_schema", { enum: ["size", "color", "material", "pattern", "none"] }).notNull().default("color"),
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

export const productImages = sqliteTable("product_images", {
    id: text("id").primaryKey(),
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    alt: text("alt"),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("product_images_product_id_idx").on(table.productId),
    index("product_images_primary_idx").on(table.productId, table.isPrimary),
]);

export const productVariants = sqliteTable("product_variants", {
    id: text("id").primaryKey(),
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    size: text("size"),
    color: text("color"),
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
    barcodeType: text("barcode_type", { enum: ["ean13", "upc", "isbn", "gtin", "custom"] }),
    colorSortOrder: integer("color_sort_order").default(0),
    sizeSortOrder: integer("size_sort_order").default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("product_variants_product_id_idx").on(table.productId),
    uniqueIndex("product_variants_sku_unique_idx").on(table.sku),
    index("product_variants_barcode_idx").on(table.barcode),
    index("product_variants_default_idx").on(table.productId, table.isDefault, table.deletedAt),
    index("product_variants_track_inventory_idx").on(table.trackInventory, table.deletedAt),
    // Manual migration 0055 also creates this partial unique index (not expressible in Drizzle):
    // product_variants_one_default_per_product_idx ON (product_id) WHERE is_default = true AND deleted_at IS NULL
]);

export const categories = sqliteTable(
    "categories",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
        slug: text("slug").notNull(),
        description: text("description"),
        imageUrl: text("image_url"),
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
    },
    (table) => [
        uniqueIndex("categories_slug_idx").on(table.slug),
        index("categories_deleted_at_idx").on(table.deletedAt),
    ],
);

export const collections = sqliteTable("collections", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type", { enum: ["manual", "dynamic"] }).notNull(),
    config: text("config").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
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

export const mediaFolders = sqliteTable("media_folders", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    parentId: text("parent_id").references((): AnySQLiteColumn => mediaFolders.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("media_folders_parent_id_idx").on(table.parentId),
]);

export const media = sqliteTable("media", {
    id: text("id").primaryKey(),
    filename: text("filename").notNull(),
    url: text("url").notNull(),
    size: integer("size").notNull(),
    mimeType: text("mime_type").notNull(),
    altText: text("alt_text"),
    width: integer("width"),
    height: integer("height"),
    folderId: text("folder_id").references(() => mediaFolders.id, { onDelete: "set null" }),
    sourceType: text("source_type", { enum: ["merchant_upload", "ai_generated"] }),
    generationId: text("generation_id"),
    generationProvider: text("generation_provider"),
    generationModel: text("generation_model"),
    generationPromptHash: text("generation_prompt_hash"),
    generationInputTokens: integer("generation_input_tokens"),
    generationOutputTokens: integer("generation_output_tokens"),
    generationTotalTokens: integer("generation_total_tokens"),
    generationCostUsdMicros: integer("generation_cost_usd_micros"),
    generationCostStatus: text("generation_cost_status", {
        enum: ["reported", "not_reported"],
    }),
    generatedAt: integer("generated_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("media_folder_id_idx").on(table.folderId),
    index("media_deleted_at_idx").on(table.deletedAt),
    uniqueIndex("media_generation_id_unique").on(table.generationId),
]);

/**
 * Short-lived authority for generated-image previews. Image bytes stay only in
 * the browser until the merchant explicitly saves them; D1 retains hashes and
 * safe provider facts so a client cannot forge media provenance.
 */
export const aiImageGenerationPreviews = sqliteTable("ai_image_generation_previews", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    imageSha256: text("image_sha256").notNull(),
    promptSha256: text("prompt_sha256").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    costUsdMicros: integer("cost_usd_micros"),
    costStatus: text("cost_status", { enum: ["reported", "not_reported"] })
        .notNull()
        .default("not_reported"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    claimedAt: integer("claimed_at", { mode: "timestamp" }),
    claimToken: text("claim_token"),
    consumedAt: integer("consumed_at", { mode: "timestamp" }),
}, (table) => [
    index("ai_image_generation_previews_user_created_idx").on(
        table.userId,
        table.createdAt,
    ),
    index("ai_image_generation_previews_expires_idx").on(table.expiresAt),
]);

export type Product = InferSelectModel<typeof products>;
export type ProductImage = InferSelectModel<typeof productImages>;
export type ProductVariant = InferSelectModel<typeof productVariants>;
export type Category = InferSelectModel<typeof categories>;
export type Collection = InferSelectModel<typeof collections>;
export type ProductAttribute = InferSelectModel<typeof productAttributes>;
export type ProductAttributeValue = InferSelectModel<typeof productAttributeValues>;
export type ProductRichContent = InferSelectModel<typeof productRichContent>;
export type Media = InferSelectModel<typeof media>;
export type AiImageGenerationPreview = InferSelectModel<typeof aiImageGenerationPreviews>;
