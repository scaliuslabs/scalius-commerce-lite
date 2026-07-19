// src/db/schema/navigation.ts
// Reusable storefront navigation authority: named menus, mutable drafts,
// immutable publications, and independently revisioned placements.

import {
    check,
    foreignKey,
    index,
    integer,
    primaryKey,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";

export const navigationMenus = sqliteTable("navigation_menus", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    handle: text("handle").notNull(),
    revision: integer("revision").notNull().default(1),
    publishedRevision: integer("published_revision"),
    dependencyRevision: integer("dependency_revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    uniqueIndex("navigation_menus_active_handle_unique")
        .on(sql`lower(trim(${table.handle}))`)
        .where(sql`${table.deletedAt} IS NULL`),
    index("navigation_menus_lifecycle_idx")
        .on(table.deletedAt, table.updatedAt, table.id),
    index("navigation_menus_publication_idx")
        .on(table.publishedRevision, table.dependencyRevision),
    check("navigation_menus_name_length", sql`length(trim(${table.name})) BETWEEN 1 AND 100`),
    check("navigation_menus_handle_length", sql`length(trim(${table.handle})) BETWEEN 1 AND 80`),
    check("navigation_menus_handle_normalized", sql`${table.handle} = lower(trim(${table.handle}))`),
    check("navigation_menus_revision_positive", sql`${table.revision} >= 1`),
    check(
        "navigation_menus_published_revision_positive",
        sql`${table.publishedRevision} IS NULL OR ${table.publishedRevision} >= 1`,
    ),
    check("navigation_menus_dependency_revision_positive", sql`${table.dependencyRevision} >= 1`),
]);

export const navigationMenuItems = sqliteTable("navigation_menu_items", {
    id: text("id").primaryKey(),
    menuId: text("menu_id")
        .notNull()
        .references(() => navigationMenus.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    position: integer("position").notNull(),
    label: text("label").notNull(),
    labelMode: text("label_mode", { enum: ["custom", "resource"] })
        .notNull()
        .default("custom"),
    targetType: text("target_type", {
        enum: [
            "label",
            "system",
            "page",
            "category",
            "collection",
            "product",
            "internal_path",
            "external_url",
        ],
    }).notNull(),
    targetId: text("target_id"),
    targetValue: text("target_value"),
    targetQuery: text("target_query"),
    openInNewTab: integer("open_in_new_tab", { mode: "boolean" })
        .notNull()
        .default(false),
    isEnabled: integer("is_enabled", { mode: "boolean" })
        .notNull()
        .default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("navigation_menu_items_parent_position_idx")
        .on(table.menuId, table.parentId, table.position, table.id),
    index("navigation_menu_items_menu_target_idx")
        .on(table.menuId, table.targetType, table.targetId),
    index("navigation_menu_items_target_menu_idx")
        .on(table.targetType, table.targetId, table.menuId),
    check("navigation_menu_items_not_self_parent", sql`${table.parentId} IS NULL OR ${table.id} <> ${table.parentId}`),
    check("navigation_menu_items_label_length", sql`length(trim(${table.label})) BETWEEN 1 AND 100`),
    check(
        "navigation_menu_items_target_shape",
        sql`(
            ${table.targetType} IN ('page', 'category', 'collection', 'product')
            AND ${table.targetId} IS NOT NULL
            AND length(trim(${table.targetId})) > 0
            AND ${table.targetValue} IS NULL
        ) OR (
            ${table.targetType} IN ('system', 'internal_path', 'external_url')
            AND ${table.targetId} IS NULL
            AND ${table.targetValue} IS NOT NULL
            AND length(trim(${table.targetValue})) > 0
            AND ${table.targetQuery} IS NULL
        ) OR (
            ${table.targetType} = 'label'
            AND ${table.targetId} IS NULL
            AND ${table.targetValue} IS NULL
            AND ${table.targetQuery} IS NULL
        )`,
    ),
    check(
        "navigation_menu_items_resource_label_mode",
        sql`${table.labelMode} <> 'resource' OR ${table.targetType} IN ('page', 'category', 'collection', 'product')`,
    ),
    check(
        "navigation_menu_items_target_query_shape",
        sql`${table.targetQuery} IS NULL OR (
            length(${table.targetQuery}) BETWEEN 2 AND 1024
            AND substr(${table.targetQuery}, 1, 1) = '?'
            AND instr(${table.targetQuery}, '#') = 0
        )`,
    ),
]);

export const navigationMenuPublications = sqliteTable("navigation_menu_publications", {
    menuId: text("menu_id")
        .notNull()
        .references(() => navigationMenus.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    publishedAt: integer("published_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    publishedBy: text("published_by"),
    itemCount: integer("item_count").notNull(),
    checksum: text("checksum").notNull(),
}, (table) => [
    primaryKey({ columns: [table.menuId, table.revision] }),
    index("navigation_menu_publications_time_idx")
        .on(table.menuId, table.publishedAt),
    check("navigation_menu_publications_revision_positive", sql`${table.revision} >= 1`),
    check("navigation_menu_publications_item_count_valid", sql`${table.itemCount} BETWEEN 0 AND 10000`),
    check("navigation_menu_publications_checksum_present", sql`length(trim(${table.checksum})) > 0`),
]);

export const navigationMenuPublicationItems = sqliteTable(
    "navigation_menu_publication_items",
    {
        menuId: text("menu_id").notNull(),
        revision: integer("revision").notNull(),
        itemId: text("item_id").notNull(),
        parentId: text("parent_id"),
        position: integer("position").notNull(),
        label: text("label").notNull(),
        labelMode: text("label_mode", { enum: ["custom", "resource"] }).notNull(),
        targetType: text("target_type", {
            enum: [
                "label",
                "system",
                "page",
                "category",
                "collection",
                "product",
                "internal_path",
                "external_url",
            ],
        }).notNull(),
        targetId: text("target_id"),
        targetValue: text("target_value"),
        targetQuery: text("target_query"),
        openInNewTab: integer("open_in_new_tab", { mode: "boolean" }).notNull(),
        isEnabled: integer("is_enabled", { mode: "boolean" }).notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.menuId, table.revision, table.itemId] }),
        foreignKey({
            columns: [table.menuId, table.revision],
            foreignColumns: [navigationMenuPublications.menuId, navigationMenuPublications.revision],
        }).onDelete("cascade"),
        index("navigation_publication_items_parent_idx")
            .on(table.menuId, table.revision, table.parentId, table.position, table.itemId),
        index("navigation_publication_items_target_idx")
            .on(table.targetType, table.targetId, table.menuId, table.revision),
        check(
            "navigation_publication_items_not_self_parent",
            sql`${table.parentId} IS NULL OR ${table.itemId} <> ${table.parentId}`,
        ),
        check(
            "navigation_publication_items_revision_positive",
            sql`${table.revision} >= 1`,
        ),
        check(
            "navigation_publication_items_label_length",
            sql`length(trim(${table.label})) BETWEEN 1 AND 100`,
        ),
        check(
            "navigation_publication_items_target_shape",
            sql`(
                ${table.targetType} IN ('page', 'category', 'collection', 'product')
                AND ${table.targetId} IS NOT NULL
                AND length(trim(${table.targetId})) > 0
                AND ${table.targetValue} IS NULL
            ) OR (
                ${table.targetType} IN ('system', 'internal_path', 'external_url')
                AND ${table.targetId} IS NULL
                AND ${table.targetValue} IS NOT NULL
                AND length(trim(${table.targetValue})) > 0
                AND ${table.targetQuery} IS NULL
            ) OR (
                ${table.targetType} = 'label'
                AND ${table.targetId} IS NULL
                AND ${table.targetValue} IS NULL
                AND ${table.targetQuery} IS NULL
            )`,
        ),
        check(
            "navigation_publication_items_resource_label_mode",
            sql`${table.labelMode} <> 'resource' OR ${table.targetType} IN ('page', 'category', 'collection', 'product')`,
        ),
        check(
            "navigation_publication_items_target_query_shape",
            sql`${table.targetQuery} IS NULL OR (
                length(${table.targetQuery}) BETWEEN 2 AND 1024
                AND substr(${table.targetQuery}, 1, 1) = '?'
                AND instr(${table.targetQuery}, '#') = 0
            )`,
        ),
    ],
);

export const navigationPlacements = sqliteTable("navigation_placements", {
    id: text("id").primaryKey(),
    surface: text("surface").notNull(),
    slot: text("slot").notNull(),
    position: integer("position").notNull().default(0),
    menuId: text("menu_id")
        .notNull()
        .references(() => navigationMenus.id, { onDelete: "restrict" }),
    labelOverride: text("label_override"),
    isEnabled: integer("is_enabled", { mode: "boolean" })
        .notNull()
        .default(true),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("navigation_placements_active_slot_unique")
        .on(table.surface, table.slot, table.position)
        .where(sql`${table.isEnabled} = true`),
    index("navigation_placements_menu_idx").on(table.menuId, table.isEnabled),
    check("navigation_placements_surface_present", sql`length(trim(${table.surface})) BETWEEN 1 AND 80`),
    check("navigation_placements_slot_present", sql`length(trim(${table.slot})) BETWEEN 1 AND 80`),
    check("navigation_placements_revision_positive", sql`${table.revision} >= 1`),
    check(
        "navigation_placements_label_override_length",
        sql`${table.labelOverride} IS NULL OR length(trim(${table.labelOverride})) BETWEEN 1 AND 100`,
    ),
]);

export type NavigationMenu = InferSelectModel<typeof navigationMenus>;
export type NavigationMenuItem = InferSelectModel<typeof navigationMenuItems>;
export type NavigationMenuPublication = InferSelectModel<typeof navigationMenuPublications>;
export type NavigationMenuPublicationItem = InferSelectModel<typeof navigationMenuPublicationItems>;
export type NavigationPlacement = InferSelectModel<typeof navigationPlacements>;
