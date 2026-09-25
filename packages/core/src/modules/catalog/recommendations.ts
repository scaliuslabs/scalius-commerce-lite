// Ranked product recommendations for the product page, cart, search dead
// ends, 404 and order confirmation.
//
// One ranking statement scores every public, buyable product against the
// source products with the signals the store really has:
//   1. also bought — other products in the same real orders (placed, not
//      cancelled/refunded/returned/unfinished) within a year, counted by
//      distinct buyer phone; two or more buyers rank a product first;
//   2. similarity — same published category, same active collection (manual
//      list or dynamic category rule), shared attribute values, and an
//      effective buyer price within 60–140% of the source price band;
//   3. popularity — distinct buyers in the last 30 days, used only when enough
//      of the list can be filled that way, otherwise newest first.
// Ties break by newest then id, so the order is deterministic. Card images
// come from one bounded media read, so a call is two statements.
//
// Candidates are the stored buyer state's public, buyable products
// (buyer-state.ts), so the statement never evaluates eligibility or ranks
// SKUs per product.
//
// Precomputed (Design B): a single product's list (the product page) is read
// from its stored `product_recommendations` rows (up to 24, written off the
// request path by recommendation-refresh.ts), filtered to products still
// public and buyable. The live ranking runs on the request path only for a
// product never computed and for multi-product sources (cart, order
// confirmation) or none (404, search dead ends).
//
// Freshness: responses ride the public API cache keyed by the store cache
// generation. Placing an order does not bump the generation by itself, so
// also-bought and popularity rankings refresh with the next buyer-visible
// write (stock band change, catalog edit) or the one-day cache ceiling.
import { productRecommendations, products } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { unixToDate } from "@scalius/shared/utils";
import {
    effectivePriceMinorSql,
    presentBuyerPricing,
    storeCurrencyCodeSql,
    storeDecimalPlacesFromCode,
} from "../products/money";
import { operationalSkuRowPredicate } from "../products/public-eligibility";
import { loadProductMediaProjections, resolveProductCardImages } from "../products/media";
import {
    buyerState,
    buyerStateCardSku,
    buyerStatePricingSelection,
    publicBuyerStateCondition,
} from "./buyer-state";

export const MAX_RECOMMENDATION_SOURCE_IDS = 20;
export const MAX_RECOMMENDATION_LIMIT = 12;
export const DEFAULT_RECOMMENDATION_LIMIT = 8;
/** Rows stored per product (`product_recommendations` positions 0-23). */
export const STORED_RECOMMENDATION_LIMIT = 24;

/** Distinct buyers who bought a product with the source before "Customers also bought" is claimed. */
export const MIN_ALSO_BOUGHT_BUYERS = 2;
/** Distinct buyers in the popularity window before a product counts as popular. */
export const MIN_POPULAR_BUYERS = 2;
const ALSO_BOUGHT_WINDOW_SECONDS = 365 * 86_400;
const POPULAR_WINDOW_SECONDS = 30 * 86_400;

/**
 * Orders a buyer placed and kept. Pending COD orders count; unfinished hosted
 * payments (`incomplete`), cancellations, refunds and returns do not.
 */
const REAL_ORDER_STATUSES_SQL = "('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed')";

export type ProductRecommendationReason = "also_bought" | "similar" | "popular" | "new_arrivals";

export interface ProductRecommendationItem {
    id: string;
    name: string;
    slug: string;
    price: number;
    discountType: string | null;
    discountPercentage: number;
    discountAmount: number;
    discountedPrice: number;
    priceVaries: boolean;
    freeDelivery: boolean;
    categoryId: string | null;
    hasVariants: boolean;
    availableForSale: boolean;
    imageUrl: string | null;
    imageMediaId: string | null;
    imageAlt: string | null;
    secondaryImageUrl: string | null;
    createdAt: string | null;
}

export interface ProductRecommendations {
    /**
     * What the list mostly is, so the storefront can title it honestly:
     * `also_bought` ("Customers also bought") only when at least half the list
     * is real co-purchase data; `similar` ("You might also like"); and for
     * lists without source products `popular` or `new_arrivals`.
     */
    reason: ProductRecommendationReason;
    products: ProductRecommendationItem[];
}

export interface ProductRecommendationInput {
    productIds?: readonly string[];
    limit?: number;
}

