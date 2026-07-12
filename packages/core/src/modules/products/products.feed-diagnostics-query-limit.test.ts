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
        CREATE TABLE product_images (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            url TEXT NOT NULL,
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
    const insertImage = sqlite.prepare(`
        INSERT INTO product_images (id, product_id, url, is_primary)
        VALUES (?, ?, ?, 1)
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
        insertImage.run(
            `image_${index}`,
            productId,
            `/images/product-${index}.jpg`,
        );
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

        const boundParameterCounts: number[] = [];
        const proxy = drizzle(async (query, params, method) => {
            boundParameterCounts.push(params.length);
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
        expect(Math.max(...boundParameterCounts)).toBeLessThanOrEqual(100);
        expect(
            boundParameterCounts
                .filter((count) => count >= 20)
                .sort((left, right) => left - right),
        ).toEqual([20, 21, 90, 90, 91, 91]);
    });
});
