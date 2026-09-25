// src/db/schema/products.ts
// Product domain tables: products, media associations, variants, categories, collections,
// attributes, attribute values, and rich content.

import { sqliteTable, text, integer, real, unique, index, uniqueIndex, check, primaryKey, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { taxClasses } from "./tax";
import { media } from "./media";
import { warrantyPolicies } from "./warranty";

/**
 * A discount a buyer can see: the rule the buyer pricing projection applies
 * (a flat amount or a percentage above zero). Written with bare column names
 * and literal constants because partial indexes and the queries that use them
 * must match term for term.
 */
export const ON_SALE_DISCOUNT_SQL = "((discount_type = 'flat' AND discount_amount_minor > 0) OR (discount_type = 'percentage' AND discount_bps > 0))";
/** A live SKU with its own discount (product_variants_on_sale_newest_idx). */
export const ON_SALE_SKU_ROW_SQL = `deleted_at IS NULL AND ${ON_SALE_DISCOUNT_SQL}`;

/**
 * A template id (`[a-z0-9-]`, 1-40 characters) or NULL, written with the GLOB
 * shapes the PostgreSQL DDL compiler translates.
 */
function templateIdCheck(column: string): string {
    return `"${column}" IS NULL OR (length("${column}") BETWEEN 1 AND 40 AND "${column}" = lower("${column}") AND "${column}" NOT GLOB '*[^A-Za-z0-9_-]*' AND instr("${column}", '_') = 0)`;
}

/** Deepest category depth (0-based): trees have at most four levels. */
export const CATEGORY_TREE_MAX_DEPTH = 3;

export const products = sqliteTable(
    "products",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
        description: text("description"),
        /** Integer minor units of the store currency. */
        priceMinor: integer("price_minor").notNull().default(0),
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
        /** Percentage discount in basis points (1250 = 12.5%). */
        discountBps: integer("discount_bps").notNull().default(0),
        discountType: text("discount_type", { enum: ["percentage", "flat"] }).default("percentage"),
        discountAmountMinor: integer("discount_amount_minor").notNull().default(0),
        freeDelivery: integer("free_delivery", { mode: "boolean" }).notNull().default(false),
        taxClassId: text("tax_class_id")
            .references(() => taxClasses.id, { onDelete: "set null" }),
        taxClassificationVersion: integer("tax_classification_version").notNull().default(1),
        /** Gift-card product: every variant is a denomination fulfilled as `gift_card` (Wave B). */
        isGiftCard: integer("is_gift_card", { mode: "boolean" }).notNull().default(false),
        /**
         * Buyer inputs asked on the product page (JSON, at most 4 KB). Validated by
         * `@scalius/shared/line-properties`; part of the product aggregate and the
         * checkout authority fence.
         */
        customizationSchema: text("customization_schema"),
        /** The product's brand (migration 0088); brand pages, facets, feeds and JSON-LD read it. */
        brandId: text("brand_id").references(() => brands.id, { onDelete: "set null" }),
        /** A product page configuration named in the theme document; NULL = the theme's default. */
        pageTemplate: text("page_template"),
        /** Shows EMI plans on the product page when the store has them (informational only). */
        emiEligible: integer("emi_eligible", { mode: "boolean" }).notNull().default(true),
        /** The product's warranty policy (Wave B); checkout freezes its current revision onto lines. */
        warrantyPolicyId: text("warranty_policy_id").references(() => warrantyPolicies.id, { onDelete: "set null" }),
    },
    (table) => [
        check("products_is_gift_card_check", sql`${table.isGiftCard} IN (0, 1)`),
        check(
            "products_customization_schema_check",
            sql`${table.customizationSchema} IS NULL OR (json_valid(${table.customizationSchema}) AND length(${table.customizationSchema}) <= 4096)`,
        ),
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
        index("products_public_brand_newest_idx").on(
            table.brandId,
            table.isActive,
            table.deletedAt,
            sql`${table.createdAt} DESC`,
        ),
        check("products_page_template_shape", sql.raw(templateIdCheck("page_template"))),
        check("products_emi_eligible_check", sql`${table.emiEligible} IN (0, 1)`),
        index("products_warranty_policy_idx")
            .on(table.warrantyPolicyId)
            .where(sql`${table.warrantyPolicyId} IS NOT NULL`),
        // The homepage "on sale" list (core catalog/home-lists.ts) walks only
        // discounted public products, newest first. It has the public-newest
        // index's equality columns plus the id tiebreak, so SQLite prefers it
        // for that list; the query repeats the WHERE word for word
        // (ON_SALE_DISCOUNT_SQL), so SQLite can prove the partial index applies.
        index("products_on_sale_newest_idx")
            .on(table.isActive, table.deletedAt, sql`${table.createdAt} DESC`, table.id)
            .where(sql.raw(ON_SALE_DISCOUNT_SQL)),
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
    /** Integer minor units of the store currency. */
    priceMinor: integer("price_minor").notNull().default(0),
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
    /** Percentage discount in basis points (1250 = 12.5%). */
    discountBps: integer("discount_bps").notNull().default(0),
    discountType: text("discount_type", { enum: ["percentage", "flat"] }).default("percentage"),
    discountAmountMinor: integer("discount_amount_minor").notNull().default(0),
    barcode: text("barcode"),
    barcodeType: text("barcode_type", { enum: ["ean13", "upc", "isbn", "gtin", "code128", "custom"] }),
    /** What this SKU is: shipped or picked up, delivered digitally, or performed. */
    fulfillmentKind: text("fulfillment_kind", { enum: ["physical", "digital", "service"] })
        .notNull()
        .default("physical"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    check("product_variants_fulfillment_kind_check", sql`${table.fulfillmentKind} IN ('physical', 'digital', 'service')`),
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
    // Store shape (`hasDigitalLines`) and digital readiness read only live digital SKUs.
    index("product_variants_digital_live_idx")
        .on(table.productId)
        .where(sql`${table.fulfillmentKind} = 'digital' AND ${table.deletedAt} IS NULL`),
    // The homepage "on sale" list's SKU-discount candidates, newest first
    // (ON_SALE_SKU_ROW_SQL, repeated word for word by the query).
    index("product_variants_on_sale_newest_idx")
        .on(sql`${table.createdAt} DESC`)
        .where(sql.raw(ON_SALE_SKU_ROW_SQL)),
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
        /**
         * Tree (migration 0088). Write only `parentId`: triggers keep `depth`
         * (0-3), the id `path` ('/root/child/') and `category_closure` exact,
         * and refuse cycles, trashed parents and a fifth level.
         */
        parentId: text("parent_id").references((): AnySQLiteColumn => categories.id, { onDelete: "restrict" }),
        depth: integer("depth").notNull().default(0),
        path: text("path").notNull().default(""),
        /** A listing configuration named in the theme document; NULL = the theme's default. */
        listingTemplate: text("listing_template"),
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
        index("categories_parent_idx").on(table.parentId, table.deletedAt),
        check("categories_depth_range", sql.raw(`"depth" BETWEEN 0 AND ${CATEGORY_TREE_MAX_DEPTH}`)),
        check("categories_listing_template_shape", sql.raw(templateIdCheck("listing_template"))),
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
    /** A listing configuration named in the theme document; NULL = the theme's default. */
    listingTemplate: text("listing_template"),
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
    check("collections_listing_template_shape", sql.raw(templateIdCheck("listing_template"))),
]);

/**
 * Brands (migration 0088): a first-class entity with its own page, logo and
 * SEO fields. `products.brand_id` points here.
 */
export const brands = sqliteTable("brands", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    logoMediaId: text("logo_media_id").references(() => media.id, { onDelete: "restrict" }),
    status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
    sortOrder: integer("sort_order").notNull().default(0),
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    canonicalPath: text("canonical_path"),
    noIndex: integer("no_index", { mode: "boolean" }).notNull().default(false),
    excludeFromSitemap: integer("exclude_from_sitemap", { mode: "boolean" }).notNull().default(false),
    listingTemplate: text("listing_template"),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    check("brands_id_shape", sql`substr(${table.id}, 1, 4) = 'brd_' AND length(${table.id}) BETWEEN 10 AND 68 AND ${table.id} NOT GLOB '*[^A-Za-z0-9_-]*'`),
    check("brands_name_valid", sql`${table.name} = trim(${table.name}) AND length(${table.name}) BETWEEN 1 AND 120`),
    check("brands_slug_valid", sql`length(${table.slug}) BETWEEN 1 AND 100 AND ${table.slug} = lower(${table.slug}) AND ${table.slug} NOT GLOB '*[^A-Za-z0-9_-]*' AND instr(${table.slug}, '_') = 0`),
    check("brands_description_length", sql`${table.description} IS NULL OR length(${table.description}) <= 20000`),
    check("brands_status_valid", sql`${table.status} IN ('draft', 'published')`),
    check("brands_flags_valid", sql`${table.noIndex} IN (0, 1) AND ${table.excludeFromSitemap} IN (0, 1)`),
    check("brands_listing_template_shape", sql.raw(templateIdCheck("listing_template"))),
    check("brands_revision_positive", sql`${table.revision} >= 1`),
    uniqueIndex("brands_slug_unique").on(table.slug),
    index("brands_public_idx").on(table.status, table.deletedAt, table.sortOrder),
    index("brands_logo_media_idx").on(table.logoMediaId).where(sql`${table.logoMediaId} IS NOT NULL`),
]);

