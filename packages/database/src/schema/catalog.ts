// src/db/schema/catalog.ts
// Catalogue tables added by migration 0090 beside the product aggregate: the
// category closure, per-category spec sets, the facet and buyer-state
// projections, precomputed recommendations, sales stats, product content
// blocks and quantity bundles. Brands and typed attribute definitions live in
// ./products.ts because product columns reference them.

import { sqliteTable, text, integer, real, index, uniqueIndex, check, primaryKey } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { categories, productAttributes, products, productVariants } from "./products";

/**
 * Every (ancestor, descendant) pair of the category tree, including each
 * category with itself at depth 0. Trigger-maintained from
 * `categories.parent_id`; "this category and everything below it" is
 * `SELECT descendant_id FROM category_closure WHERE ancestor_id = ?`.
 */
export const categoryClosure = sqliteTable("category_closure", {
    ancestorId: text("ancestor_id")
        .notNull()
        .references(() => categories.id, { onDelete: "cascade" }),
    descendantId: text("descendant_id")
        .notNull()
        .references(() => categories.id, { onDelete: "cascade" }),
    depth: integer("depth").notNull(),
}, (table) => [
    primaryKey({ columns: [table.ancestorId, table.descendantId] }),
    index("category_closure_descendant_idx").on(table.descendantId, table.depth),
    check("category_closure_depth_range", sql`${table.depth} BETWEEN 0 AND 3`),
    check(
        "category_closure_self_shape",
        sql`(${table.depth} = 0) = (${table.ancestorId} = ${table.descendantId})`,
    ),
]);

