// The /collections directory: active collections in the merchant's order,
// each with the count its own page shows and a photo, leaving out the ones
// nobody can shop.
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterAll, describe, expect, it } from "vitest";

import { rebuildCatalogProjections } from "../products/catalog-projections";
import { listPublicCollectionDirectory } from "./collections.service";

let sqlite: DatabaseSync | null = null;
afterAll(() => {
    sqlite?.close();
    sqlite = null;
});

describe("the collection directory", () => {
    it("lists shoppable collections in order with their visible product count", async () => {
        const harness = createSqliteD1Database();
        sqlite = harness.sqlite;
        harness.sqlite.exec(`
            INSERT INTO categories (id, name, slug, status) VALUES ('cat_tea', 'Tea', 'tea', 'published');
            INSERT INTO products (id, name, price_minor, slug, category_id, is_active, created_at) VALUES
                ('prod_a', 'Assam', 10000, 'assam', 'cat_tea', 1, 1700000001),
                ('prod_b', 'Darjeeling', 10000, 'darjeeling', 'cat_tea', 1, 1700000002),
                ('prod_c', 'Hidden', 10000, 'hidden', NULL, 0, 1700000003);
            INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES
                ('var_a', 'prod_a', 'SKU-A', 10000, 5, 1, 1),
                ('var_b', 'prod_b', 'SKU-B', 10000, 5, 1, 1),
                ('var_c', 'prod_c', 'SKU-C', 10000, 5, 1, 1);
            INSERT INTO collections (id, name, presentation, config, sort_order, is_active, canonical_path) VALUES
                ('col_picks', 'Picks', 'grid', '{"source":"manual","productIds":["prod_b","prod_c"],"categoryIds":[]}', 2, 1, NULL),
                ('col_tea', 'All tea', 'grid', '{"source":"dynamic","productIds":[],"categoryIds":["cat_tea"]}', 1, 1, '/collections/col_tea'),
                ('col_empty', 'Only hidden', 'grid', '{"source":"manual","productIds":["prod_c"],"categoryIds":[]}', 3, 1, NULL),
                ('col_off', 'Switched off', 'grid', '{"source":"manual","productIds":["prod_a"],"categoryIds":[]}', 0, 0, NULL);
        `);
        await rebuildCatalogProjections(harness.db);

        const directory = await listPublicCollectionDirectory(harness.db);

        expect(directory.map(({ id, name, canonicalPath, productCount }) => ({ id, name, canonicalPath, productCount }))).toEqual([
            { id: "col_tea", name: "All tea", canonicalPath: "/collections/col_tea", productCount: 2 },
            { id: "col_picks", name: "Picks", canonicalPath: null, productCount: 1 },
        ]);
        expect(directory.every((entry) => "imageUrl" in entry && "imageAlt" in entry)).toBe(true);
    });
});
