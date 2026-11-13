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
// Precomputed (Design B): the live ranking runs only off the request path
// (recommendation-refresh.ts stores each product's top 24 in
// `product_recommendations`). A request reads stored lists only:
//   - one source product (the product page) reads its list, filtered to
//     products still public and buyable;
//   - several (cart, cart drawer, order confirmation) merge their sources'
//     stored lists by position;
//   - a source without a stored list is queued for the refresh
//     (recommendation-queue.ts), and the list, or a request without sources
//     (cart page, 404, search dead ends), is filled by an index-bounded
//     fallback: the sources' categories' newest products, the 30-day best
//     sellers (`product_sales_stats`) and the newest products, ranked same
//     category, then units sold, then newest.
//
// Freshness: stored lists declare rec:<source> (so a queued product's page
// changes when its list is stored); the fallback declares its windows' list
// membership (`lm:cat:<id>`, `lm:all`), `popular` and every product it read.
// None of these advances on an order: only the refresh jobs move them.
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
import { presentCardRating, publishedCategoryIdSet, reviewStats, reviewStatsJoin, type CardRating } from "./shared";
import {
    buyerState,
    buyerStateCardSku,
    buyerStateCardSkuJoin,
    buyerStatePricingSelection,
} from "./buyer-state";
import { categoryScope, declareProductCards, declareRequestedProducts, deps } from "./declare-deps";
import { requestRecommendationRefresh } from "./recommendation-queue";

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
/** Related candidates scored in all (cart sources and large manual collections can add more). */
export const RELATED_CANDIDATE_LIMIT = 1_000;

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
    imageAspect: number | null;
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


type Row = Record<string, unknown>;
const count = (value: unknown) => Number(value ?? 0);

/** Rows of `statement` under the given column names (a batchable read on every provider). */
function rankingRead(db: Database, fields: readonly string[], statement: SQL) {
    return db
        .select(Object.fromEntries(fields.map((field) => [field, sql`q.${sql.raw(field)}`])) as Record<string, SQL<unknown>>)
        .from(sql`(${statement}) AS q`);
}

/**
 * A JSON array (round trip 1's aggregate) read back as rows of typed columns,
 * each read by its member name (portable casts). Text is COLLATE BINARY: on
 * PostgreSQL it orders and ties as the id columns it came from ("C"), not by
 * the database's default collation.
 */
function jsonRows(json: unknown, columns: Readonly<Record<string, "text" | "bigint">>): SQL {
    return sql`SELECT ${sql.join(Object.entries(columns).map(([column, type]) => type === "text"
        ? sql`CAST(json_extract(value, ${`$.${column}`}) AS TEXT) COLLATE BINARY AS ${sql.raw(column)}`
        : sql`CAST(json_extract(value, ${`$.${column}`}) AS bigint) AS ${sql.raw(column)}`), sql`, `)}
        FROM json_each(${typeof json === "string" ? json : "[]"})`;
}

/** A JSON array of ids read back as rows of `product_id` (COLLATE BINARY, see jsonRows). */
function jsonIds(json: unknown): SQL {
    return sql`SELECT CAST(value AS TEXT) COLLATE BINARY AS product_id FROM json_each(${typeof json === "string" ? json : "[]"})`;
}

/**
 * The most bytes a ranking statement binds in one value, a quarter of D1's
 * 2,000,000-byte limit on a string. A scoring statement binds per-candidate
 * JSON for at most RELATED_CANDIDATE_LIMIT pooled ids plus its tail (24 + 20
 * popular, 24 newest): 1,068 popularity entries (about 120 bytes each with a
 * 64-byte id: 128 KB), as many co-purchase counts (about 100 KB), 1,000 peer
 * ids (66 KB), and two collection rows per id (about 260 KB) plus two per
 * linked category. The batch's popularity is a result, not a bound value.
 * recommendations-ranking.oracle.d1.test.ts fails past it.
 */
export const RECOMMENDATION_BOUND_VALUE_BYTES = 500_000;

/** Rankings computed together: their first reads in one batch, their scoring in another. */
const RANKING_BATCH_SOURCES = 25;

/** One popular product of the window (eligible, sources not excluded) and its place in the popular order. */
type PopularEntry = { product_id: string; buyers: number; created_at: number; rank: number };

/** What a batch of rankings shares: the window's popular products, the newest eligible products, the window's exit. */
type BatchPopularity = { popular: PopularEntry[]; newest: Array<{ product_id: string; rank: number }>; popular_at: unknown };

/** One ranking's share of it, as its scoring binds it. */
type SourcePopularity = { popular: string; popular_switch: number; newest: string };

const utf8 = new TextEncoder();
/** Text in the order the id columns sort it: SQLite's BINARY and PostgreSQL's "C", UTF-8 bytes. */
function binaryOrder(left: string, right: string): number {
    const a = utf8.encode(left);
    const b = utf8.encode(right);
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        if (a[index] !== b[index]) return a[index]! - b[index]!;
    }
    return a.length - b.length;
}

function parsedJson<T>(json: unknown): T[] {
    return typeof json === "string" ? JSON.parse(json) as T[] : [];
}

