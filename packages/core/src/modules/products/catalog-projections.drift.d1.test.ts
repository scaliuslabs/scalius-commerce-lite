// The cheap projection maintenance a large catalogue needs (docs/SCALE.md):
// the drift check compares stored projections with their sources and
// repairs only what differs, and the band-only refresh recomputes stored
// availability bands from each product's card SKU after a store-wide band
// input (the default low-stock level) changes, without a full rebuild.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
    catalogProjectionDefinition,
    checkCatalogProjectionDrift,
    rebuildCatalogProjections,
    refreshCatalogAvailabilityBands,
} from "./catalog-projections";

describe("catalogue projection drift check and band refresh", () => {
    let harness: ReturnType<typeof createSqliteD1Database>;
    let statements: string[];
    const PRODUCTS = 7;

    beforeEach(async () => {
        statements = [];
        harness = createSqliteD1Database({ onQuery: (query) => statements.push(query) });
        harness.sqlite.exec(`
            INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'A', 'a', 'published');
            INSERT INTO product_attributes (id, name, slug, filterable) VALUES ('attr_mat', 'Material', 'material', 1);
        `);
        const product = harness.sqlite.prepare("INSERT INTO products (id, name, slug, price_minor, category_id, is_active, created_at) VALUES (?, ?, ?, 1000, 'cat_a', 1, ?)");
        const sku = harness.sqlite.prepare("INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES (?, ?, ?, 1000, ?, 1, 1)");
        const attribute = harness.sqlite.prepare("INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES (?, ?, 'attr_mat', ?)");
        for (let index = 0; index < PRODUCTS; index += 1) {
            const id = `prod_${index}`;
            product.run(id, `Product ${index}`, `product-${index}`, 1_700_000_000 + index);
            // Stock 3: with a store default of 5 every SKU is low; without one, in stock.
            sku.run(`var_${index}`, id, `SKU-${index}`, 3);
            attribute.run(`pav_${index}`, id, index % 2 === 0 ? "Cotton" : "Wool");
        }
        await rebuildCatalogProjections(harness.db);
        statements.length = 0;
    });
    afterEach(() => harness.sqlite.close());

    const bands = () => harness.sqlite.prepare("SELECT product_id, availability_band FROM product_buyer_state ORDER BY product_id").all()
        .map((row) => (row as { availability_band: string }).availability_band);
    const storeSeq = () => Number((harness.sqlite.prepare("SELECT seq FROM cache_dep WHERE dep = 'store'").get() as { seq?: number } | undefined)?.seq ?? 0);
    const writes = () => statements.filter((query) => /^\s*(insert|update|delete)/i.test(query) && !query.includes("cache_clock"));

    it("finds nothing and writes nothing on correct projections", async () => {
        const result = await checkCatalogProjectionDrift(harness.db, { limit: 100 });
        expect(result).toEqual({ checked: PRODUCTS, repaired: [], nextAfterProductId: null, done: true });
        expect(writes()).toEqual([]);
    });

    it("repairs a drifted buyer row, a stale facet row and a missing facet row, and only those products", async () => {
        harness.sqlite.exec(`
            UPDATE product_buyer_state SET from_minor = 1, base_minor = 1, to_minor = 1 WHERE product_id = 'prod_1';
            UPDATE product_facet_values SET value_label = 'Stale' WHERE product_id = 'prod_3';
            DELETE FROM product_facet_values WHERE product_id = 'prod_5';
        `);
        const first = await checkCatalogProjectionDrift(harness.db, { limit: 4 });
        expect(first).toEqual({ checked: 4, repaired: ["prod_1", "prod_3"], nextAfterProductId: "prod_3", done: false });
        const second = await checkCatalogProjectionDrift(harness.db, { afterProductId: first.nextAfterProductId, limit: 4 });
        expect(second).toEqual({ checked: 3, repaired: ["prod_5"], nextAfterProductId: null, done: true });
        // Repaired: a second pass finds nothing.
        expect((await checkCatalogProjectionDrift(harness.db, { limit: 100 })).repaired).toEqual([]);
        expect(harness.sqlite.prepare("SELECT from_minor FROM product_buyer_state WHERE product_id = 'prod_1'").get()).toEqual({ from_minor: 1000 });
        expect(harness.sqlite.prepare("SELECT count(*) AS n FROM product_facet_values WHERE product_id = 'prod_5'").get()).toEqual({ n: 1 });
    });

    it("recomputes only stored bands after the store default changes, in chunks, and advances store once per changed chunk", async () => {
        expect(bands()).toEqual(Array(PRODUCTS).fill("in_stock"));
        harness.sqlite.exec(`INSERT INTO settings (id, type, category, key, value) VALUES ('set_inventory', 'json', 'inventory', 'document', '{"defaultLowStockThreshold":5}')
            ON CONFLICT (category, key) DO UPDATE SET value = excluded.value`);
        const before = storeSeq();
        const first = await refreshCatalogAvailabilityBands(harness.db, { limit: 4 });
        expect(first).toEqual({ processed: 4, nextAfterProductId: "prod_3", done: false });
        expect(bands()).toEqual([...Array(4).fill("low_stock"), ...Array(3).fill("in_stock")]);
        const second = await refreshCatalogAvailabilityBands(harness.db, { afterProductId: first.nextAfterProductId, limit: 4 });
        expect(second).toEqual({ processed: 3, nextAfterProductId: null, done: true });
        expect(bands()).toEqual(Array(PRODUCTS).fill("low_stock"));
        expect(storeSeq()).toBeGreaterThan(before);
        // Nothing else moved: the full projection agrees with the refreshed bands.
        expect((await checkCatalogProjectionDrift(harness.db, { limit: 100 })).repaired).toEqual([]);
        // A repeat changes no band and advances nothing.
        const settled = storeSeq();
        await refreshCatalogAvailabilityBands(harness.db, { limit: 100 });
        expect(storeSeq()).toBe(settled);
    });

    it("stops a band chunk at the upper bound of a wrapped lap", async () => {
        harness.sqlite.exec(`INSERT INTO settings (id, type, category, key, value) VALUES ('set_inventory', 'json', 'inventory', 'document', '{"defaultLowStockThreshold":5}')
            ON CONFLICT (category, key) DO UPDATE SET value = excluded.value`);
        expect(await refreshCatalogAvailabilityBands(harness.db, { untilProductId: "prod_2", limit: 100 }))
            .toEqual({ processed: 3, nextAfterProductId: null, done: true });
        expect(bands()).toEqual([...Array(3).fill("low_stock"), ...Array(4).fill("in_stock")]);
    });

    it("bounds a rebuild walk by its upper product id and recounts facet counts only when asked", async () => {
        const result = await rebuildCatalogProjections(harness.db, { afterProductId: "prod_1", untilProductId: "prod_4", limit: 100 });
        expect(result).toEqual({ processed: 3, nextAfterProductId: null, done: true });
        expect(statements.some((query) => query.includes('delete from "product_facet_public_counts"'))).toBe(false);
        statements.length = 0;
        await rebuildCatalogProjections(harness.db, { afterProductId: "prod_1", limit: 1, repairFacetCounts: true });
        expect(statements.filter((query) => query.includes('delete from "product_facet_public_counts"'))).toHaveLength(1);
    });

    it("describes the projection with stable SQL text", () => {
        expect(catalogProjectionDefinition(harness.db)).toBe(catalogProjectionDefinition(harness.db));
        expect(catalogProjectionDefinition(harness.db)).toContain("product_buyer_state");
    });
});
