import { products, productVariants } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { effectivePriceMinorSql } from "./products.money";

/**
 * Builds the one-row-per-product pricing projection used by buyer catalog lists.
 *
 * Selection policy is deliberate:
 * - prefer an in-stock/untracked SKU when at least one can be bought now;
 * - within that pool, choose the lowest effective price;
 * - when every SKU is sold out, still choose the lowest effective price so the
 *   product can remain visible with truthful sold-out pricing;
 * - a valid SKU discount overrides the product discount, matching checkout and
 *   the product-page pricing engine.
 *
 * This is a derived query rather than N correlated SKU lookups. SQLite ranks
 * the active SKU rows once and every list/filter/sort consumer joins the same
 * projection.
 */
export function buildBuyerCatalogPricingProjection(db: Database) {
    const pricingProduct = alias(products, "buyer_pricing_product");
    const pricingSku = alias(productVariants, "buyer_pricing_sku");
    const availableStock = sql`(${pricingSku.stock} - ${pricingSku.reservedStock})`;

    const skuAvailable = sql<number>`CASE
        WHEN ${pricingSku.trackInventory} = 0
          OR ${availableStock} > 0
        THEN 1 ELSE 0
    END`;
    const skuHasDiscount = sql<number>`CASE
        WHEN ${pricingSku.discountType} = 'flat' AND ${pricingSku.discountAmountMinor} > 0 THEN 1
        WHEN ${pricingSku.discountType} = 'percentage' AND ${pricingSku.discountBps} > 0 THEN 1
        ELSE 0
    END`;
    const effectivePrice = effectivePriceMinorSql({
        priceMinor: sql`${pricingSku.priceMinor}`,
        discountType: sql`${pricingSku.discountType}`,
        discountBps: sql`${pricingSku.discountBps}`,
        discountAmountMinor: sql`${pricingSku.discountAmountMinor}`,
    }, {
        discountType: sql`${pricingProduct.discountType}`,
        discountBps: sql`${pricingProduct.discountBps}`,
        discountAmountMinor: sql`${pricingProduct.discountAmountMinor}`,
    });
    const resolvedDiscountType = sql<string | null>`CASE
        WHEN ${skuHasDiscount} = 1 THEN ${pricingSku.discountType}
        ELSE ${pricingProduct.discountType}
    END`;
    const resolvedDiscountBps = sql<number>`CASE
        WHEN ${skuHasDiscount} = 1 THEN ${pricingSku.discountBps}
        ELSE ${pricingProduct.discountBps}
    END`;
    const resolvedDiscountAmountMinor = sql<number>`CASE
        WHEN ${skuHasDiscount} = 1 THEN ${pricingSku.discountAmountMinor}
        ELSE ${pricingProduct.discountAmountMinor}
    END`;

    const rankedSkus = db
        .select({
            productId: pricingSku.productId,
            skuId: pricingSku.id,
            basePriceMinor: pricingSku.priceMinor,
            effectivePriceMinor: effectivePrice.as("buyer_effective_price"),
            discountType: resolvedDiscountType.as("buyer_discount_type"),
            discountBps: resolvedDiscountBps.as("buyer_discount_bps"),
            discountAmountMinor: resolvedDiscountAmountMinor.as("buyer_discount_amount"),
            availableForSale: sql<number>`MAX(${skuAvailable}) OVER (
                PARTITION BY ${pricingSku.productId}
            )`.as("buyer_available_for_sale"),
            hasCustomerOptions: sql<number>`MAX(CASE
                WHEN ${pricingSku.isDefault} = 0
                  AND trim(coalesce(${pricingSku.optionCombinationKey}, '')) <> ''
                THEN 1 ELSE 0
            END) OVER (PARTITION BY ${pricingSku.productId})`.as("buyer_has_customer_options"),
            hasAnyDiscount: sql<number>`MAX(CASE
                WHEN ${effectivePrice} < ${pricingSku.priceMinor} THEN 1 ELSE 0
            END) OVER (PARTITION BY ${pricingSku.productId})`.as("buyer_has_any_discount"),
            hasAvailableDiscount: sql<number>`MAX(CASE
                WHEN ${skuAvailable} = 1 AND ${effectivePrice} < ${pricingSku.priceMinor} THEN 1 ELSE 0
            END) OVER (PARTITION BY ${pricingSku.productId})`.as("buyer_has_available_discount"),
            maxAvailableEffectivePrice: sql<number | null>`MAX(CASE
                WHEN ${skuAvailable} = 1 THEN ${effectivePrice} ELSE NULL
            END) OVER (PARTITION BY ${pricingSku.productId})`.as("buyer_max_available_effective_price"),
            maxEffectivePrice: sql<number>`MAX(${effectivePrice}) OVER (
                PARTITION BY ${pricingSku.productId}
            )`.as("buyer_max_effective_price"),
            buyerRank: sql<number>`ROW_NUMBER() OVER (
                PARTITION BY ${pricingSku.productId}
                ORDER BY ${skuAvailable} DESC, ${effectivePrice} ASC, ${pricingSku.id} ASC
            )`.as("buyer_rank"),
        })
        .from(pricingSku)
        .innerJoin(pricingProduct, eq(pricingProduct.id, pricingSku.productId))
        .where(and(
            isNull(pricingSku.deletedAt),
            sql`${pricingSku.id} <> 'default'`,
            sql`(
                ${pricingSku.isDefault} = 0
                OR NOT EXISTS (
                    SELECT 1
                    FROM product_variants AS buyer_option_sku
                    WHERE buyer_option_sku.product_id = ${pricingSku.productId}
                      AND buyer_option_sku.deleted_at IS NULL
                      AND buyer_option_sku.id <> 'default'
                      AND buyer_option_sku.is_default = 0
                      AND trim(coalesce(buyer_option_sku.option_combination_key, '')) <> ''
                )
            )`,
        ))
        .as("buyer_ranked_skus");

    return db
        .select({
            productId: rankedSkus.productId,
            skuId: rankedSkus.skuId,
            basePriceMinor: rankedSkus.basePriceMinor,
            effectivePriceMinor: sql<number>`${rankedSkus.effectivePriceMinor}`.as("buyer_effective_price"),
            discountType: sql<string | null>`${rankedSkus.discountType}`.as("buyer_discount_type"),
            discountBps: sql<number>`${rankedSkus.discountBps}`.as("buyer_discount_bps"),
            discountAmountMinor: sql<number>`${rankedSkus.discountAmountMinor}`.as("buyer_discount_amount"),
            availableForSale: sql<number>`${rankedSkus.availableForSale}`.as("buyer_available_for_sale"),
            hasCustomerOptions: sql<number>`${rankedSkus.hasCustomerOptions}`.as("buyer_has_customer_options"),
            hasDiscount: sql<number>`CASE
                WHEN ${rankedSkus.availableForSale} = 1
                    THEN ${rankedSkus.hasAvailableDiscount}
                ELSE ${rankedSkus.hasAnyDiscount}
            END`.as("buyer_has_discount"),
            maxBuyerPriceMinor: sql<number>`CASE
                WHEN ${rankedSkus.availableForSale} = 1
                    THEN ${rankedSkus.maxAvailableEffectivePrice}
                ELSE ${rankedSkus.maxEffectivePrice}
            END`.as("buyer_max_price"),
        })
        .from(rankedSkus)
        .where(eq(rankedSkus.buyerRank, 1))
        .as("buyer_catalog_pricing");
}