/**
 * The batch's popularity read: the window's latest order/product pairs per
 * eligible product (ranked buyers, then newest, then id) and the newest
 * eligible products, `tail` of them, for every ranking of the batch at once.
 * Each ranking drops its own sources from them (`scoringInputs`).
 */
function batchPopularityRead(db: Database, tail: number) {
    const n = (value: number) => sql.raw(String(value));
    const now = sql`unixepoch()`;
    return rankingRead(db, ["popular", "popular_at", "newest"], sql`
        WITH rec_popular_sample AS MATERIALIZED (
            SELECT sample.product_id, sample.buyer, sample.created_at
            FROM recommendation_order_products AS sample
            WHERE sample.created_at >= ${now} - ${n(POPULAR_WINDOW_SECONDS)}
            ORDER BY sample.created_at DESC, sample.product_id DESC, sample.buyer DESC
            LIMIT ${n(POPULAR_SAMPLE_PAIRS)}
        )
        SELECT (SELECT json_group_array(json_object('product_id', product_id, 'buyers', buyers, 'created_at', created_at, 'rank', popular_rank)) FROM (
                SELECT popular.product_id, popular.buyers, popular.created_at,
                    ROW_NUMBER() OVER (ORDER BY popular.buyers DESC, popular.created_at DESC, popular.product_id) AS popular_rank
                FROM (
                    SELECT popular_pair.product_id, COUNT(DISTINCT popular_pair.buyer) AS buyers,
                        MIN(buyer_state.product_created_at) AS created_at
                    FROM rec_popular_sample AS popular_pair
                    INNER JOIN product_buyer_state AS buyer_state ON buyer_state.product_id = popular_pair.product_id
                    WHERE +buyer_state.is_public = 1 AND buyer_state.available_for_sale = 1
                    GROUP BY popular_pair.product_id
                ) AS popular
            ) AS ranked_popular) AS popular,
            (SELECT MIN(created_at) FROM rec_popular_sample) + ${n(POPULAR_WINDOW_SECONDS + 1)} AS popular_at,
            (SELECT json_group_array(json_object('product_id', product_id, 'rank', newest_rank)) FROM (
                SELECT newest.product_id,
                    ROW_NUMBER() OVER (ORDER BY newest.product_created_at DESC, newest.product_id) AS newest_rank
                FROM product_buyer_state AS newest WHERE newest.is_public = 1 AND newest.available_for_sale = 1
                ORDER BY newest.product_created_at DESC, newest.product_id LIMIT ${n(tail)}
            ) AS newest_tail) AS newest`);
}

/**
 * One ranking's popularity, from its batch's: whether popularity orders the
 * tail (it can fill at least half the list), its newest tail, and only the
 * popularity entries its scoring can read. Scoring reads an entry for a
 * pooled candidate or for the tail, so it gets the entries of the related
 * pool's first RELATED_CANDIDATE_LIMIT ids (by id, as the pool is capped:
 * a superset of the cap on either engine), of its `limit + sources` most
 * popular products and of its newest tail; never the whole window, which
 * at 5,000 popular products was about 400 KB per ranking. The co-purchase
 * counts, the categories' newest peers and the collection links' products are
 * trimmed to the same ids. The scoring statement drops the sources themselves.
 */
function scoringInputs(batch: BatchPopularity, sources: readonly string[], limit: number, links: Row, values: Row, coBuy: Row, peerRows: Row) {
    const excluded = new Set(sources);
    const co = parsedJson<{ product_id: string; buyers: number }>(coBuy.co);
    const coTop = [...co].sort((left, right) => count(right.buyers) - count(left.buyers) || binaryOrder(left.product_id, right.product_id))
        .slice(0, RELATED_CANDIDATES_PER_SIGNAL).map((row) => row.product_id);
    const pool = [...new Set([
        ...coTop,
        ...parsedJson<{ product_id: string | null }>(links.links).map((row) => row.product_id),
        ...parsedJson<string | null>(peerRows.newest_peers),
        ...parsedJson<string | null>(values.value_peers),
    ].filter((id): id is string => typeof id === "string"))].sort(binaryOrder).slice(0, RELATED_CANDIDATE_LIMIT);
    const popularOrder = [...batch.popular].sort((left, right) => left.rank - right.rank);
    const eligible = [...batch.newest].sort((left, right) => left.rank - right.rank).filter((row) => !excluded.has(row.product_id));
    const newest = eligible.slice(0, limit).map((row) => row.product_id);
    // The eligible products besides the sources, up to `limit`: the batch read
    // `limit` plus the most sources any ranking has, so with this ranking's
    // sources dropped it still holds `limit` when the catalogue does.
    const population = Math.min(limit, eligible.length);
    const read = new Set([...pool, ...newest, ...popularOrder.slice(0, limit + excluded.size).map((row) => row.product_id)]);
    const witness = Math.min(
        popularOrder.filter((row) => !excluded.has(row.product_id) && count(row.buyers) >= MIN_POPULAR_BUYERS).length,
        Math.ceil(limit / 2),
    );
    // A candidate's collection score counts at most two distinct collections
    // (its own rows and its category's), so two rows per id or category keep it.
    const kept = new Map<string, Set<string>>();
    const keepTwo = (key: string, collection: string) => {
        const seen = kept.get(key) ?? new Set<string>();
        kept.set(key, seen);
        if (seen.size >= 2 && !seen.has(collection)) return false;
        seen.add(collection);
        return true;
    };
    const linkRows = parsedJson<{ collection_id: string; product_id: string | null; category_id: string | null }>(links.links).filter((row) =>
        row.product_id !== null ? read.has(row.product_id) && keepTwo(`p\u0000${row.product_id}`, row.collection_id)
            : keepTwo(`c\u0000${row.category_id}`, row.collection_id));
    // A category with no peer stays a NULL in the pool (it takes a place under the cap on SQLite).
    const peers = parsedJson<string | null>(peerRows.newest_peers).filter((id) => id === null || read.has(id));
    return {
        links: { ...links, links: JSON.stringify(linkRows) },
        peers: { newest_peers: JSON.stringify([...new Set(peers)]) },
        popularity: {
            popular: JSON.stringify(popularOrder.filter((row) => read.has(row.product_id))
                .map(({ product_id, buyers, created_at }) => ({ product_id, buyers, created_at }))),
            popular_switch: 2 * witness >= population ? 1 : 0,
            newest: JSON.stringify(newest),
        } satisfies SourcePopularity,
        coBuy: { ...coBuy, co: JSON.stringify(co.filter((row) => read.has(row.product_id))) },
    };
}

