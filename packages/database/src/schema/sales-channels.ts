// Sales channels (docs/MARKETS-DESIGN.md D6, migration 0122): where products
// are published and which stock locations each channel sells from (Shopify's
// sales channels and publications, Medusa's sales channels with stock
// locations, Saleor's channel listings and warehouses).
//
// - `sales_channels`: the built-in online store, Google and Meta catalogue
//   feeds and AI agents, plus one row per channel an app declares in its
//   manifest (`kind = 'app'`, `plugin_id`). The online store is always active.
// - `product_channel_publications`: a product is published to a channel while
//   its row exists with `unpublished_at` null. A new product is published to
//   every channel (trigger `products_publish_to_channels`); the product form,
//   the bulk actions and the API change that.
// - `sales_channel_locations`: the locations whose on-hand a channel sells. A
//   new channel links every active location and a new location every channel,
//   so a channel's sellable stock is the SKU's stock until a merchant unlinks
//   one. Never a per-channel stock count.
//
// `orders.sales_channel_id` names the channel an order sold from.

import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { products } from "./products";
import { inventoryLocations } from "./inventory";

/** Mirrors `SALES_CHANNEL_KINDS` in `@scalius/shared/sales-channels`. */
export const SALES_CHANNEL_KIND_VALUES = ["online_store", "pos", "catalog_feed", "agent", "app"] as const;
export const SALES_CHANNEL_STATUS_VALUES = ["active", "inactive"] as const;

export const salesChannels = sqliteTable("sales_channels", {
    id: text("id").primaryKey(),
    /** Stable handle for the API and CLI; unique by `lower(trim(handle))`. */
    handle: text("handle").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: SALES_CHANNEL_KIND_VALUES }).notNull(),
    /** The app that declares an `app` channel (its manifest's `salesChannels`); null otherwise. */
    pluginId: text("plugin_id"),
    status: text("status", { enum: SALES_CHANNEL_STATUS_VALUES }).notNull().default("active"),
    /** List order in Settings → Sales channels. */
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("sales_channels_handle_unique").on(sql`lower(trim(${table.handle}))`),
    index("sales_channels_plugin_idx").on(table.pluginId).where(sql`${table.pluginId} IS NOT NULL`),
    check("sales_channels_id_shape", sql`length(${table.id}) BETWEEN 4 AND 160 AND ${table.id} NOT GLOB '*[^a-z0-9._:-]*'`),
    check("sales_channels_handle_shape", sql`length(${table.handle}) BETWEEN 1 AND 160 AND ${table.handle} NOT GLOB '*[^a-z0-9._:-]*'`),
    check("sales_channels_name_length", sql`${table.name} = trim(${table.name}) AND length(${table.name}) BETWEEN 1 AND 80`),
    check("sales_channels_kind_check", sql`${table.kind} IN ('online_store', 'pos', 'catalog_feed', 'agent', 'app')`),
    check("sales_channels_status_check", sql`${table.status} IN ('active', 'inactive')`),
    check("sales_channels_app_plugin", sql`(${table.kind} = 'app') = (${table.pluginId} IS NOT NULL)`),
]);

export const productChannelPublications = sqliteTable("product_channel_publications", {
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
        .notNull()
        .references(() => salesChannels.id, { onDelete: "cascade" }),
    /** When the product was last published to the channel (epoch seconds). */
    publishedAt: integer("published_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    /** Set while the product is unpublished from the channel; null = published. */
    unpublishedAt: integer("unpublished_at", { mode: "timestamp" }),
}, (table) => [
    primaryKey({ columns: [table.productId, table.channelId] }),
    // A channel's published products (dashboard filter, app reads).
    index("product_channel_publications_channel_idx")
        .on(table.channelId, table.productId)
        .where(sql`${table.unpublishedAt} IS NULL`),
    check(
        "product_channel_publications_dates",
        sql`${table.unpublishedAt} IS NULL OR ${table.unpublishedAt} >= ${table.publishedAt}`,
    ),
]);

export const salesChannelLocations = sqliteTable("sales_channel_locations", {
    channelId: text("channel_id")
        .notNull()
        .references(() => salesChannels.id, { onDelete: "cascade" }),
    locationId: text("location_id")
        .notNull()
        .references(() => inventoryLocations.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.channelId, table.locationId] }),
    index("sales_channel_locations_location_idx").on(table.locationId),
]);

export type SalesChannel = InferSelectModel<typeof salesChannels>;
export type ProductChannelPublication = InferSelectModel<typeof productChannelPublications>;
export type SalesChannelLocation = InferSelectModel<typeof salesChannelLocations>;
