// src/modules/collections/collections.service.ts
// All DB queries and business logic for the collections domain.

import { collections, products, categories } from "@scalius/database/schema";
import { sql, and, isNull, isNotNull, eq, inArray, like, asc, desc, max, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { CreateCollectionInput, UpdateCollectionInput } from "./collections.validation";
import { safeBatch, type Database } from "@scalius/database/client";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { getResourceCanonicalPathSegment } from "@scalius/shared/seo-canonical";
import {
    publicCollectionProductConditions,
} from "../products/products.public-eligibility";
import {
    buildBuyerCatalogPricingProjection,
    type BuyerCatalogPricingProjection,
} from "../products/products.buyer-projection";
import {
    COLLECTION_CONFIG_ID_LIMIT,
    collectionMembershipForConfig,
    normalizeCollectionConfig,
    stringifyCollectionConfig,
} from "./collection-config";
import { ftsMatch } from "../../search/fts5";
import { getStorefrontCollectionProducts } from "../products/products.storefront";
import type { StorefrontProductFilterInput } from "../products/products.types";
import {
    publicCategoryConditions,
    publishedCategoryIdExists,
} from "../categories/categories.publication";
import {
    loadProductMediaProjections,
    resolveProductImageRepresentation,
    type ProductImageRepresentation,
} from "../products/products.media";

// ─────────────────────────────────────────
// Admin queries
// ─────────────────────────────────────────

const ALLOWED_COLLECTION_SORT_FIELDS = ["name", "presentation", "isActive", "updatedAt", "sortOrder"] as const;
const COLLECTION_MUTATION_ID_LIMIT = 90;
type CollectionSortField = typeof ALLOWED_COLLECTION_SORT_FIELDS[number];

export async function listCollections(
    db: Database,
    options: {
        page?: number;
        limit?: number;
        search?: string;
        showTrashed?: boolean;
        sort?: CollectionSortField;
        order?: "asc" | "desc";
    } = {},
) {
    const {
        page: rawPage = 1,
        limit: rawLimit = 20,
        search = "",
        showTrashed = false,
        order = "asc",
    } = options;
    const page = Math.max(1, Math.trunc(rawPage));
    const limit = Math.min(Math.max(Math.trunc(rawLimit), 1), 100);
    const sort: CollectionSortField = ALLOWED_COLLECTION_SORT_FIELDS.includes(options.sort as CollectionSortField)
        ? (options.sort as CollectionSortField)
        : "sortOrder";

    const whereConditions: (SQL | undefined)[] = [];
    if (showTrashed) {
        whereConditions.push(isNotNull(collections.deletedAt));
    } else {
        whereConditions.push(isNull(collections.deletedAt));
    }
    if (search) {
        whereConditions.push(like(collections.name, `%${search}%`));
    }

    const whereClause = whereConditions.length > 0 ? and(...whereConditions) : undefined;
    const offset = (page - 1) * limit;

    const sortColumn = (() => {
        switch (sort) {
            case "name": return collections.name;
            case "presentation": return collections.presentation;
            case "isActive": return collections.isActive;
            case "updatedAt": return collections.updatedAt;
            default: return collections.sortOrder;
        }
    })();

    const batchResults = await safeBatch(db, [
        db.select({ count: sql<number>`count(*)` })
            .from(collections)
            .where(whereClause),
        db.select({
            id: collections.id,
            name: collections.name,
            presentation: collections.presentation,
            config: collections.config,
            sortOrder: collections.sortOrder,
            isActive: collections.isActive,
            version: collections.version,
            canonicalPath: collections.canonicalPath,
            noIndex: collections.noIndex,
            excludeFromSitemap: collections.excludeFromSitemap,
            createdAt: collections.createdAt,
            updatedAt: collections.updatedAt,
            deletedAt: collections.deletedAt,
        })
            .from(collections)
            .where(whereClause)
            .orderBy(
                order === "desc" ? desc(sortColumn) : asc(sortColumn),
                asc(collections.id),
            )
            .limit(limit)
            .offset(offset),
    ]);
    const countRows = batchResults[0] as { count: number }[];
    const items = batchResults[1] as Array<Omit<
        typeof collections.$inferSelect,
        "description" | "content" | "metaTitle" | "metaDescription"
    >>;
    const total = Number(countRows[0]?.count || 0);

    return {
        collections: items,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}

export async function getCollectionById(db: Database, id: string) {
    return db
        .select()
        .from(collections)
        .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
        .limit(1)
        .then((rows: (typeof collections.$inferSelect)[]) => rows[0] ?? null);
}

function normalizeLookupIds(ids: string[]): string[] {
    return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).slice(0, 90);
}

function normalizeMutationIds(ids: string[]): string[] {
    const normalized = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    if (normalized.length > COLLECTION_MUTATION_ID_LIMIT) {
        throw new ValidationError(`At most ${COLLECTION_MUTATION_ID_LIMIT} collections can be changed at once.`);
    }
    return normalized;
}

function assertCollectionPublishReady(isActive: boolean, rawConfig: unknown): void {
    if (!isActive) return;
    const membership = collectionMembershipForConfig(rawConfig);
    if (membership.source === "manual" && membership.productIds.length === 0) {
        throw new ValidationError("Add at least one product before publishing a manual collection.");
    }
    if (membership.source === "dynamic" && membership.categoryIds.length === 0) {
        throw new ValidationError("Select at least one category before publishing a dynamic collection.");
    }
}

async function assertCollectionReferencesExist(
    db: Database,
    isActive: boolean,
    rawConfig: unknown,
): Promise<void> {
    return assertCollectionReferenceSetsExist(db, [{ isActive, rawConfig }]);
}

async function assertCollectionReferenceSetsExist(
    db: Database,
    entries: { isActive: boolean; rawConfig: unknown }[],
): Promise<void> {
    const productIds = new Set<string>();
    const categoryIds = new Set<string>();
    for (const entry of entries) {
        const config = normalizeCollectionConfig(entry.rawConfig);
        const membership = collectionMembershipForConfig(config);
        if (entry.isActive) {
            membership.productIds.forEach((id) => productIds.add(id));
            membership.categoryIds.forEach((id) => categoryIds.add(id));
        }
        if (config.featuredProductId) productIds.add(config.featuredProductId);
    }
    const productIdList = Array.from(productIds);
    const categoryIdList = Array.from(categoryIds);
    const [productRows, categoryRows] = await Promise.all([
        productIdList.length > 0
            ? db.select({ id: products.id }).from(products).where(and(
                sql`${products.id} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(productIdList)})
                )`,
                isNull(products.deletedAt),
            )).all()
            : Promise.resolve([]),
        categoryIdList.length > 0
            ? db.select({ id: categories.id, status: categories.status }).from(categories).where(and(
                sql`${categories.id} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(categoryIdList)})
                )`,
                isNull(categories.deletedAt),
            )).all()
            : Promise.resolve([]),
    ]);
    const foundProductIds = new Set(productRows.map((row) => row.id));
    const foundCategoryIds = new Set(categoryRows.map((row) => row.id));
    const unpublishedCategoryIds = categoryRows
        .filter((row) => row.status !== "published")
        .map((row) => row.id);
    const missingProductIds = productIdList.filter((id) => !foundProductIds.has(id));
    const missingCategoryIds = categoryIdList.filter((id) => !foundCategoryIds.has(id));
    if (missingProductIds.length > 0 || missingCategoryIds.length > 0) {
        throw new ValidationError(
            "Collection membership references products or categories that no longer exist.",
            { missingProductIds, missingCategoryIds },
        );
    }
    if (unpublishedCategoryIds.length > 0) {
        throw new ValidationError(
            "Publish the selected categories before activating this dynamic collection, or keep the collection inactive.",
            { unpublishedCategoryIds },
        );
    }
}

export async function getCollectionsByIds(db: Database, ids: string[]) {
    const lookupIds = normalizeLookupIds(ids);
    if (lookupIds.length === 0) return [];

    const orderById = new Map(lookupIds.map((id, index) => [id, index]));
    const rows = await db
        .select({
            id: collections.id,
            name: collections.name,
            presentation: collections.presentation,
        })
        .from(collections)
        .where(and(inArray(collections.id, lookupIds), isNull(collections.deletedAt)));

    return rows.sort(
        (a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0),
    );
}

export async function getCollectionCategoryOptions(db: Database) {
    return db
        .select({ id: categories.id, name: categories.name, status: categories.status })
        .from(categories)
        .where(isNull(categories.deletedAt))
        .orderBy(asc(categories.name), asc(categories.id))
        .limit(500);
}

const COLLECTION_PRODUCT_OPTION_CATEGORY_LIMIT = 90;

export interface CollectionProductOptionsInput {
    page?: number;
    limit?: number;
    search?: string;
    categoryIds?: string[];
}

/**
 * Lightweight, paginated product lookup for the collection builder.
 *
 * Category IDs are deliberately capped below D1's 100-bound-parameter limit:
 * each statement may also bind the search expression, limit, and offset.
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
    const offset = (page - 1) * limit;

    const whereConditions: SQL[] = [isNull(products.deletedAt)];
    const searchCondition = search
        ? ftsMatch("products_fts", "products", search)
        : undefined;
    if (searchCondition) whereConditions.push(searchCondition);
    if (categoryIds.length > 0) {
        whereConditions.push(inArray(products.categoryId, categoryIds));
    }
    const whereClause = and(...whereConditions);

    const countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .where(whereClause);
    const optionsQuery = db
        .select({
            id: products.id,
            name: products.name,
            price: products.price,
            categoryId: products.categoryId,
            categoryName: sql<string | null>`${categories.name}`.as(
                "collection_product_category_name",
            ),
            isActive: products.isActive,
        })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(whereClause)
        .orderBy(asc(products.name), asc(products.id))
        .limit(limit)
        .offset(offset);

    const [countRows = [], productOptions = []] = await safeBatch(db, [
        countQuery,
        optionsQuery,
    ]) as unknown as [
        Array<{ count: number }>,
        Array<{
            id: string;
            name: string;
            price: number;
            categoryId: string | null;
            categoryName: string | null;
            isActive: boolean;
        }>,
    ];
    const total = Number(countRows[0]?.count ?? 0);

    return {
        products: productOptions,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}

// ─────────────────────────────────────────
// Admin mutations
// ─────────────────────────────────────────

export async function createCollection(
    db: Database,
    data: CreateCollectionInput,
) {
    if (data.canonicalPath) {
        throw new ValidationError("Collection canonical path should be blank until the collection has a saved ID route.");
    }
    assertCollectionPublishReady(data.isActive, data.config);
    await assertCollectionReferencesExist(db, data.isActive, data.config);

    const maxSortOrder = await db
        .select({ max: max(collections.sortOrder) })
        .from(collections)
        .where(isNull(collections.deletedAt))
        .then((result: { max: number | null }[]) => (result[0]?.max ?? -1) + 1);

    return db
        .insert(collections)
        .values({
            id: nanoid(),
            name: data.name,
            description: data.description,
            content: data.content,
            presentation: data.presentation,
            isActive: data.isActive,
            canonicalPath: data.canonicalPath ?? null,
            noIndex: data.noIndex ?? false,
            excludeFromSitemap: data.excludeFromSitemap ?? false,
            metaTitle: data.metaTitle,
            metaDescription: data.metaDescription,
            sortOrder: maxSortOrder,
            config: stringifyCollectionConfig(data.config),
        })
        .returning()
        .get();
}

export async function updateCollection(
    db: Database,
    id: string,
    data: UpdateCollectionInput,
) {
    const existing = await db
        .select({
            id: collections.id,
            isActive: collections.isActive,
            version: collections.version,
            config: collections.config,
        })
        .from(collections)
        .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
        .get();
    if (!existing) throw new NotFoundError("Collection not found");
    if (existing.version !== data.expectedVersion) {
        throw new ConflictError("Collection changed while you were editing it. Reload and try again.");
    }

    if (
        data.canonicalPath &&
        getResourceCanonicalPathSegment("collection", data.canonicalPath) !== id
    ) {
        throw new ValidationError("Collection canonical path must match this collection's ID route, or be left blank.");
    }

    const existingConfig = normalizeCollectionConfig(existing.config);
    const nextIsActive = data.isActive ?? existing.isActive;
    const nextConfig = data.config
        ? { ...existingConfig, ...data.config }
        : existingConfig;
    if (data.isActive === true || data.config !== undefined) {
        assertCollectionPublishReady(nextIsActive, nextConfig);
    }
    if (data.isActive === true || data.config !== undefined) {
        await assertCollectionReferencesExist(db, nextIsActive, nextConfig);
    }

    const updateData: Record<string, unknown> = {
        version: existing.version + 1,
        updatedAt: sql`(unixepoch())`,
    };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.content !== undefined) updateData.content = data.content;
    if (data.presentation !== undefined) updateData.presentation = data.presentation;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.canonicalPath !== undefined) updateData.canonicalPath = data.canonicalPath;
    if (data.noIndex !== undefined) updateData.noIndex = data.noIndex;
    if (data.excludeFromSitemap !== undefined) updateData.excludeFromSitemap = data.excludeFromSitemap;
    if (data.metaTitle !== undefined) updateData.metaTitle = data.metaTitle;
    if (data.metaDescription !== undefined) updateData.metaDescription = data.metaDescription;
    if (data.config !== undefined) updateData.config = stringifyCollectionConfig(nextConfig);

    const updated = await db
        .update(collections)
        .set(updateData)
        .where(and(
            eq(collections.id, id),
            eq(collections.version, data.expectedVersion),
            isNull(collections.deletedAt),
        ))
        .returning()
        .get();
    if (!updated) {
        throw new ConflictError("Collection changed while you were editing it. Reload and try again.");
    }
    return updated;
}

export async function deleteCollection(db: Database, id: string): Promise<void> {
    const existing = await getCollectionById(db, id);
    if (!existing) throw new NotFoundError("Collection not found");

    await db
        .update(collections)
        .set({
            deletedAt: sql`(unixepoch())`,
            version: sql`${collections.version} + 1`,
            updatedAt: sql`(unixepoch())`,
        })
        .where(eq(collections.id, id));
}

export async function bulkDeleteCollections(
    db: Database,
    ids: string[],
    permanent = false,
): Promise<void> {
    const normalizedIds = normalizeMutationIds(ids);
    if (normalizedIds.length === 0) return;

    if (permanent) {
        await db.delete(collections).where(and(
            inArray(collections.id, normalizedIds),
            isNotNull(collections.deletedAt),
        ));
    } else {
        await db
            .update(collections)
            .set({
                deletedAt: sql`(unixepoch())`,
                version: sql`${collections.version} + 1`,
                updatedAt: sql`(unixepoch())`,
            })
            .where(and(
                inArray(collections.id, normalizedIds),
                isNull(collections.deletedAt),
            ));
    }
}

export async function bulkActivateCollections(db: Database, ids: string[]): Promise<void> {
    const normalizedIds = normalizeMutationIds(ids);
    if (normalizedIds.length === 0) return;

    const rows = await db
        .select({ id: collections.id, config: collections.config, version: collections.version })
        .from(collections)
        .where(and(inArray(collections.id, normalizedIds), isNull(collections.deletedAt)))
        .all();
    if (rows.length !== normalizedIds.length) throw new NotFoundError("One or more collections were not found.");
    for (const row of rows) assertCollectionPublishReady(true, row.config);
    await assertCollectionReferenceSetsExist(
        db,
        rows.map((row) => ({ isActive: true, rawConfig: row.config })),
    );
    const results = await safeBatch(db, rows.map((row) => db.update(collections).set({
        isActive: true,
        version: row.version + 1,
        updatedAt: sql`(unixepoch())`,
    }).where(and(
        eq(collections.id, row.id),
        eq(collections.version, row.version),
        isNull(collections.deletedAt),
    )).returning({ id: collections.id })));
    if (results.some((result) => !result?.length)) {
        throw new ConflictError("A collection changed while activation was being committed. Reload and try again.");
    }
}

export async function bulkDeactivateCollections(db: Database, ids: string[]): Promise<void> {
    const normalizedIds = normalizeMutationIds(ids);
    if (normalizedIds.length === 0) return;

    await db
        .update(collections)
        .set({
            isActive: false,
            version: sql`${collections.version} + 1`,
            updatedAt: sql`(unixepoch())`,
        })
        .where(and(inArray(collections.id, normalizedIds), isNull(collections.deletedAt)));
}

export async function restoreCollections(db: Database, ids: string[]): Promise<void> {
    const normalizedIds = normalizeMutationIds(ids);
    if (normalizedIds.length === 0) return;

    const [trashedRows, maxRows] = await Promise.all([
        db.select({ id: collections.id, version: collections.version })
            .from(collections)
            .where(and(inArray(collections.id, normalizedIds), isNotNull(collections.deletedAt)))
            .all(),
        db.select({ max: max(collections.sortOrder) })
            .from(collections)
            .where(isNull(collections.deletedAt))
            .all(),
    ]);
    if (trashedRows.length !== normalizedIds.length) {
        throw new NotFoundError("One or more trashed collections were not found.");
    }
    const byId = new Map(trashedRows.map((row) => [row.id, row]));
    const nextSortOrder = Number(maxRows[0]?.max ?? -1) + 1;
    const results = await safeBatch(db, normalizedIds.map((id, index) => {
        const row = byId.get(id)!;
        return db.update(collections).set({
            deletedAt: null,
            sortOrder: nextSortOrder + index,
            version: row.version + 1,
            updatedAt: sql`(unixepoch())`,
        }).where(and(
            eq(collections.id, id),
            eq(collections.version, row.version),
            isNotNull(collections.deletedAt),
        )).returning({ id: collections.id });
    }));
    if (results.some((result) => !result?.length)) {
        throw new ConflictError("A collection changed while restore was being committed. Reload and try again.");
    }
}

export async function reorderCollections(
    db: Database,
    items: { id: string; sortOrder: number; expectedVersion: number }[],
): Promise<void> {
    if (items.length === 0) return;
    if (items.length > COLLECTION_MUTATION_ID_LIMIT) {
        throw new ValidationError(`At most ${COLLECTION_MUTATION_ID_LIMIT} collections can be reordered at once.`);
    }
    const ids = items.map((item) => item.id.trim());
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
        throw new ValidationError("Collection reorder items must use unique saved IDs.");
    }
    if (items.some((item) => !Number.isInteger(item.sortOrder) || item.sortOrder < 0)) {
        throw new ValidationError("Collection sort order must be a non-negative integer.");
    }
    const sortedPositions = items.map((item) => item.sortOrder).sort((a, b) => a - b);
    if (sortedPositions.some((position, index) => position !== index)) {
        throw new ValidationError("Collection reorder must use every contiguous position from 0 once.");
    }
    if (items.some((item) => !Number.isInteger(item.expectedVersion) || item.expectedVersion < 1)) {
        throw new ValidationError("Collection reorder items require a positive expected version.");
    }
    const existingRows = await db.select({ id: collections.id, version: collections.version })
        .from(collections)
        .where(isNull(collections.deletedAt))
        .all();
    if (
        existingRows.length !== items.length ||
        existingRows.some((row) => !ids.includes(row.id))
    ) {
        throw new ConflictError("Reorder requires the complete current collection list. Reload and try again.");
    }
    const versionById = new Map(existingRows.map((row) => [row.id, row.version]));
    if (items.some((item) => versionById.get(item.id) !== item.expectedVersion)) {
        throw new ConflictError("A collection changed while you were reordering. Reload and try again.");
    }

    const results = await safeBatch(
        db,
        items.map((item) =>
            db.update(collections)
                .set({
                    sortOrder: item.sortOrder,
                    version: item.expectedVersion + 1,
                    updatedAt: sql`(unixepoch())`,
                })
                .where(and(
                    eq(collections.id, item.id.trim()),
                    eq(collections.version, item.expectedVersion),
                    isNull(collections.deletedAt),
                ))
                .returning({ id: collections.id })
        )
    );
    if (results.some((result) => !result?.length)) {
        throw new ConflictError("A collection changed while reorder was being committed. Reload and try again.");
    }
}

// ─────────────────────────────────────────
// Storefront: product resolution
// ─────────────────────────────────────────

export async function getPublicCollectionCatalog(
    db: Database,
    id: string,
    params: StorefrontProductFilterInput,
) {
    const collection = await db
        .select()
        .from(collections)
        .where(and(
            eq(collections.id, id),
            eq(collections.isActive, true),
            isNull(collections.deletedAt),
        ))
        .get();
    if (!collection) return null;

    const config = normalizeCollectionConfig(collection.config);
    const membership = collectionMembershipForConfig(config);
    const buyerPricing = buildBuyerCatalogPricingProjection(db);
    const categoryIdsJson = JSON.stringify(membership.categoryIds);
    const categoryPromise: Promise<Array<{ id: string; name: string; slug: string }>> =
        membership.categoryIds.length > 0
            ? db
                .select({ id: categories.id, name: categories.name, slug: categories.slug })
                .from(categories)
                .where(and(
                    sql`${categories.id} IN (
                        SELECT CAST(value AS TEXT) FROM json_each(${categoryIdsJson})
                    )`,
                    ...publicCategoryConditions(),
                ))
                .all()
            : Promise.resolve([]);
    const catalogPromise = getStorefrontCollectionProducts(db, {
        productIds: membership.productIds,
        categoryIds: membership.categoryIds,
    }, params);
    const featuredPromise: Promise<RawProduct[]> = config.featuredProductId
            ? db
                .select(buildCollectionProductSelect(buyerPricing))
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
    const featuredProducts = await enrichProductsWithMedia(db, featuredRows);

    return {
        collection: { ...collection, config },
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

/** Product select shape used for collection product resolution. */
const buildCollectionProductSelect = (buyerPricing: BuyerCatalogPricingProjection) => ({
    id: products.id,
    name: products.name,
    slug: products.slug,
    price: buyerPricing.basePrice,
    discountType: buyerPricing.discountType,
    discountPercentage: buyerPricing.discountPercentage,
    discountAmount: buyerPricing.discountAmount,
    discountedPrice: buyerPricing.effectivePrice,
    maxBuyerPrice: buyerPricing.maxBuyerPrice,
    availableForSale: buyerPricing.availableForSale,
    freeDelivery: products.freeDelivery,
    categoryId: products.categoryId,
    hasVariants: buyerPricing.hasCustomerOptions,
});

type RawProduct = {
    id: string;
    name: string;
    slug: string;
    price: number;
    discountType: string | null;
    discountPercentage: number | null;
    discountAmount: number | null;
    discountedPrice: number;
    maxBuyerPrice: number;
    availableForSale: number;
    freeDelivery: boolean;
    categoryId: string | null;
    hasVariants: number;
};

export type ResolvedProduct = Omit<RawProduct, "hasVariants" | "availableForSale" | "maxBuyerPrice"> & {
    hasVariants: boolean;
    availableForSale: boolean;
    priceVaries: boolean;
    imageUrl: string | null;
    imageMediaId: string | null;
    imageAlt: string | null;
};

function enrichProduct(
    p: RawProduct,
    image: ProductImageRepresentation,
): ResolvedProduct {
    const { hasVariants, availableForSale, maxBuyerPrice, ...product } = p;
    return {
        ...product,
        hasVariants: Boolean(hasVariants),
        availableForSale: Boolean(availableForSale),
        priceVaries: maxBuyerPrice > p.discountedPrice,
        imageUrl: image?.url ?? null,
        imageMediaId: image?.mediaId ?? null,
        imageAlt: image?.altText ?? null,
    };
}

async function enrichProductsWithMedia(
    db: Database,
    rows: readonly RawProduct[],
): Promise<Map<string, ResolvedProduct>> {
    const mediaMap = await loadProductMediaProjections(db, rows.map((row) => row.id));
    return new Map(rows.map((row) => [
        row.id,
        enrichProduct(
            row,
            resolveProductImageRepresentation(mediaMap.get(row.id) ?? []),
        ),
    ]));
}

export interface CollectionProductResult {
    products: ResolvedProduct[];
    categories: { id: string; name: string; slug: string }[];
    featuredProduct: ResolvedProduct | null;
}

function uniqueNonEmptyIds(ids: string[]): string[] {
    return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

/**
 * Resolve products for a single collection config.
 * Used by the public collection detail endpoint.
 *
 * Priority: productIds > categoryIds. Featured product resolved independently.
 */
export async function resolveCollectionProducts(
    db: Database,
    rawConfig: unknown,
): Promise<CollectionProductResult> {
    const config = normalizeCollectionConfig(rawConfig);
    const membership = collectionMembershipForConfig(config);
    const productIds = membership.productIds;
    const categoryIds = membership.categoryIds;
    const maxProducts = Math.min(Math.max(config.maxProducts || 8, 1), 24);
    const hasFeaturedProduct = !!config.featuredProductId;
    const buyerPricing = buildBuyerCatalogPricingProjection(db);

    const noopQuery = db.select({ id: sql`NULL` }).from(products).where(sql`1 = 0`);

    if (productIds.length > 0) {
        // CASE 1: Specific products — ignore categoryIds
        const specificProductIds = uniqueNonEmptyIds(productIds).slice(0, COLLECTION_CONFIG_ID_LIMIT);
        const batchResults = await db.batch([
            specificProductIds.length > 0
                ? db.select(buildCollectionProductSelect(buyerPricing))
                    .from(products)
                    .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
                    .where(and(...publicCollectionProductConditions(sql`${products.id} IN (
                        SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(specificProductIds)})
                    )`)))
                    .limit(specificProductIds.length)
                : noopQuery,
            hasFeaturedProduct
                ? db.select(buildCollectionProductSelect(buyerPricing))
                    .from(products)
                    .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
                    .where(and(...publicCollectionProductConditions(eq(products.id, config.featuredProductId!))))
                : noopQuery,
        ]);

        const productsData = batchResults[0] as RawProduct[];
        const featuredData = hasFeaturedProduct ? (batchResults[1] as RawProduct[])[0] ?? null : null;
        const productsById = await enrichProductsWithMedia(
            db,
            featuredData ? [...productsData, featuredData] : productsData,
        );

        return {
            products: specificProductIds
                .map((id) => productsById.get(id))
                .filter((product): product is ResolvedProduct => product != null)
                .slice(0, maxProducts),
            categories: [],
            featuredProduct: featuredData ? productsById.get(featuredData.id) ?? null : null,
        };
    }

    if (categoryIds.length > 0) {
        // CASE 2: Category-based collection
        const specificCategoryIds = uniqueNonEmptyIds(categoryIds);
        const batchResults = await db.batch([
            db.select({ id: categories.id, name: categories.name, slug: categories.slug })
                .from(categories)
                .where(and(
                    inArray(categories.id, specificCategoryIds),
                    ...publicCategoryConditions(),
                )),
            db.select(buildCollectionProductSelect(buyerPricing))
                .from(products)
                .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
                .where(and(
                    ...publicCollectionProductConditions(inArray(products.categoryId, specificCategoryIds)),
                    publishedCategoryIdExists(products.categoryId),
                ))
                .orderBy(desc(products.createdAt))
                .limit(maxProducts),
            hasFeaturedProduct
                ? db.select(buildCollectionProductSelect(buyerPricing))
                    .from(products)
                    .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
                    .where(and(...publicCollectionProductConditions(eq(products.id, config.featuredProductId!))))
                : noopQuery,
        ]);

        const categoriesData = batchResults[0] as { id: string; name: string; slug: string }[];
        const productsData = batchResults[1] as RawProduct[];
        const featuredData = hasFeaturedProduct ? (batchResults[2] as RawProduct[])[0] ?? null : null;
        const categoriesById = new Map(categoriesData.map((category) => [category.id, category]));
        const resolvedProductsById = await enrichProductsWithMedia(
            db,
            featuredData ? [...productsData, featuredData] : productsData,
        );

        return {
            products: productsData.flatMap((product) => {
                const resolved = resolvedProductsById.get(product.id);
                return resolved ? [resolved] : [];
            }),
            categories: specificCategoryIds
                .map((id) => categoriesById.get(id))
                .filter((category): category is { id: string; name: string; slug: string } => category != null),
            featuredProduct: featuredData
                ? resolvedProductsById.get(featuredData.id) ?? null
                : null,
        };
    }

    if (hasFeaturedProduct) {
        // CASE 3: Only featured product
        const featuredData = await db.select(buildCollectionProductSelect(buyerPricing))
            .from(products)
            .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
            .where(and(...publicCollectionProductConditions(eq(products.id, config.featuredProductId!))))
            .get() as RawProduct | undefined;
        const resolvedFeatured = featuredData
            ? (await enrichProductsWithMedia(db, [featuredData])).get(featuredData.id) ?? null
            : null;

        return {
            products: [],
            categories: [],
            featuredProduct: resolvedFeatured,
        };
    }

    // CASE 4: Empty config
    return { products: [], categories: [], featuredProduct: null };
}

/**
 * Batch-resolve products for multiple collections.
 * Used by the homepage endpoint to avoid unbounded category product reads.
 *
 * Returns a Map from collection ID to resolved products/categories/featured.
 */
export async function resolveCollectionProductsBatch(
    db: Database,
    parsedCollections: {
        id: string;
        config: unknown;
    }[],
): Promise<Map<string, CollectionProductResult>> {
    // Gather all IDs across collections
    const allProductIds = new Set<string>();
    const categoryProductLimitsById = new Map<string, number>();
    const allFeaturedIds = new Set<string>();

    for (const col of parsedCollections) {
        const cfg = normalizeCollectionConfig(col.config);
        const membership = collectionMembershipForConfig(cfg);
        membership.productIds.forEach((id) => allProductIds.add(id));
        if (membership.source === "dynamic") {
            membership.categoryIds.forEach((id) => {
                categoryProductLimitsById.set(
                    id,
                    Math.max(categoryProductLimitsById.get(id) ?? 0, cfg.maxProducts),
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
    const buyerPricing = buildBuyerCatalogPricingProjection(db);

    const noopQuery = db.select({ id: sql`NULL` }).from(products).where(sql`1 = 0`);

    const batchResults = await safeBatch(db, [
        productIdsArr.length > 0
            ? db.select(buildCollectionProductSelect(buyerPricing)).from(products)
                .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
                .where(and(...publicCollectionProductConditions(sql`${products.id} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(productIdsArr)})
                )`)))
            : noopQuery,
        ...categoryProductLimits.map(({ categoryId, maxProducts }) =>
            db.select(buildCollectionProductSelect(buyerPricing))
                .from(products)
                .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
                .where(and(
                    ...publicCollectionProductConditions(eq(products.categoryId, categoryId)),
                    publishedCategoryIdExists(products.categoryId),
                ))
                .orderBy(desc(products.createdAt), asc(products.id))
                .limit(maxProducts),
        ),
        categoryIdsArr.length > 0
            ? db.select({ id: categories.id, name: categories.name, slug: categories.slug }).from(categories).where(and(
                sql`${categories.id} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(categoryIdsArr)})
                )`,
                ...publicCategoryConditions(),
            ))
            : noopQuery,
        featuredIdsArr.length > 0
            ? db.select(buildCollectionProductSelect(buyerPricing)).from(products)
                .innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))
                .where(and(...publicCollectionProductConditions(sql`${products.id} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(featuredIdsArr)})
                )`)))
            : noopQuery,
    ]);
    const categoryProductsStartIndex = 1;
    const categoryMetadataIndex = categoryProductsStartIndex + categoryProductLimits.length;
    const featuredProductsIndex = categoryMetadataIndex + 1;
    const allRawProducts = [
        ...(batchResults[0] as RawProduct[]),
        ...categoryProductLimits.flatMap((_, index) =>
            batchResults[categoryProductsStartIndex + index] as RawProduct[]
        ),
        ...(batchResults[featuredProductsIndex] as RawProduct[]),
    ];
    const resolvedProductsById = await enrichProductsWithMedia(db, allRawProducts);

    // Build lookup maps
    const specificProductsById = new Map<string, ResolvedProduct>();
    for (const prod of batchResults[0] as RawProduct[]) {
        const resolved = prod.id ? resolvedProductsById.get(prod.id) : null;
        if (resolved) specificProductsById.set(prod.id, resolved);
    }

    const categoryProductsByCategoryId = new Map<string, ResolvedProduct[]>();
    categoryProductLimits.forEach(({ categoryId }, index) => {
        const productsData = batchResults[categoryProductsStartIndex + index] as RawProduct[];
        const resolvedProducts = productsData
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
    for (const cat of batchResults[categoryMetadataIndex] as { id: string; name: string; slug: string }[]) {
        if (cat.id) categoryMetadataById.set(cat.id, cat);
    }

    const featuredProductsById = new Map<string, ResolvedProduct>();
    for (const prod of batchResults[featuredProductsIndex] as RawProduct[]) {
        const resolved = prod.id ? resolvedProductsById.get(prod.id) : null;
        if (resolved) featuredProductsById.set(prod.id, resolved);
    }

    // Resolve per-collection
    const results = new Map<string, CollectionProductResult>();

    for (const col of parsedCollections) {
        const cfg = normalizeCollectionConfig(col.config);
        const membership = collectionMembershipForConfig(cfg);
        const productIds = membership.productIds;
        const categoryIds = membership.categoryIds;
        const maxProducts = Math.min(Math.max(cfg.maxProducts || 8, 1), 24);

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

        results.set(col.id, { products: collectionProducts, categories: collectionCategories, featuredProduct });
    }

    return results;
}
