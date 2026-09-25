// Buyer product listings: the shop, category and collection pages.
//
// Every statement reads the stored buyer state (`product_buyer_state`, see
// buyer-state.ts): the public set, the card SKU's prices, discount depth and
// availability are indexed columns, so a listing never evaluates the public
// eligibility predicate or ranks SKUs per request.
import { products, categories } from "@scalius/database/schema";
import { and, sql, desc, eq, type SQL, type SQLWrapper } from "drizzle-orm";
import { suggestSearchCorrection } from "../../search/correct";
import { productSearchRankJoin, productSearchRelevanceOrder } from "../../search/relevance";
import { unixToDate } from "@scalius/shared/utils";
import { fromMinor } from "@scalius/shared/money";
import type { StorefrontProductFilterInput } from "../products/types";
import type { Database } from "@scalius/database/client";
import {
    presentBuyerPricing,
    storeCurrencyCodeSql,
    storeDecimalPlacesFromCode,
} from "../products/money";
import { publicCategoryConditions } from "../categories/categories.publication";
import { publicCategorySubtreeCondition } from "../categories/categories.tree";
import { loadProductMediaProjections, resolveProductCardImages } from "../products/media";
import {
    buildCatalogFacetCountQuery,
    catalogFacetFilterConditions,
    groupCatalogFacets,
    groupCatalogRatingFacet,
    type CatalogFacetCountRow,
} from "./facets";
import {
    priceFilterBoundsMinor,
    buildStorefrontBuyerStateConditions,
    getPagination,
    normalizeMinRating,
    presentCardRating,
    productMinRatingCondition,
    reviewStats,
    STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE,
    publishedCategoryIdSet,
} from "./shared";
import {
    buyerState,
    buyerStateCardSku,
    buyerStatePricingSelection,
    publicBuyerStateCondition,
} from "./buyer-state";

type StorefrontProductSort = NonNullable<StorefrontProductFilterInput["sort"]>;

/**
 * Facet counts over the unscoped "shop all" set (no category, collection,
 * search or id lookup) are computed live only while the whole public
 * catalogue holds at most this many products. Above it a live count reads
 * every attribute and option row in the store (397k rows at 30k products),
 * so large stores filter inside a category, where counts stay bounded by
 * the category's own products. Decided in Scale-A (CATALOG-SCALE Design D):
 * a cap, not a per-category count cache.
 */
export const SHOP_ALL_LIVE_FACET_PRODUCT_LIMIT = 2_000;

type StorefrontProductListRow = {
    id: string;
    name: string;
    basePriceMinor: number;
    slug: string;
    discountType: string | null;
    discountBps: number;
    discountAmountMinor: number;
    effectivePriceMinor: number;
    maxBuyerPriceMinor: number;
    freeDelivery: boolean;
    categoryId: string | null;
    createdAt: number;
    updatedAt: number;
    ratingAvgCenti: number | null;
    reviewCount: number | null;
};

type StorefrontProductListRowWithVariants = StorefrontProductListRow & {
    hasCustomerOptions: number | boolean;
    availableForSale: number | boolean;
};

export interface StorefrontCategoryProductCategory {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    imageUrl: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
    canonicalPath: string | null;
    noIndex: boolean;
    excludeFromSitemap: boolean;
    createdAt: string | null;
    updatedAt: string | null;
}

/**
 * The listing order over the buyer state. Newest, price and discount orders
 * are the buyer state's own indexed columns; ties break by product id.
 *
 * `sortAfterScope`: the scope is a set of categories, read through the
 * category index and then sorted. SQLite has no statistics on D1, so a
 * sortable index (newest, price) would otherwise win and walk every public
 * row filtering by the set; the unary `+` keeps the order from choosing it,
 * which bounds the read by the scope's own size.
 *
 * `rating` reads the review stats projection the page left-joins by primary
 * key (`rating_rank_milli`, Bayesian, so one 5★ never outranks many 4.8★):
 * no buyer-state index gives that order, so the scope's own index drives
 * and the page is sorted after it; unreviewed products come last, newest
 * first.
 */
