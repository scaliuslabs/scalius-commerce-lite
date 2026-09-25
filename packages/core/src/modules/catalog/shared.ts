// Helpers shared by the catalogue reads. Not exported from the domain entry.
import { products, categories, productReviewStats } from "@scalius/database/schema";
import { and, sql, eq, or, type AnyColumn, type SQL } from "drizzle-orm";
import { ftsMatch } from "../../search/fts5";
import { productCategoryNameMatch } from "../../search/relevance";
import type { StorefrontProductFilterInput } from "../products/types";
import type { Database } from "@scalius/database/client";
import { publicProductBaseConditions } from "../products/public-eligibility";
import { reviewsEnabledSql } from "../settings/documents";
import {
    buyerCatalogHasSkuInPriceRange,
    type BuyerCatalogPricingProjection,
} from "../products/buyer-projection";
import { storeDecimalToMinorSql } from "../products/money";
import { publicCategoryConditions } from "../categories/categories.publication";
import { resolveProductImageRepresentation, type ProductMediaProjection } from "../products/media";
import { buyerState, publicBuyerStateCondition } from "./buyer-state";

type StorefrontProductConditionOptions = {
    includeLookupHandles?: boolean;
    includeVariantLookups?: boolean;
};

const MAX_PUBLIC_LOOKUP_TOKENS = 100;
// Leave room for non-IN predicates under D1's 100 bound-parameter limit.
export const STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE = 90;

function parsePublicLookupTokens(ids: string | undefined): string[] {
    if (!ids) return [];
    return Array.from(new Set(ids.split(",").map((id) => id.trim()).filter(Boolean))).slice(
        0,
        MAX_PUBLIC_LOOKUP_TOKENS,
    );
}

/**
 * Membership sets are written as `column IN (subquery)` rather than a
 * correlated EXISTS, so SQLite can drive the read from the matching index
 * (products_category_id_idx, the primary key) instead of testing every
 * public product in the store.
 */
export function publishedCategoryIdSet(where: SQL): SQL {
    return sql`(
        SELECT ${categories.id}
        FROM ${categories}
        WHERE ${where}
          AND ${and(...publicCategoryConditions())}
    )`;
}

function buildCategoryLookupCondition(category: string, column: SQL | AnyColumn = products.categoryId): SQL {
    return sql`${column} IN ${publishedCategoryIdSet(
        sql`(${categories.id} = ${category} OR ${categories.slug} = ${category})`,
    )}`;
}

function buildProductLookupCondition(
    lookupTokens: string[],
    options: StorefrontProductConditionOptions = {},
    column: SQL | AnyColumn = products.id,
): SQL {
    const lookupBranches: SQL[] = [sql`SELECT value FROM public_lookup`];

    if (options.includeLookupHandles) {
        lookupBranches.push(sql`
            SELECT lookup_product.id
            FROM "products" AS lookup_product
            INNER JOIN public_lookup
                ON lookup_product.slug = public_lookup.value
        `);
    }

    if (options.includeVariantLookups) {
        // SKUs match on their identity key, lower(trim(sku)), the only SKU
        // index (product_variants_sku_identity_uidx); a raw `sku = ?` read
        // every SKU in the store per lookup.
        lookupBranches.push(sql`
            SELECT lookup_variant.product_id
            FROM "product_variants" AS lookup_variant
            INNER JOIN public_lookup
                ON lookup_variant.id = public_lookup.value
            WHERE lookup_variant.deleted_at IS NULL
        `, sql`
            SELECT lookup_sku.product_id
            FROM "product_variants" AS lookup_sku
            INNER JOIN public_lookup
                ON lower(trim(lookup_sku.sku)) = lower(trim(public_lookup.value))
            WHERE lookup_sku.deleted_at IS NULL
        `);
    }

    return sql`${column} IN (
        WITH public_lookup(value) AS (
            SELECT CAST(value AS TEXT)
            FROM json_each(${JSON.stringify(lookupTokens)})
        )
        ${sql.join(lookupBranches, sql` UNION `)}
    )`;
}

