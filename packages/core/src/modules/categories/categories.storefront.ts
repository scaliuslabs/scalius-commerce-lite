// src/modules/categories/categories.storefront.ts
// Public/storefront category queries for use by API routes.

import { categories } from "@scalius/database/schema";
import { sql, eq, and } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { publicCategoryConditions } from "./categories.publication";
import { deps } from "../../cache-deps";
import {
  presentStorefrontCustomFields,
  selectStorefrontCustomFieldRows,
  type StorefrontCustomFieldRow,
} from "../custom-fields";
import {
    publicCategoryTreeContextQueries,
    publishedCategoryIdBySlug,
    type CategoryBreadcrumbItem,
    type PublicCategoryChild,
} from "./categories.tree";
import {
    NAME_FIELDS,
    localizedSlugSql,
    localizedSlugsSql,
    parseLocalizedSlugs,
    translateRow,
    translateRows,
    translationColumns,
    type TranslationScope,
} from "../translations";

/** A category's translated text (MARKETS-DESIGN D9). */
const CATEGORY_FIELDS = { name: "name", description: "description", content: "content", metaTitle: "metaTitle", metaDescription: "metaDescription" } as const;

/** Sub-category links a category page carries (pills, shelves, drill levels). */
export const STOREFRONT_CATEGORY_PAGE_CHILD_LIMIT = 48;

export const STOREFRONT_CATEGORY_TEXT_CHUNK = 12_000;

export type StorefrontCategorySection = "summary" | "text";
export type StorefrontCategoryTextField = "description" | "content";

/** Category URLs one sitemap document lists at most (the sitemap protocol allows 50k). */
export const CATEGORY_SITEMAP_LIMIT = 5000;

/**
 * Category pages for XML discovery: published, live, not `noIndex` and not
 * `excludeFromSitemap`, filtered before the limit (never after a page read).
 * `updatedAt` is the row's own last change, the page's lastmod.
 */
export async function getPublicCategorySitemapEntries(db: Database, translation: TranslationScope | null = null) {
    deps.anyCategory();
    // Sitemap lastmod: a write that changes only updated_at advances the
    // discovery key (cache-deps registry), not a category key.
    deps.discoveryMembership();
    // A presence's sitemap: each category at its handle in the presence's language.
    if (translation) deps.localizedSlugs("category", translation.locale);
    const rows = await db
        .select({
            slug: categories.slug,
            ...(translation ? { trSlug: localizedSlugSql(translation, "category", categories.id) } : {}),
            canonicalPath: categories.canonicalPath,
            updatedAt: sql<number | null>`CAST(COALESCE(${categories.updatedAt}, ${categories.createdAt}) AS INTEGER)`,
        })
        .from(categories)
        .where(and(
            ...publicCategoryConditions(),
            eq(categories.noIndex, false),
            eq(categories.excludeFromSitemap, false),
        ))
        .orderBy(categories.name, categories.id)
        .limit(CATEGORY_SITEMAP_LIMIT)
        .all();
    return rows.map((row) => ({
        slug: (row as { trSlug?: string | null }).trSlug || row.slug,
        canonicalPath: row.canonicalPath,
        updatedAt: row.updatedAt ? new Date(Number(row.updatedAt) * 1000).toISOString() : null,
    }));
}

/**
 * Returns all active categories for the storefront (navigation, listing).
 * No pagination — categories are typically <100 rows and cached aggressively.
 */
export async function getPublicCategories(db: Database, translation: TranslationScope | null = null) {
    // Category reads list, look up by slug or walk the tree: any category
    // row (and closure) change can change them, and category writes are rare.
    deps.anyCategory();
    const read = await db
        .select({
            ...translationColumns(translation, "category", categories.id),
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
            parentId: categories.parentId,
            depth: categories.depth,
            createdAt: sql<number>`CAST(${categories.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${categories.updatedAt} AS INTEGER)`,
        })
        .from(categories)
        .where(and(...publicCategoryConditions()))
        .orderBy(categories.name)
        .all();
    const categoriesList = translateRows(translation, "category", read, { name: "name", description: "description", metaTitle: "metaTitle", metaDescription: "metaDescription" });

    return categoriesList.map((c) => ({
        ...c,
        createdAt: c.createdAt ? new Date(c.createdAt * 1000).toISOString() : null,
        updatedAt: c.updatedAt ? new Date(c.updatedAt * 1000).toISOString() : null,
    }));
}

