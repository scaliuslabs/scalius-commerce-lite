// Catalogue projections (migration 0090): `product_buyer_state`, one row per
// product, and `product_facet_values`, one row per product attribute value
// and per SKU option value. Listings, counts, sitemaps and facets read these
// indexed rows instead of evaluating public eligibility and the SKU pricing
// window over the whole catalogue on every request.
//
// They are projections like `availabilityBand`: never checkout authority.
// Every write that can change them appends `catalogProjectionRefreshStatements`
// (or the SKU-scoped buyer-state variant) to its own D1 batch, after the
// ledger-v2 edge and the `stockVersion` CAS, so the projection commits with
// the write or not at all. `rebuildCatalogProjections` recomputes them from
// the same sources in keyset pages; the nightly rebuild and the dashboard
// action heal drift and fill them the first time.
//
// The SQL is single-sourced: the buyer pricing projection
// (`buildBuyerCatalogPricingProjection`) and the public eligibility predicate
// (`publicProductHasBuyerResolvableSku`) are the same expressions the live
// catalogue reads used, scoped to at most 90 products per statement through
// one `json_each` parameter.
import {
    attributeValues,
    productAttributeValues,
    productAttributes,
    productBuyerState,
    productFacetValues,
    productOptionDefinitions,
    productOptionValues,
    productVariantOptionValues,
    products,
    productVariants,
} from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { OPTION_FACET_KEY_PREFIX } from "@scalius/shared/catalog-attributes";
import { buildBuyerCatalogPricingProjection } from "./buyer-projection";
import { publicProductHasBuyerResolvableSku } from "./public-eligibility";
import { storeDefaultLowStockThresholdSql } from "../inventory/low-stock-policy";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** Products per refresh statement group: the D1 enrichment bound. */
export const CATALOG_PROJECTION_PRODUCTS_PER_CALL = 90;
/** Products one rebuild call recomputes (sequential batches of 90). */
export const CATALOG_PROJECTION_REBUILD_DEFAULT_LIMIT = 900;
export const CATALOG_PROJECTION_REBUILD_MAX_LIMIT = 2_700;

export type CatalogProjectionScope =
    | { productIds: readonly string[] }
    | { skuIds: readonly string[] };

export interface CatalogProjectionRefreshOptions {
    /**
     * Rewrite the facet rows too. Stock-only writes (reservations, releases,
     * adjustments) cannot change a facet value, so they refresh buyer state only.
     */
    facets?: boolean;
}

function uniqueIds(ids: readonly string[]): string[] {
    return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
    return out;
}

/** The products a scope names, as a condition on `products` (one bound parameter). */
function productScopeCondition(kind: "product" | "sku", ids: readonly string[]): SQL {
    const idSet = sql`(SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`;
    return kind === "product"
        ? sql`${products.id} IN ${idSet}`
        : sql`${products.id} IN (
            SELECT scope_sku.product_id FROM product_variants AS scope_sku
            WHERE scope_sku.id IN ${idSet}
        )`;
}

/** The same scope as a condition on a column holding a product id. */
function productIdColumnScope(column: SQL, kind: "product" | "sku", ids: readonly string[]): SQL {
    const idSet = sql`(SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`;
    return kind === "product"
        ? sql`${column} IN ${idSet}`
        : sql`${column} IN (
            SELECT scope_sku.product_id FROM product_variants AS scope_sku
            WHERE scope_sku.id IN ${idSet}
        )`;
}

/**
 * The live buyer state of the scoped products, in `product_buyer_state`
 * column order. Used by the refresh insert and by drift checks.
 *
 * - `is_public`: active, not trashed, a buyer-resolvable SKU topology (the
 *   storefront's own predicate) and a priced card SKU.
 * - `sku_id`, `from/to/base_minor`, `has_discount`, `available_for_sale`,
 *   `has_customer_options`: the buyer pricing projection's card row.
 * - `discount_depth_bps`: (base - from) / base of the card SKU, the
 *   listing's "discount" sort.
 * - `availability_band`: the card SKU's band (its own low-stock level, else
 *   the store default), as `resolveBuyerAvailabilityBand`.
 */