/**
 * One ranking's statements: four source reads, each one row of JSON
 * aggregates (so a set crosses the wire as one row), then (from them) its
 * scoring.
 */
function rankingStatements(db: Database, sourceIds: readonly string[], limit: number) {
    const n = (value: number) => sql.raw(String(value));
    const now = sql`unixepoch()`;
    const recSource = sql`rec_source AS MATERIALIZED (
            SELECT DISTINCT CAST(value AS TEXT) COLLATE BINARY AS product_id FROM json_each(${JSON.stringify(sourceIds)})
        )`;
    // The sources bound again where a reference to `rec_source` would expand it once more.
    const sourceList = sql`SELECT CAST(value AS TEXT) COLLATE BINARY FROM json_each(${JSON.stringify(sourceIds)})`;
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

    // Round trip 1. The source's categories and its collections' links
    // (manual ids or published rule categories).
    const linksRead = rankingRead(db, ["categories", "links"], sql`
        WITH ${recSource},
        rec_categories AS MATERIALIZED (
            SELECT DISTINCT source_product.category_id AS id
            FROM products AS source_product
            WHERE source_product.id IN (SELECT product_id FROM rec_source)
              AND source_product.category_id IN ${publishedCategoryIdSet(sql`1 = 1`)}
        ),
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
        )
        SELECT (SELECT json_group_array(json_object('id', id)) FROM rec_categories) AS categories,
            (SELECT json_group_array(json_object('collection_id', collection_id, 'product_id', product_id, 'category_id', category_id))
                FROM rec_collection_links) AS links`);
    // Each of those categories' newest public products and their created-time
    // ties (a NULL for a category with none, and for the manual links' empty
    // category, as the pool reads them). No CTE: the categories are written
    // twice, a few rows read by key, where a CTE reference expanded again
    // would take the links read past the CTE bound.
    const sourceCategories = sql`SELECT source_product.category_id FROM products AS source_product
        WHERE source_product.id IN (${sourceList}) AND source_product.category_id IN ${publishedCategoryIdSet(sql`1 = 1`)}`;
    const peersRead = rankingRead(db, ["newest_peers"], sql`
        SELECT json_group_array(peer.product_id) AS newest_peers FROM (
            ${sourceCategories}
            UNION SELECT CAST(NULL AS TEXT) FROM collections AS collection
            WHERE ${sql.raw(activeCollectionSql("collection", false))}
              AND EXISTS (SELECT 1 FROM ${collectionIdList("collection.config", "productIds")} AS member)
              AND EXISTS (SELECT 1 FROM ${collectionIdList("collection.config", "productIds")} AS hit
                  WHERE CAST(hit.value AS TEXT) IN (${sourceList}))
            UNION SELECT CAST(rule.value AS TEXT)
            FROM collections AS collection
            CROSS JOIN ${collectionIdList("collection.config", "categoryIds")} AS rule
            WHERE ${sql.raw(activeCollectionSql("collection", true))}
              AND CAST(rule.value AS TEXT) IN (
                  SELECT id FROM categories WHERE status = 'published' AND deleted_at IS NULL
              )
              AND EXISTS (SELECT 1 FROM ${collectionIdList("collection.config", "categoryIds")} AS hit
                  WHERE CAST(hit.value AS TEXT) IN (${sourceCategories}))
        ) AS peer_category
        LEFT JOIN product_buyer_state AS peer
            ON peer.is_public = 1 AND peer.category_id = peer_category.category_id
           AND peer.product_id NOT IN (${sourceList})
           AND peer.product_created_at >= (SELECT MIN(newest.product_created_at) FROM (
               SELECT cutoff.product_created_at FROM product_buyer_state AS cutoff
               WHERE cutoff.is_public = 1 AND cutoff.category_id = peer_category.category_id
                 AND cutoff.product_id NOT IN (${sourceList})
               ORDER BY cutoff.product_created_at DESC LIMIT ${n(RELATED_CANDIDATES_PER_SIGNAL)}
           ) AS newest)`);
    // The source's attribute values, each value's first products, and its price band.
    const valuesRead = rankingRead(db, ["vals", "value_peers", "band_min", "band_max"], sql`
        WITH ${recSource},
        rec_values AS MATERIALIZED (
            SELECT DISTINCT source_value.attribute_id, source_value.value
            FROM product_attribute_values AS source_value
            INNER JOIN product_attributes AS attribute
                ON attribute.id = source_value.attribute_id AND attribute.deleted_at IS NULL
            WHERE source_value.product_id IN (SELECT product_id FROM rec_source)
        )
        SELECT (SELECT json_group_array(json_object('attribute_id', attribute_id, 'value', value)) FROM rec_values) AS vals,
            (SELECT json_group_array(product_id) FROM (
                SELECT peer_value.product_id FROM rec_values AS source_value
                LEFT JOIN product_attribute_values AS peer_value
                    ON peer_value.attribute_id = source_value.attribute_id AND peer_value.value = source_value.value
                   AND peer_value.product_id <= (SELECT MAX(first_value.product_id) FROM (
                       SELECT cutoff.product_id FROM product_attribute_values AS cutoff
                       WHERE cutoff.attribute_id = source_value.attribute_id AND cutoff.value = source_value.value
                       ORDER BY cutoff.product_id LIMIT ${n(RELATED_CANDIDATES_PER_SIGNAL)}
                   ) AS first_value)
                GROUP BY peer_value.product_id
                ORDER BY COUNT(*) DESC, peer_value.product_id LIMIT ${n(RELATED_CANDIDATES_PER_SIGNAL)}
            ) AS attribute_peer) AS value_peers,
            band.min_price AS band_min, band.max_price AS band_max
        FROM (
            SELECT MIN(${bandPrice}) AS min_price, MAX(${bandPrice}) AS max_price
            FROM product_variants AS band_sku
            INNER JOIN products AS band_product ON band_product.id = band_sku.product_id
            WHERE band_sku.product_id IN (SELECT product_id FROM rec_source)
              AND band_sku.deleted_at IS NULL AND band_sku.id <> 'default'
              AND ${operationalSkuRowPredicate("band_sku")}
        ) AS band`);
    // The source products' latest order lines (order_items_product_recent_idx),
    // then their real orders' time and buyer by primary key (the LEFT JOIN
    // keeps the bounded sample outer; a line of no real order has none); an
    // order's pairs share its buyer.
    const coBuyRead = rankingRead(db, ["co", "also_bought_at"], sql`
        WITH ${recSource},
        rec_source_orders AS MATERIALIZED (
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
            WHERE source_pair.created_at >= ${now} - ${n(ALSO_BOUGHT_WINDOW_SECONDS)}
        )
        SELECT (SELECT json_group_array(json_object('product_id', product_id, 'buyers', buyers)) FROM (
                SELECT peer.product_id, COUNT(DISTINCT peer.buyer) AS buyers
                FROM recommendation_order_products AS peer
                WHERE peer.order_id IN (SELECT order_id FROM rec_source_orders)
                  AND peer.product_id NOT IN (SELECT product_id FROM rec_source)
                GROUP BY peer.product_id
            ) AS co) AS co,
            (SELECT MIN(created_at) FROM rec_source_orders) + ${n(ALSO_BOUGHT_WINDOW_SECONDS + 1)} AS also_bought_at`);
    // Round trip 2: the pool (the source sets as JSON, and their categories'
    // newest products), each candidate's signals and score, ranked.
    const affinity = (row: string) => sql.raw(`${row}.related
        + CASE WHEN ${row}.related > 0 OR ${row}.also_bought > 0 THEN 15 * ${row}.in_band ELSE 0 END`);
    const ranking = (row: string) => sql`CASE WHEN ${sql.raw(row)}.also_bought >= ${n(MIN_ALSO_BOUGHT_BUYERS)}
            THEN ${sql.raw(row)}.also_bought ELSE 0 END DESC,
        ${affinity(row)} DESC, ${sql.raw(row)}.popular_ordering DESC, ${sql.raw(row)}.created_at DESC, ${sql.raw(row)}.id`;
    const scoring = (links: Row, values: Row, coBuy: Row, peers: Row, popularity: SourcePopularity) => rankingRead(db, ["id", "also_bought", "related", "popular_buyers", "popular_ordering"], sql`
        WITH ${recSource},
        rec_co AS (${jsonRows(coBuy.co, { product_id: "text", buyers: "bigint" })}),
        rec_popular AS (SELECT * FROM (${jsonRows(popularity.popular, { product_id: "text", buyers: "bigint", created_at: "bigint" })}) AS popular_entry
            WHERE popular_entry.product_id NOT IN (SELECT product_id FROM rec_source)),
        rec_categories AS (${jsonRows(links.categories, { id: "text" })}),
        rec_collection_links AS (${jsonRows(links.links, { collection_id: "text", product_id: "text", category_id: "text" })}),
        rec_values AS (${jsonRows(values.vals, { attribute_id: "text", value: "text" })}),
        rec_pool AS (
            SELECT product_id FROM (
                SELECT product_id FROM rec_co ORDER BY buyers DESC, product_id LIMIT ${n(RELATED_CANDIDATES_PER_SIGNAL)}
            ) AS co_peer
            UNION SELECT product_id FROM rec_collection_links WHERE product_id IS NOT NULL
            UNION SELECT product_id FROM (${jsonIds(peers.newest_peers)}) AS category_peer
            UNION SELECT product_id FROM (${jsonIds(values.value_peers)}) AS attribute_peer
        ),
        rec_tail AS (
            SELECT product_id FROM (
                SELECT product_id FROM rec_popular ORDER BY buyers DESC, created_at DESC, product_id LIMIT ${n(limit)}
            ) AS popular_tail
            UNION SELECT product_id FROM (${jsonIds(popularity.newest)}) AS newest_tail
        ),
        -- Each pooled product with its co-buy and popularity counts: one grouped
        -- pass over the bounded sets, never a lookup into them per candidate.
        rec_signals AS (
            SELECT product_id, MAX(pooled) AS pooled, MAX(co_buyers) AS co_buyers, MAX(popular_buyers) AS popular_buyers
            FROM (
                -- The related pool is capped as a whole too.
                SELECT product_id, 1 AS pooled, 0 AS co_buyers, 0 AS popular_buyers FROM (
                    SELECT product_id FROM rec_pool ORDER BY product_id LIMIT ${n(RELATED_CANDIDATE_LIMIT)}
                ) AS related
                UNION ALL SELECT product_id, 1, 0, 0 FROM rec_tail
                UNION ALL SELECT product_id, 0, buyers, 0 FROM rec_co
                UNION ALL SELECT product_id, 0, 0, buyers FROM rec_popular
            ) AS signal
            GROUP BY product_id
        ),
        rec_scored AS (
            SELECT candidate.product_id AS id, candidate.product_created_at AS created_at,
                pool.co_buyers AS also_bought,
                40 * CASE WHEN candidate.category_id IN (SELECT id FROM rec_categories) THEN 1 ELSE 0 END
                + 25 * MIN((SELECT COUNT(DISTINCT shared.collection_id) FROM (
                    SELECT collection_id FROM rec_collection_links WHERE product_id = candidate.product_id
                    UNION ALL SELECT collection_id FROM rec_collection_links WHERE category_id = candidate.category_id
                ) AS shared), 2)
                + 10 * MIN((SELECT COUNT(DISTINCT shared.attribute_id) FROM product_attribute_values AS shared
                    INNER JOIN rec_values ON rec_values.attribute_id = shared.attribute_id AND rec_values.value = shared.value
                    WHERE shared.product_id = candidate.product_id), 5)
                + CASE WHEN pool.co_buyers = 1 THEN 20 ELSE 0 END AS related,
                CASE WHEN CAST(${values.band_min ?? null} AS bigint) IS NOT NULL
                    AND candidate.from_minor * 100 >= CAST(${values.band_min ?? null} AS bigint) * 60
                    AND candidate.from_minor * 100 <= CAST(${values.band_max ?? null} AS bigint) * 140 THEN 1 ELSE 0 END AS in_band,
                pool.popular_buyers,
                CASE WHEN CAST(${count(popularity.popular_switch)} AS bigint) = 1 AND pool.popular_buyers >= ${n(MIN_POPULAR_BUYERS)}
                    THEN pool.popular_buyers ELSE 0 END AS popular_ordering
            FROM rec_signals AS pool
            INNER JOIN product_buyer_state AS candidate ON candidate.product_id = pool.product_id
            WHERE pool.pooled = 1 AND ${eligible("candidate", true)}
        )
        SELECT id, also_bought, related, popular_buyers, popular_ordering
        FROM rec_scored ORDER BY ${ranking("rec_scored")} LIMIT ${n(limit)}`);
    /** The ranked rows, and when the ranking stops being exact (its windows' first order ages out). */
    const finish = (rows: Row[], coBuy: Row, popularity: BatchPopularity) => {
        // Inclusive windows stop including an order one second after its boundary.
        // An empty, quiet store has no deadline, never a routine TTL.
        const exits = [popularity.popular_at, coBuy.also_bought_at]
            .filter((at) => at !== null && at !== undefined).map(Number);
        return {
            validUntil: exits.length > 0 ? Math.min(...exits) * 1000 : null,
            rows: rows.map((row): RankedRecommendationRow => ({
                id: String(row.id), alsoBoughtBuyers: count(row.also_bought), relatedScore: count(row.related),
                popularBuyers: count(row.popular_buyers), popularOrdering: count(row.popular_ordering),
            })),
        };
    };
    return { reads: [linksRead, valuesRead, coBuyRead, peersRead] as const, scoring, finish };
}