export type BuyerCatalogPricingProjection = ReturnType<
    typeof buildBuyerCatalogPricingProjection
>;

/**
 * True when at least one SKU in the same buyer pool used for card pricing is
 * inside the requested effective-price range (minor units). This avoids the
 * common min/max shortcut where a product with only 50 and 150 SKUs
 * incorrectly matches an 80–120 filter.
 */
export function buyerCatalogHasSkuInPriceRange(
    minPriceMinor?: number | SQL<number>,
    maxPriceMinor?: number | SQL<number>,
): SQL {
    const buyerFilterAvailable = sql.raw("(buyer_filter_sku.stock - buyer_filter_sku.reserved_stock)");
    const buyerAvailableSkuAvailable = sql.raw(
        "(buyer_filter_available_sku.stock - buyer_filter_available_sku.reserved_stock)",
    );
    const available = sql`(
        buyer_filter_sku.track_inventory = 0
        OR ${buyerFilterAvailable} > 0
    )`;
    const effectivePrice = effectivePriceMinorSql({
        priceMinor: sql.raw("buyer_filter_sku.price_minor"),
        discountType: sql.raw("buyer_filter_sku.discount_type"),
        discountBps: sql.raw("buyer_filter_sku.discount_bps"),
        discountAmountMinor: sql.raw("buyer_filter_sku.discount_amount_minor"),
    }, {
        discountType: sql`${products.discountType}`,
        discountBps: sql`${products.discountBps}`,
        discountAmountMinor: sql`${products.discountAmountMinor}`,
    });
    const lowerBound = minPriceMinor === undefined ? sql`` : sql`AND ${effectivePrice} >= ${minPriceMinor}`;
    const upperBound = maxPriceMinor === undefined ? sql`` : sql`AND ${effectivePrice} <= ${maxPriceMinor}`;

    return sql`EXISTS (
        SELECT 1
        FROM product_variants AS buyer_filter_sku
        WHERE buyer_filter_sku.product_id = ${products.id}
          AND buyer_filter_sku.deleted_at IS NULL
          AND buyer_filter_sku.id <> 'default'
          AND (
              buyer_filter_sku.is_default = 0
              OR NOT EXISTS (
                  SELECT 1
                  FROM product_variants AS buyer_filter_option_sku
                  WHERE buyer_filter_option_sku.product_id = ${products.id}
                    AND buyer_filter_option_sku.deleted_at IS NULL
                    AND buyer_filter_option_sku.id <> 'default'
                    AND buyer_filter_option_sku.is_default = 0
                    AND trim(coalesce(buyer_filter_option_sku.option_combination_key, '')) <> ''
              )
          )
          AND (
              ${available}
              OR NOT EXISTS (
                  SELECT 1
                  FROM product_variants AS buyer_filter_available_sku
                  WHERE buyer_filter_available_sku.product_id = ${products.id}
                    AND buyer_filter_available_sku.deleted_at IS NULL
                    AND buyer_filter_available_sku.id <> 'default'
                    AND (
                        buyer_filter_available_sku.is_default = 0
                        OR NOT EXISTS (
                            SELECT 1
                            FROM product_variants AS buyer_filter_available_option_sku
                            WHERE buyer_filter_available_option_sku.product_id = ${products.id}
                              AND buyer_filter_available_option_sku.deleted_at IS NULL
                              AND buyer_filter_available_option_sku.id <> 'default'
                              AND buyer_filter_available_option_sku.is_default = 0
                              AND trim(coalesce(buyer_filter_available_option_sku.option_combination_key, '')) <> ''
                        )
                    )
                    AND (
                        buyer_filter_available_sku.track_inventory = 0
                        OR ${buyerAvailableSkuAvailable} > 0
                    )
              )
          )
          ${lowerBound}
          ${upperBound}
    )`;
}