function getStorefrontProductOrderBy(sort: StorefrontProductSort = "newest", sortAfterScope = false): SQL {
    const column = (value: SQLWrapper) => sortAfterScope ? sql`+${value}` : sql`${value}`;
    if (sort === "price-asc") return column(buyerState.fromMinor);
    if (sort === "price-desc") return sql`${column(buyerState.fromMinor)} DESC`;
    if (sort === "name-asc") return sql`${products.name}`;
    if (sort === "name-desc") return desc(products.name);
    if (sort === "discount") return sql`${column(buyerState.discountDepthBps)} DESC`;
    if (sort === "rating") {
        return sql`${reviewStats.ratingRankMilli} DESC NULLS LAST, COALESCE(${reviewStats.reviewCount}, 0) DESC, ${column(buyerState.productCreatedAt)} DESC`;
    }
    return sql`${column(buyerState.productCreatedAt)} DESC`;
}

// ─────────────────────────────────────────
// Storefront queries
// ─────────────────────────────────────────

type StorefrontCatalogScope = {
    /** A condition on the buyer state (or on `products` with `needsProducts`). */
    condition?: SQL;
    /** The scope condition reads `products` columns. */
    needsProducts?: boolean;
    /** The scope is a small id set that should drive the read by primary key. */
    drivenByIdSet?: boolean;
    /** The scope is a category set read through the category index, then sorted. */
    sortAfterScope?: boolean;
    orderBy?: SQL;
    fixedCategory?: StorefrontCategoryProductCategory;
    /** The brand's own page: no brand facet. */
    withoutBrandFacet?: boolean;
};

/**
 * Reads one catalog page. A search that matches nothing is retried once with
 * the closest catalog words ("kettel" → "kettle", "ব্যাগ" → "bag"); the
 * response then carries `correctedQuery` so the storefront can say so.
 */
async function readStorefrontCatalogPage(
    db: Database,
    params: StorefrontProductFilterInput,
    scope: StorefrontCatalogScope = {},
) {
    const result = await readStorefrontCatalogResults(db, params, scope);
    if (!params.search || result.pagination.total > 0) return { ...result, correctedQuery: null };
    const correctedQuery = await suggestSearchCorrection(db, params.search);
    if (!correctedQuery) return { ...result, correctedQuery: null };
    const corrected = await readStorefrontCatalogResults(db, { ...params, search: correctedQuery }, scope);
    return corrected.pagination.total > 0
        ? { ...corrected, correctedQuery }
        : { ...result, correctedQuery: null };
}

/** At most `limit + 1` public products: enough to tell "more than limit" apart. */
function boundedPublicCatalogueSizeSql(limit: number): SQL<number> {
    return sql<number>`(
        SELECT count(*) FROM (
            SELECT 1 FROM ${buyerState} WHERE ${publicBuyerStateCondition()} LIMIT ${sql.raw(String(limit + 1))}
        ) AS public_catalogue_probe
    )`;
}

