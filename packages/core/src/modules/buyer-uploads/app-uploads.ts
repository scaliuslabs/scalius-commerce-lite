// App uploads (COMMERCE-HOOKS H17): a file staff give one of an app's admin
// forms (a `file-field`, e.g. a CSV import), kept in the buyer-uploads store
// as target `admin`: bound to its app and the admin route the form posts to
// (`<app id>.<route>`), never attached to an order. The app reads it in
// bounded slices (`ctx.uploads.read`) and deletes it when it is done; the
// 72-hour sweep deletes one it never did. Only its app reads it: another
// app's id, an expired one and a buyer's upload are the same
// `uploads_not_found`. Logs carry upload ids only, never names or bytes.
import type { Database } from "@scalius/database/client";
import { buyerUploads } from "@scalius/database/schema";
import {
    ADMIN_UPLOAD_TYPES,
    BUYER_UPLOAD_ORPHAN_SECONDS,
    buyerUploadFilename,
    buyerUploadR2Key,
    sniffAdminUploadType,
    type AdminUploadType,
} from "@scalius/shared/buyer-uploads";
import { sha256Hex } from "@scalius/shared/hash";
import { planLimits } from "@scalius/shared/plan-limits";
import {
    PLUGIN_UPLOAD_ID_PATTERN,
    pluginUploadReadBounds,
    pluginUploadSlice,
    type PluginUpload,
    type PluginUploadSlice,
} from "@scalius/shared/plugins/uploads";
import { and, eq, gte, isNull } from "drizzle-orm";
import { AppError, RateLimitError } from "../../errors";
import { newBuyerUploadId } from "./uploads";

/**
 * A refusal of `ctx.uploads` (the bridge forwards `uploadCode` as the app's
 * sealed error code). This domain is a leaf, so the plugin domain's own error
 * class is not imported here.
 */
export class AppUploadError extends AppError {
    readonly uploadCode: "uploads_invalid" | "uploads_not_found";

    constructor(code: "uploads_invalid" | "uploads_not_found", message: string) {
        super(code === "uploads_not_found" ? 404 : 422, code, message);
        this.name = "AppUploadError";
        this.uploadCode = code;
    }
}

export interface StageAppUploadInput {
    appId: string;
    /** The admin route whose form takes the file. */
    route: string;
    /** The most bytes this deployment takes (`planLimits().uploads.maxBytes`). */
    maxBytes: number;
    /** The name the browser sent (cleaned; its extension follows the sniffed type). */
    filename: string | null;
    bytes: Uint8Array;
    /** A keyed hash of the staff member (`appUploadStaffKey`). */
    uploaderKey: string;
}

export interface StagedAppUpload {
    id: string;
    filename: string;
    mediaType: AdminUploadType;
    sizeBytes: number;
    expiresAt: string;
}

/**
 * Stores staff's file for one of the app's admin forms: typed from its bytes
 * (UTF-8 text without control characters or markup, whatever its name or
 * declared type), at most `maxBytes`, and at most the plan's
 * `stagedPerVisitor` live uploads per staff member. The object is written
 * first; a failed insert deletes it again.
 */
export async function stageAppUpload(db: Database, bucket: R2Bucket, input: StageAppUploadInput): Promise<StagedAppUpload> {
    const sizeBytes = input.bytes.byteLength;
    if (sizeBytes < 1 || sizeBytes > input.maxBytes) {
        throw new AppError(400, "upload_too_large", `Files must be ${Math.floor(input.maxBytes / 1_048_576 * 10) / 10} MB or smaller.`, { maxBytes: input.maxBytes });
    }
    const mediaType = sniffAdminUploadType(input.bytes);
    if (!mediaType) {
        throw new AppError(400, "upload_type_not_accepted", "This file type is not accepted here. Choose a CSV file.", { accept: ADMIN_UPLOAD_TYPES });
    }
    const now = Math.floor(Date.now() / 1000);
    const cap = planLimits().uploads.stagedPerVisitor;
    const live = await db.select({ id: buyerUploads.id, createdAt: buyerUploads.createdAt }).from(buyerUploads)
        .where(and(isNull(buyerUploads.orderId), eq(buyerUploads.uploaderKey, input.uploaderKey), gte(buyerUploads.createdAt, now - BUYER_UPLOAD_ORPHAN_SECONDS)))
        .limit(cap)
        .all();
    if (live.length >= cap) {
        // A slot frees when the oldest upload of the window ages out of it.
        const oldest = Math.min(...live.map((row) => row.createdAt));
        throw new RateLimitError("You have uploaded many files recently. Wait for the apps to finish with them, or try again later.", oldest + BUYER_UPLOAD_ORPHAN_SECONDS - now);
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
            fieldKey: `${input.appId}.${input.route}`,
            target: "admin",
            productId: null,
            r2Key,
            mediaType,
            sizeBytes,
            filename,
            sha256,
            uploaderKey: input.uploaderKey,
            createdAt: now,
        });
    } catch (error) {
        await bucket.delete(r2Key).catch(() => undefined);
        throw error;
    }
    return { id, filename, mediaType, sizeBytes, expiresAt: new Date((now + BUYER_UPLOAD_ORPHAN_SECONDS) * 1000).toISOString() };
}