/** Spec-table groups ("Display", "Processor"), migration 0088. */
export const attributeGroups = sqliteTable("attribute_groups", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    check("attribute_groups_id_shape", sql`substr(${table.id}, 1, 4) = 'atg_' AND length(${table.id}) BETWEEN 10 AND 68 AND ${table.id} NOT GLOB '*[^A-Za-z0-9_-]*'`),
    check("attribute_groups_name_valid", sql`${table.name} = trim(${table.name}) AND length(${table.name}) BETWEEN 1 AND 80`),
    uniqueIndex("attribute_groups_live_name_unique")
        .on(sql`lower(${table.name})`)
        .where(sql`${table.deletedAt} IS NULL`),
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
    // Typed spec attributes (migration 0088; vocabulary in @scalius/shared/catalog-attributes).
    groupId: text("group_id").references(() => attributeGroups.id, { onDelete: "set null" }),
    valueType: text("value_type", { enum: ["text", "number", "boolean", "enum"] }).notNull().default("text"),
    unit: text("unit"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Shown on spec cards and in the buy box. */
    keySpec: integer("key_spec", { mode: "boolean" }).notNull().default(false),
    /** An "at a glance" chip near the price. */
    highlight: integer("highlight", { mode: "boolean" }).notNull().default(false),
    facetDisplay: text("facet_display", { enum: ["checkbox", "range", "swatch", "search_list"] })
        .notNull()
        .default("checkbox"),
}, (table) => [
    index("product_attributes_slug_idx").on(table.slug),
    index("product_attributes_group_idx").on(table.groupId, table.sortOrder),
    check("product_attributes_value_type_check", sql`${table.valueType} IN ('text', 'number', 'boolean', 'enum')`),
    check("product_attributes_unit_check", sql`${table.unit} IS NULL OR (${table.unit} = trim(${table.unit}) AND length(${table.unit}) BETWEEN 1 AND 16)`),
    check("product_attributes_key_spec_check", sql`${table.keySpec} IN (0, 1)`),
    check("product_attributes_highlight_check", sql`${table.highlight} IN (0, 1)`),
    check(
        "product_attributes_facet_display_check",
        sql`${table.facetDisplay} IN ('checkbox', 'range', 'swatch', 'search_list') AND (${table.facetDisplay} <> 'range' OR ${table.valueType} = 'number') AND (${table.facetDisplay} <> 'swatch' OR ${table.valueType} = 'enum')`,
    ),
]);

