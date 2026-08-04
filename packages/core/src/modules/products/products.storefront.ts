// src/modules/products/products.storefront.ts
// Storefront product queries — public-facing read-only operations.
import {
    products,
    categories,
    productVariants,
    productRichContent,
    productAttributeValues,
    productAttributes,
} from "@scalius/database/schema";
import { effectiveRegularReservedStockSql } from "@scalius/database/inventory-authority";
import { and, sql, desc, eq, isNull, inArray, or, lt, type SQL } from "drizzle-orm";
import { ftsMatch } from "../../search/fts5";
import { unixToDate } from "@scalius/shared/utils";
import { calculateDiscountedPrice } from "@scalius/shared/price-utils";
import type {
    StorefrontFeedProduct,
    StorefrontFeedProductAttribute,
    StorefrontFeedProductFilterInput,
    StorefrontFeedProductPage,
    StorefrontFeedProductVariant,
    StorefrontProductFilterInput,
} from "./products.types";
import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import {
    publicProductBaseConditions,
    publicProductHasBuyerResolvableSku,
    publicProductHasPrimaryDiscoveryImage,
    normalizeDefaultSkuOptions,
} from "./products.public-eligibility";
import {
    buildBuyerCatalogPricingProjection,
    buyerCatalogHasSkuInPriceRange,
    type BuyerCatalogPricingProjection,
} from "./products.buyer-projection";
import {
    loadProductOptions,
    loadVariantSelectedOptions,
    type SelectedProductOption,
} from "./products.option-model";
import {
    publicCategoryConditions,
    publishedCategoryIdExists,
} from "../categories/categories.publication";
import {
    loadProductMediaProjections,
    resolveProductImageRepresentation,
    resolveSkuImageRepresentation,
    type ProductMediaProjection,
} from "./products.media";

type StorefrontProductSort = NonNullable<StorefrontProductFilterInput["sort"]>;
type AttributeFilter = NonNullable<StorefrontProductFilterInput["attributeFilters"]>[number];
type StorefrontProductConditionOptions = {
    includeLookupHandles?: boolean;
    includeVariantLookups?: boolean;
    includeCategorySearchMatches?: boolean;
};

const MAX_PUBLIC_LOOKUP_TOKENS = 100;
const MAX_PUBLIC_CATEGORY_SEARCH_SLUG_LENGTH = 160;
// Leave room for non-IN predicates under D1's 100 bound-parameter limit.
const STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE = 90;

type StorefrontProductListRow = {
    id: string;
    name: string;
    price: number;
    slug: string;
    discountType: string | null;
    discountPercentage: number | null;
    discountAmount: number | null;
    discountedPrice: number;
    maxBuyerPrice: number;
    freeDelivery: boolean;
    categoryId: string | null;
    createdAt: number;
    updatedAt: number;
};

type StorefrontProductListRowWithVariants = StorefrontProductListRow & {
    hasCustomerOptions: number;
    availableForSale: number;
};

type StorefrontFeedProductListRow = {
    id: string;
    name: string;
    description: string | null;
    price: number;
    slug: string;
    canonicalPath: string | null;
    discountType: string | null;
    discountPercentage: number | null;
    discountAmount: number | null;
    freeDelivery: boolean;
    categoryId: string | null;
    excludeFromProductFeed: boolean;
    productCondition: "new" | "refurbished" | "used" | null;
    createdAt: number;
    updatedAt: number;
    hasCustomerOptions: number;
    availableForSale: number;
};

const STOREFRONT_FEED_CURSOR_PREFIX = "feed-v1.";

function encodeFeedCursor(position: { createdAt: number; id: string }): string {
    const bytes = new TextEncoder().encode(position.id);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encodedId = btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    return `${STOREFRONT_FEED_CURSOR_PREFIX}${position.createdAt.toString(36)}.${encodedId}`;
}

function decodeFeedCursor(cursor: string): { createdAt: number; id: string } {
    const match = /^feed-v1\.([0-9a-z]+)\.([A-Za-z0-9_-]+)$/.exec(cursor);
    if (!match?.[1] || !match[2]) throw new ValidationError("Invalid product feed cursor.");
    const createdAt = Number.parseInt(match[1], 36);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new ValidationError("Invalid product feed cursor.");
    }
    try {
        const padded = match[2].replace(/-/g, "+").replace(/_/g, "/")
            .padEnd(Math.ceil(match[2].length / 4) * 4, "=");
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const id = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes).trim();
        if (!id || id.length > 180) throw new Error("invalid id");
        return { createdAt, id };
    } catch {
        throw new ValidationError("Invalid product feed cursor.");
    }
}

type StorefrontSitemapProductRow = {
    slug: string;
    canonicalPath: string | null;
    updatedAt: number;
};

type StorefrontFeedVariantRow = Omit<
    StorefrontFeedProductVariant,
    "deletedAt" | "selectedOptions" | "imageUrl" | "imageMediaId"
