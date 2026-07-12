import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq, sql } from "drizzle-orm";
import { products } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import {
    buildBuyerCatalogPricingProjection,
    buyerCatalogHasSkuInPriceRange,
} from "./products.buyer-projection";

function inlineSqlParams(sql: string, params: unknown[]): string {
    let index = 0;
    return sql.replaceAll("?", () => {
        const value = params[index++];
        if (typeof value === "number") return String(value);
        if (value === null) return "NULL";
        return `'${String(value).replaceAll("'", "''")}'`;
    });
}

describe("buyer catalog pricing projection", () => {
    it("prefers purchasable SKUs and applies variant-over-product discount inheritance", () => {
        const db = drizzle(async () => ({ rows: [] })) as unknown as Database;
        const pricing = buildBuyerCatalogPricingProjection(db);
        const compiled = db
            .select({
                productId: sql<string>`${products.id}`.as("result_product_id"),
                skuId: sql<string>`${pricing.skuId}`.as("result_sku_id"),
                basePrice: sql<number>`${pricing.basePrice}`.as("result_base_price"),
                effectivePrice: sql<number>`${pricing.effectivePrice}`.as("result_effective_price"),
                discountType: sql<string | null>`${pricing.discountType}`.as("result_discount_type"),
                discountAmount: sql<number | null>`${pricing.discountAmount}`.as("result_discount_amount"),
                availableForSale: sql<number>`${pricing.availableForSale}`.as("result_available"),
                hasCustomerOptions: sql<number>`${pricing.hasCustomerOptions}`.as("result_has_options"),
                hasDiscount: sql<number>`${pricing.hasDiscount}`.as("result_has_discount"),
                maxBuyerPrice: sql<number>`${pricing.maxBuyerPrice}`.as("result_max_buyer_price"),
            })
            .from(products)
            .innerJoin(pricing, eq(products.id, pricing.productId))
            .orderBy(products.id)
            .toSQL();

        const query = inlineSqlParams(compiled.sql, compiled.params);
        const script = `
            CREATE TABLE products (
                id TEXT PRIMARY KEY,
                discount_type TEXT,
                discount_percentage REAL,
                discount_amount REAL
            );
            CREATE TABLE product_variants (
                id TEXT PRIMARY KEY,
                product_id TEXT NOT NULL,
                option_combination_key TEXT,
                price REAL NOT NULL,
                stock INTEGER NOT NULL,
                reserved_stock INTEGER NOT NULL,
                track_inventory INTEGER NOT NULL,
                is_default INTEGER NOT NULL,
                discount_type TEXT,
                discount_percentage REAL,
                discount_amount REAL,
                deleted_at INTEGER
            );
            INSERT INTO products VALUES
                ('p1', 'percentage', 10, 0),
                ('p2', 'percentage', 10, 0);
            INSERT INTO product_variants VALUES
                ('p1-hidden-default', 'p1', NULL, 1, 50, 0, 0, 1, NULL, 0, 0, NULL),
                ('p1-cheapest-sold-out', 'p1', 'value_s', 40, 0, 0, 1, 0, NULL, 0, 0, NULL),
                ('p1-available', 'p1', 'value_m', 150, 5, 0, 1, 0, 'flat', 0, 100, NULL),
                ('p1-other-sold-out', 'p1', 'value_l', 100, 0, 0, 1, 0, NULL, 0, 0, NULL),
                ('p2-lowest', 'p2', NULL, 20, 0, 0, 1, 1, NULL, 0, 0, NULL),
                ('p2-other', 'p2', NULL, 30, 0, 0, 1, 0, NULL, 0, 0, NULL);
            ${query};
        `;
        const result = spawnSync("sqlite3", ["-json", ":memory:"], {
            input: script,
            encoding: "utf8",
        });

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([
            {
                result_product_id: "p1",
                result_sku_id: "p1-available",
                result_base_price: 150,
                result_effective_price: 50,
                result_discount_type: "flat",
                result_discount_amount: 100,
                result_available: 1,
                result_has_options: 1,
                result_has_discount: 1,
                result_max_buyer_price: 50,
            },
            {
                result_product_id: "p2",
                result_sku_id: "p2-lowest",
                result_base_price: 20,
                result_effective_price: 18,
                result_discount_type: "percentage",
                result_discount_amount: 0,
                result_available: 0,
                result_has_options: 0,
                result_has_discount: 1,
                result_max_buyer_price: 27,
            },
        ]);
    });

    it("matches an actual buyer SKU rather than a loose min/max interval", () => {
        const db = drizzle(async () => ({ rows: [] })) as unknown as Database;
        const compiled = db
            .select({ id: sql<string>`${products.id}`.as("result_id") })
            .from(products)
            .where(buyerCatalogHasSkuInPriceRange(80, 120))
            .orderBy(products.id)
            .toSQL();
        const query = inlineSqlParams(compiled.sql, compiled.params);
        const script = `
            CREATE TABLE products (
                id TEXT PRIMARY KEY,
                discount_type TEXT,
                discount_percentage REAL,
                discount_amount REAL
            );
            CREATE TABLE product_variants (
                id TEXT PRIMARY KEY,
                product_id TEXT NOT NULL,
                option_combination_key TEXT,
                price REAL NOT NULL,
                stock INTEGER NOT NULL,
                reserved_stock INTEGER NOT NULL,
                track_inventory INTEGER NOT NULL,
                is_default INTEGER NOT NULL,
                discount_type TEXT,
                discount_percentage REAL,
                discount_amount REAL,
                deleted_at INTEGER
            );
            INSERT INTO products VALUES ('p_gap', NULL, 0, 0), ('p_match', NULL, 0, 0);
            INSERT INTO product_variants VALUES
                ('gap-hidden-default', 'p_gap', NULL, 1, 1, 0, 0, 1, NULL, 0, 0, NULL),
                ('gap-low', 'p_gap', 'value_s', 50, 1, 0, 1, 0, NULL, 0, 0, NULL),
                ('gap-high', 'p_gap', 'value_m', 150, 1, 0, 1, 0, NULL, 0, 0, NULL),
                ('match', 'p_match', NULL, 100, 1, 0, 1, 1, NULL, 0, 0, NULL);
            ${query};
        `;
        const result = spawnSync("sqlite3", ["-json", ":memory:"], {
            input: script,
            encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([{ result_id: "p_match" }]);
    });
});
