// Price lists (docs/MARKETS-DESIGN.md D5, migration 0120): fixed prices per
// market, customer segment or sale, with a schedule, a priority and quantity
// breaks (Medusa's price lists, Shopify's catalogs, Vendure's per-channel
// prices). Base prices stay on product_variants in the shop currency (the
// backup market). The one precedence that turns these rows into a price is
// `resolvePrice()` in @scalius/shared/market-pricing.
//
// - `market` and `sale` lists price a non-backup market for every buyer; the
//   backup market sells at base prices, so the root catalogue never varies.
// - `segment` lists price members of one customer segment in one market
//   (any market, the backup included); only signed-in checkout, staff orders
//   and agents apply them, never a public (cached) read.
// - Every write of a list or its prices advances the checkout authority fence;
//   the cache dependency triggers are generated from @scalius/shared/cache-deps.

import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { markets } from "./markets";
import { customerSegments } from "./customer-marketing";
import { productVariants } from "./products";

/** Mirrors `PRICE_LIST_KINDS` in `@scalius/shared/market-pricing`. */
export const PRICE_LIST_KINDS = ["market", "segment", "sale"] as const;
export const PRICE_LIST_STATUSES = ["draft", "active"] as const;

export const priceLists = sqliteTable("price_lists", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind", { enum: PRICE_LIST_KINDS }).notNull(),
    marketId: text("market_id")
        .notNull()
        .references(() => markets.id, { onDelete: "cascade" }),
    /** Segment lists only: the members it prices (segments are only soft-deleted). */
    segmentId: text("segment_id").references(() => customerSegments.id, { onDelete: "restrict" }),
    /** Only active lists price anything. */
    status: text("status", { enum: PRICE_LIST_STATUSES }).notNull().default("draft"),
    /** Inclusive start and exclusive end (epoch seconds); null is unbounded. */
    startsAt: integer("starts_at", { mode: "timestamp" }),
    endsAt: integer("ends_at", { mode: "timestamp" }),
    /** Among lists of one kind, the higher priority wins (then the lower amount). */
    priority: integer("priority").notNull().default(0),
    /** Optimistic concurrency of the list and its prices. */
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    index("price_lists_market_status_idx").on(table.marketId, table.status),
    index("price_lists_segment_idx").on(table.segmentId),
    check("price_lists_id_shape", sql`substr(${table.id}, 1, 3) = 'pl_' AND length(${table.id}) BETWEEN 6 AND 40`),
    check("price_lists_name_length", sql`${table.name} = trim(${table.name}) AND length(${table.name}) BETWEEN 1 AND 80`),
    check("price_lists_description_length", sql`${table.description} IS NULL OR length(${table.description}) BETWEEN 1 AND 300`),
    check("price_lists_kind_check", sql`${table.kind} IN ('market', 'segment', 'sale')`),
    check("price_lists_status_check", sql`${table.status} IN ('draft', 'active')`),
    check("price_lists_segment_kind", sql`(${table.kind} = 'segment') = (${table.segmentId} IS NOT NULL)`),
    check("price_lists_schedule", sql`${table.startsAt} IS NULL OR ${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`),
    check("price_lists_priority_range", sql`${table.priority} BETWEEN 0 AND 1000`),
    check("price_lists_revision_positive", sql`${table.revision} >= 1`),
]);

/**
 * One fixed price of a SKU in a list: per currency, from a quantity
 * (`min_quantity` 1 is the list's price; larger ones are quantity breaks).
 */
export const priceListPrices = sqliteTable("price_list_prices", {
    priceListId: text("price_list_id")
        .notNull()
        .references(() => priceLists.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
        .notNull()
        .references(() => productVariants.id, { onDelete: "cascade" }),
    /** ISO 4217, upper case: the market's currency (the shop currency until step 6). */
    currencyCode: text("currency_code").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    /** The struck-through price; above the amount or null. */
    compareAtMinor: integer("compare_at_minor"),
    minQuantity: integer("min_quantity").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.priceListId, table.variantId, table.currencyCode, table.minQuantity] }),
    index("price_list_prices_variant_idx").on(table.variantId),
    check("price_list_prices_currency_shape", sql`length(${table.currencyCode}) = 3 AND ${table.currencyCode} NOT GLOB '*[^A-Z]*'`),
    check("price_list_prices_amount_positive", sql`${table.amountMinor} > 0`),
    check("price_list_prices_compare_at", sql`${table.compareAtMinor} IS NULL OR ${table.compareAtMinor} > ${table.amountMinor}`),
    check("price_list_prices_min_quantity", sql`${table.minQuantity} BETWEEN 1 AND 10000`),
]);

export type PriceListRecordRow = InferSelectModel<typeof priceLists>;
export type PriceListPriceRecordRow = InferSelectModel<typeof priceListPrices>;
