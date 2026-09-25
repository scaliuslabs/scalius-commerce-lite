import {
    media,
    mediaFolders,
    mediaUploadParts,
    mediaUploadSessions,
} from "@scalius/database/schema";
import {
    buildBatchGuard,
    isBatchGuardError,
    safeBatch,
    type Database,
} from "@scalius/database/client";
import {
    abortMediaMultipartUpload,
    buildMediaObjectKey,
    completeMediaMultipartUpload,
    createMediaMultipartUpload,
    deleteFile,
    deleteMediaVariants,
    headMediaObject,
    putMediaVariant,
    uploadMediaMultipartPart,
} from "../../integrations/storage";
import {
    mediaVariantQuality,
    mediaVariantWidths,
} from "@scalius/shared/media-variants";
import {
    MEDIA_MULTIPART_PART_SIZE_BYTES,
    MEDIA_SIGNATURE_READ_BYTES,
    validateMediaFileMetadata,
    validateMediaSignature,
} from "@scalius/shared/media-policy";
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import {
    AppError,
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationError,
} from "@scalius/core/errors";
import type { InitiateMediaUploadInput, UpdateMediaInput } from "./media.validation";
import { presentMediaProjection } from "./media.presentation";
import { countMediaUsage, loadMediaUsage, noMediaUsage, type MediaUsage } from "./media.usage";

const MAX_COMMAND_IDS = 90;
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export class MediaDependencyConflictError extends AppError {
    constructor(usage: MediaUsage) {
        super(
            409,
            "MEDIA_DEPENDENCY_CONFLICT",
            "This file is still used. Remove it from those places before deleting it permanently. Files shown on past orders are kept.",
            usage,
        );
        this.name = "MediaDependencyConflictError";
    }
}

type SortField = "createdAt" | "size" | "filename";
type SortOrder = "asc" | "desc";

type MediaListCursor = {
    sortBy: SortField;
    sortOrder: SortOrder;
    value: string | number;
    id: string;
    scope: string;
};

function encodeCursor(value: object): string {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function decodeCursor<T>(cursor: string): T {
    if (!cursor || cursor.length > 2_000) throw new ValidationError("Media cursor is invalid.");
    try {
        const padded = cursor.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(cursor.length / 4) * 4, "=");
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
        throw new ValidationError("Media cursor is invalid.");
    }
}

const poster = alias(media, "media_poster");
const mediaProjection = {
    ...getTableColumns(media),
    posterObjectKey: poster.objectKey,
    posterVariantWidth: poster.variantWidth,
    posterKind: poster.kind,
    posterStatus: poster.status,
};

async function readPresentedMedia(db: Database, id: string) {
    const row = await db.select(mediaProjection).from(media)
        .leftJoin(poster, eq(poster.id, media.posterMediaId))
        .where(eq(media.id, id))
        .get();
    return row ? presentMediaProjection(row) : null;
}

function expectedPartCount(size: number): number {
    return Math.ceil(size / MEDIA_MULTIPART_PART_SIZE_BYTES);
}

function expectedPartSize(totalSize: number, expectedParts: number, partNumber: number): number {
    return partNumber < expectedParts
        ? MEDIA_MULTIPART_PART_SIZE_BYTES
        : totalSize - MEDIA_MULTIPART_PART_SIZE_BYTES * (expectedParts - 1);
}

function isExpired(value: Date): boolean {
    return value.getTime() <= Date.now();
}

async function expireMediaUploadSession(
    db: Database,
    initial: typeof mediaUploadSessions.$inferSelect,
    bucket: R2Bucket,
) {
    let session = initial;
    if (session.uploadId && session.state !== "aborting") {
        const claimed = await db.update(mediaUploadSessions).set({
            state: "aborting",
            version: session.version + 1,
            updatedAt: sql`(unixepoch())`,
        }).where(and(
            eq(mediaUploadSessions.id, session.id),
            eq(mediaUploadSessions.version, session.version),
            inArray(mediaUploadSessions.state, ["initiated", "uploading", "failed"]),
        )).returning().get();
        if (!claimed) throw new ConflictError("Media upload cleanup changed. Retry shortly.");
        session = claimed;
    }
    if (session.uploadId) {
        await abortMediaMultipartUpload({
            objectKey: session.objectKey,
            uploadId: session.uploadId,
            bucket,
        });
    }
    await db.update(mediaUploadSessions).set({
        state: "expired",
        version: sql`${mediaUploadSessions.version} + 1`,
        updatedAt: sql`(unixepoch())`,
    }).where(and(
        eq(mediaUploadSessions.id, session.id),
        eq(mediaUploadSessions.version, session.version),
        inArray(mediaUploadSessions.state, ["initializing", "initiated", "uploading", "aborting", "failed"]),
    ));
}

async function assertActiveFolder(db: Database, folderId: string | null | undefined) {
    if (!folderId) return;
    const folder = await db
        .select({ id: mediaFolders.id })
        .from(mediaFolders)
        .where(and(eq(mediaFolders.id, folderId), isNull(mediaFolders.deletedAt)))
        .get();
    if (!folder) throw new ValidationError("Media folder does not exist.");
}

