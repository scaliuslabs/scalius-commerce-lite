// src/modules/catalog/collections.ts
// Buyer-facing collection reads: a collection's page catalog and its
// product cards, the batched collection-product resolvers storefront sections
// use, the public collection directory and sitemap entries, and the
// dashboard's collection product picker, which shows the same buyer-visible
// facts. Collection records, their membership config and admin writes live
// in modules/collections.

import { collections, products, categories, productVariants } from "@scalius/database/schema";
import { sql, and, isNull, eq, inArray, asc, desc, max, getTableColumns, type SQL } from "drizzle-orm";
import { safeBatch, type Database } from "@scalius/database/client";
import { fromMinor } from "@scalius/shared/money";
import { categoryScope } from "@scalius/shared/cache-deps";
import { deps } from "../../cache-deps";
import { ftsMatch } from "../../search/fts5";
import { collectionMembershipForConfig, normalizeCollectionConfig } from "../collections";
import {
  buildBuyerCatalogPricingProjection,
  buyerPriceRangeColumns,
  loadProductMediaProjections,
  presentBuyerPriceRange,
  type ProductMediaProjectionRow,
  publicCollectionProductConditions,
  resolveProductImageRepresentation,
  resolveProductMediaProjectionRows,
  selectProductMediaProjectionRows,
  type StorefrontProductFilterInput,
} from "../products";
import { storeCurrencyCodeSql, storeDecimalPlacesFromCode } from "../settings";
import { marketPriceContextOf, priceProductCards, type MarketPricing } from "../price-lists";
import { publicCategoryConditions, publishedCategoryIdExists } from "../categories";
import {
  presentStorefrontCustomFields,
  selectStorefrontCustomFieldRows,
  type StorefrontCustomFieldRow,
} from "../custom-fields";
import { getStorefrontCollectionProducts, storefrontCollectionVisibleCountQuery } from "./listing";
import { resolveProductCardFacts, selectProductCardFactRows, type ProductCardFactRow } from "./card-facts";
import {
    buildCollectionProductSelect,
    resolveProductCards,
    type RawProduct,
    type ResolvedProduct,
} from "./cards";
import { declareProductCards, declareRequestedProducts } from "./declare-deps";
import {
    translationScopeOf,
    NAME_FIELDS,
    translateRow,
    translateRows,
    translationColumns,
    type TranslationScope,
} from "../translations";

/** A collection's translated text (MARKETS-DESIGN D9). */
const COLLECTION_FIELDS = { name: "name", description: "description", content: "content", metaTitle: "metaTitle", metaDescription: "metaDescription" } as const;

/**
 * What a collection's product set depends on beyond the cards shown: a
 * manual collection's every configured member (a hidden one shows once it is
 * public again) and a dynamic one's categories (membership, newest order and
 * published state). The collection row itself is declared by its reader.
 *
 * `shown`: a curated list that shows the first public members in configured
 * order, up to its limit. Once the limit is reached, members after the last
 * shown one cannot enter unless one before them changes (their own keys), so
 * only the members up to that point are declared.
 */
function declareCollectionMembership(
    config: unknown,
    shown?: { productIds: readonly string[]; limit: number },
): void {
    if (!deps.active()) return;
    const cfg = normalizeCollectionConfig(config);
    const membership = collectionMembershipForConfig(cfg);
    let members = membership.productIds;
    if (shown && shown.productIds.length >= shown.limit && shown.productIds.length > 0) {
        const last = members.indexOf(shown.productIds[shown.productIds.length - 1]!);
        if (last !== -1) members = members.slice(0, last + 1);
    }
    declareRequestedProducts(members);
    for (const categoryId of membership.categoryIds) {
        deps.listMembership(categoryScope(categoryId));
        deps.category(categoryId);
    }
    if (cfg.featuredProductId) declareRequestedProducts([cfg.featuredProductId]);
}

const COLLECTION_PRODUCT_OPTION_CATEGORY_LIMIT = 90;

export interface CollectionProductOptionsInput {
    page?: number;
    limit?: number;
    search?: string;
    categoryIds?: string[];
    selectedProductIds?: string[];
}

