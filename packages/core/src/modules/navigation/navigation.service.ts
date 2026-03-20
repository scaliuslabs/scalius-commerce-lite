// src/modules/navigation/navigation.service.ts
// All DB queries and business logic for the navigation domain.

import { categories, pages, siteSettings } from "@scalius/database/schema";
import { isNull, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { NotFoundError } from "@scalius/core/errors";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface NavigationItem {
    id: string;
    title: string;
    href?: string;
    subMenu?: NavigationItem[];
}

// ─────────────────────────────────────────
// Admin Queries
// ─────────────────────────────────────────

/** Get available categories + pages for the admin nav item picker */
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

/** Get navigation configs (header + footer) from siteSettings */
export async function getNavigationMenus(db: Database) {
    const [row] = await db
        .select({ headerConfig: siteSettings.headerConfig, footerConfig: siteSettings.footerConfig })
        .from(siteSettings)
        .limit(1);

    let headerConfig: Record<string, unknown> = {};
    let footerConfig: Record<string, unknown> = {};

    try { headerConfig = row?.headerConfig ? JSON.parse(row.headerConfig) : {}; } catch { headerConfig = {}; }
    try { footerConfig = row?.footerConfig ? JSON.parse(row.footerConfig) : {}; } catch { footerConfig = {}; }

    return { headerConfig, footerConfig };
}

/** Get a single navigation menu by type (header/footer) */
export async function getNavigationMenu(db: Database, id: string) {
    const { headerConfig, footerConfig } = await getNavigationMenus(db);

    if (id === "header" && headerConfig) {
        return {
            id: "header",
            name: "Header Navigation",
            items: (headerConfig as Record<string, unknown>).navigation ?? [],
        };
    }

    if (id === "footer" && footerConfig) {
        return {
            id: "footer",
            name: "Footer Navigation",
            items: (footerConfig as Record<string, unknown>).menus ?? [],
        };
    }

    // Try to find a specific footer menu by id
    const menus = (footerConfig as Record<string, unknown>).menus;
    if (Array.isArray(menus)) {
        const footerMenu = menus.find(
            (m: Record<string, unknown>) => m.id === id || m.title === id,
        );
        if (footerMenu) {
            return {
                id: (footerMenu as Record<string, unknown>).id as string || id,
                name: (footerMenu as Record<string, unknown>).title as string,
                items: (footerMenu as Record<string, unknown>).links ?? [],
            };
        }
    }

    return null;
}

/** Save (create or update) navigation config for header or footer */
export async function saveNavigationConfig(
    db: Database,
    type: "header" | "footer",
    config: Record<string, unknown>,
) {
    const configField = type === "header" ? "headerConfig" : "footerConfig";
    const configJson = JSON.stringify(config);

    const [existing] = await db.select().from(siteSettings).limit(1);

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

/** Update navigation config by site settings ID */
export async function updateNavigationConfig(
    db: Database,
    id: string,
    type: "header" | "footer",
    config: Record<string, unknown>,
) {
    const [existing] = await db.select().from(siteSettings).where(eq(siteSettings.id, id));
    if (!existing) throw new NotFoundError("Navigation settings not found");

    const configField = type === "header" ? "headerConfig" : "footerConfig";
    await db
        .update(siteSettings)
        .set({ [configField]: JSON.stringify(config), updatedAt: sql`unixepoch()` })
        .where(eq(siteSettings.id, id));
}

/** Reset navigation config to empty by site settings ID */
export async function deleteNavigationConfig(
    db: Database,
    id: string,
    type: "header" | "footer",
) {
    const [existing] = await db.select().from(siteSettings).where(eq(siteSettings.id, id));
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
 *  Used by both the public navigation route and the storefront layout service. */
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