export async function listMediaFiles(db: Database, input: {
    cursor?: string;
    limit?: number;
    search?: string;
    folderId?: string;
    sortBy?: SortField;
    sortOrder?: SortOrder;
    mimeType?: string;
    kind?: "image" | "video";
    view?: "ready" | "trash";
    /** "missing": images that can still get pre-generated renditions. */
    variants?: "missing";
}) {
    const boundedLimit = Math.min(100, Math.max(1, input.limit ?? 24));
    const sortBy = input.sortBy ?? "createdAt";
    const sortOrder = input.sortOrder ?? "desc";
    const search = input.search?.trim() ?? "";
    const mimeType = input.mimeType?.trim().toLowerCase() ?? "";
    const conditions = [eq(media.status, input.view === "trash" ? "trashed" : "ready")];
    const scope = JSON.stringify({
        search,
        folderId: input.folderId ?? "all",
        mimeType,
        kind: input.kind ?? "all",
        view: input.view ?? "ready",
        variants: input.variants ?? "all",
    });

    if (search) conditions.push(like(media.filename, `%${search}%`));
    if (input.folderId !== undefined && input.folderId !== "all") {
        conditions.push(
            input.folderId === "" || input.folderId === "root" || input.folderId === "null"
                ? isNull(media.folderId)
                : eq(media.folderId, input.folderId),
        );
    }
    if (mimeType) conditions.push(like(media.mimeType, `${mimeType}%`));
    if (input.kind) conditions.push(eq(media.kind, input.kind));
    if (input.variants === "missing") {
        conditions.push(
            eq(media.kind, "image"),
            isNull(media.variantWidth),
            inArray(media.mimeType, [...VARIANT_SOURCE_MIME_TYPES]),
        );
    }

    const sortColumn = sortBy === "size" ? media.size : sortBy === "filename" ? media.filename : media.createdAt;
    if (input.cursor) {
        const cursor = decodeCursor<MediaListCursor>(input.cursor);
        if (
            cursor.sortBy !== sortBy || cursor.sortOrder !== sortOrder || cursor.scope !== scope ||
            typeof cursor.id !== "string" || !["string", "number"].includes(typeof cursor.value)
        ) throw new ValidationError("Media cursor does not match this sort.");
        if (
            cursor.id.length < 8 || cursor.id.length > 160 ||
            (sortBy === "filename" && (typeof cursor.value !== "string" || cursor.value.length > 255)) ||
            (sortBy !== "filename" && (typeof cursor.value !== "number" || !Number.isSafeInteger(cursor.value) || cursor.value < 0))
        ) throw new ValidationError("Media cursor value is invalid.");
        const idCompare = sortOrder === "asc" ? gt(media.id, cursor.id) : lt(media.id, cursor.id);
        const compare = sortBy === "createdAt"
            ? (() => {
                const value = new Date(Number(cursor.value));
                return sortOrder === "asc"
                    ? or(gt(media.createdAt, value), and(eq(media.createdAt, value), idCompare))
                    : or(lt(media.createdAt, value), and(eq(media.createdAt, value), idCompare));
            })()
            : sortBy === "size"
                ? sortOrder === "asc"
                    ? or(gt(media.size, Number(cursor.value)), and(eq(media.size, Number(cursor.value)), idCompare))
                    : or(lt(media.size, Number(cursor.value)), and(eq(media.size, Number(cursor.value)), idCompare))
                : sortOrder === "asc"
                    ? or(gt(media.filename, String(cursor.value)), and(eq(media.filename, String(cursor.value)), idCompare))
                    : or(lt(media.filename, String(cursor.value)), and(eq(media.filename, String(cursor.value)), idCompare));
        if (compare) conditions.push(compare);
    }

    const rows = await db.select(mediaProjection).from(media)
        .leftJoin(poster, eq(poster.id, media.posterMediaId))
        .where(and(...conditions)).orderBy(
        (sortOrder === "asc" ? asc : desc)(sortColumn),
        (sortOrder === "asc" ? asc : desc)(media.id),
    ).limit(boundedLimit + 1);
    const hasMore = rows.length > boundedLimit;
    const pageRows = hasMore ? rows.slice(0, boundedLimit) : rows;
    const last = pageRows.at(-1);
    const rawValue = last
        ? sortBy === "size" ? last.size : sortBy === "filename" ? last.filename : last.createdAt.getTime()
        : null;
    const usage = await countMediaUsage(db, pageRows.map((row) => row.id));
    return {
        files: pageRows.map((row) => ({
            ...presentMediaProjection(row),
            usageCount: usage.get(row.id)?.usageCount ?? 0,
            keptForOrders: usage.get(row.id)?.keptForOrders ?? false,
        })),
        pagination: {
            limit: boundedLimit,
            hasMore,
            nextCursor: hasMore && last && rawValue !== null
                ? encodeCursor({ sortBy, sortOrder, value: rawValue, id: last.id, scope })
                : null,
        },
    };
}

export async function initiateMediaUpload(
    db: Database,
    input: InitiateMediaUploadInput,
    bucket: R2Bucket,
) {
    const validation = validateMediaFileMetadata(input);
    if (!validation.ok) throw new ValidationError(validation.error);
    await assertActiveFolder(db, input.folderId);
    const file = validation.value;
    const parts = expectedPartCount(file.size);
    const mediaId = `media_${nanoid()}`;
    const sessionId = `mup_${nanoid()}`;
    const objectKey = buildMediaObjectKey(mediaId, file.mimeType);
    const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_MS);
    const claim = await db.insert(mediaUploadSessions).values({
        id: sessionId,
        mediaId,
        objectKey,
        uploadId: null,
        filename: file.filename,
        kind: file.kind,
        mimeType: file.mimeType,
        size: file.size,
        expectedParts: parts,
        folderId: input.folderId ?? null,
        state: "initializing",
        expiresAt,
    }).returning().get();
    try {
        const handle = await createMediaMultipartUpload({
            objectKey,
            filename: file.filename,
            mimeType: file.mimeType,
            size: file.size,
            customMetadata: { mediaId, sessionId },
        }, bucket);
        const session = await db.update(mediaUploadSessions).set({
            uploadId: handle.uploadId,
            state: "initiated",
            version: claim.version + 1,
            updatedAt: sql`(unixepoch())`,
        }).where(and(
            eq(mediaUploadSessions.id, claim.id),
            eq(mediaUploadSessions.state, "initializing"),
            eq(mediaUploadSessions.version, claim.version),
        )).returning().get();
        if (!session) {
            try { await abortMediaMultipartUpload({ objectKey, uploadId: handle.uploadId, bucket }); } catch { /* expires */ }
            throw new ConflictError("Media upload initialization changed. Start a new upload.");
        }
        return {
            id: session.id,
            mediaId: session.mediaId,
            filename: session.filename,
            kind: session.kind,
            mimeType: session.mimeType,
            size: session.size,
            expectedParts: session.expectedParts,
            partSize: MEDIA_MULTIPART_PART_SIZE_BYTES,
            state: session.state,
            version: session.version,
            expiresAt: session.expiresAt,
        };
    } catch (error) {
        await db.update(mediaUploadSessions).set({
            state: "failed",
            version: sql`${mediaUploadSessions.version} + 1`,
            updatedAt: sql`(unixepoch())`,
        }).where(and(
            eq(mediaUploadSessions.id, claim.id),
            eq(mediaUploadSessions.state, "initializing"),
        ));
        throw error;
    }
}