export function normalizeRecommendationSourceIds(ids: readonly string[] | string | undefined): string[] {
    const list = typeof ids === "string" ? ids.split(",") : ids ?? [];
    return Array.from(new Set(
        list.map((id) => id.trim()).filter((id) => id.length > 0 && id.length <= 180),
    )).slice(0, MAX_RECOMMENDATION_SOURCE_IDS);
}

function normalizeLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_RECOMMENDATION_LIMIT;
    return Math.min(Math.max(Math.trunc(limit), 1), MAX_RECOMMENDATION_LIMIT);
}

function realOrder(alias: string): SQL {
    return sql.raw(`${alias}.status IN ${REAL_ORDER_STATUSES_SQL} AND ${alias}.deleted_at IS NULL`);
}

/** A stored collection id list, or an empty list for a malformed config (json_each fails closed on Postgres). */
function collectionIdList(configColumn: string, key: "productIds" | "categoryIds"): SQL {
    return sql.raw(`json_each(CASE WHEN json_valid(${configColumn}) THEN CASE WHEN json_type(${configColumn}, '$.${key}') = 'array' THEN ${configColumn} ELSE '{"${key}":[]}' END ELSE '{"${key}":[]}' END, '$.${key}')`);
}

function activeCollectionSql(collection: string, dynamic: boolean): string {
    const source = `COALESCE(CASE WHEN json_valid(${collection}.config) THEN json_extract(${collection}.config, '$.source') END, 'manual')`;
    return `${collection}.is_active = 1 AND ${collection}.deleted_at IS NULL AND ${source} ${dynamic ? "=" : "<>"} 'dynamic'`;
}

/**
 * Every (collection, product) membership of the given active collections,
 * manual or dynamic. The CROSS JOINs fix the join order (SQLite never
 * reorders across them): collection, then its rules, then the rule's
 * category, then that category's products. Left to the planner, it started
 * from every published category and every product in the store and parsed
 * each collection's rules once per product (1.3 s at 30k products).
 */
function collectionMembersSql(prefix: string, collectionIds: SQL): SQL {
    const collection = `${prefix}_collection`;
    const manual = `${prefix}_manual`;
    const categoryRule = `${prefix}_rule`;
    const product = `${prefix}_product`;
    const category = `${prefix}_category`;
    return sql.raw(`
        SELECT ${collection}.id AS collection_id, CAST(${manual}.value AS TEXT) AS product_id
        FROM collections AS ${collection}
        CROSS JOIN `).append(collectionIdList(`${collection}.config`, "productIds")).append(sql.raw(` AS ${manual}
        WHERE ${activeCollectionSql(collection, false)} AND ${collection}.id IN `)).append(collectionIds).append(sql.raw(`
        UNION ALL
        SELECT ${collection}.id AS collection_id, ${product}.id AS product_id
        FROM collections AS ${collection}
        CROSS JOIN `)).append(collectionIdList(`${collection}.config`, "categoryIds")).append(sql.raw(` AS ${categoryRule}
        CROSS JOIN categories AS ${category}
        CROSS JOIN products AS ${product}
        WHERE ${activeCollectionSql(collection, true)} AND ${collection}.id IN `)).append(collectionIds).append(sql.raw(`
          AND ${category}.id = CAST(${categoryRule}.value AS TEXT)
          AND ${category}.status = 'published'
          AND ${category}.deleted_at IS NULL
          AND ${product}.category_id = ${category}.id
    `));
}

/**
 * The active collections that contain any source product, found without
 * expanding any collection: manual lists name the product, dynamic rules
 * name its published category.
 */
function sourceCollectionIdsSql(sourceSet: SQL): SQL {
    return sql`(
        SELECT rec_source_collection.id
        FROM collections AS rec_source_collection
        CROSS JOIN ${collectionIdList("rec_source_collection.config", "productIds")} AS rec_source_manual
        WHERE ${sql.raw(activeCollectionSql("rec_source_collection", false))}
          AND CAST(rec_source_manual.value AS TEXT) IN ${sourceSet}
        UNION
        SELECT rec_source_collection.id
        FROM collections AS rec_source_collection
        CROSS JOIN ${collectionIdList("rec_source_collection.config", "categoryIds")} AS rec_source_rule
        WHERE ${sql.raw(activeCollectionSql("rec_source_collection", true))}
          AND CAST(rec_source_rule.value AS TEXT) IN (
              SELECT rec_source_product.category_id
              FROM products AS rec_source_product
              CROSS JOIN categories AS rec_source_category
              WHERE rec_source_product.id IN ${sourceSet}
                AND rec_source_category.id = rec_source_product.category_id
                AND rec_source_category.status = 'published'
                AND rec_source_category.deleted_at IS NULL
          )
    )`;
}

