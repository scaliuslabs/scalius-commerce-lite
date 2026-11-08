// Buyer uploads (COMMERCE-HOOKS H17): stage a file a buyer gives an app's
// `file` input, let the buyer take it back, list an order's files, and sweep
// the ones no order took. The API route sniffs and bounds the bytes before
// anything here runs; every object lives under `private/buyer-uploads/` and
// is read only through a signed link (links.ts). Logs carry upload ids only,
// never names, bytes or links.
import type { Database } from "@scalius/database/client";
import { buyerUploads, orders } from "@scalius/database/schema";
import {
    BUYER_UPLOAD_ORPHAN_SECONDS,
    BUYER_UPLOADS_PER_ORDER_MAX,
    BUYER_UPLOAD_RETENTION_DAYS,
    buyerUploadFilename,
    buyerUploadR2Key,
    sniffBuyerUploadType,
    type BuyerFileBounds,
    type BuyerUploadType,
} from "@scalius/shared/buyer-uploads";
import { ERASURE_BLOCKING_ORDER_STATUSES } from "@scalius/shared/customer-erasure";
import { sha256Hex } from "@scalius/shared/hash";
import { planLimits } from "@scalius/shared/plan-limits";
import { and, asc, eq, gt, isNotNull, isNull, lt, notInArray, sql, type SQL } from "drizzle-orm";
import { AppError, NotFoundError, RateLimitError } from "../../errors";

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** `bup_` + 24 characters from 18 random bytes (144 bits). */
export function newBuyerUploadId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    let id = "bup_";
    for (const byte of bytes) id += ID_ALPHABET[byte & 63];
    return id;
}

export interface StageBuyerUploadInput {
    appId: string;
    /** `<app id>.<key>`. */
    fieldKey: string;
    target: "line" | "attribute";
    /** A line input's product; null for a checkout attribute. */
    productId: string | null;
    bounds: BuyerFileBounds;
    /** The name the browser sent (cleaned; its extension follows the sniffed type). */
    filename: string | null;
    bytes: Uint8Array;
    /** A keyed hash of the visitor (`buyerUploadVisitorKey`). */
    uploaderKey: string;
}

export interface StagedBuyerUpload {
    id: string;
    filename: string;
    mediaType: BuyerUploadType;
    sizeBytes: number;
}

function refuse(code: "upload_type_not_accepted" | "upload_too_large", message: string, details: Record<string, unknown>): never {
    throw new AppError(400, code, message, details);
}

/**
 * Stores the bytes (sniffed: never the name or the declared type) and records
 * the unattached row. The object is written first; a failed insert deletes
 * it again. A visitor holds at most the plan's `stagedPerVisitor` unattached
 * uploads at once.
 */
export async function stageBuyerUpload(
    db: Database,
    bucket: R2Bucket,
    input: StageBuyerUploadInput,
): Promise<StagedBuyerUpload> {
    const sizeBytes = input.bytes.byteLength;
    if (sizeBytes < 1 || sizeBytes > input.bounds.maxBytes) {
        refuse("upload_too_large", `Files must be ${Math.floor(input.bounds.maxBytes / 1_048_576 * 10) / 10} MB or smaller.`, { maxBytes: input.bounds.maxBytes });
    }
    const mediaType = sniffBuyerUploadType(input.bytes);
    if (!mediaType || !input.bounds.accept.includes(mediaType)) {
        refuse("upload_type_not_accepted", "This file type is not accepted here.", { accept: input.bounds.accept });
    }
    const cap = planLimits().uploads.stagedPerVisitor;
    const staged = await db.select({ id: buyerUploads.id }).from(buyerUploads)
        .where(and(isNull(buyerUploads.orderId), eq(buyerUploads.uploaderKey, input.uploaderKey)))
        .limit(cap)
        .all();
    if (staged.length >= cap) {
        throw new RateLimitError("You have added many files. Place your order or remove some files first.");
    }

    const id = newBuyerUploadId();
    const r2Key = buyerUploadR2Key(id);
    const filename = buyerUploadFilename(input.filename, mediaType);
    const body = input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + sizeBytes) as ArrayBuffer;
    const sha256 = await sha256Hex(body);
    await bucket.put(r2Key, body, { httpMetadata: { contentType: mediaType } });
    try {
        await db.insert(buyerUploads).values({
            id,
            appId: input.appId,
            fieldKey: input.fieldKey,
            target: input.target,
            productId: input.target === "line" ? input.productId : null,
            r2Key,
            mediaType,
            sizeBytes,
            filename,
            sha256,
            uploaderKey: input.uploaderKey,
            createdAt: Math.floor(Date.now() / 1000),
        });
    } catch (error) {
        await bucket.delete(r2Key).catch(() => undefined);
        throw error;
    }
    return { id, filename, mediaType, sizeBytes };
}

