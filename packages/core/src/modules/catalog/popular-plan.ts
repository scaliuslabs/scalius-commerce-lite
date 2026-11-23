// The `popular` listing order: products with MIN_POPULAR_UNITS or more sold
// in 30 days (`product_sales_stats.sold_30d`, refreshed nightly) first, by
// units then product id (the home "popular" list's order), then the rest
// newest first. Its key is two values, the tier (1 popular, 0 the rest) and
// the tier's value (units, or the creation time), so a cursor carries them
// without assuming any unit of either.
//
// A page picks its first `offset + limit + 1` ids in one of two forms:
//
// - driven: the set (a scope, or the products of a facet value) read whole
//   through its own index, each row's stats by primary key, then sorted;
// - walking: the popularity index (`product_sales_stats_popular_idx`) until
//   enough rows of the set, each row's buyer state by primary key, merged
//   with the newest page of the rest (the set's own newest walk).
//
// With both forms the plan reads the set's maintained size S against T
// public products and stays driven while 3 S² <= 2 n T (n the rows needed),
// the narrowed shop-all plan's rule (listing-plan.ts): driven costs about S
// rows, walking about n T / S. A CASE evaluates only the form it takes.
import { productSalesStats, products } from "@scalius/database/schema";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { MIN_POPULAR_UNITS } from "@scalius/shared/listing-sorts";
import type { ListCursor } from "@scalius/shared/pagination";
import { allOf } from "../../utils/all-of";
import { keysetCondition } from "../../utils/keyset";
import { buyerState, publicBuyerStateCondition } from "./buyer-state";

const UNITS = sql.raw(String(MIN_POPULAR_UNITS));

/** The tier and its value of a row: (1, units) for a popular product, (0, creation time) for the rest. */
function popularityTier(sold: SQLWrapper): SQL<number> {
    return sql<number>`CASE WHEN ${sold} >= ${UNITS} THEN 1 ELSE 0 END`;
}
function popularityValue(sold: SQLWrapper, createdAt: SQLWrapper): SQL<number> {
    return sql<number>`CASE WHEN ${sold} >= ${UNITS} THEN ${sold} ELSE ${createdAt} END`;
}

/** Whether a product is in the popular tier, probed by primary key. */
function isPopular(productId: SQLWrapper): SQL {
    return sql`EXISTS (
        SELECT 1 FROM ${productSalesStats} AS popular_probe
        WHERE popular_probe.product_id = ${productId} AND popular_probe.sold_30d >= ${UNITS}
    )`;
}

/** A `popular` cursor's position: the last row's tier, its value and its id. */
export interface PopularBoundary {
    tier: number;
    value: number;
    id: string;
}

export function popularBoundaryOf(cursor: Pick<ListCursor, "values" | "id">): PopularBoundary {
    return { tier: Number(cursor.values[0]), value: Number(cursor.values[1]), id: cursor.id };
}

export interface PopularPageInput {
    /** The listing's conditions over the unaliased buyer state (and `products`); the first is the public condition. */
    conditions: SQL[];
    needsProducts: boolean;
    /** The driven form's conditions (a facet value's set probed by id); `conditions` by default. Omit `driven` for none. */
    driven?: { conditions?: SQL[] } | null;
    /**
     * The walking form: the first `rows` ids (`page_product_id`) of the rest
     * in the set's own newest walk, under the conditions and `extra`. Omit for none.
     */
    rest?: ((extra: Array<SQL | undefined>, rows: number) => SQL) | null;
    /** With both forms: the set's size and the public products, as scalar subqueries. */
    size?: { set: SQL<number>; total: SQL<number> };
    boundary: PopularBoundary | undefined;
    limit: number;
    offset: number;
}

/**
 * A `popular` page (`page_product_id`, `popularity_tier`,
 * `popularity_value`), ordered by tier, value and product id, as a statement
 * for `listingPageOf`.
 */