export function selectLiveCatalogBuyerState(db: Database, scope: SQL) {
    const pricing = buildBuyerCatalogPricingProjection(db, { productScope: scope });
    const cardSku = alias(productVariants, "buyer_state_card_sku");
    const effective = sql`${pricing.effectivePriceMinor}`;
    const available = sql`(${cardSku.stock} - ${cardSku.reservedStock})`;
    const threshold = sql`COALESCE(${cardSku.lowStockThreshold}, ${storeDefaultLowStockThresholdSql()})`;
    return db
        .select({
            productId: products.id,
            isPublic: sql<number>`CASE
                WHEN ${products.isActive} = 1
                  AND ${products.deletedAt} IS NULL
                  AND ${pricing.skuId} IS NOT NULL
                  AND ${publicProductHasBuyerResolvableSku()}
                THEN 1 ELSE 0
            END`.as("buyer_state_is_public"),
            categoryId: products.categoryId,
            brandId: products.brandId,
            productCreatedAt: products.createdAt,
            skuId: pricing.skuId,
            fromMinor: sql<number | null>`${effective}`.as("buyer_state_from_minor"),
            toMinor: sql<number | null>`CASE
                WHEN ${pricing.skuId} IS NULL THEN NULL
                ELSE MAX(COALESCE(${pricing.maxBuyerPriceMinor}, ${effective}), ${effective})
            END`.as("buyer_state_to_minor"),
            baseMinor: sql<number | null>`CASE
                WHEN ${pricing.skuId} IS NULL THEN NULL
                ELSE MAX(${pricing.basePriceMinor}, ${effective})
            END`.as("buyer_state_base_minor"),
            discountDepthBps: sql<number>`CASE
                WHEN ${pricing.skuId} IS NOT NULL AND ${pricing.basePriceMinor} > 0 AND ${pricing.basePriceMinor} > ${effective}
                    THEN MIN((${pricing.basePriceMinor} - ${effective}) * 10000 / ${pricing.basePriceMinor}, 10000)
                ELSE 0
            END`.as("buyer_state_discount_depth_bps"),
            hasDiscount: sql<number>`COALESCE(${pricing.hasDiscount}, 0)`.as("buyer_state_has_discount"),
            availableForSale: sql<number>`COALESCE(${pricing.availableForSale}, 0)`.as("buyer_state_available_for_sale"),
            hasCustomerOptions: sql<number>`COALESCE(${pricing.hasCustomerOptions}, 0)`.as("buyer_state_has_customer_options"),
            availabilityBand: sql<string>`CASE
                WHEN ${cardSku.id} IS NULL THEN 'out_of_stock'
                WHEN ${cardSku.trackInventory} = 0 THEN 'untracked'
                WHEN ${available} <= 0 THEN 'out_of_stock'
                WHEN ${threshold} > 0 AND ${available} <= ${threshold} THEN 'low_stock'
                ELSE 'in_stock'
            END`.as("buyer_state_availability_band"),
            refreshedAt: sql<number>`unixepoch()`.as("buyer_state_refreshed_at"),
        })
        .from(products)
        .leftJoin(pricing, eq(pricing.productId, products.id))
        .leftJoin(cardSku, eq(cardSku.id, pricing.skuId))
        .where(scope);
}

function buyerStateUpsert(db: Database, scope: SQL): SQLiteBatchItem {
    const excluded = (column: string) => sql.raw(`excluded.${column}`);
    return db
        .insert(productBuyerState)
        .select(selectLiveCatalogBuyerState(db, scope) as never)
        .onConflictDoUpdate({
            // Unqualified: an insert-select renders a column target as
            // "table"."column", which PostgreSQL refuses in ON CONFLICT.
            target: sql.identifier("product_id") as never,
            set: {
                isPublic: excluded("is_public"),
                categoryId: excluded("category_id"),
                brandId: excluded("brand_id"),
                productCreatedAt: excluded("product_created_at"),
                skuId: excluded("sku_id"),
                fromMinor: excluded("from_minor"),
                toMinor: excluded("to_minor"),
                baseMinor: excluded("base_minor"),
                discountDepthBps: excluded("discount_depth_bps"),
                hasDiscount: excluded("has_discount"),
                availableForSale: excluded("available_for_sale"),
                hasCustomerOptions: excluded("has_customer_options"),
                availabilityBand: excluded("availability_band"),
                refreshedAt: excluded("refreshed_at"),
            },
        });
}

/**
 * Canonical number text in SQL, the twin of `canonicalAttributeNumber`:
 * six decimals, no trailing zeros ("15.60" -> "15.6", 1e3 -> "1000"),
 * computed in integer arithmetic so D1, Turso and PostgreSQL agree.
 */
