// Home at scale (migration 0128): the month totals and the daily activity
// sum a period of orders from orders_sales_rollup_idx alone. Reading the
// wide order rows instead took 9.7 s (totals) and 24 s (90 days) on a
// million orders. D1 keeps no table statistics, so an empty database plans
// exactly as a large store.
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { CapturedQuery } from "../../testing/list-plans";
import { getDailyActivityData, getDashboardHomeSummary } from "./dashboard.service";

const harnesses: Array<{ sqlite: DatabaseSync }> = [];
afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

function orderPlans(sqlite: DatabaseSync, queries: readonly CapturedQuery[]): string[][] {
    return queries
        .filter(({ query }) => /from "orders"/.test(query) && /sum\(case when "status"/.test(query))
        .map(({ query, values }) => (sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...(values as never[])) as Array<{ detail: string }>)
            .map((row) => row.detail));
}

describe("dashboard home plans (migration 0128)", () => {
    it("sums the month and the daily activity from the sales rollup index alone", async () => {
        const queries: CapturedQuery[] = [];
        const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
        harnesses.push(harness);
        await getDashboardHomeSummary(harness.db, 10, "Asia/Dhaka");
        await getDailyActivityData(harness.db, 90, "Asia/Dhaka");
        const plans = orderPlans(harness.sqlite, queries);
        expect(plans).toHaveLength(3);
        for (const plan of plans) {
            expect(plan[0]).toMatch(/^SEARCH orders USING COVERING INDEX orders_sales_rollup_idx \(deleted_at=\? AND created_at>\?/);
        }
    });
});
