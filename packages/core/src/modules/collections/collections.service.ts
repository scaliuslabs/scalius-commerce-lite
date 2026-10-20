// src/modules/collections/collections.service.ts
// All DB queries and business logic for the collections domain.

import { collections, products, categories } from "@scalius/database/schema";
import { sql, and, isNull, isNotNull, eq, inArray, asc, desc, max, type SQL } from "drizzle-orm";
import { containsText } from "../../utils/text-match";
import { nanoid } from "nanoid";
import type { CreateCollectionInput, UpdateCollectionInput, UpdateCollectionProductsInput } from "./collections.validation";
import { safeBatch, type Database } from "@scalius/database/client";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";

/** A save made at a version that is no longer current: the editor reloads the latest and keeps its edits. */
export class CollectionRevisionConflictError extends AppError {
    constructor(collectionId: string, expectedVersion: number, currentVersion: number | null) {
        super(
            409,
            "collection_revision_conflict",
            "Collection changed while you were editing it. Reload and try again.",
            { collectionId, expectedVersion, currentVersion },
        );
        this.name = "CollectionRevisionConflictError";
    }
}
import { getResourceCanonicalPathSegment } from "@scalius/shared/seo-canonical";
import {
    COLLECTION_CONFIG_ID_LIMIT,
    collectionMembershipForConfig,
    normalizeCollectionConfig,
    stringifyCollectionConfig,
} from "./collection-config";
import { truthfulUpdatedAt } from "../../utils/truthful-updated-at";

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
        whereConditions.push(containsText(collections.name, search));
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
            listingTemplate: collections.listingTemplate,
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
                listingTemplate: collections.listingTemplate,
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
            listingTemplate: data.listingTemplate ?? null,
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
        throw new CollectionRevisionConflictError(id, data.expectedVersion, existing.version);
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
    if (data.listingTemplate !== undefined) updateData.listingTemplate = data.listingTemplate;

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
        throw new CollectionRevisionConflictError(id, data.expectedVersion, null);
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
        throw new CollectionRevisionConflictError(id, data.expectedVersion, existing.version);
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
        .set(truthfulUpdatedAt(collections, {
            config: stringifyCollectionConfig({ ...config, productIds }),
            version: sql`${collections.version} + 1`,
            updatedAt: sql`(unixepoch())`,
        }))
        .where(and(
            eq(collections.id, id),
            eq(collections.version, data.expectedVersion),
            isNull(collections.deletedAt),
        ))
        .returning({ id: collections.id, version: collections.version })
        .get();
    if (!updated) {
        throw new CollectionRevisionConflictError(id, data.expectedVersion, null);
    }
    return updated;
}

/**
 * Moves a collection to the trash. `expectedVersion`, when given, is the
 * version the caller read: a change since refuses (409) and trashes nothing.
 */
export async function deleteCollection(db: Database, id: string, options: { expectedVersion?: number } = {}): Promise<void> {
    const existing = await getCollectionById(db, id);
    if (!existing) throw new NotFoundError("Collection not found");

    const trashed = await db
        .update(collections)
        .set(truthfulUpdatedAt(collections, {
            deletedAt: sql`(unixepoch())`,
            version: sql`${collections.version} + 1`,
            updatedAt: sql`(unixepoch())`,
        }))
        .where(and(
            eq(collections.id, id),
            options.expectedVersion !== undefined ? eq(collections.version, options.expectedVersion) : undefined,
        ))
        .returning({ id: collections.id });
    if (trashed.length === 0) throw new ConflictError("This collection changed. Reload to see the latest.");
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
            .set(truthfulUpdatedAt(collections, {
                deletedAt: sql`(unixepoch())`,
                version: sql`${collections.version} + 1`,
                updatedAt: sql`(unixepoch())`,
            }))
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
    const results = await safeBatch(db, rows.map((row) => db.update(collections).set(truthfulUpdatedAt(collections, {
        isActive: true,
        version: row.version + 1,
        updatedAt: sql`(unixepoch())`,
    })).where(and(
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
        .set(truthfulUpdatedAt(collections, {
            isActive: false,
            version: sql`${collections.version} + 1`,
            updatedAt: sql`(unixepoch())`,
        }))
        .where(and(inArray(collections.id, normalizedIds), isNull(collections.deletedAt)));
}

/** `expectedVersion` (one collection only) is the version the caller read; a change since refuses (409). */
export async function restoreCollections(db: Database, ids: string[], options: { expectedVersion?: number } = {}): Promise<void> {
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
    if (options.expectedVersion !== undefined && trashedRows.some((row) => row.version !== options.expectedVersion)) {
        throw new ConflictError("This collection changed. Reload to see the latest.");
    }
    const nextSortOrder = Number(maxRows[0]?.max ?? -1) + 1;
    const results = await safeBatch(db, normalizedIds.map((id, index) => {
        const row = byId.get(id)!;
        return db.update(collections).set(truthfulUpdatedAt(collections, {
            deletedAt: null,
            sortOrder: nextSortOrder + index,
            version: row.version + 1,
            updatedAt: sql`(unixepoch())`,
        })).where(and(
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
                .set(truthfulUpdatedAt(collections, {
                    sortOrder: item.sortOrder,
                    version: item.expectedVersion + 1,
                    updatedAt: sql`(unixepoch())`,
                }))
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