function canonicalNumberSql(value: SQL): SQL<string> {
    const scaled = sql`CAST(round(${value} * 1000000) AS INTEGER)`;
    const magnitude = sql`abs(${scaled})`;
    const fraction = sql`(${magnitude} % 1000000)`;
    return sql<string>`(CASE WHEN ${scaled} < 0 THEN '-' ELSE '' END
        || CAST(${magnitude} / 1000000 AS TEXT)
        || CASE WHEN ${fraction} = 0 THEN ''
            ELSE '.' || rtrim(substr(CAST(1000000 + ${fraction} AS TEXT), 2), '0') END)`;
}

/** The facet value key of a stored attribute value (`attributeFacetValueKey`). */
function attributeFacetValueKeySql(): SQL<string | null> {
    return sql<string | null>`CASE ${productAttributes.valueType}
        WHEN 'enum' THEN ${productAttributeValues.valueId}
        WHEN 'number' THEN CASE WHEN ${productAttributeValues.valueNumber} IS NULL THEN NULL
            ELSE ${canonicalNumberSql(sql`${productAttributeValues.valueNumber}`)} END
        WHEN 'boolean' THEN CASE WHEN ${productAttributeValues.valueNumber} IS NULL THEN NULL
            ELSE CAST(CAST(${productAttributeValues.valueNumber} AS INTEGER) AS TEXT) END
        ELSE substr(lower(trim(${productAttributeValues.value})), 1, 200)
    END`;
}

/** Live attribute value rows of the scoped products, in `product_facet_values` column order. */
export function selectLiveAttributeFacetRows(db: Database, productScope: SQL) {
    const valueKey = attributeFacetValueKeySql();
    return db
        .select({
            ownerId: productAttributeValues.productId,
            productId: productAttributeValues.productId,
            variantId: sql<string | null>`NULL`.as("facet_variant_id"),
            facetKind: sql<"attribute">`'attribute'`.as("facet_kind_value"),
            facetKey: productAttributes.id,
            valueKey: valueKey.as("facet_value_key"),
            valueLabel: sql<string>`COALESCE(NULLIF(substr(trim(${productAttributeValues.value}), 1, 200), ''), ${valueKey})`
                .as("facet_value_label"),
            valueNumber: sql<number | null>`CASE WHEN ${productAttributes.valueType} IN ('number', 'boolean')
                THEN ${productAttributeValues.valueNumber} ELSE NULL END`.as("facet_value_number"),
            sortOrder: sql<number>`COALESCE(${attributeValues.sortOrder}, 0)`.as("facet_sort_order"),
        })
        .from(productAttributeValues)
        .innerJoin(productAttributes, and(
            eq(productAttributes.id, productAttributeValues.attributeId),
            isNull(productAttributes.deletedAt),
        ))
        .leftJoin(attributeValues, eq(attributeValues.id, productAttributeValues.valueId))
        .where(and(
            productScope,
            sql`length(${productAttributes.id}) BETWEEN 1 AND 120`,
            sql`length(${valueKey}) BETWEEN 1 AND 200`,
        ));
}

/**
 * Live option rows of the scoped products' live SKUs: one per SKU and axis,
 * keyed `option.<axis key>` like the storefront's option filters.
 */
export function selectLiveOptionFacetRows(db: Database, productScope: SQL) {
    const axisKey = sql<string>`${OPTION_FACET_KEY_PREFIX} || replace(${productOptionDefinitions.normalizedName}, ' ', '-')`;
    return db
        .select({
            ownerId: productVariants.id,
            productId: productVariants.productId,
            variantId: productVariants.id,
            facetKind: sql<"option">`'option'`.as("facet_kind_value"),
            facetKey: axisKey.as("facet_key_value"),
            valueKey: sql<string>`substr(${productOptionValues.normalizedValue}, 1, 200)`.as("facet_value_key"),
            valueLabel: sql<string>`COALESCE(NULLIF(substr(trim(${productOptionValues.value}), 1, 200), ''), substr(${productOptionValues.normalizedValue}, 1, 200))`
                .as("facet_value_label"),
            valueNumber: sql<number | null>`NULL`.as("facet_value_number"),
            sortOrder: productOptionValues.position,
        })
        .from(productVariants)
        .innerJoin(productVariantOptionValues, eq(productVariantOptionValues.variantId, productVariants.id))
        .innerJoin(productOptionDefinitions, and(
            eq(productOptionDefinitions.id, productVariantOptionValues.optionDefinitionId),
            isNull(productOptionDefinitions.deletedAt),
        ))
        .innerJoin(productOptionValues, and(
            eq(productOptionValues.id, productVariantOptionValues.optionValueId),
            isNull(productOptionValues.deletedAt),
        ))
        .where(and(
            productScope,
            isNull(productVariants.deletedAt),
            sql`${productVariants.id} <> 'default'`,
            sql`length(${axisKey}) BETWEEN 1 AND 120`,
            sql`length(${productOptionValues.normalizedValue}) >= 1`,
        ));
}