export async function getMediaUploadSession(db: Database, sessionId: string) {
    const session = await db.select().from(mediaUploadSessions)
        .where(eq(mediaUploadSessions.id, sessionId)).get();
    if (!session) throw new NotFoundError("Media upload session not found.");
    const parts = await db.select({
        partNumber: mediaUploadParts.partNumber,
        size: mediaUploadParts.size,
    }).from(mediaUploadParts)
        .where(eq(mediaUploadParts.sessionId, sessionId))
        .orderBy(asc(mediaUploadParts.partNumber));
    return {
        id: session.id,
        mediaId: session.mediaId,
        filename: session.filename,
        kind: session.kind,
        mimeType: session.mimeType,
        size: session.size,
        expectedParts: session.expectedParts,
        partSize: MEDIA_MULTIPART_PART_SIZE_BYTES,
        state: session.state,
        version: session.version,
        expiresAt: session.expiresAt,
        uploadedParts: parts,
    };
}

export async function uploadMediaPart(db: Database, input: {
    sessionId: string;
    partNumber: number;
    size: number;
    value: ArrayBuffer;
    signatureBytes?: ArrayBuffer;
}, bucket: R2Bucket) {
    const session = await db.select().from(mediaUploadSessions)
        .where(eq(mediaUploadSessions.id, input.sessionId)).get();
    if (!session) throw new NotFoundError("Media upload session not found.");
    if (!session.uploadId) throw new ConflictError("This media upload was not initialized.");
    if (!["initiated", "uploading"].includes(session.state)) {
        throw new ConflictError("This media upload no longer accepts parts.");
    }
    if (isExpired(session.expiresAt)) {
        await expireMediaUploadSession(db, session, bucket);
        throw new ConflictError("This media upload session has expired.");
    }
    if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > session.expectedParts) {
        throw new ValidationError("Media multipart part number is invalid.");
    }
    const requiredSize = expectedPartSize(session.size, session.expectedParts, input.partNumber);
    if (input.size !== requiredSize) {
        throw new ValidationError(`Part ${input.partNumber} must contain exactly ${requiredSize} bytes.`);
    }
    const signatureVerified = input.partNumber !== 1 || (() => {
        if (!input.signatureBytes) throw new ValidationError("The first media part requires signature verification.");
        const result = validateMediaSignature(input.signatureBytes, session.mimeType);
        if (!result.ok) throw new ValidationError(result.error);
        return true;
    })();

    const uploaded = await uploadMediaMultipartPart({
        objectKey: session.objectKey,
        uploadId: session.uploadId,
        partNumber: input.partNumber,
        size: input.size,
        isFinal: input.partNumber === session.expectedParts,
        value: input.value,
        bucket,
    });
    await safeBatch(db, [
        db.insert(mediaUploadParts).values({
            sessionId: session.id,
            partNumber: uploaded.partNumber,
            etag: uploaded.etag,
            size: input.size,
            signatureVerified,
        }).onConflictDoUpdate({
            target: [mediaUploadParts.sessionId, mediaUploadParts.partNumber],
            set: {
                etag: uploaded.etag,
                size: input.size,
                signatureVerified,
                updatedAt: sql`(unixepoch())`,
            },
        }),
        db.update(mediaUploadSessions).set({
            state: "uploading",
            version: sql`${mediaUploadSessions.version} + 1`,
            updatedAt: sql`(unixepoch())`,
        }).where(and(
            eq(mediaUploadSessions.id, session.id),
            inArray(mediaUploadSessions.state, ["initiated", "uploading"]),
        )),
    ]);
    return { partNumber: uploaded.partNumber, size: input.size };
}

async function commitCompletedUpload(db: Database, session: typeof mediaUploadSessions.$inferSelect) {
    const existing = await db.select().from(media).where(or(
        eq(media.id, session.mediaId),
        eq(media.objectKey, session.objectKey),
    )).get();
    if (existing && (
        existing.id !== session.mediaId ||
        existing.objectKey !== session.objectKey ||
        existing.mimeType !== session.mimeType ||
        existing.size !== session.size ||
        existing.kind !== session.kind
    )) {
        throw new ConflictError("Existing media does not match this upload session.");
    }
    await safeBatch(db, [
        db.insert(media).values({
            id: session.mediaId,
            filename: session.filename,
            kind: session.kind,
            objectKey: session.objectKey,
            size: session.size,
            mimeType: session.mimeType,
            folderId: session.folderId,
            status: "ready",
        }).onConflictDoNothing({ target: media.id }),
        db.update(mediaUploadSessions).set({
            state: "committed",
            r2CompletedAt: sql`coalesce(${mediaUploadSessions.r2CompletedAt}, unixepoch())`,
            committedAt: sql`(unixepoch())`,
            version: sql`${mediaUploadSessions.version} + 1`,
            updatedAt: sql`(unixepoch())`,
        }).where(and(
            eq(mediaUploadSessions.id, session.id),
            eq(mediaUploadSessions.state, "completing"),
        )),
    ]);
    const row = await readPresentedMedia(db, session.mediaId);
    if (!row) throw new ServiceUnavailableError("Media completion could not be committed.");
    return row;
}

/**
 * Completes an upload. When `images` is given (non-browser uploads: agents,
 * CLI, URL import), the renditions are generated once right away; a failure
 * there never fails the upload and leaves the image original-only.
 */
export async function completeMediaUpload(
    db: Database,
    sessionId: string,
    bucket: R2Bucket,
    images?: ImagesBinding,
) {
    const file = await completeMediaUploadObject(db, sessionId, bucket);
    if (!images || file.variantWidth || !canHaveVariants(file)) return file;
    try {
        return await generateMediaVariants(db, file.id, bucket, images);
    } catch (error) {
        console.warn("[media] rendition generation skipped", {
            mediaId: file.id,
            error: error instanceof Error ? error.name : "unknown",
        });
        return file;
    }
}

