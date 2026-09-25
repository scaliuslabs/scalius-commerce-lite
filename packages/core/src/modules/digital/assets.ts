// Digital assets (Wave B §3.1, §3.5): the files and licence-key pools a
// product delivers. Files upload in fixed 50 MiB parts into an R2 multipart
// upload under `private/digital/<asset>/<upload>` (never served publicly);
// replacing a file moves `current_r2_key`, so buyers who already own it get
// the new file, as in Shopify Digital Downloads.
import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import {
    digitalAssets,
    digitalAssetUploads,
    digitalEntitlements,
    digitalLicenceKeys,
    productVariants,
    products,
} from "@scalius/database/schema";
import {
    DIGITAL_MAX_FILE_ASSETS_PER_VARIANT,
    DIGITAL_MAX_FILE_BYTES,
    DIGITAL_UPLOAD_PART_BYTES,
    digitalObjectKey,
    digitalUploadPartCount,
    isDigitalAccessDays,
    isDigitalDownloadLimit,
    sanitizeDownloadFilename,
} from "@scalius/shared/digital";
import { AppError, ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

export type DigitalAssetStatus = "draft" | "ready" | "archived";

export interface DigitalAssetView {
    id: string;
    productId: string;
    variantId: string | null;
    kind: "file" | "licence_keys";
    status: DigitalAssetStatus;
    displayName: string;
    filename: string | null;
    mediaType: string | null;
    sizeBytes: number | null;
    /** A file is uploaded (the asset can be delivered once `ready`). */
    hasFile: boolean;
    downloadLimit: number | null;
    accessDays: number | null;
    version: number;
    /** Key pools: keys by status. Files: all zero. */
    keys: { available: number; assigned: number; revoked: number };
    /** Order lines that received this asset. */
    deliveredCount: number;
    createdAt: number;
    updatedAt: number;
}

export interface DigitalUploadSession {
    id: string;
    assetId: string;
    partSize: number;
    partCount: number;
    sizeBytes: number;
    /** Part numbers already stored (resume). */
    uploadedParts: number[];
}

/** What an upload row keeps in its `parts` JSON: the declared file and each stored part's etag. */
interface UploadManifest {
    sizeBytes: number;
    filename: string;
    mediaType: string;
    parts: Record<string, string>;
}

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/i;

function newAssetId(): string {
    return `dga_${nanoid(16)}`;
}

function newUploadId(): string {
    return `dgu_${nanoid(16)}`;
}

function requireBucket(bucket: R2Bucket | undefined): R2Bucket {
    if (!bucket) throw new ServiceUnavailableError("File storage is unavailable right now.");
    return bucket;
}

function displayNameOf(value: string | undefined, fallback: string): string {
    const name = (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 200);
    return name || fallback;
}

function checkLimits(input: { downloadLimit?: number | null; accessDays?: number | null }): void {
    if (input.downloadLimit !== undefined && !isDigitalDownloadLimit(input.downloadLimit)) {
        throw new ValidationError("Downloads per purchase must be a whole number from 1 to 100, or unlimited.");
    }
    if (input.accessDays !== undefined && !isDigitalAccessDays(input.accessDays)) {
        throw new ValidationError("Access must last 1 to 3650 days, or forever.");
    }
}

function checkFile(input: { filename: string; mediaType: string; sizeBytes: number }): { filename: string; mediaType: string; partCount: number } {
    const partCount = digitalUploadPartCount(input.sizeBytes);
    if (partCount === null) {
        throw new ValidationError(`Files must be between 1 byte and ${Math.floor(DIGITAL_MAX_FILE_BYTES / (1024 * 1024))} MB.`);
    }
    const mediaType = input.mediaType.trim().toLowerCase() || "application/octet-stream";
    if (!MEDIA_TYPE.test(mediaType)) throw new ValidationError("The file type is not recognised.");
    return { filename: sanitizeDownloadFilename(input.filename), mediaType, partCount };
}

function readManifest(parts: string): UploadManifest | null {
    try {
        const value = JSON.parse(parts) as Partial<UploadManifest>;
        if (
            !value || typeof value !== "object" || Array.isArray(value)
            || typeof value.sizeBytes !== "number" || typeof value.filename !== "string"
            || typeof value.mediaType !== "string" || !value.parts || typeof value.parts !== "object"
        ) return null;
        return value as UploadManifest;
    } catch {
        return null;
    }
}

function sessionOf(upload: { id: string; assetId: string }, manifest: UploadManifest): DigitalUploadSession {
    return {
        id: upload.id,
        assetId: upload.assetId,
        partSize: DIGITAL_UPLOAD_PART_BYTES,
        partCount: digitalUploadPartCount(manifest.sizeBytes) ?? 0,
        sizeBytes: manifest.sizeBytes,
        uploadedParts: Object.keys(manifest.parts).map(Number).filter(Number.isInteger).sort((a, b) => a - b),
    };
}

/** Assets of one product with their pool counts, oldest first. */
export async function listProductDigitalAssets(db: Database, productId: string): Promise<DigitalAssetView[]> {
    const rows = await db.select({
        id: digitalAssets.id,
        productId: digitalAssets.productId,
        variantId: digitalAssets.variantId,
        kind: digitalAssets.kind,
        status: digitalAssets.status,
        displayName: digitalAssets.displayName,
        filename: digitalAssets.filename,
        mediaType: digitalAssets.mediaType,
        sizeBytes: digitalAssets.sizeBytes,
        currentR2Key: digitalAssets.currentR2Key,
        downloadLimit: digitalAssets.downloadLimit,
        accessDays: digitalAssets.accessDays,
        version: digitalAssets.version,
        createdAt: digitalAssets.createdAt,
        updatedAt: digitalAssets.updatedAt,
        available: sql<number>`(SELECT count(*) FROM ${digitalLicenceKeys} k WHERE k.asset_id = "digital_assets"."id" AND k.status = 'available')`,
        assigned: sql<number>`(SELECT count(*) FROM ${digitalLicenceKeys} k WHERE k.asset_id = "digital_assets"."id" AND k.status = 'assigned')`,
        revoked: sql<number>`(SELECT count(*) FROM ${digitalLicenceKeys} k WHERE k.asset_id = "digital_assets"."id" AND k.status = 'revoked')`,
        deliveredCount: sql<number>`(SELECT count(*) FROM ${digitalEntitlements} e WHERE e.asset_id = "digital_assets"."id")`,
    }).from(digitalAssets)
        .where(eq(digitalAssets.productId, productId))
        .orderBy(asc(digitalAssets.sortOrder), asc(digitalAssets.createdAt), asc(digitalAssets.id))
        .all();
    return rows.map(({ currentR2Key, available, assigned, revoked, ...row }) => ({
        ...row,
        hasFile: currentR2Key !== null,
        keys: { available: Number(available), assigned: Number(assigned), revoked: Number(revoked) },
        deliveredCount: Number(row.deliveredCount),
    }));
}

export async function getDigitalAsset(db: Database, assetId: string): Promise<DigitalAssetView> {
    const row = await db.select({ productId: digitalAssets.productId }).from(digitalAssets).where(eq(digitalAssets.id, assetId)).get();
    if (!row) throw new NotFoundError("Digital item not found");
    const asset = (await listProductDigitalAssets(db, row.productId)).find((candidate) => candidate.id === assetId);
    if (!asset) throw new NotFoundError("Digital item not found");
    return asset;
}

export type CreateDigitalAssetInput =
    | {
        kind: "file";
        variantId?: string | null;
        displayName?: string;
        filename: string;
        mediaType: string;
        sizeBytes: number;
        downloadLimit?: number | null;
        accessDays?: number | null;
    }
    | {
        kind: "licence_keys";
        variantId: string;
        displayName?: string;
    };

/** A live digital SKU of this product, or a validation error that says what to fix. */
async function requireDigitalVariant(db: Database, productId: string, variantId: string) {
    const variant = await db.select({
        id: productVariants.id,
        fulfillmentKind: productVariants.fulfillmentKind,
        trackInventory: productVariants.trackInventory,
    }).from(productVariants)
        .where(and(eq(productVariants.id, variantId), eq(productVariants.productId, productId), isNull(productVariants.deletedAt)))
        .get();
    if (!variant) throw new ValidationError("Choose a variant of this product.");
    if (variant.fulfillmentKind !== "digital") throw new ValidationError("Set this variant's fulfilment to Digital first.");
    return variant;
}

/**
 * Adds a file (with its first upload session) or a licence-key pool to a
 * product. A key pool belongs to one variant, whose quantity must be tracked:
 * the pool is that variant's stock.
 */
export async function createDigitalAsset(
    db: Database,
    bucket: R2Bucket | undefined,
    productId: string,
    input: CreateDigitalAssetInput,
): Promise<{ asset: DigitalAssetView; upload: DigitalUploadSession | null }> {
    const product = await db.select({ id: products.id, deletedAt: products.deletedAt }).from(products).where(eq(products.id, productId)).get();
    if (!product || product.deletedAt) throw new NotFoundError("Product not found");
    const variantId = input.variantId ?? null;
    if (variantId) {
        const variant = await requireDigitalVariant(db, productId, variantId);
        if (input.kind === "licence_keys" && !variant.trackInventory) {
            throw new ValidationError("Turn on quantity tracking for this variant: its licence keys are its stock.");
        }
    } else if (input.kind === "licence_keys") {
        throw new ValidationError("Choose the variant these licence keys belong to.");
    }

    const live = and(eq(digitalAssets.productId, productId), ne(digitalAssets.status, "archived"));
    const scope = variantId ? eq(digitalAssets.variantId, variantId) : isNull(digitalAssets.variantId);
    const [counted] = await db.select({
        files: sql<number>`coalesce(sum(CASE WHEN ${digitalAssets.kind} = 'file' THEN 1 ELSE 0 END), 0)`,
        pools: sql<number>`coalesce(sum(CASE WHEN ${digitalAssets.kind} = 'licence_keys' THEN 1 ELSE 0 END), 0)`,
    }).from(digitalAssets).where(and(live, scope)).all();
    const assetId = newAssetId();

    if (input.kind === "licence_keys") {
        if (Number(counted?.pools ?? 0) >= 1) throw new ConflictError("This variant already has a licence-key pool. Import more keys into it.");
        await db.insert(digitalAssets).values({
            id: assetId,
            productId,
            variantId,
            kind: "licence_keys",
            status: "ready",
            displayName: displayNameOf(input.displayName, "Licence key"),
            downloadLimit: null,
        }).run();
        return { asset: await getDigitalAsset(db, assetId), upload: null };
    }

    if (Number(counted?.files ?? 0) >= DIGITAL_MAX_FILE_ASSETS_PER_VARIANT) {
        throw new ConflictError(`Each variant can deliver at most ${DIGITAL_MAX_FILE_ASSETS_PER_VARIANT} files.`);
    }
    checkLimits(input);
    const file = checkFile(input);
    const uploadBucket = requireBucket(bucket);
    const uploadId = newUploadId();
    const key = digitalObjectKey(assetId, uploadId);
    const multipart = await uploadBucket.createMultipartUpload(key, {
        httpMetadata: { contentType: "application/octet-stream" },
    });
    const manifest: UploadManifest = { sizeBytes: input.sizeBytes, filename: file.filename, mediaType: file.mediaType, parts: {} };
    try {
        await safeBatch(db, [
            db.insert(digitalAssets).values({
                id: assetId,
                productId,
                variantId,
                kind: "file",
                status: "draft",
                displayName: displayNameOf(input.displayName, file.filename),
                filename: file.filename,
                mediaType: file.mediaType,
                downloadLimit: input.downloadLimit === undefined ? 5 : input.downloadLimit,
                accessDays: input.accessDays ?? null,
            }),
            db.insert(digitalAssetUploads).values({
                id: uploadId,
                assetId,
                r2Key: key,
                r2UploadId: multipart.uploadId,
                status: "uploading",
                parts: JSON.stringify(manifest),
            }),
        ]);
    } catch (error) {
        await multipart.abort().catch(() => undefined);
        throw error;
    }
    return {
        asset: await getDigitalAsset(db, assetId),
        upload: sessionOf({ id: uploadId, assetId }, manifest),
    };
}

/** Starts replacing an asset's file (a new upload session); the current file keeps serving until it completes. */
export async function startDigitalAssetUpload(
    db: Database,
    bucket: R2Bucket | undefined,
    assetId: string,
    input: { filename: string; mediaType: string; sizeBytes: number },
): Promise<DigitalUploadSession> {
    const asset = await db.select({ id: digitalAssets.id, kind: digitalAssets.kind, status: digitalAssets.status })
        .from(digitalAssets).where(eq(digitalAssets.id, assetId)).get();
    if (!asset) throw new NotFoundError("Digital item not found");
    if (asset.kind !== "file") throw new ValidationError("Only file items take uploads.");
    if (asset.status === "archived") throw new ConflictError("Restore this file before replacing it.");
    const file = checkFile(input);
    const uploadBucket = requireBucket(bucket);
    const uploadId = newUploadId();
    const key = digitalObjectKey(assetId, uploadId);
    const multipart = await uploadBucket.createMultipartUpload(key, {
        httpMetadata: { contentType: "application/octet-stream" },
    });
    const manifest: UploadManifest = { sizeBytes: input.sizeBytes, filename: file.filename, mediaType: file.mediaType, parts: {} };
    try {
        await db.insert(digitalAssetUploads).values({
            id: uploadId,
            assetId,
            r2Key: key,
            r2UploadId: multipart.uploadId,
            status: "uploading",
            parts: JSON.stringify(manifest),
        }).run();
    } catch (error) {
        await multipart.abort().catch(() => undefined);
        throw error;
    }
    return sessionOf({ id: uploadId, assetId }, manifest);
}

async function requireOpenUpload(db: Database, assetId: string, uploadId: string) {
    const upload = await db.select({
        id: digitalAssetUploads.id,
        assetId: digitalAssetUploads.assetId,
        r2Key: digitalAssetUploads.r2Key,
        r2UploadId: digitalAssetUploads.r2UploadId,
        status: digitalAssetUploads.status,
        parts: digitalAssetUploads.parts,
    }).from(digitalAssetUploads)
        .where(and(eq(digitalAssetUploads.id, uploadId), eq(digitalAssetUploads.assetId, assetId)))
        .get();
    if (!upload) throw new NotFoundError("Upload not found");
    const manifest = readManifest(upload.parts);
    if (!manifest) throw new ConflictError("This upload can't continue. Start the upload again.");
    return { upload, manifest };
}

/** The upload session, for resuming after a dropped connection. */
export async function getDigitalAssetUpload(db: Database, assetId: string, uploadId: string): Promise<DigitalUploadSession & { status: string }> {
    const { upload, manifest } = await requireOpenUpload(db, assetId, uploadId);
    return { ...sessionOf(upload, manifest), status: upload.status };
}

/** Expected byte length of part `partNumber` (1-based) of a `sizeBytes` file. */
export function expectedDigitalPartBytes(sizeBytes: number, partNumber: number): number | null {
    const count = digitalUploadPartCount(sizeBytes);
    if (count === null || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) return null;
    return partNumber < count ? DIGITAL_UPLOAD_PART_BYTES : sizeBytes - DIGITAL_UPLOAD_PART_BYTES * (count - 1);
}

/**
 * Stores one part. Every part but the last is exactly 50 MiB; the caller
 * streams a body of exactly `size` bytes. Re-sending a part replaces it.
 */
export async function uploadDigitalAssetPart(
    db: Database,
    bucket: R2Bucket | undefined,
    input: { assetId: string; uploadId: string; partNumber: number; size: number; body: ReadableStream | ArrayBuffer | Uint8Array },
): Promise<{ partNumber: number; size: number }> {
    const { upload, manifest } = await requireOpenUpload(db, input.assetId, input.uploadId);
    if (upload.status !== "uploading") throw new ConflictError("This upload is already finished.");
    const expected = expectedDigitalPartBytes(manifest.sizeBytes, input.partNumber);
    if (expected === null) throw new ValidationError("This part number is outside the upload.");
    if (expected !== input.size) throw new ValidationError(`Part ${input.partNumber} must be exactly ${expected} bytes.`);
    const multipart = requireBucket(bucket).resumeMultipartUpload(upload.r2Key, upload.r2UploadId);
    const stored = await multipart.uploadPart(input.partNumber, input.body);
    // One JSON path per part: re-sending replaces, parallel parts never overwrite each other.
    await db.update(digitalAssetUploads).set({
        parts: sql`json_set(${digitalAssetUploads.parts}, ${`$.parts."${input.partNumber}"`}, ${stored.etag})`,
        updatedAt: sql`unixepoch()`,
    }).where(and(eq(digitalAssetUploads.id, upload.id), eq(digitalAssetUploads.status, "uploading"))).run();
    return { partNumber: input.partNumber, size: input.size };
}

/**
 * Completes the multipart upload once every part is stored, then points the
 * asset at the new object (`ready` unless archived). Safe to repeat.
 */
export async function completeDigitalAssetUpload(
    db: Database,
    bucket: R2Bucket | undefined,
    input: { assetId: string; uploadId: string },
): Promise<DigitalAssetView> {
    const { upload, manifest } = await requireOpenUpload(db, input.assetId, input.uploadId);
    if (upload.status === "aborted") throw new ConflictError("This upload was cancelled. Start the upload again.");
    const storage = requireBucket(bucket);
    if (upload.status === "uploading") {
        const count = digitalUploadPartCount(manifest.sizeBytes) ?? 0;
        const parts: R2UploadedPart[] = [];
        for (let partNumber = 1; partNumber <= count; partNumber += 1) {
            const etag = manifest.parts[String(partNumber)];
            if (!etag) throw new AppError(409, "UPLOAD_INCOMPLETE", `Part ${partNumber} of ${count} is missing. Resume the upload.`);
            parts.push({ partNumber, etag });
        }
        try {
            await storage.resumeMultipartUpload(upload.r2Key, upload.r2UploadId).complete(parts);
        } catch (error) {
            // A retry after the object was assembled: the object is the proof.
            const head = await storage.head(upload.r2Key);
            if (!head || head.size !== manifest.sizeBytes) throw error;
        }
        const head = await storage.head(upload.r2Key);
        if (!head || head.size !== manifest.sizeBytes) {
            throw new AppError(409, "UPLOAD_SIZE_MISMATCH", "The uploaded file isn't the declared size. Start the upload again.");
        }
    }
    await safeBatch(db, [
        db.update(digitalAssetUploads).set({ status: "complete", updatedAt: sql`unixepoch()` })
            .where(eq(digitalAssetUploads.id, upload.id)),
        db.update(digitalAssets).set({
            currentR2Key: upload.r2Key,
            filename: manifest.filename,
            mediaType: manifest.mediaType,
            sizeBytes: manifest.sizeBytes,
            status: sql`CASE WHEN ${digitalAssets.status} = 'archived' THEN 'archived' ELSE 'ready' END`,
            version: sql`${digitalAssets.version} + 1`,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(digitalAssets.id, input.assetId),
            // Never move back to an older upload than the one serving now.
            sql`(${digitalAssets.currentR2Key} IS NULL OR ${digitalAssets.currentR2Key} = ${upload.r2Key} OR ${upload.status} = 'uploading')`,
        )),
    ]);
    return getDigitalAsset(db, input.assetId);
}

export interface UpdateDigitalAssetInput {
    displayName?: string;
    downloadLimit?: number | null;
    accessDays?: number | null;
    /** `archived` stops delivering it to new orders; `ready` restores it. */
    status?: "ready" | "archived";
    /** The version the editor loaded. */
    version: number;
}

/**
 * Renames an asset, changes its limits (new deliveries only: delivered lines
 * keep their snapshot), or archives/restores it.
 */
export async function updateDigitalAsset(db: Database, assetId: string, input: UpdateDigitalAssetInput): Promise<DigitalAssetView> {
    checkLimits(input);
    const asset = await db.select({ kind: digitalAssets.kind, currentR2Key: digitalAssets.currentR2Key })
        .from(digitalAssets).where(eq(digitalAssets.id, assetId)).get();
    if (!asset) throw new NotFoundError("Digital item not found");
    if (asset.kind === "licence_keys" && (input.downloadLimit !== undefined || input.accessDays !== undefined)) {
        throw new ValidationError("Licence keys have no download limit.");
    }
    if (input.status === "ready" && asset.kind === "file" && !asset.currentR2Key) {
        throw new ValidationError("Upload the file before offering it.");
    }
    const updated = await db.update(digitalAssets).set({
        ...(input.displayName !== undefined ? { displayName: displayNameOf(input.displayName, "Download") } : {}),
        ...(input.downloadLimit !== undefined ? { downloadLimit: input.downloadLimit } : {}),
        ...(input.accessDays !== undefined ? { accessDays: input.accessDays } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        version: sql`${digitalAssets.version} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(eq(digitalAssets.id, assetId), eq(digitalAssets.version, input.version)))
        .returning({ id: digitalAssets.id });
    if (updated.length === 0) throw new AppError(409, "DIGITAL_ASSET_CHANGED", "Someone else changed this item. Reload and try again.");
    return getDigitalAsset(db, assetId);
}

/**
 * Deletes an asset nobody received (and its objects). Delivered files and key
 * pools with keys stay as records: archive them instead.
 */
export async function deleteDigitalAsset(db: Database, bucket: R2Bucket | undefined, assetId: string): Promise<{ deleted: true }> {
    const asset = await db.select({
        id: digitalAssets.id,
        entitlements: sql<number>`(SELECT count(*) FROM ${digitalEntitlements} e WHERE e.asset_id = "digital_assets"."id")`,
        keys: sql<number>`(SELECT count(*) FROM ${digitalLicenceKeys} k WHERE k.asset_id = "digital_assets"."id")`,
    }).from(digitalAssets).where(eq(digitalAssets.id, assetId)).get();
    if (!asset) throw new NotFoundError("Digital item not found");
    if (Number(asset.entitlements) > 0 || Number(asset.keys) > 0) {
        throw new AppError(409, "DIGITAL_ASSET_IN_USE", "Customers received this item or it holds keys. Archive it instead.");
    }
    const uploads = await db.select({ r2Key: digitalAssetUploads.r2Key, r2UploadId: digitalAssetUploads.r2UploadId, status: digitalAssetUploads.status })
        .from(digitalAssetUploads).where(eq(digitalAssetUploads.assetId, assetId)).all();
    const removed = await db.delete(digitalAssets).where(and(
        eq(digitalAssets.id, assetId),
        sql`NOT EXISTS (SELECT 1 FROM ${digitalEntitlements} e WHERE e.asset_id = ${assetId})`,
    )).returning({ id: digitalAssets.id });
    if (removed.length === 0) throw new AppError(409, "DIGITAL_ASSET_IN_USE", "Customers received this item. Archive it instead.");
    if (bucket) {
        for (const upload of uploads) {
            if (upload.status === "uploading") {
                await bucket.resumeMultipartUpload(upload.r2Key, upload.r2UploadId).abort().catch(() => undefined);
            }
        }
        const keys = uploads.filter((upload) => upload.status === "complete").map((upload) => upload.r2Key);
        if (keys.length > 0) await bucket.delete(keys).catch(() => undefined);
    }
    return { deleted: true };
}
