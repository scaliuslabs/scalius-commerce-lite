// The digital delivery plan (Wave B §3.3): what the auto-fulfil batch writes
// for an order's digital lines, after the ledger insert. The composition file
// `fulfilment/auto/digital.ts` adds the delivery message and the staff alert.
//
//  1. Files: one entitlement per ready file asset of the line's product (the
//     product-wide ones and the variant's own), snapshotting the download
//     limit and the access expiry.
//  2. Key pools: one entitlement per line, then the line's keys assigned FIFO
//     from the variant's pool, then a guard that the line got exactly its
//     quantity.
//
// The plan is per line: a line with nothing ready (an archived or missing
// asset) or whose pool cannot cover it (lines take a pool's keys in order)
// is left out and stays owed, and every other line is delivered. A pool that
// runs out between the plan and the batch still aborts the batch (the guard),
// ledger rows included, and the sweep retries.
import type { Database } from "@scalius/database/client";
import { buildBatchGuard, chunkRowsForD1, D1_ID_CHUNK_SIZE } from "@scalius/database/client";
import { digitalAssets, digitalEntitlements, digitalLicenceKeys } from "@scalius/database/schema";
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

/** The guard marker when a pool ran out between the plan and the batch. */
export const DIGITAL_KEYS_EXHAUSTED = "digital_keys_exhausted";

export interface DigitalDeliveryLine {
    orderItemId: string;
    productId: string;
    variantId: string | null;
    /** Units to hand over. */
    quantity: number;
}

export interface DigitalShortPool {
    assetId: string;
    variantId: string;
    needed: number;
    available: number;
}

export interface DigitalDeliveryPlan {
    statements: BatchItem<"sqlite">[];
    /** The lines these statements deliver (all their units). */
    deliveredLineIds: string[];
    /** Pools with fewer available keys than their lines need (those lines stay owed). */
    shortPools: DigitalShortPool[];
    /** Lines left owed because their pool is short. */
    shortLines: string[];
    /** Lines with nothing ready to deliver (an archived or missing asset). */
    emptyLines: string[];
    entitlementCount: number;
}

/** id, order_id, order_item_id, asset_id, fulfillment_id, kind, quantity, download_limit, expires_at (+ spare). */
const ENTITLEMENT_PARAMS = 11;
interface ReadyAsset {
    id: string;
    productId: string;
    variantId: string | null;
    kind: "file" | "licence_keys";
    downloadLimit: number | null;
    accessDays: number | null;
    available: number;
}

async function readReadyAssets(db: Database, productIds: readonly string[]): Promise<ReadyAsset[]> {
    const assets: ReadyAsset[] = [];
    const unique = [...new Set(productIds)];
    // Sequential chunks of at most 90 ids (the D1 parameter budget).
    for (let offset = 0; offset < unique.length; offset += D1_ID_CHUNK_SIZE) {
        const rows = await db.select({
            id: digitalAssets.id,
            productId: digitalAssets.productId,
            variantId: digitalAssets.variantId,
            kind: digitalAssets.kind,
            downloadLimit: digitalAssets.downloadLimit,
            accessDays: digitalAssets.accessDays,
            available: sql<number>`CASE WHEN ${digitalAssets.kind} = 'licence_keys'
                THEN (SELECT count(*) FROM ${digitalLicenceKeys} k WHERE k.asset_id = "digital_assets"."id" AND k.status = 'available')
                ELSE 0 END`,
        }).from(digitalAssets)
            .where(and(inArray(digitalAssets.productId, unique.slice(offset, offset + D1_ID_CHUNK_SIZE)), eq(digitalAssets.status, "ready")))
            .orderBy(asc(digitalAssets.sortOrder), asc(digitalAssets.createdAt), asc(digitalAssets.id))
            .all();
        for (const row of rows) assets.push({ ...row, available: Number(row.available) });
    }
    return assets;
}

/**
 * The entitlement one ready file gives one delivered line: the asset's
 * download limit and access days, snapshotted at `now`. The delivery plan
 * writes it, and so does a grant of a file added after the line's delivery.
 */
export function fileEntitlementRow(
    asset: { id: string; downloadLimit: number | null; accessDays: number | null },
    line: { orderId: string; orderItemId: string; fulfillmentId: string | null },
    now: number,
): typeof digitalEntitlements.$inferInsert {
    return {
        id: `dge_${nanoid(16)}`,
        orderId: line.orderId,
        orderItemId: line.orderItemId,
        assetId: asset.id,
        fulfillmentId: line.fulfillmentId,
        kind: "file",
        quantity: 1,
        downloadLimit: asset.downloadLimit,
        expiresAt: asset.accessDays === null ? null : now + asset.accessDays * 86_400,
    };
}

