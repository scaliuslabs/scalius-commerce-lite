// Tax configuration authority. Rates are merchant-defined; the platform does
// not seed or infer legal rates.
//
// Tax regions (MARKETS-DESIGN D8, migration 0116): the merchant collects tax
// only where it has a region (Stripe Tax's rule: no region, no tax). A
// country region is a registration; its sub-regions (an admin area, a postal
// prefix, or a Bangladesh City/Thana/Area place) carry rates that apply
// there instead of, or with, the broader ones. `tax/region-match.ts` holds
// the one specificity rule. Whether prices include tax is the market's
// (`markets.prices_include_tax`), not the store's.

import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";

/** The built-in tax provider; mirrors `SYSTEM_TAX_PROVIDER_ID` in `@scalius/shared/plugins/providers/kinds`. */
export const SYSTEM_TAX_PROVIDER_ID = "system";
/** Bangladesh delivery location kinds a tax region may be (City, Thana, Area). */
export const TAX_PLACE_TYPES = ["city", "zone", "area"] as const;

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
    taxShipping: integer("tax_shipping", { mode: "boolean" }).notNull().default(false),
    defaultTaxClassId: text("default_tax_class_id")
        .references(() => taxClasses.id, { onDelete: "set null" }),
    shippingTaxClassId: text("shipping_tax_class_id")
        .references(() => taxClasses.id, { onDelete: "set null" }),
    displayLabel: text("display_label").notNull().default("Tax"),
    /**
     * The store-wide tax provider: `system` (the built-in rates by region)
     * or an app's `<plugin id>:<provider id>`. A country region may name
     * another one.
     */
    // Column check added by 0116 (ALTER TABLE ADD ... CHECK).
    providerId: text("provider_id").notNull().default(SYSTEM_TAX_PROVIDER_ID),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    check("tax_settings_singleton", sql`${table.id} = 'default'`),
    check("tax_settings_version_positive", sql`${table.version} >= 1`),
    check("tax_settings_display_label_length", sql`length(${table.displayLabel}) BETWEEN 1 AND 80`),
    check("tax_settings_provider_shape", sql`${table.providerId} = 'system' OR (length(${table.providerId}) BETWEEN 3 AND 120 AND ${table.providerId} LIKE '_%:_%')`),
]);

/**
 * Where the merchant collects tax. A country region (no admin area, no
 * postal prefix, no place) is the registration; every other region of the
 * country is a sub-region of it and needs it (a trigger refuses an orphan).
 * One region per scope (the unique index).
 */
export const taxRegions = sqliteTable("tax_regions", {
    id: text("id").primaryKey(),
    /** ISO 3166-1 alpha-2, upper case. */
    countryCode: text("country_code").notNull(),
    /** The admin area code of the country's address rules; '' for none. */
    adminArea: text("admin_area").notNull().default(""),
    /** Upper-case letters and digits; '' for none. */
    postalPrefix: text("postal_prefix").notNull().default(""),
    /** A Bangladesh delivery location: its kind and id (null for none). */
    placeType: text("place_type", { enum: TAX_PLACE_TYPES }),
    placeId: text("place_id"),
    /**
     * A country region's tax provider (null: the store-wide one). Only a
     * country region names one: its sub-regions use it.
     */
    providerId: text("provider_id"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("tax_regions_scope_unique").on(
        table.countryCode,
        table.adminArea,
        table.postalPrefix,
        sql`coalesce(${table.placeId}, '')`,
    ),
    check("tax_regions_country_shape", sql`length(${table.countryCode}) = 2 AND ${table.countryCode} NOT GLOB '*[^A-Z]*'`),
    check("tax_regions_admin_area_shape", sql`length(${table.adminArea}) <= 120 AND ${table.adminArea} = trim(${table.adminArea})`),
    check("tax_regions_postal_prefix_shape", sql`length(${table.postalPrefix}) <= 10 AND ${table.postalPrefix} NOT GLOB '*[^A-Z0-9]*'`),
    // A region is a whole country, an admin area, a postal prefix or a Bangladesh place: never two at once.
    check(
        "tax_regions_one_kind",
        sql`(${table.adminArea} = '' OR ${table.postalPrefix} = '') AND (${table.placeId} IS NULL OR (${table.adminArea} = '' AND ${table.postalPrefix} = '' AND ${table.countryCode} = 'BD'))`,
    ),
    check(
        "tax_regions_place_shape",
        sql`(${table.placeType} IS NULL AND ${table.placeId} IS NULL) OR (${table.placeType} IN ('city', 'zone', 'area') AND ${table.placeId} IS NOT NULL AND length(${table.placeId}) BETWEEN 1 AND 180)`,
    ),
    check(
        "tax_regions_provider_country_only",
        sql`${table.providerId} IS NULL OR (${table.adminArea} = '' AND ${table.postalPrefix} = '' AND ${table.placeId} IS NULL AND (${table.providerId} = 'system' OR (length(${table.providerId}) BETWEEN 3 AND 120 AND ${table.providerId} LIKE '_%:_%')))`,
    ),
    check("tax_regions_version_positive", sql`${table.version} >= 1`),
]);

export const taxRates = sqliteTable("tax_rates", {
    id: text("id").primaryKey(),
    taxClassId: text("tax_class_id")
        .notNull()
        .references(() => taxClasses.id, { onDelete: "restrict" }),
    /** The region the rate applies in; deleting the region deletes its rates. */
    taxRegionId: text("tax_region_id")
        .notNull()
        .references(() => taxRegions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Percentage in basis points: 1500 = 15.00%. */
    rateBps: integer("rate_bps").notNull(),
    priority: integer("priority").notNull().default(0),
    isCompound: integer("is_compound", { mode: "boolean" }).notNull().default(false),
    /**
     * Applies together with the broader regions' rates of its class (Medusa's
     * `is_combinable`); otherwise the region's rates replace them.
     */
    combinable: integer("combinable", { mode: "boolean" }).notNull().default(false),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    index("tax_rates_class_active_priority_idx").on(
        table.taxClassId,
        table.isActive,
        table.priority,
    ),
    index("tax_rates_region_idx").on(table.taxRegionId),
    check("tax_rates_rate_bps_range", sql`${table.rateBps} BETWEEN 0 AND 10000`),
    check("tax_rates_name_length", sql`length(${table.name}) BETWEEN 1 AND 120`),
    check("tax_rates_priority_range", sql`${table.priority} BETWEEN 0 AND 1000`),
    check("tax_rates_version_positive", sql`${table.version} >= 1`),
]);

export type TaxClass = InferSelectModel<typeof taxClasses>;
export type TaxSetting = InferSelectModel<typeof taxSettings>;
export type TaxRate = InferSelectModel<typeof taxRates>;
export type TaxRegion = InferSelectModel<typeof taxRegions>;