async function completeMediaUploadObject(
    db: Database,
    sessionId: string,
    bucket: R2Bucket,
) {
    let session = await db.select().from(mediaUploadSessions)
        .where(eq(mediaUploadSessions.id, sessionId)).get();
    if (!session) throw new NotFoundError("Media upload session not found.");
    if (session.state === "committed") {
        const existing = await readPresentedMedia(db, session.mediaId);
        if (!existing || existing.objectKey !== session.objectKey || existing.mimeType !== session.mimeType || existing.size !== session.size) {
            throw new ConflictError("Committed media does not match its upload session.");
        }
        return existing;
    }
    if (!["initiated", "uploading", "completing"].includes(session.state)) {
        throw new ConflictError("This media upload cannot be completed.");
    }
    if (isExpired(session.expiresAt) && session.state !== "completing") {
        await expireMediaUploadSession(db, session, bucket);
        throw new ConflictError("This media upload session has expired.");
    }
    const parts = await db.select().from(mediaUploadParts)
        .where(eq(mediaUploadParts.sessionId, session.id))
        .orderBy(asc(mediaUploadParts.partNumber));
    const declaredSize = session.size;
    const declaredParts = session.expectedParts;
    if (
        parts.length !== declaredParts ||
        parts.some((part, index) =>
            part.partNumber !== index + 1 ||
            part.size !== expectedPartSize(declaredSize, declaredParts, part.partNumber)
        ) ||
        parts[0]?.signatureVerified !== true
    ) {
        throw new ConflictError("Upload every part and verify the first part before completing this media.");
    }

    if (session.state !== "completing") {
        const claimed = await db.update(mediaUploadSessions).set({
            state: "completing",
            version: session.version + 1,
            updatedAt: sql`(unixepoch())`,
        }).where(and(
            eq(mediaUploadSessions.id, session.id),
            eq(mediaUploadSessions.version, session.version),
            inArray(mediaUploadSessions.state, ["initiated", "uploading"]),
        )).returning().get();
        if (!claimed) throw new ConflictError("Media completion is already in progress. Retry shortly.");
        session = claimed;
    }
    if (!session.uploadId) throw new ConflictError("This media upload was not initialized.");

    let object = await headMediaObject(session.objectKey, bucket);
    if (!object) {
        try {
            object = await completeMediaMultipartUpload({
                objectKey: session.objectKey,
                uploadId: session.uploadId,
                parts: parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
                bucket,
            });
        } catch (error) {
            object = await headMediaObject(session.objectKey, bucket);
            if (!object) throw error;
        }
    }
    if (object.size !== session.size) {
        throw new ConflictError("Stored media size does not match the declared upload.");
    }
    return commitCompletedUpload(db, session);
}

export async function abortMediaUpload(
    db: Database,
    sessionId: string,
    bucket: R2Bucket,
) {
    let session = await db.select().from(mediaUploadSessions)
        .where(eq(mediaUploadSessions.id, sessionId)).get();
    if (!session) throw new NotFoundError("Media upload session not found.");
    if (session.state === "aborted" || session.state === "expired") return;
    if (session.state === "committed" || session.state === "completing") {
        throw new ConflictError("Completed media cannot be aborted. Move it to trash instead.");
    }
    const uploadId = session.uploadId;
    if (!uploadId) {
        await db.update(mediaUploadSessions).set({
            state: "aborted",
            version: sql`${mediaUploadSessions.version} + 1`,
            updatedAt: sql`(unixepoch())`,
        }).where(eq(mediaUploadSessions.id, session.id));
        return;
    }
    if (session.state !== "aborting") {
        const claimed = await db.update(mediaUploadSessions).set({
            state: "aborting",
            version: session.version + 1,
            updatedAt: sql`(unixepoch())`,
        }).where(and(eq(mediaUploadSessions.id, session.id), eq(mediaUploadSessions.version, session.version)))
            .returning().get();
        if (!claimed) throw new ConflictError("Media upload changed. Reload and try again.");
        session = claimed;
    }
    await abortMediaMultipartUpload({ objectKey: session.objectKey, uploadId, bucket });
    await db.update(mediaUploadSessions).set({
        state: "aborted",
        version: sql`${mediaUploadSessions.version} + 1`,
        updatedAt: sql`(unixepoch())`,
    }).where(and(eq(mediaUploadSessions.id, session.id), eq(mediaUploadSessions.state, "aborting")));
}

export async function reconcileExpiredMediaUploads(
    db: Database,
    bucket: R2Bucket,
    limit = 25,
) {
    const boundedLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
    const sessions = await db.select().from(mediaUploadSessions).where(and(
        inArray(mediaUploadSessions.state, ["initializing", "initiated", "uploading", "aborting", "failed"]),
        sql`${mediaUploadSessions.expiresAt} <= unixepoch()`,
    )).orderBy(asc(mediaUploadSessions.expiresAt), asc(mediaUploadSessions.id)).limit(boundedLimit);

    let expired = 0;
    const retrySessionIds: string[] = [];
    for (const session of sessions) {
        try {
            await expireMediaUploadSession(db, session, bucket);
            expired += 1;
        } catch {
            retrySessionIds.push(session.id);
        }
    }
    return {
        scanned: sessions.length,
        expired,
        retrySessionIds,
        hasMore: sessions.length === boundedLimit,
    };
}

