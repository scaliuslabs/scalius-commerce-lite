// src/modules/categories/categories.service.ts
// All DB queries and business logic for the categories domain.
// Used by both admin Hono routes and storefront Hono routes.

import { categories, products, collections } from "@scalius/database/schema";
import { sql, and, isNull, isNotNull, eq, ne, desc, asc, inArray, type SQL } from "drizzle-orm";
import { ftsMatch } from "../../search/fts5";
import { nanoid } from "nanoid";
import {
    CATEGORY_BATCH_LIMIT,
    type CreateCategoryInput,
    type UpdateCategoryInput,
} from "./categories.validation";
import { buildBatchGuard, safeBatch, type Database } from "@scalius/database/client";
import { NotFoundError, ConflictError, ValidationError } from "@scalius/core/errors";
import type { BatchItem } from "drizzle-orm/batch";

type SQLiteBatchItem = BatchItem<"sqlite">;

function categoryProductRevisionBump(
    db: Database,
    categoryIds: string[],
): SQLiteBatchItem {
    return db.update(products)
        .set({
            aggregateRevision: sql`${products.aggregateRevision} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(inArray(products.categoryId, categoryIds));
}

function categoryDeleteUsageGuard(
    db: Database,
    categoryIds: string[],
): SQLiteBatchItem {
    return buildBatchGuard(db, sql`
        CASE WHEN NOT EXISTS (
            SELECT 1 FROM ${products}
            WHERE ${inArray(products.categoryId, categoryIds)}
              AND ${products.deletedAt} IS NULL
        ) THEN 1 ELSE json_extract('CATEGORY_DELETE_IN_USE', '$') END
    `);
}

function allCategoriesTrashedCondition(
    categoryIds: string[],
): SQL {
    return sql`(
        SELECT count(*) FROM ${categories}
        WHERE ${categories.id} IN (
            SELECT CAST(value AS TEXT)
            FROM json_each(${JSON.stringify(categoryIds)})
        )
          AND ${categories.deletedAt} IS NOT NULL
    ) = ${categoryIds.length}`;
}

function categoryActiveStateGuard(
    db: Database,
    categoryIds: string[],
): SQLiteBatchItem {
    return buildBatchGuard(db, sql`
        CASE WHEN (
            SELECT count(*) FROM ${categories}
            WHERE ${inArray(categories.id, categoryIds)}
              AND ${categories.deletedAt} IS NULL
        ) = ${categoryIds.length}
        THEN 1 ELSE json_extract('CATEGORY_ACTIVE_STATE_REQUIRED', '$') END
    `);
}

function categoryTrashedStateGuard(
    db: Database,
    categoryIds: string[],
): SQLiteBatchItem {
    return buildBatchGuard(db, sql`
        CASE WHEN (
            SELECT count(*) FROM ${categories}
            WHERE ${inArray(categories.id, categoryIds)}
              AND ${categories.deletedAt} IS NOT NULL
        ) = ${categoryIds.length}
        THEN 1 ELSE json_extract('CATEGORY_TRASHED_STATE_REQUIRED', '$') END
    `);
}

function isCategorySlugConstraintError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /categories(?:_slug_idx|\.slug)|UNIQUE constraint failed: categories\.slug/i.test(message);
}

// ─────────────────────────────────────────
// Admin queries
// ─────────────────────────────────────────

/**
 * Returns a paginated, searchable list of categories for the admin dashboard.
 * Includes a product count per category.
 */
export async function listCategories(
    db: Database,
    options: {
        page?: number;
        limit?: number;
        search?: string;
        showTrashed?: boolean;
        sort?: "name" | "createdAt" | "updatedAt";
        order?: "asc" | "desc";
    } = {},
) {
    const {
        page: rawPage = 1,
        limit: rawLimit = 10,
        search = "",
        showTrashed = false,
        sort = "updatedAt",
        order = "desc",
    } = options;
    const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
    const limit = Number.isSafeInteger(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 500)
        : 10;

    const whereConditions: (SQL | undefined)[] = [];

    if (showTrashed) {
        whereConditions.push(isNotNull(categories.deletedAt));
    } else {
        whereConditions.push(isNull(categories.deletedAt));
    }

    if (search) {
        const cond = ftsMatch("categories_fts", "categories", search);
        if (cond) whereConditions.push(cond);
    }

    const offset = (page - 1) * limit;
    const whereClause = whereConditions.length > 0 ? and(...whereConditions) : undefined;

    const countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(categories)
        .where(whereClause);

    const sortField = (() => {
        switch (sort) {
            case "name": return categories.name;
            case "createdAt": return categories.createdAt;
            default: return categories.updatedAt;
        }
    })();

    const resultsQuery = db
        .select({
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
            createdAt: sql<number>`CAST(${categories.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${categories.updatedAt} AS INTEGER)`,
            deletedAt: sql<number>`CAST(${categories.deletedAt} AS INTEGER)`,
            productCount: sql<number>`(
                SELECT count(*)
                FROM ${products}
                WHERE ${products.categoryId} = ${categories.id}
                  AND ${products.deletedAt} IS NULL
            )`,
        })
        .from(categories)
        .where(whereClause)
        .limit(limit)
        .offset(offset)
        .orderBy(order === "asc" ? asc(sortField) : desc(sortField));

    const [countArr, results] = await db.batch([
        countQuery,
        resultsQuery,
    ]);
    const count = countArr[0]?.count ?? 0;

    const formattedCategories = results.map((category) => ({
        ...category,
        createdAt: category.createdAt ? new Date(category.createdAt * 1000).toISOString() : null,
        updatedAt: category.updatedAt ? new Date(category.updatedAt * 1000).toISOString() : null,
        deletedAt: category.deletedAt ? new Date(category.deletedAt * 1000).toISOString() : null,
        productCount: Number(category.productCount ?? 0),
    }));

    return {
        categories: formattedCategories,
        pagination: {
            total: count,
            page,
            limit,
            totalPages: Math.ceil(count / limit),
        },
    };
}

/**
 * Returns a single category by slug (public storefront).
 */
export async function getCategoryBySlug(db: Database, slug: string) {
    return db
        .select({
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
            createdAt: sql<number>`CAST(${categories.createdAt} AS INTEGER)`,
        })
        .from(categories)
        .where(and(eq(categories.slug, slug), isNull(categories.deletedAt)))
        .get();
}

/**
 * Returns a single category by ID.
 */
export async function getCategoryById(db: Database, id: string) {
    return db
        .select({
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
            deletedAt: sql<number | null>`CAST(${categories.deletedAt} AS INTEGER)`,
            createdAt: sql<number>`CAST(${categories.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${categories.updatedAt} AS INTEGER)`,
        })
        .from(categories)
        .where(eq(categories.id, id))
        .get();
}

// ─────────────────────────────────────────
// Admin mutations
// ─────────────────────────────────────────

/**
 * Creates a new category. Throws if the slug is already in use.
 */
export async function createCategory(
    db: Database,
    data: CreateCategoryInput,
): Promise<{ id: string }> {
    const existing = await db
        .select({ id: categories.id, deletedAt: categories.deletedAt })
        .from(categories)
        .where(eq(categories.slug, data.slug))
        .get();

    if (existing) {
        throw new ConflictError(
            existing.deletedAt
                ? "A category with this slug already exists in trash. Restore it or choose another slug."
                : "A category with this slug already exists.",
        );
    }

    const categoryId = "cat_" + nanoid();

    try {
        await db.insert(categories).values({
            id: categoryId,
            name: data.name,
            description: data.description,
            slug: data.slug,
            imageUrl: data.image?.url || null,
            metaTitle: data.metaTitle,
            metaDescription: data.metaDescription,
            canonicalPath: data.canonicalPath ?? null,
            noIndex: data.noIndex ?? false,
            excludeFromSitemap: data.excludeFromSitemap ?? false,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
            deletedAt: null,
        });
    } catch (error) {
        if (isCategorySlugConstraintError(error)) {
            throw new ConflictError("A category with this slug already exists.");
        }
        throw error;
    }

    return { id: categoryId };
}

/**
 * Updates a category. Throws if not found, or if slug is taken by another category.
 */
export async function updateCategory(
    db: Database,
    id: string,
    data: UpdateCategoryInput,
): Promise<void> {
    const existing = await db
        .select({ id: categories.id, deletedAt: categories.deletedAt })
        .from(categories)
        .where(eq(categories.id, id))
        .get();

    if (!existing) throw new NotFoundError("Category not found");
    if (existing.deletedAt) {
        throw new ConflictError("Restore this category before editing it.");
    }

    const slugConflict = await db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.slug, data.slug), ne(categories.id, id)))
        .get();

    if (slugConflict) {
        throw new ConflictError("A category with this slug already exists, including in trash.");
    }

    try {
        await safeBatch(db, [
            categoryActiveStateGuard(db, [id]),
            db
                .update(categories)
                .set({
                    name: data.name,
                    description: data.description,
                    slug: data.slug,
                    imageUrl: data.image?.url || null,
                    metaTitle: data.metaTitle,
                    metaDescription: data.metaDescription,
                    canonicalPath: data.canonicalPath ?? null,
                    noIndex: data.noIndex ?? false,
                    excludeFromSitemap: data.excludeFromSitemap ?? false,
                    updatedAt: sql`unixepoch()`,
                })
                .where(and(eq(categories.id, id), isNull(categories.deletedAt))),
            categoryProductRevisionBump(db, [id]),
        ] as never);
    } catch (error) {
        if (isCategorySlugConstraintError(error)) {
            throw new ConflictError("A category with this slug already exists.");
        }
        if (error instanceof Error && /CATEGORY_ACTIVE_STATE_REQUIRED|malformed json/i.test(error.message)) {
            throw new ConflictError("Restore this category before editing it.");
        }
        throw error;
    }
}

/**
 * Soft-deletes a category. Throws if products are still assigned to it.
 */
export async function deleteCategory(db: Database, id: string): Promise<void> {
    await bulkDeleteCategories(db, [id], false);
}

/**
 * Bulk soft-delete or permanent-delete categories.
 * Permanent delete also cleans up collection configs.
 */
export async function bulkDeleteCategories(
    db: Database,
    categoryIds: string[],
    permanent = false,
): Promise<void> {
    if (categoryIds.length === 0) return;
    const uniqueCategoryIds = [...new Set(categoryIds)];
    if (uniqueCategoryIds.length > CATEGORY_BATCH_LIMIT) {
        throw new ValidationError(`Delete at most ${CATEGORY_BATCH_LIMIT} categories at a time.`);
    }

    const referencedProducts = await db
        .select({ id: products.id, name: products.name, categoryId: products.categoryId })
        .from(products)
        .where(and(inArray(products.categoryId, uniqueCategoryIds), isNull(products.deletedAt)))
        .limit(5)
        .all();

    if (referencedProducts.length > 0) {
        const categoryCount = new Set(referencedProducts.map((p) => p.categoryId)).size;
        const productCount = referencedProducts.length;
        throw new ValidationError(
            `Cannot delete ${categoryCount === 1 ? "category" : "categories"} because ${productCount} product${productCount === 1 ? "" : "s"} ${productCount === 1 ? "is" : "are"} still assigned to ${categoryCount === 1 ? "it" : "them"}.`,
            {
                suggestion: "Please delete the products permanently or move them to another category first.",
                affectedProducts: referencedProducts.map((p) => ({ id: p.id, name: p.name })),
            },
        );
    }

    if (permanent) {
        const categoryStates = await db
            .select({ id: categories.id, deletedAt: categories.deletedAt })
            .from(categories)
            .where(inArray(categories.id, uniqueCategoryIds))
            .all();
        if (
            categoryStates.length !== uniqueCategoryIds.length ||
            categoryStates.some((category) => !category.deletedAt)
        ) {
            throw new ConflictError(
                "Only categories already in trash can be permanently deleted.",
            );
        }

        const affectedCollections = await db
            .select({
                id: collections.id,
                name: collections.name,
                config: collections.config,
                isActive: collections.isActive,
                deletedAt: collections.deletedAt,
            })
            .from(collections)
            .where(sql`
                CASE
                    WHEN json_valid(${collections.config}) = 0 THEN 1
                    WHEN json_type(${collections.config}, '$.categoryIds') IS NOT NULL
                         AND json_type(${collections.config}, '$.categoryIds') <> 'array'
                    THEN 1
                    ELSE EXISTS (
                        SELECT 1
                        FROM json_each(${collections.config}, '$.categoryIds') AS membership
                        INNER JOIN json_each(${JSON.stringify(uniqueCategoryIds)}) AS target
                            ON CAST(membership.value AS TEXT) = CAST(target.value AS TEXT)
                    )
                END = 1
            `)
            .all();

        const statements: SQLiteBatchItem[] = [
            categoryDeleteUsageGuard(db, uniqueCategoryIds),
            db.update(products)
                .set({
                    aggregateRevision: sql`${products.aggregateRevision} + 1`,
                    updatedAt: sql`unixepoch()`,
                })
                .where(and(
                    inArray(products.categoryId, uniqueCategoryIds),
                    allCategoriesTrashedCondition(uniqueCategoryIds),
                )),
        ];
        for (const collection of affectedCollections) {
            let config: Record<string, unknown>;
            try {
                const parsed = JSON.parse(collection.config) as unknown;
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    throw new Error("invalid collection config");
                }
                config = parsed as Record<string, unknown>;
            } catch {
                throw new ConflictError(
                    `Collection ${collection.id} has invalid configuration. Repair it before permanently deleting categories.`,
                );
            }
            if (config.categoryIds === undefined) continue;
            if (!Array.isArray(config.categoryIds)) {
                throw new ConflictError(
                    `Collection ${collection.id} has invalid category membership. Repair it before permanently deleting categories.`,
                );
            }
            if (config.categoryIds.some((categoryId) => typeof categoryId !== "string")) {
                throw new ConflictError(
                    `Collection ${collection.id} has invalid category membership. Repair it before permanently deleting categories.`,
                );
            }

            const categoryIds = config.categoryIds.filter(
                (categoryId): categoryId is string => typeof categoryId === "string",
            );
            const updated = categoryIds.filter(
                (categoryId) => !uniqueCategoryIds.includes(categoryId),
            );
            if (updated.length === categoryIds.length) continue;
            if (
                collection.deletedAt == null &&
                collection.isActive &&
                config.source === "dynamic" &&
                updated.length === 0
            ) {
                throw new ValidationError(
                    `Category deletion would leave active collection “${collection.name}” without a source.`,
                    {
                        suggestion:
                            "Add another category to the collection or deactivate it before deleting this category permanently.",
                    },
                );
            }
            config.categoryIds = updated;
            statements.push(
                db
                    .update(collections)
                    .set({
                        config: JSON.stringify(config),
                        updatedAt: sql`unixepoch()`,
                    })
                    .where(and(
                        eq(collections.id, collection.id),
                        allCategoriesTrashedCondition(uniqueCategoryIds),
                    )),
            );
        }

        statements.push(
            db.delete(categories)
                .where(and(
                    inArray(categories.id, uniqueCategoryIds),
                    isNotNull(categories.deletedAt),
                    allCategoriesTrashedCondition(uniqueCategoryIds),
                ))
                .returning({ id: categories.id }),
        );
        try {
            const results = await safeBatch(db, statements as never) as unknown[][];
            const deletedRows = results.at(-1) ?? [];
            if (deletedRows.length !== uniqueCategoryIds.length) {
                throw new ConflictError(
                    "Only categories already in trash can be permanently deleted.",
                );
            }
        } catch (error) {
            if (
                error instanceof Error &&
                /CATEGORY_DELETE_IN_USE|malformed json/i.test(error.message)
            ) {
                throw new ValidationError(
                    "Cannot delete categories while active products are still assigned to them.",
                    {
                        suggestion:
                            "Move the products to another category or permanently delete them first.",
                    },
                );
            }
            throw error;
        }
    } else {
        try {
            await safeBatch(db, [
                categoryDeleteUsageGuard(db, uniqueCategoryIds),
                db
                    .update(categories)
                    .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
                    .where(and(
                        inArray(categories.id, uniqueCategoryIds),
                        isNull(categories.deletedAt),
                    )),
                categoryProductRevisionBump(db, uniqueCategoryIds),
            ] as never);
        } catch (error) {
            if (
                error instanceof Error &&
                /CATEGORY_DELETE_IN_USE|malformed json/i.test(error.message)
            ) {
                throw new ValidationError(
                    "Cannot delete categories while active products are still assigned to them.",
                    {
                        suggestion:
                            "Move the products to another category or permanently delete them first.",
                    },
                );
            }
            throw error;
        }
    }
}

/**
 * Restores soft-deleted categories.
 */
export async function restoreCategories(db: Database, categoryIds: string[]): Promise<void> {
    if (categoryIds.length === 0) return;

    const uniqueCategoryIds = [...new Set(categoryIds)];
    if (uniqueCategoryIds.length > CATEGORY_BATCH_LIMIT) {
        throw new ValidationError(`Restore at most ${CATEGORY_BATCH_LIMIT} categories at a time.`);
    }

    try {
        await safeBatch(db, [
            categoryTrashedStateGuard(db, uniqueCategoryIds),
            db
                .update(categories)
                .set({ deletedAt: null, updatedAt: sql`unixepoch()` })
                .where(and(
                    inArray(categories.id, uniqueCategoryIds),
                    isNotNull(categories.deletedAt),
                )),
            categoryProductRevisionBump(db, uniqueCategoryIds),
        ] as never);
    } catch (error) {
        if (error instanceof Error && /CATEGORY_TRASHED_STATE_REQUIRED|malformed json/i.test(error.message)) {
            throw new ConflictError("Only categories currently in trash can be restored.");
        }
        throw error;
    }
}

/**
 * Permanently deletes a single category.
 * Throws ConflictError if products still reference this category.
 */
export async function permanentlyDeleteCategory(db: Database, id: string): Promise<void> {
    await bulkDeleteCategories(db, [id], true);
}
