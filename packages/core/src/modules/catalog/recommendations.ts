// Ranked product recommendations for the product page, cart, search dead
// ends, 404 and order confirmation.
//
// One ranking statement scores a bounded pool of eligible (public, buyable,
// buyer-state.ts) products against the source products:
//   1. also bought — other products in the real orders (placed, not
//      cancelled, refunded, returned or unfinished) of the source products'
//      latest ALSO_BOUGHT_SOURCE_ORDERS lines within a year, counted by
//      distinct buyer; two or more buyers rank a product first;
//   2. similarity — same published category, same active collection (manual
//      list or dynamic category rule) and shared attribute values; a related
//      product also scores when its buyer price is within 60–140% of the
//      source price band;
//   3. popularity — distinct buyers among the latest POPULAR_SAMPLE_PAIRS
//      order/product pairs of the last 30 days, used only when enough of the
//      list can be filled that way, otherwise newest first.
// Ties break by newest then id, so the order is deterministic. Every read is
// an index range with a fixed cap, the same SQL on D1, Turso and PostgreSQL.
//
// Precomputed (Design B): a single product's list (the product page) is read
// from its stored `product_recommendations` rows (up to 24, written off the
// request path by recommendation-refresh.ts), filtered to products still
// public and buyable. The live ranking runs on the request path only for a
// product never computed and for multi-product sources (cart, order
// confirmation) or none (404, search dead ends).
//
// Freshness: stored lists declare rec:<source>; live fallback declares the
// recommendation-signals key and the moment its oldest sampled order leaves
// a window. No arbitrary age limit applies to a quiet store's recommendations.
import {
    translationScopeOf,
    PRODUCT_CARD_FIELDS,
    translateRows,
    translationColumns,
    type TranslationScope,
    type TranslatedRowColumns,
} from "../translations";
import { productRecommendations, products } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { asc, eq, sql, type SQL } from "drizzle-orm";
import { unixToDate } from "@scalius/shared/utils";
import {
  effectivePriceMinorSql,
  loadProductMediaProjections,
  operationalSkuRowPredicate,
  presentBuyerPricing,
  quickAddEligibleSql,
  resolveProductCardImages,
} from "../products";
import { storeCurrencyCodeSql, storeDecimalPlacesFromCode } from "../settings";
import { marketPriceContextOf, priceProductCards, type MarketPricing } from "../price-lists";
import { presentCardRating, reviewStats, reviewStatsJoin, type CardRating } from "./shared";
import {
    buyerState,
    buyerStateCardSku,
    buyerStateCardSkuJoin,
    buyerStatePricingSelection,
} from "./buyer-state";
import { declareProductCards, declareRequestedProducts, deps } from "./declare-deps";

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
/** "Also bought" reads the source products' latest order lines in the window, at most this many. */
export const ALSO_BOUGHT_SOURCE_ORDERS = 1_000;
const POPULAR_WINDOW_SECONDS = 30 * 86_400;
/** Popularity reads the window's latest order/product pairs, at most this many. */
export const POPULAR_SAMPLE_PAIRS = 5_000;
/** Candidates from co-purchases, and per category, collection rule category and source attribute value. */
export const RELATED_CANDIDATES_PER_SIGNAL = 100;

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
    quickAddEligible: boolean;
    imageUrl: string | null;
    imageMediaId: string | null;
    imageAlt: string | null;
    secondaryImageUrl: string | null;
    createdAt: string | null;
    /** Published-review average and count; null without a published review. */
    rating: CardRating;
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
    /** A market-keyed read's market pricing (null at the root). */
    pricing?: MarketPricing | null;
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

/** A stored collection id list, or an empty list for a malformed config (json_each fails closed on Postgres). */
function collectionIdList(configColumn: string, key: "productIds" | "categoryIds"): SQL {
    return sql.raw(`json_each(CASE WHEN json_valid(${configColumn}) THEN CASE WHEN json_type(${configColumn}, '$.${key}') = 'array' THEN ${configColumn} ELSE '{"${key}":[]}' END ELSE '{"${key}":[]}' END, '$.${key}')`);
}

