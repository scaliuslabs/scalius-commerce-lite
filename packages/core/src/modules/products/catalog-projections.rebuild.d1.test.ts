import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildCatalogProjections } from "./catalog-projections";

describe("full catalog rebuild repairs public catalog counters", () => {
    let harness: ReturnType<typeof createSqliteD1Database>;
    let statements: string[];
    beforeEach(async () => {
        statements = [];
        harness = createSqliteD1Database({ onQuery: query => statements.push(query) });
        harness.sqlite.exec(`
            INSERT INTO brands (id, name, slug, status) VALUES ('brd_repair_a', 'Brand A', 'brand-a', 'published');
            INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'Category A', 'category-a', 'published');
            INSERT INTO product_attributes (id, name, slug) VALUES ('attr_mat', 'Material', 'material');
            INSERT INTO products (id, name, slug, price_minor, brand_id, category_id) VALUES
                ('prod_a', 'A', 'a', 100, 'brd_repair_a', 'cat_a'),
                ('prod_b', 'B', 'b', 100, 'brd_repair_a', 'cat_a'), ('prod_c', 'C', 'c', 100, NULL, NULL);
            INSERT INTO product_variants (id, product_id, sku, price_minor, is_default, track_inventory) VALUES
                ('var_a', 'prod_a', 'A', 100, 1, 0), ('var_b', 'prod_b', 'B', 100, 1, 0), ('var_c', 'prod_c', 'C', 100, 1, 0);
            INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES
                ('pav_a', 'prod_a', 'attr_mat', 'Cotton'), ('pav_b', 'prod_b', 'attr_mat', 'Cotton'), ('pav_c', 'prod_c', 'attr_mat', 'Wool');
        `);
        await rebuildCatalogProjections(harness.db);
        statements.length = 0;
    });
    afterEach(() => harness.sqlite.close());

    const counts = () => harness.sqlite.prepare(`SELECT facet_kind, facet_key, value_key, product_count
        FROM product_facet_public_counts WHERE product_count > 0 ORDER BY facet_kind, facet_key, value_key`).all();
    const expectedCounts = () => harness.sqlite.prepare(`SELECT f.facet_kind, f.facet_key, f.value_key,
        count(DISTINCT f.product_id) AS product_count FROM product_facet_values f
        JOIN product_buyer_state b ON b.product_id = f.product_id WHERE b.is_public = 1
        GROUP BY f.facet_kind, f.facet_key, f.value_key ORDER BY f.facet_kind, f.facet_key, f.value_key`).all();
    const sequence = () => Number(harness.sqlite.prepare("SELECT seq FROM cache_clock WHERE id = 1").get()!.seq);
    const buyerCounts = () => harness.sqlite.prepare(`SELECT * FROM product_buyer_public_counts
        WHERE product_count > 0 ORDER BY dimension, value_id`).all();
    const expectedBuyerCounts = () => harness.sqlite.prepare(`
        SELECT 'brand' AS dimension, brand_id AS value_id, COUNT(*) AS product_count
        FROM product_buyer_state WHERE is_public=1 AND brand_id IS NOT NULL GROUP BY brand_id
        UNION ALL SELECT 'category', category_id, COUNT(*) FROM product_buyer_state
        WHERE is_public=1 AND category_id IS NOT NULL GROUP BY category_id ORDER BY 1,2`).all();

    it("repairs undercounts before deletes, clears stale groups, and resyncs only the initial page", async () => {
        harness.sqlite.exec(`
            UPDATE product_facet_public_counts SET product_count = 0 WHERE value_key = 'cotton';
            INSERT INTO product_facet_public_counts VALUES ('attribute', 'attr_stale', 'stale', 8);
            UPDATE product_buyer_public_counts SET product_count = 0;
            INSERT INTO product_buyer_public_counts VALUES ('brand', 'stale', 8);
            UPDATE product_attribute_values SET value = 'Linen' WHERE id = 'pav_a';
        `);
        const before = sequence();
        let afterProductId: string | null = null;
        for (;;) {
            const page = await rebuildCatalogProjections(harness.db, { afterProductId, limit: 1 });
            expect(counts()).toEqual(expectedCounts());
            expect(buyerCounts()).toEqual(expectedBuyerCounts());
            if (page.done) break;
            afterProductId = page.nextAfterProductId;
        }
        expect(counts().map(row => [row.value_key, row.product_count])).toEqual([["cotton", 1], ["linen", 1], ["wool", 1]]);
        expect(statements.filter(query => query.includes('delete from "product_facet_public_counts"'))).toHaveLength(1);
        expect(statements.filter(query => query.includes('delete from "product_buyer_public_counts"'))).toHaveLength(1);
        expect(harness.sqlite.prepare("SELECT seq FROM cache_dep WHERE dep = 'store'").get()!.seq).toBeGreaterThan(before);
    });

    it("repairs dimension-only drift with one coherent store clock advance", async () => {
        const before = sequence();
        const facets = counts();
        harness.sqlite.exec(`UPDATE product_buyer_public_counts SET product_count = 0;
            INSERT INTO product_buyer_public_counts VALUES ('category', 'stale', 8)`);
        expect(sequence()).toBe(before);
        await rebuildCatalogProjections(harness.db);
        expect(buyerCounts()).toEqual(expectedBuyerCounts());
        expect(counts()).toEqual(facets);
        expect(sequence()).toBe(before + 1);
        expect(harness.sqlite.prepare("SELECT seq FROM cache_dep WHERE dep='store'").get()!.seq).toBe(before + 1);
        await rebuildCatalogProjections(harness.db);
        expect(sequence()).toBe(before + 1);
    });

    it("invalidates repaired counter-only drift but leaves a correct rebuild's dependencies unchanged", async () => {
        const before = sequence();
        await rebuildCatalogProjections(harness.db);
        expect(sequence()).toBe(before);
        harness.sqlite.exec("UPDATE product_facet_public_counts SET product_count = product_count + 9");
        await rebuildCatalogProjections(harness.db);
        expect(counts()).toEqual(expectedCounts());
        expect(sequence()).toBeGreaterThan(before);
    });

    it("clears stale counters for an empty catalog and invalidates the corrected result", async () => {
        harness.sqlite.exec(`DELETE FROM products; INSERT INTO product_facet_public_counts
            VALUES ('attribute', 'attr_stale', 'stale', 8);
            INSERT INTO product_buyer_public_counts VALUES ('category', 'stale', 8)`);
        const before = sequence();
        expect(await rebuildCatalogProjections(harness.db)).toEqual({ processed: 0, nextAfterProductId: null, done: true });
        expect(harness.sqlite.prepare("SELECT * FROM product_facet_public_counts").all()).toEqual([]);
        expect(harness.sqlite.prepare("SELECT * FROM product_buyer_public_counts").all()).toEqual([]);
        expect(sequence()).toBe(before + 1);
    });
});