export async function updateMediaFile(db: Database, id: string, data: UpdateMediaInput) {
    const current = await db.select().from(media)
        .where(and(eq(media.id, id), eq(media.status, "ready"))).get();
    if (!current) throw new NotFoundError("Media file not found");
    if (current.version !== data.expectedVersion) {
        throw new ConflictError("Media changed while you were editing it. Reload and try again.");
    }
    await assertActiveFolder(db, data.folderId);
    if (current.kind === "image" && (data.posterMediaId !== undefined || data.durationMs !== undefined)) {
        throw new ValidationError("Image media cannot have a video poster or duration.");
    }
    if (data.posterMediaId !== undefined && data.posterMediaId !== null) {
        if (current.kind !== "video") throw new ValidationError("Only videos can have poster images.");
        if (data.posterMediaId === id) throw new ValidationError("A video cannot use itself as a poster.");
        const poster = await db.select({ id: media.id }).from(media).where(and(
            eq(media.id, data.posterMediaId),
            eq(media.kind, "image"),
            eq(media.status, "ready"),
        )).get();
        if (!poster) throw new ValidationError("Poster must be a ready image in the media library.");
    }

    const updates: Record<string, unknown> = {
        version: current.version + 1,
        updatedAt: sql`(unixepoch())`,
    };
    for (const key of ["filename", "altText", "caption", "width", "height", "durationMs", "posterMediaId", "folderId"] as const) {
        if (data[key] !== undefined) updates[key] = data[key] || null;
    }
    const updated = await db.update(media).set(updates).where(and(
        eq(media.id, id),
        eq(media.version, data.expectedVersion),
        eq(media.status, "ready"),
    )).returning().get();
    if (!updated) throw new ConflictError("Media changed while you were editing it. Reload and try again.");
    const presented = await readPresentedMedia(db, updated.id);
    if (!presented) throw new ConflictError("Media changed while it was being read. Reload and try again.");
    return presented;
}

export async function trashMediaFile(db: Database, id: string, expectedVersion: number) {
    const row = await db.update(media).set({
        status: "trashed",
        trashedAt: sql`(unixepoch())`,
        version: expectedVersion + 1,
        updatedAt: sql`(unixepoch())`,
    }).where(and(eq(media.id, id), eq(media.version, expectedVersion), eq(media.status, "ready")))
        .returning().get();
    if (!row) throw new ConflictError("Only a current, ready media item can be moved to trash.");
    const presented = await readPresentedMedia(db, row.id);
    if (!presented) throw new ConflictError("Media changed while it was being read. Reload and try again.");
    return presented;
}

export async function restoreMediaFile(db: Database, id: string, expectedVersion: number) {
    const row = await db.update(media).set({
        status: "ready",
        trashedAt: null,
        version: expectedVersion + 1,
        updatedAt: sql`(unixepoch())`,
    }).where(and(eq(media.id, id), eq(media.version, expectedVersion), eq(media.status, "trashed")))
        .returning().get();
    if (!row) throw new ConflictError("Only a current trashed media item can be restored.");
    const presented = await readPresentedMedia(db, row.id);
    if (!presented) throw new ConflictError("Media changed while it was being read. Reload and try again.");
    return presented;
}

function isMediaInUse(usage: MediaUsage): boolean {
    return usage.count > 0 || usage.orderCount > 0;
}

export async function permanentlyDeleteMediaFile(
    db: Database,
    id: string,
    expectedVersion: number,
    bucket: R2Bucket,
) {
    let current = await db.select().from(media).where(eq(media.id, id)).get();
    if (!current) throw new NotFoundError("Media file not found");
    if (current.status === "deleted") return;
    if (current.status === "trashed" && current.version === expectedVersion) {
        const usage = await loadMediaUsage(db, id);
        if (isMediaInUse(usage)) throw new MediaDependencyConflictError(usage);
        const claimed = await db.update(media).set({
            status: "deleting",
            version: expectedVersion + 1,
            updatedAt: sql`(unixepoch())`,
        }).where(and(
            eq(media.id, id),
            eq(media.version, expectedVersion),
            eq(media.status, "trashed"),
            noMediaUsage(id, current.objectKey),
        ))
            .returning().get();
        if (!claimed) {
            const latestUsage = await loadMediaUsage(db, id);
            if (isMediaInUse(latestUsage)) throw new MediaDependencyConflictError(latestUsage);
            throw new ConflictError("Media changed. Reload and try again.");
        }
        current = claimed;
    } else if (!(
        current.status === "deleting" &&
        (current.version === expectedVersion || current.version === expectedVersion + 1)
    )) {
        throw new ConflictError("Move current media to trash before deleting it permanently.");
    }
    await deleteFile(current.objectKey, bucket);
    await deleteMediaVariants(current.objectKey, current.variantWidth, bucket);
    const finalized = await db.update(media).set({
        status: "deleted",
        deletedAt: sql`(unixepoch())`,
        version: sql`${media.version} + 1`,
        updatedAt: sql`(unixepoch())`,
    }).where(and(
        eq(media.id, id),
        eq(media.status, "deleting"),
        eq(media.version, current.version),
    )).returning({ id: media.id }).get();
    if (!finalized) {
        const terminal = await db.select({ status: media.status }).from(media).where(eq(media.id, id)).get();
        if (terminal?.status !== "deleted") {
            throw new ConflictError("Media deletion changed while storage was being finalized. Reload and retry.");
        }
    }
}

const VARIANT_SOURCE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const;
const MAX_VARIANT_BYTES = MEDIA_MULTIPART_PART_SIZE_BYTES;

/** GIFs keep their animation, so only still formats get WebP renditions. */
function canHaveVariants(row: { kind: string; mimeType: string }): boolean {
    return row.kind === "image"
        && (VARIANT_SOURCE_MIME_TYPES as readonly string[]).includes(row.mimeType);
}

export interface MediaVariantsInput {
    /** Intrinsic size of the original upload. */
    width: number;
    height: number;
    /** WebP bytes keyed by rendition width; must match mediaVariantWidths(width). */
    files: ReadonlyMap<number, ArrayBuffer>;
}

/**
 * Stores pre-generated WebP renditions beside the original object and records
 * the largest one on the media row, which switches every published URL of
 * this media to the renditions. Re-running replaces the same keys. Renditions
 * are derived storage, not a merchant edit, so `version` stays put and an
 * editor open on this media keeps saving without a conflict.
 */
