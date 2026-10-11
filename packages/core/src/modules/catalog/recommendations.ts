// Ranked product recommendations for the product page, cart, search dead
// ends, 404 and order confirmation.
//
// One ranking statement scores eligible public, buyable products against the
// source products with the signals the store really has:
//   1. also bought — other products in the same real orders (placed, not
//      cancelled/refunded/returned/unfinished) within a year, counted by
//      distinct buyer phone; two or more buyers rank a product first. Only
//      the source products' latest ALSO_BOUGHT_SOURCE_LINES lines are read;
//   2. similarity — same published category, same active collection (manual
//      list or dynamic category rule), shared attribute values, and an
//      effective buyer price within 60–140% of the source price band;
//   3. popularity — distinct buyers in the last 30 days, used only when enough
//      of the list can be filled that way, otherwise newest first.
// Ties break by newest then id, so the order is deterministic. Card images
// come from one bounded media read. A recorded live fallback carries its
// next semantic ranking-window boundary in the ranking statement.
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
// Freshness: stored lists declare rec:<source>; live fallback declares the
// recommendation-signals key and the next included order's ranking-window
// exit. No arbitrary age limit applies to a quiet store's recommendations.
import {
    translationScopeOf,
    PRODUCT_CARD_FIELDS,
    translateRows,
    translationColumns,
    type TranslationScope,
    type TranslatedRowColumns,
} from "../translations";
import { contactPhoneSql, productRecommendations, products } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
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
    publicBuyerStateCondition,
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
/**
 * "Also bought" reads the source products' latest order lines in the window,
 * at most this many (newest first, through order_items_product_recent_idx).
 * A best seller sits in tens of thousands of orders: reading them all, and
 * every line of each, made one product page take a minute on a
 * million-order store. The latest thousand orders carry the same signal.
 */
export const ALSO_BOUGHT_SOURCE_LINES = 1_000;
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

function realOrder(alias: string): SQL {
    return sql.raw(`${alias}.status IN ${REAL_ORDER_STATUSES_SQL} AND ${alias}.deleted_at IS NULL`);
}

/**
 * One buyer of an order: its phone, or its email when it was placed without
 * one (a phoneless order never counts as one shared buyer).
 */
