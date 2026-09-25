// Buyer product cards for curated lists (homepage collections and homepage
// section lists): the select shape over a scoped buyer pricing projection,
// and the card built from a row plus its gallery rows. Listings keep their
// own richer projection (listing.ts).
import { products } from "@scalius/database/schema";
import { sql } from "drizzle-orm";
import type { BuyerCatalogPricingProjection } from "../products/buyer-projection";
import {
    buyerPricingSelection,
    presentBuyerPricing,
    storeCurrencyCodeSql,
    storeDecimalPlacesFromCode,
    type BuyerPricingMinor,
} from "../products/money";
import {
    resolveProductCardImages,
    type ProductCardImages,
    type ProductMediaProjection,
} from "../products/media";
import { presentCardRating, reviewStats, type CardRating } from "./shared";
import { EMPTY_PRODUCT_CARD_FACTS, type ProductCardFacts } from "./card-facts";

/** The card columns of a product row joined to a buyer pricing projection. */
export const buildCollectionProductSelect = (buyerPricing: BuyerCatalogPricingProjection) => ({
    id: products.id,
    name: products.name,
    slug: products.slug,
    ...buyerPricingSelection(buyerPricing),
    availableForSale: buyerPricing.availableForSale,
    freeDelivery: products.freeDelivery,
    categoryId: products.categoryId,
    hasVariants: buyerPricing.hasCustomerOptions,
    storeCurrencyCode: storeCurrencyCodeSql().as("collection_store_currency_code"),
    // The card rating: primary-key probes of the stats projection per card
    // row (no join, so every caller keeps its own statement shape).
    ratingAvgCenti: sql<number | null>`(
        SELECT ${reviewStats.ratingAvgCenti} FROM ${reviewStats} WHERE ${reviewStats.productId} = ${products.id}
    )`.as("card_rating_avg_centi"),
    reviewCount: sql<number | null>`(
        SELECT ${reviewStats.reviewCount} FROM ${reviewStats} WHERE ${reviewStats.productId} = ${products.id}
    )`.as("card_review_count"),
});

export type RawProduct = BuyerPricingMinor & {
    id: string;
    name: string;
    slug: string;
    availableForSale: number;
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
        storeCurrencyCode: _storeCurrencyCode,
        ratingAvgCenti,
        reviewCount,
        ...product
    } = p;
    return {
        ...presentBuyerPricing(product, decimalPlaces),
        hasVariants: Boolean(hasVariants),
        availableForSale: Boolean(availableForSale),
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