/**
 * The buyer takes a file back before ordering: only the visitor who staged
 * it, only while no order holds it. Anything else is the same 404.
 */
export async function removeStagedBuyerUpload(
    db: Database,
    bucket: R2Bucket,
    input: { id: string; uploaderKey: string },
): Promise<void> {
    const removed = await db.delete(buyerUploads)
        .where(and(eq(buyerUploads.id, input.id), eq(buyerUploads.uploaderKey, input.uploaderKey), isNull(buyerUploads.orderId)))
        .returning({ r2Key: buyerUploads.r2Key });
    const row = removed[0];
    if (!row) throw new NotFoundError("Upload not found");
    await bucket.delete(row.r2Key).catch((error: unknown) => {
        console.error(`[buyer-uploads] Removed upload ${input.id} object not deleted:`, error instanceof Error ? error.name : "unknown error");
    });
}

export interface OrderBuyerUpload {
    id: string;
    appId: string;
    fieldKey: string;
    target: "line" | "attribute";
    orderItemId: string | null;
    filename: string;
    mediaType: BuyerUploadType;
    sizeBytes: number;
    attachedAt: number;
}


/**
 * An order's files, in id order: every app's for store readers, only its own
 * for an app (`appId`). Bounded by `BUYER_UPLOADS_PER_ORDER_MAX`; `afterId`
 * continues a page.
 */
export async function listOrderBuyerUploads(
    db: Database,
    orderId: string,
    options: { appId?: string | null; afterId?: string | null; limit?: number } = {},
): Promise<OrderBuyerUpload[]> {
    const limit = Math.max(1, Math.min(options.limit ?? BUYER_UPLOADS_PER_ORDER_MAX, BUYER_UPLOADS_PER_ORDER_MAX));
    const rows = await db.select({
        id: buyerUploads.id,
        appId: buyerUploads.appId,
        fieldKey: buyerUploads.fieldKey,
        target: buyerUploads.target,
        orderItemId: buyerUploads.orderItemId,
        filename: buyerUploads.filename,
        mediaType: buyerUploads.mediaType,
        sizeBytes: buyerUploads.sizeBytes,
        attachedAt: buyerUploads.attachedAt,
    }).from(buyerUploads)
        .where(and(
            eq(buyerUploads.orderId, orderId),
            options.appId ? eq(buyerUploads.appId, options.appId) : undefined,
            options.afterId ? gt(buyerUploads.id, options.afterId) : undefined,
        ))
        .orderBy(asc(buyerUploads.id))
        .limit(limit)
        .all();
    return rows.map((row) => ({ ...row, mediaType: row.mediaType as BuyerUploadType, attachedAt: row.attachedAt ?? 0 }));
}

/** An attached upload's object, for the signed link route. Unattached or unknown: null. */
export async function readAttachedBuyerUpload(
    db: Database,
    id: string,
): Promise<{ r2Key: string; mediaType: BuyerUploadType; sizeBytes: number; filename: string } | null> {
    const row = await db.select({
        r2Key: buyerUploads.r2Key,
        mediaType: buyerUploads.mediaType,
        sizeBytes: buyerUploads.sizeBytes,
        filename: buyerUploads.filename,
    }).from(buyerUploads)
        .where(and(eq(buyerUploads.id, id), isNotNull(buyerUploads.orderId)))
        .get();
    return row ? { ...row, mediaType: row.mediaType as BuyerUploadType } : null;
}