/**
 * Lightweight, paginated product lookup for the collection builder.
 * With categories, `visibleOnline` is how many of their products buyers see
 * (the storefront collection's own count, whatever the search); `total`
 * also counts drafts.
 *
 * Category IDs are deliberately capped below D1's 100-bound-parameter limit.
 * Selected product IDs use one bound json_each() set so the query can sort
 * committed rows last without spending another 90 parameters.
 */
export async function listCollectionProductOptions(
    db: Database,
    input: CollectionProductOptionsInput = {},
) {
    const page = Math.max(1, Math.trunc(input.page ?? 1));
    const limit = Math.min(20, Math.max(1, Math.trunc(input.limit ?? 10)));
    const search = input.search?.trim().slice(0, 100) ?? "";
    const categoryIds = Array.from(
        new Set((input.categoryIds ?? []).map((id) => id.trim()).filter(Boolean)),
    ).slice(0, COLLECTION_PRODUCT_OPTION_CATEGORY_LIMIT);
    const selectedProductIds = Array.from(
        new Set((input.selectedProductIds ?? []).map((id) => id.trim()).filter(Boolean)),
    ).slice(0, COLLECTION_PRODUCT_OPTION_CATEGORY_LIMIT);
    const selectedProductIdSet = JSON.stringify(selectedProductIds);
    const offset = (page - 1) * limit;

    const whereConditions: SQL[] = [isNull(products.deletedAt)];
    const searchCondition = search
        ? ftsMatch(db, "products_fts", "products", search)
        : undefined;
    if (searchCondition) whereConditions.push(searchCondition);
    if (categoryIds.length > 0) {
        whereConditions.push(inArray(products.categoryId, categoryIds));
    }
    const whereClause = and(...whereConditions);

    const countQuery = db
        .select({ count: sql<number>`count(*)`, storeCurrencyCode: storeCurrencyCodeSql() })
        .from(products)
        .where(whereClause);
    const optionsQuery = db
        .select({
            id: products.id,
            name: products.name,
            priceMinor: products.priceMinor,
            categoryId: products.categoryId,
            categoryName: sql<string | null>`${categories.name}`.as(
                "collection_product_category_name",
            ),
            isActive: products.isActive,
            // Optioned SKUs only: a simple product's one hidden SKU is not a variant.
            variantCount: sql<number>`(
                SELECT count(*) FROM ${productVariants}
                WHERE ${productVariants.productId} = ${products.id}
                  AND ${productVariants.deletedAt} IS NULL
                  AND ${productVariants.isDefault} = 0
            )`.as("collection_product_variant_count"),
            // Sellable now across tracked SKUs; null when no SKU tracks stock.
            available: sql<number | null>`(
                SELECT sum(max(${productVariants.stock} - ${productVariants.reservedStock}, 0))
                FROM ${productVariants}
                WHERE ${productVariants.productId} = ${products.id}
                  AND ${productVariants.deletedAt} IS NULL
                  AND ${productVariants.trackInventory} = 1
            )`.as("collection_product_available"),
        })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(whereClause)
        .orderBy(
            ...(selectedProductIds.length > 0
                ? [asc(sql<number>`CASE WHEN ${products.id} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${selectedProductIdSet})
                ) THEN 1 ELSE 0 END`)]
                : []),
            // Searches read A-Z; an open picker starts with the newest products.
            ...(search ? [asc(products.name)] : [desc(products.createdAt)]),
            asc(products.id),
        )
        .limit(limit)
        .offset(offset);

    const [countRows = [], productOptions = [], visibleRows = []] = await (safeBatch(db, [
        countQuery,
        optionsQuery,
        ...(categoryIds.length > 0 ? [storefrontCollectionVisibleCountQuery(db, { categoryIds })] : []),
    ]) as unknown as Promise<[
        Array<{ count: number; storeCurrencyCode: string | null }>,
        Array<{
            id: string;
            name: string;
            priceMinor: number;
            categoryId: string | null;
            categoryName: string | null;
            isActive: boolean;
            variantCount: number;
            available: number | null;
        }>,
        Array<{ count: number }>?,
    ]>);
    const total = Number(countRows[0]?.count ?? 0);
    const decimalPlaces = storeDecimalPlacesFromCode(countRows[0]?.storeCurrencyCode);
    const pageIds = productOptions.map((product) => product.id);
    // Buyer pricing for the page only; joined into the page query it ranked
    // every SKU in the store to price ten picker rows.
    const pagePricing = buildBuyerCatalogPricingProjection(db, {
        productScope: sql`${products.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(pageIds)}))`,
    });
    const [mediaMap, pricingRows] = pageIds.length > 0
        ? await Promise.all([
            loadProductMediaProjections(db, pageIds),
            db.select({ productId: pagePricing.productId, ...buyerPriceRangeColumns(pagePricing) }).from(pagePricing).all(),
        ])
        : [new Map(), []];
    const pricingByProduct = new Map(pricingRows.map((row) => [row.productId, row]));

    return {
        products: productOptions.map(({ priceMinor, variantCount, available, ...product }) => ({
            ...product,
            variantCount: Number(variantCount ?? 0),
            available: available == null ? null : Number(available),
            price: fromMinor(priceMinor, decimalPlaces),
            priceRange: presentBuyerPriceRange(
                pricingByProduct.get(product.id) ?? { buyerFromMinor: null, buyerToMinor: null, buyerBaseMinor: null },
                decimalPlaces,
            ),
            primaryImage:
                resolveProductImageRepresentation(mediaMap.get(product.id) ?? [])?.url ?? null,
        })),
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
        visibleOnline: categoryIds.length > 0 ? Number(visibleRows[0]?.count ?? 0) : null,
    };
}