> & {
    optionCombinationKey: string | null;
    deletedAt: number | null;
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

// ─────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────

function extractFeatures(description: string | null): string[] {
    if (!description) return [];
    const features: string[] = [];
    const lines = description.split("\n");
    for (const line of lines) {
        if (line.trim().match(/^[-*•]|^\d+\./) && line.trim().length > 2) {
            features.push(line.trim().replace(/^[-*•]|^\d+\./, "").trim());
        }
    }
    return features;
}

function parsePublicLookupTokens(ids: string | undefined): string[] {
    if (!ids) return [];
    return Array.from(new Set(ids.split(",").map((id) => id.trim()).filter(Boolean))).slice(
        0,
        MAX_PUBLIC_LOOKUP_TOKENS,
    );
}

function buildCategoryLookupCondition(category: string): SQL {
    return sql`EXISTS (
        SELECT 1
        FROM "categories"
        WHERE ${eq(categories.id, products.categoryId)}
          AND ${and(...publicCategoryConditions())}
          AND (${categories.id} = ${category} OR ${categories.slug} = ${category})
    )`;
}

function buildFeedCategorySearchCondition(db: Database, search: string): SQL | undefined {
    const normalizedSlug = search.trim().toLowerCase();
    const categoryNameCondition = ftsMatch(
        db,
        "categories_fts",
        "categories",
        search,
        { column: "name" },
    );
    const categoryMatch = or(
        categoryNameCondition,
        normalizedSlug.length <= MAX_PUBLIC_CATEGORY_SEARCH_SLUG_LENGTH
            ? eq(categories.slug, normalizedSlug)
            : undefined,
    );
    if (!categoryMatch) return undefined;

    return sql`EXISTS (
        SELECT 1
        FROM "categories"
        WHERE ${eq(categories.id, products.categoryId)}
          AND ${and(...publicCategoryConditions())}
          AND ${categoryMatch}
    )`;
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
        lookupBranches.push(sql`
            SELECT lookup_variant.product_id
            FROM "product_variants" AS lookup_variant
            INNER JOIN public_lookup
                ON lookup_variant.id = public_lookup.value
                OR lookup_variant.sku = public_lookup.value
            WHERE lookup_variant.deleted_at IS NULL
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

function buildStorefrontProductConditions(
    db: Database,
    params: StorefrontProductFilterInput,
    options: StorefrontProductConditionOptions = {},
    buyerPricing?: BuyerCatalogPricingProjection,
): SQL[] {
    const {
        category,
        search,
        minPrice,
        maxPrice,
        freeDelivery,
        hasDiscount,
        ids,
    } = params;

    const conditions: (SQL | undefined)[] = publicProductBaseConditions();

    if (category) conditions.push(buildCategoryLookupCondition(category));
    if (search) {
        const searchConditions = [ftsMatch(db, "products_fts", "products", search)];
        if (options.includeCategorySearchMatches) {
            searchConditions.push(buildFeedCategorySearchCondition(db, search));
        }
        conditions.push(
            or(
                ...searchConditions.filter(
                    (condition): condition is SQL => Boolean(condition),
                ),
            ) ?? sql`0 = 1`,
        );
    }
    if (buyerPricing && (minPrice !== undefined || maxPrice !== undefined)) {
        conditions.push(buyerCatalogHasSkuInPriceRange(minPrice, maxPrice));
    } else {
        if (minPrice !== undefined) conditions.push(sql`${products.price} >= ${minPrice}`);
        if (maxPrice !== undefined) conditions.push(sql`${products.price} <= ${maxPrice}`);
    }
    if (freeDelivery === "true") conditions.push(eq(products.freeDelivery, true));
    else if (freeDelivery === "false") conditions.push(eq(products.freeDelivery, false));
    if (hasDiscount === "true") {
        conditions.push(buyerPricing
            ? eq(buyerPricing.hasDiscount, 1)
            : sql`(${products.discountPercentage} > 0 OR ${products.discountAmount} > 0)`);
    } else if (hasDiscount === "false") {
        conditions.push(buyerPricing
            ? eq(buyerPricing.hasDiscount, 0)
            : sql`(${products.discountPercentage} IS NULL OR ${products.discountPercentage} = 0) AND (${products.discountAmount} IS NULL OR ${products.discountAmount} = 0)`);
    }
    if (ids) {
        const lookupTokens = parsePublicLookupTokens(ids);
        if (lookupTokens.length > 0) {
            conditions.push(buildProductLookupCondition(lookupTokens, options));
        }
    }

    return conditions.filter((condition): condition is SQL => Boolean(condition));
}

function getStorefrontProductOrderBy(
    sort: StorefrontProductSort = "newest",
    buyerPricing?: BuyerCatalogPricingProjection,
) {
    const productEffectivePrice = sql`CASE
        WHEN ${products.discountType} = 'flat' AND ${products.discountAmount} > 0 THEN MAX(${products.price} - ${products.discountAmount}, 0)
        WHEN ${products.discountPercentage} > 0 THEN ${products.price} * (1 - ${products.discountPercentage} / 100.0)
        ELSE ${products.price}
    END`;
    const effectivePriceSql = buyerPricing
        ? sql`${buyerPricing.effectivePrice}`
        : productEffectivePrice;

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
                WHEN ${buyerPricing.basePrice} > 0
                    THEN (${buyerPricing.basePrice} - ${buyerPricing.effectivePrice}) / ${buyerPricing.basePrice} * 100
                ELSE 0
            END`);
        }
        return desc(sql`CASE
            WHEN ${products.price} > 0 AND ${products.discountType} = 'flat' AND ${products.discountAmount} > 0 THEN ${products.discountAmount} / ${products.price} * 100
            WHEN ${products.discountPercentage} > 0 THEN ${products.discountPercentage}
            ELSE 0
        END`);
    }
    return desc(products.createdAt);
}

