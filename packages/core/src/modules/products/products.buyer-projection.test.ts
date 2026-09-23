import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { products } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
    buildBuyerCatalogPricingProjection,
    buyerCatalogHasSkuInPriceRange,
} from "./products.buyer-projection";

const insertVariants = `INSERT INTO product_variants (
    id, product_id, sku, option_combination_key, price, stock, track_inventory, is_default,
    discount_type, discount_percentage, discount_amount
) VALUES`;

describe("buyer catalog pricing projection", () => {
    it("prefers purchasable SKUs and applies variant-over-product discount inheritance", async () => {
        const { sqlite, db } = createSqliteD1Database();
        sqlite.exec(`
            INSERT INTO products (id, name, slug, price, discount_type, discount_percentage, discount_amount) VALUES
                ('p1', 'P1', 'p1', 1, 'percentage', 10, 0),
                ('p2', 'P2', 'p2', 1, 'percentage', 10, 0),
                ('p3', 'P3', 'p3', 1, NULL, 0, 0);
            ${insertVariants}
                ('p1-hidden-default', 'p1', 'P1-D', NULL, 1, 50, 0, 1, NULL, 0, 0),
                ('p1-cheapest-sold-out', 'p1', 'P1-S', 'value_s', 40, 0, 1, 0, NULL, 0, 0),
                ('p1-available', 'p1', 'P1-M', 'value_m', 150, 5, 1, 0, 'flat', 0, 100),
                ('p1-other-sold-out', 'p1', 'P1-L', 'value_l', 100, 0, 1, 0, NULL, 0, 0),
                ('p2-lowest', 'p2', 'P2-A', 'value_a', 20, 0, 1, 0, NULL, 0, 0),
                ('p2-other', 'p2', 'P2-B', 'value_b', 30, 0, 1, 0, NULL, 0, 0),
                ('p3-default', 'p3', 'P3-D', NULL, 70, 0, 0, 1, NULL, 0, 0);
        `);
        const pricing = buildBuyerCatalogPricingProjection(db);
        const rows = await db
            .select({
                productId: products.id,
                skuId: pricing.skuId,
                basePrice: pricing.basePrice,
                effectivePrice: pricing.effectivePrice,
                discountType: pricing.discountType,
                discountAmount: pricing.discountAmount,
                availableForSale: pricing.availableForSale,
                hasCustomerOptions: pricing.hasCustomerOptions,
                hasDiscount: pricing.hasDiscount,
                maxBuyerPrice: pricing.maxBuyerPrice,
            })
            .from(products)
            .innerJoin(pricing, eq(products.id, pricing.productId))
            .orderBy(products.id);

        expect(rows).toEqual([
            {
                productId: "p1",
                skuId: "p1-available",
                basePrice: 150,
                effectivePrice: 50,
                discountType: "flat",
                discountAmount: 100,
                availableForSale: 1,
                hasCustomerOptions: 1,
                hasDiscount: 1,
                maxBuyerPrice: 50,
            },
            {
                productId: "p2",
                skuId: "p2-lowest",
                basePrice: 20,
                effectivePrice: 18,
                discountType: "percentage",
                discountAmount: 0,
                availableForSale: 0,
                hasCustomerOptions: 1,
                hasDiscount: 1,
                maxBuyerPrice: 27,
            },
            {
                productId: "p3",
                skuId: "p3-default",
                basePrice: 70,
                effectivePrice: 70,
                discountType: null,
                discountAmount: 0,
                availableForSale: 1,
                hasCustomerOptions: 0,
                hasDiscount: 0,
                maxBuyerPrice: 70,
            },
        ]);
    });

    it("matches an actual buyer SKU rather than a loose min/max interval", async () => {
        const { sqlite, db } = createSqliteD1Database();
        sqlite.exec(`
            INSERT INTO products (id, name, slug, price, discount_type, discount_percentage, discount_amount) VALUES
                ('p_gap', 'Gap', 'gap', 1, NULL, 0, 0),
                ('p_match', 'Match', 'match', 1, NULL, 0, 0);
            ${insertVariants}
                ('gap-hidden-default', 'p_gap', 'GAP-D', NULL, 1, 1, 0, 1, NULL, 0, 0),
                ('gap-low', 'p_gap', 'GAP-S', 'value_s', 50, 1, 1, 0, NULL, 0, 0),
                ('gap-high', 'p_gap', 'GAP-M', 'value_m', 150, 1, 1, 0, NULL, 0, 0),
                ('match', 'p_match', 'MATCH', NULL, 100, 1, 1, 1, NULL, 0, 0);
        `);
        const rows = await db
            .select({ id: products.id })
            .from(products)
            .where(buyerCatalogHasSkuInPriceRange(80, 120))
            .orderBy(products.id);

        expect(rows).toEqual([{ id: "p_match" }]);
    });
});