// ─────────────────────────────────────────
// Storefront: XML discovery
// ─────────────────────────────────────────

/** Collection URLs one sitemap document lists at most (the sitemap protocol allows 50k). */
export const COLLECTION_SITEMAP_LIMIT = 5000;

/**
 * Collection pages for XML discovery: active, live, not `noIndex` and not
 * `excludeFromSitemap`, filtered before the limit (never after a page read).
 * `updatedAt` is the row's own last change, the page's lastmod.
 */
export async function getPublicCollectionSitemapEntries(db: Database) {
    deps.anyCollection();
    // Sitemap lastmod: a write that changes only updated_at advances the
    // discovery key (cache-deps registry), not a collection key.
    deps.discoveryMembership();
    const rows = await db
        .select({
            id: collections.id,
            canonicalPath: collections.canonicalPath,
            updatedAt: sql<number | null>`CAST(COALESCE(${collections.updatedAt}, ${collections.createdAt}) AS INTEGER)`,
        })
        .from(collections)
        .where(and(
            eq(collections.isActive, true),
            isNull(collections.deletedAt),
            eq(collections.noIndex, false),
            eq(collections.excludeFromSitemap, false),
        ))
        .orderBy(asc(collections.sortOrder), asc(collections.id))
        .limit(COLLECTION_SITEMAP_LIMIT)
        .all();
    return rows.map((row) => ({
        id: row.id,
        canonicalPath: row.canonicalPath,
        updatedAt: row.updatedAt ? new Date(Number(row.updatedAt) * 1000).toISOString() : null,
    }));
}

// ─────────────────────────────────────────
// Storefront: product resolution
// ─────────────────────────────────────────