type RecommendationCardRow = {
    id: string;
    name: string;
    slug: string;
    basePriceMinor: number;
    discountType: string | null;
    discountBps: number;
    discountAmountMinor: number;
    effectivePriceMinor: number;
    maxBuyerPriceMinor: number;
    freeDelivery: boolean;
    categoryId: string | null;
    hasCustomerOptions: number | boolean;
    availableForSale: number | boolean;
    createdAt: number;
    storeCurrencyCode: string | null;
};

/** One ranked product: its id and the signals that placed it (no card columns). */
type RankedRecommendationRow = {
    id: string;
    alsoBoughtBuyers: number;
    relatedScore: number;
    popularBuyers: number;
    popularOrdering: number;
};

export interface RankedRecommendations {
    reason: ProductRecommendationReason;
    rows: RankedRecommendationRow[];
}

/**
 * The ranking statement alone (no images). Bound parameters stay constant
 * regardless of how many source ids are passed: the id set is one JSON value.
 */
export async function rankProductRecommendations(
    db: Database,
    input: ProductRecommendationInput,
): Promise<RankedRecommendations> {
    const sourceIds = normalizeRecommendationSourceIds(input.productIds);
    const rows = await rankRecommendationRows(db, sourceIds, normalizeLimit(input.limit));
    return { reason: recommendationReason(rows, sourceIds.length > 0), rows };
}

/**
 * The ranking statement for up to `limit` rows (the request path caps it at
 * 12; the refresh job stores 24). It reads only the buyer state and the
 * signal sets: every public product is scored, so card columns (names,
 * prices, the card SKU) are read afterwards for the few rows kept
 * (`loadRecommendationCards`). Internal to the catalog domain.
 */
