import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { resolveCollectionProductsBatch } from "./collections.service";

describe("public collection product resolution", () => {
    it("resolves manual, dynamic, and featured products only when a buyer can resolve a SKU", async () => {
        const { sqlite, db } = createSqliteD1Database();
        sqlite.exec(`
            INSERT INTO categories (id, name, slug, status) VALUES ('cat_1', 'Shoes', 'shoes', 'published');
            INSERT INTO products (id, name, price, slug, category_id, is_active) VALUES
                ('p_visible', 'Visible', 10, 'visible', 'cat_1', 1),
                ('p_no_sku', 'No SKU', 10, 'no-sku', 'cat_1', 1),
                ('p_inactive', 'Inactive', 10, 'inactive', 'cat_1', 0);
            INSERT INTO product_variants (id, product_id, sku, price, stock, reserved_stock, is_default, track_inventory) VALUES
                ('v_visible', 'p_visible', 'VIS-1', 10, 0, 0, 1, 0),
                ('v_inactive', 'p_inactive', 'INA-1', 10, 0, 0, 1, 0);
        `);
        const allProducts = ["p_visible", "p_no_sku", "p_inactive"];

        const resolved = await resolveCollectionProductsBatch(db, [
            { id: "manual", config: { source: "manual", productIds: allProducts, featuredProductId: "p_no_sku" } },
            { id: "dynamic", config: { source: "dynamic", categoryIds: ["cat_1"], featuredProductId: "p_visible" } },
        ]);

        expect(resolved.get("manual")?.products.map((product) => product.id)).toEqual(["p_visible"]);
        expect(resolved.get("manual")?.featuredProduct).toBeNull();
        expect(resolved.get("dynamic")?.products.map((product) => product.id)).toEqual(["p_visible"]);
        expect(resolved.get("dynamic")?.featuredProduct?.id).toBe("p_visible");
    });
});
