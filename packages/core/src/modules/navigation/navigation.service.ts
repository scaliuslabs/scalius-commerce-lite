// src/modules/navigation/navigation.service.ts
// All DB queries and business logic for the navigation domain.

import { categories, pages, siteSettings } from "@scalius/database/schema";
import { isNull, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { NotFoundError } from "@scalius/core/errors";
import { getPublicCategoryById } from "../categories/categories.storefront";
import { getStorefrontProducts } from "../products/products.storefront";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface NavigationItem {
    id: string;
    title: string;
    href?: string;
    subMenu?: NavigationItem[];
}

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
            type: sql<string>`'category'`.as("type"),
        })
        .from(categories)
        .where(isNull(categories.deletedAt))
        .orderBy(categories.name);

    const categoryItems = categoriesData.map((cat) => ({
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        type: cat.type,
        url: `/categories/${cat.slug}`,
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
        .orderBy(pages.title);

    const pageItems = pagesData.map((page) => ({
        id: page.id,
        name: page.title,
        slug: page.slug,
        type: page.type,
        url: `/${page.slug}`,
    }));

    return {
        categories: categoryItems,
        pages: pageItems,
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
        attributeFilters: input.attributeFilters ?? [],
    });

    return { count: result.pagination.total };
}

/** Get navigation configs (header + footer) from siteSettings with safe JSON.parse.
 *  WIRE: api-app should call this from routes/admin/navigation.ts (getConfigRoute handler)
 *  replacing the inline DB query + raw JSON.parse at lines 88-96.
 *  Swap: `const { headerConfig, footerConfig } = await getNavigationMenus(db);`
 *  then `return ok(c, { headerConfig, footerConfig });` */
export async function getNavigationMenus(db: Database) {
    const [row] = await db
        .select({ headerConfig: siteSettings.headerConfig, footerConfig: siteSettings.footerConfig })
        .from(siteSettings)
        .limit(1);

    const headerConfig: Record<string, unknown> = (() => {
        try { return row?.headerConfig ? JSON.parse(row.headerConfig) : {}; } catch { return {}; }
    })();
    const footerConfig: Record<string, unknown> = (() => {
        try { return row?.footerConfig ? JSON.parse(row.footerConfig) : {}; } catch { return {}; }
    })();

    return { headerConfig, footerConfig };
}

/** Get a single navigation menu by type (header/footer/footer-menu-id).
 *  WIRE: api-app should call this from routes/navigation.ts (getNavigationByIdRoute handler)
 *  replacing the inline logic at lines 189-249.
 *  Swap: `const menu = await getNavigationMenu(db, id);`
 *  then `if (!menu) throw new NotFoundError(...);` + `return ok(c, { menu });` */
export async function getNavigationMenu(db: Database, id: string) {
    const { headerConfig, footerConfig } = await getNavigationMenus(db);

    if (id === "header") {
        const navigation = (headerConfig && typeof headerConfig === "object")
            ? (headerConfig as { navigation?: unknown }).navigation ?? []
            : [];
        return { id: "header", name: "Header Navigation", items: navigation };
    }

    if (id === "footer") {
        const menus = (footerConfig && typeof footerConfig === "object")
            ? (footerConfig as { menus?: unknown }).menus ?? []
            : [];
        return { id: "footer", name: "Footer Navigation", items: menus };
    }

    // Try to find a specific footer menu by id
    if (footerConfig && typeof footerConfig === "object") {
        const menus = (footerConfig as { menus?: Array<{ id?: string; title?: string; links?: unknown[] }> }).menus;
        if (Array.isArray(menus)) {
            const footerMenu = menus.find((m) => m.id === id || m.title === id);
            if (footerMenu) {
                return {
                    id: footerMenu.id || id,
                    name: footerMenu.title || "",
                    items: footerMenu.links ?? [],
                };
            }
        }
    }

    return null;
}

/** Save (create or update) navigation config for header or footer.
 *  WIRE: api-app should call this from routes/admin/navigation.ts (saveConfigRoute handler)
 *  replacing the inline DB query at lines 146-163.
 *  Route must still call `invalidateSiteSettingsCache(getKv())` after this function.
 *  Swap: `await saveNavigationConfig(db, type, config);`
 *  then `await invalidateSiteSettingsCache(getKv());` + `return ok(c, { message: ... });` */
export async function saveNavigationConfig(
    db: Database,
    type: "header" | "footer",
    config: Record<string, unknown>,
) {
    const configField = type === "header" ? "headerConfig" : "footerConfig";
    const configJson = JSON.stringify(config);

    const [existing] = await db
        .select({ id: siteSettings.id })
        .from(siteSettings)
        .limit(1);

    if (existing) {
        await db
            .update(siteSettings)
            .set({ [configField]: configJson, updatedAt: sql`unixepoch()` })
            .where(eq(siteSettings.id, existing.id));
    } else {
        await db.insert(siteSettings).values({
            id: "settings_" + nanoid(),
            siteName: "My Store",
            siteDescription: "",
            headerConfig: type === "header" ? configJson : JSON.stringify({}),
            footerConfig: type === "footer" ? configJson : JSON.stringify({}),
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        });
    }
}

/** Update navigation config by site settings ID.
 *  WIRE: api-app should call this from routes/admin/navigation.ts (updateConfigRoute handler)
 *  replacing the inline DB query at lines 194-201.
 *  Route must still call `invalidateSiteSettingsCache(getKv())` after this function.
 *  Swap: `await updateNavigationConfig(db, id, type, config);`
 *  then `await invalidateSiteSettingsCache(getKv());` + `return ok(c, { message: ... });` */
export async function updateNavigationConfig(
    db: Database,
    id: string,
    type: "header" | "footer",
    config: Record<string, unknown>,
) {
    const [existing] = await db
        .select({ id: siteSettings.id })
        .from(siteSettings)
        .where(eq(siteSettings.id, id));
    if (!existing) throw new NotFoundError("Navigation settings not found");

    const configField = type === "header" ? "headerConfig" : "footerConfig";
    await db
        .update(siteSettings)
        .set({ [configField]: JSON.stringify(config), updatedAt: sql`unixepoch()` })
        .where(eq(siteSettings.id, id));
}

/** Reset navigation config to empty by site settings ID.
 *  WIRE: api-app should call this from routes/admin/navigation.ts (deleteConfigRoute handler)
 *  replacing the inline DB query at lines 237-244.
 *  Route must still call `invalidateSiteSettingsCache(getKv())` after this function.
 *  Swap: `await deleteNavigationConfig(db, id, type);`
 *  then `await invalidateSiteSettingsCache(getKv());` + `return noContent(c);` */
export async function deleteNavigationConfig(
    db: Database,
    id: string,
    type: "header" | "footer",
) {
    const [existing] = await db
        .select({ id: siteSettings.id })
        .from(siteSettings)
        .where(eq(siteSettings.id, id));
    if (!existing) throw new NotFoundError("Navigation settings not found");

    const configField = type === "header" ? "headerConfig" : "footerConfig";
    await db
        .update(siteSettings)
        .set({ [configField]: JSON.stringify({}), updatedAt: sql`unixepoch()` })
        .where(eq(siteSettings.id, id));
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
        .where(isNull(categories.deletedAt))
        .orderBy(categories.name);

    const pagesData = await db
        .select({ id: pages.id, title: pages.title, slug: pages.slug })
        .from(pages)
        .where(sql`${pages.deletedAt} IS NULL AND ${pages.isPublished} = true`)
        .orderBy(pages.title);

    const nav: NavigationItem[] = [{ id: "home", title: "Home", href: "/" }];

    if (categoriesData.length > 0) {
        nav.push({
            id: "categories",
            title: "Categories",
            href: "#",
            subMenu: categoriesData.map((cat) => ({
                id: `cat_${cat.id}`,
                title: cat.name,
                href: `/categories/${cat.slug}`,
            })),
        });
    }

    pagesData.forEach((page) => {
        nav.push({ id: `page_${page.id}`, title: page.title, href: `/${page.slug}` });
    });

    return nav;
}