function activeCollectionSql(collection: string, dynamic: boolean): string {
    const source = `COALESCE(CASE WHEN json_valid(${collection}.config) THEN json_extract(${collection}.config, '$.source') END, 'manual')`;
    return `${collection}.is_active = 1 AND ${collection}.deleted_at IS NULL AND ${source} ${dynamic ? "=" : "<>"} 'dynamic'`;
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
    quickAddEligible: number | boolean;
    createdAt: number;
    storeCurrencyCode: string | null;
    ratingAvgCenti: number | null;
    reviewCount: number | null;
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
 * 12; the refresh job stores 24). It scores only a bounded candidate pool:
 * the most co-bought peers of the source's latest orders, the newest eligible
 * products of the source and collection-rule categories, manual collection
 * members and the first products sharing each source attribute value
 * (RELATED_CANDIDATES_PER_SIGNAL each), plus the `limit` most popular and
 * newest eligible products. The unrelated tail orders by popularity, then
 * newest, so those last two parts make it exact. Card columns are read
 * afterwards for the few rows kept (`loadRecommendationCards`). Internal to
 * the catalog domain.
 */
export async function rankRecommendationRows(
    db: Database,
    sourceIds: readonly string[],
    limit: number,
): Promise<RankedRecommendationRow[]> {
    // Only this live fallback reads private order signals. Stored lists use rec:<id>.
    deps.recommendationSignals();
    deps.listMembership("all");
    // Any candidate may enter the result when its price score or buyability changes.
    deps.listOrder("price", "all");
    deps.listOrder("band", "all");
    declareRequestedProducts(sourceIds);
    deps.anyCategory();
    deps.anyCollection();
    deps.anyAttribute();
    const n = (value: number) => sql.raw(String(value));
    const now = sql`unixepoch()`;
    // `+`: where an id set drives (the pool), the public flag stays a filter (buyer-state.ts).
    const eligible = (alias: string, drivenByIdSet = false) => sql.raw(`${drivenByIdSet ? "+" : ""}${alias}.is_public = 1
        AND ${alias}.available_for_sale = 1 AND ${alias}.product_id NOT IN (SELECT product_id FROM rec_source)`);
    const bandPrice = effectivePriceMinorSql({
        priceMinor: sql.raw("band_sku.price_minor"),
        discountType: sql.raw("band_sku.discount_type"),
        discountBps: sql.raw("band_sku.discount_bps"),
        discountAmountMinor: sql.raw("band_sku.discount_amount_minor"),
    }, {
        discountType: sql.raw("band_product.discount_type"),
        discountBps: sql.raw("band_product.discount_bps"),
        discountAmountMinor: sql.raw("band_product.discount_amount_minor"),
    });
    const affinity = (row: string) => sql.raw(`${row}.related
        + CASE WHEN ${row}.related > 0 OR ${row}.also_bought > 0 THEN 15 * ${row}.in_band ELSE 0 END`);
    const ranking = (row: string) => sql`CASE WHEN ${sql.raw(row)}.also_bought >= ${n(MIN_ALSO_BOUGHT_BUYERS)}
            THEN ${sql.raw(row)}.also_bought ELSE 0 END DESC,
        ${affinity(row)} DESC, ${sql.raw(row)}.popular_ordering DESC, ${sql.raw(row)}.created_at DESC, ${sql.raw(row)}.id`;
    const rows = await db.all<Omit<RankedRecommendationRow, "id"> & {
        id: string | null; popularAt: number | null; alsoBoughtAt: number | null;
    }>(sql`
        WITH rec_source AS (
            SELECT DISTINCT CAST(value AS TEXT) AS product_id FROM json_each(${JSON.stringify(sourceIds)})
        ),
        -- The source products' latest order lines (order_items_product_recent_idx),
        -- then their real orders' time and buyer by primary key (the LEFT JOIN
        -- keeps the bounded sample outer; a line of no real order has none).
        rec_source_lines AS (
            SELECT source_line.order_id, source_pair.created_at, source_pair.buyer
            FROM (
                SELECT line.order_id, line.product_id FROM order_items AS line
                WHERE line.product_id IN (SELECT product_id FROM rec_source)
                  AND line.created_at >= ${now} - ${n(ALSO_BOUGHT_WINDOW_SECONDS)}
                ORDER BY line.created_at DESC, line.order_id DESC
                LIMIT ${n(ALSO_BOUGHT_SOURCE_ORDERS)}
            ) AS source_line
            LEFT JOIN recommendation_order_products AS source_pair
                ON source_pair.order_id = source_line.order_id AND source_pair.product_id = source_line.product_id
        ),
        rec_source_orders AS (
            SELECT order_id, created_at, buyer FROM rec_source_lines
            WHERE created_at >= ${now} - ${n(ALSO_BOUGHT_WINDOW_SECONDS)}
        ),
        -- An order's pairs share its buyer.
        rec_co AS (
            SELECT peer.product_id, COUNT(DISTINCT peer.buyer) AS buyers
            FROM recommendation_order_products AS peer
            WHERE peer.order_id IN (SELECT order_id FROM rec_source_orders)
              AND peer.product_id NOT IN (SELECT product_id FROM rec_source)
            GROUP BY peer.product_id
        ),
        -- The popularity window's latest order/product pairs.
        rec_popular_sample AS (
            SELECT sample.product_id, sample.buyer, sample.created_at
            FROM recommendation_order_products AS sample
            WHERE sample.created_at >= ${now} - ${n(POPULAR_WINDOW_SECONDS)}
            ORDER BY sample.created_at DESC, sample.order_id DESC
            LIMIT ${n(POPULAR_SAMPLE_PAIRS)}
        ),
        rec_popular AS (
            SELECT popular.product_id, COUNT(DISTINCT popular.buyer) AS buyers,
                MIN(buyer_state.product_created_at) AS created_at
            FROM rec_popular_sample AS popular
            INNER JOIN product_buyer_state AS buyer_state ON buyer_state.product_id = popular.product_id
            WHERE ${eligible("buyer_state", true)}
            GROUP BY popular.product_id
        ),
        -- Popularity orders the tail only when it can fill at least half the list.
        rec_switch AS (
            SELECT CASE WHEN 2 * (SELECT COUNT(*) FROM (
                SELECT 1 FROM rec_popular WHERE buyers >= ${n(MIN_POPULAR_BUYERS)} LIMIT ${n(Math.ceil(limit / 2))}
            ) AS witness) >= (SELECT COUNT(*) FROM (
                SELECT 1 FROM product_buyer_state AS population WHERE ${eligible("population")} LIMIT ${n(limit)}
            ) AS population_sample) THEN 1 ELSE 0 END AS popular
        ),
        rec_band AS (
            SELECT MIN(${bandPrice}) AS min_price, MAX(${bandPrice}) AS max_price
            FROM product_variants AS band_sku
            INNER JOIN products AS band_product ON band_product.id = band_sku.product_id
            WHERE band_sku.product_id IN (SELECT product_id FROM rec_source)
              AND band_sku.deleted_at IS NULL AND band_sku.id <> 'default'
              AND ${operationalSkuRowPredicate("band_sku")}
        ),
        rec_categories AS (
            SELECT DISTINCT source_product.category_id AS id
            FROM products AS source_product
            INNER JOIN categories AS category ON category.id = source_product.category_id
                AND category.status = 'published' AND category.deleted_at IS NULL
            WHERE source_product.id IN (SELECT product_id FROM rec_source)
        ),
        -- Each active collection holding a source: its manual ids, or its published rule categories.
        rec_collection_links AS (
            SELECT collection.id AS collection_id, CAST(member.value AS TEXT) AS product_id, CAST(NULL AS TEXT) AS category_id
            FROM collections AS collection
            CROSS JOIN ${collectionIdList("collection.config", "productIds")} AS member
            WHERE ${sql.raw(activeCollectionSql("collection", false))}
              AND EXISTS (SELECT 1 FROM ${collectionIdList("collection.config", "productIds")} AS hit
                  WHERE CAST(hit.value AS TEXT) IN (SELECT product_id FROM rec_source))
            UNION ALL
            SELECT collection.id, CAST(NULL AS TEXT), CAST(rule.value AS TEXT)
            FROM collections AS collection
            CROSS JOIN ${collectionIdList("collection.config", "categoryIds")} AS rule
            WHERE ${sql.raw(activeCollectionSql("collection", true))}
              AND CAST(rule.value AS TEXT) IN (
                  SELECT id FROM categories WHERE status = 'published' AND deleted_at IS NULL
              )
              AND EXISTS (SELECT 1 FROM ${collectionIdList("collection.config", "categoryIds")} AS hit
                  WHERE CAST(hit.value AS TEXT) IN (SELECT id FROM rec_categories))
        ),
        rec_values AS (
            SELECT DISTINCT source_value.attribute_id, source_value.value
            FROM product_attribute_values AS source_value
            INNER JOIN product_attributes AS attribute
                ON attribute.id = source_value.attribute_id AND attribute.deleted_at IS NULL
            WHERE source_value.product_id IN (SELECT product_id FROM rec_source)
        ),
        rec_pool AS (
            SELECT product_id FROM (
                SELECT product_id FROM rec_co ORDER BY buyers DESC, product_id LIMIT ${n(RELATED_CANDIDATES_PER_SIGNAL)}
            ) AS co_peer
            UNION SELECT product_id FROM rec_collection_links WHERE product_id IS NOT NULL
            -- The small source sets drive (a LEFT JOIN keeps them outer; a NULL
            -- id joins no candidate): each category's newest public products
            -- and their created-time ties, then each value's first products,
            -- one covering index range each (buyability is checked when scored).
            UNION SELECT peer.product_id FROM (
                SELECT id FROM rec_categories UNION SELECT category_id FROM rec_collection_links
            ) AS peer_category
            LEFT JOIN product_buyer_state AS peer
                ON peer.is_public = 1 AND peer.category_id = peer_category.id
               AND peer.product_id NOT IN (SELECT product_id FROM rec_source)
               AND peer.product_created_at >= (SELECT MIN(newest.product_created_at) FROM (
                   SELECT cutoff.product_created_at FROM product_buyer_state AS cutoff
                   WHERE cutoff.is_public = 1 AND cutoff.category_id = peer_category.id
                     AND cutoff.product_id NOT IN (SELECT product_id FROM rec_source)
                   ORDER BY cutoff.product_created_at DESC LIMIT ${n(RELATED_CANDIDATES_PER_SIGNAL)}
               ) AS newest)
            UNION SELECT peer_value.product_id FROM rec_values AS source_value
            LEFT JOIN product_attribute_values AS peer_value
                ON peer_value.attribute_id = source_value.attribute_id AND peer_value.value = source_value.value
               AND peer_value.product_id <= (SELECT MAX(first_value.product_id) FROM (
                   SELECT cutoff.product_id FROM product_attribute_values AS cutoff
                   WHERE cutoff.attribute_id = source_value.attribute_id AND cutoff.value = source_value.value
                   ORDER BY cutoff.product_id LIMIT ${n(RELATED_CANDIDATES_PER_SIGNAL)}
               ) AS first_value)
        ),
        rec_tail AS (
            SELECT product_id FROM (
                SELECT product_id FROM rec_popular ORDER BY buyers DESC, created_at DESC, product_id LIMIT ${n(limit)}
            ) AS popular_tail
            UNION SELECT product_id FROM (
                SELECT newest.product_id FROM product_buyer_state AS newest WHERE ${eligible("newest")}
                ORDER BY newest.product_created_at DESC, newest.product_id LIMIT ${n(limit)}
            ) AS newest_tail
        ),
        rec_scored AS (
            SELECT candidate.product_id AS id, candidate.product_created_at AS created_at,
                COALESCE(co.buyers, 0) AS also_bought,
                40 * CASE WHEN candidate.category_id IN (SELECT id FROM rec_categories) THEN 1 ELSE 0 END
                + 25 * MIN((SELECT COUNT(DISTINCT shared.collection_id) FROM (
                    SELECT collection_id FROM rec_collection_links WHERE product_id = candidate.product_id
                    UNION ALL SELECT collection_id FROM rec_collection_links WHERE category_id = candidate.category_id
                ) AS shared), 2)
                + 10 * MIN((SELECT COUNT(DISTINCT shared.attribute_id) FROM product_attribute_values AS shared
                    INNER JOIN rec_values ON rec_values.attribute_id = shared.attribute_id AND rec_values.value = shared.value
                    WHERE shared.product_id = candidate.product_id), 5)
                + CASE WHEN co.buyers = 1 THEN 20 ELSE 0 END AS related,
                CASE WHEN rec_band.min_price IS NOT NULL
                    AND candidate.from_minor * 100 >= rec_band.min_price * 60
                    AND candidate.from_minor * 100 <= rec_band.max_price * 140 THEN 1 ELSE 0 END AS in_band,
                COALESCE(popular.buyers, 0) AS popular_buyers,
                CASE WHEN rec_switch.popular = 1 AND popular.buyers >= ${n(MIN_POPULAR_BUYERS)}
                    THEN popular.buyers ELSE 0 END AS popular_ordering
            FROM (SELECT product_id FROM rec_pool UNION SELECT product_id FROM rec_tail) AS pool
            INNER JOIN product_buyer_state AS candidate ON candidate.product_id = pool.product_id
            CROSS JOIN rec_band
            CROSS JOIN rec_switch
            LEFT JOIN rec_co AS co ON co.product_id = candidate.product_id
            LEFT JOIN rec_popular AS popular ON popular.product_id = candidate.product_id
            WHERE ${eligible("candidate", true)}
        ),
        rec_ranked AS (
            SELECT * FROM rec_scored ORDER BY ${ranking("rec_scored")} LIMIT ${n(limit)}
        ),
        rec_boundary AS (
            SELECT (SELECT MIN(created_at) FROM rec_popular_sample) + ${n(POPULAR_WINDOW_SECONDS + 1)} AS popular_at,
                (SELECT MIN(created_at) FROM rec_source_orders) + ${n(ALSO_BOUGHT_WINDOW_SECONDS + 1)} AS also_bought_at
        )
        SELECT rec_ranked.id AS "id", rec_ranked.also_bought AS "alsoBoughtBuyers",
            rec_ranked.related AS "relatedScore", rec_ranked.popular_buyers AS "popularBuyers",
            rec_ranked.popular_ordering AS "popularOrdering",
            rec_boundary.popular_at AS "popularAt", rec_boundary.also_bought_at AS "alsoBoughtAt"
        FROM rec_boundary LEFT JOIN rec_ranked ON 1 = 1
        ORDER BY ${ranking("rec_ranked")}
    `);
    // Inclusive windows stop including an order one second after its boundary.
    // An empty, quiet store has no deadline, never a routine TTL.
    const exits = [rows[0]?.popularAt, rows[0]?.alsoBoughtAt]
        .filter((at): at is number => at !== null && at !== undefined).map(Number);
    if (exits.length > 0) deps.validUntil(Math.min(...exits) * 1000);
    return rows.flatMap((row) => row.id === null ? [] : [{
        id: row.id, alsoBoughtBuyers: Number(row.alsoBoughtBuyers), relatedScore: Number(row.relatedScore),
        popularBuyers: Number(row.popularBuyers), popularOrdering: Number(row.popularOrdering),
    }]);
}

