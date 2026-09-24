// Helpers shared by the catalogue reads. Not exported from the domain entry.
import { products, categories } from "@scalius/database/schema";
import { and, sql, eq, or, type SQL } from "drizzle-orm";
import { ftsMatch } from "../../search/fts5";
import { productCategoryNameMatch } from "../../search/relevance";
import type { StorefrontProductFilterInput } from "../products/types";
import type { Database } from "@scalius/database/client";
import { publicProductBaseConditions } from "../products/public-eligibility";
import {
    buyerCatalogHasSkuInPriceRange,
    type BuyerCatalogPricingProjection,
} from "../products/buyer-projection";
import { storeDecimalToMinorSql } from "../products/money";
import { publicCategoryConditions } from "../categories/categories.publication";
import { resolveProductImageRepresentation, type ProductMediaProjection } from "../products/media";

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

function buildCategoryLookupCondition(category: string): SQL {
    return sql`${products.categoryId} IN ${publishedCategoryIdSet(
        sql`(${categories.id} = ${category} OR ${categories.slug} = ${category})`,
    )}`;
}

function buildProductLookupCondition(
    lookupTokens: string[],
    options: StorefrontProductConditionOptions = {},
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

    return sql`${products.id} IN (
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
