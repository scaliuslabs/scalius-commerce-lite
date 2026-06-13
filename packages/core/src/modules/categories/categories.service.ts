// src/modules/categories/categories.service.ts
// All DB queries and business logic for the categories domain.
// Used by both admin Hono routes and storefront Hono routes.

import { categories, products, collections } from "@scalius/database/schema";
import { sql, and, isNull, isNotNull, eq, desc, asc, inArray, type SQL } from "drizzle-orm";
import { ftsMatch } from "../../search/fts5";
import { nanoid } from "nanoid";
import type { CreateCategoryInput, UpdateCategoryInput } from "./categories.validation";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ConflictError, ValidationError } from "@scalius/core/errors";

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
        page = 1,
        limit: rawLimit = 10,
        search = "",
        showTrashed = false,
        sort = "updatedAt",
        order = "desc",
    } = options;
    const limit = Math.min(Math.max(rawLimit, 1), 500);

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
            createdAt: sql<number>`CAST(${categories.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${categories.updatedAt} AS INTEGER)`,
            deletedAt: sql<number>`CAST(${categories.deletedAt} AS INTEGER)`,
        })
        .from(categories)
        .where(whereClause)
        .limit(limit)
        .offset(offset)
        .orderBy(order === "asc" ? asc(sortField) : desc(sortField));

    const countsQuery = db
        .select({
            categoryId: products.categoryId,
            count: sql<number>`count(*)`.as("count"),
        })
        .from(products)
        .where(and(isNull(products.deletedAt), eq(products.isActive, true)))
        .groupBy(products.categoryId);

    const [countArr, results, productCounts] = await db.batch([
        countQuery,
        resultsQuery,
        countsQuery,
    ]);
    const count = countArr[0]?.count ?? 0;

    const countMap = new Map(
        productCounts.map(({ categoryId, count }: { categoryId: string | null; count: number }) => [categoryId, Number(count)]),
    );

    const formattedCategories = results.map((category) => ({
        ...category,
        createdAt: category.createdAt ? new Date(category.createdAt * 1000).toISOString() : null,
        updatedAt: category.updatedAt ? new Date(category.updatedAt * 1000).toISOString() : null,
        deletedAt: category.deletedAt ? new Date(category.deletedAt * 1000).toISOString() : null,
        productCount: countMap.get(category.id) || 0,
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
        .select({ id: categories.id })
        .from(categories)
        .where(sql`slug = ${data.slug} AND deleted_at IS NULL`)
        .get();

    if (existing) {
        throw new ConflictError("A category with this slug already exists");
    }

    const categoryId = "cat_" + nanoid();

    await db.insert(categories).values({
        id: categoryId,
        name: data.name,
        description: data.description || null,
        slug: data.slug,
        imageUrl: data.image?.url || null,
        metaTitle: data.metaTitle || null,
        metaDescription: data.metaDescription || null,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
        deletedAt: null,
    });

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
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.id, id))
        .get();

    if (!existing) throw new NotFoundError("Category not found");

    const slugConflict = await db
        .select({ id: categories.id })
        .from(categories)
        .where(sql`${categories.slug} = ${data.slug} AND ${categories.deletedAt} IS NULL`)
        .get();

    if (slugConflict && slugConflict.id !== id) {
        throw new ConflictError("A category with this slug already exists");
    }

    await db
        .update(categories)
        .set({
            name: data.name,
            description: data.description,
            slug: data.slug,
            imageUrl: data.image?.url || null,
            metaTitle: data.metaTitle,
            metaDescription: data.metaDescription,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(categories.id, id));
}

/**
 * Soft-deletes a category. Throws if products are still assigned to it.
 */
export async function deleteCategory(db: Database, id: string): Promise<void> {
    const referencedProducts = await db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(and(eq(products.categoryId, id), isNull(products.deletedAt)))
        .limit(5)
        .all();

    if (referencedProducts.length > 0) {
        const count = referencedProducts.length;
        throw new ValidationError(
            `Cannot delete category because ${count} product${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} still assigned to it.`,
            {
                suggestion: "Please delete the products permanently or move them to another category first.",
                affectedProducts: referencedProducts.map((p) => ({ id: p.id, name: p.name })),
            },
        );
    }

    await db
        .update(categories)
        .set({ deletedAt: sql`unixepoch()` })
        .where(eq(categories.id, id));
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

    const referencedProducts = await db
        .select({ id: products.id, name: products.name, categoryId: products.categoryId })
        .from(products)
        .where(and(inArray(products.categoryId, categoryIds), isNull(products.deletedAt)))
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
        // Clean up collection configs that reference deleted categories
        const affectedCollections = await db
            .select()
            .from(collections)
            .where(isNull(collections.deletedAt))
            .all();

        for (const collection of affectedCollections) {
            try {
                const config = JSON.parse(collection.config);
                if (Array.isArray(config.categoryIds)) {
                    const updated = config.categoryIds.filter((cid: string) => !categoryIds.includes(cid));
                    if (updated.length !== config.categoryIds.length) {
                        config.categoryIds = updated;
                        await db
                            .update(collections)
                            .set({ config: JSON.stringify(config) })
                            .where(eq(collections.id, collection.id));
                    }
                }
            } catch (e) {
                console.warn(`Failed to parse collection config for ${collection.id}:`, e);
            }
        }

        await db.delete(categories).where(inArray(categories.id, categoryIds));
    } else {
        await db
            .update(categories)
            .set({ deletedAt: sql`unixepoch()` })
            .where(inArray(categories.id, categoryIds));
    }
}

/**
 * Restores soft-deleted categories.
 */
export async function restoreCategories(db: Database, categoryIds: string[]): Promise<void> {
    if (categoryIds.length === 0) return;

    await db
        .update(categories)
        .set({ deletedAt: null })
        .where(inArray(categories.id, categoryIds));
}

/**
 * Permanently deletes a single category.
 * Throws ConflictError if products still reference this category.
 */
export async function permanentlyDeleteCategory(db: Database, id: string): Promise<void> {
    const productCount = await db.select({ count: sql<number>`count(*)` }).from(products).where(and(eq(products.categoryId, id), isNull(products.deletedAt))).get();
    if (productCount && productCount.count > 0) {
        throw new ConflictError(`Cannot permanently delete: ${productCount.count} products still use this category`);
    }
    await db.delete(categories).where(eq(categories.id, id));
}
