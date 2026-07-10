import { describe, expect, it } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
    defaultProductSkuValues,
    normalizeDefaultSkuOptions,
    publicProductBaseConditions,
    publicProductHasAvailableBuyerSku,
    publicProductHasCustomerOptions,
    publicProductHasBuyerResolvableSku,
} from "./products.public-eligibility";

describe("public product SKU eligibility", () => {
    it("uses a buyer-resolvable SKU topology instead of active product rows alone", () => {
        const dialect = new SQLiteSyncDialect();
        const query = dialect.sqlToQuery(publicProductHasBuyerResolvableSku());

        expect(query.sql).toContain("buyer_option_sku");
        expect(query.sql).toContain("buyer_option_shape_sku");
        expect(query.sql).toContain("buyer_active_sku");
        expect(query.sql).toContain("buyer_simple_sku");
        expect(query.sql).toContain("product_id");
        expect(query.sql).toContain("deleted_at");
        expect(query.sql).toContain("id");
        expect(query.sql).toContain("default");
        expect(query.sql).toContain("is_default");
        expect(query.sql).toContain("buyer_simple_sku.is_default");
        expect(query.sql).toContain("count(*)");
        expect(query.sql).toContain("min(CASE");
        expect(query.sql).toContain("max(CASE");
        expect(query.sql).not.toContain("count(DISTINCT");
    });

    it("treats is_default as the simple-SKU authority even if old option labels drifted", () => {
        const dialect = new SQLiteSyncDialect();
        const query = dialect.sqlToQuery(publicProductHasBuyerResolvableSku());

        expect(query.sql).toContain("buyer_simple_sku.is_default");
        expect(query.sql).not.toContain("buyer_simple_sku.size");
        expect(query.sql).not.toContain("buyer_simple_sku.color");
    });

    it("keeps public product base conditions gated by SKU eligibility", () => {
        const conditions = publicProductBaseConditions();
        const dialect = new SQLiteSyncDialect();
        const query = dialect.sqlToQuery(conditions[2]!);

        expect(conditions).toHaveLength(3);
        expect(query.sql).toContain("buyer_option_sku");
        expect(query.sql).toContain("buyer_option_shape_sku");
        expect(query.sql).toContain("buyer_simple_sku");
    });

    it("defines hasVariants as customer-facing options, not the protected simple SKU", () => {
        const dialect = new SQLiteSyncDialect();
        const query = dialect.sqlToQuery(publicProductHasCustomerOptions());

        expect(query.sql).toContain("buyer_option_sku");
        expect(query.sql).toContain("is_default");
        expect(query.sql).toContain("= 0");
        expect(query.sql).toContain("trim(coalesce");
        expect(query.sql).toContain("size");
        expect(query.sql).toContain("color");
        expect(query.sql).not.toContain("buyer_simple_sku");
        expect(query.sql).not.toContain("count(*)");
    });

    it("projects buyer purchase availability from the same SKU topology", () => {
        const dialect = new SQLiteSyncDialect();
        const query = dialect.sqlToQuery(publicProductHasAvailableBuyerSku());

        expect(query.sql).toContain("buyer_available_option_sku");
        expect(query.sql).toContain("buyer_available_option_shape_sku");
        expect(query.sql).toContain("buyer_available_simple_sku");
        expect(query.sql).toContain("track_inventory");
        expect(query.sql).toContain("stock");
        expect(query.sql).toContain("reserved_stock");
        expect(query.sql).toContain("> 0");
        expect(query.sql).toContain("count(*)");
        expect(query.sql).not.toContain("buyer_option_sku");
    });

    it("creates the protected untracked default SKU shape for simple products", () => {
        expect(defaultProductSkuValues("prod_1", 1250)).toMatchObject({
            id: "var_default_prod_1",
            productId: "prod_1",
            sku: "SIMPLE-prod_1",
            size: null,
            color: null,
            price: 1250,
            stock: 0,
            reservedStock: 0,
            isDefault: true,
            trackInventory: false,
            deletedAt: null,
        });
    });

    it("normalizes protected default SKU option labels before exposing DTOs", () => {
        expect(
            normalizeDefaultSkuOptions({
                id: "var_default_prod_1",
                isDefault: true,
                size: "Default",
                color: "Default",
            }),
        ).toMatchObject({
            size: null,
            color: null,
        });

        expect(
            normalizeDefaultSkuOptions({
                id: "var_option_1",
                isDefault: false,
                size: "2KG",
                color: "Red",
            }),
        ).toMatchObject({
            size: "2KG",
            color: "Red",
        });
    });
});
