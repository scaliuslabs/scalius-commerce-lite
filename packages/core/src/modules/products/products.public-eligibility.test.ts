import { describe, expect, it } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
    defaultProductSkuValues,
    normalizeDefaultSkuOptions,
    operationalSkuRowPredicate,
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
        expect(query.sql).toContain("buyer_shape_sku");
        expect(query.sql).toContain("buyer_active_sku");
        expect(query.sql).toContain("buyer_simple_sku");
        expect(query.sql).toContain("product_id");
        expect(query.sql).toContain("deleted_at");
        expect(query.sql).toContain("id");
        expect(query.sql).toContain("default");
        expect(query.sql).toContain("is_default");
        expect(query.sql).toContain("buyer_simple_sku.is_default");
        expect(query.sql).toContain("count(*)");
        expect(query.sql).toContain("product_option_definitions");
        expect(query.sql).toContain("product_variant_option_values");
        expect(query.sql).toContain("product_option_values");
        expect(query.sql).toContain("option_combination_key");
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
        expect(query.sql).toContain("buyer_shape_sku");
        expect(query.sql).toContain("buyer_simple_sku");
    });

    it("defines hasVariants as customer-facing options, not the protected simple SKU", () => {
        const dialect = new SQLiteSyncDialect();
        const query = dialect.sqlToQuery(publicProductHasCustomerOptions());

        expect(query.sql).toContain("buyer_option_sku");
        expect(query.sql).toContain("is_default");
        expect(query.sql).toContain("= 0");
        expect(query.sql).toContain("trim(coalesce");
        expect(query.sql).toContain("option_combination_key");
        expect(query.sql).toContain("product_option_definitions");
        expect(query.sql).not.toContain("buyer_simple_sku");
    });

    it("projects buyer purchase availability from the same SKU topology", () => {
        const dialect = new SQLiteSyncDialect();
        const query = dialect.sqlToQuery(publicProductHasAvailableBuyerSku());

        expect(query.sql).toContain("buyer_available_option_sku");
        expect(query.sql).toContain("buyer_shape_sku");
        expect(query.sql).toContain("buyer_available_simple_sku");
        expect(query.sql).toContain("track_inventory");
        expect(query.sql).toContain("stock");
        expect(query.sql).toContain("reserved_stock");
        expect(query.sql).toContain("> 0");
        expect(query.sql).toContain("count(*)");
        expect(query.sql).not.toContain("buyer_option_sku");
    });

    it("keeps protected default SKUs operational only for simple products", () => {
        const dialect = new SQLiteSyncDialect();
        const query = dialect.sqlToQuery(operationalSkuRowPredicate());

        expect(query.sql).toContain("product_variants.is_default");
        expect(query.sql).toContain("operational_option_sku");
        expect(query.sql).toContain("operational_option_sku.product_id = product_variants.product_id");
        expect(query.sql).toContain("operational_option_sku.is_default = 0");
        expect(query.sql).toContain("operational_option_sku.deleted_at IS NULL");
        expect(query.sql).toContain("operational_option_sku.option_combination_key");
    });

    it("creates the protected untracked default SKU shape for simple products", () => {
        expect(defaultProductSkuValues("prod_1", 1250)).toMatchObject({
            id: "var_default_prod_1",
            productId: "prod_1",
            sku: "SIMPLE-prod_1",
            optionCombinationKey: null,
            price: 1250,
            stock: 0,
            reservedStock: 0,
            isDefault: true,
            trackInventory: false,
            barcode: "SCALIUS:C128:default_prod_1",
            barcodeType: "code128",
            deletedAt: null,
        });
    });

    it("normalizes protected default SKU option labels before exposing DTOs", () => {
        expect(
            normalizeDefaultSkuOptions({
                isDefault: true,
                optionCombinationKey: null,
            }),
        ).toMatchObject({
            optionCombinationKey: null,
        });

        expect(
            normalizeDefaultSkuOptions({
                isDefault: false,
                optionCombinationKey: "2kg|red",
            }),
        ).toMatchObject({
            optionCombinationKey: "2kg|red",
        });
    });
});