async function readStorefrontCatalogResults(
    db: Database,
    params: StorefrontProductFilterInput,
    scope: StorefrontCatalogScope,
) {
    const {
        page = 1,
        limit = 20,
        search,
        sort = search ? "relevance" : "newest",
    } = params;
    const priceBounds = priceFilterBoundsMinor(params);
    const unscoped = !scope.condition && !params.category && !params.search && !params.ids;
    // Facet counts apply every selection except their own facet's, so they
    // read the scope conditions before the facet filters are applied.
    const setOptions = { drivenByIdSet: scope.drivenByIdSet };
    const unfiltered = buildStorefrontBuyerStateConditions(db, { ...params, ...priceBounds }, setOptions);
    const priceRange = buildStorefrontBuyerStateConditions(db, params, setOptions);
    const facetBaseConditions = unfiltered.conditions;
    const priceRangeConditions = priceRange.conditions;
    if (scope.condition) {
        facetBaseConditions.push(scope.condition);
        priceRangeConditions.push(scope.condition);
    }
    // Selected facet values, ranges, option axes and brands: probes of the
    // stored facet rows and buyer state, never a `products` read.
    const facetConditions = catalogFacetFilterConditions(params.attributeFilters);
    // "N★ & up": a primary-key probe of the review stats per scoped product.
    const minRating = normalizeMinRating(params.minRating);
    if (minRating !== undefined) facetConditions.push(productMinRatingCondition(buyerState.productId, minRating));
    const conditions = [...facetBaseConditions, ...facetConditions];
    priceRangeConditions.push(...facetConditions);
    // The count and price range join `products` only when a condition reads it.
    const countNeedsProducts = unfiltered.needsProducts || Boolean(scope.needsProducts);
    const priceRangeNeedsProducts = priceRange.needsProducts || Boolean(scope.needsProducts);
    const orderBy = scope.orderBy
        ? [scope.orderBy]
        : sort === "relevance" && search
            ? [...productSearchRelevanceOrder(db, search), desc(buyerState.productCreatedAt)]
            : [getStorefrontProductOrderBy(sort, scope.sortAfterScope)];
    const offset = (page - 1) * limit;

    const cardSku = buyerStateCardSku();
    let query = db
        .select({
            id: products.id,
            name: products.name,
            ...buyerStatePricingSelection(cardSku),
            slug: products.slug,
            freeDelivery: products.freeDelivery,
            categoryId: products.categoryId,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`.as("createdAt"),
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`.as("updatedAt"),
            hasCustomerOptions: buyerState.hasCustomerOptions,
            availableForSale: buyerState.availableForSale,
            ratingAvgCenti: reviewStats.ratingAvgCenti,
            reviewCount: reviewStats.reviewCount,
        })
        .from(buyerState)
        .innerJoin(products, eq(products.id, buyerState.productId))
        .leftJoin(cardSku, eq(cardSku.id, buyerState.skuId))
        // The card rating (and the `rating` order): the page's rows by primary key.
        .leftJoin(reviewStats, eq(reviewStats.productId, buyerState.productId))
        .where(and(...conditions))
        .$dynamic();
    const rankJoin = !scope.orderBy && sort === "relevance" && search
        ? productSearchRankJoin(db, search)
        : undefined;
    if (rankJoin) query = query.leftJoin(rankJoin.table, rankJoin.on);

    // Without a price filter the price range reads exactly the count's rows,
    // so one statement answers both.
    const hasPriceFilter = priceBounds.minPriceMinor !== undefined || priceBounds.maxPriceMinor !== undefined;
    let countQuery = db
        .select({
            count: sql<number>`count(*)`,
            storeCurrencyCode: storeCurrencyCodeSql(),
            min: sql<number | null>`MIN(${buyerState.fromMinor})`,
            max: sql<number | null>`MAX(${buyerState.toMinor})`,
            publicCatalogueSize: unscoped
                ? boundedPublicCatalogueSizeSql(SHOP_ALL_LIVE_FACET_PRODUCT_LIMIT)
                : sql<number>`0`,
        })
        .from(buyerState)
        .$dynamic();
    if (countNeedsProducts) countQuery = countQuery.innerJoin(products, eq(products.id, buyerState.productId));
    countQuery = countQuery.where(and(...conditions));

    let priceRangeQuery = db
        .select({
            min: sql<number | null>`MIN(${buyerState.fromMinor})`,
            max: sql<number | null>`MAX(${buyerState.toMinor})`,
        })
        .from(buyerState)
        .$dynamic();
    if (priceRangeNeedsProducts) {
        priceRangeQuery = priceRangeQuery.innerJoin(products, eq(products.id, buyerState.productId));
    }
    priceRangeQuery = priceRangeQuery.where(and(...priceRangeConditions));

    // Every facet (brand, option axes, attributes) in one statement.
    const facetReads = () => buildCatalogFacetCountQuery(db, {
        baseConditions: facetBaseConditions,
        needsProducts: countNeedsProducts,
        filters: params.attributeFilters,
        categoryId: scope.fixedCategory?.id,
        brandFacet: !scope.withoutBrandFacet,
        ratingFacet: true,
        minRating,
    });
    const noFacets = Promise.resolve([] as CatalogFacetCountRow[]);
    // A scoped listing counts its facets in the first wave; the unscoped one
    // learns the catalogue size from its count first (see the limit above).
    const [productsList, totalCount, filteredPriceRange, scopedFacets] = await Promise.all([
        query.orderBy(...orderBy, buyerState.productId).limit(limit).offset(offset).all() as Promise<StorefrontProductListRowWithVariants[]>,
        countQuery.get(),
        hasPriceFilter ? priceRangeQuery.get() : Promise.resolve(null),
        unscoped ? noFacets : facetReads(),
    ]);
    const decimalPlaces = storeDecimalPlacesFromCode(totalCount?.storeCurrencyCode);
    const rawPriceRange = hasPriceFilter ? filteredPriceRange : totalCount;
    const shopAllFacetsLive = unscoped
        && Number(totalCount?.publicCatalogueSize ?? 0) <= SHOP_ALL_LIVE_FACET_PRODUCT_LIMIT;

    const productIds = productsList.map((product) => product.id);
    // A fixed category names every row in it; a subtree listing still reads
    // the sub-categories its other rows sit in (none on a flat store).
    const categoryIds = [...new Set(
        productsList
            .map((product) => product.categoryId)
            .filter((id): id is string => Boolean(id) && id !== scope.fixedCategory?.id),
    )];
    const [mediaMap, categoriesData, facetRows] = await Promise.all([
        loadProductMediaProjections(db, productIds),
        categoryIds.length > 0
            ? db
                .select({ id: categories.id, name: categories.name, slug: categories.slug })
                .from(categories)
                .where(and(
                    // One JSON parameter: a 100-card page can name 100 categories,
                    // and 100 ids plus the status bind exceed D1's 100 limit.
                    sql`${categories.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(categoryIds)}))`,
                    ...publicCategoryConditions(),
                ))
                .all() as Promise<Array<{ id: string; name: string; slug: string }>>
            : Promise.resolve([] as Array<{ id: string; name: string; slug: string }>),
        shopAllFacetsLive ? facetReads() : Promise.resolve(scopedFacets),
    ]);
    const categoryMap = new Map(categoriesData.map((category) => [category.id, category]));
    const productsWithImages = productsList.map(({
        hasCustomerOptions,
        availableForSale,
        ratingAvgCenti,
        reviewCount,
        ...product
    }) => {
        const category = scope.fixedCategory && product.categoryId === scope.fixedCategory.id
            ? scope.fixedCategory
            : product.categoryId ? categoryMap.get(product.categoryId) ?? null : null;
        return {
            ...presentBuyerPricing(product, decimalPlaces),
            categoryId: category?.id ?? null,
            hasVariants: Boolean(hasCustomerOptions),
            availableForSale: Boolean(availableForSale),
            ...resolveProductCardImages(mediaMap.get(product.id) ?? []),
            rating: presentCardRating(ratingAvgCenti, reviewCount),
            category,
            createdAt: unixToDate(product.createdAt)?.toISOString() ?? null,
            updatedAt: unixToDate(product.updatedAt)?.toISOString() ?? null,
        };
    });

    return {
        products: productsWithImages,
        pagination: getPagination(page, limit, totalCount?.count ?? 0),
        priceRange: {
            min: fromMinor(rawPriceRange?.min ?? 0, decimalPlaces),
            max: fromMinor(rawPriceRange?.max ?? 0, decimalPlaces),
        },
        facets: groupCatalogFacets(facetRows, params.attributeFilters),
        ratingFacet: groupCatalogRatingFacet(facetRows, minRating),
    };
}

