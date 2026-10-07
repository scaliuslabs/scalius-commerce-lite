// Buyer product cards for curated lists (homepage collections and homepage
// section lists): the select shape over a scoped buyer pricing projection,
// and the card built from a row plus its gallery rows. Listings keep their
// own richer projection (listing.ts).
import { products } from "@scalius/database/schema";
import { sql } from "drizzle-orm";
import {
  type BuyerCatalogPricingProjection,
  type BuyerPricingMinor,
  buyerPricingSelection,
  presentBuyerPricing,
  type ProductCardImages,
  type ProductMediaProjection,
  quickAddEligibleSql,
  resolveProductCardImages,
} from "../products";
import { storeCurrencyCodeSql, storeDecimalPlacesFromCode } from "../settings";
import type { Database } from "@scalius/database/client";
import { isNeutralMarketPricing, priceProductCards, type MarketPriceContext } from "../price-lists";
import { presentCardRating, reviewStats, reviewStatsJoin, type CardRating } from "./shared";
import { EMPTY_PRODUCT_CARD_FACTS, type ProductCardFacts } from "./card-facts";

/** The card columns of a product row joined to a buyer pricing projection. */
export const buildCollectionProductSelect = (buyerPricing: BuyerCatalogPricingProjection) => ({
    id: products.id,
    name: products.name,
    slug: products.slug,
    ...buyerPricingSelection(buyerPricing),
    availableForSale: buyerPricing.availableForSale,
    quickAddEligible: quickAddEligibleSql(buyerPricing).as("collection_quick_add_eligible"),
    freeDelivery: products.freeDelivery,
    categoryId: products.categoryId,
    hasVariants: buyerPricing.hasCustomerOptions,
    storeCurrencyCode: storeCurrencyCodeSql().as("collection_store_currency_code"),
    // The card rating: primary-key probes of the stats projection per card
    // row (no join, so every caller keeps its own statement shape).
    ratingAvgCenti: sql<number | null>`(
        SELECT ${reviewStats.ratingAvgCenti} FROM ${reviewStats} WHERE ${reviewStatsJoin(products.id)}
    )`.as("card_rating_avg_centi"),
    reviewCount: sql<number | null>`(
        SELECT ${reviewStats.reviewCount} FROM ${reviewStats} WHERE ${reviewStatsJoin(products.id)}
    )`.as("card_review_count"),
});

export type RawProduct = BuyerPricingMinor & {
    id: string;
    name: string;
    slug: string;
    availableForSale: number;
    quickAddEligible: number;
    freeDelivery: boolean;
    categoryId: string | null;
    hasVariants: number;
    storeCurrencyCode?: string | null;
    ratingAvgCenti?: number | null;
    reviewCount?: number | null;
};

export type ResolvedProduct = {
    id: string;
    name: string;
    slug: string;
    price: number;
    discountType: string | null;
    discountPercentage: number;
    discountAmount: number;
    discountedPrice: number;
    freeDelivery: boolean;
    categoryId: string | null;
    hasVariants: boolean;
    availableForSale: boolean;
    quickAddEligible: boolean;
    priceVaries: boolean;
    /** Published-review average and count; null without a published review. */
    rating: CardRating;
    /** Brand, key specs, options, sold count, pack size and delivery line (card-facts.ts). */
    cardFacts: ProductCardFacts;
} & ProductCardImages;

function enrichProduct(
    p: RawProduct,
    images: ProductCardImages,
    decimalPlaces: number,
    cardFacts: ProductCardFacts,
): ResolvedProduct {
    const {
        hasVariants,
        availableForSale,
        quickAddEligible,
        storeCurrencyCode: _storeCurrencyCode,
        ratingAvgCenti,
        reviewCount,
        ...product
    } = p;
    return {
        ...presentBuyerPricing(product, decimalPlaces),
        hasVariants: Boolean(hasVariants),
        availableForSale: Boolean(availableForSale),
        quickAddEligible: Boolean(quickAddEligible),
        rating: presentCardRating(ratingAvgCenti, reviewCount),
        ...images,
        cardFacts,
    };
}

/**
 * Buyer cards for product rows, with the card images from their gallery rows
 * and, when the plan read them, their card facts.
 */
export function resolveProductCards(
    rows: readonly RawProduct[],
    mediaByProductId: ReadonlyMap<string, ProductMediaProjection[]>,
    cardFacts: (productId: string) => ProductCardFacts = () => EMPTY_PRODUCT_CARD_FACTS,
): Map<string, ResolvedProduct> {
    const decimalPlaces = storeDecimalPlacesFromCode(rows[0]?.storeCurrencyCode);
    return new Map(rows.map((row) => [
        row.id,
        enrichProduct(row, resolveProductCardImages(mediaByProductId.get(row.id) ?? []), decimalPlaces, cardFacts(row.id)),
    ]));
}

/**
 * The card rows of these batch results priced in the page's market, in
 * place, before the plans resolve them into cards (MARKETS-DESIGN D5): one
 * read of the shown products' SKUs when a list is live, none for FX alone,
 * and nothing at all in a neutral market or at the root.
 */
export async function priceCardRowsInResults(
    db: Database,
    market: MarketPriceContext | null,
    results: unknown[],
    slots: readonly number[],
): Promise<void> {
    if (!market || isNeutralMarketPricing(market) || slots.length === 0) return;
    const unique = new Map<string, RawProduct>();
    for (const slot of slots) for (const row of results[slot] as RawProduct[]) unique.set(row.id, row);
    const priced = new Map((await priceProductCards(db, market, [...unique.values()])).map((row) => [row.id, row]));
    for (const slot of slots) results[slot] = (results[slot] as RawProduct[]).map((row) => priced.get(row.id) ?? row);
}
