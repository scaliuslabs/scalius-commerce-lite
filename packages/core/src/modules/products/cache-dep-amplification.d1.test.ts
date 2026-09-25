// Write amplification of the 0093 cache dependency triggers on the real
// write paths (CACHE-DESIGN.md §6.11, §11): a 90-product bulk change, a
// product save whose facets did not change, and a catalogue rebuild that
// finds no drift. `depWrites` counts cache_dep row writes (each is the row
// plus its seq index entry on D1), `clockWrites` the clock row updates.
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { bulkUpdateProducts } from "./admin/lifecycle";
import { catalogProjectionRefreshStatements, rebuildCatalogProjections } from "./catalog-projections";
import { safeBatch } from "@scalius/database/client";

const PRODUCTS = 90;

describe("cache dependency write amplification", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(async () => {
        ({ sqlite, db } = createSqliteD1Database());
        const values = (make: (index: number) => string) => Array.from({ length: PRODUCTS }, (_, index) => make(index)).join(",\n");
        sqlite.exec(`
            INSERT INTO categories (id, name, slug, status) VALUES ('cat_root', 'Root', 'root', 'published');
            INSERT INTO categories (id, name, slug, status, parent_id) VALUES ('cat_a', 'A', 'a', 'published', 'cat_root');
            INSERT INTO categories (id, name, slug, status, parent_id) VALUES ('cat_b', 'B', 'b', 'published', 'cat_root');
            INSERT INTO brands (id, name, slug, status) VALUES ('brd_amp00001', 'Amp', 'amp', 'published');
            INSERT INTO product_attributes (id, name, slug, filterable, value_type, facet_display) VALUES ('attr_mat', 'Material', 'material', 1, 'text', 'checkbox');
            INSERT INTO products (id, name, price_minor, slug, category_id, brand_id, is_active) VALUES
            ${values((index) => `('p_${index}', 'Product ${index}', 1000, 'product-${index}', 'cat_a', 'brd_amp00001', 1)`)};
            INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
            ${values((index) => `('v_${index}', 'p_${index}', 'AMP-${index}', 1000, 10, 0, 1, 1)`)};
            INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES
            ${values((index) => `('pav_${index}', 'p_${index}', 'attr_mat', 'Cotton')`)};
            CREATE TABLE amp (k TEXT PRIMARY KEY, n INTEGER NOT NULL);
            CREATE TRIGGER amp_dep_ins AFTER INSERT ON cache_dep BEGIN INSERT INTO amp VALUES ('dep', 1) ON CONFLICT (k) DO UPDATE SET n = n + 1; END;
            CREATE TRIGGER amp_dep_upd AFTER UPDATE ON cache_dep BEGIN INSERT INTO amp VALUES ('dep', 1) ON CONFLICT (k) DO UPDATE SET n = n + 1; END;
            CREATE TRIGGER amp_clock AFTER UPDATE ON cache_clock BEGIN INSERT INTO amp VALUES ('clock', 1) ON CONFLICT (k) DO UPDATE SET n = n + 1; END;
        `);
        await rebuildCatalogProjections(db);
    }, 60_000);

    async function measure(write: () => Promise<unknown>) {
        sqlite.exec("DELETE FROM amp");
        const { seq } = sqlite.prepare("SELECT seq FROM cache_clock").get() as { seq: number };
        const started = performance.now();
        await write();
        const ms = performance.now() - started;
        const counts = Object.fromEntries((sqlite.prepare("SELECT k, n FROM amp").all() as Array<{ k: string; n: number }>)
            .map((row) => [row.k, row.n]));
        const keys = (sqlite.prepare("SELECT dep FROM cache_dep WHERE seq > ? ORDER BY dep").all(seq) as Array<{ dep: string }>)
            .map((row) => row.dep);
        const result = { keys, depWrites: counts.dep ?? 0, clockWrites: counts.clock ?? 0, ms };
        if (process.env.CACHE_DEP_AMPLIFICATION_REPORT) {
            console.log(`[cache-dep amplification] ${expect.getState().currentTestName}: ${JSON.stringify({ ...result, keys: result.keys.length, ms: Math.round(ms) })}`);
        }
        return result;
    }

    const claims = () => Array.from({ length: PRODUCTS }, (_, index) => ({ id: `p_${index}`, expectedAggregateRevision: 1 }));

    it("a 90-product unpublish advances each product once and the shared scopes, in one batch", async () => {
        const result = await measure(() => bulkUpdateProducts(db, claims(), { isActive: false }));
        const productKeys = result.keys.filter((key) => key.startsWith("p:"));
        expect(productKeys).toHaveLength(PRODUCTS);
        expect(result.keys.filter((key) => !key.startsWith("p:"))).toEqual([
            "lm:all", "lm:brand:brd_amp00001", "lm:cat:cat_a", "lm:cat:cat_root", "t:product_buyer_state", "t:products",
        ]);
        // Per product: the products row trigger and the buyer-state membership trigger.
        expect(result.clockWrites).toBe(2 * PRODUCTS);
        // products fire: p + t (2); buyer state fire: p + 4 scopes + t (6).
        expect(result.depWrites).toBe(8 * PRODUCTS);
        expect(result.ms).toBeLessThan(2_000);
    });

    it("a 90-product category move advances both subtrees", async () => {
        const result = await measure(() => bulkUpdateProducts(db, claims(), { categoryId: "cat_b" }));
        expect(result.keys.filter((key) => !key.startsWith("p:"))).toEqual([
            "lm:all", "lm:brand:brd_amp00001", "lm:cat:cat_a", "lm:cat:cat_b", "lm:cat:cat_root", "t:product_buyer_state", "t:products",
        ]);
        // products row + buyer state old image + new image.
        expect(result.clockWrites).toBe(3 * PRODUCTS);
        expect(result.depWrites).toBeLessThanOrEqual(14 * PRODUCTS);
    });

    it("a refresh with no change (a save of unchanged facts) and a rebuild with no drift write nothing", async () => {
        const refresh = await measure(() => safeBatch(db, catalogProjectionRefreshStatements(db, claims().map((claim) => claim.id)) as never));
        expect(refresh).toMatchObject({ keys: [], depWrites: 0, clockWrites: 0 });
        const rebuild = await measure(() => rebuildCatalogProjections(db));
        expect(rebuild).toMatchObject({ keys: [], depWrites: 0 });
        // Only the coarse flag's own set and reset touch the clock row.
        expect(rebuild.clockWrites).toBe(2);
    });

    it("a rebuild that heals drift advances `store`, not every product's keys", async () => {
        sqlite.exec("UPDATE product_buyer_state SET from_minor = 1, to_minor = 1, base_minor = 1");
        sqlite.exec("DELETE FROM product_facet_values WHERE product_id IN ('p_1', 'p_2')");
        const rebuild = await measure(() => rebuildCatalogProjections(db));
        expect(rebuild.keys).toEqual(["store"]);
        expect(sqlite.prepare("SELECT count(*) AS n FROM product_buyer_state WHERE from_minor = 1000").get()).toEqual({ n: PRODUCTS });
        expect(sqlite.prepare("SELECT coarse FROM cache_clock").get()).toEqual({ coarse: 0 });
    });
});