export async function rankRecommendationRows(
    db: Database,
    sourceIds: readonly string[],
    limit: number,
): Promise<RankedRecommendationRow[]> {
    const sourceJson = JSON.stringify(sourceIds);
    const sourceSet = sql`(SELECT CAST(value AS TEXT) FROM json_each(${sourceJson}))`;

    const coPurchase = sql`(
        SELECT rec_peer_line.product_id AS product_id,
               COUNT(DISTINCT rec_co_order.customer_phone) AS buyers
        FROM order_items AS rec_source_line
        CROSS JOIN orders AS rec_co_order
        CROSS JOIN order_items AS rec_peer_line
        WHERE rec_source_line.product_id IN ${sourceSet}
          AND rec_co_order.id = rec_source_line.order_id
          AND rec_peer_line.order_id = rec_source_line.order_id
          AND rec_peer_line.product_id NOT IN ${sourceSet}
          AND ${realOrder("rec_co_order")}
          AND rec_co_order.created_at >= unixepoch() - ${sql.raw(String(ALSO_BOUGHT_WINDOW_SECONDS))}
        GROUP BY rec_peer_line.product_id
    ) AS rec_co_purchase`;

    const collectionPeers = sql`(
        SELECT rec_member.product_id AS product_id, COUNT(DISTINCT rec_member.collection_id) AS shared
        FROM (${collectionMembersSql("rec_peer", sourceCollectionIdsSql(sourceSet))}) AS rec_member
        GROUP BY rec_member.product_id
    ) AS rec_collection_peer`;

    const attributePeers = sql`(
        SELECT rec_peer_value.product_id AS product_id,
               COUNT(DISTINCT rec_peer_value.attribute_id) AS shared
        FROM product_attribute_values AS rec_source_value
        INNER JOIN product_attributes AS rec_attribute
            ON rec_attribute.id = rec_source_value.attribute_id
           AND rec_attribute.deleted_at IS NULL
        INNER JOIN product_attribute_values AS rec_peer_value
            ON rec_peer_value.attribute_id = rec_source_value.attribute_id
           AND rec_peer_value.value = rec_source_value.value
        WHERE rec_source_value.product_id IN ${sourceSet}
        GROUP BY rec_peer_value.product_id
    ) AS rec_attribute_peer`;

    const popular = sql`(
        SELECT rec_popular_line.product_id AS product_id,
               COUNT(DISTINCT rec_popular_order.customer_phone) AS buyers
        FROM orders AS rec_popular_order
        INNER JOIN order_items AS rec_popular_line ON rec_popular_line.order_id = rec_popular_order.id
        WHERE ${realOrder("rec_popular_order")}
          AND rec_popular_order.created_at >= unixepoch() - ${sql.raw(String(POPULAR_WINDOW_SECONDS))}
        GROUP BY rec_popular_line.product_id
    ) AS rec_popular`;

    const bandPrice = effectivePriceMinorSql({
        priceMinor: sql.raw("rec_band_sku.price_minor"),
        discountType: sql.raw("rec_band_sku.discount_type"),
        discountBps: sql.raw("rec_band_sku.discount_bps"),
        discountAmountMinor: sql.raw("rec_band_sku.discount_amount_minor"),
    }, {
        discountType: sql.raw("rec_band_product.discount_type"),
        discountBps: sql.raw("rec_band_product.discount_bps"),
        discountAmountMinor: sql.raw("rec_band_product.discount_amount_minor"),
    });
    const sourceBand = sql`(
        SELECT MIN(${bandPrice}) AS min_price, MAX(${bandPrice}) AS max_price
        FROM product_variants AS rec_band_sku
        INNER JOIN products AS rec_band_product ON rec_band_product.id = rec_band_sku.product_id
        WHERE rec_band_sku.product_id IN ${sourceSet}
          AND rec_band_sku.deleted_at IS NULL
          AND rec_band_sku.id <> 'default'
          AND ${operationalSkuRowPredicate("rec_band_sku")}
    ) AS rec_source_band`;

    // CROSS JOIN keeps the source products as the driver; the planner
    // otherwise walked every product of every published category.
    const sameCategory = sql`CASE WHEN ${buyerState.categoryId} IN (
        SELECT rec_source_product.category_id
        FROM products AS rec_source_product
        CROSS JOIN categories AS rec_source_category
        WHERE rec_source_product.id IN ${sourceSet}
          AND rec_source_category.id = rec_source_product.category_id
          AND rec_source_category.status = 'published'
          AND rec_source_category.deleted_at IS NULL
    ) THEN 1 ELSE 0 END`;
    const alsoBoughtBuyers = sql<number>`COALESCE(rec_co_purchase.buyers, 0)`;
    const collectionShared = sql`COALESCE(rec_collection_peer.shared, 0)`;
    const attributeShared = sql`COALESCE(rec_attribute_peer.shared, 0)`;
    // Category, collection and attribute evidence, plus a single co-purchase
    // that is too thin to claim "also bought" on its own.
    const relatedScore = sql<number>`(
        40 * ${sameCategory}
        + 25 * MIN(${collectionShared}, 2)
        + 10 * MIN(${attributeShared}, 5)
        + CASE WHEN ${alsoBoughtBuyers} = 1 THEN 20 ELSE 0 END
    )`;
    const inPriceBand = sql`CASE
        WHEN rec_source_band.min_price IS NOT NULL
         AND ${buyerState.fromMinor} * 100 >= rec_source_band.min_price * 60
         AND ${buyerState.fromMinor} * 100 <= rec_source_band.max_price * 140
        THEN 1 ELSE 0
    END`;
    const alsoBoughtTier = sql`CASE WHEN ${alsoBoughtBuyers} >= ${sql.raw(String(MIN_ALSO_BOUGHT_BUYERS))} THEN ${alsoBoughtBuyers} ELSE 0 END`;
    const popularBuyers = sql<number>`COALESCE(rec_popular.buyers, 0)`;
    // Popularity orders the tail only when it can fill at least half the
    // list; otherwise the tail is plainly newest first ("New arrivals").
    const popularOrdering = sql<number>`CASE
        WHEN SUM(CASE WHEN ${popularBuyers} >= ${sql.raw(String(MIN_POPULAR_BUYERS))} THEN 1 ELSE 0 END) OVER () * 2
             >= MIN(COUNT(*) OVER (), ${sql.raw(String(limit))})
         AND ${popularBuyers} >= ${sql.raw(String(MIN_POPULAR_BUYERS))}
        THEN ${popularBuyers} ELSE 0
    END`;
    return await db
        .select({
            id: buyerState.productId,
            alsoBoughtBuyers: alsoBoughtBuyers.as("rec_also_bought_buyers"),
            relatedScore: relatedScore.as("rec_related_score"),
            popularBuyers: popularBuyers.as("rec_popular_buyers"),
            popularOrdering: popularOrdering.as("rec_popular_ordering"),
        })
        .from(buyerState)
        .leftJoin(coPurchase, sql`rec_co_purchase.product_id = ${buyerState.productId}`)
        .leftJoin(collectionPeers, sql`rec_collection_peer.product_id = ${buyerState.productId}`)
        .leftJoin(attributePeers, sql`rec_attribute_peer.product_id = ${buyerState.productId}`)
        .leftJoin(popular, sql`rec_popular.product_id = ${buyerState.productId}`)
        .crossJoin(sourceBand)
        .where(and(
            publicBuyerStateCondition(),
            sql`${buyerState.availableForSale} = 1`,
            sql`${buyerState.productId} NOT IN ${sourceSet}`,
        ))
        .orderBy(
            desc(alsoBoughtTier),
            desc(sql`${relatedScore} + 15 * ${inPriceBand}`),
            desc(popularOrdering),
            desc(buyerState.productCreatedAt),
            buyerState.productId,
        )
        .limit(limit)
        .all() as RankedRecommendationRow[];
}