export async function getPublicCollectionCatalog(
    db: Database,
    id: string,
    params: StorefrontProductFilterInput,
    pricing: MarketPricing | null = null,
) {
    // The row (found or not: a collection can be activated or restored).
    if (/^[\x21-\x7e]{1,200}$/.test(id)) deps.collection(id);
    // A presence page's collection, cards and categories in its language.
    const translation = translationScopeOf(pricing);
    // The row and its storefront-visible custom fields: one round trip.
    const [collectionRows, customFieldRows] = await db.batch([
        db
            .select({ ...getTableColumns(collections), ...translationColumns(translation, "collection", collections.id, { slug: false }) })
            .from(collections)
            .where(and(
                eq(collections.id, id),
                eq(collections.isActive, true),
                isNull(collections.deletedAt),
            ))
            .limit(1),
        selectStorefrontCustomFieldRows(db, "collection", id),
    ] as never) as unknown as [Array<typeof collections.$inferSelect & { trRows?: string | null }>, StorefrontCustomFieldRow[]];
    const collection = translateRow(translation, "collection", collectionRows[0], COLLECTION_FIELDS);
    if (!collection) return null;

    const config = normalizeCollectionConfig(collection.config);
    declareCollectionMembership(config);
    const membership = collectionMembershipForConfig(config);
    const buyerPricing = buildBuyerCatalogPricingProjection(db, {
        productScope: eq(products.id, config.featuredProductId ?? ""),
    });
    const categoryIdsJson = JSON.stringify(membership.categoryIds);
    const categoryPromise: Promise<Array<{ id: string; name: string; slug: string }>> =
        membership.categoryIds.length > 0
            ? db
                .select({ id: categories.id, name: categories.name, slug: categories.slug, ...translationColumns(translation, "category", categories.id) })
                .from(categories)
                .where(and(
                    sql`${categories.id} IN (
                        SELECT CAST(value AS TEXT) FROM json_each(${categoryIdsJson})
                    )`,
                    ...publicCategoryConditions(),
                ))
                .all()
                .then((rows) => translateRows(translation, "category", rows, NAME_FIELDS))
            : Promise.resolve([]);
    const catalogPromise = getStorefrontCollectionProducts(db, {
        productIds: membership.productIds,
        categoryIds: membership.categoryIds,
    }, params, pricing);
    const featuredPromise: Promise<RawProduct[]> = config.featuredProductId
            ? db
                .select(buildCollectionProductSelect(buyerPricing, translation))
                .from(products)
                .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
                .where(and(
                    ...publicCollectionProductConditions(
                        eq(products.id, config.featuredProductId),
                    ),
                ))
                .limit(1)
                .all() as Promise<RawProduct[]>
            : Promise.resolve([]);
    const [categoryRows, featuredRows, catalog] = await Promise.all([
        categoryPromise,
        featuredPromise,
        catalogPromise,
    ]);
    const categoryById = new Map(categoryRows.map((category) => [category.id, category]));
    const featuredProducts = await enrichProductsWithMedia(
        db,
        await priceProductCards(db, await marketPriceContextOf(pricing), featuredRows),
        translation,
    );

    return {
        collection: { ...collection, config, customFields: presentStorefrontCustomFields(customFieldRows) },
        categories: membership.categoryIds
            .map((categoryId) => categoryById.get(categoryId))
            .filter((category): category is { id: string; name: string; slug: string } => (
                category !== undefined
            )),
        ...catalog,
        featuredProduct: featuredRows[0]
            ? featuredProducts.get(featuredRows[0].id) ?? null
            : null,
    };
}

async function enrichProductsWithMedia(
    db: Database,
    rows: readonly RawProduct[],
    translation: TranslationScope | null,
): Promise<Map<string, ResolvedProduct>> {
    const mediaByProduct = await loadProductMediaProjections(db, rows.map((row) => row.id));
    declareProductCards(rows.map((row) => row.id), mediaByProduct);
    return resolveProductCards(rows, mediaByProduct, undefined, translation);
}

export interface CollectionProductResult {
    products: ResolvedProduct[];
    categories: { id: string; name: string; slug: string }[];
    featuredProduct: ResolvedProduct | null;
}

type BatchStatement = Parameters<typeof safeBatch>[1][number];

export interface CollectionProductsRequest {
    /** The result's key (a collection id, or a homepage list's key). */
    key: string;
    config: unknown;
    /** Products to show; the collection's own `maxProducts` when left out. */
    maxProducts?: number;
}

/**
 * Statements for one D1 batch and how to read their results: every
 * collection's products (pinned list, newest per member category, the
 * featured product), the member categories, and **the card media of exactly
 * those products** (each media statement selects its products with the
 * same conditions, order and limit as its product statement). The caller
 * can put these in a batch with its own reads, so collection cards cost one
 * round trip with no dependent media wave.
 */
