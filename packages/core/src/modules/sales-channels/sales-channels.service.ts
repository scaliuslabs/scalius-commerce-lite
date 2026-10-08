// Sales channels (docs/MARKETS-DESIGN.md D6, step 5): the dashboard and API
// side. A channel is where products are published (Shopify's sales channels
// and publications, Medusa's sales channels, Saleor's channel listings). The
// built-in channels come from migration 0122; an app's come from its manifest
// (plugins/installations.ts). This module lists and edits them (status and
// the locations they sell from), publishes and unpublishes products, names a
// staff order's channel and pages a channel's products for apps.
//
// The SQL a buyer read folds in (publication, sellable stock) lives in the
// products domain (`channel-publications.ts`): it is a product fact.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { safeBatch, type Database } from "@scalius/database/client";
import {
    inventoryLocations,
    productChannelPublications,
    products,
    salesChannelLocations,
    salesChannels,
    type SalesChannel,
} from "@scalius/database/schema";
import {
    isSalesChannelId,
    ONLINE_STORE_CHANNEL_ID,
    PUBLICATION_BULK_MAX_CHANNELS,
    PUBLICATION_BULK_MAX_PRODUCTS,
    type SalesChannelKind,
    type SalesChannelStatus,
} from "@scalius/shared/sales-channels";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import {
    catalogProjectionRefreshStatements,
    publishProductsStatement,
    setProductChannelsStatements,
    unpublishProductsStatement,
} from "../products";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** One channel as Settings → Sales channels shows it. */
export interface SalesChannelRecord {
    id: string;
    handle: string;
    name: string;
    kind: SalesChannelKind;
    pluginId: string | null;
    status: SalesChannelStatus;
    position: number;
    /** The locations whose on-hand it sells, by id. */
    locationIds: string[];
    /** Products published to it, trashed ones left out (the Products list the count links to). */
    publishedProducts: number;
}

function toRecord(row: SalesChannel, locationIds: string[], publishedProducts: number): SalesChannelRecord {
    return {
        id: row.id,
        handle: row.handle,
        name: row.name,
        kind: row.kind,
        pluginId: row.pluginId,
        status: row.status,
        position: row.position,
        locationIds,
        publishedProducts,
    };
}

/** Every channel, the online store first, with its locations and published product count. */
export async function listSalesChannels(db: Database): Promise<SalesChannelRecord[]> {
    const [channels, links, counts] = await safeBatch(db, [
        db.select().from(salesChannels).orderBy(asc(salesChannels.position), asc(salesChannels.id)),
        db.select({ channelId: salesChannelLocations.channelId, locationId: salesChannelLocations.locationId })
            .from(salesChannelLocations)
            .orderBy(asc(salesChannelLocations.locationId)),
        // The partial index on published rows serves each channel's count; trashed products are not in the list it links to.
        db.select({ channelId: productChannelPublications.channelId, count: sql<number>`count(*)` })
            .from(productChannelPublications)
            .innerJoin(products, eq(products.id, productChannelPublications.productId))
            .where(and(isNull(productChannelPublications.unpublishedAt), isNull(products.deletedAt)))
            .groupBy(productChannelPublications.channelId),
    ] as never) as unknown as [SalesChannel[], Array<{ channelId: string; locationId: string }>, Array<{ channelId: string; count: number }>];
    const locationsByChannel = new Map<string, string[]>();
    for (const link of links) {
        const list = locationsByChannel.get(link.channelId) ?? [];
        list.push(link.locationId);
        locationsByChannel.set(link.channelId, list);
    }
    const countByChannel = new Map(counts.map((row) => [row.channelId, Number(row.count)]));
    return channels.map((channel) => toRecord(channel, locationsByChannel.get(channel.id) ?? [], countByChannel.get(channel.id) ?? 0));
}

export async function getSalesChannel(db: Database, id: string): Promise<SalesChannelRecord> {
    const channel = (await listSalesChannels(db)).find((entry) => entry.id === id);
    if (!channel) throw new NotFoundError("Sales channel not found.");
    return channel;
}

export interface UpdateSalesChannelInput {
    /** `inactive` hides everything the channel shows (a feed lists nothing). The online store is always active. */
    status?: SalesChannelStatus;
    /** The locations whose on-hand the channel sells: at least one active location. */
    locationIds?: string[];
}

/**
 * Changes a channel's status or the locations it sells from. Linking or
 * unlinking a location changes availability everywhere the channel shows
 * products, so it advances every cache dependency (`store`, a trigger), and
 * the caller queues the catalogue projection rebuild (the online store's
 * stored availability bands).
 */
