// src/db/schema/content.ts
// Site content tables: pages, heroSections, heroSliders, pageTemplates.

import { sqliteTable, text, integer, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";

export type PageFeaturedImage = {
    id: string;
    url: string;
    filename: string;
    size: number;
    mimeType?: string;
    altText?: string | null;
    width?: number | null;
    height?: number | null;
    folderId?: string | null;
    createdAt?: string | number | Date;
    updatedAt?: string | number | Date;
};

export const pages = sqliteTable(
    "pages",
    {
        id: text("id").primaryKey(),
        title: text("title").notNull(),
        slug: text("slug").notNull(),
        content: text("content").notNull(),
        metaTitle: text("meta_title"),
        metaDescription: text("meta_description"),
        canonicalPath: text("canonical_path"),
        noIndex: integer("no_index", { mode: "boolean" }).notNull().default(false),
        excludeFromSitemap: integer("exclude_from_sitemap", { mode: "boolean" }).notNull().default(false),
        isPublished: integer("is_published", { mode: "boolean" }).notNull().default(true),
        hideHeader: integer("hide_header", { mode: "boolean" }).notNull().default(false),
        hideFooter: integer("hide_footer", { mode: "boolean" }).notNull().default(false),
        hideTitle: integer("hide_title", { mode: "boolean" }).notNull().default(false),
        featuredImage: text("featured_image", { mode: "json" }).$type<PageFeaturedImage | null>(),
        publishedAt: integer("published_at", { mode: "timestamp" }),
        sortOrder: integer("sort_order").notNull().default(0),
        revision: integer("revision").notNull().default(1),
        createdAt: integer("created_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
        updatedAt: integer("updated_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
        deletedAt: integer("deleted_at", { mode: "timestamp" }),
    },
    (table) => [
        uniqueIndex("pages_slug_idx").on(table.slug),
        index("pages_deleted_at_idx").on(table.deletedAt),
        check("pages_revision_positive", sql.raw(`"revision" >= 1`)),
    ],
);

export const heroSections = sqliteTable("hero_sections", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    config: text("config").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
});

export const heroSliders = sqliteTable("hero_sliders", {
    id: text("id").primaryKey(),
    type: text("type", { enum: ["desktop", "mobile"] }).notNull(),
    images: text("images").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

export const pageTemplates = sqliteTable("page_templates", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    config: text("config").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
});

export type Page = InferSelectModel<typeof pages>;
export type HeroSection = InferSelectModel<typeof heroSections>;
export type HeroSlider = InferSelectModel<typeof heroSliders>;
export type PageTemplate = InferSelectModel<typeof pageTemplates>;