type AppUploadRow = { id: string; appId: string; fieldKey: string; r2Key: string; mediaType: string; sizeBytes: number; filename: string; createdAt: number };

function uploadId(value: unknown): string {
    if (typeof value !== "string" || !PLUGIN_UPLOAD_ID_PATTERN.test(value)) throw new AppUploadError("uploads_invalid", "An upload id is bup_ and 24 characters.");
    return value;
}

/** The app's own live admin upload, or null (another app's, a buyer's, a deleted or expired one). */
async function ownUpload(db: Database, appId: string, id: string, now: number): Promise<AppUploadRow | null> {
    const row = await db.select({
        id: buyerUploads.id,
        appId: buyerUploads.appId,
        fieldKey: buyerUploads.fieldKey,
        r2Key: buyerUploads.r2Key,
        mediaType: buyerUploads.mediaType,
        sizeBytes: buyerUploads.sizeBytes,
        filename: buyerUploads.filename,
        createdAt: buyerUploads.createdAt,
    }).from(buyerUploads)
        .where(and(eq(buyerUploads.id, id), eq(buyerUploads.appId, appId), eq(buyerUploads.target, "admin"), isNull(buyerUploads.orderId)))
        .get();
    if (!row || row.createdAt < now - BUYER_UPLOAD_ORPHAN_SECONDS) return null;
    return row;
}

const notFound = (): never => {
    throw new AppUploadError("uploads_not_found", "The upload was not found.");
};

function view(row: AppUploadRow): PluginUpload {
    return {
        id: row.id,
        filename: row.filename,
        mediaType: row.mediaType as AdminUploadType,
        sizeBytes: row.sizeBytes,
        route: row.fieldKey.slice(row.appId.length + 1),
        createdAt: new Date(row.createdAt * 1000).toISOString(),
        expiresAt: new Date((row.createdAt + BUYER_UPLOAD_ORPHAN_SECONDS) * 1000).toISOString(),
    };
}

/** `ctx.uploads.get`: one of the app's uploads, or null. */
export async function readAppUpload(db: Database, appId: string, idInput: unknown, now: number = Math.floor(Date.now() / 1000)): Promise<PluginUpload | null> {
    const row = await ownUpload(db, appId, uploadId(idInput), now);
    return row ? view(row) : null;
}

/**
 * `ctx.uploads.read`: one slice of the app's upload, at most
 * `PLUGIN_UPLOAD_READ_MAX_BYTES` from `offset`, ending after its last whole
 * line (`pluginUploadSlice`). One ranged R2 read.
 */
export async function readAppUploadSlice(
    db: Database,
    bucket: R2Bucket | undefined,
    appId: string,
    idInput: unknown,
    options: unknown,
    now: number = Math.floor(Date.now() / 1000),
): Promise<PluginUploadSlice> {
    const id = uploadId(idInput);
    const bounds = pluginUploadReadBounds(options);
    if (!bounds.ok) throw new AppUploadError("uploads_invalid", bounds.message);
    const row = await ownUpload(db, appId, id, now) ?? notFound();
    if (bounds.offset > row.sizeBytes) throw new AppUploadError("uploads_invalid", `offset is at most the file's ${row.sizeBytes} bytes.`);
    const length = Math.min(bounds.length, row.sizeBytes - bounds.offset);
    let window = new Uint8Array();
    if (length > 0) {
        const object = bucket ? await bucket.get(row.r2Key, { range: { offset: bounds.offset, length } }) : null;
        if (!object || !("arrayBuffer" in object)) notFound();
        window = new Uint8Array(await (object as R2ObjectBody).arrayBuffer()).subarray(0, length);
    }
    const slice = pluginUploadSlice(window, bounds.offset, row.sizeBytes);
    if (!slice) throw new AppUploadError("uploads_invalid", "offset falls inside a character: pass 0 or the nextOffset a read answered.");
    return slice;
}

/**
 * `ctx.uploads.delete`: the app is done with its upload (row first, then the
 * object). False when there was none to delete.
 */
export async function deleteAppUpload(db: Database, bucket: R2Bucket | undefined, appId: string, idInput: unknown): Promise<boolean> {
    const id = uploadId(idInput);
    const removed = await db.delete(buyerUploads)
        .where(and(eq(buyerUploads.id, id), eq(buyerUploads.appId, appId), eq(buyerUploads.target, "admin"), isNull(buyerUploads.orderId)))
        .returning({ r2Key: buyerUploads.r2Key });
    const row = removed[0];
    if (!row) return false;
    await bucket?.delete(row.r2Key).catch((error: unknown) => {
        console.error(`[buyer-uploads] App upload ${id} object not deleted:`, error instanceof Error ? error.name : "unknown error");
    });
    return true;
}
