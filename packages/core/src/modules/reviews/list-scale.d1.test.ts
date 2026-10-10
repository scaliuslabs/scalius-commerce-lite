// The review moderation queue at scale (migration 0127): the All tab reads
// its page newest first from `product_reviews_created_idx`, never sorting
// every review (a 100,000-review store); a status tab from its status index.
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { type CapturedQuery, SORTS_THE_TABLE } from "../../testing/list-plans";
import { listAdminReviews } from "./staff";
import { createReviewStore } from "./testing/fixture";

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

describe("review queue search (migration 0128)", () => {
    it("finds a review by its words, its author or its product's name through the FTS indexes", async () => {
        const store = createReviewStore();
        try {
            store.deliveredOrder("ord_rev_1", [{ item: "item_rev_1", product: "prod_shirt" }, { item: "item_rev_2", product: "prod_mug" }]);
            const review = (id: string, item: string, product: string, title: string, body: string) => store.insert("product_reviews", {
                id, product_id: product, order_id: "ord_rev_1", order_item_id: item, reviewer_key: "acct_rahim",
                author_type: "customer", author_display_name: "Abdur Rahim", rating: 5, title, body,
            });
            review("rev_search_shirt", "item_rev_1", "prod_shirt", "Breathable", "Cool in the summer heat");
            review("rev_search_mug01", "item_rev_2", "prod_mug", "Sturdy", "Keeps tea warm");
            const queries: CapturedQuery[] = [];
            const harness = createSqliteD1Database({ sqlite: store.sqlite, onQuery: (query, values) => queries.push({ query, values }) });
            const find = async (q: string) => (await listAdminReviews(harness.db, { q })).items.map((item) => item.id);
            expect(await find("summer")).toEqual(["rev_search_shirt"]);
            expect(await find("sturd")).toEqual(["rev_search_mug01"]);
            expect(await find("clay")).toEqual(["rev_search_mug01"]);
            expect((await find("rahim")).sort()).toEqual(["rev_search_mug01", "rev_search_shirt"]);
            expect(await find("nothing")).toEqual([]);
            const searches = queries.filter(({ query }) => /from "product_reviews"/.test(query));
            expect(searches.length).toBeGreaterThan(0);
            for (const { query, values } of searches) {
                const plan = (store.sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...(values as never[])) as Array<{ detail: string }>).map((row) => row.detail);
                expect(plan.some((detail) => /product_reviews_fts VIRTUAL TABLE/.test(detail))).toBe(true);
                expect(plan.filter((detail) => /^SCAN (products|product_reviews)$/.test(detail))).toEqual([]);
            }
        } finally {
            store.close();
        }
    });
});