export function popularPageIds(input: PopularPageInput): SQL {
    const rows = input.offset + input.limit + 1;
    const rowCount = sql.raw(String(rows));
    const joinProducts = input.needsProducts ? sql`INNER JOIN ${products} ON ${products.id} = ${buyerState.productId}` : sql``;
    const boundary = input.boundary;

    const driven = input.driven === null || input.driven === undefined ? null : (() => {
        const tier = popularityTier(productSalesStats.sold30d);
        const value = popularityValue(productSalesStats.sold30d, buyerState.productCreatedAt);
        const cursor = boundary
            ? sql`(${tier} < ${boundary.tier} OR (${tier} = ${boundary.tier} AND (${value} < ${boundary.value}
                OR (${value} = ${boundary.value} AND ${buyerState.productId} > ${boundary.id}))))`
            : undefined;
        return sql`
                SELECT ${buyerState.productId} AS page_product_id FROM ${buyerState}
                ${joinProducts}
                LEFT JOIN ${productSalesStats} ON ${productSalesStats.productId} = ${buyerState.productId}
                WHERE ${allOf([...(input.driven.conditions ?? input.conditions), cursor])}
                ORDER BY ${tier} DESC, ${value} DESC, ${buyerState.productId}
                LIMIT ${rowCount}`;
    })();

    const walking = !input.rest ? null : (() => {
        // A cursor in the rest has passed every popular product. The public
        // test is a filter (`+`): the popularity index drives (D1 has no statistics).
        const popularWalk = boundary && boundary.tier < 1 ? null : sql`
                SELECT popular_top.page_product_id FROM (
                    SELECT ${productSalesStats.productId} AS page_product_id FROM ${productSalesStats}
                    INNER JOIN ${buyerState} ON ${buyerState.productId} = ${productSalesStats.productId}
                    ${joinProducts}
                    WHERE ${allOf([
                        sql`${productSalesStats.sold30d} >= ${UNITS}`,
                        publicBuyerStateCondition({ drivenByIdSet: true }),
                        ...input.conditions.slice(1),
                        boundary && boundary.tier >= 1
                            ? keysetCondition({ column: productSalesStats.sold30d, id: productSalesStats.productId, direction: "desc", idDirection: "asc" },
                                { values: [boundary.value], id: boundary.id })
                            : undefined,
                    ])}
                    ORDER BY ${productSalesStats.sold30d} DESC, ${productSalesStats.productId}
                    LIMIT ${rowCount}
                ) AS popular_top
                UNION ALL`;
        const restCursor = boundary && boundary.tier < 1
            ? keysetCondition({ column: buyerState.productCreatedAt, id: buyerState.productId, direction: "desc", idDirection: "asc" },
                { values: [boundary.value], id: boundary.id })
            : undefined;
        return sql`
                ${popularWalk ?? sql``}
                SELECT newest_rest.page_product_id FROM (
                    ${input.rest!([sql`NOT ${isPopular(buyerState.productId)}`, restCursor], rows)}
                ) AS newest_rest`;
    })();

    const ids = driven && walking && input.size
        ? sql`(
            SELECT CAST(popular_pick.value AS TEXT) AS page_product_id
            FROM (
                SELECT CASE WHEN 3 * popular_plan.set_size * popular_plan.set_size <= 2 * ${rowCount} * popular_plan.total_size
                    THEN (SELECT json_group_array(driven_ids.page_product_id) FROM (${driven}) AS driven_ids)
                    ELSE (SELECT json_group_array(walked_ids.page_product_id) FROM (${walking}) AS walked_ids)
                END AS page_ids
                FROM (SELECT ${input.size.set} AS set_size, ${input.size.total} AS total_size LIMIT 1 OFFSET 0) AS popular_plan
            ) AS popular_choice
            CROSS JOIN json_each(popular_choice.page_ids) AS popular_pick
        ) AS popular_ids`
        : sql`(${walking ?? driven}) AS popular_ids`;
    return sql`
            SELECT popular_ids.page_product_id AS page_product_id,
                ${popularityTier(sql`ranked_sales.sold_30d`)} AS popularity_tier,
                ${popularityValue(sql`ranked_sales.sold_30d`, sql`ranked_state.product_created_at`)} AS popularity_value
            FROM ${ids}
            INNER JOIN ${buyerState} AS ranked_state ON ranked_state.product_id = popular_ids.page_product_id
            LEFT JOIN ${productSalesStats} AS ranked_sales ON ranked_sales.product_id = ranked_state.product_id
            ORDER BY popularity_tier DESC, popularity_value DESC, popular_ids.page_product_id
            LIMIT ${sql.raw(String(input.limit + 1))} OFFSET ${sql.raw(String(input.offset))}`;
}

/** A category set's or brand's maintained public products (`product_facet_scope_counts`). */
export function scopeProductCount(scope: { kind: "category"; categoryIds: SQL } | { kind: "brand"; brandId: string }): SQL<number> {
    return scope.kind === "category"
        ? sql<number>`(SELECT COALESCE(SUM(scope_size.product_count), 0) FROM product_facet_scope_counts AS scope_size
            WHERE scope_size.scope_kind = 'category' AND scope_size.facet_kind = 'products' AND scope_size.scope_id IN ${scope.categoryIds})`
        : sql<number>`(SELECT COALESCE(SUM(scope_size.product_count), 0) FROM product_facet_scope_counts AS scope_size
            WHERE scope_size.scope_kind = 'brand' AND scope_size.facet_kind = 'products' AND scope_size.scope_id = ${scope.brandId})`;
}

/** T: the public products with a category, from the maintained counts (the narrowed plan's and this plan's). */
export function publicProductCount(): SQL<number> {
    return sql<number>`(
            SELECT COALESCE(SUM(plan_count.product_count), 0) FROM product_facet_scope_counts AS plan_count
            WHERE plan_count.scope_kind = 'category' AND plan_count.facet_kind = 'products'
        )`;
}
