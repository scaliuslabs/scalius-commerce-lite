// src/modules/categories/categories.storefront.ts
// Public/storefront category queries for use by API routes.

import { categories } from "@scalius/database/schema";
import { sql, eq, and } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { publicCategoryConditions } from "./categories.publication";

export const STOREFRONT_CATEGORY_TEXT_CHUNK = 12_000;

export type StorefrontCategorySection = "summary" | "text";
export type StorefrontCategoryTextField = "description" | "content";

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

/** Bounded public discovery rows; rich text is reconstructed through getPublicCategorySection. */
export async function getPublicCategorySummaries(
    db: Database,
    options: { page?: number; limit?: number } = {},
) {
    const page = Number.isSafeInteger(options.page) && Number(options.page) > 0
        ? Number(options.page)
        : 1;
    const limit = Number.isSafeInteger(options.limit)
        ? Math.min(Math.max(Number(options.limit), 1), 50)
        : 20;
    const where = and(...publicCategoryConditions());
    const countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(categories)
        .where(where);
    const rowsQuery = db
        .select({
            id: categories.id,
            name: categories.name,
            slug: categories.slug,
            imageUrl: categories.imageUrl,
            descriptionCharacters: sql<number>`length(coalesce(${categories.description}, ''))`,
            contentCharacters: sql<number>`length(coalesce(${categories.content}, ''))`,
            updatedAt: sql<number>`CAST(${categories.updatedAt} AS INTEGER)`,
        })
        .from(categories)
        .where(where)
        .orderBy(categories.name)
        .limit(limit)
        .offset((page - 1) * limit);
    const [counts, rows] = await db.batch([countQuery, rowsQuery]);
    const total = Number(counts[0]?.count ?? 0);
    return {
        categories: rows.map((category) => ({
            ...category,
            descriptionCharacters: Number(category.descriptionCharacters ?? 0),
            contentCharacters: Number(category.contentCharacters ?? 0),
            updatedAt: category.updatedAt
                ? new Date(Number(category.updatedAt) * 1000).toISOString()
                : null,
        })),
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
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
            content: categories.content,
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
 * Bounded agent projection for categories whose buyer-facing rich text can be
 * up to 100,000 characters. Browser aggregates keep their existing contract;
 * agents reconstruct the same content through explicit text chunks.
 */
export async function getPublicCategorySection(
    db: Database,
    slug: string,
    section: StorefrontCategorySection,
    options: { field?: StorefrontCategoryTextField; offset?: number } = {},
) {
    if (section === "summary") {
        const category = await db
            .select({
                id: categories.id,
                name: categories.name,
                slug: categories.slug,
                imageUrl: categories.imageUrl,
                metaTitle: categories.metaTitle,
                metaDescription: categories.metaDescription,
                canonicalPath: categories.canonicalPath,
                noIndex: categories.noIndex,
                excludeFromSitemap: categories.excludeFromSitemap,
                descriptionCharacters: sql<number>`length(coalesce(${categories.description}, ''))`,
                contentCharacters: sql<number>`length(coalesce(${categories.content}, ''))`,
                createdAt: sql<number>`CAST(${categories.createdAt} AS INTEGER)`,
                updatedAt: sql<number>`CAST(${categories.updatedAt} AS INTEGER)`,
            })
            .from(categories)
            .where(and(eq(categories.slug, slug), ...publicCategoryConditions()))
            .get();
        if (!category) return null;
        return {
            section,
            category: {
                ...category,
                descriptionCharacters: Number(category.descriptionCharacters ?? 0),
                contentCharacters: Number(category.contentCharacters ?? 0),
                createdAt: category.createdAt ? new Date(category.createdAt * 1000).toISOString() : null,
                updatedAt: category.updatedAt ? new Date(category.updatedAt * 1000).toISOString() : null,
            },
        };
    }

    const field = options.field ?? "description";
    const offset = options.offset ?? 0;
    const column = field === "content" ? categories.content : categories.description;
    const category = await db
        .select({
            value: sql<string>`substr(coalesce(${column}, ''), ${offset + 1}, ${STOREFRONT_CATEGORY_TEXT_CHUNK})`,
            totalCharacters: sql<number>`length(coalesce(${column}, ''))`,
            isNull: sql<number>`CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END`,
        })
        .from(categories)
        .where(and(eq(categories.slug, slug), ...publicCategoryConditions()))
        .get();
    if (!category) return null;
    const totalCharacters = Number(category.totalCharacters ?? 0);
    const value = category.value ?? "";
    const nextOffset = offset + value.length < totalCharacters ? offset + value.length : null;
    return {
        section,
        field,
        value,
        totalCharacters,
        offset,
        nextOffset,
        isNull: Boolean(category.isNull),
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
            content: categories.content,
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
