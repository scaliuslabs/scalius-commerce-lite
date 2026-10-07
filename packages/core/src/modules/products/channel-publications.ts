// Sales-channel facts of a product (docs/MARKETS-DESIGN.md D6, migration
// 0122), as SQL the buyer reads fold into statements they already run.
//
// - Publication: a product is published to a channel while its
//   `product_channel_publications` row has no `unpublished_at`. Every public
//   read of the online store requires it (the live predicate and the stored
//   buyer state); a catalogue feed or UCP read requires its own channel's
//   too. One primary-key probe per candidate row, no bound value: channel ids
//   are validated identifiers written as SQL literals.
// - Sellable stock: a channel sells the on-hand of its linked locations
//   (`sales_channel_locations`), never a per-channel count. A SKU's sellable
//   stock in a channel is `stock - reserved_stock` minus its on-hand at the
//   locations the channel is not linked to. Every channel links every
//   location until a merchant unlinks one, and while that holds the gap is a
//   constant 0 decided once per statement (an uncorrelated EXISTS), so a
//   single-location store does no per-SKU work.
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "@scalius/database/client";
import { productChannelPublications, products, salesChannels } from "@scalius/database/schema";
import { isSalesChannelId, ONLINE_STORE_CHANNEL_ID } from "@scalius/shared/sales-channels";

/** A channel id as an SQL string literal; refuses anything that is not a channel id. */
export function salesChannelLiteral(channelId: string): SQL {
    if (!isSalesChannelId(channelId)) throw new Error(`Not a sales channel id: ${JSON.stringify(channelId)}`);
    return sql.raw(`'${channelId}'`);
}

/** The product (`productId`, a column reference) is published to the channel. */
export function productPublishedToChannelSql(productId: SQL, channelId: string = ONLINE_STORE_CHANNEL_ID): SQL<boolean> {
    return sql<boolean>`EXISTS (
        SELECT 1 FROM "product_channel_publications" AS channel_publication
        WHERE channel_publication.product_id = ${productId}
          AND channel_publication.channel_id = ${salesChannelLiteral(channelId)}
          AND channel_publication.unpublished_at IS NULL
    )`;
}

/** The channel is active (an uncorrelated scalar: evaluated once per statement). */
export function salesChannelActiveSql(channelId: string): SQL<boolean> {
    return sql<boolean>`EXISTS (
        SELECT 1 FROM "sales_channels" AS active_channel
        WHERE active_channel.id = ${salesChannelLiteral(channelId)} AND active_channel.status = 'active'
    )`;
}

/**
 * The SKU's on-hand at locations the channel does not sell from: 0 (decided
 * once per statement) while the channel is linked to every location.
 * `variantId` is a column reference to the SKU's id.
 */
export function channelUnlinkedOnHandSql(variantId: SQL, channelId: string = ONLINE_STORE_CHANNEL_ID): SQL<number> {
    const channel = salesChannelLiteral(channelId);
    return sql<number>`(CASE WHEN EXISTS (
            SELECT 1 FROM "inventory_locations" AS channel_gap_location
            WHERE NOT EXISTS (
                SELECT 1 FROM "sales_channel_locations" AS channel_gap_link
                WHERE channel_gap_link.channel_id = ${channel} AND channel_gap_link.location_id = channel_gap_location.id
            )
        )
        THEN COALESCE((
            SELECT sum(channel_gap_level.on_hand) FROM "inventory_levels" AS channel_gap_level
            WHERE channel_gap_level.variant_id = ${variantId}
              AND NOT EXISTS (
                SELECT 1 FROM "sales_channel_locations" AS channel_gap_held
                WHERE channel_gap_held.channel_id = ${channel} AND channel_gap_held.location_id = channel_gap_level.location_id
              )
        ), 0)
        ELSE 0 END)`;
}

/** The SKU's sellable on-hand in the channel (`stock` less the unlinked locations' units). */
export function channelOnHandSql(
    sku: { id: SQL; stock: SQL },
    channelId: string = ONLINE_STORE_CHANNEL_ID,
): SQL<number> {
    return sql<number>`(${sku.stock} - ${channelUnlinkedOnHandSql(sku.id, channelId)})`;
}