/** The statements that deliver these digital lines (see the file comment). */
export async function planDigitalDelivery(
    db: Database,
    context: { orderId: string; fulfillmentId: string; lines: readonly DigitalDeliveryLine[] },
    now: number = Math.floor(Date.now() / 1000),
): Promise<DigitalDeliveryPlan> {
    const assets = await readReadyAssets(db, context.lines.map((line) => line.productId));
    const fileRows: Array<typeof digitalEntitlements.$inferInsert> = [];
    const keyStatements: BatchItem<"sqlite">[] = [];
    // Keys left in each pool as lines take them in order.
    const remaining = new Map<string, number>();
    const short = new Map<string, DigitalShortPool>();
    const deliveredLineIds: string[] = [];
    const shortLines: string[] = [];
    const emptyLines: string[] = [];
    let keyEntitlements = 0;

    for (const line of context.lines) {
        const files = assets.filter((asset) => asset.kind === "file"
            && asset.productId === line.productId
            && (asset.variantId === null || asset.variantId === line.variantId));
        const pool = line.variantId
            ? assets.find((asset) => asset.kind === "licence_keys" && asset.variantId === line.variantId)
            : undefined;
        if (files.length === 0 && !pool) {
            emptyLines.push(line.orderItemId);
            continue;
        }
        if (pool) {
            const left = remaining.get(pool.id) ?? pool.available;
            if (left < line.quantity) {
                const entry = short.get(pool.id) ?? { assetId: pool.id, variantId: pool.variantId ?? "", needed: 0, available: pool.available };
                entry.needed += line.quantity;
                short.set(pool.id, entry);
                shortLines.push(line.orderItemId);
                continue;
            }
            remaining.set(pool.id, left - line.quantity);
        }
        deliveredLineIds.push(line.orderItemId);
        for (const asset of files) {
            fileRows.push(fileEntitlementRow(asset, { orderId: context.orderId, orderItemId: line.orderItemId, fulfillmentId: context.fulfillmentId }, now));
        }
        if (pool) {
            keyEntitlements += 1;
            const entitlementId = `dge_${nanoid(16)}`;
            keyStatements.push(
                db.insert(digitalEntitlements).values({
                    id: entitlementId,
                    orderId: context.orderId,
                    orderItemId: line.orderItemId,
                    assetId: pool.id,
                    fulfillmentId: context.fulfillmentId,
                    kind: "licence_keys",
                    quantity: line.quantity,
                    downloadLimit: null,
                    expiresAt: null,
                }) as BatchItem<"sqlite">,
                // FIFO from the pool index (asset_id, status, created_at, id).
                db.update(digitalLicenceKeys).set({
                    status: "assigned",
                    orderItemId: line.orderItemId,
                    entitlementId,
                    assignedAt: sql`unixepoch()`,
                }).where(sql`${digitalLicenceKeys.id} IN (
                    SELECT k.id FROM ${digitalLicenceKeys} k
                    WHERE k.asset_id = ${pool.id} AND k.status = 'available'
                    ORDER BY k.created_at, k.id
                    LIMIT ${line.quantity}
                )`) as BatchItem<"sqlite">,
                buildBatchGuard(db, sql`(
                    SELECT count(*) FROM ${digitalLicenceKeys} k
                    WHERE k.order_item_id = ${line.orderItemId} AND k.asset_id = ${pool.id} AND k.status = 'assigned'
                ) = ${line.quantity}`, DIGITAL_KEYS_EXHAUSTED),
            );
        }
    }

    // A short pool counts the demand of the lines it serves too.
    for (const entry of short.values()) {
        entry.needed += entry.available - (remaining.get(entry.assetId) ?? entry.available);
    }
    const shortPools = [...short.values()];
    const fileStatements = chunkRowsForD1(fileRows, ENTITLEMENT_PARAMS).map((rows) =>
        db.insert(digitalEntitlements).values(rows)
            .onConflictDoNothing({ target: [digitalEntitlements.orderItemId, digitalEntitlements.assetId] }) as BatchItem<"sqlite">);
    return {
        statements: [...fileStatements, ...keyStatements],
        deliveredLineIds,
        shortPools,
        shortLines,
        emptyLines,
        entitlementCount: fileRows.length + keyEntitlements,
    };
}
