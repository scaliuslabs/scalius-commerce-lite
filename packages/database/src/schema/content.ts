// src/db/schema/content.ts
// Site content tables: pages, widgets, widgetHistory, heroSections, heroSliders, pageTemplates.

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { collections } from "./products";
import { WidgetPlacementRule } from "./enums";

export const pages = sqliteTable(
    "pages",
    {
        id: text("id").primaryKey(),
        title: text("title").notNull(),
        slug: text("slug").notNull(),
        content: text("content").notNull(),
        metaTitle: text("meta_title"),
        metaDescription: text("meta_description"),
        isPublished: integer("is_published", { mode: "boolean" }).notNull().default(true),
        hideHeader: integer("hide_header", { mode: "boolean" }).notNull().default(false),
        hideFooter: integer("hide_footer", { mode: "boolean" }).notNull().default(false),
        hideTitle: integer("hide_title", { mode: "boolean" }).notNull().default(false),
        publishedAt: integer("published_at", { mode: "timestamp" }),
        sortOrder: integer("sort_order").notNull().default(0),
        createdAt: integer("created_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
        updatedAt: integer("updated_at", { mode: "timestamp" })
            .notNull()
            .default(UNIX_NOW),
        deletedAt: integer("deleted_at", { mode: "timestamp" }),
    },
    (table) => [
        index("pages_slug_idx").on(table.slug),
        index("pages_deleted_at_idx").on(table.deletedAt),
    ],
);

export const widgets = sqliteTable(
    "widgets",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
        htmlContent: text("html_content").notNull(),
        cssContent: text("css_content"),
        aiContext: text("ai_context"),
        isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
        displayTarget: text("display_target", { enum: ["homepage"] }).notNull().default("homepage"),
        placementRule: text("placement_rule", {
            enum: [
                WidgetPlacementRule.BEFORE_COLLECTION,
                WidgetPlacementRule.AFTER_COLLECTION,
                WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
                WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE,
                WidgetPlacementRule.STANDALONE,
            ],
        }).notNull(),
        referenceCollectionId: text("reference_collection_id").references(
            () => collections.id,
            { onDelete: "set null" },
        ),
        sortOrder: integer("sort_order").notNull().default(0),
        createdAt: integer("created_at", { mode: "timestamp" })
            .notNull()
            .default(sql`(cast(strftime('%s','now') as int))`),
        updatedAt: integer("updated_at", { mode: "timestamp" })
            .notNull()
            .default(sql`(cast(strftime('%s','now') as int))`),
        deletedAt: integer("deleted_at", { mode: "timestamp" }),
    },
    (table) => [
        index("widgets_target_idx").on(table.displayTarget, table.isActive, table.deletedAt),
        index("widgets_deleted_at_idx").on(table.deletedAt),
    ],
);

export const widgetHistory = sqliteTable("widget_history", {
    id: text("id").primaryKey(),
    widgetId: text("widget_id")
        .notNull()
        .references(() => widgets.id, { onDelete: "cascade" }),
    htmlContent: text("html_content").notNull(),
    cssContent: text("css_content"),
    reason: text("reason").notNull().default("updated"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(sql`(cast(strftime('%s','now') as int))`),
}, (table) => [
    index("widget_history_widget_id_idx").on(table.widgetId),
]);

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
export type Widget = InferSelectModel<typeof widgets>;
export type WidgetHistory = InferSelectModel<typeof widgetHistory>;
export type HeroSection = InferSelectModel<typeof heroSections>;
export type HeroSlider = InferSelectModel<typeof heroSliders>;
export type PageTemplate = InferSelectModel<typeof pageTemplates>;
