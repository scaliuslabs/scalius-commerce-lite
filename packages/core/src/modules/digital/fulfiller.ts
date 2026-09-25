// The digital delivery plan (Wave B §3.3): what the auto-fulfil batch writes
// for an order's digital lines, after the ledger insert. The composition file
// `fulfilment/auto/digital.ts` adds the delivery message and the staff alert.
//
//  1. Files: one entitlement per ready file asset of the line's product (the
//     product-wide ones and the variant's own), snapshotting the download
//     limit and the access expiry.
//  2. Key pools: one entitlement per line, then the line's keys assigned FIFO
//     from the variant's pool, then a guard that the line got exactly its
//     quantity. Too few keys aborts the whole batch, ledger row included: the
//     line stays owed and the sweep retries once keys are imported.
import type { Database } from "@scalius/database/client";
import { buildBatchGuard, chunkRowsForD1 } from "@scalius/database/client";
import { digitalAssets, digitalEntitlements, digitalLicenceKeys } from "@scalius/database/schema";
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

/** The guard marker when a pool ran out between the plan and the batch. */
export const DIGITAL_KEYS_EXHAUSTED = "DIGITAL_KEYS_EXHAUSTED";

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
    /** Pools with fewer available keys than this delivery needs. */
    shortPools: DigitalShortPool[];
    /** Lines with nothing ready to deliver (an archived or missing asset). */
    emptyLines: string[];
    entitlementCount: number;
}

/** id, order_id, order_item_id, asset_id, fulfillment_id, kind, quantity, download_limit, expires_at (+ spare). */
const ENTITLEMENT_PARAMS = 11;
const PRODUCT_CHUNK = 90;

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
    for (let offset = 0; offset < unique.length; offset += PRODUCT_CHUNK) {
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
            .where(and(inArray(digitalAssets.productId, unique.slice(offset, offset + PRODUCT_CHUNK)), eq(digitalAssets.status, "ready")))
            .orderBy(asc(digitalAssets.sortOrder), asc(digitalAssets.createdAt), asc(digitalAssets.id))
            .all();
        for (const row of rows) assets.push({ ...row, available: Number(row.available) });
    }
    return assets;
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
    const demand = new Map<string, { asset: ReadyAsset; needed: number }>();
    const emptyLines: string[] = [];

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
        for (const asset of files) {
            fileRows.push({
                id: `dge_${nanoid(16)}`,
                orderId: context.orderId,
                orderItemId: line.orderItemId,
                assetId: asset.id,
                fulfillmentId: context.fulfillmentId,
                kind: "file",
                quantity: 1,
                downloadLimit: asset.downloadLimit,
                expiresAt: asset.accessDays === null ? null : now + asset.accessDays * 86_400,
            });
        }
        if (pool) {
            const entry = demand.get(pool.id) ?? { asset: pool, needed: 0 };
            entry.needed += line.quantity;
            demand.set(pool.id, entry);
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

    const shortPools = [...demand.values()]
        .filter((entry) => entry.needed > entry.asset.available)
        .map((entry) => ({
            assetId: entry.asset.id,
            variantId: entry.asset.variantId ?? "",
            needed: entry.needed,
            available: entry.asset.available,
        }));
    const fileStatements = chunkRowsForD1(fileRows, ENTITLEMENT_PARAMS).map((rows) =>
        db.insert(digitalEntitlements).values(rows)
            .onConflictDoNothing({ target: [digitalEntitlements.orderItemId, digitalEntitlements.assetId] }) as BatchItem<"sqlite">);
    return {
        statements: [...fileStatements, ...keyStatements],
        shortPools,
        emptyLines,
        entitlementCount: fileRows.length + demand.size,
    };
}
