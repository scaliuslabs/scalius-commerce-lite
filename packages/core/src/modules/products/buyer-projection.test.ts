import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { products } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
    buildBuyerCatalogPricingProjection,
    buyerCatalogHasSkuInPriceRange,
} from "./buyer-projection";

const insertVariants = `INSERT INTO product_variants (
    id, product_id, sku, option_combination_key, price_minor, stock, track_inventory, is_default,
    discount_type, discount_bps, discount_amount_minor
) VALUES`;

describe("buyer catalog pricing projection", () => {
    it("prefers purchasable SKUs and applies variant-over-product discount inheritance", async () => {
        const { sqlite, db } = createSqliteD1Database();
        sqlite.exec(`
            INSERT INTO products (id, name, slug, price_minor, discount_type, discount_bps, discount_amount_minor) VALUES
                ('p1', 'P1', 'p1', 100, 'percentage', 1000, 0),
                ('p2', 'P2', 'p2', 100, 'percentage', 1000, 0),
                ('p3', 'P3', 'p3', 100, NULL, 0, 0);
            ${insertVariants}
                ('p1-hidden-default', 'p1', 'P1-D', NULL, 100, 50, 0, 1, NULL, 0, 0),
                ('p1-cheapest-sold-out', 'p1', 'P1-S', 'value_s', 4000, 0, 1, 0, NULL, 0, 0),
                ('p1-available', 'p1', 'P1-M', 'value_m', 15000, 5, 1, 0, 'flat', 0, 10000),
                ('p1-other-sold-out', 'p1', 'P1-L', 'value_l', 10000, 0, 1, 0, NULL, 0, 0),
                ('p2-lowest', 'p2', 'P2-A', 'value_a', 2000, 0, 1, 0, NULL, 0, 0),
                ('p2-other', 'p2', 'P2-B', 'value_b', 3000, 0, 1, 0, NULL, 0, 0),
                ('p3-default', 'p3', 'P3-D', NULL, 7000, 0, 0, 1, NULL, 0, 0);
        `);
        const pricing = buildBuyerCatalogPricingProjection(db);
        const rows = await db
            .select({
                productId: products.id,
                skuId: pricing.skuId,
                basePriceMinor: pricing.basePriceMinor,
                effectivePriceMinor: pricing.effectivePriceMinor,
                discountType: pricing.discountType,
                discountAmountMinor: pricing.discountAmountMinor,
                availableForSale: pricing.availableForSale,
                hasCustomerOptions: pricing.hasCustomerOptions,
                hasDiscount: pricing.hasDiscount,
                maxBuyerPriceMinor: pricing.maxBuyerPriceMinor,
            })
            .from(products)
            .innerJoin(pricing, eq(products.id, pricing.productId))
            .orderBy(products.id);

        expect(rows).toEqual([
            {
                productId: "p1",
                skuId: "p1-available",
                basePriceMinor: 15000,
                effectivePriceMinor: 5000,
                discountType: "flat",
                discountAmountMinor: 10000,
                availableForSale: 1,
                hasCustomerOptions: 1,
                hasDiscount: 1,
                maxBuyerPriceMinor: 5000,
            },
            {
                productId: "p2",
                skuId: "p2-lowest",
                basePriceMinor: 2000,
                effectivePriceMinor: 1800,
                discountType: "percentage",
                discountAmountMinor: 0,
                availableForSale: 0,
                hasCustomerOptions: 1,
                hasDiscount: 1,
                maxBuyerPriceMinor: 2700,
            },
            {
                productId: "p3",
                skuId: "p3-default",
                basePriceMinor: 7000,
                effectivePriceMinor: 7000,
                discountType: null,
                discountAmountMinor: 0,
                availableForSale: 1,
                hasCustomerOptions: 0,
                hasDiscount: 0,
                maxBuyerPriceMinor: 7000,
            },
        ]);
    });

    it("matches an actual buyer SKU rather than a loose min/max interval", async () => {
        const { sqlite, db } = createSqliteD1Database();
        sqlite.exec(`
            INSERT INTO products (id, name, slug, price_minor, discount_type, discount_bps, discount_amount_minor) VALUES
                ('p_gap', 'Gap', 'gap', 100, NULL, 0, 0),
                ('p_match', 'Match', 'match', 100, NULL, 0, 0);
            ${insertVariants}
                ('gap-hidden-default', 'p_gap', 'GAP-D', NULL, 100, 1, 0, 1, NULL, 0, 0),
                ('gap-low', 'p_gap', 'GAP-S', 'value_s', 5000, 1, 1, 0, NULL, 0, 0),
                ('gap-high', 'p_gap', 'GAP-M', 'value_m', 15000, 1, 1, 0, NULL, 0, 0),
                ('match', 'p_match', 'MATCH', NULL, 10000, 1, 1, 1, NULL, 0, 0);
        `);
        const rows = await db
            .select({ id: products.id })
            .from(products)
            .where(buyerCatalogHasSkuInPriceRange(8_000, 12_000))
            .orderBy(products.id);

        expect(rows).toEqual([{ id: "p_match" }]);
    });
});
