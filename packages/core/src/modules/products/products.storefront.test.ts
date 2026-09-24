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

function optionedCatalog(onQuery?: (params: readonly unknown[]) => void) {
    const harness = createSqliteD1Database({ onQuery: (_query, params) => onQuery?.(params) });
    harness.sqlite.exec(`
        INSERT INTO categories (id, name, slug, status) VALUES ('cat_shoes', 'Footwear', 'footwear', 'published');
        INSERT INTO products (id, name, description, price_minor, slug, category_id, is_active, created_at) VALUES
            ('p_runner', 'Trail Runner', 'Grippy sole', 10000, 'trail-runner', 'cat_shoes', 1, 300),
            ('p_loafer', 'City Loafer', 'Leather', 10000, 'city-loafer', 'cat_shoes', 1, 200),
            ('p_sandal', 'Beach Sandal', 'Pairs well with a runner outfit', 10000, 'beach-sandal', 'cat_shoes', 1, 400),
            ('p_kettle', 'Copper Tea Kettle', 'Stovetop', 10000, 'copper-kettle', NULL, 1, 50);
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
            ('v_kettle', 'p_kettle', 'KETTLE-1', 10000, 0, 0, 1, 0);
    `);
    const axes = harness.sqlite.prepare(
        "INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position) VALUES (?, ?, ?, ?, ?)",
    );
    const values = harness.sqlite.prepare(
        "INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES (?, ?, ?, ?, ?)",
    );
    const skus = harness.sqlite.prepare(
        `INSERT INTO product_variants (id, product_id, option_combination_key, sku, price_minor, stock, is_default, track_inventory)
         VALUES (?, ?, ?, ?, 10000, 5, 0, 1)`,
    );
    const assignments = harness.sqlite.prepare(
        "INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES (?, ?, ?)",
    );
    // Option axes are merchant-defined per product: the loafer names its axis
    // in lower case, and the sandal sells by colour only.
    const catalog: Array<[string, string, string[]]> = [
        ["p_runner", "Size", ["40", "41"]],
        ["p_loafer", "size", ["41", "42"]],
        ["p_sandal", "Color", ["Black", "Sand"]],
    ];
    for (const [productId, axisName, axisValues] of catalog) {
        const axisId = `axis_${productId}`;
        axes.run(axisId, productId, axisName, axisName.toLowerCase(), 0);
        axisValues.forEach((value, position) => {
            const valueId = `value_${productId}_${value}`;
            values.run(valueId, axisId, value, value.toLowerCase(), position);
            skus.run(`sku_${productId}_${value}`, productId, valueId, `${productId}-${value}`);
            assignments.run(`sku_${productId}_${value}`, axisId, valueId);
        });
    }
    return harness;
}

describe("storefront catalog search and option facets", () => {
    it("ranks title matches above description-only matches unless the buyer picks a sort", async () => {
        const { db } = optionedCatalog();

        const relevant = await getStorefrontProducts(db, { search: "runner" });
        const newest = await getStorefrontProducts(db, { search: "runner", sort: "newest" });

        expect(relevant.products.map((product) => product.id)).toEqual(["p_runner", "p_sandal"]);
        expect(newest.products.map((product) => product.id)).toEqual(["p_sandal", "p_runner"]);
        expect(relevant.correctedQuery).toBeNull();
    });

    it("returns corrected results with the corrected query when the typed query matches nothing", async () => {
        const { db } = optionedCatalog();

        const result = await getStorefrontProducts(db, { search: "kettel" });

        expect(result.correctedQuery).toBe("kettle");
        expect(result.products.map((product) => product.id)).toEqual(["p_kettle"]);
        expect(result.pagination.total).toBe(1);
    });

    it("offers merchant option axes as facets and filters by them within D1's bind limit", async () => {
        let maxParams = 0;
        const { db } = optionedCatalog((params) => {
            maxParams = Math.max(maxParams, params.length);
        });
        const size = { id: "option.size", name: "size", slug: "option.size" };

        const all = await getStorefrontProducts(db, { category: "cat_shoes" });
        const filtered = await getStorefrontProducts(db, {
            category: "cat_shoes",
            attributeFilters: [{ ...size, values: ["42"] }],
        });

        expect(all.facets).toEqual([
            { id: "option.color", name: "Color", slug: "option.color", values: [
                { value: "Black", count: 1 },
                { value: "Sand", count: 1 },
            ] },
            { id: "option.size", name: "Size", slug: "option.size", values: [
                { value: "40", count: 1 },
                { value: "41", count: 2 },
                { value: "42", count: 1 },
            ] },
        ]);
        expect(filtered.products.map((product) => product.id)).toEqual(["p_loafer"]);
        // OR within the selected axis keeps its own counts; other axes only
        // count products that also match the selection.
        expect(filtered.facets).toEqual([
            { id: "option.color", name: "Color", slug: "option.color", values: [
                { value: "Black", count: 0 },
                { value: "Sand", count: 0 },
            ] },
            { id: "option.size", name: "Size", slug: "option.size", values: [
                { value: "40", count: 1 },
                { value: "41", count: 2 },
                { value: "42", count: 1 },
            ] },
        ]);
        expect(maxParams).toBeLessThanOrEqual(100);
    });
});