/**
 * The ranking for up to `limit` rows (the request path caps it at 12; the
 * refresh job stores 24). It scores only a bounded candidate pool: the most
 * co-bought peers of the source's latest orders, the newest eligible
 * products of the source and collection-rule categories, manual collection
 * members and the first products sharing each source attribute value
 * (RELATED_CANDIDATES_PER_SIGNAL each), plus the `limit` most popular and
 * newest eligible products. The unrelated tail orders by popularity, then
 * newest, so those last two parts make it exact. Card columns are read
 * afterwards for the few rows kept (`loadRecommendationCards`). Internal to
 * the catalog domain.
 *
 * Two round trips, each statement far from SQLite's limit on CTE expansion
 * (one statement re-expanded every source set at each of its uses, and
 * SQLite 3.54.1 refused it): one batch reads each set once, as one row of
 * JSON (the source's categories and collection links; its attribute values,
 * their first products and its price band; co-purchases; its categories'
 * newest products), and the window's popularity and newest products once
 * for every ranking of the batch; the second binds each ranking only the
 * entries its pool and tail can read (`scoringInputs`) and scores the pool.
 * Only the background refresh ranks, after the response.
 */
export async function rankRecommendationRows(
    db: Database,
    sourceIds: readonly string[],
    limit: number,
): Promise<RankedRecommendationRow[]> {
    const [ranking] = await rankRecommendationLists(db, [sourceIds], limit);
    if (ranking!.validUntil !== null) deps.validUntil(ranking!.validUntil);
    return ranking!.rows;
}