/** Card columns of the given public products (at most 24 ids, one JSON parameter). */
async function loadRecommendationCards(
    db: Database,
    ids: readonly string[],
): Promise<Map<string, RecommendationCardRow>> {
    if (ids.length === 0) return new Map();
    const cardSku = buyerStateCardSku();
    const rows = await db
        .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            ...buyerStatePricingSelection(cardSku),
            freeDelivery: products.freeDelivery,
            categoryId: products.categoryId,
            hasCustomerOptions: buyerState.hasCustomerOptions,
            availableForSale: buyerState.availableForSale,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`.as("rec_created_at"),
            storeCurrencyCode: storeCurrencyCodeSql().as("rec_store_currency_code"),
        })
        .from(buyerState)
        .innerJoin(products, eq(products.id, buyerState.productId))
        .leftJoin(cardSku, eq(cardSku.id, buyerState.skuId))
        .where(sql`${buyerState.productId} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`)
        .all() as RecommendationCardRow[];
    return new Map(rows.map((row) => [row.id, row]));
}

/** Why one ranked row is on the list, as stored in `product_recommendations.reason`. */
export function recommendationRowReason(row: {
    alsoBoughtBuyers: number;
    relatedScore: number;
    popularOrdering: number;
}): ProductRecommendationReason {
    if (Number(row.alsoBoughtBuyers) >= MIN_ALSO_BOUGHT_BUYERS) return "also_bought";
    if (Number(row.relatedScore) > 0) return "similar";
    if (Number(row.popularOrdering) > 0) return "popular";
    return "new_arrivals";
}

function recommendationReason(
    rows: readonly RankedRecommendationRow[],
    hasSources: boolean,
): ProductRecommendationReason {
    const atLeastHalf = (count: number) => count > 0 && count * 2 >= rows.length;
    const alsoBought = rows.filter((row) => Number(row.alsoBoughtBuyers) >= MIN_ALSO_BOUGHT_BUYERS).length;
    if (hasSources && atLeastHalf(alsoBought)) return "also_bought";
    const related = rows.filter((row) => Number(row.relatedScore) > 0).length;
    if (hasSources && atLeastHalf(alsoBought + related)) return "similar";
    if (atLeastHalf(rows.filter((row) => Number(row.popularOrdering) > 0).length)) return "popular";
    // A source product with nothing related falls back to the store's newest
    // products; saying "You might also like" would still be honest there.
    return hasSources ? "similar" : "new_arrivals";
}

/**
 * The list reason from stored per-row reasons, by the same "at least half"
 * rules as a live ranking (a stored list always has its source product).
 */
function storedRecommendationReason(reasons: readonly ProductRecommendationReason[]): ProductRecommendationReason {
    const atLeastHalf = (count: number) => count > 0 && count * 2 >= reasons.length;
    const alsoBought = reasons.filter((reason) => reason === "also_bought").length;
    if (atLeastHalf(alsoBought)) return "also_bought";
    return "similar";
}

type StoredRecommendationRow = RecommendationCardRow & {
    reason: ProductRecommendationReason;
    isPublic: number | boolean | null;
};

/**
 * One product's stored rows (at most 24, by primary key), with each
 * recommended product's current buyer state; null when never computed.
 */
async function readStoredRecommendations(
    db: Database,
    productId: string,
    limit: number,
): Promise<{ reason: ProductRecommendationReason; rows: RecommendationCardRow[] } | null> {
    const cardSku = buyerStateCardSku();
    const stored = await db
        .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            ...buyerStatePricingSelection(cardSku),
            freeDelivery: products.freeDelivery,
            categoryId: products.categoryId,
            hasCustomerOptions: buyerState.hasCustomerOptions,
            availableForSale: buyerState.availableForSale,
            isPublic: buyerState.isPublic,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`.as("rec_created_at"),
            reason: productRecommendations.reason,
            storeCurrencyCode: storeCurrencyCodeSql().as("rec_store_currency_code"),
        })
        .from(productRecommendations)
        .leftJoin(buyerState, eq(buyerState.productId, productRecommendations.recommendedProductId))
        .leftJoin(products, eq(products.id, productRecommendations.recommendedProductId))
        .leftJoin(cardSku, eq(cardSku.id, buyerState.skuId))
        .where(eq(productRecommendations.productId, productId))
        .orderBy(asc(productRecommendations.position))
        .all() as StoredRecommendationRow[];
    if (stored.length === 0) return null;
    const shown = stored
        .filter((row) => Boolean(row.isPublic) && Boolean(row.availableForSale) && row.id !== null)
        .slice(0, limit);
    return {
        reason: storedRecommendationReason(shown.map((row) => row.reason)),
        rows: shown.map(({ reason: _reason, isPublic: _isPublic, ...row }) => row),
    };
}