export function planCollectionProducts(
    db: Database,
    requests: readonly CollectionProductsRequest[],
    /** A presence read's language: cards and categories folded in its translations (none at the root). */
    translation: TranslationScope | null = null,
): {
    statements: BatchStatement[];
    /** The statements whose rows are cards (`priceCardRowsInResults`). */
    productRowSlots: number[];
    /** `presentShopAmount`: a shop-currency fee in the page market's currency (none at the root). */
    resolve(results: readonly unknown[], presentShopAmount?: (shopMinor: number) => number): Map<string, CollectionProductResult>;
} {
    const allProductIds = new Set<string>();
    const categoryProductLimitsById = new Map<string, number>();
    const allFeaturedIds = new Set<string>();
    const maxProductsOf = (request: CollectionProductsRequest, cfg: ReturnType<typeof normalizeCollectionConfig>) =>
        Math.min(Math.max(request.maxProducts ?? (cfg.maxProducts || 8), 1), 36);

    for (const request of requests) {
        const cfg = normalizeCollectionConfig(request.config);
        const membership = collectionMembershipForConfig(cfg);
        membership.productIds.forEach((id) => allProductIds.add(id));
        if (membership.source === "dynamic") {
            membership.categoryIds.forEach((id) => {
                categoryProductLimitsById.set(
                    id,
                    Math.max(categoryProductLimitsById.get(id) ?? 0, maxProductsOf(request, cfg)),
                );
            });
        }
        if (cfg.featuredProductId) allFeaturedIds.add(cfg.featuredProductId);
    }

    const productIdsArr = Array.from(allProductIds);
    const categoryProductLimits = Array.from(
        categoryProductLimitsById.entries(),
        ([categoryId, maxProducts]) => ({ categoryId, maxProducts }),
    );
    const categoryIdsArr = categoryProductLimits.map(({ categoryId }) => categoryId);
    const featuredIdsArr = Array.from(allFeaturedIds);
    // One pricing projection per statement, scoped to that statement's
    // products: an unscoped one ranked every SKU in the store once per
    // homepage category (30 statements, 9 s of D1 time at 30k products).
    const pricingFor = (productScope: SQL) => buildBuyerCatalogPricingProjection(db, { productScope });
    const idSetCondition = (ids: string[]) => sql`${products.id} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)})
                )`;

    const statements: BatchStatement[] = [];
    const productSlots: number[] = [];
    const mediaSlots: number[] = [];
    const factSlots: number[] = [];
    const push = (statement: BatchStatement) => statements.push(statement) - 1;
    /**
     * A product statement and the media statement of the same rows. Eligible
     * products always have a buyer pricing row, so the id query can skip the
     * pricing projection and still select exactly the product statement's rows.
     */
    const productList = (scope: SQL, conditions: SQL[], order?: { limit: number }) => {
        const pricing = pricingFor(scope);
        const rows = db.select(buildCollectionProductSelect(pricing, translation)).from(products)
            .innerJoin(pricing, eq(products.id, pricing.productId))
            .where(and(...conditions));
        const ids = db.select({ id: products.id }).from(products).where(and(...conditions));
        productSlots.push(push(order
            ? rows.orderBy(desc(products.createdAt), asc(products.id)).limit(order.limit)
            : rows));
        const scopedIds = order
            ? ids.orderBy(desc(products.createdAt), asc(products.id)).limit(order.limit)
            : ids;
        mediaSlots.push(push(selectProductMediaProjectionRows(db, scopedIds)));
        factSlots.push(push(selectProductCardFactRows(db, scopedIds)));
        return productSlots.length - 1;
    };

    const pinnedList = productIdsArr.length > 0
        ? productList(idSetCondition(productIdsArr), publicCollectionProductConditions(idSetCondition(productIdsArr)))
        : null;
    const categoryLists = categoryProductLimits.map(({ categoryId, maxProducts }) => productList(eq(products.categoryId, categoryId), [
        ...publicCollectionProductConditions(eq(products.categoryId, categoryId)),
        publishedCategoryIdExists(products.categoryId),
    ], { limit: maxProducts }));
    const featuredList = featuredIdsArr.length > 0
        ? productList(idSetCondition(featuredIdsArr), publicCollectionProductConditions(idSetCondition(featuredIdsArr)))
        : null;
    const categoryMetadataSlot = categoryIdsArr.length > 0
        ? push(db.select({ id: categories.id, name: categories.name, slug: categories.slug, ...translationColumns(translation, "category", categories.id) }).from(categories).where(and(
            sql`${categories.id} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(categoryIdsArr)})
                )`,
            ...publicCategoryConditions(),
        )))
        : null;

    return {
        statements,
        productRowSlots: productSlots,
        resolve(results, presentShopAmount) {
            const rowsOf = (list: number | null) =>
                list === null ? [] : results[productSlots[list]!] as RawProduct[];
            const mediaRows = mediaSlots.flatMap((slot) => results[slot] as ProductMediaProjectionRow[]);
            const allRows = [...rowsOf(pinnedList), ...categoryLists.flatMap(rowsOf), ...rowsOf(featuredList)];
            const mediaByProduct = resolveProductMediaProjectionRows(mediaRows);
            const resolvedProductsById = resolveProductCards(
                allRows,
                mediaByProduct,
                resolveProductCardFacts(
                    factSlots.flatMap((slot) => results[slot] as ProductCardFactRow[]),
                    storeDecimalPlacesFromCode(allRows[0]?.storeCurrencyCode),
                    new Set(allRows.filter((row) => row.freeDelivery).map((row) => row.id)),
                    presentShopAmount,
                ),
                translation,
            );

            const specificProductsById = new Map<string, ResolvedProduct>();
            for (const prod of rowsOf(pinnedList)) {
                const resolved = prod.id ? resolvedProductsById.get(prod.id) : null;
                if (resolved) specificProductsById.set(prod.id, resolved);
            }

            const categoryProductsByCategoryId = new Map<string, ResolvedProduct[]>();
            categoryProductLimits.forEach(({ categoryId }, index) => {
                const resolvedProducts = rowsOf(categoryLists[index]!)
                    .filter((prod) => prod.id && prod.categoryId === categoryId)
                    .flatMap((prod) => {
                        const resolved = resolvedProductsById.get(prod.id);
                        return resolved ? [resolved] : [];
                    });
                if (resolvedProducts.length > 0) {
                    categoryProductsByCategoryId.set(categoryId, resolvedProducts);
                }
            });

            const categoryMetadataById = new Map<string, { id: string; name: string; slug: string }>();
            const categoryRows = categoryMetadataSlot === null
                ? []
                : translateRows(translation, "category", results[categoryMetadataSlot] as { id: string; name: string; slug: string }[], NAME_FIELDS);
            for (const cat of categoryRows) {
                if (cat.id) categoryMetadataById.set(cat.id, cat);
            }

            const featuredProductsById = new Map<string, ResolvedProduct>();
            for (const prod of rowsOf(featuredList)) {
                const resolved = prod.id ? resolvedProductsById.get(prod.id) : null;
                if (resolved) featuredProductsById.set(prod.id, resolved);
            }

            const resolvedByKey = new Map<string, CollectionProductResult>();
            for (const request of requests) {
                const cfg = normalizeCollectionConfig(request.config);
                const membership = collectionMembershipForConfig(cfg);
                const productIds = membership.productIds;
                const categoryIds = membership.categoryIds;
                const maxProducts = maxProductsOf(request, cfg);

                let collectionProducts: ResolvedProduct[] = [];
                let collectionCategories: { id: string; name: string; slug: string }[] = [];

                if (productIds.length > 0) {
                    collectionProducts = productIds
                        .map((id) => specificProductsById.get(id))
                        .filter((p): p is ResolvedProduct => p != null)
                        .slice(0, maxProducts);
                } else if (categoryIds.length > 0) {
                    const all: ResolvedProduct[] = [];
                    for (const catId of categoryIds) {
                        all.push(...(categoryProductsByCategoryId.get(catId) || []));
                    }
                    const seen = new Set<string>();
                    collectionProducts = all.filter((p) => {
                        if (seen.has(p.id)) return false;
                        seen.add(p.id);
                        return true;
                    }).slice(0, maxProducts);
                    collectionCategories = categoryIds
                        .map((id) => categoryMetadataById.get(id))
                        .filter((c): c is { id: string; name: string; slug: string } => c != null);
                }

                const featuredProduct = cfg.featuredProductId
                    ? featuredProductsById.get(cfg.featuredProductId) ?? null
                    : null;

                // The cards shown, and the set they are taken from.
                declareProductCards(
                    [...collectionProducts.map((product) => product.id), ...(featuredProduct ? [featuredProduct.id] : [])],
                    mediaByProduct,
                );
                declareCollectionMembership(cfg, {
                    productIds: collectionProducts.map((product) => product.id),
                    limit: maxProducts,
                });

                resolvedByKey.set(request.key, { products: collectionProducts, categories: collectionCategories, featuredProduct });
            }
            return resolvedByKey;
        },
    };
}