/** The specs a category uses, in order; a category inherits its ancestors' sets. */
export const categoryAttributeSets = sqliteTable("category_attribute_sets", {
    categoryId: text("category_id")
        .notNull()
        .references(() => categories.id, { onDelete: "cascade" }),
    attributeId: text("attribute_id")
        .notNull()
        .references(() => productAttributes.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
    primaryKey({ columns: [table.categoryId, table.attributeId] }),
    index("category_attribute_sets_attribute_idx").on(table.attributeId),
]);

export const PRODUCT_FACET_KINDS = ["attribute", "option"] as const;

/**
 * Facet projection. `attribute` rows are product level (`facet_key` = the
 * attribute id; `value_key` = the enum value id, the normalised text, or the
 * canonical number/boolean text with `value_number`). `option` rows are SKU
 * level (`facet_key` = `option.<axis key>`, `value_key` = the normalised option
 * value), so combined option filters match one SKU. Rewritten per product in
 * the same batch as the product aggregate's writes and rebuildable from its
 * sources; counts join it to `product_buyer_state` for the public scope.
 */
export const productFacetValues = sqliteTable("product_facet_values", {
    /** The product for `attribute` rows, the SKU for `option` rows. */
    ownerId: text("owner_id").notNull(),
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    variantId: text("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    facetKind: text("facet_kind", { enum: PRODUCT_FACET_KINDS }).notNull(),
    facetKey: text("facet_key").notNull(),
    valueKey: text("value_key").notNull(),
    valueLabel: text("value_label").notNull(),
    valueNumber: real("value_number"),
    sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
    primaryKey({ columns: [table.ownerId, table.facetKey] }),
    check(
        "product_facet_values_owner_shape",
        sql`${table.ownerId} = coalesce(${table.variantId}, ${table.productId})`,
    ),
    check(
        "product_facet_values_kind_shape",
        sql`(${table.facetKind} = 'attribute' AND ${table.variantId} IS NULL) OR (${table.facetKind} = 'option' AND ${table.variantId} IS NOT NULL AND substr(${table.facetKey}, 1, 7) = 'option.')`,
    ),
    check(
        "product_facet_values_keys_valid",
        sql`length(${table.facetKey}) BETWEEN 1 AND 120 AND length(${table.valueKey}) BETWEEN 1 AND 200 AND length(${table.valueLabel}) BETWEEN 1 AND 200`,
    ),
    index("product_facet_values_product_idx").on(table.productId, table.facetKey, table.valueKey, table.variantId),
    index("product_facet_values_value_idx").on(table.facetKey, table.valueKey, table.productId),
    index("product_facet_values_number_idx")
        .on(table.facetKey, table.valueNumber, table.productId)
        .where(sql`${table.valueNumber} IS NOT NULL`),
]);

export const PRODUCT_BUYER_AVAILABILITY_BANDS = ["untracked", "out_of_stock", "low_stock", "in_stock"] as const;

/**
 * One row per product: the buyer-visible projection of its SKUs (public
 * eligibility, the card SKU and its price range, availability band), written
 * in the same batch as every write that can change it. A projection like
 * `availabilityBand`: stock and checkout stay authoritative, and a rebuild
 * recomputes it from them. Money is integer minor units.
 */
export const productBuyerState = sqliteTable("product_buyer_state", {
    productId: text("product_id")
        .primaryKey()
        .references(() => products.id, { onDelete: "cascade" }),
    isPublic: integer("is_public", { mode: "boolean" }).notNull().default(false),
    categoryId: text("category_id"),
    brandId: text("brand_id"),
    productCreatedAt: integer("product_created_at", { mode: "timestamp" }).notNull(),
    skuId: text("sku_id"),
    fromMinor: integer("from_minor"),
    toMinor: integer("to_minor"),
    baseMinor: integer("base_minor"),
    discountDepthBps: integer("discount_depth_bps").notNull().default(0),
    hasDiscount: integer("has_discount", { mode: "boolean" }).notNull().default(false),
    availableForSale: integer("available_for_sale", { mode: "boolean" }).notNull().default(false),
    hasCustomerOptions: integer("has_customer_options", { mode: "boolean" }).notNull().default(false),
    availabilityBand: text("availability_band", { enum: PRODUCT_BUYER_AVAILABILITY_BANDS })
        .notNull()
        .default("out_of_stock"),
    refreshedAt: integer("refreshed_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    check(
        "product_buyer_state_flags_valid",
        sql`${table.isPublic} IN (0, 1) AND ${table.hasDiscount} IN (0, 1) AND ${table.availableForSale} IN (0, 1) AND ${table.hasCustomerOptions} IN (0, 1)`,
    ),
    check(
        "product_buyer_state_band_valid",
        sql`${table.availabilityBand} IN ('untracked', 'out_of_stock', 'low_stock', 'in_stock')`,
    ),
    check("product_buyer_state_discount_depth_range", sql`${table.discountDepthBps} BETWEEN 0 AND 10000`),
    check(
        "product_buyer_state_price_shape",
        sql`(${table.skuId} IS NULL AND ${table.fromMinor} IS NULL AND ${table.toMinor} IS NULL AND ${table.baseMinor} IS NULL) OR (${table.skuId} IS NOT NULL AND ${table.fromMinor} IS NOT NULL AND ${table.toMinor} IS NOT NULL AND ${table.baseMinor} IS NOT NULL AND ${table.fromMinor} >= 0 AND ${table.toMinor} >= ${table.fromMinor} AND ${table.baseMinor} >= ${table.fromMinor})`,
    ),
    check("product_buyer_state_public_priced", sql`${table.isPublic} = 0 OR ${table.skuId} IS NOT NULL`),
    index("product_buyer_state_newest_idx").on(table.isPublic, sql`${table.productCreatedAt} DESC`, table.productId),
    index("product_buyer_state_category_newest_idx").on(
        table.isPublic,
        table.categoryId,
        sql`${table.productCreatedAt} DESC`,
        table.productId,
    ),
    index("product_buyer_state_brand_newest_idx")
        .on(table.isPublic, table.brandId, sql`${table.productCreatedAt} DESC`, table.productId)
        .where(sql`${table.brandId} IS NOT NULL`),
    index("product_buyer_state_price_idx").on(table.isPublic, table.fromMinor, table.productId),
]);

export const PRODUCT_RECOMMENDATION_REASONS = ["also_bought", "similar", "popular", "new_arrivals"] as const;
/** Positions 0-23 per product. */
export const PRODUCT_RECOMMENDATIONS_MAX = 24;

/** Precomputed recommendations per product, refreshed off the request path. */
export const productRecommendations = sqliteTable("product_recommendations", {
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    recommendedProductId: text("recommended_product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    reason: text("reason", { enum: PRODUCT_RECOMMENDATION_REASONS }).notNull(),
    computedAt: integer("computed_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.productId, table.position] }),
    check("product_recommendations_position_range", sql`${table.position} BETWEEN 0 AND 23`),
    check("product_recommendations_not_self", sql`${table.recommendedProductId} <> ${table.productId}`),
    check(
        "product_recommendations_reason_valid",
        sql`${table.reason} IN ('also_bought', 'similar', 'popular', 'new_arrivals')`,
    ),
    uniqueIndex("product_recommendations_pair_unique").on(table.productId, table.recommendedProductId),
    index("product_recommendations_recommended_idx").on(table.recommendedProductId),
]);

/** Units sold in the last 30 days, from real order lines, refreshed on a schedule. */
export const productSalesStats = sqliteTable("product_sales_stats", {
    productId: text("product_id")
        .primaryKey()
        .references(() => products.id, { onDelete: "cascade" }),
    sold30d: integer("sold_30d").notNull().default(0),
    computedAt: integer("computed_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    check("product_sales_stats_sold_nonnegative", sql`${table.sold30d} >= 0`),
    index("product_sales_stats_popular_idx").on(sql`${table.sold30d} DESC`, table.productId),
]);

export const PRODUCT_CONTENT_BLOCK_PLACEMENTS = ["tabs", "after-buy-box", "after-description", "before-reviews"] as const;

/**
 * Typed product content blocks. `settings` follows the strict per-type schema
 * in `@scalius/shared/product-content-blocks` (validated on write).
 */
export const productContentBlocks = sqliteTable("product_content_blocks", {
    id: text("id").primaryKey(),
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    placement: text("placement", { enum: PRODUCT_CONTENT_BLOCK_PLACEMENTS }).notNull(),
    position: integer("position").notNull().default(0),
    type: text("type").notNull(),
    version: integer("version").notNull().default(1),
    settings: text("settings").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    check(
        "product_content_blocks_id_shape",
        sql`substr(${table.id}, 1, 4) = 'pcb_' AND length(${table.id}) BETWEEN 8 AND 120 AND ${table.id} NOT GLOB '*[^A-Za-z0-9_-]*'`,
    ),
    check(
        "product_content_blocks_placement_valid",
        sql`${table.placement} IN ('tabs', 'after-buy-box', 'after-description', 'before-reviews')`,
    ),
    check("product_content_blocks_position_nonnegative", sql`${table.position} >= 0`),
    check(
        "product_content_blocks_type_shape",
        sql`length(${table.type}) BETWEEN 1 AND 40 AND ${table.type} = lower(${table.type}) AND ${table.type} NOT GLOB '*[^A-Za-z0-9_-]*' AND instr(${table.type}, '_') = 0`,
    ),
    check("product_content_blocks_version_positive", sql`${table.version} >= 1`),
    check(
        "product_content_blocks_settings_valid",
        sql`json_valid(${table.settings}) AND substr(${table.settings}, 1, 1) = '{' AND length(${table.settings}) <= 262144`,
    ),
    index("product_content_blocks_product_order_idx").on(table.productId, table.placement, table.position, table.id),
]);

export const PRODUCT_BUNDLE_DISCOUNT_TYPES = ["percentage", "fixed_price"] as const;

/**
 * Quantity tiers ("2 for 10% off", "3 for 900"). Checkout prices them with
 * the shared pricing engine, so every change bumps the checkout authority.
 */
export const productBundles = sqliteTable("product_bundles", {
    id: text("id").primaryKey(),
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
    discountType: text("discount_type", { enum: PRODUCT_BUNDLE_DISCOUNT_TYPES }).notNull(),
    /** Percentage off each unit in the tier, in basis points. */
    discountBps: integer("discount_bps").notNull().default(0),
    /** Total price of `quantity` units (integer minor units) for `fixed_price`. */
    priceMinor: integer("price_minor"),
    label: text("label"),
    position: integer("position").notNull().default(0),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    check(
        "product_bundles_id_shape",
        sql`substr(${table.id}, 1, 4) = 'pbd_' AND length(${table.id}) BETWEEN 10 AND 68 AND ${table.id} NOT GLOB '*[^A-Za-z0-9_-]*'`,
    ),
    check("product_bundles_quantity_range", sql`${table.quantity} BETWEEN 2 AND 100`),
    check(
        "product_bundles_price_shape",
        sql`(${table.discountType} = 'percentage' AND ${table.discountBps} BETWEEN 1 AND 9999 AND ${table.priceMinor} IS NULL) OR (${table.discountType} = 'fixed_price' AND ${table.discountBps} = 0 AND ${table.priceMinor} IS NOT NULL AND ${table.priceMinor} > 0)`,
    ),
    check(
        "product_bundles_label_valid",
        sql`${table.label} IS NULL OR (${table.label} = trim(${table.label}) AND length(${table.label}) BETWEEN 1 AND 60)`,
    ),
    check("product_bundles_position_nonnegative", sql`${table.position} >= 0`),
    check("product_bundles_active_valid", sql`${table.isActive} IN (0, 1)`),
    uniqueIndex("product_bundles_product_quantity_unique").on(table.productId, table.quantity),
]);

export type CategoryClosure = InferSelectModel<typeof categoryClosure>;
export type CategoryAttributeSet = InferSelectModel<typeof categoryAttributeSets>;
export type ProductFacetValue = InferSelectModel<typeof productFacetValues>;
export type ProductBuyerState = InferSelectModel<typeof productBuyerState>;
export type ProductRecommendation = InferSelectModel<typeof productRecommendations>;
export type ProductSalesStats = InferSelectModel<typeof productSalesStats>;
export type ProductContentBlock = InferSelectModel<typeof productContentBlocks>;
export type ProductBundle = InferSelectModel<typeof productBundles>;