export async function saveMediaVariants(
    db: Database,
    id: string,
    input: MediaVariantsInput,
    bucket: R2Bucket,
) {
    const current = await db.select().from(media).where(and(
        eq(media.id, id),
        inArray(media.status, ["ready", "trashed"]),
    )).get();
    if (!current) throw new NotFoundError("Media file not found");
    if (!canHaveVariants(current)) {
        throw new ValidationError("Only JPEG, PNG, WebP and AVIF images get optimized renditions.");
    }
    const widths = mediaVariantWidths(input.width);
    if (
        !Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) ||
        input.height < 1 || widths.length === 0 ||
        input.files.size !== widths.length ||
        widths.some((width) => !input.files.has(width))
    ) {
        throw new ValidationError(`Send one WebP rendition for each width: ${widths.join(", ") || "none"}.`);
    }
    for (const width of widths) {
        const bytes = input.files.get(width)!;
        if (bytes.byteLength < 1 || bytes.byteLength > MAX_VARIANT_BYTES) {
            throw new ValidationError("Each rendition must be between 1 byte and 5 MB.");
        }
        const signature = validateMediaSignature(bytes.slice(0, MEDIA_SIGNATURE_READ_BYTES), "image/webp");
        if (!signature.ok) throw new ValidationError(signature.error);
    }
    for (const width of widths) {
        await putMediaVariant(current.objectKey, width, input.files.get(width)!, bucket);
    }
    const updated = await db.update(media).set({
        width: input.width,
        height: input.height,
        variantWidth: widths.at(-1)!,
        updatedAt: sql`(unixepoch())`,
    }).where(and(
        eq(media.id, id),
        eq(media.objectKey, current.objectKey),
        inArray(media.status, ["ready", "trashed"]),
    )).returning({ id: media.id }).get();
    if (!updated) {
        // A permanent delete claimed the row meanwhile and only removes the
        // renditions it had recorded, so drop the ones written just now.
        await deleteMediaVariants(current.objectKey, widths.at(-1)!, bucket).catch(() => undefined);
        throw new ConflictError("Media changed while its renditions were saved. Reload and try again.");
    }
    const presented = await readPresentedMedia(db, id);
    if (!presented) throw new ConflictError("Media changed while it was being read. Reload and try again.");
    return presented;
}

/** Streams a stored original for the dashboard rendition backfill. */
export async function readMediaOriginal(db: Database, id: string, bucket: R2Bucket) {
    const row = await db.select({ objectKey: media.objectKey, mimeType: media.mimeType })
        .from(media)
        .where(and(eq(media.id, id), inArray(media.status, ["ready", "trashed"])))
        .get();
    if (!row) throw new NotFoundError("Media file not found");
    const object = await bucket.get(row.objectKey);
    if (!object || !("body" in object)) throw new NotFoundError("Media object not found");
    return { body: object.body, mimeType: row.mimeType };
}

/**
 * Server-side rendition pipeline for uploads that did not come from the
 * dashboard browser pipeline. Uses the Cloudflare Images binding once per
 * rendition; renditions are then plain R2 objects. The original is held once
 * (as a Blob every transform streams from) so a 20 MB upload is not copied
 * per rendition.
 */
export async function generateMediaVariants(
    db: Database,
    id: string,
    bucket: R2Bucket,
    images: ImagesBinding,
) {
    const row = await db.select().from(media).where(eq(media.id, id)).get();
    if (!row || !canHaveVariants(row)) throw new ValidationError("This media cannot get optimized renditions.");
    const object = await bucket.get(row.objectKey);
    if (!object || !("arrayBuffer" in object)) throw new NotFoundError("Media object not found");
    const original = new Blob([await object.arrayBuffer()]);
    const info = await images.info(original.stream());
    if (!("width" in info)) throw new ValidationError("This media has no raster dimensions.");
    const files = new Map<number, ArrayBuffer>();
    for (const width of mediaVariantWidths(info.width)) {
        const output = await images.input(original.stream())
            .transform({ width })
            .output({ format: "image/webp", quality: Math.round(mediaVariantQuality(width) * 100) });
        files.set(width, await output.response().arrayBuffer());
    }
    return saveMediaVariants(db, id, { width: info.width, height: info.height, files }, bucket);
}

/** Whether a presented or stored media row still publishes only its original. */
export function needsMediaVariants(row: { kind: string; mimeType: string; variantWidth?: number | null }): boolean {
    return canHaveVariants(row) && row.variantWidth == null;
}

export type MediaVariantsRenderOutcome = "generated" | "skipped" | "failed";

/**
 * Renders the renditions of one media item unless it already has them, it
 * cannot have them, or it is gone. Idempotent: rendition keys are
 * deterministic, so a duplicate run only rewrites the same objects. A failure
 * never throws; it touches `updated_at` (never `version`) so the scheduled
 * backfill tries this image again only after the quiet window, behind every
 * other candidate. Only the initial row read can throw (database outage).
 */
export async function renderMissingMediaVariants(
    db: Database,
    id: string,
    bucket: R2Bucket,
    images: ImagesBinding,
): Promise<MediaVariantsRenderOutcome> {
    const row = await db.select({
        kind: media.kind,
        mimeType: media.mimeType,
        variantWidth: media.variantWidth,
        status: media.status,
    }).from(media).where(eq(media.id, id)).get();
    if (!row || (row.status !== "ready" && row.status !== "trashed") || !needsMediaVariants(row)) {
        return "skipped";
    }
    try {
        await generateMediaVariants(db, id, bucket, images);
        return "generated";
    } catch (error) {
        console.warn("[media] rendition generation failed", {
            mediaId: id,
            error: error instanceof Error ? error.name : "unknown",
        });
        // Best effort: if even this write fails the image is simply first again next run.
        await db.update(media).set({ updatedAt: sql`(unixepoch())` })
            .where(and(eq(media.id, id), isNull(media.variantWidth)))
            .catch(() => undefined);
        return "failed";
    }
}

/** `JOBS_QUEUE` message that renders one upload's renditions if nothing else has. */
export type MediaVariantsQueueMessage = {
    type: "media.render_variants";
    mediaId: string;
};

export interface MediaVariantsQueue {
    send(message: MediaVariantsQueueMessage, options: { delaySeconds: number }): Promise<unknown>;
}

