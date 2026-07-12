// src/modules/categories/categories.storefront.ts
// Public/storefront category queries for use by API routes.

import { categories } from "@scalius/database/schema";
import { sql, eq, and } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { publicCategoryConditions } from "./categories.publication";

/**
 * Returns all active categories for the storefront (navigation, listing).
 * No pagination — categories are typically <100 rows and cached aggressively.
 */
export async function getPublicCategories(db: Database) {
    const categoriesList = await db
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
        })
        .from(categories)
        .where(and(...publicCategoryConditions()))
        .orderBy(categories.name)
        .all();

    return categoriesList.map((c) => ({
        ...c,
        createdAt: c.createdAt ? new Date(c.createdAt * 1000).toISOString() : null,
        updatedAt: c.updatedAt ? new Date(c.updatedAt * 1000).toISOString() : null,
    }));
}

/**
 * Returns a single category by slug for the storefront.
 * Returns null if not found or soft-deleted.
 */
export async function getPublicCategoryBySlug(db: Database, slug: string) {
    const category = await db
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
        })
        .from(categories)
        .where(and(eq(categories.slug, slug), ...publicCategoryConditions()))
        .get();

    if (!category) return null;

    return {
        ...category,
        createdAt: category.createdAt ? new Date(category.createdAt * 1000).toISOString() : null,
        updatedAt: category.updatedAt ? new Date(category.updatedAt * 1000).toISOString() : null,
    };
}

/**
 * Returns a single category by ID for public routes.
 * Filters out soft-deleted categories. Includes both createdAt and updatedAt.
 */
export async function getPublicCategoryById(db: Database, id: string) {
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
            updatedAt: sql<number>`CAST(${categories.updatedAt} AS INTEGER)`,
        })
        .from(categories)
        .where(and(eq(categories.id, id), ...publicCategoryConditions()))
        .get();
}

/**
 * Returns the full category tree (flat list) for storefront navigation.
 * Same as getPublicCategories for now (flat schema), but named explicitly
 * for nav use so it can be extended with hierarchy later.
 */
export async function getPublicCategoryTree(db: Database) {
    return getPublicCategories(db);
}
