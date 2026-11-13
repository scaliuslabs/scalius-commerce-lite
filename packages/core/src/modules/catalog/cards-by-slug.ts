// Product cards named by handle (`GET /products/by-slugs?slugs=`): the
// listing's own card for each product a CMS page, an article or rich text
// names with a `[product slug="..."]` (or `id="..."`) shortcode, up to 50 per
// read. One statement resolves every handle the way the product page resolves
// one (its source slug, else a localized handle, the page's language first;
// last a product id, which the product page does not take) and keeps
// only public products (the stored buyer state: active, not trashed,
// published to the online store, with a SKU a buyer can buy); the card media,
// facts and the market's prices follow in one batch, as a listing page's do.
// The handles travel as one JSON value (`json_each`), so the read binds a
// handful of parameters whatever their number (D1 allows 100).
import { products } from "@scalius/database/schema";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { presentBuyerPricing, quickAddEligibleSql, resolveProductCardImages } from "../products";
import { marketDecimalPlaces, marketPriceContextOf, marketShopAmounts, priceProductCards, type MarketPricing } from "../price-lists";
import { storeCurrencyCodeSql, storeDecimalPlacesFromCode } from "../settings";
import { PRODUCT_CARD_FIELDS, translateRows, translationColumns, translationScopeOf } from "../translations";
import { loadCatalogCardData, type ProductCardFacts } from "./card-facts";
import { presentCardRating, reviewStats, reviewStatsJoin, type CardRating } from "./shared";
import {
    buyerState,
    buyerStateCardSku,
    buyerStateCardSkuJoin,
    buyerStatePricingSelection,
    publicBuyerStateCondition,
} from "./buyer-state";
import { declareProductCards, deps } from "./declare-deps";
import type { ProductCondition } from "@scalius/shared/product-condition";
import type { ProductCardImages } from "../products";

/** Products one read names: the shortcode bound of one document. */
export const MAX_PRODUCT_CARDS_BY_SLUG = 50;

/** A handle a URL can carry: printable ASCII without a comma (the list separator). */
const HANDLE = /^[\x21-\x2b\x2d-\x7e]{1,200}$/;

/** Unique handles in the order given, empty and malformed ones dropped. */
export function normalizeProductCardSlugs(raw: string | readonly string[]): string[] {
    const tokens = (typeof raw === "string" ? raw.split(",") : raw).map((slug) => slug.trim()).filter((slug) => HANDLE.test(slug));
    return [...new Set(tokens)];
}

export interface StorefrontProductCardBySlug extends ProductCardImages {
    /** The handle the request named (a localized handle stays as asked). */
    reference: string;
    id: string;
    name: string;
    slug: string;
    productCondition: ProductCondition | null;
    price: number;
    discountedPrice: number;
    discountType: string | null;
    discountPercentage: number;
    discountAmount: number;
    priceVaries: boolean;
    freeDelivery: boolean;
    categoryId: string | null;
    hasVariants: boolean;
    availableForSale: boolean;
    quickAddEligible: boolean;
    rating: CardRating;
    cardFacts: ProductCardFacts;
}

/**
 * The cards of the public products these handles name, in the order asked;
 * a handle naming no public product is left out. Throws for more than
 * MAX_PRODUCT_CARDS_BY_SLUG handles (the route answers 400).
 */
