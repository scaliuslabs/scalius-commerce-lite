// src/db/schema/markets.ts
// Markets (docs/MARKETS-DESIGN.md D4): the configuration bundle a buyer is
// matched to: its countries and URL presences (step 2), whether its prices
// include tax (step 3c) and how it prices (step 4a: fixed or FX-derived, with
// its price lists in price-lists.ts). Every market sells in the shop currency
// until step 6; per-market delivery and payment links arrive later.

import { sqliteTable, text, integer, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";

export const MARKET_STATUSES = ["draft", "active"] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];

/** Mirrors `MARKET_PRICE_MODES` in `@scalius/shared/market-pricing`. */
export const MARKET_PRICE_MODES = ["fixed", "fx"] as const;

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
    /**
     * Whether the market's prices include tax (MARKETS-DESIGN D8, migration
     * 0116): checkout and the order's tax snapshot read the order's market.
     */
    pricesIncludeTax: integer("prices_include_tax", { mode: "boolean" }).notNull().default(false),
    /**
     * How the market prices (MARKETS-DESIGN D5, migration 0120): `fixed` sells
     * at base prices and its fixed price lists; `fx` derives its prices from
     * the base prices at its exchange rate, adjustment, rounding and ending.
     * The backup market is always `fixed` (its prices are the base prices).
     * Triggers keep the shape (`MARKET_PRICING_INVALID`).
     */
    priceMode: text("price_mode", { enum: MARKET_PRICE_MODES }).notNull().default("fixed"),
    /**
     * The manual exchange rate (market currency units per shop currency
     * unit, a decimal string); null uses the rate source. A market in the
     * shop currency converts at "1" whatever this holds.
     */
    fxRate: text("fx_rate"),
    /** Percentage adjustment of FX-derived prices, in basis points (−9,900 to 100,000). */
    priceAdjustmentBps: integer("price_adjustment_bps").notNull().default(0),
    /** FX-derived prices round up to this step (minor units); null rounds half-up to the price increment. */
    priceRoundingMinor: integer("price_rounding_minor"),
    /** What a rounded price ends in within its step (`.99`: 99 of a 100 step); null for none. */
    priceEndingMinor: integer("price_ending_minor"),
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
    // Pricing (0120): the backup market sells at base prices.
    check("markets_price_mode_check", sql`${table.priceMode} IN ('fixed', 'fx') AND (${table.isBackup} = 0 OR ${table.priceMode} = 'fixed')`),
    check("markets_fx_rate_shape", sql`${table.fxRate} IS NULL OR (length(${table.fxRate}) BETWEEN 1 AND 25 AND ${table.fxRate} GLOB '[0-9]*' AND ${table.fxRate} NOT GLOB '*[^0-9.]*')`),
    check("markets_price_adjustment_range", sql`${table.priceAdjustmentBps} BETWEEN -9900 AND 100000`),
    check("markets_price_rounding", sql`${table.priceRoundingMinor} IS NULL OR ${table.priceRoundingMinor} BETWEEN 1 AND 100000000`),
    check("markets_price_ending", sql`${table.priceEndingMinor} IS NULL OR (${table.priceRoundingMinor} IS NOT NULL AND ${table.priceEndingMinor} > 0 AND ${table.priceEndingMinor} < ${table.priceRoundingMinor})`),
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
