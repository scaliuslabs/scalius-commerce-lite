import { products, productVariants } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, eq, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { fromMinor } from "@scalius/shared/money";
import { effectivePriceMinorSql } from "./money";
import { channelAvailableStockSql, skuStockRefs } from "./channel-publications";

type DiscountColumns = { discountType: SQL; discountBps: SQL; discountAmountMinor: SQL };

/** A card can add one unit without asking the buyer to choose an SKU or fill any input. */
export function quickAddEligibleSql(buyer: {
    availableForSale: SQLWrapper;
    hasCustomerOptions: SQLWrapper;
    effectivePriceMinor: SQLWrapper;
}): SQL<number> {
    return sql<number>`CASE WHEN ${buyer.availableForSale} = 1
        AND ${buyer.hasCustomerOptions} = 0
        AND ${buyer.effectivePriceMinor} > 0
        AND ${products.isGiftCard} = 0
        AND (CASE
            WHEN ${products.customizationSchema} IS NULL THEN 1
            WHEN json_valid(${products.customizationSchema}) THEN
                CASE WHEN json_type(${products.customizationSchema}) = 'object'
                    AND json_type(${products.customizationSchema}, '$.fields') = 'array'
                    AND json_array_length(${products.customizationSchema}, '$.fields') = 0
                THEN 1 ELSE 0 END
            ELSE 0
        END) = 1
    THEN 1 ELSE 0 END`;
}

/**
 * The discount a buyer card shows for one SKU: a valid SKU discount overrides
 * the product discount (checkout and the product page resolve it the same
 * way). Shared by the pricing projection and the stored buyer state's card
 * SKU, so the rule has one copy.
 */
export function resolvedBuyerDiscountSql(sku: DiscountColumns, product: DiscountColumns) {
    const skuHasDiscount = sql<number>`CASE
        WHEN ${sku.discountType} = 'flat' AND ${sku.discountAmountMinor} > 0 THEN 1
        WHEN ${sku.discountType} = 'percentage' AND ${sku.discountBps} > 0 THEN 1
        ELSE 0
    END`;
    return {
        discountType: sql<string | null>`CASE
            WHEN ${skuHasDiscount} = 1 THEN ${sku.discountType}
            ELSE ${product.discountType}
        END`,
        discountBps: sql<number>`CASE
            WHEN ${skuHasDiscount} = 1 THEN ${sku.discountBps}
            ELSE ${product.discountBps}
        END`,
        discountAmountMinor: sql<number>`CASE
            WHEN ${skuHasDiscount} = 1 THEN ${sku.discountAmountMinor}
            ELSE ${product.discountAmountMinor}
        END`,
    };
}

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
 *
 * `productScope` is a condition on `products` rows that every row the caller
 * keeps already satisfies: a category, a collection's members, search hits,
 * a list of ids. SQLite cannot push the caller's join into a windowed
 * subquery, so an unscoped projection ranks every live SKU in the store for
 * each statement that joins it (about 80k SKUs, 0.3-1.3 s of D1 time per
 * statement at 30k products), even to show eight cards of one category. The
 * scope must never be narrower than the caller's own conditions, or rows
 * would lose their pricing.
 */
