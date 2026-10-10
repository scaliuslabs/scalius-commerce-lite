// The collection product picker at scale: the page's ids are sorted on the
// narrow product row, and each page product's SKU count and sellable units
// are read through its own SKUs (product_variants_product_live_idx, 0128).
// Before, the SKU subqueries ran for every product it sorted, each walking
// every tracked SKU in the store through (track_inventory, deleted_at):
// 1.2 s warm, 5 s on the local Worker, for 50,000 products.
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { CapturedQuery } from "../../testing/list-plans";
import { listCollectionProductOptions } from "./collections";

const harnesses: Array<{ sqlite: DatabaseSync }> = [];
afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

describe("collection product picker at scale", () => {
    it("reads SKU facts for the page's products only, each through its own SKUs", async () => {
        const queries: CapturedQuery[] = [];
        const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
        harnesses.push(harness);
        harness.sqlite.exec(`
            INSERT INTO products (id, name, slug, price_minor, created_at) VALUES
                ('prod_old', 'Old kettle', 'old-kettle', 1000, 1700000000), ('prod_new', 'New kettle', 'new-kettle', 2000, 1700000100);
            INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
                ('var_old', 'prod_old', 'OLD-1', 1000, 4, 1, 1, 1), ('var_new', 'prod_new', 'NEW-1', 2000, 2, 0, 1, 1);
        `);
        const result = await listCollectionProductOptions(harness.db, { limit: 1 });
        expect(result.products.map((product) => [product.id, product.available])).toEqual([["prod_new", 2]]);

        const page = queries.find(({ query }) => /collection_product_available/.test(query))!;
        expect(page.query.replace(/\s+/g, " ")).toMatch(/"products"\."id" in \(select "id" from "products"/);
        const plan = (harness.sqlite.prepare(`EXPLAIN QUERY PLAN ${page.query}`).all(...(page.values as never[])) as Array<{ detail: string }>)
            .map((row) => row.detail);
        const skuReads = plan.filter((detail) => /^SEARCH product_variants /.test(detail));
        expect(skuReads.length).toBeGreaterThan(0);
        for (const detail of skuReads) expect(detail).toMatch(/\(product_id=\?/);
    });
});