/**
 * Several rankings (the refresh's products), RANKING_BATCH_SOURCES at a
 * time: every ranking's source reads in one batch, then every scoring in one.
 */
export async function rankRecommendationLists(
    db: Database,
    sourceSets: readonly (readonly string[])[],
    limit: number,
): Promise<Array<{ rows: RankedRecommendationRow[]; validUntil: number | null }>> {
    deps.listMembership("all");
    // Any candidate may enter the result when its price score or buyability changes.
    deps.listOrder("price", "all");
    deps.listOrder("band", "all");
    declareRequestedProducts(sourceSets.flat());
    deps.anyCategory();
    deps.anyCollection();
    deps.anyAttribute();
    const rankings: Array<{ rows: RankedRecommendationRow[]; validUntil: number | null }> = [];
    for (let start = 0; start < sourceSets.length; start += RANKING_BATCH_SOURCES) {
        const batchSources = sourceSets.slice(start, start + RANKING_BATCH_SOURCES);
        const plans = batchSources.map((sourceIds) => rankingStatements(db, sourceIds, limit));
        const widest = Math.max(0, ...batchSources.map((sourceIds) => new Set(sourceIds).size));
        const read = await db.batch([batchPopularityRead(db, limit + widest), ...plans.flatMap((plan) => plan.reads)] as never) as unknown as Row[][];
        // Each read is one row of JSON aggregates.
        const shared = read[0]![0] ?? {};
        const popularity: BatchPopularity = {
            popular: parsedJson<PopularEntry>(shared.popular).map((row) => ({ ...row, buyers: count(row.buyers), created_at: count(row.created_at), rank: count(row.rank) })),
            newest: parsedJson<{ product_id: string; rank: number }>(shared.newest).map((row) => ({ ...row, rank: count(row.rank) })),
            popular_at: shared.popular_at,
        };
        const sets = plans.map((_, index) => {
            const [links, values, coBuy, peers] = read.slice(1 + index * 4, 5 + index * 4).map((rows) => rows[0] ?? {}) as [Row, Row, Row, Row];
            return { coBuy, values, scored: scoringInputs(popularity, batchSources[index]!, limit, links, values, coBuy, peers) };
        });
        const scored = await db.batch(plans.map((plan, index) => {
            const set = sets[index]!;
            return plan.scoring(set.scored.links, set.values, set.scored.coBuy, set.scored.peers, set.scored.popularity);
        }) as never) as unknown as Row[][];
        plans.forEach((plan, index) => rankings.push(plan.finish(scored[index]!, sets[index]!.coBuy, popularity)));
    }
    return rankings;
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
            ...translationColumns(translation, "product", products.id, { fields: PRODUCT_CARD_FIELDS }),
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

/** The list reason of ranked rows ("at least half" rules). Internal to the catalog domain. */
export function recommendationReason(
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
            ...translationColumns(translation, "product", products.id, { fields: PRODUCT_CARD_FIELDS }),
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
 * Source categories the fallback reads (D1 allows five terms in a compound
 * SELECT: three category windows, the best sellers and the newest), and the
 * newest products it reads from each.
 */
const FALLBACK_CATEGORY_LIMIT = 3;
const FALLBACK_CATEGORY_WINDOW = 48;
/** Units sold in 30 days (`product_sales_stats`) before the fallback calls a product popular (home-lists.ts). */
const FALLBACK_MIN_POPULAR_UNITS = 2;

type FallbackRow = {
    kind: "source" | "category" | "candidate";
    productId: string;
    inCategory: number;
    soldUnits: number;
    createdAt: number;
    available: number;
};

/**
 * The fallback ranking, one statement of fixed-size index ranges: the newest
 * public products of up to three source categories (48 each), the public best
 * sellers and the newest public products (`window` each). It never reads
 * orders, so an order never changes it; ranked same category, then units sold
 * in 30 days, then newest, then id. `publicSources` are the sources that are
 * public products (the ones worth queueing for a stored list).
 */
async function rankFallbackRows(
    db: Database,
    sourceIds: readonly string[],
    exclude: ReadonlySet<string>,
    limit: number,
): Promise<{ rows: RankedRecommendationRow[]; publicSources: string[] }> {
    declareRequestedProducts(sourceIds);
    const n = (value: number) => sql.raw(String(value));
    const window = n(limit + exclude.size + sourceIds.length);
    const categoryWindow = (slot: number) => sql`SELECT product_id FROM (
            SELECT peer.product_id FROM product_buyer_state AS peer
            WHERE peer.is_public = 1
              AND peer.category_id = (SELECT id FROM fb_categories ORDER BY id LIMIT 1 OFFSET ${n(slot)})
            ORDER BY peer.product_created_at DESC, peer.product_id LIMIT ${n(FALLBACK_CATEGORY_WINDOW)}
        ) AS category_${n(slot)}`;
    const rows = await db.all<FallbackRow>(sql`
        WITH fb_source AS MATERIALIZED (
            SELECT DISTINCT CAST(value AS TEXT) AS product_id FROM json_each(${JSON.stringify(sourceIds)})
        ),
        fb_source_state AS MATERIALIZED (
            SELECT source_state.product_id, source_state.category_id, source_state.is_public
            FROM product_buyer_state AS source_state
            WHERE source_state.product_id IN (SELECT product_id FROM fb_source)
        ),
        fb_categories AS MATERIALIZED (
            SELECT DISTINCT category_id AS id FROM fb_source_state WHERE category_id IS NOT NULL
            ORDER BY category_id LIMIT ${n(FALLBACK_CATEGORY_LIMIT)}
        ),
        fb_window AS (
            ${sql.join(Array.from({ length: FALLBACK_CATEGORY_LIMIT }, (_, slot) => categoryWindow(slot)), sql` UNION `)}
            -- The popularity index drives; the public flag stays a filter (home-lists.ts).
            UNION SELECT product_id FROM (
                SELECT stats.product_id FROM product_sales_stats AS stats
                INNER JOIN product_buyer_state AS popular_state ON popular_state.product_id = stats.product_id
                WHERE stats.sold_30d >= ${n(FALLBACK_MIN_POPULAR_UNITS)} AND +popular_state.is_public = 1
                ORDER BY stats.sold_30d DESC, stats.product_id LIMIT ${window}
            ) AS best_sellers
            UNION SELECT product_id FROM (
                SELECT newest.product_id FROM product_buyer_state AS newest WHERE newest.is_public = 1
                ORDER BY newest.product_created_at DESC, newest.product_id LIMIT ${window}
            ) AS newest_window
        )
        SELECT 'category' AS "kind", id AS "productId", 0 AS "inCategory", 0 AS "soldUnits",
            0 AS "createdAt", 0 AS "available"
        FROM fb_categories
        UNION ALL
        SELECT 'source', product_id, 0, 0, 0, 0 FROM fb_source_state WHERE is_public = 1
        UNION ALL
        SELECT 'candidate', candidate.product_id,
            CASE WHEN candidate.category_id IN (SELECT id FROM fb_categories) THEN 1 ELSE 0 END,
            CASE WHEN stats.sold_30d >= ${n(FALLBACK_MIN_POPULAR_UNITS)} THEN stats.sold_30d ELSE 0 END,
            CAST(candidate.product_created_at AS INTEGER),
            CASE WHEN candidate.is_public = 1 AND candidate.available_for_sale = 1 THEN 1 ELSE 0 END
        FROM fb_window AS pool
        INNER JOIN product_buyer_state AS candidate ON candidate.product_id = pool.product_id
        LEFT JOIN product_sales_stats AS stats ON stats.product_id = pool.product_id
    `);
    // Which products each window holds (the source categories', the public
    // newest) and their order by units sold; every product read, shown or
    // not, since a change to it alone can show it.
    for (const row of rows) if (row.kind === "category") deps.listMembership(categoryScope(row.productId));
    deps.listMembership("all");
    deps.popular();
    const candidates = rows.filter((row) => row.kind === "candidate");
    deps.products(candidates.map((row) => row.productId));
    const publicSources = rows.filter((row) => row.kind === "source").map((row) => row.productId);
    const ranked = candidates
        .filter((row) => Number(row.available) === 1 && !exclude.has(row.productId))
        .sort((a, b) => Number(b.inCategory) - Number(a.inCategory)
            || Number(b.soldUnits) - Number(a.soldUnits)
            || Number(b.createdAt) - Number(a.createdAt)
            || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0))
        .slice(0, limit)
        .map((row) => ({
            id: row.productId,
            alsoBoughtBuyers: 0,
            relatedScore: Number(row.inCategory) === 1 ? 40 : 0,
            popularBuyers: Number(row.soldUnits),
            popularOrdering: Number(row.soldUnits),
        }));
    return { rows: ranked, publicSources };
}

type PickedRecommendation = { id: string; reason: ProductRecommendationReason };

/**
 * The sources' stored lists merged by position (each source's first row,
 * then each one's second...), without the sources themselves, to products
 * still public and buyable. One statement by primary key, at most 24 rows a
 * source; `missing` are sources without a stored list.
 */
async function readStoredRecommendationIds(
    db: Database,
    sourceIds: readonly string[],
    limit: number,
): Promise<{ picked: PickedRecommendation[]; missing: string[] }> {
    for (const id of sourceIds) deps.recommendations(id);
    const stored = await db
        .select({
            source: productRecommendations.productId,
            position: productRecommendations.position,
            id: productRecommendations.recommendedProductId,
            reason: productRecommendations.reason,
            isPublic: buyerState.isPublic,
            availableForSale: buyerState.availableForSale,
        })
        .from(productRecommendations)
        .leftJoin(buyerState, eq(buyerState.productId, productRecommendations.recommendedProductId))
        .where(sql`${productRecommendations.productId} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(sourceIds)}))`)
        .all();
    // A stored product hidden now shows again when its own buyer state changes.
    deps.products(stored.map((row) => row.id));
    const order = new Map(sourceIds.map((id, index) => [id, index]));
    const sources = new Set(sourceIds);
    const seen = new Set<string>();
    const picked: PickedRecommendation[] = [];
    for (const row of [...stored].sort((a, b) => a.position - b.position
        || (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0))) {
        if (picked.length >= limit) break;
        if (sources.has(row.id) || seen.has(row.id) || !row.isPublic || !row.availableForSale) continue;
        seen.add(row.id);
        picked.push({ id: row.id, reason: row.reason as ProductRecommendationReason });
    }
    const withRows = new Set(stored.map((row) => row.source));
    return { picked, missing: sourceIds.filter((id) => !withRows.has(id)) };
}

/**
 * Fills a list short of `limit` from the fallback (a source without a list,
 * a cart of its own peers, or no sources), and queues the `missing` sources
 * that are public products for the stored refresh.
 */
async function withFallback(
    db: Database,
    sourceIds: readonly string[],
    picked: PickedRecommendation[],
    limit: number,
    missing: readonly string[],
): Promise<PickedRecommendation[]> {
    const exclude = new Set([...sourceIds, ...picked.map((row) => row.id)]);
    const fill = await rankFallbackRows(db, sourceIds, exclude, limit - picked.length);
    const publicSources = new Set(fill.publicSources);
    requestRecommendationRefresh(missing.filter((id) => publicSources.has(id)));
    return [...picked, ...fill.rows.map((row) => ({ id: row.id, reason: recommendationRowReason(row) }))];
}

/** The list reason of picked rows, by the live ranking's "at least half" rules. */
function pickedReason(picked: readonly PickedRecommendation[], hasSources: boolean): ProductRecommendationReason {
    return recommendationReason(picked.map((row) => ({
        id: row.id,
        alsoBoughtBuyers: row.reason === "also_bought" ? MIN_ALSO_BOUGHT_BUYERS : 0,
        relatedScore: row.reason === "similar" ? 1 : 0,
        popularBuyers: 0,
        popularOrdering: row.reason === "popular" ? 1 : 0,
    })), hasSources);
}

/**
 * Which products to recommend (ids and reason, no cards): stored lists, then
 * the fallback for sources without one (queued for the refresh) or for no
 * sources. Never the live ranking.
 */
export async function recommendedProductIds(
    db: Database,
    input: ProductRecommendationInput,
): Promise<{ reason: ProductRecommendationReason; ids: string[] }> {
    const sourceIds = normalizeRecommendationSourceIds(input.productIds);
    const limit = normalizeLimit(input.limit);
    let picked: PickedRecommendation[] = [];
    let missing: string[] = [];
    if (sourceIds.length > 0) {
        const stored = await readStoredRecommendationIds(db, sourceIds, limit);
        picked = stored.picked;
        missing = stored.missing;
        // The stored lists fill it: the fallback is not read (nor declared).
        if (picked.length >= limit) {
            // Sources without a list are queued (the queue keeps only public products).
            requestRecommendationRefresh(missing);
            return { reason: pickedReason(picked, true), ids: picked.map((row) => row.id) };
        }
    }
    picked = await withFallback(db, sourceIds, picked, limit, missing);
    return { reason: pickedReason(picked, sourceIds.length > 0), ids: picked.map((row) => row.id) };
}

/**
 * Recommendations as product cards. One source product reads its stored
 * list and then its card media (two statements, two waves). Several sources
 * read their stored ids; a source without a list, or no source, adds the
 * fallback; then the kept rows' cards and media are read together.
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
        let ids: string[];
        if (sourceIds.length === 1) {
            // Never computed: serve the fallback until its list is stored
            // (rec:<id>), and queue it when it is a public product.
            const picked = await withFallback(db, sourceIds, [], limit, sourceIds);
            reason = pickedReason(picked, true);
            ids = picked.map((row) => row.id);
        } else {
            ({ reason, ids } = await recommendedProductIds(db, { productIds: sourceIds, limit }));
        }
        if (ids.length === 0) return { reason, products: [] };
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
