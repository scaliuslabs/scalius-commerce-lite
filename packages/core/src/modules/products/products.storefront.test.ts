import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { getStorefrontProductBySlug, getStorefrontProducts } from "./products.storefront";

function setup() {
    const harness = createSqliteD1Database();
    harness.sqlite.exec(`
        INSERT INTO categories (id, name, slug, status) VALUES ('cat_draft', 'Draft', 'draft', 'draft');
        INSERT INTO products (id, name, price_minor, slug, category_id, is_active) VALUES
            ('p_z', 'Discounted', 10000, 'discounted', 'cat_draft', 1),
            ('p_a', 'Plain', 9040, 'plain', NULL, 1),
            ('p_no_sku', 'No SKU', 100, 'no-sku', NULL, 1),
            ('p_inactive', 'Inactive', 100, 'inactive', NULL, 0);
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, discount_type, discount_bps, low_stock_threshold) VALUES
            ('v_z', 'p_z', 'Z-1', 10000, 7, 0, 1, 1, 'percentage', 1000, 3),
            ('v_a', 'p_a', 'A-1', 9040, 0, 0, 1, 0, 'percentage', 0, NULL),
            ('v_inactive', 'p_inactive', 'I-1', 100, 0, 0, 1, 0, 'percentage', 0, NULL);
        INSERT INTO media (id, filename, kind, object_key, size, mime_type, alt_text, status)
            VALUES ('media_z', 'z.webp', 'image', 'media/z.webp', 1, 'image/webp', 'Library alt', 'ready');
        INSERT INTO product_media (id, product_id, media_id, alt_text, is_primary, sort_order)
            VALUES ('pmed_zzzzz', 'p_z', 'media_z', 'Merchant context alt', 1, 0);
        INSERT INTO product_attributes (id, name, slug, filterable) VALUES ('attr_fabric', 'Fabric', 'fabric', 0);
        INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('pav_z', 'p_z', 'attr_fabric', 'Cotton');
    `);
    return harness;
}

describe("storefront product reads", () => {
    it("lists only buyer-resolvable products sorted by raw effective SKU price", async () => {
        const { db } = setup();

        const result = await getStorefrontProducts(db, { sort: "price-asc", limit: 10 });

        expect(result.products.map((product) => [product.id, product.discountedPrice])).toEqual([
            ["p_z", 90],
            ["p_a", 90.4],
        ]);
        expect(result.products[0]).not.toHaveProperty("variants");
        expect(result.products[0]).not.toHaveProperty("attributes");
    });

    it("keeps exact inventory, admin alt overrides, and unpublished categories out of product detail", async () => {
        const { db } = setup();

        const product = await getStorefrontProductBySlug(db, "discounted");

        expect(product).not.toBeNull();
        const json = JSON.stringify(product);
        expect(product!.variants).toEqual([expect.objectContaining({ id: "v_z", availabilityBand: expect.any(String) })]);
        expect(product!.variants[0]!.stock).not.toBe(7);
        expect(json).not.toContain("contextualAltText");
        expect(product!.category ?? null).toBeNull();
        expect(json).toContain("Cotton");
    });

    it("does not resolve products without a buyer SKU or that are inactive", async () => {
        const { db } = setup();

        await expect(getStorefrontProductBySlug(db, "no-sku")).resolves.toBeNull();
        await expect(getStorefrontProductBySlug(db, "inactive")).resolves.toBeNull();
    });
});