/**
 * Batch-resolve products for multiple collections in one D1 batch (products,
 * categories and card media together). Returns a Map from collection ID to
 * resolved products/categories/featured.
 */
export async function resolveCollectionProductsBatch(
    db: Database,
    parsedCollections: {
        id: string;
        config: unknown;
    }[],
    translation: TranslationScope | null = null,
): Promise<Map<string, CollectionProductResult>> {
    deps.collections(parsedCollections.map(({ id }) => id));
    const plan = planCollectionProducts(db, parsedCollections.map(({ id, config }) => ({ key: id, config })), translation);
    return plan.resolve(plan.statements.length > 0 ? await safeBatch(db, plan.statements) : []);
}

/** The most collections `/collections` lists (a directory, not a paged catalogue). */
export const COLLECTION_DIRECTORY_LIMIT = 60;

export interface PublicCollectionDirectoryEntry {
    id: string;
    name: string;
    canonicalPath: string | null;
    /** Products a buyer sees on the collection's page (the catalogue's own count). */
    productCount: number;
    /** The featured product's photo, else the collection's first product's. */
    imageUrl: string | null;
    imageAlt: string | null;
}

/**
 * Every active collection for the `/collections` directory, in the merchant's
 * order, with its product count and a photo. Two D1 waves: the collections,
 * then one batch with each collection's first product (and its card media)
 * and its visible count. Collections nobody can shop (no visible product)
 * are left out.
 */