/**
 * Upload completion schedules one server-side render this long after commit.
 * The dashboard browser pipeline normally saves renditions seconds after an
 * upload, so the job finds them done and skips; it only renders when the
 * browser never finished (closed tab, failed save, non-dashboard client).
 */
export const MEDIA_VARIANTS_JOB_DELAY_SECONDS = 120;

/**
 * Enqueues the delayed server-side render for a just-completed upload that
 * still publishes only its original. Never throws: the upload is already
 * committed and the scheduled backfill is the fallback. Skipped without the
 * Images binding (local dev), since nothing could render it.
 */
export async function enqueueMediaVariantsJob(
    queue: MediaVariantsQueue | undefined,
    images: ImagesBinding | undefined,
    file: { id: string; kind: string; mimeType: string; variantWidth?: number | null },
    /**
     * After an upload the job waits for the dashboard's own renditions; a
     * public read that already shows the original (a placeholder on cards)
     * queues it at once (`delaySeconds: 0`).
     */
    { delaySeconds = MEDIA_VARIANTS_JOB_DELAY_SECONDS }: { delaySeconds?: number } = {},
): Promise<boolean> {
    if (!queue || !images || !needsMediaVariants(file)) return false;
    const message: MediaVariantsQueueMessage = { type: "media.render_variants", mediaId: file.id };
    try {
        await queue.send(message, { delaySeconds });
        return true;
    } catch (error) {
        console.warn("[media] rendition job enqueue failed", {
            mediaId: file.id,
            error: error instanceof Error ? error.name : "unknown",
        });
        return false;
    }
}

/**
 * Media touched within this window is left to the upload's own pipeline: the
 * dashboard browser saves renditions seconds after an upload and the delayed
 * `media.render_variants` job follows two minutes later. A failed attempt
 * also waits at least this long (it touches `updated_at`) before a retry.
 */
export const VARIANT_BACKFILL_QUIET_MS = 10 * 60 * 1_000;
/** Candidate rows read per page; far under D1's bound-parameter ceiling. */
const VARIANT_BACKFILL_PAGE_SIZE = 20;

export interface MediaVariantsBackfillOptions {
    /** Epoch ms after which no new image is started; in-flight ones finish. */
    deadline: number;
    /** Images rendered at once; each holds its original in memory. */
    concurrency: number;
    /** Hard cap on images attempted in one run (CPU guard). */
    maxImages: number;
    now?: () => number;
}

/**
 * Scheduled rendition backfill for still images that publish only their
 * original (uploaded before renditions existed, or whose upload-time render
 * failed). Least recently touched first, in pages, with at most `concurrency`
 * images in flight, until the candidate set is empty, the deadline passes, or
 * `maxImages` were attempted. A failure touches `updated_at`, so it leaves the
 * candidate set for this run and goes behind every other candidate next time:
 * a broken image cannot stall the loop. Idempotent: done rows leave the set.
 */
export async function backfillMissingMediaVariants(
    db: Database,
    bucket: R2Bucket,
    images: ImagesBinding,
    { deadline, concurrency, maxImages, now = Date.now }: MediaVariantsBackfillOptions,
) {
    const attempted = new Set<string>();
    let generated = 0;
    let failed = 0;
    let hasMore = false;
    const workers = Math.max(1, Math.floor(concurrency));
    for (;;) {
        const remaining = maxImages - attempted.size;
        if (remaining <= 0 || now() >= deadline) {
            hasMore = true;
            break;
        }
        const page = await db.select({ id: media.id }).from(media).where(and(
            eq(media.kind, "image"),
            inArray(media.status, ["ready", "trashed"]),
            isNull(media.variantWidth),
            inArray(media.mimeType, [...VARIANT_SOURCE_MIME_TYPES]),
            lt(media.updatedAt, new Date(now() - VARIANT_BACKFILL_QUIET_MS)),
        )).orderBy(asc(media.updatedAt), asc(media.id)).limit(VARIANT_BACKFILL_PAGE_SIZE);
        // A row whose failure touch also failed comes back; never retry it in
        // the same run, and stop once a page holds nothing new.
        const ids = page.map(({ id }) => id).filter((id) => !attempted.has(id)).slice(0, remaining);
        if (ids.length === 0) break;
        let next = 0;
        let stoppedEarly = false;
        const worker = async () => {
            while (next < ids.length) {
                if (now() >= deadline) {
                    stoppedEarly = true;
                    return;
                }
                const id = ids[next++]!;
                attempted.add(id);
                const outcome = await renderMissingMediaVariants(db, id, bucket, images);
                if (outcome === "generated") generated += 1;
                else if (outcome === "failed") failed += 1;
            }
        };
        await Promise.all(Array.from({ length: Math.min(workers, ids.length) }, worker));
        if (stoppedEarly) {
            hasMore = true;
            break;
        }
    }
    return { scanned: attempted.size, generated, failed, hasMore };
}

/** Queue messages per `sendBatch` call (Cloudflare Queues: at most 100 per call). */
const VARIANT_FANOUT_BATCH = 100;

export interface MediaVariantsBatchQueue {
    sendBatch(messages: Array<{ body: MediaVariantsQueueMessage; delaySeconds?: number }>): Promise<unknown>;
}

/**
 * The backlog beyond what one scheduled run renders inline: after the
 * rendition ladder migration (0094) every image publishes its original
 * again, and one cron run renders at most a few hundred. The next `limit`
 * candidates after the first `skip` (the ones the inline backfill takes in
 * this run, same order) go to the jobs queue with no delay, where consumers
 * render them in parallel. Disjoint from the inline run, so no image is
 * rendered twice; a job for an image that is done by then skips it.
 */