/**
 * Returns a paginated list of active storefront products with images and categories.
 * This is the unified query backing the Hono GET /api/storefront/products route.
 */
export async function getStorefrontProducts(db: Database, params: StorefrontProductFilterInput) {
    return readStorefrontCatalogPage(db, params);
}

/**
 * Returns category-scoped storefront products using the shared public product
 * filtering/sort core, without the extra variant/category enrichment needed by
 * the global product list endpoint.
 */
export async function getStorefrontCategoryProducts(
    db: Database,
    category: StorefrontCategoryProductCategory,
    params: StorefrontProductFilterInput,
    options: StorefrontCategoryListingOptions = {},
) {
    return readStorefrontCatalogPage(db, params, {
        // The buyer state's category index: (is_public, category_id, newest).
        condition: options.includeDescendants
            ? publicCategorySubtreeCondition(buyerState.categoryId, category.id)
            : eq(buyerState.categoryId, category.id),
        sortAfterScope: options.includeDescendants === true,
        fixedCategory: category,
    });
}

// ── Catalogue 1a: category subtrees and brand listings ────────────────────
// Kept as one block so the projection rewrite of the reads above can rebase
// onto it: both are scopes of readStorefrontCatalogPage and nothing else.

export interface StorefrontCategoryListingOptions {
    /**
     * List the category's published sub-categories too (closure read; a
     * draft or internal descendant's products stay out of the parent).
     */
    includeDescendants?: boolean;
}