export async function listPublicCollectionDirectory(db: Database, translation: TranslationScope | null = null): Promise<PublicCollectionDirectoryEntry[]> {
    // Which collections are listed, and each one's whole member set (its count).
    deps.anyCollection();
    const read = await db
        .select({
            id: collections.id,
            name: collections.name,
            config: collections.config,
            canonicalPath: collections.canonicalPath,
            ...translationColumns(translation, "collection", collections.id, { slug: false }),
        })
        .from(collections)
        .where(and(eq(collections.isActive, true), isNull(collections.deletedAt)))
        .orderBy(asc(collections.sortOrder), asc(collections.name))
        .limit(COLLECTION_DIRECTORY_LIMIT)
        .all();
    const rows = translateRows(translation, "collection", read, NAME_FIELDS);
    if (rows.length === 0) return [];
    for (const row of rows) declareCollectionMembership(row.config);

    const plan = planCollectionProducts(db, rows.map((row) => ({ key: row.id, config: row.config, maxProducts: 1 })), translation);
    const counts = rows.map((row) => storefrontCollectionVisibleCountQuery(
        db,
        collectionMembershipForConfig(normalizeCollectionConfig(row.config)),
    ));
    const results = await safeBatch(db, [...plan.statements, ...counts] as Parameters<typeof safeBatch>[1]);
    const resolved = plan.resolve(results);
    return rows.flatMap((row, index) => {
        const productCount = Number((results[plan.statements.length + index] as Array<{ count: number }> | undefined)?.[0]?.count ?? 0);
        if (productCount === 0) return [];
        const entry = resolved.get(row.id);
        const cover = entry?.featuredProduct ?? entry?.products.find((product) => product.imageUrl) ?? null;
        return [{
            id: row.id,
            name: row.name,
            canonicalPath: row.canonicalPath ?? null,
            productCount,
            imageUrl: cover?.imageUrl ?? null,
            imageAlt: cover?.imageAlt ?? null,
        }];
    });
}