export function buildBuyerCatalogPricingProjection(
    db: Database,
    options: {
        productScope?: SQL;
        /** The channel whose sellable stock decides availability (default: the online store). */
        channelId?: string;
    } = {},
) {
    const pricingProduct = alias(products, "buyer_pricing_product");
    const pricingSku = alias(productVariants, "buyer_pricing_sku");
    const availableStock = channelAvailableStockSql(skuStockRefs("buyer_pricing_sku"), options.channelId);

    const skuAvailable = sql<number>`CASE
        WHEN ${pricingSku.trackInventory} = 0
          OR ${availableStock} > 0
        THEN 1 ELSE 0
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
    const {
        discountType: resolvedDiscountType,
        discountBps: resolvedDiscountBps,
        discountAmountMinor: resolvedDiscountAmountMinor,
    } = resolvedBuyerDiscountSql({
        discountType: sql`${pricingSku.discountType}`,
        discountBps: sql`${pricingSku.discountBps}`,
        discountAmountMinor: sql`${pricingSku.discountAmountMinor}`,
    }, {
        discountType: sql`${pricingProduct.discountType}`,
        discountBps: sql`${pricingProduct.discountBps}`,
        discountAmountMinor: sql`${pricingProduct.discountAmountMinor}`,
    });

    // Each SKU's own facts first, as plain columns: the window aggregates
    // below then read columns, never a subquery (the stock and price
    // increment expressions hold scalar subqueries, which the Turso engine
    // does not prepare inside a window function's argument).
    const skuFacts = db
        .select({
            productId: pricingSku.productId,
            skuId: pricingSku.id,
            basePriceMinor: pricingSku.priceMinor,
            effectivePriceMinor: effectivePrice.as("buyer_sku_effective_price"),
            available: skuAvailable.as("buyer_sku_available"),
            customerOption: sql<number>`CASE
                WHEN ${pricingSku.isDefault} = 0
                  AND trim(coalesce(${pricingSku.optionCombinationKey}, '')) <> ''
                THEN 1 ELSE 0
            END`.as("buyer_sku_customer_option"),
            discountType: resolvedDiscountType.as("buyer_sku_discount_type"),
            discountBps: resolvedDiscountBps.as("buyer_sku_discount_bps"),
            discountAmountMinor: resolvedDiscountAmountMinor.as("buyer_sku_discount_amount"),
        })
        .from(pricingSku)
        .innerJoin(pricingProduct, eq(pricingProduct.id, pricingSku.productId))
        .where(and(
            options.productScope
                ? sql`${pricingSku.productId} IN (SELECT ${products.id} FROM ${products} WHERE ${options.productScope})`
                : undefined,
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
        .as("buyer_sku_facts");

    const facts = {
        productId: sql`${skuFacts.productId}`,
        skuId: sql`${skuFacts.skuId}`,
        basePriceMinor: sql`${skuFacts.basePriceMinor}`,
        effectivePrice: sql`${skuFacts.effectivePriceMinor}`,
        available: sql`${skuFacts.available}`,
    };
    const rankedSkus = db
        .select({
            productId: skuFacts.productId,
            skuId: skuFacts.skuId,
            basePriceMinor: skuFacts.basePriceMinor,
            effectivePriceMinor: sql<number>`${facts.effectivePrice}`.as("buyer_effective_price"),
            discountType: sql<string | null>`${skuFacts.discountType}`.as("buyer_discount_type"),
            discountBps: sql<number>`${skuFacts.discountBps}`.as("buyer_discount_bps"),
            discountAmountMinor: sql<number>`${skuFacts.discountAmountMinor}`.as("buyer_discount_amount"),
            availableForSale: sql<number>`MAX(${facts.available}) OVER (
                PARTITION BY ${facts.productId}
            )`.as("buyer_available_for_sale"),
            hasCustomerOptions: sql<number>`MAX(${skuFacts.customerOption}) OVER (PARTITION BY ${facts.productId})`.as("buyer_has_customer_options"),
            hasAnyDiscount: sql<number>`MAX(CASE
                WHEN ${facts.effectivePrice} < ${facts.basePriceMinor} THEN 1 ELSE 0
            END) OVER (PARTITION BY ${facts.productId})`.as("buyer_has_any_discount"),
            hasAvailableDiscount: sql<number>`MAX(CASE
                WHEN ${facts.available} = 1 AND ${facts.effectivePrice} < ${facts.basePriceMinor} THEN 1 ELSE 0
            END) OVER (PARTITION BY ${facts.productId})`.as("buyer_has_available_discount"),
            maxAvailableEffectivePrice: sql<number | null>`MAX(CASE
                WHEN ${facts.available} = 1 THEN ${facts.effectivePrice} ELSE NULL
            END) OVER (PARTITION BY ${facts.productId})`.as("buyer_max_available_effective_price"),
            maxEffectivePrice: sql<number>`MAX(${facts.effectivePrice}) OVER (
                PARTITION BY ${facts.productId}
            )`.as("buyer_max_effective_price"),
            buyerRank: sql<number>`ROW_NUMBER() OVER (
                PARTITION BY ${facts.productId}
                ORDER BY ${facts.available} DESC, ${facts.effectivePrice} ASC, ${facts.skuId} ASC
            )`.as("buyer_rank"),
        })
        .from(skuFacts)
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
 * What buyers pay for a product, in decimal major units: the storefront's
 * "From" price, the highest price in the same buyer pool, and the
 * undiscounted price of the "From" SKU when it is on sale. Dashboard lists
 * and pickers show this instead of the product-level price, which a product
 * with options does not sell at.
 */
export type BuyerPriceRange = { from: number; to: number; compareAt: number | null };

/** Columns to select from a joined pricing projection for {@link presentBuyerPriceRange}. */
export function buyerPriceRangeColumns(pricing: BuyerCatalogPricingProjection) {
    return {
        buyerFromMinor: pricing.effectivePriceMinor,
        buyerToMinor: pricing.maxBuyerPriceMinor,
        // Named apart from products.price_minor, which callers select too.
        buyerBaseMinor: sql<number | null>`${pricing.basePriceMinor}`.as("buyer_base_price"),
    };
}

/** Null when the product has no live SKU (the projection has no row). */
export function presentBuyerPriceRange(
    row: { buyerFromMinor: number | null; buyerToMinor: number | null; buyerBaseMinor: number | null },
    decimalPlaces: number,
): BuyerPriceRange | null {
    if (row.buyerFromMinor == null) return null;
    const fromMinorValue = Number(row.buyerFromMinor);
    const toMinorValue = Math.max(fromMinorValue, Number(row.buyerToMinor ?? fromMinorValue));
    const baseMinor = Number(row.buyerBaseMinor ?? fromMinorValue);
    return {
        from: fromMinor(fromMinorValue, decimalPlaces),
        to: fromMinor(toMinorValue, decimalPlaces),
        compareAt: baseMinor > fromMinorValue ? fromMinor(baseMinor, decimalPlaces) : null,
    };
}

/**
 * A price filter in a market whose public lists are live: its bounds in the
 * market's currency, and what decides a SKU's price there. A SKU with a live
 * list price (in the market's currency, at quantity 1) costs the winning one
 * (`resolvePrice`: sale before market list, then the higher priority, the
 * lower amount, the smaller list id), rounded half-up to the increment; any
 * other SKU its FX-derived price, which the base bounds already express.
 */
export interface MarketListPriceFilter {
    marketId: string;
    currencyCode: string;
    atSeconds: number;
    incrementMinor: number;
    minMarketMinor?: number;
    maxMarketMinor?: number;
}

/** The winning live public list amount of a SKU (a column reference) in a market, rounded to its increment; NULL without one. */
export function marketListSkuPriceSql(variantId: SQL, market: MarketListPriceFilter): SQL<number | null> {
    const increment = Math.max(1, Math.trunc(market.incrementMinor));
    const winner = sql`(SELECT winner_price.amount_minor FROM price_list_prices AS winner_price
        INNER JOIN price_lists AS winner_list ON winner_list.id = winner_price.price_list_id
        WHERE winner_price.variant_id = ${variantId} AND winner_price.currency_code = ${market.currencyCode}
          AND winner_price.min_quantity = 1 AND winner_list.market_id = ${market.marketId}
          AND winner_list.status = 'active' AND winner_list.kind <> 'segment'
          AND (winner_list.starts_at IS NULL OR winner_list.starts_at <= ${market.atSeconds})
          AND (winner_list.ends_at IS NULL OR winner_list.ends_at > ${market.atSeconds})
        ORDER BY CASE winner_list.kind WHEN 'sale' THEN 0 ELSE 1 END, winner_list.priority DESC,
            winner_price.amount_minor, winner_list.id
        LIMIT 1)`;
    if (increment <= 1) return sql<number | null>`${winner}`;
    const step = sql.raw(String(increment));
    return sql<number | null>`MAX(${step}, ((2 * ${winner} + ${step}) / (2 * ${step})) * ${step})`;
}

/**
 * True when at least one SKU in the same buyer pool used for card pricing is
 * inside the requested effective-price range (minor units). This avoids the
 * common min/max shortcut where a product with only 50 and 150 SKUs
 * incorrectly matches an 80–120 filter. In a market with live lists
 * (`market`), a SKU with a list price is tested by it, in the market's
 * currency; the others by the base bounds.
 */
export function buyerCatalogHasSkuInPriceRange(
    minPriceMinor?: number | SQL<number>,
    maxPriceMinor?: number | SQL<number>,
    market?: MarketListPriceFilter,
): SQL {
    const buyerFilterAvailable = channelAvailableStockSql(skuStockRefs("buyer_filter_sku"));
    const buyerAvailableSkuAvailable = channelAvailableStockSql(skuStockRefs("buyer_filter_available_sku"));
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
    const baseInRange = and(
        minPriceMinor === undefined ? undefined : sql`${effectivePrice} >= ${minPriceMinor}`,
        maxPriceMinor === undefined ? undefined : sql`${effectivePrice} <= ${maxPriceMinor}`,
    );
    const listPrice = market ? marketListSkuPriceSql(sql.raw("buyer_filter_sku.id"), market) : null;
    const listInRange = market ? and(
        market.minMarketMinor === undefined ? undefined : sql`${listPrice} >= ${market.minMarketMinor}`,
        market.maxMarketMinor === undefined ? undefined : sql`${listPrice} <= ${market.maxMarketMinor}`,
    ) : undefined;
    const inRange = listPrice
        ? sql`AND (CASE WHEN ${listPrice} IS NULL THEN ${baseInRange ?? sql`1 = 1`} ELSE ${listInRange ?? sql`1 = 1`} END)`
        : baseInRange ? sql`AND ${baseInRange}` : sql``;

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
          ${inRange}
    )`;
}