/** Decimal HTTP price-filter bounds in store minor units. */
/** Decimal price filters as store minor units, resolved in SQL (no separate currency read). */
export function priceFilterBoundsMinor(params: Pick<StorefrontProductFilterInput, "minPrice" | "maxPrice">) {
    const bound = (value: number | undefined) =>
        value === undefined || !Number.isFinite(value) ? undefined : storeDecimalToMinorSql(Math.max(0, value));
    return { minPriceMinor: bound(params.minPrice), maxPriceMinor: bound(params.maxPrice) };
}

export function buildStorefrontProductConditions(
    db: Database,
    params: Omit<StorefrontProductFilterInput, "minPrice" | "maxPrice"> & {
        minPriceMinor?: SQL<number>;
        maxPriceMinor?: SQL<number>;
    },
    options: StorefrontProductConditionOptions = {},
    buyerPricing?: BuyerCatalogPricingProjection,
): SQL[] {
    const {
        category,
        search,
        minPriceMinor,
        maxPriceMinor,
        freeDelivery,
        hasDiscount,
        ids,
    } = params;

    const conditions: (SQL | undefined)[] = [
        ...publicProductBaseConditions(),
        ...storefrontProductSetConditions(db, { category, search, ids }, options),
    ];

    if (buyerPricing && (minPriceMinor !== undefined || maxPriceMinor !== undefined)) {
        conditions.push(buyerCatalogHasSkuInPriceRange(minPriceMinor, maxPriceMinor));
    } else {
        if (minPriceMinor !== undefined) conditions.push(sql`${products.priceMinor} >= ${minPriceMinor}`);
        if (maxPriceMinor !== undefined) conditions.push(sql`${products.priceMinor} <= ${maxPriceMinor}`);
    }
    if (freeDelivery === "true") conditions.push(eq(products.freeDelivery, true));
    else if (freeDelivery === "false") conditions.push(eq(products.freeDelivery, false));
    if (hasDiscount === "true") {
        conditions.push(buyerPricing
            ? eq(buyerPricing.hasDiscount, 1)
            : sql`(${products.discountBps} > 0 OR ${products.discountAmountMinor} > 0)`);
    } else if (hasDiscount === "false") {
        conditions.push(buyerPricing
            ? eq(buyerPricing.hasDiscount, 0)
            : sql`${products.discountBps} = 0 AND ${products.discountAmountMinor} = 0`);
    }

    return conditions.filter((condition): condition is SQL => Boolean(condition));
}

/**
 * Listing conditions over the stored buyer state (`product_buyer_state`
 * joined to `products`): the public set, the request's category, search,
 * id, price, free-delivery, discount and in-stock filters. `needsProducts` is false
 * when every condition reads the buyer state alone, so a count can skip
 * the `products` join.
 */
export function buildStorefrontBuyerStateConditions(
    db: Database,
    params: Omit<StorefrontProductFilterInput, "minPrice" | "maxPrice"> & {
        minPriceMinor?: SQL<number>;
        maxPriceMinor?: SQL<number>;
    },
    options: { drivenByIdSet?: boolean } = {},
): { conditions: SQL[]; needsProducts: boolean } {
    // Search hits and id lookups are small sets that drive the read through
    // `products` (the FTS rowids, the lookup ids), never the public walk.
    const drivenByIdSet = Boolean(options.drivenByIdSet)
        || Boolean(params.search)
        || parsePublicLookupTokens(params.ids).length > 0;
    const conditions: SQL[] = [publicBuyerStateCondition({ drivenByIdSet })];
    let needsProducts = false;
    if (params.category) conditions.push(buildCategoryLookupCondition(params.category, buyerState.categoryId));
    if (params.search) {
        needsProducts = true;
        conditions.push(
            or(ftsMatch(db, "products_fts", "products", params.search), productCategoryNameMatch(db, params.search))
                ?? sql`0 = 1`,
        );
    }
    if (params.ids) {
        const lookupTokens = parsePublicLookupTokens(params.ids);
        if (lookupTokens.length > 0) {
            conditions.push(buildProductLookupCondition(lookupTokens, {}, buyerState.productId));
        }
    }
    if (params.minPriceMinor !== undefined || params.maxPriceMinor !== undefined) {
        needsProducts = true;
        conditions.push(buyerCatalogHasSkuInPriceRange(params.minPriceMinor, params.maxPriceMinor));
    }
    if (params.freeDelivery === "true" || params.freeDelivery === "false") {
        needsProducts = true;
        conditions.push(eq(products.freeDelivery, params.freeDelivery === "true"));
    }
    if (params.hasDiscount === "true") conditions.push(sql`${buyerState.hasDiscount} = 1`);
    else if (params.hasDiscount === "false") conditions.push(sql`${buyerState.hasDiscount} = 0`);
    // "Exclude out of stock": the stored buyer-visible availability, the
    // same truth the card's sold-out band and the product feed show.
    if (params.inStock === "true") conditions.push(sql`${buyerState.availableForSale} = 1`);
    return { conditions, needsProducts };
}