export async function updateSalesChannel(
    db: Database,
    id: string,
    input: UpdateSalesChannelInput,
): Promise<{ channel: SalesChannelRecord; locationsChanged: boolean }> {
    const current = await getSalesChannel(db, id);
    if (input.status === "inactive" && id === ONLINE_STORE_CHANNEL_ID) {
        throw new ValidationError("The online store is always on.", { field: "status", reason: "SALES_CHANNEL_ONLINE_STORE_REQUIRED" });
    }
    if (input.status === "active" && current.kind === "app") {
        throw new ValidationError("An app's channel is on while the app is active. Turn the app on in Apps.", { field: "status" });
    }
    const writes: SQLiteBatchItem[] = [];
    if (input.status !== undefined && input.status !== current.status) {
        writes.push(db.update(salesChannels)
            .set({ status: input.status, updatedAt: sql`unixepoch()` })
            .where(eq(salesChannels.id, id)) as unknown as SQLiteBatchItem);
    }
    let locationsChanged = false;
    if (input.locationIds !== undefined) {
        const requested = [...new Set(input.locationIds.map((locationId) => locationId.trim()).filter(Boolean))].sort();
        if (requested.length === 0) {
            throw new ValidationError("Choose at least one location this channel sells from.", { field: "locationIds" });
        }
        const known = await db.select({ id: inventoryLocations.id, status: inventoryLocations.status })
            .from(inventoryLocations)
            .where(inArray(inventoryLocations.id, requested));
        if (known.length !== requested.length) {
            throw new ValidationError("A location was not found. Reload and try again.", { field: "locationIds" });
        }
        if (!known.some((location) => location.status === "active")) {
            throw new ValidationError("Choose at least one active location.", { field: "locationIds" });
        }
        const before = [...current.locationIds].sort();
        locationsChanged = before.length !== requested.length || before.some((locationId, index) => locationId !== requested[index]);
        if (locationsChanged) {
            const added = requested.filter((locationId) => !before.includes(locationId));
            const removed = before.filter((locationId) => !requested.includes(locationId));
            if (removed.length > 0) {
                writes.push(db.delete(salesChannelLocations).where(and(
                    eq(salesChannelLocations.channelId, id),
                    inArray(salesChannelLocations.locationId, removed),
                )) as unknown as SQLiteBatchItem);
            }
            if (added.length > 0) {
                writes.push(db.insert(salesChannelLocations)
                    .values(added.map((locationId) => ({ channelId: id, locationId })))
                    .onConflictDoNothing() as unknown as SQLiteBatchItem);
            }
        }
    }
    if (writes.length > 0) await safeBatch(db, writes as never);
    return { channel: await getSalesChannel(db, id), locationsChanged };
}

function requireChannelIds(channelIds: readonly string[]): string[] {
    const ids = [...new Set(channelIds)];
    if (ids.length === 0) throw new ValidationError("Choose at least one sales channel.", { field: "channelIds" });
    if (ids.length > PUBLICATION_BULK_MAX_CHANNELS) {
        throw new ValidationError(`Choose at most ${PUBLICATION_BULK_MAX_CHANNELS} sales channels at a time.`, { field: "channelIds" });
    }
    if (!ids.every(isSalesChannelId)) throw new ValidationError("Use sales channel ids.", { field: "channelIds" });
    return ids;
}

async function requireKnownChannels(db: Database, channelIds: readonly string[]): Promise<void> {
    if (channelIds.length === 0) return;
    const known = await db.select({ id: salesChannels.id }).from(salesChannels).where(inArray(salesChannels.id, [...channelIds]));
    if (known.length !== new Set(channelIds).size) {
        throw new ValidationError("A sales channel was not found. Reload and try again.", { field: "channelIds" });
    }
}

export type PublicationAction = "publish" | "unpublish";

/**
 * Publishes or unpublishes up to 90 products on up to 10 channels in one
 * batch, with the online store's buyer state refreshed in the same batch.
 * A product already in that state is left alone (no event, no cache key).
 */
