// Translations (docs/MARKETS-DESIGN.md D9, migration 0121): the store's
// languages, translated resource fields and localized URL handles. The one
// fallback resolver and the list of translatable resources are in
// @scalius/shared/translations.
//
// - store_languages is the one list of the store's languages. The default
//   language is the backup market's root presence locale; every presence
//   names a store language, and a presence in an unpublished language is not
//   served. Triggers keep the root presence's language published
//   (STORE_LANGUAGE_REQUIRED, STORE_LANGUAGE_DEFAULT_REQUIRED) and refuse
//   removing a language a presence uses (STORE_LANGUAGE_IN_USE).
// - translations holds one row per resource, locale and market (NULL: every
//   market) with the translated fields as a JSON object and the digest of the
//   source text they were made from (Outdated markers).
// - localized_slugs holds one URL handle per resource and locale, unique per
//   resource type and locale; a trigger keeps it off the source handles of
//   the same type (LOCALIZED_SLUG_TAKEN).
// The cache dependency triggers are generated from @scalius/shared/cache-deps.

import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { markets } from "./markets";

/** Mirrors `TRANSLATABLE_RESOURCE_TYPES` in `@scalius/shared/translations`. */
export const TRANSLATION_RESOURCE_TYPES = [
    "product",
    "product_variant",
    "product_option",
    "product_option_value",
    "collection",
    "category",
    "brand",
    "page",
    "menu",
    "shipping_method",
    "payment_method",
] as const;
/** Mirrors `SLUGGED_RESOURCE_TYPES` in `@scalius/shared/translations`. */
export const LOCALIZED_SLUG_RESOURCE_TYPES = ["product", "category", "brand", "page"] as const;

const quoted = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

export const storeLanguages = sqliteTable("store_languages", {
    /** ISO 639-1, lower case: the presence locale grammar. */
    locale: text("locale").primaryKey(),
    /** Only published languages are served; the default language is always published. */
    published: integer("published", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    check("store_languages_locale_shape", sql`length(${table.locale}) = 2 AND ${table.locale} NOT GLOB '*[^a-z]*'`),
    check("store_languages_published_flag", sql`${table.published} IN (0, 1)`),
]);

export const translations = sqliteTable("translations", {
    id: text("id").primaryKey(),
    resourceType: text("resource_type", { enum: TRANSLATION_RESOURCE_TYPES }).notNull(),
    resourceId: text("resource_id").notNull(),
    locale: text("locale")
        .notNull()
        .references(() => storeLanguages.locale, { onDelete: "cascade" }),
    /** A market-specific translation (Shopify's `marketId`); NULL serves every market. */
    marketId: text("market_id").references(() => markets.id, { onDelete: "cascade" }),
    /** `{ "<field>": "<text>" }`: only the fields that are translated. */
    fields: text("fields").notNull(),
    /** `{ "<field>": "<digest>" }` of the source text each field was translated from. */
    sourceDigest: text("source_digest").notNull().default("{}"),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("translations_identity_unique").on(
        table.resourceType,
        table.resourceId,
        table.locale,
        sql`coalesce(${table.marketId}, '')`,
    ),
    index("translations_locale_idx").on(table.locale),
    index("translations_market_idx").on(table.marketId),
    check("translations_id_shape", sql`substr(${table.id}, 1, 3) = 'tr_' AND length(${table.id}) BETWEEN 6 AND 40`),
    check("translations_resource_type_check", sql`${table.resourceType} IN (${quoted(TRANSLATION_RESOURCE_TYPES)})`),
    check("translations_resource_id_length", sql`length(${table.resourceId}) BETWEEN 1 AND 64`),
    check("translations_locale_shape", sql`length(${table.locale}) = 2 AND ${table.locale} NOT GLOB '*[^a-z]*'`),
    check("translations_fields_object", sql`json_valid(${table.fields}) AND json_type(${table.fields}) = 'object'`),
    check("translations_source_digest_object", sql`json_valid(${table.sourceDigest}) AND json_type(${table.sourceDigest}) = 'object'`),
]);

export const localizedSlugs = sqliteTable("localized_slugs", {
    resourceType: text("resource_type", { enum: LOCALIZED_SLUG_RESOURCE_TYPES }).notNull(),
    locale: text("locale")
        .notNull()
        .references(() => storeLanguages.locale, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    resourceId: text("resource_id").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.resourceType, table.locale, table.slug] }),
    uniqueIndex("localized_slugs_resource_unique").on(table.resourceType, table.resourceId, table.locale),
    // A handle looked up in any locale (a presence that is not the handle's own).
    index("localized_slugs_slug_idx").on(table.resourceType, table.slug),
    index("localized_slugs_locale_idx").on(table.locale),
    check("localized_slugs_resource_type_check", sql`${table.resourceType} IN (${quoted(LOCALIZED_SLUG_RESOURCE_TYPES)})`),
    check("localized_slugs_resource_id_length", sql`length(${table.resourceId}) BETWEEN 1 AND 64`),
    check("localized_slugs_locale_shape", sql`length(${table.locale}) = 2 AND ${table.locale} NOT GLOB '*[^a-z]*'`),
    // The handle grammar (`HANDLE_PATTERN`): ASCII words joined by single dashes.
    check(
        "localized_slugs_slug_shape",
        sql`length(${table.slug}) BETWEEN 1 AND 100 AND ${table.slug} NOT GLOB '*[^a-z0-9-]*' AND substr(${table.slug}, 1, 1) <> '-' AND substr(${table.slug}, -1, 1) <> '-' AND instr(${table.slug}, '--') = 0`,
    ),
]);

export type StoreLanguageRow = InferSelectModel<typeof storeLanguages>;
export type TranslationRecord = InferSelectModel<typeof translations>;
export type LocalizedSlugRow = InferSelectModel<typeof localizedSlugs>;
