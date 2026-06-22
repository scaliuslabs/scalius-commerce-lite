import { describe, expect, it } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
    defaultProductSkuValues,
    publicProductBaseConditions,
    publicProductHasBuyerResolvableSku,
} from "./products.public-eligibility";

describe("public product SKU eligibility", () => {
    it("uses a buyer-resolvable SKU topology instead of active product rows alone", () => {
        const dialect = new SQLiteSyncDialect();
        const query = dialect.sqlToQuery(publicProductHasBuyerResolvableSku());

        expect(query.sql).toContain("buyer_option_sku");
        expect(query.sql).toContain("buyer_active_sku");
        expect(query.sql).toContain("buyer_simple_sku");
        expect(query.sql).toContain("product_id");
        expect(query.sql).toContain("deleted_at");
        expect(query.sql).toContain("id");
        expect(query.sql).toContain("default");
        expect(query.sql).toContain("is_default");
        expect(query.sql).toContain("buyer_simple_sku.is_default");
        expect(query.sql).toContain("count(*)");
    });

    it("keeps public product base conditions gated by SKU eligibility", () => {
        const conditions = publicProductBaseConditions();
        const dialect = new SQLiteSyncDialect();
        const query = dialect.sqlToQuery(conditions[2]!);

        expect(conditions).toHaveLength(3);
        expect(query.sql).toContain("buyer_option_sku");
        expect(query.sql).toContain("buyer_simple_sku");
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
});