export async function getStorefrontProductCardsBySlugs(
    db: Database,
    requested: readonly string[],
    pricing: MarketPricing | null = null,
): Promise<{ products: StorefrontProductCardBySlug[] }> {
    const handles = normalizeProductCardSlugs(requested);
    if (handles.length > MAX_PRODUCT_CARDS_BY_SLUG) throw new RangeError(`At most ${MAX_PRODUCT_CARDS_BY_SLUG} handles`);
    if (handles.length === 0) return { products: [] };
    const translation = translationScopeOf(pricing);
    const cardSku = buyerStateCardSku();
    const preferred = translation?.locale ?? "";
    // The product each handle names, as the product page finds one: its source slug, else a
    // localized handle (the page's language first); last, a product id (`[product id="..."]`). A
    // source slug wins even when its product is not public, as on the product page.
    const named = sql`(
        SELECT CAST(asked.value AS TEXT) AS handle, CAST(asked.key AS INTEGER) AS position, coalesce(
            (SELECT source_product.id FROM ${products} AS source_product WHERE source_product.slug = CAST(asked.value AS TEXT)),
            (SELECT handle.resource_id FROM localized_slugs AS handle
                WHERE handle.resource_type = 'product' AND handle.slug = CAST(asked.value AS TEXT)
                ORDER BY handle.locale = ${preferred} DESC, handle.locale LIMIT 1),
            (SELECT by_id.id FROM ${products} AS by_id WHERE by_id.id = CAST(asked.value AS TEXT))
        ) AS product_id
        FROM json_each(${JSON.stringify(handles)}) AS asked
    ) AS named`;
    const rows = await db
        .select({
            reference: sql<string>`named.handle`,
            id: products.id,
            name: products.name,
            productCondition: products.productCondition,
            ...translationColumns(translation, "product", products.id, { fields: PRODUCT_CARD_FIELDS }),
            ...buyerStatePricingSelection(cardSku),
            slug: products.slug,
            sourceSlug: sql<string>`${products.slug}`.as("source_slug"),
            freeDelivery: products.freeDelivery,
            categoryId: products.categoryId,
            hasCustomerOptions: buyerState.hasCustomerOptions,
            availableForSale: buyerState.availableForSale,
            quickAddEligible: quickAddEligibleSql({
                availableForSale: buyerState.availableForSale,
                hasCustomerOptions: buyerState.hasCustomerOptions,
                effectivePriceMinor: buyerState.fromMinor,
            }).as("by_slug_quick_add_eligible"),
            ratingAvgCenti: reviewStats.ratingAvgCenti,
            reviewCount: reviewStats.reviewCount,
            storeCurrencyCode: storeCurrencyCodeSql(),
        })
        .from(named)
        .innerJoin(buyerState, sql`${buyerState.productId} = named.product_id`)
        .innerJoin(products, eq(products.id, buyerState.productId))
        .leftJoin(cardSku, buyerStateCardSkuJoin(cardSku))
        .leftJoin(reviewStats, reviewStatsJoin(buyerState.productId))
        .where(and(publicBuyerStateCondition({ drivenByIdSet: true })))
        .orderBy(sql`named.position`)
        .all();

    const market = await marketPriceContextOf(pricing);
    const decimalPlaces = marketDecimalPlaces(market, storeDecimalPlacesFromCode(rows[0]?.storeCurrencyCode));
    const [priced, cardData] = await Promise.all([
        priceProductCards(db, market, rows),
        loadCatalogCardData(db, rows, decimalPlaces, marketShopAmounts(market, "fee")),
    ]);

    // Each card (its product, SKUs, stock band, prices and images), its handles, and for a handle
    // that named no public product, whatever can make it name one: a product taking that slug or
    // becoming public, or a localized handle.
    const ids = rows.map((row) => row.id);
    declareProductCards(ids, cardData.media);
    for (const id of ids) deps.resourceHandles(translation !== null, "product", id);
    const found = new Set(rows.map((row) => row.reference));
    if (handles.some((handle) => !found.has(handle)) || rows.some((row) => row.sourceSlug !== row.reference)) {
        deps.listMembership("all");
        deps.table("products");
        deps.localizedSlugSpace("product");
    }

    const cards = translateRows(translation, "product", priced, PRODUCT_CARD_FIELDS).map(({
        hasCustomerOptions,
        availableForSale,
        quickAddEligible,
        ratingAvgCenti,
        reviewCount,
        storeCurrencyCode: _currency,
        sourceSlug: _sourceSlug,
        ...product
    }): StorefrontProductCardBySlug => ({
        ...presentBuyerPricing(product, decimalPlaces),
        hasVariants: Boolean(hasCustomerOptions),
        availableForSale: Boolean(availableForSale),
        quickAddEligible: Boolean(quickAddEligible),
        ...resolveProductCardImages(cardData.media.get(product.id) ?? []),
        rating: presentCardRating(ratingAvgCenti, reviewCount),
        cardFacts: cardData.facts(product.id),
    }));
    return { products: cards };
}
