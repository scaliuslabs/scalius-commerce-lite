// The review moderation queue at scale (migration 0127): the All tab reads
// its page newest first from `product_reviews_created_idx`, never sorting
// every review (a 100,000-review store); a status tab from its status index.
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { type CapturedQuery, SORTS_THE_TABLE } from "../../testing/list-plans";
import { listAdminReviews } from "./staff";

const harnesses: Array<{ sqlite: DatabaseSync }> = [];
afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

describe("review queue plans (migration 0127)", () => {
    for (const [label, filters, index] of [
        ["All", {}, "product_reviews_created_idx"],
        ["Pending", { status: "pending" as const }, "product_reviews_status_list_idx"],
    ] as const) {
        it(`reads the ${label} tab newest first from ${index}`, async () => {
            const queries: CapturedQuery[] = [];
            const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
            harnesses.push(harness);
            await listAdminReviews(harness.db, filters);
            const list = queries.find(({ query }) => /from "product_reviews"/.test(query) && /order by "product_reviews"\."created_at" desc/.test(query));
            expect(list).toBeDefined();
            const plan = (harness.sqlite.prepare(`EXPLAIN QUERY PLAN ${list!.query}`).all(...(list!.values as never[])) as Array<{ parent: number; detail: string }>)
                .filter((row) => row.parent === 0).map((row) => row.detail).join(" | ");
            expect(plan).toMatch(new RegExp(`INDEX ${index}`));
            expect(plan).not.toMatch(SORTS_THE_TABLE);
        });
    }
});
