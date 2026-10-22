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
// action heal drift and fill them the first time. The per-write facet refresh
// rewrites only the rows that differ, so the cache dependency triggers fire
// only for real changes; the rebuild runs its batches in coarse mode.
//
// The SQL is single-sourced: the buyer pricing projection
// (`buildBuyerCatalogPricingProjection`) and the public eligibility predicate
// (`publicProductHasBuyerResolvableSku`) are the same expressions the live
// catalogue reads used, scoped to at most 90 products per statement through
// one `json_each` parameter.
import {
    attributeValues,
    cacheClock,
    productAttributeValues,
    productAttributes,
    productBuyerState,
    productFacetValues,
    productFacetPublicCounts,
    productFacetScopeCounts,
    productOptionDefinitions,
    productOptionValues,
    productVariantOptionValues,
    products,
    productVariants,
} from "@scalius/database/schema";
import { chunkForD1, type Database, safeBatch } from "@scalius/database/client";
import { advanceCacheDeps } from "@scalius/database/cache-dep-writes";
import { facetScopeCountsSelect } from "@scalius/database/derived-projections";
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, eq, gt, isNull, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { OPTION_FACET_KEY_PREFIX } from "@scalius/shared/catalog-attributes";
import { buildBuyerCatalogPricingProjection } from "./buyer-projection";
import { publicProductHasBuyerResolvableSku } from "./public-eligibility";
import { channelAvailableStockSql, productPublishedToChannelSql } from "./channel-publications";
import { storeDefaultLowStockThresholdSql } from "./low-stock-policy";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** Products per refresh statement group: the D1 enrichment bound. */
export const CATALOG_PROJECTION_PRODUCTS_PER_CALL = 90;
/** Products one rebuild call recomputes (sequential batches of 90). */
export const CATALOG_PROJECTION_REBUILD_DEFAULT_LIMIT = 900;
export const CATALOG_PROJECTION_REBUILD_MAX_LIMIT = 2_700;

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

/**
 * Which products a refresh covers: `on(column)` is the condition on a column
 * holding a product id; `pricing` scopes the buyer pricing projection
 * (undefined ranks every SKU once, which is what a whole-store fill wants).
 */
interface ProductScope {
    on(column: SQL): SQL;
    pricing: SQL | undefined;
}

/** The products named by ids (or by their SKUs' ids), as one bound JSON parameter. */
function idScope(kind: "product" | "sku", ids: readonly string[]): ProductScope {
    const idSet = sql`(SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`;
    const on = (column: SQL) => kind === "product"
        ? sql`${column} IN ${idSet}`
        : sql`${column} IN (
            SELECT scope_sku.product_id FROM product_variants AS scope_sku
            WHERE scope_sku.id IN ${idSet}
        )`;
    return { on, pricing: on(sql`${products.id}`) };
}

/**
 * Every product. `1 = 1` (not an empty WHERE): an INSERT ... SELECT ... ON
 * CONFLICT needs a WHERE for SQLite to parse, and PostgreSQL wants a boolean.
 */
const EVERY_PRODUCT: ProductScope = { on: () => sql`1 = 1`, pricing: undefined };

/**
 * The live buyer state of the scoped products, in `product_buyer_state`
 * column order. Used by the refresh insert and by drift checks.
 *
 * - `is_public`: active, not trashed, published to the online store, a
 *   buyer-resolvable SKU topology (the storefront's own predicate) and a
 *   priced card SKU.
 * - `sku_id`, `from/to/base_minor`, `has_discount`, `available_for_sale`,
 *   `has_customer_options`: the buyer pricing projection's card row.
 * - `discount_depth_bps`: (base - from) / base of the card SKU, the
 *   listing's "discount" sort.
 * - `availability_band`: the card SKU's band (its own low-stock level, else
 *   the store default), as `resolveBuyerAvailabilityBand`, over the units
 *   the online store sells (its linked locations).
 */
/**
 * The stored availability band of a card SKU (an aliased `product_variants`
 * row; a missing row is out of stock): its own low-stock level, else the
 * store default, over the units the online store sells.
 */
