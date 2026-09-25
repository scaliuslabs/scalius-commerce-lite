// src/modules/navigation/navigation.service.ts
// All DB queries and business logic for the navigation domain.

import { categories, collections, pages, products } from "@scalius/database/schema";
import { and, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { NotFoundError } from "@scalius/core/errors";
import { getPublicCategoryById } from "../categories/categories.storefront";
import { getStorefrontProducts } from "../catalog/listing";
import { resolvePublicAttributeFilters } from "../catalog/facets";
import { publicCategoryConditions } from "../categories/categories.publication";
import { resolveNavigationConfigs } from "./navigation.resolver";
import type {
    NavigationTargetItem,
    ResolvedNavigationItem,
} from "@scalius/shared/navigation-target";
import { normalizeResourceCanonicalPath } from "@scalius/shared/seo-canonical";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export type NavigationItem = ResolvedNavigationItem;

export interface NavigationPreviewProductCountInput {
    categoryId: string;
    search?: string;
    minPrice?: number;
    maxPrice?: number;
    freeDelivery?: "true" | "false";
    hasDiscount?: "true" | "false";
    attributeFilters?: { slug: string; value: string }[];
}

// ─────────────────────────────────────────
// Admin Queries
// ─────────────────────────────────────────

/** Get available categories + pages for the admin nav item picker.
 *  Called by admin route: apps/api/src/routes/admin/navigation.ts (listItemsRoute handler) */
export async function getNavigationItems(db: Database) {
    const categoriesData = await db
        .select({
            id: categories.id,
            name: categories.name,
            slug: categories.slug,
            canonicalPath: categories.canonicalPath,
            type: sql<string>`'category'`.as("type"),
        })
        .from(categories)
        .where(and(...publicCategoryConditions()))
        .orderBy(categories.name)
        .limit(100);

    const categoryItems = categoriesData.map((cat) => ({
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        type: cat.type,
        url: normalizeResourceCanonicalPath("category", cat.canonicalPath)
            ?? `/categories/${cat.slug}`,
    }));

    const pagesData = await db
        .select({
            id: pages.id,
            title: pages.title,
            slug: pages.slug,
            type: sql<string>`'page'`.as("type"),
            isPublished: pages.isPublished,
        })
        .from(pages)
        .where(sql`${pages.deletedAt} IS NULL AND ${pages.isPublished} = true`)
        .orderBy(pages.title)
        .limit(100);

    const pageItems = pagesData.map((page) => ({
        id: page.id,
        name: page.title,
        slug: page.slug,
        type: page.type,
        url: `/${page.slug}`,
    }));

    const productsData = await db
        .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            canonicalPath: products.canonicalPath,
        })
        .from(products)
        .where(sql`${products.deletedAt} IS NULL AND ${products.isActive} = true`)
        .orderBy(products.name)
        .limit(100);

    const collectionsData = await db
        .select({
            id: collections.id,
            name: collections.name,
            canonicalPath: collections.canonicalPath,
        })
        .from(collections)
        .where(sql`${collections.deletedAt} IS NULL AND ${collections.isActive} = true`)
        .orderBy(collections.name)
        .limit(100);

    return {
        categories: categoryItems,
        pages: pageItems,
        products: productsData.map((product) => ({
            id: product.id,
            name: product.name,
            slug: product.slug,
            type: "product",
            url: normalizeResourceCanonicalPath("product", product.canonicalPath)
                ?? `/products/${product.slug}`,
        })),
        collections: collectionsData.map((collection) => ({
            id: collection.id,
            name: collection.name,
            slug: collection.id,
            type: "collection",
            url: normalizeResourceCanonicalPath("collection", collection.canonicalPath)
                ?? `/collections/${collection.id}`,
        })),
    };
}

export async function getNavigationPreviewProductCount(
    db: Database,
    input: NavigationPreviewProductCountInput,
) {
    const category = await getPublicCategoryById(db, input.categoryId);
    if (!category) {
        throw new NotFoundError("Category not found");
    }

    // The preview filters as the storefront link would: slug=value pairs
    // resolved to typed facet filters.
    const filterValues: Record<string, string[]> = {};
    for (const filter of input.attributeFilters ?? []) {
        (filterValues[filter.slug] ??= []).push(filter.value);
    }
    const attributeFilters = await resolvePublicAttributeFilters(db, filterValues, []);
    const result = await getStorefrontProducts(db, {
        category: input.categoryId,
        search: input.search,
        minPrice: input.minPrice,
        maxPrice: input.maxPrice,
        freeDelivery: input.freeDelivery,
        hasDiscount: input.hasDiscount,
        page: 1,
        limit: 1,
        sort: "newest",
        attributeFilters,
    });

    return { count: result.pagination.total };
}

// ─────────────────────────────────────────
// Default Navigation Builder (shared logic)
// ─────────────────────────────────────────

/** Build default navigation from categories + pages when no saved config exists.
 *  WIRE: api-app should call this from routes/navigation.ts (getNavigationRoute handler)
 *  replacing the inline default nav builder at lines 103-153.
 *  Also usable by storefront.service.ts to replace its inline copy at lines 254-271. */
export async function buildDefaultNavigation(db: Database): Promise<NavigationItem[]> {
    const categoriesData = await db
        .select({ id: categories.id, name: categories.name, slug: categories.slug })
        .from(categories)
        .where(and(...publicCategoryConditions()))
        .orderBy(categories.name)
        .limit(90);

    const pagesData = await db
        .select({ id: pages.id, title: pages.title, slug: pages.slug })
        .from(pages)
        .where(sql`${pages.deletedAt} IS NULL AND ${pages.isPublished} = true`)
        .orderBy(pages.title)
        .limit(58);

    const nav: NavigationTargetItem[] = [{
        id: "home",
        target: { type: "internal_path", path: "/" },
        labelMode: "custom",
        customLabel: "Home",
    }];

    if (categoriesData.length > 0) {
        nav.push({
            id: "categories",
            target: { type: "label" },
            labelMode: "custom",
            customLabel: "Categories",
            subMenu: categoriesData.map((cat) => ({
                id: `cat_${cat.id}`,
                target: {
                    type: "resource" as const,
                    resourceType: "category" as const,
                    resourceId: cat.id,
                },
                labelMode: "resource" as const,
                lastKnownLabel: cat.name,
            })),
        });
    }

    pagesData.forEach((page) => {
        nav.push({
            id: `page_${page.id}`,
            target: {
                type: "resource",
                resourceType: "page",
                resourceId: page.id,
            },
            labelMode: "resource",
            lastKnownLabel: page.title,
        });
    });

    const projected = await resolveNavigationConfigs(
        db,
        { navigation: nav },
        {},
        "public",
    );
    return (projected.headerConfig.navigation ?? []) as NavigationItem[];
}
