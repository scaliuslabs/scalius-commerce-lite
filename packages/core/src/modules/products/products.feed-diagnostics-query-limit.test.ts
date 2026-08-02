import { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import type { SeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it } from "vitest";

import { getProductFeedDiagnostics } from "./products.feed-diagnostics";

const feedsPolicy: SeoDiscoverySettings["feeds"] = {
    productCatalogEnabled: true,
    includeUnavailableProducts: false,
    variantStrategy: "variants",
    title: "",
    description: "",
};

function createSchema(sqlite: DatabaseSync): void {
    sqlite.exec(`
        CREATE TABLE products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL,
            is_active INTEGER NOT NULL,
            exclude_from_product_feed INTEGER NOT NULL,
            price REAL NOT NULL,
            discount_type TEXT,
            discount_percentage REAL,
            discount_amount REAL,
            deleted_at INTEGER,
            updated_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE media (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            object_key TEXT NOT NULL,
            poster_media_id TEXT,
            alt_text TEXT,
            caption TEXT,
            width INTEGER,
            height INTEGER,
            duration_ms INTEGER,
            status TEXT NOT NULL
        );
        CREATE TABLE product_media (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            media_id TEXT NOT NULL,
            alt_text TEXT,
            sort_order INTEGER NOT NULL,
            is_primary INTEGER NOT NULL
        );
        CREATE TABLE product_variants (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            option_combination_key TEXT,
            stock INTEGER NOT NULL,
            reserved_stock INTEGER NOT NULL,
            is_default INTEGER NOT NULL,
            track_inventory INTEGER NOT NULL,
            price REAL NOT NULL,
            discount_type TEXT,
            discount_percentage REAL,
            discount_amount REAL,
            deleted_at INTEGER
        );
        CREATE TABLE inventory_reservation_lanes (
            variant_id TEXT NOT NULL,
            pool TEXT NOT NULL,
            lane INTEGER NOT NULL,
            reserved_quantity INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (variant_id, pool, lane)
        );
    `);
}

function seedSimpleProducts(sqlite: DatabaseSync, count: number): void {
    const insertProduct = sqlite.prepare(`
        INSERT INTO products (
            id, name, slug, is_active, exclude_from_product_feed, price,
            discount_type, discount_percentage, discount_amount,
            deleted_at, updated_at, created_at
        ) VALUES (?, ?, ?, 1, 0, 1200, NULL, NULL, NULL, NULL, ?, ?)
    `);
    const insertMedia = sqlite.prepare(`
        INSERT INTO media (id, kind, object_key, alt_text, status)
        VALUES (?, 'image', ?, ?, 'ready')
    `);
    const insertProductMedia = sqlite.prepare(`
        INSERT INTO product_media (id, product_id, media_id, alt_text, sort_order, is_primary)
        VALUES (?, ?, ?, ?, 0, 1)
    `);
    const insertVariant = sqlite.prepare(`
        INSERT INTO product_variants (
            id, product_id, option_combination_key, stock, reserved_stock, is_default,
            track_inventory, price, discount_type, discount_percentage,
            discount_amount, deleted_at
        ) VALUES (?, ?, NULL, 0, 0, 1, 0, 1200, NULL, NULL, NULL, NULL)
    `);

    for (let index = 0; index < count; index += 1) {
        const productId = `prod_${index.toString().padStart(3, "0")}`;
        insertProduct.run(
            productId,
            `Product ${index}`,
            `product-${index}`,
            index,
            index,
        );
        const mediaId = `media_${index}`;
        insertMedia.run(mediaId, `products/product-${index}.jpg`, `Product ${index}`);
        insertProductMedia.run(`pmed_${index}`, productId, mediaId, `Product ${index}`);
        insertVariant.run(`var_default_${index}`, productId);
    }
}

describe("product feed diagnostic D1 query limits", () => {
    let sqlite: DatabaseSync | null = null;

    afterEach(() => {
        sqlite?.close();
        sqlite = null;
    });

    it("chunks more than 100 products while preserving every diagnostic row", async () => {
        sqlite = new DatabaseSync(":memory:");
        createSchema(sqlite);
        seedSimpleProducts(sqlite, 205);

        const observedQueries: Array<{ query: string; params: unknown[] }> = [];
        const proxy = drizzle(async (query, params, method) => {
            observedQueries.push({ query, params });
            if (params.length > 100) {
                throw new Error(`D1 bound-parameter limit exceeded: ${params.length}`);
            }

            const statement = sqlite!.prepare(query);
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
                rows: statement.all(...params) as unknown as unknown[][],
            };
        });

        const report = await getProductFeedDiagnostics(
            proxy as unknown as Database,
            feedsPolicy,
            {
                scanLimit: 200,
                storefrontBaseUrl: "https://store.example.test",
                currencyCode: "BDT",
            },
        );

        expect(report.scan).toMatchObject({
            limit: 200,
            scannedProducts: 200,
            truncated: true,
        });
        expect(report.totals).toMatchObject({
            emittedRows: 200,
            emittedProductRows: 200,
            emittedVariantRows: 0,
            productsWithIssues: 0,
            skippedRows: 0,
        });
        const boundParameterCounts = observedQueries.map(({ params }) => params.length);
        expect(Math.max(...boundParameterCounts)).toBeLessThanOrEqual(100);
        expect(
            boundParameterCounts
                .filter((count) => count >= 20)
                .sort((left, right) => left - right),
        ).toEqual([20, 90, 90]);

        const mediaQueries = observedQueries.filter(({ query }) =>
            query.includes('from "product_media"'),
        );
        expect(mediaQueries).toHaveLength(3);
        expect(mediaQueries.every(({ query }) => query.includes("json_each"))).toBe(true);
        expect(mediaQueries.map(({ params }) => {
            const encodedIds = params.find((parameter) =>
                typeof parameter === "string" && parameter.startsWith('["prod_'),
            );
            return Array.isArray(JSON.parse(String(encodedIds)))
                ? JSON.parse(String(encodedIds)).length as number
                : 0;
        }).sort((left, right) => left - right)).toEqual([20, 90, 90]);
    });
});
