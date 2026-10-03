// src/db/schema/markets.ts
// Markets (docs/MARKETS-DESIGN.md D4): the configuration bundle a buyer is
// matched to. Step 2 holds the countries and the URL presences of each
// market; every market sells in the shop currency at base prices. Price lists,
// tax inclusivity and per-market delivery and payment links arrive in later
// steps as their own columns or tables.

import { sqliteTable, text, integer, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";

export const MARKET_STATUSES = ["draft", "active"] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];

/** `subfolder`: a path prefix on the store's own origin (`''` is the root). `domain` is reserved for a later step. */
export const MARKET_PRESENCE_KINDS = ["subfolder", "domain"] as const;
export type MarketPresenceKind = (typeof MARKET_PRESENCE_KINDS)[number];

/** The backup market's fixed id: migration 0112 creates it and nothing can remove it. */
export const BACKUP_MARKET_ID = "mkt_backup";

export const markets = sqliteTable("markets", {
    id: text("id").primaryKey(),
    /** Stable merchant handle for the API and CLI; unique by `lower(trim(handle))`. */
    handle: text("handle").notNull(),
    name: text("name").notNull(),
    /** Only active markets resolve for buyers. The backup market is always active. */
    status: text("status", { enum: MARKET_STATUSES }).notNull().default("draft"),
    /**
     * Exactly one market is the backup: it catches every buyer no other market
     * matches. A partial unique index allows one; triggers refuse deleting it
     * and changing the flag; migration 0112 creates it.
     */
    isBackup: integer("is_backup", { mode: "boolean" }).notNull().default(false),
    /**
     * The backup market's price increment in minor units of the shop currency
     * (MARKETS-DESIGN D1): every merchant-entered price is a multiple of it
     * and every derived amount rounds to it. Other markets sell in the shop
     * currency, so they have none (NULL) and use the backup market's.
     */
    priceIncrementMinor: integer("price_increment_minor"),
    /** Optimistic concurrency of the market aggregate (row, countries, presences). */
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("markets_handle_unique").on(sql`lower(trim(${table.handle}))`),
    uniqueIndex("markets_backup_unique")
        .on(table.isBackup)
        .where(sql`${table.isBackup} = 1`),
    check("markets_name_length", sql`length(trim(${table.name})) BETWEEN 1 AND 60`),
    check(
        "markets_handle_shape",
        sql`length(${table.handle}) BETWEEN 1 AND 60 AND ${table.handle} = lower(${table.handle}) AND ${table.handle} NOT GLOB '*[^a-z0-9-]*' AND substr(${table.handle}, 1, 1) <> '-' AND substr(${table.handle}, -1, 1) <> '-'`,
    ),
    check("markets_status_check", sql`${table.status} IN ('draft', 'active')`),
    check("markets_backup_flag", sql`${table.isBackup} IN (0, 1)`),
    check("markets_backup_active", sql`${table.isBackup} = 0 OR ${table.status} = 'active'`),
    check(
        "markets_price_increment",
        sql`(${table.isBackup} = 1 AND ${table.priceIncrementMinor} IS NOT NULL AND ${table.priceIncrementMinor} IN (1, 10, 100, 1000)) OR (${table.isBackup} = 0 AND ${table.priceIncrementMinor} IS NULL)`,
    ),
    check("markets_revision_positive", sql`${table.revision} >= 1`),
]);

/** One market per country: the country code is the key. */
export const marketCountries = sqliteTable("market_countries", {
    /** ISO 3166-1 alpha-2, upper case. */
    countryCode: text("country_code").primaryKey(),
    marketId: text("market_id")
        .notNull()
        .references(() => markets.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("market_countries_market_idx").on(table.marketId),
    check("market_countries_code_shape", sql`length(${table.countryCode}) = 2 AND ${table.countryCode} NOT GLOB '*[^A-Z]*'`),
]);

/**
 * Where a market is sold on the web: one row per URL. A `subfolder` value is
 * the first path segment (`en-in`) or `''` for the root, which only the
 * backup market holds. `locale` is the page language (BCP 47 language).
 */
export const marketPresences = sqliteTable("market_presences", {
    id: text("id").primaryKey(),
    marketId: text("market_id")
        .notNull()
        .references(() => markets.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: MARKET_PRESENCE_KINDS }).notNull().default("subfolder"),
    value: text("value").notNull(),
    locale: text("locale").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("market_presences_value_unique").on(table.kind, table.value),
    index("market_presences_market_idx").on(table.marketId),
    check("market_presences_kind_check", sql`${table.kind} IN ('subfolder', 'domain')`),
    // A subfolder is the root or `<locale>-<country>` (`en-in` for English in India).
    check(
        "market_presences_subfolder_shape",
        sql`${table.kind} <> 'subfolder' OR ${table.value} = '' OR (length(${table.value}) = 5 AND ${table.value} GLOB '[a-z][a-z]-[a-z][a-z]' AND substr(${table.value}, 1, 2) = ${table.locale})`,
    ),
    check(
        "market_presences_locale_shape",
        sql`length(${table.locale}) = 2 AND ${table.locale} NOT GLOB '*[^a-z]*'`,
    ),
]);

export type MarketRow = InferSelectModel<typeof markets>;
export type MarketCountryRow = InferSelectModel<typeof marketCountries>;
export type MarketPresenceRow = InferSelectModel<typeof marketPresences>;