export async function setProductPublications(
    db: Database,
    input: { productIds: readonly string[]; channelIds: readonly string[]; action: PublicationAction },
): Promise<{ productIds: string[]; channelIds: string[] }> {
    const productIds = [...new Set(input.productIds.map((id) => id.trim()).filter(Boolean))];
    if (productIds.length === 0) throw new ValidationError("Choose at least one product.", { field: "productIds" });
    if (productIds.length > PUBLICATION_BULK_MAX_PRODUCTS) {
        throw new ValidationError(`Choose at most ${PUBLICATION_BULK_MAX_PRODUCTS} products at a time.`, { field: "productIds" });
    }
    const channelIds = requireChannelIds(input.channelIds);
    await requireKnownChannels(db, channelIds);
    await safeBatch(db, [
        input.action === "publish"
            ? publishProductsStatement(db, productIds, channelIds)
            : unpublishProductsStatement(db, productIds, channelIds),
        ...(channelIds.includes(ONLINE_STORE_CHANNEL_ID) ? catalogProjectionRefreshStatements(db, productIds, { facets: false }) : []),
    ] as never);
    return { productIds, channelIds };
}

/** Publishes one product to exactly these channels (the product page's Publishing card). */
export async function setProductChannels(db: Database, productId: string, channelIds: readonly string[]): Promise<string[]> {
    const ids = [...new Set(channelIds)];
    if (!ids.every(isSalesChannelId)) throw new ValidationError("Use sales channel ids.", { field: "channelIds" });
    await requireKnownChannels(db, ids);
    const product = await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).get();
    if (!product) throw new NotFoundError("Product not found.");
    await safeBatch(db, [
        ...setProductChannelsStatements(db, productId, ids),
        ...catalogProjectionRefreshStatements(db, [productId], { facets: false }),
    ] as never);
    return readProductChannels(db, productId);
}

/** The channels a product is published to, sorted. */
export async function readProductChannels(db: Database, productId: string): Promise<string[]> {
    const rows = await db.select({ channelId: productChannelPublications.channelId })
        .from(productChannelPublications)
        .where(and(eq(productChannelPublications.productId, productId), isNull(productChannelPublications.unpublishedAt)))
        .orderBy(asc(productChannelPublications.channelId));
    return rows.map((row) => row.channelId);
}

/**
 * The channel a staff order sells from: the one staff picked (an active
 * channel), else the online store. Staff may sell any product, published
 * or not (Shopify's draft orders), so nothing else is checked.
 */
export async function resolveStaffOrderSalesChannel(db: Database, requested: string | null | undefined): Promise<string> {
    if (!requested || requested === ONLINE_STORE_CHANNEL_ID) return ONLINE_STORE_CHANNEL_ID;
    if (!isSalesChannelId(requested)) throw new ValidationError("Use a sales channel id.", { field: "salesChannelId" });
    const channel = await db.select({ id: salesChannels.id, status: salesChannels.status })
        .from(salesChannels).where(eq(salesChannels.id, requested)).get();
    if (!channel || channel.status !== "active") {
        throw new ValidationError("That sales channel is off or no longer exists.", { field: "salesChannelId" });
    }
    return channel.id;
}

export const CHANNEL_PRODUCTS_PAGE_MAX = 100;

/**
 * A channel's published products by id, in keyset pages (the port a
 * sales-channel app syncs its listings from; the `product.publication_changed`
 * event tells it what changed). Trashed products are left out.
 */
export async function listChannelProducts(
    db: Database,
    channelId: string,
    options: { after?: string | null; limit?: number } = {},
): Promise<{ productIds: string[]; nextAfter: string | null }> {
    if (!isSalesChannelId(channelId)) throw new ValidationError("Use a sales channel id.", { field: "channelId" });
    const limit = Math.min(CHANNEL_PRODUCTS_PAGE_MAX, Math.max(1, Math.trunc(options.limit ?? 50)));
    const channel = await db.select({ id: salesChannels.id }).from(salesChannels).where(eq(salesChannels.id, channelId)).get();
    if (!channel) throw new NotFoundError("Sales channel not found.");
    const rows = await db.select({ productId: productChannelPublications.productId })
        .from(productChannelPublications)
        .innerJoin(products, eq(products.id, productChannelPublications.productId))
        .where(and(
            eq(productChannelPublications.channelId, channelId),
            isNull(productChannelPublications.unpublishedAt),
            isNull(products.deletedAt),
            options.after ? sql`${productChannelPublications.productId} > ${options.after}` : undefined,
        ))
        .orderBy(asc(productChannelPublications.productId))
        .limit(limit + 1);
    const page = rows.slice(0, limit).map((row) => row.productId);
    return { productIds: page, nextAfter: rows.length > limit ? page.at(-1) ?? null : null };
}
