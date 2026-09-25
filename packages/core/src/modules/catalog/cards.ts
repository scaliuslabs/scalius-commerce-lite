// Buyer product cards for curated lists (homepage collections and homepage
// section lists): the select shape over a scoped buyer pricing projection,
// and the card built from a row plus its gallery rows. Listings keep their
// own richer projection (listing.ts).
import { products } from "@scalius/database/schema";
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
} & ProductCardImages;

function enrichProduct(
    p: RawProduct,
    images: ProductCardImages,
    decimalPlaces: number,
): ResolvedProduct {
    const { hasVariants, availableForSale, storeCurrencyCode: _storeCurrencyCode, ...product } = p;
    return {
        ...presentBuyerPricing(product, decimalPlaces),
        hasVariants: Boolean(hasVariants),
        availableForSale: Boolean(availableForSale),
        ...images,
    };
}

/** Buyer cards for product rows, with the card images from their gallery rows. */
export function resolveProductCards(
    rows: readonly RawProduct[],
    mediaByProductId: ReadonlyMap<string, ProductMediaProjection[]>,
): Map<string, ResolvedProduct> {
    const decimalPlaces = storeDecimalPlacesFromCode(rows[0]?.storeCurrencyCode);
    return new Map(rows.map((row) => [
        row.id,
        enrichProduct(row, resolveProductCardImages(mediaByProductId.get(row.id) ?? []), decimalPlaces),
    ]));
}