/** Bounded public discovery rows; rich text is reconstructed through getPublicCategorySection. */
export async function getPublicCategorySummaries(
    db: Database,
    options: { page?: number; limit?: number; translation?: TranslationScope | null } = {},
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
            ...translationColumns(options.translation ?? null, "category", categories.id),
        })
        .from(categories)
        .where(where)
        .orderBy(categories.name)
        .limit(limit)
        .offset((page - 1) * limit);
    deps.anyCategory();
    const [counts, rows] = await db.batch([countQuery, rowsQuery]);
    const total = Number(counts[0]?.count ?? 0);
    return {
        categories: translateRows(options.translation ?? null, "category", rows, NAME_FIELDS).map((category) => ({
            ...category,
            descriptionCharacters: Number(category.descriptionCharacters ?? 0),
            contentCharacters: Number(category.contentCharacters ?? 0),
        })),
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
}

/**
 * Returns a single category by slug for the storefront, with its published
 * sub-categories and its public breadcrumb (root first, ending with the
 * category). The three reads share one batch, so the tree adds no round trip.
 * Returns null if not found, not published or soft-deleted.
 */
export async function getPublicCategoryBySlug(db: Database, slug: string, translation: TranslationScope | null = null) {
    deps.anyCategory();
    // A localized handle can name the category (MARKETS-DESIGN D9).
    deps.localizedSlugSpace("category");
    const tree = publicCategoryTreeContextQueries(db, slug, STOREFRONT_CATEGORY_PAGE_CHILD_LIMIT, translation);
    const categoryId = publishedCategoryIdBySlug(slug, translation);
    const [rows, children, breadcrumb, customFieldRows] = await db.batch([
        db
            .select({
                // Its handle in every language (hreflang alternates), at the root too.
                localizedSlugs: localizedSlugsSql("category", categories.id),
                ...translationColumns(translation, "category", categories.id),
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
                parentId: categories.parentId,
                depth: categories.depth,
                listingTemplate: categories.listingTemplate,
                createdAt: sql<number>`CAST(${categories.createdAt} AS INTEGER)`,
                updatedAt: sql<number>`CAST(${categories.updatedAt} AS INTEGER)`,
            })
            .from(categories)
            .where(and(sql`${categories.id} = ${categoryId}`, ...publicCategoryConditions()))
            .limit(1),
        tree.children,
        tree.breadcrumb,
        selectStorefrontCustomFieldRows(db, "category", categoryId),
    ]);
    const read = rows[0];
    if (!read) return null;
    const { localizedSlugs: localizedSlugsText, ...category } = translateRow(translation, "category", read, CATEGORY_FIELDS)!;
    deps.resourceHandles(translation !== null, "category", category.id);
    const alternateSlugs = parseLocalizedSlugs(localizedSlugsText);

    return {
        ...category,
        /** The category's handle by language (`localized_slugs`) and its source handle; absent without a localized handle. */
        ...(Object.keys(alternateSlugs).length > 0 ? { localizedSlugs: alternateSlugs, sourceSlug: read.slug } : {}),
        depth: Number(category.depth),
        /** Storefront-visible custom fields, in the merchant's order. */
        customFields: presentStorefrontCustomFields(customFieldRows as StorefrontCustomFieldRow[]),
        children: translateRows(translation, "category", children as PublicCategoryChild[], NAME_FIELDS),
        breadcrumb: translateRows(translation, "category", breadcrumb as CategoryBreadcrumbItem[], NAME_FIELDS).map((item) => ({ ...item, depth: Number(item.depth) })),
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
    options: { field?: StorefrontCategoryTextField; offset?: number; translation?: TranslationScope | null } = {},
) {
    deps.anyCategory();
    deps.localizedSlugSpace("category");
    const categoryId = publishedCategoryIdBySlug(slug, options.translation ?? null);
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
            .where(and(sql`${categories.id} = ${categoryId}`, ...publicCategoryConditions()))
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
        .where(and(sql`${categories.id} = ${categoryId}`, ...publicCategoryConditions()))
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
    deps.anyCategory();
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