function facetRefreshStatements(db: Database, kind: "product" | "sku", ids: readonly string[]): SQLiteBatchItem[] {
    return [
        db.delete(productFacetValues)
            .where(productIdColumnScope(sql`${productFacetValues.productId}`, kind, ids)),
        // DO NOTHING: two option axes whose names normalise to one key
        // ("Screen size", "screen-size") keep the first row instead of
        // failing the merchant's write.
        db.insert(productFacetValues)
            .select(selectLiveAttributeFacetRows(
                db,
                productIdColumnScope(sql`${productAttributeValues.productId}`, kind, ids),
            ) as never)
            .onConflictDoNothing(),
        db.insert(productFacetValues)
            .select(selectLiveOptionFacetRows(
                db,
                productIdColumnScope(sql`${productVariants.productId}`, kind, ids),
            ) as never)
            .onConflictDoNothing(),
    ];
}

function refreshStatementsForIds(
    db: Database,
    kind: "product" | "sku",
    ids: readonly string[],
    options: CatalogProjectionRefreshOptions,
): SQLiteBatchItem[] {
    const statements: SQLiteBatchItem[] = [];
    for (const chunk of chunks(uniqueIds(ids), CATALOG_PROJECTION_PRODUCTS_PER_CALL)) {
        if (options.facets !== false) statements.push(...facetRefreshStatements(db, kind, chunk));
        statements.push(buyerStateUpsert(db, productScopeCondition(kind, chunk)));
    }
    return statements;
}

/**
 * Statements that recompute both projections for the given products. Append
 * them to the batch that writes the products, after its SKU, ledger and CAS
 * statements; they read that batch's own writes. At most 90 products per
 * statement group; a product that no longer exists writes nothing.
 */
export function catalogProjectionRefreshStatements(
    db: Database,
    productIds: readonly string[],
    options: CatalogProjectionRefreshOptions = {},
): SQLiteBatchItem[] {
    return refreshStatementsForIds(db, "product", productIds, options);
}

/**
 * Buyer-state refresh for the products of the given SKUs, for stock writes
 * that know only SKU ids. Facet rows are left alone (stock never changes them).
 */
export function catalogBuyerStateRefreshStatementsForSkus(
    db: Database,
    skuIds: readonly string[],
): SQLiteBatchItem[] {
    return refreshStatementsForIds(db, "sku", skuIds, { facets: false });
}

export interface CatalogProjectionRebuildResult {
    processed: number;
    nextAfterProductId: string | null;
    done: boolean;
}

/**
 * Recomputes both projections for the next `limit` products after
 * `afterProductId` (id order), in sequential batches of 90. Returns the
 * cursor for the next call; `done` once the last product is covered.
 */
export async function rebuildCatalogProjections(
    db: Database,
    input: { afterProductId?: string | null; limit?: number } = {},
): Promise<CatalogProjectionRebuildResult> {
    const limit = Math.min(
        Math.max(Math.trunc(input.limit ?? CATALOG_PROJECTION_REBUILD_DEFAULT_LIMIT), 1),
        CATALOG_PROJECTION_REBUILD_MAX_LIMIT,
    );
    let after = input.afterProductId ?? null;
    let processed = 0;
    while (processed < limit) {
        const pageSize = Math.min(CATALOG_PROJECTION_PRODUCTS_PER_CALL, limit - processed);
        const rows = await db
            .select({ id: products.id })
            .from(products)
            .where(after === null ? undefined : gt(products.id, after))
            .orderBy(asc(products.id))
            .limit(pageSize)
            .all();
        if (rows.length === 0) return { processed, nextAfterProductId: null, done: true };
        const ids = rows.map((row) => row.id);
        await safeBatch(db, catalogProjectionRefreshStatements(db, ids) as never);
        processed += ids.length;
        after = ids[ids.length - 1]!;
        if (rows.length < pageSize) return { processed, nextAfterProductId: null, done: true };
    }
    return { processed, nextAfterProductId: after, done: false };
}
