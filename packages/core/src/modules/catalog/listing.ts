// Buyer product listings: the shop, category and collection pages.
import { products, categories } from "@scalius/database/schema";
import { and, sql, desc, eq, type SQL } from "drizzle-orm";
import { suggestSearchCorrection } from "../../search/correct";
import { productSearchRankJoin, productSearchRelevanceOrder } from "../../search/relevance";
import { unixToDate } from "@scalius/shared/utils";
import { fromMinor } from "@scalius/shared/money";
import type { StorefrontProductFilterInput } from "../products/types";
import type { Database } from "@scalius/database/client";
import { publicProductBaseConditions } from "../products/public-eligibility";
import {
    buildBuyerCatalogPricingProjection,
    type BuyerCatalogPricingProjection,
} from "../products/buyer-projection";
import {
    buyerPricingSelection,
    effectivePriceMinorSql,
    presentBuyerPricing,
    storeCurrencyCodeSql,
    storeDecimalPlacesFromCode,
} from "../products/money";
import { publicCategoryConditions } from "../categories/categories.publication";
import { publicCategorySubtreeCondition } from "../categories/categories.tree";
import { loadProductMediaProjections, resolveProductCardImages } from "../products/media";
import {
    isOptionFilter,
    buildOptionFilterCondition,
    buildAttributeProductSubquery,
    buildResultScopedFacetQuery,
    buildResultScopedOptionFacetQuery,
    type PublicProductFacetRow,
    groupResultScopedFacets,
} from "./facets";
import {
    priceFilterBoundsMinor,
    storefrontProductSetConditions,
    buildStorefrontProductConditions,
    getPagination,
    STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE,
    publishedCategoryIdSet,
} from "./shared";

type StorefrontProductSort = NonNullable<StorefrontProductFilterInput["sort"]>;

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
};