function buyerSql(alias: string): SQL {
    return sql`COALESCE(${contactPhoneSql(sql.raw(`${alias}.customer_phone`))}, lower(trim(${sql.raw(`${alias}.customer_email`)})))`;
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
 * 12; the refresh job stores 24). It reads only buyer state and signal sets,
 * narrowing to the complete leading co-buy tier when its bounds prove that
 * no other product can win. Card columns are read afterwards for the few
 * rows kept (`loadRecommendationCards`). Internal to the catalog domain.
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
    const sourceJson = JSON.stringify(sourceIds);
    const sourceSet = sql`(SELECT CAST(value AS TEXT) FROM json_each(${sourceJson}))`;
    // The source products' latest lines in the window (ALSO_BOUGHT_SOURCE_LINES),
    // read newest first from (product_id, created_at, order_id). Older lines
    // never re-enter: anything older leaves the window first.
    const sourceLines = (alias: string) => sql`(
        SELECT ${sql.raw(alias)}_sample.order_id AS order_id
        FROM order_items AS ${sql.raw(alias)}_sample
        WHERE ${sourceIds.length === 1
            // Equality lets the index stop at LIMIT without sorting a bestseller's entire history.
            ? sql`${sql.raw(alias)}_sample.product_id = ${sourceIds[0]}`
            : sql`${sql.raw(alias)}_sample.product_id IN ${sourceSet}`}
          AND ${sql.raw(alias)}_sample.created_at >= unixepoch() - ${sql.raw(String(ALSO_BOUGHT_WINDOW_SECONDS))}
        ORDER BY ${sql.raw(alias)}_sample.created_at DESC, ${sql.raw(alias)}_sample.order_id DESC
        LIMIT ${sql.raw(String(ALSO_BOUGHT_SOURCE_LINES))}
    ) AS ${sql.raw(alias)}`;

    const recordBoundary = deps.active();
    // Materialize the bounded sample once for both co-buy scores and its
    // freshness deadline; preserve duplicate source lines after LIMIT.
    const sourceOrders = sql`
        SELECT rec_source_order.id AS order_id, rec_source_order.created_at,
               ${buyerSql("rec_source_order")} AS buyer
        FROM ${sourceLines("rec_source_line")}
        CROSS JOIN orders AS rec_source_order INDEXED BY orders_recommendation_id_buyers_idx
        WHERE rec_source_order.id = rec_source_line.order_id
          AND ${realOrder("rec_source_order")}
          AND rec_source_order.created_at >= unixepoch() - ${sql.raw(String(ALSO_BOUGHT_WINDOW_SECONDS))}
    `;
    const coPurchaseRows = sql`
        SELECT rec_peer_line.product_id AS product_id,
               COUNT(DISTINCT rec_co_order.buyer) AS buyers
               ${sourceIds.length > 0 ? sql`, COUNT(DISTINCT CASE
                   WHEN rec_co_order.created_at >= unixepoch() - ${sql.raw(String(POPULAR_WINDOW_SECONDS))}
                   THEN rec_co_order.buyer END) AS recent_buyers` : sql``}
        FROM ${sourceIds.length > 0 ? sql`rec_source_orders` : sql`(${sourceOrders})`} AS rec_co_order
        CROSS JOIN order_items AS rec_peer_line
        WHERE rec_peer_line.order_id = rec_co_order.order_id
          AND rec_peer_line.product_id NOT IN ${sourceSet}
        GROUP BY rec_peer_line.product_id
    `;
    const coPurchase = sourceIds.length > 0
        ? sql`rec_co_purchase`
        : sql`(${coPurchaseRows}) AS rec_co_purchase`;

    const collectionPeerRows = sql`
        SELECT rec_member.product_id AS product_id, COUNT(DISTINCT rec_member.collection_id) AS shared
        FROM (${collectionMembersSql("rec_peer", sourceCollectionIdsSql(sourceSet))}) AS rec_member
        GROUP BY rec_member.product_id
    `;
    const collectionPeers = sourceIds.length > 0
        ? sql`rec_collection_peer`
        : sql`(${collectionPeerRows}) AS rec_collection_peer`;

    const attributePeerRows = sql`
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
    `;
    const attributePeers = sourceIds.length > 0
        ? sql`rec_attribute_peer`
        : sql`(${attributePeerRows}) AS rec_attribute_peer`;

    // One maintained row per eligible order/product pair keeps the canonical
    // order timestamp and buyer; popularity no longer joins every recent line.
    const popularRows = sql`
        SELECT rec_popular_projection.product_id AS product_id,
               COUNT(DISTINCT rec_popular_projection.buyer) AS buyers
        FROM ${sourceIds.length > 0 ? sql`rec_guard AS rec_popular_guard CROSS JOIN` : sql``}
             recommendation_order_products AS rec_popular_projection
        WHERE rec_popular_projection.created_at >= unixepoch() - ${sql.raw(String(POPULAR_WINDOW_SECONDS))}
          ${sourceIds.length > 0 ? sql`AND rec_popular_guard.qualifies = 0` : sql``}
        GROUP BY rec_popular_projection.product_id
    `;
    const popular = sourceIds.length > 0
        ? sql`rec_popular`
        : sql`(${popularRows}) AS rec_popular`;

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
    const sourceBandRows = sql`
        SELECT MIN(${bandPrice}) AS min_price, MAX(${bandPrice}) AS max_price
        FROM product_variants AS rec_band_sku
        INNER JOIN products AS rec_band_product ON rec_band_product.id = rec_band_sku.product_id
        WHERE rec_band_sku.product_id IN ${sourceSet}
          AND rec_band_sku.deleted_at IS NULL
          AND rec_band_sku.id <> 'default'
          AND ${operationalSkuRowPredicate("rec_band_sku")}
    `;
    const sourceBand = sourceIds.length > 0
        ? sql`rec_source_band`
        : sql`(${sourceBandRows}) AS rec_source_band`;

    // CROSS JOIN keeps the source products as the driver; the planner
    // otherwise walked every product of every published category.
    const sourceCategoryIds = sql`
        SELECT rec_source_product.category_id
        FROM products AS rec_source_product
        CROSS JOIN categories AS rec_source_category
        WHERE rec_source_product.id IN ${sourceSet}
          AND rec_source_category.id = rec_source_product.category_id
          AND rec_source_category.status = 'published'
          AND rec_source_category.deleted_at IS NULL
    `;
    const sameCategory = sql`CASE WHEN ${buyerState.categoryId} IN (
        ${sourceIds.length > 0 ? sql`SELECT category_id FROM rec_source_categories` : sourceCategoryIds}
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
        WHEN (${sourceIds.length > 0 ? sql`(SELECT qualifies FROM rec_popularity_guard) = 1` : sql`
              SUM(CASE WHEN ${popularBuyers} >= ${sql.raw(String(MIN_POPULAR_BUYERS))} THEN 1 ELSE 0 END) OVER () * 2
              >= MIN(COUNT(*) OVER (), ${sql.raw(String(limit))})`})
         AND ${popularBuyers} >= ${sql.raw(String(MIN_POPULAR_BUYERS))}
        THEN ${popularBuyers} ELSE 0
    END`;
    const candidateCondition = and(
        publicBuyerStateCondition(),
        sql`${buyerState.availableForSale} = 1`,
        sql`${buyerState.productId} NOT IN ${sourceSet}`,
    );
    const ranking = db
        .select({
            id: sql<string>`${buyerState.productId}`.as("id"),
            alsoBoughtBuyers: alsoBoughtBuyers.as("alsoBoughtBuyers"),
            relatedScore: relatedScore.as("relatedScore"),
            popularBuyers: popularBuyers.as("popularBuyers"),
            popularOrdering: popularOrdering.as("popularOrdering"),
            ...(recordBoundary ? {
                _priceBand: inPriceBand.as("_price_band"),
                _createdAt: sql`${buyerState.productCreatedAt}`.as("_created_at"),
            } : {}),
        })
        .from(sourceIds.length > 0 ? sql`rec_candidates AS product_buyer_state` : buyerState)
        .leftJoin(coPurchase, sql`rec_co_purchase.product_id = ${buyerState.productId}`)
        .leftJoin(collectionPeers, sql`rec_collection_peer.product_id = ${buyerState.productId}`)
        .leftJoin(attributePeers, sql`rec_attribute_peer.product_id = ${buyerState.productId}`)
        .leftJoin(popular, sql`rec_popular.product_id = ${buyerState.productId}`)
        .crossJoin(sourceBand)
        .where(sourceIds.length > 0 ? undefined : candidateCondition)
        .orderBy(
            desc(alsoBoughtTier),
            desc(sql`${relatedScore} + 15 * ${inPriceBand}`),
            desc(popularOrdering),
            desc(buyerState.productCreatedAt),
            buyerState.productId,
        )
        .limit(limit);

    // Enough eligible co-buy peers exclude the zero-co-buy tier from the top
    // list. Recent co-buyers are a subset of global recent buyers, so half a
    // list of witnesses proves the existing popularity switch is on. Score
    // every peer at or above the list's annual-buyer cutoff, including all
    // ties, with exact popularity. The full witness set keeps the global
    // popularity switch on even if its witnesses fall below that cutoff.
    // Otherwise the same statement narrows the full eligible set by affinity
    // and proves popularity against the original population independently.
    const candidateColumns = sql`${buyerState.productId} AS product_id,
        ${buyerState.fromMinor} AS from_minor, ${buyerState.categoryId} AS category_id,
        ${buyerState.productCreatedAt} AS product_created_at`;
    // Outside the union of category, collection, attribute and co-buy peers,
    // a candidate has co-buy tier zero and at most the 15-point price score.
    // A related-set cutoff strictly above (0, 15) therefore contains every
    // possible winner. Otherwise compute affinity over the full eligible set.
    // Shared peer aggregates also serve the final bounded rows without re-reading
    // their underlying collection, attribute and SKU data.
    const affinityQuery = (relatedOnly: boolean) => db.select({
        productId: sql`${buyerState.productId}`.as("product_id"),
        fromMinor: sql`${buyerState.fromMinor}`.as("from_minor"),
        categoryId: sql`${buyerState.categoryId}`.as("category_id"),
        productCreatedAt: sql`${buyerState.productCreatedAt}`.as("product_created_at"),
        alsoBoughtTier: alsoBoughtTier.as("also_bought_tier"),
        affinity: sql`${relatedScore} + 15 * ${inPriceBand}`.as("affinity"),
    })
        .from(relatedOnly
            ? sql`rec_guard AS rec_affinity_guard CROSS JOIN rec_related_ids CROSS JOIN ${buyerState}`
            : sql`rec_guard AS rec_affinity_guard CROSS JOIN ${buyerState}`)
        .leftJoin(coPurchase, sql`rec_co_purchase.product_id = ${buyerState.productId}`)
        .leftJoin(collectionPeers, sql`rec_collection_peer.product_id = ${buyerState.productId}`)
        .leftJoin(attributePeers, sql`rec_attribute_peer.product_id = ${buyerState.productId}`)
        .crossJoin(sourceBand)
        .where(and(sql`rec_affinity_guard.qualifies = 0`, relatedOnly
            ? and(publicBuyerStateCondition({ drivenByIdSet: true }),
                sql`${buyerState.availableForSale} = 1`, sql`${buyerState.productId} NOT IN ${sourceSet}`,
                sql`${buyerState.productId} = rec_related_ids.product_id`)
            : and(candidateCondition,
                // These IDs came from eligible buyer-state PKs, so the set
                // cannot contain NULL (unlike raw collection JSON members).
                sql`${buyerState.productId} NOT IN (SELECT product_id FROM rec_related_affinity)`)));
    const unrelatedAffinityLimit = sql`(
        SELECT CASE WHEN rec_guard.qualifies = 0 AND rec_related_guard.qualifies = 0
            THEN 9223372036854775807 ELSE 0 END
        FROM rec_guard CROSS JOIN rec_related_guard
    )`;
    const rankingCtes = sourceIds.length === 0 ? sql`` : sql`
        WITH rec_source_orders AS MATERIALIZED (${sourceOrders}),
        rec_co_purchase AS MATERIALIZED (${coPurchaseRows}),
        rec_eligible_co AS MATERIALIZED (
            SELECT ${candidateColumns}, rec_co_purchase.buyers, rec_co_purchase.recent_buyers
            FROM rec_co_purchase
            CROSS JOIN ${buyerState}
            WHERE ${buyerState.productId} = rec_co_purchase.product_id
              AND ${publicBuyerStateCondition({ drivenByIdSet: true })}
              AND ${buyerState.availableForSale} = 1
              AND rec_co_purchase.buyers >= ${sql.raw(String(MIN_ALSO_BOUGHT_BUYERS))}
        ),
        rec_guard AS MATERIALIZED (
            SELECT CASE WHEN COUNT(*) >= ${sql.raw(String(limit))}
                AND COALESCE(SUM(CASE WHEN recent_buyers >= ${sql.raw(String(MIN_POPULAR_BUYERS))}
                    THEN 1 ELSE 0 END), 0) * 2 >= ${sql.raw(String(limit))}
                THEN 1 ELSE 0 END AS qualifies
            FROM rec_eligible_co
        ),
        rec_winning_co AS MATERIALIZED (
            SELECT rec_eligible_co.*
            FROM rec_guard AS rec_winning_guard
            CROSS JOIN rec_eligible_co
            WHERE rec_winning_guard.qualifies = 1
              AND buyers >= (SELECT buyers FROM rec_eligible_co ORDER BY buyers DESC
                  LIMIT 1 OFFSET ${sql.raw(String(limit - 1))})
        ),
        rec_collection_peer AS MATERIALIZED (${collectionPeerRows}),
        rec_attribute_peer AS MATERIALIZED (${attributePeerRows}),
        rec_source_band AS MATERIALIZED (${sourceBandRows}),
        rec_source_categories AS MATERIALIZED (${sourceCategoryIds}),
        rec_related_ids AS MATERIALIZED (
            SELECT ${buyerState.productId} AS product_id
            FROM ${buyerState}
            WHERE ${publicBuyerStateCondition()}
              AND ${buyerState.categoryId} IN (SELECT category_id FROM rec_source_categories)
            UNION SELECT product_id FROM rec_collection_peer
            UNION SELECT product_id FROM rec_attribute_peer
            UNION SELECT product_id FROM rec_co_purchase
            LIMIT (SELECT CASE WHEN qualifies = 0 THEN 9223372036854775807 ELSE 0 END FROM rec_guard)
        ),
        rec_related_affinity AS MATERIALIZED (${affinityQuery(true).getSQL()}),
        rec_related_guard AS MATERIALIZED (
            SELECT COALESCE((
                SELECT CASE WHEN also_bought_tier > 0 OR affinity > 15 THEN 1 ELSE 0 END
                FROM rec_related_affinity
                ORDER BY also_bought_tier DESC, affinity DESC
                LIMIT 1 OFFSET ${sql.raw(String(limit - 1))}
            ), 0) AS qualifies
        ),
        rec_fallback_affinity AS MATERIALIZED (
            SELECT * FROM rec_related_affinity
            UNION ALL
            SELECT * FROM (${affinityQuery(false).getSQL()} LIMIT ${unrelatedAffinityLimit}) AS rec_full_affinity_enabled
        ),
        rec_affinity_cutoff AS MATERIALIZED (
            SELECT also_bought_tier, affinity
            FROM rec_fallback_affinity
            ORDER BY also_bought_tier DESC, affinity DESC
            LIMIT 1 OFFSET ${sql.raw(String(limit - 1))}
        ),
        rec_candidates AS (
            SELECT ${candidateColumns}
            FROM rec_guard AS rec_candidate_guard
            CROSS JOIN rec_winning_co AS product_buyer_state
            WHERE rec_candidate_guard.qualifies = 1
            UNION ALL
            SELECT ${candidateColumns}
            FROM rec_guard AS rec_candidate_guard
            CROSS JOIN rec_fallback_affinity AS product_buyer_state
            LEFT JOIN rec_affinity_cutoff ON 1 = 1
            WHERE rec_candidate_guard.qualifies = 0
              AND (rec_affinity_cutoff.also_bought_tier IS NULL
                OR product_buyer_state.also_bought_tier > rec_affinity_cutoff.also_bought_tier
                OR (product_buyer_state.also_bought_tier = rec_affinity_cutoff.also_bought_tier
                    AND product_buyer_state.affinity >= rec_affinity_cutoff.affinity))
        ),
        rec_popular AS MATERIALIZED (
            SELECT rec_peer_projection.product_id AS product_id,
                   COUNT(DISTINCT rec_peer_projection.buyer) AS buyers
            FROM rec_guard AS rec_peer_popular_guard
            CROSS JOIN recommendation_order_products AS rec_peer_projection
            WHERE rec_peer_popular_guard.qualifies = 1
              AND rec_peer_projection.product_id IN (SELECT product_id FROM rec_winning_co)
              AND rec_peer_projection.created_at >= unixepoch() - ${sql.raw(String(POPULAR_WINDOW_SECONDS))}
            GROUP BY rec_peer_projection.product_id
            UNION ALL
            ${popularRows}
        ),
        rec_popularity_guard AS MATERIALIZED (
            SELECT CASE WHEN rec_guard.qualifies = 1 THEN 1 ELSE (
                SELECT CASE WHEN COUNT(*) * 2 >= (
                    -- The related guard proves at least limit eligible products;
                    -- otherwise affinity still contains the full population.
                    SELECT COUNT(*) FROM (SELECT 1 FROM rec_fallback_affinity LIMIT ${sql.raw(String(limit))}) AS rec_population_sample
                ) THEN 1 ELSE 0 END
                FROM (
                    SELECT 1
                    FROM rec_popular
                    INNER JOIN ${buyerState} ON ${buyerState.productId} = rec_popular.product_id
                    WHERE ${candidateCondition}
                      AND rec_popular.buyers >= ${sql.raw(String(MIN_POPULAR_BUYERS))}
                    LIMIT ${sql.raw(String(Math.ceil(limit / 2)))}
                ) AS rec_popular_witnesses
            ) END AS qualifies
            FROM rec_guard
        )
    `;
    if (!recordBoundary) {
        return sourceIds.length === 0
            ? await ranking.all() as RankedRecommendationRow[]
            : await db.all<RankedRecommendationRow>(sql`${rankingCtes} ${ranking.getSQL()}`);
    }

    // Keep the boundary even when no product ranks, in the same SQL snapshot.
    // Reapply the existing order only to the already limited (at most 24) rows.
    const rows = await db.all<Omit<RankedRecommendationRow, "id"> & {
        id: string | null; popularAt: number | null; alsoBoughtAt: number | null;
    }>(sql`${rankingCtes}${sourceIds.length > 0 ? sql`,` : sql`WITH`}
        rec_ranked AS MATERIALIZED (${ranking.getSQL()}),
        rec_boundary AS MATERIALIZED (
            SELECT (SELECT rec_popular_first.created_at + ${sql.raw(String(POPULAR_WINDOW_SECONDS + 1))}
                FROM orders AS rec_popular_first
                WHERE ${realOrder("rec_popular_first")}
                  AND rec_popular_first.created_at >= unixepoch() - ${sql.raw(String(POPULAR_WINDOW_SECONDS))}
                  AND EXISTS (SELECT 1 FROM order_items AS boundary_line WHERE boundary_line.order_id = rec_popular_first.id)
                ORDER BY rec_popular_first.created_at ASC LIMIT 1) AS popular_at,
                ${sourceIds.length > 0 ? sql`(SELECT MIN(created_at) + ${sql.raw(String(ALSO_BOUGHT_WINDOW_SECONDS + 1))}
                    FROM rec_source_orders)` : sql`NULL`} AS also_bought_at
        )
        SELECT rec_ranked.id AS "id", rec_ranked."alsoBoughtBuyers" AS "alsoBoughtBuyers",
            rec_ranked."relatedScore" AS "relatedScore", rec_ranked."popularBuyers" AS "popularBuyers",
            rec_ranked."popularOrdering" AS "popularOrdering",
            rec_boundary.popular_at AS popularAt, rec_boundary.also_bought_at AS alsoBoughtAt
        FROM rec_boundary LEFT JOIN rec_ranked ON 1 = 1
        ORDER BY CASE WHEN rec_ranked."alsoBoughtBuyers" >= ${sql.raw(String(MIN_ALSO_BOUGHT_BUYERS))}
                THEN rec_ranked."alsoBoughtBuyers" ELSE 0 END DESC,
            rec_ranked."relatedScore" + 15 * rec_ranked._price_band DESC,
            rec_ranked."popularOrdering" DESC, rec_ranked._created_at DESC, rec_ranked.id ASC
    `);
    // Inclusive windows stop including an order one second after its boundary.
    // An empty, quiet store has no deadline, never a routine TTL.
    const exits = [rows[0]?.popularAt, rows[0]?.alsoBoughtAt]
        .filter((at): at is number => at !== null && at !== undefined).map(Number);
    if (exits.length > 0) deps.validUntil(Math.min(...exits) * 1000);
    return rows.flatMap((row) => row.id === null ? [] : [{
        id: row.id, alsoBoughtBuyers: row.alsoBoughtBuyers, relatedScore: row.relatedScore,
        popularBuyers: row.popularBuyers, popularOrdering: row.popularOrdering,
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
