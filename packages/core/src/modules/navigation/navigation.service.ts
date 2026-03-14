// src/modules/navigation/navigation.service.ts
import { categories, pages } from "@scalius/database/schema";
import { isNull, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";

export const NavigationService = {
    async getNavigationItems(db: Database) {
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
};
