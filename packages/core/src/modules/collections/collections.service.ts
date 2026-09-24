// src/modules/collections/collections.service.ts
// All DB queries and business logic for the collections domain.

import { collections, products, categories, productVariants } from "@scalius/database/schema";
import { sql, and, isNull, isNotNull, eq, inArray, like, asc, desc, max, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { CreateCollectionInput, UpdateCollectionInput, UpdateCollectionProductsInput } from "./collections.validation";
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
import { fromMinor } from "@scalius/shared/money";
import {
    buyerPricingSelection,
    presentBuyerPricing,
    storeCurrencyCodeSql,
    storeDecimalPlacesFromCode,
    type BuyerPricingMinor,
} from "../products/products.money";
import { getStorefrontCollectionProducts } from "../products/products.storefront";
import type { StorefrontProductFilterInput } from "../products/products.types";
import {
    publicCategoryConditions,
    publishedCategoryIdExists,
} from "../categories/categories.publication";
import {
    loadProductMediaProjections,
    resolveProductCardImages,
    resolveProductImageRepresentation,
    type ProductCardImages,
} from "../products/products.media";

// ─────────────────────────────────────────
// Admin queries
// ─────────────────────────────────────────

const ALLOWED_COLLECTION_SORT_FIELDS = ["name", "presentation", "isActive", "updatedAt", "sortOrder"] as const;
const COLLECTION_MUTATION_ID_LIMIT = 90;
export const COLLECTION_TEXT_CHUNK_SIZE = 12_000;
export type CollectionSection = "summary" | "text";
export type CollectionTextField = "description" | "content";
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

/**
 * Bounded admin projection for collections whose editor text may contain up to
 * 100,000 characters per field. The summary reads only lengths; text is
 * reconstructed in fixed chunks without loading the full aggregate.
 */
export async function getCollectionSection(
    db: Database,
    id: string,
    section: CollectionSection,
    options: { field?: CollectionTextField; offset?: number } = {},
) {
    if (section === "summary") {
        const collection = await db
            .select({
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
                metaTitle: collections.metaTitle,
                metaDescription: collections.metaDescription,
                descriptionCharacters: sql<number>`length(coalesce(${collections.description}, ''))`,
                contentCharacters: sql<number>`length(coalesce(${collections.content}, ''))`,
            })
            .from(collections)
            .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
            .get();
        if (!collection) return null;
        return {
            section,
            collection: {
                ...collection,
                descriptionCharacters: Number(collection.descriptionCharacters ?? 0),
                contentCharacters: Number(collection.contentCharacters ?? 0),
            },
        };
    }

    const field = options.field ?? "description";
    const offset = options.offset ?? 0;
    const column = field === "content" ? collections.content : collections.description;
    const collection = await db
        .select({
            value: sql<string>`substr(coalesce(${column}, ''), ${offset + 1}, ${COLLECTION_TEXT_CHUNK_SIZE})`,
            totalCharacters: sql<number>`length(coalesce(${column}, ''))`,
            isNull: sql<number>`CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END`,
        })
        .from(collections)
        .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
        .get();
    if (!collection) return null;
    const totalCharacters = Number(collection.totalCharacters ?? 0);
    const value = collection.value ?? "";
    return {
        section,
        field,
        value,
        totalCharacters,
        offset,
        nextOffset: offset + value.length < totalCharacters ? offset + value.length : null,
        isNull: Boolean(collection.isNull),
    };
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
    selectedProductIds?: string[];
}

/**
 * Lightweight, paginated product lookup for the collection builder.
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

    const [countRows = [], productOptions = []] = await (safeBatch(db, [
        countQuery,
        optionsQuery,
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
    ]>);
    const total = Number(countRows[0]?.count ?? 0);
    const decimalPlaces = storeDecimalPlacesFromCode(countRows[0]?.storeCurrencyCode);
    const mediaMap = productOptions.length > 0
        ? await loadProductMediaProjections(db, productOptions.map((product) => product.id))
        : new Map();

    return {
        products: productOptions.map(({ priceMinor, variantCount, available, ...product }) => ({
            ...product,
            variantCount: Number(variantCount ?? 0),
            available: available == null ? null : Number(available),
            price: fromMinor(priceMinor, decimalPlaces),
            primaryImage:
                resolveProductImageRepresentation(mediaMap.get(product.id) ?? [])?.url ?? null,
        })),
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

/**
 * Adds and removes products in a manual collection (the products list's
 * "Add to collection"). New products go to the end in the order given;
 * unknown or trashed ids are skipped. Version CAS like `updateCollection`.
 */
export async function updateCollectionProducts(
    db: Database,
    id: string,
    data: UpdateCollectionProductsInput,
) {
    const existing = await db
        .select({ isActive: collections.isActive, version: collections.version, config: collections.config })
        .from(collections)
        .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
        .get();
    if (!existing) throw new NotFoundError("Collection not found");
    if (existing.version !== data.expectedVersion) {
        throw new ConflictError("Collection changed while you were editing it. Reload and try again.");
    }
    const config = normalizeCollectionConfig(existing.config);
    if (config.source !== "manual") {
        throw new ValidationError(
            "This collection picks products automatically. Change its rule instead.",
            { field: "products" },
        );
    }

    const removed = new Set(data.remove.map((productId) => productId.trim()));
    const kept = config.productIds.filter((productId) => !removed.has(productId));
    const candidates = Array.from(new Set(data.add.map((productId) => productId.trim())))
        .filter((productId) => !removed.has(productId) && !kept.includes(productId));
    const found = candidates.length > 0
        ? new Set((await db.select({ id: products.id }).from(products).where(and(
            sql`${products.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(candidates)}))`,
            isNull(products.deletedAt),
        )).all()).map((row) => row.id))
        : new Set<string>();
    const productIds = [...kept, ...candidates.filter((productId) => found.has(productId))];
    if (productIds.length > COLLECTION_CONFIG_ID_LIMIT) {
        throw new ValidationError(
            `This collection can hold ${COLLECTION_CONFIG_ID_LIMIT} products. Remove some first.`,
            { field: "products" },
        );
    }
    if (existing.isActive && productIds.length === 0) {
        throw new ValidationError(
            "An active collection needs at least one product. Set it as draft first.",
            { field: "products" },
        );
    }

    const updated = await db
        .update(collections)
        .set({
            config: stringifyCollectionConfig({ ...config, productIds }),
            version: sql`${collections.version} + 1`,
            updatedAt: sql`(unixepoch())`,
        })
        .where(and(
            eq(collections.id, id),
            eq(collections.version, data.expectedVersion),
            isNull(collections.deletedAt),
        ))
        .returning({ id: collections.id, version: collections.version })
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
    ...buyerPricingSelection(buyerPricing),
    availableForSale: buyerPricing.availableForSale,
    freeDelivery: products.freeDelivery,
    categoryId: products.categoryId,
    hasVariants: buyerPricing.hasCustomerOptions,
    storeCurrencyCode: storeCurrencyCodeSql().as("collection_store_currency_code"),
});

type RawProduct = BuyerPricingMinor & {
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

async function enrichProductsWithMedia(
    db: Database,
    rows: readonly RawProduct[],
): Promise<Map<string, ResolvedProduct>> {
    const mediaMap = await loadProductMediaProjections(db, rows.map((row) => row.id));
    const decimalPlaces = storeDecimalPlacesFromCode(rows[0]?.storeCurrencyCode);
    return new Map(rows.map((row) => [
        row.id,
        enrichProduct(
            row,
            resolveProductCardImages(mediaMap.get(row.id) ?? []),
            decimalPlaces,
        ),
    ]));
}

export interface CollectionProductResult {
    products: ResolvedProduct[];
    categories: { id: string; name: string; slug: string }[];
    featuredProduct: ResolvedProduct | null;
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
