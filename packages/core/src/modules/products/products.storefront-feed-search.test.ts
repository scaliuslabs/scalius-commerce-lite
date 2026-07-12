import { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    getStorefrontFeedProducts,
    getStorefrontCollectionProducts,
    getStorefrontProducts,
    searchStorefrontProducts,
} from "./products.storefront";
import { resolvePublicAttributeFilters } from "../attributes/attributes.public";

let sqlite: DatabaseSync;
let db: Database;
let maxBoundParameters: number;

function createDatabase(): Database {
    const proxy = drizzle(async (query, params, method) => {
        maxBoundParameters = Math.max(maxBoundParameters, params.length);
        if (params.length > 100) {
            throw new Error(`D1 bound-parameter limit exceeded: ${params.length}`);
        }
        const statement = sqlite.prepare(query);
        statement.setReturnArrays(true);

        if (method === "run") {
            statement.run(...params);
            return { rows: [] };
        }
        if (method === "get") {
            return {
                rows: statement.get(...params) as unknown as unknown[],
            };
        }
        return {
            rows: statement.all(...params) as unknown as unknown[],
        };
    });

    return proxy as unknown as Database;
}

function createCatalogSchema(): void {
    sqlite.exec(`
        CREATE TABLE categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            description TEXT,
            image_url TEXT,
            meta_title TEXT,
            meta_description TEXT,
            canonical_path TEXT,
            no_index INTEGER NOT NULL DEFAULT 0,
            exclude_from_sitemap INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER
        );
        CREATE VIRTUAL TABLE categories_fts USING fts5(name, description);

        CREATE TABLE products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            price REAL NOT NULL,
            category_id TEXT,
            slug TEXT NOT NULL UNIQUE,
            meta_title TEXT,
            meta_description TEXT,
            canonical_path TEXT,
            no_index INTEGER NOT NULL DEFAULT 0,
            exclude_from_sitemap INTEGER NOT NULL DEFAULT 0,
            exclude_from_product_feed INTEGER NOT NULL DEFAULT 0,
            product_condition TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
            is_active INTEGER NOT NULL DEFAULT 1,
            discount_percentage REAL DEFAULT 0,
            discount_type TEXT DEFAULT 'percentage',
            discount_amount REAL DEFAULT 0,
            free_delivery INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX products_category_id_idx ON products(category_id);
        CREATE VIRTUAL TABLE products_fts USING fts5(name, description);

        CREATE TABLE product_variants (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            option_combination_key TEXT,
            image_id TEXT,
            weight REAL,
            sku TEXT NOT NULL UNIQUE,
            price REAL NOT NULL,
            stock INTEGER NOT NULL DEFAULT 0,
            reserved_stock INTEGER NOT NULL DEFAULT 0,
            is_default INTEGER NOT NULL DEFAULT 0,
            track_inventory INTEGER NOT NULL DEFAULT 1,
            discount_percentage REAL DEFAULT 0,
            discount_type TEXT DEFAULT 'percentage',
            discount_amount REAL DEFAULT 0,
            barcode TEXT,
            barcode_type TEXT,
            created_at INTEGER NOT NULL DEFAULT 1,
            deleted_at INTEGER
        );
        CREATE INDEX product_variants_product_id_idx ON product_variants(product_id);

        CREATE TABLE product_option_definitions (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            name TEXT NOT NULL,
            position INTEGER NOT NULL,
            standard_mapping TEXT NOT NULL DEFAULT 'none',
            deleted_at INTEGER
        );
        CREATE TABLE product_option_values (
            id TEXT PRIMARY KEY,
            option_definition_id TEXT NOT NULL,
            value TEXT NOT NULL,
            position INTEGER NOT NULL,
            deleted_at INTEGER
        );
        CREATE TABLE product_variant_option_values (
            variant_id TEXT NOT NULL,
            option_definition_id TEXT NOT NULL,
            option_value_id TEXT NOT NULL
        );

        CREATE TABLE product_images (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            url TEXT NOT NULL,
            alt TEXT,
            is_primary INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX product_images_product_id_idx ON product_images(product_id);

        CREATE TABLE product_attributes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL,
            filterable INTEGER NOT NULL DEFAULT 1,
            deleted_at INTEGER
        );
        CREATE TABLE product_attribute_values (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            attribute_id TEXT NOT NULL,
            value TEXT NOT NULL
        );
    `);
}

function insertCategory(input: {
    id: string;
    name: string;
    slug: string;
    description?: string;
}): void {
    const description = input.description ?? "";
    sqlite
        .prepare(
            "INSERT INTO categories (id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
        )
        .run(input.id, input.name, input.slug, description);
    const row = sqlite
        .prepare("SELECT rowid FROM categories WHERE id = ?")
        .get(input.id) as { rowid: number };
    sqlite
        .prepare(
            "INSERT INTO categories_fts (rowid, name, description) VALUES (?, ?, ?)",
        )
        .run(row.rowid, input.name, description);
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
            `INSERT INTO products (
                id, name, description, price, category_id, slug,
                created_at, updated_at, is_active, exclude_from_product_feed
            ) VALUES (?, ?, '', 1000, ?, ?, ?, ?, 1, 0)`,
        )
        .run(
            input.id,
            input.name,
            input.categoryId,
            input.slug,
            input.createdAt,
            input.createdAt,
        );
    const row = sqlite
        .prepare("SELECT rowid FROM products WHERE id = ?")
        .get(input.id) as { rowid: number };
    sqlite
        .prepare(
            "INSERT INTO products_fts (rowid, name, description) VALUES (?, ?, '')",
        )
        .run(row.rowid, input.name);
    sqlite
        .prepare(
            "INSERT INTO product_images (id, product_id, url, alt, is_primary) VALUES (?, ?, ?, ?, 1)",
        )
        .run(
            `image_${input.id}`,
            input.id,
            `https://cdn.example.test/${input.slug}.jpg`,
            input.name,
        );
}