export async function enqueueMediaVariantsBacklog(
    db: Database,
    queue: MediaVariantsBatchQueue,
    { skip, limit, now = Date.now }: { skip: number; limit: number; now?: () => number },
): Promise<{ queued: number; hasMore: boolean }> {
    if (limit < 1) return { queued: 0, hasMore: false };
    const rows = await db.select({ id: media.id }).from(media).where(and(
        eq(media.kind, "image"),
        inArray(media.status, ["ready", "trashed"]),
        isNull(media.variantWidth),
        inArray(media.mimeType, [...VARIANT_SOURCE_MIME_TYPES]),
        lt(media.updatedAt, new Date(now() - VARIANT_BACKFILL_QUIET_MS)),
    )).orderBy(asc(media.updatedAt), asc(media.id)).limit(limit + 1).offset(Math.max(0, skip));
    const ids = rows.slice(0, limit).map(({ id }) => id);
    let queued = 0;
    for (let start = 0; start < ids.length; start += VARIANT_FANOUT_BATCH) {
        const chunk = ids.slice(start, start + VARIANT_FANOUT_BATCH);
        await queue.sendBatch(chunk.map((mediaId) => ({
            body: { type: "media.render_variants" as const, mediaId },
            delaySeconds: 0,
        })));
        queued += chunk.length;
    }
    return { queued, hasMore: rows.length > limit };
}

export async function moveMediaFiles(
    db: Database,
    items: Array<{ id: string; expectedVersion: number }>,
    folderId: string | null,
) {
    if (items.length < 1) return { movedCount: 0 };
    if (items.length > MAX_COMMAND_IDS || new Set(items.map(({ id }) => id)).size !== items.length) {
        throw new ValidationError("Move at most 90 unique media items at once.");
    }
    await assertActiveFolder(db, folderId);
    const claims = JSON.stringify(items);
    const rows = await db.update(media).set({
        folderId,
        version: sql`${media.version} + 1`,
        updatedAt: sql`(unixepoch())`,
    }).where(and(
        eq(media.status, "ready"),
        sql`EXISTS (
            SELECT 1 FROM json_each(${claims}) AS claim
            WHERE json_extract(claim.value, '$.id') = ${media.id}
              AND CAST(json_extract(claim.value, '$.expectedVersion') AS INTEGER) = ${media.version}
        )`,
        sql`(
            SELECT count(*)
            FROM ${media} AS current_media
            JOIN json_each(${claims}) AS claim
              ON current_media.id = json_extract(claim.value, '$.id')
             AND current_media.version = CAST(json_extract(claim.value, '$.expectedVersion') AS INTEGER)
             AND current_media.status = 'ready'
        ) = ${items.length}`,
    ))
        .returning({ id: media.id });
    if (rows.length !== items.length) {
        throw new ConflictError("One or more media items changed. Reload and try again.");
    }
    return { movedCount: rows.length };
}

export async function listMediaFolders(db: Database, input: { cursor?: string; limit?: number } = {}) {
    const limit = Math.min(100, Math.max(1, input.limit ?? 50));
    const conditions = [isNull(mediaFolders.deletedAt)];
    if (input.cursor) {
        const cursor = decodeCursor<{ name: string; id: string }>(input.cursor);
        if (typeof cursor.name !== "string" || typeof cursor.id !== "string") {
            throw new ValidationError("Media folder cursor is invalid.");
        }
        const after = or(
            sql`lower(${mediaFolders.name}) > lower(${cursor.name})`,
            and(sql`lower(${mediaFolders.name}) = lower(${cursor.name})`, sql`${mediaFolders.id} > ${cursor.id}`),
        );
        if (after) conditions.push(after);
    }
    const rows = await db.select().from(mediaFolders).where(and(...conditions))
        .orderBy(sql`lower(${mediaFolders.name}) ASC`, asc(mediaFolders.id))
        .limit(limit + 1);
    const hasMore = rows.length > limit;
    const folders = hasMore ? rows.slice(0, limit) : rows;
    const last = folders.at(-1);
    return {
        folders,
        pagination: {
            limit,
            hasMore,
            nextCursor: hasMore && last ? encodeCursor({ name: last.name, id: last.id }) : null,
        },
    };
}

export async function createMediaFolder(db: Database, name: string) {
    try {
        return await db.insert(mediaFolders).values({ id: `folder_${nanoid()}`, name })
            .returning().get();
    } catch (error) {
        if (error instanceof Error && /media_folders_active_name_uidx|unique constraint/i.test(error.message)) {
            throw new ConflictError("An active media folder with this name already exists.");
        }
        throw error;
    }
}

export async function updateMediaFolder(db: Database, id: string, name: string, expectedVersion: number) {
    try {
        const folder = await db.update(mediaFolders).set({
            name,
            version: expectedVersion + 1,
            updatedAt: sql`(unixepoch())`,
        }).where(and(
            eq(mediaFolders.id, id),
            eq(mediaFolders.version, expectedVersion),
            isNull(mediaFolders.deletedAt),
        )).returning().get();
        if (!folder) throw new ConflictError("Media folder changed. Reload and try again.");
        return folder;
    } catch (error) {
        if (error instanceof Error && /media_folders_active_name_uidx|unique constraint/i.test(error.message)) {
            throw new ConflictError("An active media folder with this name already exists.");
        }
        throw error;
    }
}

export async function deleteMediaFolder(db: Database, id: string, expectedVersion: number) {
    const guard = buildBatchGuard(db, sql`EXISTS (
        SELECT 1 FROM ${mediaFolders}
        WHERE ${mediaFolders.id} = ${id}
          AND ${mediaFolders.version} = ${expectedVersion}
          AND ${mediaFolders.deletedAt} IS NULL
    )`, "MEDIA_FOLDER_DELETE_CONFLICT");
    try {
        await safeBatch(db, [
            guard,
            db.update(mediaFolders).set({
            deletedAt: sql`(unixepoch())`,
            version: expectedVersion + 1,
            updatedAt: sql`(unixepoch())`,
            }).where(and(
                eq(mediaFolders.id, id),
                eq(mediaFolders.version, expectedVersion),
                isNull(mediaFolders.deletedAt),
            )),
            db.update(media).set({
                folderId: null,
                version: sql`${media.version} + 1`,
                updatedAt: sql`(unixepoch())`,
            }).where(and(eq(media.folderId, id), ne(media.status, "deleted"))),
        ] as never);
    } catch (error) {
        if (isBatchGuardError(error, "MEDIA_FOLDER_DELETE_CONFLICT")) {
            throw new ConflictError("Media folder changed. Reload and try again.");
        }
        throw error;
    }
}