/** The SKU's available units in the channel: its sellable on-hand less every reservation. */
export function channelAvailableStockSql(
    sku: { id: SQL; stock: SQL; reservedStock: SQL },
    channelId: string = ONLINE_STORE_CHANNEL_ID,
): SQL<number> {
    return sql<number>`(${channelOnHandSql(sku, channelId)} - ${sku.reservedStock})`;
}

/** Column references of an aliased `product_variants` row, for the helpers above. */
export function skuStockRefs(alias: string): { id: SQL; stock: SQL; reservedStock: SQL } {
    return {
        id: sql.raw(`${alias}.id`),
        stock: sql.raw(`${alias}.stock`),
        reservedStock: sql.raw(`${alias}.reserved_stock`),
    };
}

// ---------------------------------------------------------------------------
// Writes: one statement each, for the caller's batch. The caller appends the
// catalogue projection refresh of the products (the online store's
// publication is part of `product_buyer_state.is_public`).
// ---------------------------------------------------------------------------

const idSet = (ids: readonly string[]) => sql`(SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify([...new Set(ids)])}))`;

/**
 * Publishes the products to the channels: a missing row is inserted, an
 * unpublished one published again (its `published_at` restarts); a published
 * one is left alone. Unknown products or channels are skipped.
 */
export function publishProductsStatement(db: Database, productIds: readonly string[], channelIds: readonly string[]): BatchItem<"sqlite"> {
    return db.insert(productChannelPublications)
        .select(db.select({
            productId: products.id,
            channelId: salesChannels.id,
            publishedAt: sql<number>`unixepoch()`.as("publication_published_at"),
            unpublishedAt: sql<number | null>`NULL`.as("publication_unpublished_at"),
        }).from(products).innerJoin(salesChannels, sql`${salesChannels.id} IN ${idSet(channelIds)}`)
            .where(sql`${products.id} IN ${idSet(productIds)}`) as never)
        .onConflictDoUpdate({
            target: [productChannelPublications.productId, productChannelPublications.channelId],
            set: { publishedAt: sql`unixepoch()`, unpublishedAt: null },
            setWhere: sql`${productChannelPublications.unpublishedAt} IS NOT NULL`,
        }) as unknown as BatchItem<"sqlite">;
}

/** Unpublishes the products from the channels (published rows only, so a repeat writes nothing). */
export function unpublishProductsStatement(db: Database, productIds: readonly string[], channelIds: readonly string[]): BatchItem<"sqlite"> {
    return db.update(productChannelPublications)
        .set({ unpublishedAt: sql`unixepoch()` })
        .where(and(
            sql`${productChannelPublications.productId} IN ${idSet(productIds)}`,
            sql`${productChannelPublications.channelId} IN ${idSet(channelIds)}`,
            isNull(productChannelPublications.unpublishedAt),
        )) as unknown as BatchItem<"sqlite">;
}

/** Unpublishes the product from every channel not in `channelIds`. */
export function productChannelChoiceStatement(db: Database, productId: string, channelIds: readonly string[]): BatchItem<"sqlite"> {
    return db.update(productChannelPublications)
        .set({ unpublishedAt: sql`unixepoch()` })
        .where(and(
            eq(productChannelPublications.productId, productId),
            sql`${productChannelPublications.channelId} NOT IN ${idSet(channelIds)}`,
            isNull(productChannelPublications.unpublishedAt),
        )) as unknown as BatchItem<"sqlite">;
}

/** The product is published to exactly `channelIds`: two statements. */
export function setProductChannelsStatements(db: Database, productId: string, channelIds: readonly string[]): BatchItem<"sqlite">[] {
    return [
        publishProductsStatement(db, [productId], channelIds),
        productChannelChoiceStatement(db, productId, channelIds),
    ];
}

/** The ids of the channels a product is published to, comma-joined in one column (a correlated scalar). */
export function publishedChannelIdsSql(productId: SQL): SQL<string | null> {
    return sql<string | null>`(
        SELECT group_concat(published_channel.channel_id, ',')
        FROM "product_channel_publications" AS published_channel
        WHERE published_channel.product_id = ${productId} AND published_channel.unpublished_at IS NULL
    )`;
}

/** The parsed column of `publishedChannelIdsSql`, sorted. */
export function parsePublishedChannelIds(value: unknown): string[] {
    if (typeof value !== "string" || value === "") return [];
    return value.split(",").filter(isSalesChannelId).sort();
}