function buildAttributeProductSubquery(
    db: Database,
    attributeFilters: AttributeFilter[],
    alias: string,
) {
    if (attributeFilters.length === 0) return null;
    const filtersJson = JSON.stringify(attributeFilters);
    return db
        .select({ productId: productAttributeValues.productId })
        .from(productAttributeValues)
        .innerJoin(productAttributes, eq(productAttributeValues.attributeId, productAttributes.id))
        .where(
            and(
                eq(productAttributes.filterable, true),
                isNull(productAttributes.deletedAt),
                sql`EXISTS (
                    SELECT 1
                    FROM json_each(${filtersJson}) AS selected_filter
                    CROSS JOIN json_each(json_extract(selected_filter.value, '$.values')) AS selected_value
                    WHERE CAST(json_extract(selected_filter.value, '$.slug') AS TEXT) = ${productAttributes.slug}
                      AND CAST(selected_value.value AS TEXT) = ${productAttributeValues.value}
                )`,
            ),
        )
        .groupBy(productAttributeValues.productId)
        .having(sql`count(*) = ${attributeFilters.length}`)
        .as(alias);
}

export interface PublicProductFacetValue {
    value: string;
    count: number;
}

export interface PublicProductFacet {
    id: string;
    name: string;
    slug: string;
    values: PublicProductFacetValue[];
}

type PublicProductFacetRow = {
    id: string;
    name: string;
    slug: string;
    value: string;
    count: number;
};

function buildResultScopedFacetQuery(
    db: Database,
    buyerPricing: BuyerCatalogPricingProjection,
    baseConditions: SQL[],
    attributeFilters: AttributeFilter[],
) {
    const filtersJson = JSON.stringify(attributeFilters);
    const matchesOtherSelectedFacets = sql`NOT EXISTS (
        SELECT 1
        FROM json_each(${filtersJson}) AS selected_filter
        WHERE CAST(json_extract(selected_filter.value, '$.slug') AS TEXT) <> ${productAttributes.slug}
          AND NOT EXISTS (
              SELECT 1
              FROM product_attribute_values AS selected_product_value
              INNER JOIN product_attributes AS selected_product_attribute
                  ON selected_product_attribute.id = selected_product_value.attribute_id
              WHERE selected_product_value.product_id = ${products.id}
                AND selected_product_attribute.deleted_at IS NULL
                AND selected_product_attribute.filterable = 1
                AND selected_product_attribute.slug = CAST(json_extract(selected_filter.value, '$.slug') AS TEXT)
                AND selected_product_value.value IN (
                    SELECT CAST(value AS TEXT)
                    FROM json_each(json_extract(selected_filter.value, '$.values'))
                )
          )
    )`;

    return db
        .select({
            id: productAttributes.id,
            name: productAttributes.name,
            slug: productAttributes.slug,
            value: productAttributeValues.value,
            count: sql<number>`COUNT(DISTINCT CASE
                WHEN ${matchesOtherSelectedFacets} THEN ${products.id}
                ELSE NULL
            END)`,
        })
        .from(productAttributeValues)
        .innerJoin(
            productAttributes,
            eq(productAttributeValues.attributeId, productAttributes.id),
        )
        .innerJoin(products, eq(productAttributeValues.productId, products.id))
        .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
        .where(and(
            eq(productAttributes.filterable, true),
            isNull(productAttributes.deletedAt),
            ...baseConditions,
        ))
        .groupBy(
            productAttributes.id,
            productAttributes.name,
            productAttributes.slug,
            productAttributeValues.value,
        )
        .orderBy(productAttributes.name, productAttributeValues.value);
}

