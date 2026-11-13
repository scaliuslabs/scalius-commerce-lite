// Test-only: the recommendation ranking as one statement, before it was split
// into two round trips (SQLite 3.54.1 refused it: CTE expansion). Frozen as the
// oracle of recommendations-ranking.oracle.d1.test.ts; never call it elsewhere.
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { effectivePriceMinorSql, operationalSkuRowPredicate } from "../modules/products";
import { publishedCategoryIdSet } from "../modules/catalog/shared";
import { declareRequestedProducts, deps } from "../modules/catalog/declare-deps";
import {
    ALSO_BOUGHT_SOURCE_ORDERS,
    MIN_ALSO_BOUGHT_BUYERS,
    MIN_POPULAR_BUYERS,
    POPULAR_SAMPLE_PAIRS,
    RELATED_CANDIDATE_LIMIT,
    RELATED_CANDIDATES_PER_SIGNAL,
} from "../modules/catalog/recommendations";

const ALSO_BOUGHT_WINDOW_SECONDS = 365 * 86_400;
const POPULAR_WINDOW_SECONDS = 30 * 86_400;

type RankedRecommendationRow = { id: string; alsoBoughtBuyers: number; relatedScore: number; popularBuyers: number; popularOrdering: number };

function collectionIdList(configColumn: string, key: "productIds" | "categoryIds"): SQL {
    return sql.raw(`json_each(CASE WHEN json_valid(${configColumn}) THEN CASE WHEN json_type(${configColumn}, '$.${key}') = 'array' THEN ${configColumn} ELSE '{"${key}":[]}' END ELSE '{"${key}":[]}' END, '$.${key}')`);
}

function activeCollectionSql(collection: string, dynamic: boolean): string {
    const source = `COALESCE(CASE WHEN json_valid(${collection}.config) THEN json_extract(${collection}.config, '$.source') END, 'manual')`;
    return `${collection}.is_active = 1 AND ${collection}.deleted_at IS NULL AND ${source} ${dynamic ? "=" : "<>"} 'dynamic'`;
}

export async function oracleRankRecommendationRows(
    db: Database,
    sourceIds: readonly string[],
    limit: number,
): Promise<RankedRecommendationRow[]> {
    // Private order signals (orders, order lines, recommendation_order_products)
    // carry no key: only the background refresh ranks, outside any request
    // scope, and stores the result under rec:<id>.
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
        WITH rec_source AS MATERIALIZED (
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
        rec_source_orders AS MATERIALIZED (
            SELECT order_id, created_at, buyer FROM rec_source_lines
            WHERE created_at >= ${now} - ${n(ALSO_BOUGHT_WINDOW_SECONDS)}
        ),
        -- An order's pairs share its buyer.
        rec_co AS MATERIALIZED (
            SELECT peer.product_id, COUNT(DISTINCT peer.buyer) AS buyers
            FROM recommendation_order_products AS peer
            WHERE peer.order_id IN (SELECT order_id FROM rec_source_orders)
              AND peer.product_id NOT IN (SELECT product_id FROM rec_source)
            GROUP BY peer.product_id
        ),
        -- The popularity window's latest order/product pairs.
        rec_popular_sample AS MATERIALIZED (
            SELECT sample.product_id, sample.buyer, sample.created_at
            FROM recommendation_order_products AS sample
            WHERE sample.created_at >= ${now} - ${n(POPULAR_WINDOW_SECONDS)}
            ORDER BY sample.created_at DESC, sample.product_id DESC, sample.buyer DESC
            LIMIT ${n(POPULAR_SAMPLE_PAIRS)}
        ),
        rec_popular AS MATERIALIZED (
            SELECT popular.product_id, COUNT(DISTINCT popular.buyer) AS buyers,
                MIN(buyer_state.product_created_at) AS created_at
            FROM rec_popular_sample AS popular
            INNER JOIN product_buyer_state AS buyer_state ON buyer_state.product_id = popular.product_id
            WHERE ${eligible("buyer_state", true)}
            GROUP BY popular.product_id
        ),
        -- Popularity orders the tail only when it can fill at least half the list.
        rec_switch AS MATERIALIZED (
            SELECT CASE WHEN 2 * (SELECT COUNT(*) FROM (
                SELECT 1 FROM rec_popular WHERE buyers >= ${n(MIN_POPULAR_BUYERS)} LIMIT ${n(Math.ceil(limit / 2))}
            ) AS witness) >= (SELECT COUNT(*) FROM (
                SELECT 1 FROM product_buyer_state AS population WHERE ${eligible("population")} LIMIT ${n(limit)}
            ) AS population_sample) THEN 1 ELSE 0 END AS popular
        ),
        rec_band AS MATERIALIZED (
            SELECT MIN(${bandPrice}) AS min_price, MAX(${bandPrice}) AS max_price
            FROM product_variants AS band_sku
            INNER JOIN products AS band_product ON band_product.id = band_sku.product_id
            WHERE band_sku.product_id IN (SELECT product_id FROM rec_source)
              AND band_sku.deleted_at IS NULL AND band_sku.id <> 'default'
              AND ${operationalSkuRowPredicate("band_sku")}
        ),
        rec_categories AS MATERIALIZED (
            SELECT DISTINCT source_product.category_id AS id
            FROM products AS source_product
            WHERE source_product.id IN (SELECT product_id FROM rec_source)
              AND source_product.category_id IN ${publishedCategoryIdSet(sql`1 = 1`)}
        ),
        -- Each active collection holding a source: its manual ids, or its published rule categories.
        rec_collection_links AS MATERIALIZED (
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
        rec_values AS MATERIALIZED (
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
            UNION SELECT product_id FROM (
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
            ) AS attribute_peer
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
                CASE WHEN rec_band.min_price IS NOT NULL
                    AND candidate.from_minor * 100 >= rec_band.min_price * 60
                    AND candidate.from_minor * 100 <= rec_band.max_price * 140 THEN 1 ELSE 0 END AS in_band,
                pool.popular_buyers,
                CASE WHEN rec_switch.popular = 1 AND pool.popular_buyers >= ${n(MIN_POPULAR_BUYERS)}
                    THEN pool.popular_buyers ELSE 0 END AS popular_ordering
            FROM rec_signals AS pool
            INNER JOIN product_buyer_state AS candidate ON candidate.product_id = pool.product_id
            CROSS JOIN rec_band
            CROSS JOIN rec_switch
            WHERE pool.pooled = 1 AND ${eligible("candidate", true)}
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

