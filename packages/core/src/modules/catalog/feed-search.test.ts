import type { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getStorefrontFeedProducts } from "./feed";
import { getStorefrontCollectionProducts, getStorefrontProducts } from "./listing";
import { searchStorefrontProducts } from "./search";
import { resolvePublicAttributeFilters } from "../attributes/attributes.public";
import { search as searchCatalog } from "../../search";

let sqlite: DatabaseSync;
let db: Database;
let maxBoundParameters: number;

function insertMedia(id: string, kind: "image" | "video", objectKey: string, altText: string, posterMediaId: string | null = null): void {
    sqlite.prepare(
        `INSERT INTO media (id, filename, kind, object_key, size, mime_type, poster_media_id, alt_text, status)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'ready')`,
    ).run(id, objectKey, kind, objectKey, kind === "image" ? "image/jpeg" : "video/mp4", posterMediaId, altText);
}

function insertCategory(input: {
    id: string;
    name: string;
    slug: string;
    description?: string;
    status?: "draft" | "published" | "internal";
}): void {
    sqlite
        .prepare("INSERT INTO categories (id, name, slug, description, status) VALUES (?, ?, ?, ?, ?)")
        .run(input.id, input.name, input.slug, input.description ?? "", input.status ?? "published");
}

function insertProduct(input: {
    id: string;
    name: string;
    slug: string;
    categoryId: string;
    createdAt: number;
}): void {
    sqlite
        .prepare(
            `INSERT INTO products (id, name, description, price_minor, category_id, slug, created_at, updated_at)
             VALUES (?, ?, '', 100000, ?, ?, ?, ?)`,
        )
        .run(input.id, input.name, input.categoryId, input.slug, input.createdAt, input.createdAt);
    const mediaId = `media_${input.id}`;
    insertMedia(mediaId, "image", `products/${input.slug}.jpg`, input.name);
    sqlite.prepare(
        `INSERT INTO product_media (id, product_id, media_id, alt_text, is_primary, sort_order)
         VALUES (?, ?, ?, ?, 1, 0)`,
    ).run(`pmed_${input.id}`, input.id, mediaId, input.name);
}

function insertSimpleSku(productId: string): void {
    sqlite
        .prepare(
            `INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
             VALUES (?, ?, ?, 100000, 0, 1, 0)`,
        )
        .run(`var_default_${productId}`, productId, `SIMPLE-${productId}`);
}

function insertMixedTopologySkus(productId: string): void {
    sqlite.exec(`
        INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position, standard_mapping)
        VALUES ('option_size', '${productId}', 'Size', 'size', 0, 'size'),
               ('option_color', '${productId}', 'Color', 'color', 1, 'color');
        INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position)
        VALUES ('value_42', 'option_size', '42', '42', 0),
               ('value_41', 'option_size', '41', '41', 1),
               ('value_green', 'option_color', 'Green', 'green', 0);
    `);
    const statement = sqlite.prepare(
        `INSERT INTO product_variants (id, product_id, option_combination_key, sku, price_minor, stock, is_default, track_inventory)
         VALUES (?, ?, ?, ?, 100000, 5, 0, 1)`,
    );
    statement.run("var_mixed_size", productId, "value_42", "MIXED-SIZE");
    statement.run(
        "var_mixed_size_color",
        productId,
        "value_41|value_green",
        "MIXED-SIZE-COLOR",
    );
    sqlite.exec(`
        INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES
            ('var_mixed_size', 'option_size', 'value_42'),
            ('var_mixed_size_color', 'option_size', 'value_41'),
            ('var_mixed_size_color', 'option_color', 'value_green');
    `);
}

function insertAttribute(
    productId: string,
    attribute: { id: string; name: string; slug: string },
    value: string,
): void {
    sqlite.prepare(
        "INSERT OR IGNORE INTO product_attributes (id, name, slug, filterable) VALUES (?, ?, ?, 1)",
    ).run(attribute.id, attribute.name, attribute.slug);
    sqlite.prepare(
        "INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES (?, ?, ?, ?)",
    ).run(`value_${productId}_${attribute.id}`, productId, attribute.id, value);
}