function groupResultScopedFacets(
    rows: PublicProductFacetRow[],
    selectedFilters: AttributeFilter[],
): PublicProductFacet[] {
    const facetsBySlug = new Map<string, PublicProductFacet>();
    for (const row of rows) {
        const facet = facetsBySlug.get(row.slug) ?? {
            id: row.id,
            name: row.name,
            slug: row.slug,
            values: [],
        };
        facet.values.push({ value: row.value, count: Number(row.count) || 0 });
        facetsBySlug.set(row.slug, facet);
    }

    for (const selected of selectedFilters) {
        const facet = facetsBySlug.get(selected.slug) ?? {
            id: selected.id,
            name: selected.name,
            slug: selected.slug,
            values: [],
        };
        const knownValues = new Set(facet.values.map(({ value }) => value));
        for (const value of selected.values) {
            if (!knownValues.has(value)) facet.values.push({ value, count: 0 });
        }
        facetsBySlug.set(selected.slug, facet);
    }

    return Array.from(facetsBySlug.values())
        .map((facet) => ({
            ...facet,
            values: facet.values.sort((a, b) => a.value.localeCompare(b.value)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function getPagination(page: number, limit: number, total: number) {
    return {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
    };
}

async function readPrimaryProductImageMap(
    db: Database,
    productIds: string[],
): Promise<Map<string, { mediaId: string; url: string; alt: string | null }>> {
    const mediaMap = await loadProductMediaProjections(db, productIds);
    return productImageMapFromMedia(mediaMap);
}

function productImageMapFromMedia(
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

async function readStorefrontFeedAttributeMap(
    db: Database,
    productIds: string[],
): Promise<Map<string, StorefrontFeedProductAttribute[]>> {
    if (productIds.length === 0) {
        return new Map();
    }

    const rows: Array<{
        productId: string;
        name: string;
        slug: string;
        value: string;
    }> = [];
    for (
        let offset = 0;
        offset < productIds.length;
        offset += STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE
    ) {
        const productIdChunk = productIds.slice(
            offset,
            offset + STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE,
        );
        rows.push(...await db
            .select({
                productId: productAttributeValues.productId,
                name: productAttributes.name,
                slug: productAttributes.slug,
                value: productAttributeValues.value,
            })
            .from(productAttributeValues)
            .innerJoin(
                productAttributes,
                and(
                    eq(productAttributeValues.attributeId, productAttributes.id),
                    isNull(productAttributes.deletedAt),
                ),
            )
            .where(inArray(productAttributeValues.productId, productIdChunk))
            .all());
    }

    const attributeMap = new Map<string, StorefrontFeedProductAttribute[]>();
    for (const row of rows) {
        const attributes = attributeMap.get(row.productId) ?? [];
        attributes.push({ name: row.name, slug: row.slug, value: row.value });
        attributeMap.set(row.productId, attributes);
    }

    return attributeMap;
}

async function readStorefrontFeedVariantMap(
    db: Database,
    productIds: string[],
    mediaMapPromise: Promise<Map<string, ProductMediaProjection[]>> =
        loadProductMediaProjections(db, productIds),
): Promise<Map<string, StorefrontFeedProductVariant[]>> {
    if (productIds.length === 0) {
        return new Map();
    }

    const rows: StorefrontFeedVariantRow[] = [];
    for (
        let offset = 0;
        offset < productIds.length;
        offset += STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE
    ) {
        const productIdChunk = productIds.slice(
            offset,
            offset + STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE,
        );
        rows.push(...await db
            .select({
                id: productVariants.id,
                productId: productVariants.productId,
                optionCombinationKey: productVariants.optionCombinationKey,
                imageId: productVariants.imageId,
                weight: productVariants.weight,
                sku: productVariants.sku,
                barcode: productVariants.barcode,
                barcodeType: productVariants.barcodeType,
                price: productVariants.price,
                stock: productVariants.stock,
                reservedStock: effectiveRegularReservedStockSql(),
                isDefault: productVariants.isDefault,
                trackInventory: productVariants.trackInventory,
                discountType: productVariants.discountType,
                discountPercentage: productVariants.discountPercentage,
                discountAmount: productVariants.discountAmount,
                deletedAt: sql<number | null>`CAST(${productVariants.deletedAt} AS INTEGER)`,
            })
            .from(productVariants)
            .where(and(
                inArray(productVariants.productId, productIdChunk),
                isNull(productVariants.deletedAt),
            ))
            .orderBy(productVariants.productId, productVariants.createdAt, productVariants.id)
            .all() as StorefrontFeedVariantRow[]);
    }

    const [selectedOptionMap, mediaMap] = await Promise.all([
        loadVariantSelectedOptions(db, rows.map((row) => row.id)),
        mediaMapPromise,
    ]);
    const variantMap = new Map<string, StorefrontFeedProductVariant[]>();
    for (const row of rows) {
        const resolvedImage = resolveSkuImageRepresentation(
            mediaMap.get(row.productId) ?? [],
            row.imageId,
        );
        const variant = normalizeDefaultSkuOptions({
            ...row,
            imageMediaId: resolvedImage?.mediaId ?? null,
            imageUrl: resolvedImage?.url ?? null,
            selectedOptions: selectedOptionMap.get(row.id) ?? [],
            deletedAt: row.deletedAt ? unixToDate(row.deletedAt)?.toISOString() ?? null : null,
        });
        const variants = variantMap.get(row.productId) ?? [];
        variants.push(variant);
        variantMap.set(row.productId, variants);
    }

    return variantMap;
}

// ─────────────────────────────────────────
// Storefront queries
// ─────────────────────────────────────────

type StorefrontCatalogScope = {
    condition?: SQL;
    orderBy?: SQL | ((buyerPricing: ReturnType<typeof buildBuyerCatalogPricingProjection>) => SQL);
    fixedCategory?: StorefrontCategoryProductCategory;
};

async function readStorefrontCatalogPage(
    db: Database,
    params: StorefrontProductFilterInput,
    scope: StorefrontCatalogScope = {},
) {
    const {
        page = 1,
        limit = 20,
        sort = "newest",
        attributeFilters = [],
    } = params;
    const buyerPricing = buildBuyerCatalogPricingProjection(db);
    const conditions = buildStorefrontProductConditions(db, params, {}, buyerPricing);
    const priceRangeConditions = buildStorefrontProductConditions(db, {
        ...params,
        minPrice: undefined,
        maxPrice: undefined,
    }, {}, buyerPricing);
    if (scope.condition) {
        conditions.push(scope.condition);
        priceRangeConditions.push(scope.condition);
    }
    const orderBy = typeof scope.orderBy === "function"
        ? scope.orderBy(buyerPricing)
        : scope.orderBy ?? getStorefrontProductOrderBy(sort, buyerPricing);
    const offset = (page - 1) * limit;

    let query = db
        .select({
            id: products.id,
            name: products.name,
            price: buyerPricing.basePrice,
            slug: products.slug,
            discountType: buyerPricing.discountType,
            discountPercentage: buyerPricing.discountPercentage,
            discountAmount: buyerPricing.discountAmount,
            discountedPrice: buyerPricing.effectivePrice,
            maxBuyerPrice: buyerPricing.maxBuyerPrice,
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

    let countQuery = db
        .select({ count: sql<number>`count(*)` })
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
            min: sql<number | null>`MIN(${buyerPricing.effectivePrice})`,
            max: sql<number | null>`MAX(${buyerPricing.maxBuyerPrice})`,
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
        conditions,
        attributeFilters,
    );
    const [productsList, totalCount, rawPriceRange, facetRows] = await Promise.all([
        query.orderBy(orderBy, products.id).limit(limit).offset(offset).all(),
        countQuery.get(),
        priceRangeQuery.get(),
        facetQuery.all() as Promise<PublicProductFacetRow[]>,
    ]);

    const productIds = productsList.map((product) => product.id);
    const categoryIds = scope.fixedCategory
        ? []
        : [...new Set(
            productsList
                .map((product) => product.categoryId)
                .filter((id): id is string => Boolean(id)),
        )];
    const [imageMap, categoriesData] = await Promise.all([
        readPrimaryProductImageMap(db, productIds),
        categoryIds.length > 0
            ? db
                .select({ id: categories.id, name: categories.name, slug: categories.slug })
                .from(categories)
                .where(and(
                    inArray(categories.id, categoryIds),
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
        const image = imageMap.get(product.id);
        const category = scope.fixedCategory ?? (
            product.categoryId ? categoryMap.get(product.categoryId) ?? null : null
        );
        return {
            ...product,
            categoryId: category?.id ?? null,
            hasVariants: Boolean(hasCustomerOptions),
            availableForSale: Boolean(availableForSale),
            imageUrl: image?.url ?? null,
            imageMediaId: image?.mediaId ?? null,
            imageAlt: image?.alt ?? null,
            category,
            createdAt: unixToDate(product.createdAt)?.toISOString() ?? null,
            updatedAt: unixToDate(product.updatedAt)?.toISOString() ?? null,
            priceVaries: product.maxBuyerPrice > product.discountedPrice,
        };
    });

    return {
        products: productsWithImages,
        pagination: getPagination(page, limit, totalCount?.count ?? 0),
        priceRange: {
            min: rawPriceRange?.min ?? 0,
            max: rawPriceRange?.max ?? 0,
        },
        facets: groupResultScopedFacets(facetRows, attributeFilters),
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
 * Returns a paginated feed projection for catalog exporters.
 * This keeps normal storefront listings card-light while letting feed callers
 * read attributes and SKU data in page-wide bulk queries.
 */
export async function getStorefrontFeedProducts(
    db: Database,
    params: StorefrontFeedProductFilterInput,
): Promise<StorefrontFeedProductPage> {
    const {
        page = 1,
        limit = 100,
        sort = "newest",
        cursor,
    } = params;
    if (page !== 1) {
        throw new ValidationError("Product feed page pagination is retired. Use the cursor returned by the previous response.");
    }
    if (sort !== "newest") {
        throw new ValidationError("Product feed pagination supports newest order only.");
    }
    const buyerPricing = buildBuyerCatalogPricingProjection(db);
    const feedCreatedAt = sql<number>`CAST(${products.createdAt} AS INTEGER)`;
    const conditions = buildStorefrontProductConditions(db, params, {
        includeLookupHandles: true,
        includeVariantLookups: true,
        includeCategorySearchMatches: true,
    }, buyerPricing);
    conditions.push(eq(products.excludeFromProductFeed, false));
    conditions.push(publicProductHasPrimaryDiscoveryImage());
    if (cursor) {
        const position = decodeFeedCursor(cursor);
        conditions.push(or(
            sql`${feedCreatedAt} < ${position.createdAt}`,
            and(sql`${feedCreatedAt} = ${position.createdAt}`, lt(products.id, position.id)),
        )!);
    }

    const query = db
        .select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            slug: products.slug,
            canonicalPath: products.canonicalPath,
            productCondition: products.productCondition,
            discountType: products.discountType,
            discountPercentage: products.discountPercentage,
            discountAmount: products.discountAmount,
            freeDelivery: products.freeDelivery,
            categoryId: products.categoryId,
            excludeFromProductFeed: products.excludeFromProductFeed,
            createdAt: feedCreatedAt.as("createdAt"),
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`.as("updatedAt"),
            hasCustomerOptions: buyerPricing.hasCustomerOptions,
            availableForSale: buyerPricing.availableForSale,
        })
        .from(products)
        .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
        .where(and(...conditions));

    const scannedProducts = await query
        .orderBy(desc(feedCreatedAt), desc(products.id))
        .limit(limit + 1)
        .all();
    const hasNextPage = scannedProducts.length > limit;
    const productsList = scannedProducts.slice(0, limit);
    const productIds = productsList.map((product) => product.id);
    const categoryIds = [...new Set(productsList.map((product) => product.categoryId).filter(Boolean))] as string[];
    const mediaMapPromise = loadProductMediaProjections(db, productIds);

    const [mediaMap, categoriesData, attributeMap, variantMap, optionMap] = await Promise.all([
        mediaMapPromise,
        categoryIds.length > 0
            ? db
                .select({ id: categories.id, name: categories.name, slug: categories.slug })
                .from(categories)
                .where(and(
                    inArray(categories.id, categoryIds),
                    ...publicCategoryConditions(),
                ))
                .all() as Promise<Array<{ id: string; name: string; slug: string }>>
            : Promise.resolve([] as Array<{ id: string; name: string; slug: string }>),
        readStorefrontFeedAttributeMap(db, productIds),
        readStorefrontFeedVariantMap(db, productIds, mediaMapPromise),
        loadProductOptions(db, productIds),
    ]);
    const imageMap = productImageMapFromMedia(mediaMap);
    const categoryMap = new Map(categoriesData.map((cat) => [cat.id, cat]));

    const feedProducts: StorefrontFeedProduct[] = productsList.map((product: StorefrontFeedProductListRow) => {
        const imgData = imageMap.get(product.id);
        const category = product.categoryId ? categoryMap.get(product.categoryId) ?? null : null;
        return {
            id: product.id,
            name: product.name,
            slug: product.slug,
            canonicalPath: product.canonicalPath,
            options: (optionMap.get(product.id) ?? []).map(({ values: _values, ...option }) => option),
            description: product.description,
            price: product.price,
            discountType: product.discountType,
            discountPercentage: product.discountPercentage,
            discountAmount: product.discountAmount,
            discountedPrice: calculateDiscountedPrice(
                product.price,
                product.discountType,
                product.discountPercentage,
                product.discountAmount,
            ),
            freeDelivery: product.freeDelivery,
            categoryId: category?.id ?? null,
            excludeFromProductFeed: Boolean(product.excludeFromProductFeed),
            productCondition: product.productCondition,
            hasVariants: Boolean(product.hasCustomerOptions),
            availableForSale: Boolean(product.availableForSale),
            imageUrl: imgData?.url || null,
            imageMediaId: imgData?.mediaId ?? null,
            imageAlt: imgData?.alt || null,
            category,
            attributes: attributeMap.get(product.id) ?? [],
            variants: variantMap.get(product.id) ?? [],
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
        };
    });

    return {
        products: feedProducts,
        pagination: {
            limit,
            hasNextPage,
            ...(hasNextPage && productsList.length > 0
                ? { cursor: encodeFeedCursor(productsList[productsList.length - 1]!) }
                : {}),
        },
    };
}

export async function getStorefrontSitemapProducts(
    db: Database,
    params: Pick<StorefrontProductFilterInput, "page" | "limit">,
) {
    const {
        page = 1,
        limit = 100,
    } = params;
    const conditions = [
        ...buildStorefrontProductConditions(db, {}),
        eq(products.noIndex, false),
        eq(products.excludeFromSitemap, false),
    ];
    const offset = (page - 1) * limit;

    const [productsList, totalCount] = await Promise.all([
        db
            .select({
                slug: products.slug,
                canonicalPath: products.canonicalPath,
                updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`.as("updatedAt"),
            })
            .from(products)
            .where(and(...conditions))
            .orderBy(desc(products.createdAt), products.id)
            .limit(limit)
            .offset(offset)
            .all() as Promise<StorefrontSitemapProductRow[]>,
        db
            .select({ count: sql<number>`count(*)` })
            .from(products)
            .where(and(...conditions))
            .get(),
    ]);

    return {
        products: productsList.map((product) => ({
            slug: product.slug,
            canonicalPath: product.canonicalPath,
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
        })),
        pagination: getPagination(page, limit, totalCount?.count || 0),
    };
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
) {
    return readStorefrontCatalogPage(db, params, {
        condition: eq(products.categoryId, category.id),
        fixedCategory: category,
    });
}

export async function getStorefrontCollectionProducts(
    db: Database,
    membership: { productIds?: string[]; categoryIds?: string[] },
    params: StorefrontProductFilterInput,
) {
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
    const membershipCondition = membershipEntries.length > 0
        ? sql`EXISTS (
            SELECT 1
            FROM json_each(${membershipJson}) AS collection_membership
            WHERE (
                json_extract(collection_membership.value, '$.kind') = 'product'
                AND json_extract(collection_membership.value, '$.id') = ${products.id}
            ) OR (
                json_extract(collection_membership.value, '$.kind') = 'category'
                AND json_extract(collection_membership.value, '$.id') = ${products.categoryId}
                AND ${publishedCategoryIdExists(products.categoryId)}
            )
        )`
        : sql`0 = 1`;

    return readStorefrontCatalogPage(db, params, {
        condition: membershipCondition,
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

/**
 * Returns full storefront product details (variants, images, attributes, related products)
 * for a single product identified by slug.
 */
export async function getStorefrontProductBySlug(db: Database, slug: string) {
    const productRow = await db
        .select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            categoryId: products.categoryId,
            slug: products.slug,
            metaTitle: products.metaTitle,
            metaDescription: products.metaDescription,
            canonicalPath: products.canonicalPath,
            productCondition: products.productCondition,
            noIndex: products.noIndex,
            discountType: products.discountType,
            discountPercentage: products.discountPercentage,
            discountAmount: products.discountAmount,
            freeDelivery: products.freeDelivery,
            isActive: products.isActive,
            deletedAt: sql<number | null>`CAST(${products.deletedAt} AS INTEGER)`,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`,
            category: {
                id: categories.id,
                name: categories.name,
                slug: categories.slug,
                description: categories.description,
                imageUrl: categories.imageUrl,
                metaTitle: categories.metaTitle,
                metaDescription: categories.metaDescription,
                canonicalPath: categories.canonicalPath,
                noIndex: categories.noIndex,
                excludeFromSitemap: categories.excludeFromSitemap,
            },
        })
        .from(products)
        .leftJoin(categories, and(
            eq(products.categoryId, categories.id),
            ...publicCategoryConditions(),
        ))
        .where(and(
            eq(products.slug, slug),
            eq(products.isActive, true),
            isNull(products.deletedAt),
            publicProductHasBuyerResolvableSku(),
        ))
        .get();

    if (!productRow) return null;
    const { category, ...product } = productRow;
    const buyerPricing = buildBuyerCatalogPricingProjection(db);
    const mediaMapPromise = loadProductMediaProjections(db, [product.id]);

    const promises: Promise<{ type: string; data: unknown }>[] = [
        mediaMapPromise.then((mediaMap) => ({
            type: "media",
            data: mediaMap.get(product.id) ?? [],
        })),

        db.select({
            id: productVariants.id,
            productId: productVariants.productId,
            optionCombinationKey: productVariants.optionCombinationKey,
            imageId: productVariants.imageId,
            weight: productVariants.weight,
            sku: productVariants.sku,
            price: productVariants.price,
            stock: productVariants.stock,
            reservedStock: effectiveRegularReservedStockSql(),
            isDefault: productVariants.isDefault,
            trackInventory: productVariants.trackInventory,
            lowStockThreshold: productVariants.lowStockThreshold,
            barcode: productVariants.barcode,
            barcodeType: productVariants.barcodeType,
            discountType: productVariants.discountType,
            discountPercentage: productVariants.discountPercentage,
            discountAmount: productVariants.discountAmount,
            createdAt: sql<number>`CAST(${productVariants.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${productVariants.updatedAt} AS INTEGER)`,
            deletedAt: sql<number | null>`CAST(${productVariants.deletedAt} AS INTEGER)`,
        }).from(productVariants)
            .where(and(eq(productVariants.productId, product.id), isNull(productVariants.deletedAt)))
            .orderBy(productVariants.createdAt, productVariants.id)
            .all().then((res) => ({ type: "variants", data: res })),

        db.select({
            id: productRichContent.id,
            title: productRichContent.title,
            content: productRichContent.content,
        }).from(productRichContent).where(eq(productRichContent.productId, product.id))
            .orderBy(productRichContent.sortOrder).then((res: Array<{ id: string; title: string; content: string }>) => ({ type: "additionalInfo", data: res })),

        db.select({
            name: productAttributes.name,
            value: productAttributeValues.value,
            slug: productAttributes.slug,
        }).from(productAttributeValues)
            .innerJoin(productAttributes, and(
                eq(productAttributeValues.attributeId, productAttributes.id),
                isNull(productAttributes.deletedAt),
            ))
            .where(eq(productAttributeValues.productId, product.id))
            .then((res: Array<{ name: string; value: string; slug: string }>) => ({ type: "attributes", data: res })),
    ];

    if (product.categoryId) {
        promises.push(
            (async () => {
                const relatedProds = await db.select({
                    id: products.id, name: products.name, price: buyerPricing.basePrice,
                    slug: products.slug, discountType: buyerPricing.discountType,
                    discountPercentage: buyerPricing.discountPercentage,
                    discountAmount: buyerPricing.discountAmount,
                    discountedPrice: buyerPricing.effectivePrice,
                    maxBuyerPrice: buyerPricing.maxBuyerPrice,
                    hasVariants: buyerPricing.hasCustomerOptions,
                    availableForSale: buyerPricing.availableForSale,
                    freeDelivery: products.freeDelivery,
                }).from(products)
                    .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
                    .where(and(
                        eq(products.categoryId, product.categoryId!),
                        eq(products.isActive, true),
                        isNull(products.deletedAt),
                        publicProductHasBuyerResolvableSku(),
                        sql`${products.id} != ${product.id}`,
                    )).limit(6).all();

                if (relatedProds.length === 0) return { type: "relatedProducts", data: [] };

                const relatedIds = relatedProds.map((p) => p.id);
                const relatedImageMap = await readPrimaryProductImageMap(db, relatedIds);

                return {
                    type: "relatedProducts",
                    data: relatedProds.map(({ maxBuyerPrice, ...rp }) => {
                        const imgData = relatedImageMap.get(rp.id);
                        return {
                            ...rp,
                            hasVariants: Boolean(rp.hasVariants),
                            availableForSale: Boolean(rp.availableForSale),
                            priceVaries: maxBuyerPrice > rp.discountedPrice,
                            imageUrl: imgData?.url || null,
                            imageMediaId: imgData?.mediaId ?? null,
                            imageAlt: imgData?.alt || null,
                        };
                    }),
                };
            })(),
        );
    }

    const results = await Promise.all(promises);

    const mediaItems = (results.find((r) => r.type === "media")?.data as ProductMediaProjection[]) || [];
    const variants = (results.find((r) => r.type === "variants")?.data as unknown[]) || [];
    const additionalInfo = (results.find((r) => r.type === "additionalInfo")?.data as unknown[]) || [];
    const relatedProducts = (results.find((r) => r.type === "relatedProducts")?.data as unknown[]) || [];
    const attributes = (results.find((r) => r.type === "attributes")?.data as unknown[]) || [];

    interface VariantResult { id: string; productId: string; optionCombinationKey: string | null; imageId: string | null; weight: number | null; sku: string; price: number; stock: number; reservedStock: number; isDefault: boolean; trackInventory: boolean; lowStockThreshold: number | null; barcode: string | null; barcodeType: string | null; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; createdAt: number; updatedAt: number; deletedAt: number | null; }
    const typedVariants = variants as VariantResult[];
    const productImage = resolveProductImageRepresentation(mediaItems);
    const publicMedia = mediaItems.map((item) => ({
        id: item.id,
        mediaId: item.mediaId,
        kind: item.kind,
        url: item.url,
        posterMediaId: item.posterMediaId,
        posterUrl: item.posterUrl,
        altText: item.altText,
        caption: item.caption,
        width: item.width,
        height: item.height,
        durationMs: item.durationMs,
        isPrimary: item.isPrimary,
        sortOrder: item.sortOrder,
        status: item.status,
    }));
    const hasVariants = typedVariants.some((variant) =>
        variant.isDefault !== true && Boolean(variant.optionCombinationKey?.trim()),
    );

    const [optionMap, selectedOptionMap] = await Promise.all([
        loadProductOptions(db, [product.id]),
        loadVariantSelectedOptions(db, typedVariants.map((variant) => variant.id)),
    ]);
    const formattedVariants = typedVariants.map((variant) => {
        const v = normalizeDefaultSkuOptions(variant);
        const variantImage = resolveSkuImageRepresentation(mediaItems, v.imageId);
        return {
            ...v,
            imageUrl: variantImage?.url ?? null,
            imageMediaId: variantImage?.mediaId ?? null,
            selectedOptions: selectedOptionMap.get(variant.id) ?? [],
            createdAt: unixToDate(v.createdAt)?.toISOString() || null,
            updatedAt: unixToDate(v.updatedAt)?.toISOString() || null,
            deletedAt: v.deletedAt ? unixToDate(v.deletedAt)?.toISOString() : null,
        };
    });
    return {
        product: {
            ...product,
            categoryId: category ? product.categoryId : null,
            hasVariants,
            imageUrl: productImage?.url ?? null,
            imageMediaId: productImage?.mediaId ?? null,
            imageAlt: productImage?.altText ?? null,
            createdAt: unixToDate(product.createdAt)?.toISOString() || null,
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
            deletedAt: product.deletedAt ? unixToDate(product.deletedAt)?.toISOString() : null,
            options: optionMap.get(product.id) ?? [],
            discountType: product.discountType || "percentage",
            discountPercentage: product.discountPercentage || 0,
            discountAmount: product.discountAmount || 0,
            freeDelivery: product.freeDelivery || false,
            features: extractFeatures(product.description),
            discountedPrice: calculateDiscountedPrice(
                product.price, product.discountType,
                product.discountPercentage, product.discountAmount,
            ),
            attributes,
            additionalInfo,
        },
        category,
        media: publicMedia,
        variants: formattedVariants,
        relatedProducts,
    };
}

// ─────────────────────────────────────────
// Storefront search (variant-aware)
// ─────────────────────────────────────────

type StorefrontSearchProductVariant = {
    id: string;
    productId: string;
    optionCombinationKey: string | null;
    imageId: string | null;
    selectedOptions: SelectedProductOption[];
    weight: number | null;
    sku: string;
    price: number;
    stock: number;
    reservedStock: number;
    isDefault: boolean;
    trackInventory: boolean;
    discountType: string | null;
    discountPercentage: number | null;
    discountAmount: number | null;
};

async function readStorefrontSearchVariantMap(
    db: Database,
    productIds: string[],
): Promise<Map<string, StorefrontSearchProductVariant[]>> {
    const variantMap = new Map<string, StorefrontSearchProductVariant[]>();
    for (
        let offset = 0;
        offset < productIds.length;
        offset += STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE
    ) {
        const productIdChunk = productIds.slice(
            offset,
            offset + STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE,
        );
        const rows = await db
            .select({
                id: productVariants.id,
                productId: productVariants.productId,
                optionCombinationKey: productVariants.optionCombinationKey,
                imageId: productVariants.imageId,
                weight: productVariants.weight,
                sku: productVariants.sku,
                price: productVariants.price,
                stock: productVariants.stock,
                reservedStock: effectiveRegularReservedStockSql(),
                isDefault: productVariants.isDefault,
                trackInventory: productVariants.trackInventory,
                discountType: productVariants.discountType,
                discountPercentage: productVariants.discountPercentage,
                discountAmount: productVariants.discountAmount,
            })
            .from(productVariants)
            .where(and(
                inArray(productVariants.productId, productIdChunk),
                isNull(productVariants.deletedAt),
            ))
            .orderBy(productVariants.productId, productVariants.createdAt, productVariants.id)
            .all();

        const selectedOptionMap = await loadVariantSelectedOptions(db, rows.map((row) => row.id));
        for (const row of rows) {
            const variants = variantMap.get(row.productId) ?? [];
            variants.push(normalizeDefaultSkuOptions({
                ...row,
                selectedOptions: selectedOptionMap.get(row.id) ?? [],
            }));
            variantMap.set(row.productId, variants);
        }
    }
    return variantMap;
}

/**
 * Lightweight variant-aware product search for cart/checkout use.
 * Returns products with their variants and primary image URL.
 */
export async function searchStorefrontProducts(
    db: Database,
    params: { search: string; page: number; limit: number },
) {
    const { search, page, limit } = params;
    const offset = (page - 1) * limit;

    const conditions: SQL[] = publicProductBaseConditions();
    const searchCondition = search ? ftsMatch(db, "products_fts", "products", search) : null;
    if (search) {
        conditions.push(searchCondition ?? sql`0 = 1`);
    }

    const [results, countResults] = await Promise.all([
        db
            .select({
                id: products.id,
                name: products.name,
                price: products.price,
                slug: products.slug,
                discountType: products.discountType,
                discountPercentage: products.discountPercentage,
                discountAmount: products.discountAmount,
                freeDelivery: products.freeDelivery,
            })
            .from(products)
            .where(and(...conditions))
            .orderBy(desc(products.updatedAt))
            .limit(limit)
            .offset(offset)
            .all() as Promise<Array<{ id: string; name: string; price: number; slug: string; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; freeDelivery: boolean }>>,
        db
            .select({ count: sql<number>`count(*)` })
            .from(products)
            .where(and(...conditions)),
    ]);

    const productIds = results.map((p) => p.id);
    const count = Number((countResults[0] as { count: number } | undefined)?.count ?? 0);
    const totalPages = Math.ceil(count / limit);

    const [imageMap, variantMap] = await Promise.all([
        readPrimaryProductImageMap(db, productIds),
        readStorefrontSearchVariantMap(db, productIds),
    ]);

    return {
        data: results.map((product) => {
            const imgData = imageMap.get(product.id);
            return {
                ...product,
                imageUrl: imgData?.url || null,
                imageMediaId: imgData?.mediaId ?? null,
                imageAlt: imgData?.alt || null,
                variants: variantMap.get(product.id) ?? [],
            };
        }),
        pagination: {
            page,
            limit,
            total: count,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
        },
    };
}
