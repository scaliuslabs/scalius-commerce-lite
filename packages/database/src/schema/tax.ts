// Tax configuration authority. Rates are merchant-defined; the platform does
// not seed or infer legal rates.

import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";

export const taxClasses = sqliteTable("tax_classes", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    isExempt: integer("is_exempt", { mode: "boolean" }).notNull().default(false),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    uniqueIndex("tax_classes_active_name_ci_unique")
        .on(sql`lower(${table.name})`)
        .where(sql`${table.deletedAt} IS NULL`),
    index("tax_classes_deleted_name_idx").on(table.deletedAt, table.name),
    check("tax_classes_name_length", sql`length(${table.name}) BETWEEN 1 AND 120`),
    check("tax_classes_version_positive", sql`${table.version} >= 1`),
]);

export const taxSettings = sqliteTable("tax_settings", {
    id: text("id").primaryKey().default("default"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    pricesIncludeTax: integer("prices_include_tax", { mode: "boolean" }).notNull().default(false),
    taxShipping: integer("tax_shipping", { mode: "boolean" }).notNull().default(false),
    defaultTaxClassId: text("default_tax_class_id")
        .references(() => taxClasses.id, { onDelete: "set null" }),
    shippingTaxClassId: text("shipping_tax_class_id")
        .references(() => taxClasses.id, { onDelete: "set null" }),
    displayLabel: text("display_label").notNull().default("Tax"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    check("tax_settings_singleton", sql`${table.id} = 'default'`),
    check("tax_settings_version_positive", sql`${table.version} >= 1`),
    check("tax_settings_display_label_length", sql`length(${table.displayLabel}) BETWEEN 1 AND 80`),
]);

export const taxRates = sqliteTable("tax_rates", {
    id: text("id").primaryKey(),
    taxClassId: text("tax_class_id")
        .notNull()
        .references(() => taxClasses.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /** Percentage in basis points: 1500 = 15.00%. */
    rateBps: integer("rate_bps").notNull(),
    jurisdictionType: text("jurisdiction_type", {
        enum: ["all", "city", "zone", "area"],
    }).notNull().default("all"),
    jurisdictionId: text("jurisdiction_id"),
    jurisdictionLabel: text("jurisdiction_label"),
    priority: integer("priority").notNull().default(0),
    isCompound: integer("is_compound", { mode: "boolean" }).notNull().default(false),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("tax_rates_class_active_priority_idx").on(
        table.taxClassId,
        table.deletedAt,
        table.isActive,
        table.priority,
    ),
    index("tax_rates_jurisdiction_idx").on(
        table.jurisdictionType,
        table.jurisdictionId,
        table.deletedAt,
        table.isActive,
    ),
    check("tax_rates_rate_bps_range", sql`${table.rateBps} BETWEEN 0 AND 10000`),
    check("tax_rates_name_length", sql`length(${table.name}) BETWEEN 1 AND 120`),
    check("tax_rates_jurisdiction_label_length", sql`${table.jurisdictionLabel} IS NULL OR length(${table.jurisdictionLabel}) BETWEEN 1 AND 180`),
    check("tax_rates_priority_range", sql`${table.priority} BETWEEN 0 AND 1000`),
    check("tax_rates_version_positive", sql`${table.version} >= 1`),
    check(
        "tax_rates_jurisdiction_shape",
        sql`(
            (${table.jurisdictionType} = 'all' AND ${table.jurisdictionId} IS NULL)
            OR
            (${table.jurisdictionType} IN ('city', 'zone', 'area') AND length(${table.jurisdictionId}) BETWEEN 1 AND 180)
        )`,
    ),
]);

export type TaxClass = InferSelectModel<typeof taxClasses>;
export type TaxSetting = InferSelectModel<typeof taxSettings>;
export type TaxRate = InferSelectModel<typeof taxRates>;
