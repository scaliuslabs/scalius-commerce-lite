import type { DatabaseSync } from "node:sqlite";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { SeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import { afterEach, describe, expect, it } from "vitest";

import { getProductFeedDiagnostics } from "./products.feed-diagnostics";

const feedsPolicy: SeoDiscoverySettings["feeds"] = {
    productCatalogEnabled: true,
    includeUnavailableProducts: false,
    variantStrategy: "variants",
    title: "",
    description: "",
};

function seedSimpleProducts(sqlite: DatabaseSync, count: number): void {
    const insertProduct = sqlite.prepare(`
        INSERT INTO products (id, name, slug, is_active, price_minor, updated_at, created_at)
        VALUES (?, ?, ?, 1, 120000, ?, ?)
    `);
    const insertMedia = sqlite.prepare(`
        INSERT INTO media (id, filename, kind, object_key, size, mime_type, alt_text, status)
        VALUES (?, ?, 'image', ?, 1, 'image/jpeg', ?, 'ready')
    `);
    const insertProductMedia = sqlite.prepare(`
        INSERT INTO product_media (id, product_id, media_id, alt_text, sort_order, is_primary)
        VALUES (?, ?, ?, ?, 0, 1)
    `);
    const insertVariant = sqlite.prepare(`
        INSERT INTO product_variants (id, product_id, sku, stock, is_default, track_inventory, price_minor)
        VALUES (?, ?, ?, 0, 1, 0, 120000)
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
        insertMedia.run(mediaId, `product-${index}.jpg`, `products/product-${index}.jpg`, `Product ${index}`);
        insertProductMedia.run(`pmed_${productId}`, productId, mediaId, `Product ${index}`);
        insertVariant.run(`var_default_${index}`, productId, `SKU-${index}`);
    }
}

describe("product feed diagnostic D1 query limits", () => {
    let sqlite: DatabaseSync | null = null;

    afterEach(() => {
        sqlite?.close();
        sqlite = null;
    });

    it("chunks more than 100 products while preserving every diagnostic row", async () => {
        const observedQueries: Array<{ query: string; params: readonly unknown[] }> = [];
        const database = createSqliteD1Database({
            onQuery(query, params) {
                observedQueries.push({ query, params });
                if (params.length > 100) {
                    throw new Error(`D1 bound-parameter limit exceeded: ${params.length}`);
                }
            },
        });
        sqlite = database.sqlite;
        seedSimpleProducts(sqlite, 205);

        const report = await getProductFeedDiagnostics(
            database.db,
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