/**
 * Normalised values of an attribute (migration 0088). Enum attributes pick
 * from these; `normalized_value` is the identity, `value` the display text.
 */
export const attributeValues = sqliteTable("attribute_values", {
    id: text("id").primaryKey(),
    attributeId: text("attribute_id")
        .notNull()
        .references(() => productAttributes.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    swatchHex: text("swatch_hex"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    check("attribute_values_id_shape", sql`substr(${table.id}, 1, 4) = 'atv_' AND length(${table.id}) BETWEEN 10 AND 68 AND ${table.id} NOT GLOB '*[^A-Za-z0-9_-]*'`),
    check("attribute_values_value_valid", sql`${table.value} = trim(${table.value}) AND length(${table.value}) BETWEEN 1 AND 200`),
    check("attribute_values_normalized_value_valid", sql`${table.normalizedValue} = lower(trim(${table.value}))`),
    check("attribute_values_swatch_hex_valid", sql`${table.swatchHex} IS NULL OR (length(${table.swatchHex}) = 7 AND ${table.swatchHex} GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')`),
    uniqueIndex("attribute_values_live_value_unique")
        .on(table.attributeId, table.normalizedValue)
        .where(sql`${table.deletedAt} IS NULL`),
    index("attribute_values_attribute_order_idx").on(table.attributeId, table.deletedAt, table.sortOrder),
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
        /**
         * Typed value (migration 0088): enums name their normalised value,
         * numbers and booleans (0/1) carry `valueNumber`; `value` stays the
         * display text. Triggers refuse a value that does not match the type.
         */
        valueId: text("value_id").references(() => attributeValues.id, { onDelete: "restrict" }),
        valueNumber: real("value_number"),
    },
    (table) => [
        unique().on(table.productId, table.attributeId),
        index("product_attribute_values_value_id_idx")
            .on(table.valueId)
            .where(sql`${table.valueId} IS NOT NULL`),
        index("product_attribute_values_product_id_idx").on(table.productId),
        index("product_attribute_values_attribute_id_idx").on(table.attributeId),
        index("product_attribute_values_attr_value_product_idx").on(
            table.attributeId,
            table.value,
            table.productId,
        ),
    ],
);

/**
 * Legacy product tabs. Migration 0088 mirrors every write into
 * `product_content_blocks` (`rich-text` blocks in the `tabs` placement); the
 * table is dropped once its readers and writers use the blocks.
 */
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
export type Brand = InferSelectModel<typeof brands>;
export type AttributeGroup = InferSelectModel<typeof attributeGroups>;
export type AttributeValue = InferSelectModel<typeof attributeValues>;