/** Card columns of the given public products (at most 24 ids, one JSON parameter). */
async function loadRecommendationCards(
    db: Database,
    ids: readonly string[],
    translation: TranslationScope | null,
): Promise<Map<string, RecommendationCardRow>> {
    if (ids.length === 0) return new Map();
    const cardSku = buyerStateCardSku();
    const rows = await db
        .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            ...translationColumns(translation, "product", products.id),
            ...buyerStatePricingSelection(cardSku),
            freeDelivery: products.freeDelivery,
            categoryId: products.categoryId,
            hasCustomerOptions: buyerState.hasCustomerOptions,
            availableForSale: buyerState.availableForSale,
            quickAddEligible: quickAddEligibleSql({
                availableForSale: buyerState.availableForSale,
                hasCustomerOptions: buyerState.hasCustomerOptions,
                effectivePriceMinor: buyerState.fromMinor,
            }).as("recommendation_quick_add_eligible"),
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`.as("rec_created_at"),
            storeCurrencyCode: storeCurrencyCodeSql().as("rec_store_currency_code"),
            ratingAvgCenti: reviewStats.ratingAvgCenti,
            reviewCount: reviewStats.reviewCount,
        })
        .from(buyerState)
        .innerJoin(products, eq(products.id, buyerState.productId))
        .leftJoin(cardSku, buyerStateCardSkuJoin(cardSku))
        .leftJoin(reviewStats, reviewStatsJoin(products.id))
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
    translation: TranslationScope | null,
): Promise<{ reason: ProductRecommendationReason; rows: RecommendationCardRow[] } | null> {
    deps.recommendations(productId);
    const cardSku = buyerStateCardSku();
    const stored = await db
        .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            ...translationColumns(translation, "product", products.id),
            ...buyerStatePricingSelection(cardSku),
            freeDelivery: products.freeDelivery,
            categoryId: products.categoryId,
            hasCustomerOptions: buyerState.hasCustomerOptions,
            availableForSale: buyerState.availableForSale,
            quickAddEligible: quickAddEligibleSql({
                availableForSale: buyerState.availableForSale,
                hasCustomerOptions: buyerState.hasCustomerOptions,
                effectivePriceMinor: buyerState.fromMinor,
            }).as("stored_recommendation_quick_add_eligible"),
            isPublic: buyerState.isPublic,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`.as("rec_created_at"),
            reason: productRecommendations.reason,
            storeCurrencyCode: storeCurrencyCodeSql().as("rec_store_currency_code"),
            ratingAvgCenti: reviewStats.ratingAvgCenti,
            reviewCount: reviewStats.reviewCount,
        })
        .from(productRecommendations)
        .leftJoin(buyerState, eq(buyerState.productId, productRecommendations.recommendedProductId))
        .leftJoin(products, eq(products.id, productRecommendations.recommendedProductId))
        .leftJoin(cardSku, buyerStateCardSkuJoin(cardSku))
        .leftJoin(reviewStats, reviewStatsJoin(productRecommendations.recommendedProductId))
        .where(eq(productRecommendations.productId, productId))
        .orderBy(asc(productRecommendations.position))
        .all() as StoredRecommendationRow[];
    if (stored.length === 0) return null;
    // A stored product hidden now (not public, sold out) shows again when its
    // own buyer state changes; rec:<source> covers the stored order.
    deps.products(stored.map((row) => row.id));
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
    // A presence page's cards in its language (MARKETS-DESIGN D9).
    const translation = translationScopeOf(input.pricing);
    const stored = sourceIds.length === 1
        ? await readStoredRecommendations(db, sourceIds[0]!, limit, translation)
        : null;
    let reason: ProductRecommendationReason;
    let rows: RecommendationCardRow[];
    let mediaMap: Awaited<ReturnType<typeof loadProductMediaProjections>>;
    if (stored) {
        ({ reason, rows } = stored);
        if (rows.length === 0) return { reason, products: [] };
        const storedRows = rows;
        // A market's list prices (only when one is live) ride beside the media.
        [mediaMap, rows] = await Promise.all([
            loadProductMediaProjections(db, storedRows.map((row) => row.id)),
            marketPriceContextOf(input.pricing).then((market) => priceProductCards(db, market, storedRows)),
        ]);
    } else {
        const ranked = await rankProductRecommendations(db, { productIds: sourceIds, limit });
        reason = ranked.reason;
        if (ranked.rows.length === 0) return { reason, products: [] };
        const ids = ranked.rows.map((row) => row.id);
        const [cards, media] = await Promise.all([
            loadRecommendationCards(db, ids, translation),
            loadProductMediaProjections(db, ids),
        ]);
        rows = await priceProductCards(db, await marketPriceContextOf(input.pricing), ids.flatMap((id) => cards.get(id) ?? []));
        mediaMap = media;
    }
    if (rows.length === 0) return { reason, products: [] };
    declareProductCards(rows.map((row) => row.id), mediaMap);
    const decimalPlaces = storeDecimalPlacesFromCode(rows[0]?.storeCurrencyCode);
    return {
        reason,
        products: translateRows(translation, "product", rows as Array<RecommendationCardRow & TranslatedRowColumns>, PRODUCT_CARD_FIELDS).map(({
            hasCustomerOptions,
            availableForSale,
            quickAddEligible,
            createdAt,
            storeCurrencyCode: _storeCurrencyCode,
            ratingAvgCenti,
            reviewCount,
            ...row
        }) => ({
            ...presentBuyerPricing(row, decimalPlaces),
            rating: presentCardRating(ratingAvgCenti, reviewCount),
            freeDelivery: Boolean(row.freeDelivery),
            hasVariants: Boolean(hasCustomerOptions),
            availableForSale: Boolean(availableForSale),
            quickAddEligible: Boolean(quickAddEligible),
            ...resolveProductCardImages(mediaMap.get(row.id) ?? []),
            createdAt: unixToDate(createdAt)?.toISOString() ?? null,
        })),
    };
}