describe("storefront feed category search", () => {
    beforeEach(() => {
        maxBoundParameters = 0;
        ({ sqlite, db } = createSqliteD1Database({
            onQuery(_query, params) {
                maxBoundParameters = Math.max(maxBoundParameters, params.length);
                if (params.length > 100) {
                    throw new Error(`D1 bound-parameter limit exceeded: ${params.length}`);
                }
            },
        }));

        insertCategory({ id: "cat_shoes", name: "Shoes", slug: "shoes" });
        insertCategory({
            id: "cat_formal",
            name: "Dress Collection",
            slug: "formal-footwear",
        });
        insertCategory({
            id: "cat_men_description_only",
            name: "Men",
            slug: "men-description-only",
            description: "Clothing goods",
        });
        insertCategory({
            id: "cat_men_clothing",
            name: "Men Clothing",
            slug: "men-clothing-collection",
            description: "Seasonal collection",
        });

        for (const product of [
            {
                id: "prod_runner",
                name: "Classic Runner",
                slug: "classic-runner",
                categoryId: "cat_shoes",
                createdAt: 1,
            },
            {
                id: "prod_loafer",
                name: "Everyday Loafer",
                slug: "everyday-loafer",
                categoryId: "cat_shoes",
                createdAt: 2,
            },
            {
                id: "prod_slip_on",
                name: "Canvas Slip-On",
                slug: "canvas-slip-on",
                categoryId: "cat_shoes",
                createdAt: 3,
            },
        ]) {
            insertProduct(product);
            insertSimpleSku(product.id);
        }

        insertProduct({
            id: "prod_mixed",
            name: "Malformed Shoes",
            slug: "malformed-shoes",
            categoryId: "cat_shoes",
            createdAt: 4,
        });
        insertMixedTopologySkus("prod_mixed");

        insertProduct({
            id: "prod_oxford",
            name: "Oxford Classic",
            slug: "oxford-classic",
            categoryId: "cat_formal",
            createdAt: 5,
        });
        insertSimpleSku("prod_oxford");

        insertProduct({
            id: "prod_description_trap",
            name: "Description Trap",
            slug: "description-trap",
            categoryId: "cat_men_description_only",
            createdAt: 6,
        });
        insertSimpleSku("prod_description_trap");

        insertProduct({
            id: "prod_two_token_name",
            name: "Two Token Match",
            slug: "two-token-match",
            categoryId: "cat_men_clothing",
            createdAt: 7,
        });
        insertSimpleSku("prod_two_token_name");
    });

    afterEach(() => {
        sqlite.close();
    });

    it("returns paginated category-name matches whose product titles omit the term", async () => {
        const firstPage = await getStorefrontFeedProducts(db, {
            search: "shoes",
            limit: 2,
        });
        expect(firstPage.pagination.cursor).toMatch(/^feed-v1\./);
        const secondPage = await getStorefrontFeedProducts(db, {
            search: "shoes",
            limit: 2,
            cursor: firstPage.pagination.cursor,
        });

        expect(firstPage.products.map((product) => product.name)).toEqual([
            "Canvas Slip-On",
            "Everyday Loafer",
        ]);
        expect(firstPage.pagination).toEqual({
            limit: 2,
            cursor: expect.stringMatching(/^feed-v1\./),
            hasNextPage: true,
        });
        expect(secondPage.products.map((product) => product.name)).toEqual([
            "Classic Runner",
        ]);
        expect(secondPage.pagination).toEqual({ limit: 2, hasNextPage: false });
        expect(
            [...firstPage.products, ...secondPage.products].some(
                (product) => product.id === "prod_mixed",
            ),
        ).toBe(false);
    });

    it("returns ranked sitewide results without projecting full page content", async () => {
        sqlite.prepare(
            `INSERT INTO pages (id, title, slug, content, is_published)
             VALUES ('page_classic', 'Classic care guide', 'classic-care', ?, 1)`,
        ).run("A long rich-text body that predictive search must not return.");

        const result = await searchCatalog(db, "classic", { limit: 10 });

        expect(result.products.find((product) => product.id === "prod_runner")).toMatchObject({
            id: "prod_runner",
            imageAlt: "Classic Runner",
        });
        expect(result.pages).toEqual([
            {
                id: "page_classic",
                title: "Classic care guide",
                slug: "classic-care",
                type: "page",
            },
        ]);
        expect(result.pages[0]).not.toHaveProperty("content");
    });

    it("uses a featured video poster as the predictive-search thumbnail", async () => {
        sqlite.prepare("DELETE FROM product_media WHERE product_id = ?").run("prod_runner");
        insertMedia("media_runner_poster", "image", "products/runner-poster.jpg", "Runner video poster");
        insertMedia("media_runner_video", "video", "products/runner.mp4", "Runner product video", "media_runner_poster");
        sqlite.prepare(
            `INSERT INTO product_media (id, product_id, media_id, alt_text, is_primary, sort_order)
             VALUES ('pmed_runner_video', 'prod_runner', 'media_runner_video', NULL, 1, 0)`,
        ).run();

        const result = await searchCatalog(db, "classic", { limit: 10 });

        expect(result.products.find((product) => product.id === "prod_runner")).toMatchObject({
            imageMediaId: "media_runner_poster",
            imageUrl: "products/runner-poster.jpg",
            imageAlt: "Runner product video",
        });
    });

    it("uses a stable created-at/id keyset and rejects retired page scans", async () => {
        insertProduct({
            id: "prod_tie_a",
            name: "Tie A",
            slug: "tie-a",
            categoryId: "cat_shoes",
            createdAt: 50,
        });
        insertSimpleSku("prod_tie_a");
        insertProduct({
            id: "prod_tie_b",
            name: "Tie B",
            slug: "tie-b",
            categoryId: "cat_shoes",
            createdAt: 50,
        });
        insertSimpleSku("prod_tie_b");

        const first = await getStorefrontFeedProducts(db, { limit: 1 });
        const second = await getStorefrontFeedProducts(db, {
            limit: 1,
            cursor: first.pagination.cursor,
        });

        expect(first.products.map((product) => product.id)).toEqual(["prod_tie_b"]);
        expect(second.products.map((product) => product.id)).toEqual(["prod_tie_a"]);
        await expect(getStorefrontFeedProducts(db, {
            page: 999,
            limit: 1,
        })).rejects.toThrow(/page pagination is retired/i);
        await expect(getStorefrontFeedProducts(db, {
            cursor: "page:999",
            limit: 1,
        })).rejects.toThrow(/invalid product feed cursor/i);
    });

    it("matches an exact indexed category slug without a product-title match", async () => {
        const result = await getStorefrontFeedProducts(db, {
            search: "formal-footwear",
            limit: 10,
        });

        expect(result.products.map((product) => product.name)).toEqual([
            "Oxford Classic",
        ]);
        expect(result.pagination).toEqual({ limit: 10, hasNextPage: false });
    });

    it("keeps manual products public but suppresses unpublished category authority", async () => {
        insertCategory({
            id: "cat_draft",
            name: "Private Draft",
            slug: "private-draft",
            status: "draft",
        });
        insertProduct({
            id: "prod_draft_category",
            name: "Public Manual Item",
            slug: "public-manual-item",
            categoryId: "cat_draft",
            createdAt: 60,
        });
        insertSimpleSku("prod_draft_category");

        const allProducts = await getStorefrontProducts(db, {
            page: 1,
            limit: 20,
        });
        const product = allProducts.products.find(
            (item) => item.id === "prod_draft_category",
        );
        const categoryFiltered = await getStorefrontProducts(db, {
            category: "cat_draft",
            page: 1,
            limit: 20,
        });
        const dynamicCollection = await getStorefrontCollectionProducts(
            db,
            { categoryIds: ["cat_draft"] },
            { page: 1, limit: 20 },
        );
        const manualCollection = await getStorefrontCollectionProducts(
            db,
            { productIds: ["prod_draft_category"] },
            { page: 1, limit: 20 },
        );

        expect(product).toMatchObject({
            id: "prod_draft_category",
            categoryId: null,
            category: null,
        });
        expect(categoryFiltered.products).toEqual([]);
        expect(dynamicCollection.products).toEqual([]);
        expect(manualCollection.products).toEqual([
            expect.objectContaining({ id: "prod_draft_category", categoryId: null }),
        ]);
    });

    it("uses a featured video poster for image-only feed fields and exact SKU images when assigned", async () => {
        sqlite.prepare("UPDATE product_media SET is_primary = 0, sort_order = 1 WHERE product_id = ?")
            .run("prod_runner");
        insertMedia("media_runner_poster", "image", "products/runner-poster.jpg", "Runner video poster");
        insertMedia("media_runner_video", "video", "products/runner-demo.mp4", "Runner demo", "media_runner_poster");
        sqlite.prepare(
            `INSERT INTO product_media (id, product_id, media_id, alt_text, is_primary, sort_order)
             VALUES ('pmed_runner_video', 'prod_runner', 'media_runner_video', 'Runner demonstration', 1, 0)`,
        ).run();

        const fallbackResult = await getStorefrontFeedProducts(db, {
            ids: "prod_runner",
            limit: 10,
        });
        const fallbackProduct = fallbackResult.products[0]!;

        expect(fallbackProduct.imageUrl).toContain("runner-poster.jpg");
        expect(fallbackProduct.imageUrl).not.toContain(".mp4");
        expect(fallbackProduct.imageMediaId).toBe("media_runner_poster");
        expect(fallbackProduct.variants[0]).toMatchObject({
            imageMediaId: "media_runner_poster",
        });
        expect(fallbackProduct.variants[0]?.imageUrl).not.toContain(".mp4");

        sqlite.prepare("UPDATE product_variants SET image_id = ? WHERE product_id = ?")
            .run("pmed_prod_runner", "prod_runner");
        const exactResult = await getStorefrontFeedProducts(db, {
            ids: "prod_runner",
            limit: 10,
        });

        expect(exactResult.products[0]?.variants[0]).toMatchObject({
            imageId: "pmed_prod_runner",
            imageMediaId: "media_prod_runner",
        });
        expect(exactResult.products[0]?.variants[0]?.imageUrl).toContain("classic-runner.jpg");
    });

    it("excludes products without usable primary media before feed pagination", async () => {
        sqlite.prepare("DELETE FROM product_media WHERE product_id = ?")
            .run("prod_slip_on");
        sqlite.prepare("UPDATE media SET status = 'deleted', trashed_at = 1, deleted_at = 1 WHERE id = ?")
            .run("media_prod_loafer");

        const result = await getStorefrontFeedProducts(db, {
            search: "shoes",
            limit: 10,
        });

        expect(result.products.map((product) => product.id)).toEqual(["prod_runner"]);
        expect(result.pagination).toEqual({
            limit: 10,
            hasNextPage: false,
        });
    });

    it("scopes every multi-token term to the category name column", async () => {
        const result = await getStorefrontFeedProducts(db, {
            search: "men clothing",
            limit: 10,
        });

        expect(result.products.map((product) => product.name)).toEqual([
            "Two Token Match",
        ]);
        expect(result.products.some((product) => product.id === "prod_description_trap"))
            .toBe(false);
        expect(result.pagination).toEqual({ limit: 10, hasNextPage: false });
    });

    it("keeps full feed-page enrichment queries within D1's bind limit", async () => {
        for (let index = 0; index < 100; index += 1) {
            const id = `prod_full_page_${String(index).padStart(3, "0")}`;
            insertProduct({
                id,
                name: `Catalog Item ${index}`,
                slug: `catalog-item-${index}`,
                categoryId: "cat_shoes",
                createdAt: 100 + index,
            });
            insertSimpleSku(id);
        }

        const result = await getStorefrontFeedProducts(db, {
            limit: 100,
        });
        const searchResult = await searchStorefrontProducts(db, {
            search: "",
            page: 1,
            limit: 100,
        });
        const lookupTokens = Array.from({ length: 100 }, (_, index) => {
            const id = `prod_full_page_${String(index).padStart(3, "0")}`;
            return index % 2 === 0 ? `catalog-item-${index}` : `SIMPLE-${id}`;
        });
        const lookupResult = await getStorefrontFeedProducts(db, {
            ids: lookupTokens.join(","),
            limit: 100,
        });

        expect(result.products).toHaveLength(100);
        expect(result.pagination).toMatchObject({ limit: 100, hasNextPage: true });
        expect(result.pagination.cursor).toMatch(/^feed-v1\./);
        expect(searchResult.data).toHaveLength(100);
        expect(searchResult.pagination.total).toBe(106);
        expect(lookupResult.products).toHaveLength(100);
        expect(lookupResult.pagination).toEqual({ limit: 100, hasNextPage: false });
        expect(searchResult.data[0]?.variants[0]).not.toHaveProperty("barcode");
        expect(searchResult.data[0]?.variants[0]).not.toHaveProperty("barcodeType");
        expect(searchResult.data[0]?.variants[0]).not.toHaveProperty("deletedAt");
        expect(maxBoundParameters).toBeLessThanOrEqual(100);
    });

    it("applies OR within facets, AND across facets, and returns self-excluding counts", async () => {
        const color = { id: "attr_color", name: "Color", slug: "color" };
        const material = { id: "attr_material", name: "Material", slug: "material" };
        const brand = { id: "attr_brand", name: "Brand", slug: "brand" };
        for (const [productId, values] of [
            ["prod_runner", ["Red", "Cotton", "A"]],
            ["prod_loafer", ["Blue", "Cotton", "A"]],
            ["prod_slip_on", ["Blue", "Silk", "B"]],
        ] as const) {
            insertAttribute(productId, color, values[0]);
            insertAttribute(productId, material, values[1]);
            insertAttribute(productId, brand, values[2]);
        }
        sqlite.prepare("UPDATE product_variants SET price_minor = 50000 WHERE product_id = 'prod_runner'").run();
        sqlite.prepare("UPDATE product_variants SET price_minor = 150000 WHERE product_id = 'prod_slip_on'").run();

        const result = await getStorefrontProducts(db, {
            category: "cat_shoes",
            minPrice: 800,
            page: 1,
            limit: 20,
            attributeFilters: [
                { ...color, values: ["Red", "Blue"] },
                { ...material, values: ["Cotton"] },
            ],
        });

        expect(result.products.map((product) => product.id)).toEqual(["prod_loafer"]);
        expect(result.pagination.total).toBe(1);
        expect(result.priceRange).toEqual({ min: 500, max: 1000 });
        expect(result.facets).toEqual([
            {
                ...brand,
                values: [
                    { value: "A", count: 1 },
                    { value: "B", count: 0 },
                ],
            },
            {
                ...color,
                values: [
                    { value: "Blue", count: 1 },
                    { value: "Red", count: 0 },
                ],
            },
            {
                ...material,
                values: [
                    { value: "Cotton", count: 1 },
                    { value: "Silk", count: 1 },
                ],
            },
        ]);
        expect(maxBoundParameters).toBeLessThanOrEqual(100);
    });

    it("paginates manual collection membership in saved curated order", async () => {
        const membership = {
            productIds: ["prod_slip_on", "prod_runner", "prod_loafer"],
        };
        const firstPage = await getStorefrontCollectionProducts(db, membership, {
            page: 1,
            limit: 2,
        });
        const secondPage = await getStorefrontCollectionProducts(db, membership, {
            page: 2,
            limit: 2,
        });

        expect(firstPage.products.map((product) => product.id)).toEqual([
            "prod_slip_on",
            "prod_runner",
        ]);
        expect(secondPage.products.map((product) => product.id)).toEqual([
            "prod_loafer",
        ]);
        expect(firstPage.pagination).toEqual({
            page: 1,
            limit: 2,
            total: 3,
            totalPages: 2,
        });
        expect(secondPage.pagination.total).toBe(3);
        expect(maxBoundParameters).toBeLessThanOrEqual(100);
    });

    it("honors an explicit shopper sort instead of the manual collection order", async () => {
        const membership = {
            productIds: ["prod_slip_on", "prod_runner", "prod_loafer"],
        };
        sqlite.prepare("UPDATE product_variants SET price_minor = 50000 WHERE product_id = 'prod_runner'").run();
        sqlite.prepare("UPDATE product_variants SET price_minor = 150000 WHERE product_id = 'prod_slip_on'").run();

        const result = await getStorefrontCollectionProducts(db, membership, {
            page: 1,
            limit: 20,
            sort: "price-asc",
        });

        expect(result.products.map((product) => product.id)).toEqual([
            "prod_runner",
            "prod_loafer",
            "prod_slip_on",
        ]);
        expect(maxBoundParameters).toBeLessThanOrEqual(100);
    });

    it("unions mixed collection membership with curated products first and no duplicates", async () => {
        const membership = {
            productIds: ["prod_runner", "prod_oxford"],
            categoryIds: ["cat_shoes"],
        };
        const firstPage = await getStorefrontCollectionProducts(db, membership, {
            page: 1,
            limit: 2,
        });
        const secondPage = await getStorefrontCollectionProducts(db, membership, {
            page: 2,
            limit: 2,
        });

        expect(firstPage.products.map((product) => product.id)).toEqual([
            "prod_runner",
            "prod_oxford",
        ]);
        expect(secondPage.products.map((product) => product.id)).toEqual([
            "prod_slip_on",
            "prod_loafer",
        ]);
        expect(firstPage.pagination).toEqual({
            page: 1,
            limit: 2,
            total: 4,
            totalPages: 2,
        });
        expect(new Set([
            ...firstPage.products.map((product) => product.id),
            ...secondPage.products.map((product) => product.id),
        ]).size).toBe(4);
        expect(maxBoundParameters).toBeLessThanOrEqual(100);
    });

    it("resolves repeated public values by valid filterable slug and enforces the 90-value boundary", async () => {
        const color = { id: "attr_color", name: "Color", slug: "color" };
        insertAttribute("prod_runner", color, "Red");
        insertAttribute("prod_loafer", color, "Blue");

        await expect(resolvePublicAttributeFilters(db, {
            color: ["Red", "Blue", "Missing"],
            unknown: ["Anything"],
        }, [])).resolves.toEqual([
            { ...color, values: ["Red", "Blue"] },
        ]);
        await expect(resolvePublicAttributeFilters(db, {
            "option.size": ["42", "41"],
            color: ["Red"],
        }, [])).resolves.toEqual([
            { id: "option.size", name: "size", slug: "option.size", values: ["42", "41"] },
            { ...color, values: ["Red"] },
        ]);
        await expect(resolvePublicAttributeFilters(db, {
            color: Array.from({ length: 91 }, (_, index) => `Value ${index}`),
        }, [])).rejects.toThrow(/At most 90 attribute filter values/);
        expect(maxBoundParameters).toBeLessThanOrEqual(100);
    });
});
