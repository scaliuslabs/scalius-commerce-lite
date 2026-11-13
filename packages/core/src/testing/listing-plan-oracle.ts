// Test-only: a buyer listing's page and narrowed plan as the common table
// expressions they were (SQLite 3.54.1 refused the narrowed shop-all summary:
// its `listing_plan` CTE expanded six times, 301 cursors with a price filter
// and a colour, 373 with every filter kind). Frozen from listing.ts as the
// oracle of listing-plan.oracle.d1.test.ts and its PostgreSQL twin; never
// call it elsewhere.
import { products } from "@scalius/database/schema";
import { sql, type SQL } from "drizzle-orm";
import { allOf } from "../utils/all-of";
import { buyerState, publicBuyerStateCondition } from "../modules/catalog/buyer-state";
import type * as ListingPlan from "../modules/catalog/listing-plan";
import type { NarrowedPlan, NarrowedPlanInput } from "../modules/catalog/listing-plan";

export function oracleListingPageOf(ids: SQL): SQL {
    return sql`(WITH listing_page AS MATERIALIZED (${ids}) SELECT * FROM listing_page) AS listing_page`;
}

export function oracleNarrowedShopAllPlan(input: NarrowedPlanInput): NarrowedPlan {
    const plan = sql`listing_plan AS MATERIALIZED (
        SELECT value_size.products AS value_products, (
            SELECT COALESCE(SUM(plan_count.product_count), 0) FROM product_facet_scope_counts AS plan_count
            WHERE plan_count.scope_kind = 'category' AND plan_count.facet_kind = 'products'
        ) AS public_products
        FROM (SELECT ${input.driving.publicCount} AS products) AS value_size
    )`;
    const driven = (needed: number) => sql`(3 * value_products * value_products <= 2 * ${sql.raw(String(Math.max(1, needed)))} * public_products)`;
    const rowsFor = (form: "driven" | "walking", needed: number, rows: SQL) =>
        form === "driven"
            ? sql`(SELECT CASE WHEN ${driven(needed)} THEN ${rows} ELSE 0 END FROM listing_plan)`
            : sql`(SELECT CASE WHEN ${driven(needed)} THEN 0 ELSE ${rows} END FROM listing_plan)`;
    const from = input.needsProducts
        ? sql`${buyerState} INNER JOIN ${products} ON ${products.id} = ${buyerState.productId}`
        : sql`${buyerState}`;
    const where = (form: "driven" | "walking") => allOf([...(form === "driven" ? input.drivenConditions : input.conditions)]);
    const fewProducts = sql`(SELECT value_products <= ${sql.raw(String(input.rangeDrivenProducts))} FROM listing_plan)`;
    const range = (name: string, column: SQL, direction: "" | " DESC") => sql`
        LEFT JOIN (SELECT ${column} AS value FROM ${from} WHERE ${where("driven")} ORDER BY +${column}${sql.raw(direction)}
            LIMIT (SELECT CASE WHEN ${fewProducts} THEN 1 ELSE 0 END)) AS ${sql.raw(`${name}_driven`)} ON 1 = 1
        LEFT JOIN (SELECT ${column} AS value FROM ${buyerState} WHERE ${publicBuyerStateCondition()} ORDER BY ${column}${sql.raw(direction)}
            LIMIT (SELECT CASE WHEN ${fewProducts} THEN 0 ELSE 1 END)) AS ${sql.raw(`${name}_public`)} ON 1 = 1`;
    const countLimit = sql.raw(String(input.countLimit));
    const count = input.driving.sole
        ? { value: sql`(SELECT value_products FROM listing_plan)`, from: sql`(SELECT 1 AS summary_row) AS summary_anchor` }
        : {
            value: sql`driven_count.products + walked_count.products`,
            from: sql`(SELECT count(*) AS products FROM (SELECT 1 FROM ${from} WHERE ${where("driven")} LIMIT ${rowsFor("driven", input.countLimit, countLimit)}) AS driven_rows) AS driven_count
            CROSS JOIN (SELECT count(*) AS products FROM (SELECT 1 FROM ${from} WHERE ${where("walking")} LIMIT ${rowsFor("walking", input.countLimit, countLimit)}) AS walked_rows) AS walked_count`,
        };
    return {
        drivenConditions: input.drivenConditions,
        summary: (extra) => sql`WITH ${plan}
            SELECT ${count.value} AS count,
                COALESCE(lowest_driven.value, lowest_public.value) AS min,
                COALESCE(highest_driven.value, highest_public.value) AS max
                ${extra}
            FROM ${count.from}
            ${range("lowest", sql`${buyerState.fromMinor}`, "")}
            ${range("highest", sql`${buyerState.toMinor}`, " DESC")}`,
        page: (pageRows, ids) => {
            const rows = sql.raw(String(pageRows));
            return sql`(WITH ${plan},
            listing_page AS MATERIALIZED (
                SELECT * FROM (${ids("driven", rowsFor("driven", input.pageRowsNeeded, rows))}) AS driven_page
                UNION ALL
                SELECT * FROM (${ids("walking", rowsFor("walking", input.pageRowsNeeded, rows))}) AS walking_page
            )
            SELECT * FROM listing_page) AS listing_page`;
        },
    };
}

/**
 * Which statements the listing builds: the frozen ones (`oracle`), and with
 * `tight` a small count cap and range threshold for both, so a test-sized
 * catalogue reaches the walked count and the public price range too.
 */
export interface ListingPlanSwitch {
    oracle: boolean;
    tight: boolean;
}

/** The ./listing-plan module a test mocks: the live functions or the frozen ones, by `state`. */
export function switchedListingPlan(actual: typeof ListingPlan, state: ListingPlanSwitch): typeof ListingPlan {
    return {
        ...actual,
        listingPageOf: (ids) => (state.oracle ? oracleListingPageOf : actual.listingPageOf)(ids),
        narrowedShopAllPlan: (input) => {
            const tuned = state.tight ? { ...input, countLimit: 7, rangeDrivenProducts: 6 } : input;
            return (state.oracle ? oracleNarrowedShopAllPlan : actual.narrowedShopAllPlan)(tuned);
        },
    };
}