/**
 * The request's set-narrowing conditions (category, search hits, id lookup).
 * They are cheap to test without the public eligibility checks, so they also
 * scope the buyer pricing projection (buildBuyerCatalogPricingProjection).
 */
export function storefrontProductSetConditions(
    db: Database,
    params: Pick<StorefrontProductFilterInput, "category" | "search" | "ids">,
    options: StorefrontProductConditionOptions = {},
): SQL[] {
    const conditions: SQL[] = [];
    if (params.category) conditions.push(buildCategoryLookupCondition(params.category));
    if (params.search) {
        conditions.push(
            or(ftsMatch(db, "products_fts", "products", params.search), productCategoryNameMatch(db, params.search))
                ?? sql`0 = 1`,
        );
    }
    if (params.ids) {
        const lookupTokens = parsePublicLookupTokens(params.ids);
        if (lookupTokens.length > 0) {
            conditions.push(buildProductLookupCondition(lookupTokens, options));
        }
    }
    return conditions;
}

export function getPagination(page: number, limit: number, total: number) {
    return {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
    };
}

export function productImageMapFromMedia(
    mediaMap: Map<string, ProductMediaProjection[]>,
): Map<string, { mediaId: string; url: string; alt: string | null }> {
    const result = new Map<string, { mediaId: string; url: string; alt: string | null }>();
    for (const [productId, mediaItems] of mediaMap) {
        const image = resolveProductImageRepresentation(mediaItems);
        if (image) result.set(productId, {
            mediaId: image.mediaId,
            url: image.url,
            alt: image.altText,
        });
    }
    return result;
}

// ─── Review ratings on buyer listings (Wave B §2.4) ─────────────────────
// Listings read only the `product_review_stats` trigger projection, by its
// primary key or its indexes, never `product_reviews` (R9). Catalogue reads
// the table through the schema, not the reviews domain.

/** The stats projection (read-only here: triggers own every write, R3). */
export const reviewStats = productReviewStats;

/** `minRating` as whole stars 1-4 ("N★ & up"; the storefront offers 4, 3, 2), or undefined. */
export function normalizeMinRating(value: number | undefined): number | undefined {
    return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 4 ? value : undefined;
}

/**
 * The product has a published-review average of at least `stars`
 * (`rating_avg_centi >= stars * 100`, so 3.99 is not "4★ & up"). A
 * correlated primary-key probe per scoped product, so the listing's own
 * index keeps driving the read.
 */
export function productMinRatingCondition(productId: SQL | AnyColumn, stars: number): SQL {
    return sql`EXISTS (
        SELECT 1 FROM ${reviewStats} AS rating_filter
        WHERE rating_filter.product_id = ${productId}
          AND rating_filter.rating_avg_centi >= ${stars * 100}
    )`;
}

/**
 * The review-stats join for a product id: no row while reviews are off, so
 * cards carry no rating, the rating facet is empty and the `rating` order
 * falls back to newest (the storefront hides them too, but the API must not
 * publish them).
 */
export function reviewStatsJoin(productId: AnyColumn | SQL): SQL {
    return sql`${reviewStats.productId} = ${productId} AND ${reviewsEnabledSql()} = 1`;
}

/** A card's rating: `{average, count}` from the stats row, null without a published review. */
export type CardRating = { average: number; count: number } | null;

export function presentCardRating(ratingAvgCenti: number | null | undefined, reviewCount: number | null | undefined): CardRating {
    const count = Number(reviewCount ?? 0);
    if (!Number.isFinite(count) || count < 1 || ratingAvgCenti === null || ratingAvgCenti === undefined) return null;
    return { average: Number(ratingAvgCenti) / 100, count };
}
