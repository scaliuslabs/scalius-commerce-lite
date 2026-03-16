// src/db/schema/products.ts
// Product domain tables: products, images, variants, categories, collections,
// attributes, attribute values, rich content, and media.

import { sqliteTable, text, integer, real, unique, index } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";

export const products = sqliteTable(
    "products",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
        description: text("description"),
        price: real("price").notNull(),
        categoryId: text("category_id")
            .notNull()
            .references(() => categories.id, { onDelete: "set null" }),
        slug: text("slug").notNull(),
        metaTitle: text("meta_title"),
        metaDescription: text("meta_description"),
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
    },
    (table) => [
        index("products_slug_idx").on(table.slug),
        index("products_category_id_idx").on(table.categoryId),
        index("products_active_idx").on(table.isActive, table.deletedAt),
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
    version: integer("version").notNull().default(1), // Optimistic locking
    /** Optimistic locking for stock-specific operations (separate from general version) */
    stockVersion: integer("stock_version").notNull().default(1),
    lowStockThreshold: integer("low_stock_threshold"),
    allowPreorder: integer("allow_preorder", { mode: "boolean" }).notNull().default(false),
    preorderDate: text("preorder_date"),
    preorderMessage: text("preorder_message"),
    allowBackorder: integer("allow_backorder", { mode: "boolean" }).notNull().default(false),
    backorderLimit: integer("backorder_limit").notNull().default(0),
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
    index("product_variants_sku_idx").on(table.sku),
    index("product_variants_barcode_idx").on(table.barcode),
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
        createdAt: integer("created_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
        updatedAt: integer("updated_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
        deletedAt: integer("deleted_at", { mode: "timestamp" }),
    },
    (table) => [
        index("categories_slug_idx").on(table.slug),
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
});

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
    parentId: text("parent_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

export const media = sqliteTable("media", {
    id: text("id").primaryKey(),
    filename: text("filename").notNull(),
    url: text("url").notNull(),
    size: integer("size").notNull(),
    mimeType: text("mime_type").notNull(),
    folderId: text("folder_id").references(() => mediaFolders.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

export type Product = InferSelectModel<typeof products>;
export type ProductImage = InferSelectModel<typeof productImages>;
export type ProductVariant = InferSelectModel<typeof productVariants>;
export type Category = InferSelectModel<typeof categories>;
export type Collection = InferSelectModel<typeof collections>;
export type ProductAttribute = InferSelectModel<typeof productAttributes>;
export type ProductAttributeValue = InferSelectModel<typeof productAttributeValues>;
export type ProductRichContent = InferSelectModel<typeof productRichContent>;
export type Media = InferSelectModel<typeof media>;
