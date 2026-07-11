import { products, productVariants } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

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

    const skuAvailable = sql<number>`CASE
        WHEN ${pricingSku.trackInventory} = 0
          OR (${pricingSku.stock} - ${pricingSku.reservedStock}) > 0
        THEN 1 ELSE 0
    END`;
    const skuHasDiscount = sql<number>`CASE
        WHEN ${pricingSku.discountType} = 'flat' AND ${pricingSku.discountAmount} > 0 THEN 1
        WHEN ${pricingSku.discountType} = 'percentage' AND ${pricingSku.discountPercentage} > 0 THEN 1
        ELSE 0
    END`;
    const effectivePrice = sql<number>`CASE
        WHEN ${pricingSku.discountType} = 'flat' AND ${pricingSku.discountAmount} > 0
            THEN MAX(${pricingSku.price} - ${pricingSku.discountAmount}, 0)
        WHEN ${pricingSku.discountType} = 'percentage' AND ${pricingSku.discountPercentage} > 0
            THEN ${pricingSku.price} * (1 - ${pricingSku.discountPercentage} / 100.0)
        WHEN ${pricingProduct.discountType} = 'flat' AND ${pricingProduct.discountAmount} > 0
            THEN MAX(${pricingSku.price} - ${pricingProduct.discountAmount}, 0)
        WHEN ${pricingProduct.discountType} = 'percentage' AND ${pricingProduct.discountPercentage} > 0
            THEN ${pricingSku.price} * (1 - ${pricingProduct.discountPercentage} / 100.0)
        ELSE ${pricingSku.price}
    END`;
    const resolvedDiscountType = sql<string | null>`CASE
        WHEN ${skuHasDiscount} = 1 THEN ${pricingSku.discountType}
        ELSE ${pricingProduct.discountType}
    END`;
    const resolvedDiscountPercentage = sql<number | null>`CASE
        WHEN ${skuHasDiscount} = 1 THEN ${pricingSku.discountPercentage}
        ELSE ${pricingProduct.discountPercentage}
    END`;
    const resolvedDiscountAmount = sql<number | null>`CASE
        WHEN ${skuHasDiscount} = 1 THEN ${pricingSku.discountAmount}
        ELSE ${pricingProduct.discountAmount}
    END`;

    const rankedSkus = db
        .select({
            productId: pricingSku.productId,
            skuId: pricingSku.id,
            basePrice: pricingSku.price,
            effectivePrice: effectivePrice.as("buyer_effective_price"),
            discountType: resolvedDiscountType.as("buyer_discount_type"),
            discountPercentage: resolvedDiscountPercentage.as("buyer_discount_percentage"),
            discountAmount: resolvedDiscountAmount.as("buyer_discount_amount"),
            availableForSale: sql<number>`MAX(${skuAvailable}) OVER (
                PARTITION BY ${pricingSku.productId}
            )`.as("buyer_available_for_sale"),
            hasCustomerOptions: sql<number>`MAX(CASE
                WHEN trim(coalesce(${pricingSku.size}, '')) <> ''
                  OR trim(coalesce(${pricingSku.color}, '')) <> ''
                THEN 1 ELSE 0
            END) OVER (PARTITION BY ${pricingSku.productId})`.as("buyer_has_customer_options"),
            hasAnyDiscount: sql<number>`MAX(CASE
                WHEN ${effectivePrice} < ${pricingSku.price} THEN 1 ELSE 0
            END) OVER (PARTITION BY ${pricingSku.productId})`.as("buyer_has_any_discount"),
            hasAvailableDiscount: sql<number>`MAX(CASE
                WHEN ${skuAvailable} = 1 AND ${effectivePrice} < ${pricingSku.price} THEN 1 ELSE 0
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
                      AND (
                          trim(coalesce(buyer_option_sku.size, '')) <> ''
                          OR trim(coalesce(buyer_option_sku.color, '')) <> ''
                      )
                )
            )`,
        ))
        .as("buyer_ranked_skus");

    return db
        .select({
            productId: rankedSkus.productId,
            skuId: rankedSkus.skuId,
            basePrice: rankedSkus.basePrice,
            effectivePrice: sql<number>`${rankedSkus.effectivePrice}`.as("buyer_effective_price"),
            discountType: sql<string | null>`${rankedSkus.discountType}`.as("buyer_discount_type"),
            discountPercentage: sql<number | null>`${rankedSkus.discountPercentage}`.as("buyer_discount_percentage"),
            discountAmount: sql<number | null>`${rankedSkus.discountAmount}`.as("buyer_discount_amount"),
            availableForSale: sql<number>`${rankedSkus.availableForSale}`.as("buyer_available_for_sale"),
            hasCustomerOptions: sql<number>`${rankedSkus.hasCustomerOptions}`.as("buyer_has_customer_options"),
            hasDiscount: sql<number>`CASE
                WHEN ${rankedSkus.availableForSale} = 1
                    THEN ${rankedSkus.hasAvailableDiscount}
                ELSE ${rankedSkus.hasAnyDiscount}
            END`.as("buyer_has_discount"),
            maxBuyerPrice: sql<number>`CASE
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
 * inside the requested effective-price range. This avoids the common min/max
 * shortcut where a product with only 50 and 150 SKUs incorrectly matches an
 * 80–120 filter.
 */
export function buyerCatalogHasSkuInPriceRange(
    minPrice?: number,
    maxPrice?: number,
): SQL {
    const available = sql`(
        buyer_filter_sku.track_inventory = 0
        OR (buyer_filter_sku.stock - buyer_filter_sku.reserved_stock) > 0
    )`;
    const effectivePrice = sql`CASE
        WHEN buyer_filter_sku.discount_type = 'flat' AND buyer_filter_sku.discount_amount > 0
            THEN MAX(buyer_filter_sku.price - buyer_filter_sku.discount_amount, 0)
        WHEN buyer_filter_sku.discount_type = 'percentage' AND buyer_filter_sku.discount_percentage > 0
            THEN buyer_filter_sku.price * (1 - buyer_filter_sku.discount_percentage / 100.0)
        WHEN ${products.discountType} = 'flat' AND ${products.discountAmount} > 0
            THEN MAX(buyer_filter_sku.price - ${products.discountAmount}, 0)
        WHEN ${products.discountType} = 'percentage' AND ${products.discountPercentage} > 0
            THEN buyer_filter_sku.price * (1 - ${products.discountPercentage} / 100.0)
        ELSE buyer_filter_sku.price
    END`;
    const lowerBound = minPrice === undefined ? sql`` : sql`AND ${effectivePrice} >= ${minPrice}`;
    const upperBound = maxPrice === undefined ? sql`` : sql`AND ${effectivePrice} <= ${maxPrice}`;

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
                    AND (
                        trim(coalesce(buyer_filter_option_sku.size, '')) <> ''
                        OR trim(coalesce(buyer_filter_option_sku.color, '')) <> ''
                    )
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
                              AND (
                                  trim(coalesce(buyer_filter_available_option_sku.size, '')) <> ''
                                  OR trim(coalesce(buyer_filter_available_option_sku.color, '')) <> ''
                              )
                        )
                    )
                    AND (
                        buyer_filter_available_sku.track_inventory = 0
                        OR (buyer_filter_available_sku.stock - buyer_filter_available_sku.reserved_stock) > 0
                    )
              )
          )
          ${lowerBound}
          ${upperBound}
    )`;
}