type StorefrontProductListRowWithVariants = StorefrontProductListRow & {
    hasCustomerOptions: number;
    availableForSale: number;
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

/** A pricing-projection scope from the given set conditions, or none. */
function storefrontPricingScope(conditions: Array<SQL | undefined>): SQL | undefined {
    const present = conditions.filter((condition): condition is SQL => Boolean(condition));
    return present.length > 0 ? and(...present) : undefined;
}

function getStorefrontProductOrderBy(
    sort: StorefrontProductSort = "newest",
    buyerPricing?: BuyerCatalogPricingProjection,
) {
    const productDiscount = {
        discountType: sql`${products.discountType}`,
        discountBps: sql`${products.discountBps}`,
        discountAmountMinor: sql`${products.discountAmountMinor}`,
    };
    const effectivePriceSql = buyerPricing
        ? sql`${buyerPricing.effectivePriceMinor}`
        : effectivePriceMinorSql({ priceMinor: sql`${products.priceMinor}`, ...productDiscount }, productDiscount);

    if (sort === "price-asc") {
        return effectivePriceSql;
    }
    if (sort === "price-desc") {
        return desc(effectivePriceSql);
    }
    if (sort === "name-asc") {
        return products.name;
    }
    if (sort === "name-desc") {
        return desc(products.name);
    }
    if (sort === "discount") {
        if (buyerPricing) {
            return desc(sql`CASE
                WHEN ${buyerPricing.basePriceMinor} > 0
                    THEN (${buyerPricing.basePriceMinor} - ${buyerPricing.effectivePriceMinor}) * 10000 / ${buyerPricing.basePriceMinor}
                ELSE 0
            END`);
        }
        return desc(sql`CASE
            WHEN ${products.priceMinor} > 0 AND ${products.discountType} = 'flat' AND ${products.discountAmountMinor} > 0 THEN ${products.discountAmountMinor} * 10000 / ${products.priceMinor}
            WHEN ${products.discountBps} > 0 THEN ${products.discountBps}
            ELSE 0
        END`);
    }
    return desc(products.createdAt);
}

// ─────────────────────────────────────────
// Storefront queries
// ─────────────────────────────────────────

type StorefrontCatalogScope = {
    condition?: SQL;
    orderBy?: SQL | ((buyerPricing: ReturnType<typeof buildBuyerCatalogPricingProjection>) => SQL);
    fixedCategory?: StorefrontCategoryProductCategory;
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
    const optionFilters = (params.attributeFilters ?? []).filter(isOptionFilter);
    const attributeFilters = (params.attributeFilters ?? []).filter((filter) => !isOptionFilter(filter));
    const priceBounds = priceFilterBoundsMinor(params);
    const buyerPricing = buildBuyerCatalogPricingProjection(db, {
        productScope: storefrontPricingScope([scope.condition, ...storefrontProductSetConditions(db, params)]),
    });
    // Facet counts apply every selection except their own facet's, so they
    // read the scope conditions before the option filter is applied.
    const unfilteredOptionConditions = buildStorefrontProductConditions(db, { ...params, ...priceBounds }, {}, buyerPricing);
    const priceRangeConditions = buildStorefrontProductConditions(db, params, {}, buyerPricing);
    if (scope.condition) {
        unfilteredOptionConditions.push(scope.condition);
        priceRangeConditions.push(scope.condition);
    }
    const optionCondition = buildOptionFilterCondition(optionFilters);
    const conditions = optionCondition ? [...unfilteredOptionConditions, optionCondition] : unfilteredOptionConditions;
    if (optionCondition) priceRangeConditions.push(optionCondition);
    const orderBy = typeof scope.orderBy === "function"
        ? [scope.orderBy(buyerPricing)]
        : scope.orderBy
            ? [scope.orderBy]
            : sort === "relevance" && search
                ? [...productSearchRelevanceOrder(db, search), desc(products.createdAt)]
                : [getStorefrontProductOrderBy(sort, buyerPricing)];
    const offset = (page - 1) * limit;

    let query = db
        .select({
            id: products.id,
            name: products.name,
            ...buyerPricingSelection(buyerPricing),
            slug: products.slug,
            freeDelivery: products.freeDelivery,
            categoryId: products.categoryId,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`.as("createdAt"),
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`.as("updatedAt"),
            hasCustomerOptions: buyerPricing.hasCustomerOptions,
            availableForSale: buyerPricing.availableForSale,
        })
        .from(products)
        .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
        .where(and(...conditions));
    const attributeSubquery = buildAttributeProductSubquery(
        db,
        attributeFilters,
        "catalog_filtered_products",
    );
    if (attributeSubquery) {
        query = query.innerJoin(attributeSubquery, eq(products.id, attributeSubquery.productId));
    }
    const rankJoin = !scope.orderBy && sort === "relevance" && search
        ? productSearchRankJoin(db, search)
        : undefined;
    if (rankJoin) query = query.leftJoin(rankJoin.table, rankJoin.on);

    // Without a price filter the price range reads exactly the count's rows,
    // so one statement answers both instead of evaluating the catalogue's
    // eligibility and pricing twice.
    const hasPriceFilter = priceBounds.minPriceMinor !== undefined || priceBounds.maxPriceMinor !== undefined;
    let countQuery = db
        .select({
            count: sql<number>`count(*)`,
            storeCurrencyCode: storeCurrencyCodeSql(),
            min: sql<number | null>`MIN(${buyerPricing.effectivePriceMinor})`,
            max: sql<number | null>`MAX(${buyerPricing.maxBuyerPriceMinor})`,
        })
        .from(products)
        .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
        .where(and(...conditions));
    const countSubquery = buildAttributeProductSubquery(
        db,
        attributeFilters,
        "catalog_count_filtered_products",
    );
    if (countSubquery) {
        countQuery = countQuery.innerJoin(countSubquery, eq(products.id, countSubquery.productId));
    }

    let priceRangeQuery = db
        .select({
            min: sql<number | null>`MIN(${buyerPricing.effectivePriceMinor})`,
            max: sql<number | null>`MAX(${buyerPricing.maxBuyerPriceMinor})`,
        })
        .from(products)
        .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
        .where(and(...priceRangeConditions));
    const priceRangeSubquery = buildAttributeProductSubquery(
        db,
        attributeFilters,
        "catalog_price_range_filtered_products",
    );
    if (priceRangeSubquery) {
        priceRangeQuery = priceRangeQuery.innerJoin(
            priceRangeSubquery,
            eq(products.id, priceRangeSubquery.productId),
        );
    }

    const facetQuery = buildResultScopedFacetQuery(
        db,
        buyerPricing,
        unfilteredOptionConditions,
        attributeFilters,
        optionCondition,
    );
    const optionFacetQuery = buildResultScopedOptionFacetQuery(
        db,
        buyerPricing,
        unfilteredOptionConditions,
        attributeFilters,
        optionFilters,
    );
    const [productsList, totalCount, filteredPriceRange, facetRows, optionFacetRows] = await Promise.all([
        query.orderBy(...orderBy, products.id).limit(limit).offset(offset).all(),
        countQuery.get(),
        hasPriceFilter ? priceRangeQuery.get() : Promise.resolve(null),
        facetQuery.all() as Promise<PublicProductFacetRow[]>,
        optionFacetQuery.all() as Promise<PublicProductFacetRow[]>,
    ]);
    const decimalPlaces = storeDecimalPlacesFromCode(totalCount?.storeCurrencyCode);
    const rawPriceRange = hasPriceFilter ? filteredPriceRange : totalCount;

    const productIds = productsList.map((product) => product.id);
    // A fixed category names every row in it; a subtree listing still reads
    // the sub-categories its other rows sit in (none on a flat store).
    const categoryIds = [...new Set(
        productsList
            .map((product) => product.categoryId)
            .filter((id): id is string => Boolean(id) && id !== scope.fixedCategory?.id),
    )];
    const [mediaMap, categoriesData] = await Promise.all([
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
    ]);
    const categoryMap = new Map(categoriesData.map((category) => [category.id, category]));
    const productsWithImages = productsList.map(({
        hasCustomerOptions,
        availableForSale,
        ...product
    }: StorefrontProductListRowWithVariants) => {
        const category = scope.fixedCategory && product.categoryId === scope.fixedCategory.id
            ? scope.fixedCategory
            : product.categoryId ? categoryMap.get(product.categoryId) ?? null : null;
        return {
            ...presentBuyerPricing(product, decimalPlaces),
            categoryId: category?.id ?? null,
            hasVariants: Boolean(hasCustomerOptions),
            availableForSale: Boolean(availableForSale),
            ...resolveProductCardImages(mediaMap.get(product.id) ?? []),
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
        facets: [
            ...groupResultScopedFacets(optionFacetRows, optionFilters),
            ...groupResultScopedFacets(facetRows, attributeFilters),
        ],
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
        condition: options.includeDescendants
            ? publicCategorySubtreeCondition(products.categoryId, category.id)
            : eq(products.categoryId, category.id),
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
        condition: eq(products.brandId, brand.id),
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
    // Two index-driven sets rather than one json_each probe per product: the
    // probe tested every public product against every member (11-17 s for a
    // 90-product collection on a 30k-product catalogue).
    const branches: SQL[] = [];
    if (productIds.length > 0) {
        branches.push(sql`${products.id} IN (
            SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(productIds)})
        )`);
    }
    if (categoryIds.length > 0) {
        branches.push(sql`${products.categoryId} IN ${publishedCategoryIdSet(sql`${categories.id} IN (
            SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(categoryIds)})
        )`)}`);
    }
    const condition = branches.length > 0 ? sql`(${sql.join(branches, sql` OR `)})` : sql`0 = 1`;
    return { productIds, membershipJson, condition };
}

/**
 * How many of a collection's products buyers see: the storefront catalog's
 * own count (public products with a buyer-resolvable SKU), for batching.
 */
export function storefrontCollectionVisibleCountQuery(db: Database, membership: StorefrontCollectionMembership) {
    const { condition } = storefrontCollectionMembership(membership);
    const buyerPricing = buildBuyerCatalogPricingProjection(db, { productScope: condition });
    return db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
        .where(and(...publicProductBaseConditions(), condition));
}

export async function getStorefrontCollectionProducts(
    db: Database,
    membership: StorefrontCollectionMembership,
    params: StorefrontProductFilterInput,
) {
    const { productIds, membershipJson, condition } = storefrontCollectionMembership(membership);

    return readStorefrontCatalogPage(db, params, {
        condition,
        orderBy: productIds.length > 0 && (!params.sort || params.sort === "newest")
            ? (buyerPricing) => sql`COALESCE((
                SELECT CAST(key AS INTEGER)
                FROM json_each(${membershipJson}) AS curated_membership
                WHERE json_extract(curated_membership.value, '$.kind') = 'product'
                    AND json_extract(curated_membership.value, '$.id') = ${products.id}
            ), 2147483647), ${getStorefrontProductOrderBy(params.sort ?? "newest", buyerPricing)}`
            : undefined,
    });
}
