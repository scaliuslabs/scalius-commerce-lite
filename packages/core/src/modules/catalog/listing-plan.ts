// How a buyer listing's statements read their page and their narrowed plan,
// without a common table expression: SQLite 3.54.1 (workerd 1.20261106 to
// 1.20261110) refused a CTE reference expanded after the statement had
// allocated 100 cursors, and a price filter with an attribute value made the
// narrowed shop-all summary expand its plan six times past 300. A derived
// table is never checked. The frozen CTE statements are the test oracle
// (testing/listing-plan-oracle.ts).
import { products } from "@scalius/database/schema";
import { sql, type SQL } from "drizzle-orm";
import { allOf } from "../../utils/all-of";
import { buyerState, publicBuyerStateCondition } from "./buyer-state";

/** A narrowed shop-all page reads its own price range up to this many products of its value. */
export const NARROWED_RANGE_DRIVEN_PRODUCTS = 1_000;

/**
 * A listing's page ids as the card statement's first FROM item, picked
 * before any card column is read. The ids statement ends with
 * `LIMIT … OFFSET …`, so neither engine merges it into the card statement
 * (SQLite's flattener refuses a subquery with an OFFSET; PostgreSQL never
 * pulls up a subquery with a LIMIT): the page is chosen first and the card
 * SKU, rating and translation probes read its rows alone.
 */
export function listingPageOf(ids: SQL): SQL {
    return sql`(${ids}) AS listing_page`;
}

export interface NarrowedPlanInput {
    driving: { productIds: SQL; publicCount: SQL<number>; sole: boolean };
    conditions: SQL[];
    drivenConditions: SQL[];
    needsProducts: boolean;
    countLimit: number;
    pageRowsNeeded: number;
    /** The price range reads the value's own rows up to this many of them (NARROWED_RANGE_DRIVEN_PRODUCTS). */
    rangeDrivenProducts: number;
}

export interface NarrowedPlan {
    drivenConditions: SQL[];
    /** The count, the lowest and the highest price of the narrowed rows, plus `extra` columns. */
    summary(extra: SQL): SQL;
    /** The page's ids as the card statement's FROM item (`listing_page.page_product_id`), one form read. */
    page(pageRows: number, ids: (form: "driven" | "walking", rows: SQL) => SQL): SQL;
}

/**
 * Shop-all narrowed by a facet value. Each read (the page, the count, the
 * lowest and the highest price) takes the cheaper of two forms, chosen in
 * SQL from the maintained counts (the value's S public products, and T, the
 * public products with a category):
 *
 * - driven: the value's products, each probed by primary key, then sorted
 *   (about 6 S rows: value rows, buyer state, the other conditions' probes);
 * - walking: the order's index (any public row for the count) until enough
 *   rows match, `needed` of them (about 4 needed T / S rows).
 *
 * Driven while 3 S² <= 2 needed T (the price range: while S <= 1,000, else
 * the public range bounds it). The value's public count is the exact total
 * when it is the only selection (`sole`, nothing else narrows the page);
 * any other count is capped like every list total.
 *
 * The plan (S and T) is one row read once, the statement's only FROM item
 * (`OFFSET 0` keeps either engine from merging it into the reads, where each
 * use would read it again). Each read is a scalar subquery in a CASE on the
 * plan: a CASE evaluates only the branch it takes, so the form not chosen
 * reads nothing. The page's ids travel as one JSON list, as a subtree page's
 * do (`subtreePageIds`), since a page is many rows.
 */
export function narrowedShopAllPlan(input: NarrowedPlanInput): NarrowedPlan {
    const plan = sql`(
        SELECT value_size.products AS value_products, (
            SELECT COALESCE(SUM(plan_count.product_count), 0) FROM product_facet_scope_counts AS plan_count
            WHERE plan_count.scope_kind = 'category' AND plan_count.facet_kind = 'products'
        ) AS public_products
        FROM (SELECT ${input.driving.publicCount} AS products) AS value_size
        LIMIT 1 OFFSET 0
    ) AS listing_plan`;
    // A boolean is a CASE condition on every provider (PostgreSQL compares no boolean with 1).
    const driven = (needed: number) =>
        sql`3 * listing_plan.value_products * listing_plan.value_products <= 2 * ${sql.raw(String(Math.max(1, needed)))} * listing_plan.public_products`;
    const from = input.needsProducts
        ? sql`${buyerState} INNER JOIN ${products} ON ${products.id} = ${buyerState.productId}`
        : sql`${buyerState}`;
    const where = (form: "driven" | "walking") => allOf([...(form === "driven" ? input.drivenConditions : input.conditions)]);
    // The price range: the value's own rows while they are few (driven);
    // past that the public range (one index probe), as the slider's bounds.
    // A walk for the lowest price of a value would read every cheaper public
    // product first: prices and values go together (no 16 GB RAM under the
    // cheapest phone), so no uniform estimate bounds it.
    // Each read is a derived table of its scalar subquery: SQLite counts a
    // scalar subquery's WHERE twice in the depth of the expression it sits in
    // (the price filter's 60 levels would pass D1's 100), a derived table's once.
    const range = (column: SQL, direction: "" | " DESC") => sql`CASE
            WHEN listing_plan.value_products <= ${sql.raw(String(Math.trunc(input.rangeDrivenProducts)))}
            THEN (SELECT driven_bound.value FROM (SELECT ${column} AS value FROM ${from} WHERE ${where("driven")}
                ORDER BY +${column}${sql.raw(direction)} LIMIT 1) AS driven_bound)
            ELSE (SELECT public_bound.value FROM (SELECT ${column} AS value FROM ${buyerState} WHERE ${publicBuyerStateCondition()}
                ORDER BY ${column}${sql.raw(direction)} LIMIT 1) AS public_bound)
        END`;
    const countLimit = sql.raw(String(input.countLimit));
    const count = input.driving.sole
        ? sql`listing_plan.value_products`
        : sql`CASE WHEN ${driven(input.countLimit)}
            THEN (SELECT count(*) FROM (SELECT 1 FROM ${from} WHERE ${where("driven")} LIMIT ${countLimit}) AS driven_rows)
            ELSE (SELECT count(*) FROM (SELECT 1 FROM ${from} WHERE ${where("walking")} LIMIT ${countLimit}) AS walked_rows)
        END`;
    return {
        drivenConditions: input.drivenConditions,
        summary: (extra) => sql`
            SELECT ${count} AS count,
                ${range(sql`${buyerState.fromMinor}`, "")} AS min,
                ${range(sql`${buyerState.toMinor}`, " DESC")} AS max
                ${extra}
            FROM ${plan}`,
        page: (pageRows, ids) => {
            const rows = sql.raw(String(pageRows));
            const listed = (form: "driven" | "walking") =>
                sql`(SELECT json_group_array(${sql.raw(`${form}_page`)}.page_product_id) FROM (${ids(form, rows)}) AS ${sql.raw(`${form}_page`)})`;
            return sql`(
                SELECT CAST(page_id.value AS TEXT) AS page_product_id
                FROM (
                    SELECT CASE WHEN ${driven(input.pageRowsNeeded)} THEN ${listed("driven")} ELSE ${listed("walking")} END AS page_ids
                    FROM ${plan}
                ) AS listing_choice
                CROSS JOIN json_each(listing_choice.page_ids) AS page_id
            ) AS listing_page`;
        },
    };
}