/** A brand page's products: the storefront catalogue scoped to one brand. */
export async function getStorefrontBrandProducts(
    db: Database,
    brand: { id: string },
    params: StorefrontProductFilterInput,
) {
    return readStorefrontCatalogPage(db, params, {
        // The buyer state's brand index: (is_public, brand_id, newest).
        condition: eq(buyerState.brandId, brand.id),
        withoutBrandFacet: true,
    });
}

// ── End of the catalogue 1a block ─────────────────────────────────────────

interface StorefrontCollectionMembership {
    productIds?: string[];
    categoryIds?: string[];
}

/** A collection's members: its picked products and every product in its published categories. */
function storefrontCollectionMembership(membership: StorefrontCollectionMembership) {
    const productIds = Array.from(new Set(
        (membership.productIds ?? []).map((id) => id.trim()).filter(Boolean),
    )).slice(0, STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE);
    const categoryIds = Array.from(new Set(
        (membership.categoryIds ?? []).map((id) => id.trim()).filter(Boolean),
    )).slice(0, STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE);
    const membershipEntries = [
        ...productIds.map((id) => ({ kind: "product", id })),
        ...categoryIds.map((id) => ({ kind: "category", id })),
    ];
    const membershipJson = JSON.stringify(membershipEntries);
    // One member-id set probed by primary key, rather than a json_each probe
    // per product (11-17 s for a 90-product collection on a 30k-product
    // catalogue) or an OR of two sets (which SQLite answers by walking every
    // public row): the picked ids, plus the public products of the
    // collection's published categories through the category index.
    const branches: SQL[] = [];
    if (productIds.length > 0) {
        branches.push(sql`SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(productIds)})`);
    }
    if (categoryIds.length > 0) {
        branches.push(sql`SELECT collection_member.product_id
            FROM ${buyerState} AS collection_member
            WHERE collection_member.is_public = 1
              AND collection_member.category_id IN ${publishedCategoryIdSet(sql`${categories.id} IN (
                  SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(categoryIds)})
              )`)}`);
    }
    const condition = branches.length > 0
        ? sql`${buyerState.productId} IN (${sql.join(branches, sql` UNION `)})`
        : sql`0 = 1`;
    return { productIds, membershipJson, condition };
}

/**
 * How many of a collection's products buyers see: the storefront catalog's
 * own count (public products with a buyer-resolvable SKU), for batching.
 */
export function storefrontCollectionVisibleCountQuery(db: Database, membership: StorefrontCollectionMembership) {
    const { condition } = storefrontCollectionMembership(membership);
    return db
        .select({ count: sql<number>`count(*)` })
        .from(buyerState)
        .where(and(publicBuyerStateCondition({ drivenByIdSet: true }), condition));
}

export async function getStorefrontCollectionProducts(
    db: Database,
    membership: StorefrontCollectionMembership,
    params: StorefrontProductFilterInput,
) {
    const { productIds, membershipJson, condition } = storefrontCollectionMembership(membership);

    return readStorefrontCatalogPage(db, params, {
        condition,
        drivenByIdSet: true,
        orderBy: productIds.length > 0 && (!params.sort || params.sort === "newest")
            ? sql`COALESCE((
                SELECT CAST(key AS INTEGER)
                FROM json_each(${membershipJson}) AS curated_membership
                WHERE json_extract(curated_membership.value, '$.kind') = 'product'
                    AND json_extract(curated_membership.value, '$.id') = ${buyerState.productId}
            ), 2147483647), ${getStorefrontProductOrderBy(params.sort ?? "newest")}`
            : undefined,
    });
}