async function deleteRows(
    db: Database,
    bucket: R2Bucket,
    rows: readonly { id: string; r2Key: string }[],
    stillDue: (id: string) => ReturnType<typeof and>,
): Promise<number> {
    let deleted = 0;
    for (const row of rows) {
        // The row first, under the condition that made it due: an upload an
        // order took meanwhile keeps its row and object.
        const removed = await db.delete(buyerUploads).where(stillDue(row.id))
            .returning({ id: buyerUploads.id })
            .catch(() => []);
        if (removed.length === 0) continue;
        await bucket.delete(row.r2Key).catch((error: unknown) => {
            console.error(`[buyer-uploads] Upload ${row.id} object not deleted:`, error instanceof Error ? error.name : "unknown error");
        });
        deleted += 1;
    }
    return deleted;
}

/** The upload sweep's condition for an ordered upload past retention: its order is settled or gone. */
function pastRetention(cutoff: SQL | number): SQL {
    return sql`${buyerUploads.attachedAt} IS NOT NULL AND ${buyerUploads.attachedAt} < ${cutoff}
        AND (${orders.id} IS NULL OR ${notInArray(orders.status, [...ERASURE_BLOCKING_ORDER_STATUSES])})`;
}

/**
 * Whether the upload sweep has work, as the cron's one due-work statement
 * asks it (a column beside the other drains'): an upload no order took
 * within 72 hours, or one past retention whose order is settled. Each is a
 * one-row walk of a partial index, the second joined to its order by key,
 * exactly the sweep's own conditions; an idle store reads no row and pays no
 * query of its own.
 */
export function buyerUploadDueProbes(db: Database) {
    return [
        db.select({ id: buyerUploads.id }).from(buyerUploads)
            .where(and(isNull(buyerUploads.orderId), lt(buyerUploads.createdAt, sql`unixepoch() - ${BUYER_UPLOAD_ORPHAN_SECONDS}`)))
            .limit(1),
        db.select({ id: buyerUploads.id }).from(buyerUploads)
            .leftJoin(orders, eq(orders.id, buyerUploads.orderId))
            .where(pastRetention(sql`unixepoch() - ${BUYER_UPLOAD_RETENTION_DAYS * 86_400}`))
            .limit(1),
    ];
}

/**
 * The upload sweep (a background drain the due-work probe runs only when
 * `buyerUploadDueProbes` finds work): uploads no order took within 72 hours,
 * then order retention, uploads attached a year ago whose order is settled
 * or gone. Oldest first on partial indexes, the retention read driven from
 * the uploads and joined to their orders by key. At most `limit` deletions a
 * run.
 */
export async function sweepBuyerUploads(
    db: Database,
    bucket: R2Bucket | undefined,
    options: { now?: number; limit?: number } = {},
): Promise<{ orphans: number; retained: number }> {
    if (!bucket) return { orphans: 0, retained: 0 };
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const limit = Math.max(1, options.limit ?? planLimits().uploads.sweepPerRun);
    const orphanCutoff = now - BUYER_UPLOAD_ORPHAN_SECONDS;
    const orphanRows = await db.select({ id: buyerUploads.id, r2Key: buyerUploads.r2Key }).from(buyerUploads)
        .where(and(isNull(buyerUploads.orderId), lt(buyerUploads.createdAt, orphanCutoff)))
        .orderBy(asc(buyerUploads.createdAt))
        .limit(limit)
        .all();
    const orphans = await deleteRows(db, bucket, orphanRows, (id) =>
        and(eq(buyerUploads.id, id), isNull(buyerUploads.orderId), lt(buyerUploads.createdAt, orphanCutoff)));

    const room = limit - orphanRows.length;
    if (room <= 0) return { orphans, retained: 0 };
    const retentionCutoff = now - BUYER_UPLOAD_RETENTION_DAYS * 86_400;
    // A LEFT JOIN keeps the uploads the outer loop: the read follows the due
    // uploads, never the order history; an order still in progress keeps its files.
    const retainedRows = await db.select({ id: buyerUploads.id, r2Key: buyerUploads.r2Key }).from(buyerUploads)
        .leftJoin(orders, eq(orders.id, buyerUploads.orderId))
        .where(pastRetention(retentionCutoff))
        .orderBy(asc(buyerUploads.attachedAt))
        .limit(room)
        .all();
    const retained = await deleteRows(db, bucket, retainedRows, (id) =>
        and(eq(buyerUploads.id, id), isNotNull(buyerUploads.attachedAt), lt(buyerUploads.attachedAt, retentionCutoff)));
    return { orphans, retained };
}