function cardAvailabilityBandSql(cardSku: ReturnType<typeof alias<typeof productVariants, string>>): SQL<string> {
    const available = channelAvailableStockSql({
        id: sql`${cardSku.id}`,
        stock: sql`${cardSku.stock}`,
        reservedStock: sql`${cardSku.reservedStock}`,
    });
    const threshold = sql`COALESCE(${cardSku.lowStockThreshold}, ${storeDefaultLowStockThresholdSql()})`;
    return sql<string>`CASE
                WHEN ${cardSku.id} IS NULL THEN 'out_of_stock'
                WHEN ${cardSku.trackInventory} = 0 THEN 'untracked'
                WHEN ${available} <= 0 THEN 'out_of_stock'
                WHEN ${threshold} > 0 AND ${available} <= ${threshold} THEN 'low_stock'
                ELSE 'in_stock'
            END`;
}

export function selectLiveCatalogBuyerState(db: Database, scope: SQL, pricingScope: SQL | undefined = scope) {
    const pricing = buildBuyerCatalogPricingProjection(db, { productScope: pricingScope });
    const cardSku = alias(productVariants, "buyer_state_card_sku");
    const effective = sql`${pricing.effectivePriceMinor}`;
    return db
        .select({
            productId: products.id,
            isPublic: sql<number>`CASE
                WHEN ${products.isActive} = 1
                  AND ${products.deletedAt} IS NULL
                  AND ${pricing.skuId} IS NOT NULL
                  AND ${productPublishedToChannelSql(sql`${products.id}`)}
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
            availabilityBand: cardAvailabilityBandSql(cardSku).as("buyer_state_availability_band"),
            refreshedAt: sql<number>`unixepoch()`.as("buyer_state_refreshed_at"),
        })
        .from(products)
        .leftJoin(pricing, eq(pricing.productId, products.id))
        .leftJoin(cardSku, eq(cardSku.id, pricing.skuId))
        .where(scope);
}

/** The buyer-state columns a refresh writes (`refreshed_at` keeps its insert default; nothing reads it). */
const BUYER_STATE_COLUMNS = [
    ["isPublic", "is_public"],
    ["categoryId", "category_id"],
    ["brandId", "brand_id"],
    ["productCreatedAt", "product_created_at"],
    ["skuId", "sku_id"],
    ["fromMinor", "from_minor"],
    ["toMinor", "to_minor"],
    ["baseMinor", "base_minor"],
    ["discountDepthBps", "discount_depth_bps"],
    ["hasDiscount", "has_discount"],
    ["availableForSale", "available_for_sale"],
    ["hasCustomerOptions", "has_customer_options"],
    ["availabilityBand", "availability_band"],
] as const;

/**
 * Inserts or updates the scoped products' buyer state, writing a row only
 * when a column differs (null-safe `IS NOT`; `IS DISTINCT FROM` on
 * PostgreSQL): an unchanged product costs a read, not a billed row write.
 */
function buyerStateUpsert(db: Database, scope: ProductScope): SQLiteBatchItem {
    const excluded = (column: string) => sql.raw(`excluded.${column}`);
    const changed = sql.join(
        BUYER_STATE_COLUMNS.map(([, column]) => sql.raw(`product_buyer_state.${column} IS NOT excluded.${column}`)),
        sql` OR `,
    );
    return db
        .insert(productBuyerState)
        .select(selectLiveCatalogBuyerState(db, scope.on(sql`${products.id}`), scope.pricing) as never)
        .onConflictDoUpdate({
            target: productBuyerState.productId,
            set: Object.fromEntries(BUYER_STATE_COLUMNS.map(([key, column]) => [key, excluded(column)])),
            setWhere: sql`${changed}`,
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
 * keyed `option.<axis key>` like the storefront's option filters. A gift
 * card's denominations are not a catalogue property, so they never become a
 * store-wide filter ("Amount: 500, 1000, 2500" beside Colour and Size).
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
            sql`NOT EXISTS (SELECT 1 FROM ${products} AS gift_card_product WHERE gift_card_product.id = ${productVariants.productId} AND gift_card_product.is_gift_card = 1)`,
            sql`length(${axisKey}) BETWEEN 1 AND 120`,
            sql`length(${productOptionValues.normalizedValue}) >= 1`,
        ));
}

function facetRefreshStatements(db: Database, scope: ProductScope): SQLiteBatchItem[] {
    return [
        db.delete(productFacetValues)
            .where(scope.on(sql`${productFacetValues.productId}`)),
        // DO NOTHING: two option axes whose names normalise to one key
        // ("Screen size", "screen-size") keep the first row instead of
        // failing the merchant's write.
        db.insert(productFacetValues)
            .select(selectLiveAttributeFacetRows(db, scope.on(sql`${productAttributeValues.productId}`)) as never)
            .onConflictDoNothing(),
        db.insert(productFacetValues)
            .select(selectLiveOptionFacetRows(db, scope.on(sql`${productVariants.productId}`)) as never)
            .onConflictDoNothing(),
    ];
}

/**
 * The per-write facet refresh: deletes only the stored rows that no live row
 * equals, then inserts the live rows that are missing. Rows that did not
 * change are neither deleted nor rewritten, so a product save whose facets
 * are unchanged fires no cache dependency trigger on them (migration 0100).
 * `EXCEPT` compares every column with NULLs equal, on SQLite and PostgreSQL.
 */
function facetDiffRefreshStatements(db: Database, scope: ProductScope): SQLiteBatchItem[] {
    const stored = db
        .select({
            ownerId: productFacetValues.ownerId,
            productId: productFacetValues.productId,
            variantId: productFacetValues.variantId,
            facetKind: productFacetValues.facetKind,
            facetKey: productFacetValues.facetKey,
            valueKey: productFacetValues.valueKey,
            valueLabel: productFacetValues.valueLabel,
            valueNumber: productFacetValues.valueNumber,
            sortOrder: productFacetValues.sortOrder,
        })
        .from(productFacetValues)
        .where(scope.on(sql`${productFacetValues.productId}`));
    const liveAttributes = selectLiveAttributeFacetRows(db, scope.on(sql`${productAttributeValues.productId}`));
    const liveOptions = selectLiveOptionFacetRows(db, scope.on(sql`${productVariants.productId}`));
    const stale = stored.except(liveAttributes as never).except(liveOptions as never);
    return [
        db.delete(productFacetValues).where(and(
            scope.on(sql`${productFacetValues.productId}`),
            sql`(${productFacetValues.ownerId}, ${productFacetValues.facetKey}) IN (
                SELECT stale.owner_id, stale.facet_key FROM ${stale} AS stale
            )`,
        )),
        db.insert(productFacetValues)
            .select(selectLiveAttributeFacetRows(db, scope.on(sql`${productAttributeValues.productId}`)) as never)
            .onConflictDoNothing(),
        db.insert(productFacetValues)
            .select(selectLiveOptionFacetRows(db, scope.on(sql`${productVariants.productId}`)) as never)
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
    for (const chunk of chunkForD1(uniqueIds(ids), CATALOG_PROJECTION_PRODUCTS_PER_CALL)) {
        const scope = idScope(kind, chunk);
        if (options.facets !== false) statements.push(...facetDiffRefreshStatements(db, scope));
        statements.push(buyerStateUpsert(db, scope));
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

/**
 * Both projections for every product at once: the statements of the
 * migration that fills them when the tables arrive (0091, generated from this
 * function by `packages/core/scripts/catalog-projection-fill.ts`), so a store
 * never serves empty listings between the migration and a rebuild. The
 * request path and the rebuild use the scoped statements above; these read
 * the whole catalogue in one pass each.
 */
export function catalogProjectionFillStatements(db: Database): SQLiteBatchItem[] {
    return [...facetRefreshStatements(db, EVERY_PRODUCT), buyerStateUpsert(db, EVERY_PRODUCT)];
}

/**
 * One read-only statement: the products among `productIds` (at most 90)
 * whose stored projections differ from what their sources give now, in
 * either direction (a stored buyer row or facet row that the live projection
 * does not reproduce, or a live one that is not stored).
 */
const FACET_COLUMNS = "owner_id, product_id, variant_id, facet_kind, facet_key, value_key, value_label, value_number, sort_order";

function driftedProductsStatement(db: Database, after: string | null, size: number): SQL {
    // The window: the next `size` product ids, an index range read where it is used.
    const window = sql`(SELECT drift_window.id FROM products AS drift_window
        WHERE ${after === null ? sql`1 = 1` : sql`drift_window.id > ${after}`}
        ORDER BY drift_window.id LIMIT ${sql.raw(String(Math.trunc(size)))})`;
    const scope: ProductScope = { on: (column) => sql`${column} IN ${window}`, pricing: sql`${products.id} IN ${window}` };
    const live = selectLiveCatalogBuyerState(db, scope.on(sql`${products.id}`), scope.pricing);
    const liveFacets = selectLiveAttributeFacetRows(db, scope.on(sql`${productAttributeValues.productId}`))
        .union(selectLiveOptionFacetRows(db, scope.on(sql`${productVariants.productId}`)) as never);
    // The live selects name their columns after their sources (two are
    // `id`), so each CTE names them by position; each projection is read
    // once (two copies of the live buyer state pass D1's 100 KB statement
    // limit). `refreshed_at` is the live select's clock, never compared.
    const buyerColumns = BUYER_STATE_COLUMNS.map(([, column]) => column).join(", ");
    return sql`WITH drift_live_rows (product_id, ${sql.raw(buyerColumns)}, refreshed_at) AS (${live.getSQL()}),
            drift_live_facets (${sql.raw(FACET_COLUMNS)}) AS (${liveFacets.getSQL()}),
            drift_stored_rows AS (SELECT product_id, ${sql.raw(buyerColumns)} FROM product_buyer_state
                WHERE ${scope.on(sql.raw("product_buyer_state.product_id"))}),
            drift_stored_facets AS (SELECT ${sql.raw(FACET_COLUMNS)} FROM product_facet_values
                WHERE ${scope.on(sql.raw("product_facet_values.product_id"))})
        SELECT 'drift' AS kind, drifted.product_id AS product_id, 0 AS products FROM (
            SELECT buyer_missing.product_id FROM (
                SELECT product_id, ${sql.raw(buyerColumns)} FROM drift_live_rows
                EXCEPT SELECT * FROM drift_stored_rows) AS buyer_missing
            UNION SELECT buyer_stale.product_id FROM (
                SELECT * FROM drift_stored_rows
                EXCEPT SELECT product_id, ${sql.raw(buyerColumns)} FROM drift_live_rows) AS buyer_stale
            UNION SELECT facet_missing.product_id FROM (
                SELECT * FROM drift_live_facets EXCEPT SELECT * FROM drift_stored_facets) AS facet_missing
            UNION SELECT facet_stale.product_id FROM (
                SELECT * FROM drift_stored_facets EXCEPT SELECT * FROM drift_live_facets) AS facet_stale
        ) AS drifted
        UNION ALL SELECT 'window', max(window_end.id), count(*) FROM ${window} AS window_end`;
}

export interface CatalogProjectionDriftResult {
    /** Products compared. */
    checked: number;
    /** Products whose stored projections were wrong; they are now repaired. */
    repaired: string[];
    nextAfterProductId: string | null;
    done: boolean;
}

/**
 * A drift check of the next `limit` products after `afterProductId` (id
 * order): one read-only comparison per 90 products, and a repair batch only
 * for the products that differ. Cheaper than a rebuild (nothing is written
 * where nothing drifted, and the public facet counts are not recounted), so
 * a nightly pass can visit a bounded window and request a full rebuild only
 * when it finds drift.
 */
export async function checkCatalogProjectionDrift(
    db: Database,
    input: { afterProductId?: string | null; limit: number },
): Promise<CatalogProjectionDriftResult> {
    const limit = Math.max(1, Math.trunc(input.limit));
    let after = input.afterProductId ?? null;
    let checked = 0;
    const repaired: string[] = [];
    while (checked < limit) {
        const pageSize = Math.min(CATALOG_PROJECTION_PRODUCTS_PER_CALL, limit - checked);
        type Row = { kind: string; product_id: string | null; products: number };
        const rows = (await db.all<Row | [string, string | null, number]>(driftedProductsStatement(db, after, pageSize)))
            .map((row): Row => (Array.isArray(row) ? { kind: row[0], product_id: row[1], products: Number(row[2]) } : row));
        const window = rows.find((row) => row.kind === "window");
        const size = Number(window?.products ?? 0);
        if (!window?.product_id || size === 0) return { checked, repaired, nextAfterProductId: null, done: true };
        const drifted = rows.filter((row) => row.kind === "drift" && typeof row.product_id === "string").map((row) => row.product_id!);
        if (drifted.length > 0) {
            // Precise keys: only the drifted products' pages change.
            await safeBatch(db, catalogProjectionRefreshStatements(db, drifted) as never);
            repaired.push(...drifted);
        }
        checked += size;
        after = window.product_id;
        if (size < pageSize) return { checked, repaired, nextAfterProductId: null, done: true };
    }
    return { checked, repaired, nextAfterProductId: after, done: false };
}

/**
 * The projection's definition as text: the SQL of one product's refresh.
 * A deploy whose definition is unchanged cannot have left drift behind
 * (the previous version wrote the same projection in the same batches), so
 * the post-deploy rebuild runs only when this text changes.
 */
export function catalogProjectionDefinition(db: Database): string {
    return catalogProjectionRefreshStatements(db, ["prod_definition"])
        .map((statement) => (statement as unknown as { toSQL(): { sql: string } }).toSQL().sql)
        .join(";\n");
}

/** Products one band refresh statement covers (a primary-key probe of the card SKU each). */
export const CATALOG_BAND_REFRESH_MAX_LIMIT = 5_000;

/**
 * Recomputes only the stored availability band of the next `limit` products
 * after `afterProductId` (up to `untilProductId`), from each product's stored
 * card SKU: the lap a store-wide band input (the default low-stock level)
 * needs, instead of a full rebuild. One id read and one batch per call; a
 * row is written only when its band differs, and the batch runs in coarse
 * mode (a changed band advances `store` once).
 */
export async function refreshCatalogAvailabilityBands(
    db: Database,
    input: { afterProductId?: string | null; untilProductId?: string | null; limit: number },
): Promise<CatalogProjectionRebuildResult> {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), CATALOG_BAND_REFRESH_MAX_LIMIT);
    const after = input.afterProductId ?? null;
    const until = input.untilProductId ?? null;
    const rows = await db
        .select({ id: productBuyerState.productId })
        .from(productBuyerState)
        .where(and(
            after === null ? undefined : gt(productBuyerState.productId, after),
            until === null ? undefined : lte(productBuyerState.productId, until),
        ))
        .orderBy(asc(productBuyerState.productId))
        .limit(limit)
        .all();
    if (rows.length === 0) return { processed: 0, nextAfterProductId: null, done: true };
    const first = rows[0]!.id;
    const last = rows[rows.length - 1]!.id;
    const cardSku = alias(productVariants, "band_card_sku");
    // Qualified: an update renders its own columns bare, and the card SKU has a `product_id` too.
    const band = sql`(SELECT ${cardAvailabilityBandSql(cardSku)}
        FROM (SELECT 1) AS band_probe
        LEFT JOIN "product_variants" AS "band_card_sku" ON ${cardSku.id} = "product_buyer_state"."sku_id"
            AND ${cardSku.productId} = "product_buyer_state"."product_id")`;
    await safeBatch(db, [
        db.update(cacheClock).set({ coarse: 1 }).where(eq(cacheClock.id, 1)),
        db.update(productBuyerState)
            .set({ availabilityBand: band as never })
            .where(and(
                sql`"product_buyer_state"."product_id" BETWEEN ${first} AND ${last}`,
                // The band is never NULL, so `<>` is null-safe here on every provider.
                sql`"product_buyer_state"."availability_band" <> ${band}`,
            )),
        db.update(cacheClock).set({ coarse: 0 }).where(eq(cacheClock.id, 1)),
    ] as never);
    return rows.length < limit
        ? { processed: rows.length, nextAfterProductId: null, done: true }
        : { processed: rows.length, nextAfterProductId: last, done: false };
}

export interface CatalogProjectionRebuildResult {
    processed: number;
    nextAfterProductId: string | null;
    done: boolean;
}

/**
 * Recomputes both projections for the next `limit` products after
 * `afterProductId` (id order), in sequential batches of 90, up to and
 * including `untilProductId` when given. Returns the cursor for the next
 * call; `done` once the last product of the range is covered.
 *
 * `repairFacetCounts` (default: when the walk starts at the first product)
 * first recounts `product_facet_public_counts` from the facet rows: one scan
 * of every facet row, so a rebuild lap does it once, at its start.
 */
export async function rebuildCatalogProjections(
    db: Database,
    input: { afterProductId?: string | null; untilProductId?: string | null; limit?: number; repairFacetCounts?: boolean } = {},
): Promise<CatalogProjectionRebuildResult> {
    const limit = Math.min(
        Math.max(Math.trunc(input.limit ?? CATALOG_PROJECTION_REBUILD_DEFAULT_LIMIT), 1),
        CATALOG_PROJECTION_REBUILD_MAX_LIMIT,
    );
    let after = input.afterProductId ?? null;
    const until = input.untilProductId ?? null;
    if (input.repairFacetCounts ?? after === null) {
        // Repair the derived counters before any facet deletion can apply a
        // negative delta to a drifted count. Only the initial full-rebuild
        // call scans the existing projections; ordinary refreshes stay local.
        const counts = db.select({
            facetKind: productFacetValues.facetKind,
            facetKey: productFacetValues.facetKey,
            valueKey: productFacetValues.valueKey,
            productCount: sql<number>`count(DISTINCT ${productFacetValues.productId})`.as("product_count"),
        }).from(productFacetValues)
            .innerJoin(productBuyerState, eq(productBuyerState.productId, productFacetValues.productId))
            .where(eq(productBuyerState.isPublic, true))
            .groupBy(productFacetValues.facetKind, productFacetValues.facetKey, productFacetValues.valueKey);
        await safeBatch(db, [
            // Drifted counts change public facets: advance `store` once.
            advanceCacheDeps(db, ["store"], {
                with: sql`expected AS MATERIALIZED (${counts.getSQL()})`,
                when: sql`EXISTS (
                    SELECT * FROM expected EXCEPT
                    SELECT facet_kind, facet_key, value_key, product_count FROM product_facet_public_counts WHERE product_count > 0
                ) OR EXISTS (
                    SELECT facet_kind, facet_key, value_key, product_count FROM product_facet_public_counts WHERE product_count > 0
                    EXCEPT SELECT * FROM expected
                )`,
            }),
            db.delete(productFacetPublicCounts),
            db.insert(productFacetPublicCounts).select(counts),
            // The per-category and per-brand counts (0174), the same way.
            advanceCacheDeps(db, ["store"], {
                with: sql`expected_scope AS MATERIALIZED (${sql.raw(facetScopeCountsSelect)})`,
                // The counts alone: a kept sample is any product of the scope with the value.
                when: sql`EXISTS (
                    SELECT scope_kind, scope_id, facet_kind, facet_key, value_key, product_count FROM expected_scope EXCEPT
                    SELECT scope_kind, scope_id, facet_kind, facet_key, value_key, product_count FROM product_facet_scope_counts WHERE product_count > 0
                ) OR EXISTS (
                    SELECT scope_kind, scope_id, facet_kind, facet_key, value_key, product_count FROM product_facet_scope_counts WHERE product_count > 0
                    EXCEPT SELECT scope_kind, scope_id, facet_kind, facet_key, value_key, product_count FROM expected_scope
                )`,
            }),
            db.delete(productFacetScopeCounts),
            db.insert(productFacetScopeCounts).select(sql.raw(facetScopeCountsSelect) as never),
        ] as never);
    }
    let processed = 0;
    while (processed < limit) {
        const pageSize = Math.min(CATALOG_PROJECTION_PRODUCTS_PER_CALL, limit - processed);
        const rows = await db
            .select({ id: products.id })
            .from(products)
            .where(and(
                after === null ? undefined : gt(products.id, after),
                until === null ? undefined : lte(products.id, until),
            ))
            .orderBy(asc(products.id))
            .limit(pageSize)
            .all();
        if (rows.length === 0) return { processed, nextAfterProductId: null, done: true };
        const ids = rows.map((row) => row.id);
        // Coarse: inside this batch every cache dependency trigger advances
        // `store` once per fire instead of each product's keys (migration
        // 0100); a rebuild that finds no drift writes no key at all. The flag
        // is set and cleared in the same transaction, so no other write sees it.
        await safeBatch(db, [
            db.update(cacheClock).set({ coarse: 1 }).where(eq(cacheClock.id, 1)),
            ...catalogProjectionRefreshStatements(db, ids),
            db.update(cacheClock).set({ coarse: 0 }).where(eq(cacheClock.id, 1)),
        ] as never);
        processed += ids.length;
        after = ids[ids.length - 1]!;
        if (rows.length < pageSize) return { processed, nextAfterProductId: null, done: true };
    }
    return { processed, nextAfterProductId: after, done: false };
}