/**
 * Recommendations as product cards. One source product reads its stored
 * list and then its card media (two statements, two waves); anything else,
 * or a product never computed, runs the live ranking and then reads the
 * kept rows' cards and media together (three statements, two waves).
 */
export async function getStorefrontProductRecommendations(
    db: Database,
    input: ProductRecommendationInput,
): Promise<ProductRecommendations> {
    const sourceIds = normalizeRecommendationSourceIds(input.productIds);
    const limit = normalizeLimit(input.limit);
    const stored = sourceIds.length === 1
        ? await readStoredRecommendations(db, sourceIds[0]!, limit)
        : null;
    let reason: ProductRecommendationReason;
    let rows: RecommendationCardRow[];
    let mediaMap: Awaited<ReturnType<typeof loadProductMediaProjections>>;
    if (stored) {
        ({ reason, rows } = stored);
        if (rows.length === 0) return { reason, products: [] };
        mediaMap = await loadProductMediaProjections(db, rows.map((row) => row.id));
    } else {
        const ranked = await rankProductRecommendations(db, { productIds: sourceIds, limit });
        reason = ranked.reason;
        if (ranked.rows.length === 0) return { reason, products: [] };
        const ids = ranked.rows.map((row) => row.id);
        const [cards, media] = await Promise.all([
            loadRecommendationCards(db, ids),
            loadProductMediaProjections(db, ids),
        ]);
        rows = ids.flatMap((id) => cards.get(id) ?? []);
        mediaMap = media;
    }
    if (rows.length === 0) return { reason, products: [] };
    const decimalPlaces = storeDecimalPlacesFromCode(rows[0]?.storeCurrencyCode);
    return {
        reason,
        products: rows.map(({
            hasCustomerOptions,
            availableForSale,
            createdAt,
            storeCurrencyCode: _storeCurrencyCode,
            ...row
        }) => ({
            ...presentBuyerPricing(row, decimalPlaces),
            freeDelivery: Boolean(row.freeDelivery),
            hasVariants: Boolean(hasCustomerOptions),
            availableForSale: Boolean(availableForSale),
            ...resolveProductCardImages(mediaMap.get(row.id) ?? []),
            createdAt: unixToDate(createdAt)?.toISOString() ?? null,
        })),
    };
}