function insertSimpleSku(productId: string): void {
    sqlite
        .prepare(
            `INSERT INTO product_variants (
                id, product_id, option_combination_key, image_id, weight, sku, price, stock,
                reserved_stock, is_default, track_inventory
            ) VALUES (?, ?, NULL, NULL, NULL, ?, 1000, 0, 0, 1, 0)`,
        )
        .run(`var_default_${productId}`, productId, `SIMPLE-${productId}`);
}

function insertMixedTopologySkus(productId: string): void {
    sqlite.exec(`
        INSERT INTO product_option_definitions (id, product_id, name, position, standard_mapping)
        VALUES ('option_size', '${productId}', 'Size', 0, 'size'),
               ('option_color', '${productId}', 'Color', 1, 'color');
        INSERT INTO product_option_values (id, option_definition_id, value, position)
        VALUES ('value_42', 'option_size', '42', 0),
               ('value_41', 'option_size', '41', 1),
               ('value_green', 'option_color', 'Green', 0);
    `);
    const statement = sqlite.prepare(
        `INSERT INTO product_variants (
            id, product_id, option_combination_key, image_id, weight, sku, price, stock,
            reserved_stock, is_default, track_inventory
        ) VALUES (?, ?, ?, NULL, NULL, ?, 1000, 5, 0, 0, 1)`,
    );
    statement.run("var_mixed_size", productId, "value_42", "MIXED-SIZE");
    statement.run(
        "var_mixed_size_color",
        productId,
        "value_41|value_green",
        "MIXED-SIZE-COLOR",
    );
    sqlite.exec(`
        INSERT INTO product_variant_option_values VALUES
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
        sqlite = new DatabaseSync(":memory:");
        maxBoundParameters = 0;
        createCatalogSchema();
        db = createDatabase();

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
            page: 1,
            limit: 2,
        });
        const secondPage = await getStorefrontFeedProducts(db, {
            search: "shoes",
            page: 2,
            limit: 2,
        });

        expect(firstPage.products.map((product) => product.name)).toEqual([
            "Canvas Slip-On",
            "Everyday Loafer",
        ]);
        expect(firstPage.pagination).toEqual({
            page: 1,
            limit: 2,
            total: 3,
            totalPages: 2,
        });
        expect(secondPage.products.map((product) => product.name)).toEqual([
            "Classic Runner",
        ]);
        expect(secondPage.pagination.total).toBe(3);
        expect(
            [...firstPage.products, ...secondPage.products].some(
                (product) => product.id === "prod_mixed",
            ),
        ).toBe(false);
    });

    it("matches an exact indexed category slug without a product-title match", async () => {
        const result = await getStorefrontFeedProducts(db, {
            search: "formal-footwear",
            page: 1,
            limit: 10,
        });

        expect(result.products.map((product) => product.name)).toEqual([
            "Oxford Classic",
        ]);
        expect(result.pagination.total).toBe(1);
    });

    it("excludes products without usable primary media before feed pagination", async () => {
        sqlite.prepare("DELETE FROM product_images WHERE product_id = ?")
            .run("prod_slip_on");
        sqlite.prepare("UPDATE product_images SET url = '//unsafe.example/image.jpg' WHERE product_id = ?")
            .run("prod_loafer");

        const result = await getStorefrontFeedProducts(db, {
            search: "shoes",
            page: 1,
            limit: 10,
        });

        expect(result.products.map((product) => product.id)).toEqual(["prod_runner"]);
        expect(result.pagination).toEqual({
            page: 1,
            limit: 10,
            total: 1,
            totalPages: 1,
        });
    });

    it("scopes every multi-token term to the category name column", async () => {
        const result = await getStorefrontFeedProducts(db, {
            search: "men clothing",
            page: 1,
            limit: 10,
        });

        expect(result.products.map((product) => product.name)).toEqual([
            "Two Token Match",
        ]);
        expect(result.products.some((product) => product.id === "prod_description_trap"))
            .toBe(false);
        expect(result.pagination.total).toBe(1);
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
            page: 1,
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
            page: 1,
            limit: 100,
        });

        expect(result.products).toHaveLength(100);
        expect(result.pagination.total).toBe(106);
        expect(searchResult.data).toHaveLength(100);
        expect(searchResult.pagination.total).toBe(106);
        expect(lookupResult.products).toHaveLength(100);
        expect(lookupResult.pagination.total).toBe(100);
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
        sqlite.prepare("UPDATE product_variants SET price = 500 WHERE product_id = 'prod_runner'").run();
        sqlite.prepare("UPDATE product_variants SET price = 1500 WHERE product_id = 'prod_slip_on'").run();

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
            color: Array.from({ length: 91 }, (_, index) => `Value ${index}`),
        }, [])).rejects.toThrow(/At most 90 attribute filter values/);
        expect(maxBoundParameters).toBeLessThanOrEqual(100);
    });
});
