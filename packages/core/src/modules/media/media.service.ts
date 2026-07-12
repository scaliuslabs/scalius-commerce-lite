import {
    media,
    mediaFolders,
    mediaUploadParts,
    mediaUploadSessions,
    productMedia,
    products,
    orderItems,
} from "@scalius/database/schema";
import { buildBatchGuard, safeBatch, type Database } from "@scalius/database/client";
import {
    abortMediaMultipartUpload,
    buildMediaObjectKey,
    completeMediaMultipartUpload,
    createMediaMultipartUpload,
    deleteFile,
    headMediaObject,
    uploadMediaMultipartPart,
} from "../../integrations/storage";
import {
    MEDIA_MULTIPART_PART_SIZE_BYTES,
    validateMediaFileMetadata,
    validateMediaSignature,
} from "@scalius/shared/media-policy";
import { and, asc, desc, eq, getTableColumns, inArray, isNull, like, ne, or, sql } from "drizzle-orm";
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

const MAX_COMMAND_IDS = 90;
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export type MediaDependencyConflictDetails = {
    posterReferences: {
        count: number;
        samples: Array<{ mediaId: string; filename: string }>;
    };
    productReferences: {
        count: number;
        samples: Array<{ productId: string; productName: string; productMediaId: string }>;
    };
    orderReferences: {
        count: number;
        samples: Array<{ orderId: string; orderItemId: string }>;
    };
};

export class MediaDependencyConflictError extends AppError {
    constructor(details: MediaDependencyConflictDetails) {
        super(
            409,
            "MEDIA_DEPENDENCY_CONFLICT",
            "Remove this media from every product and video poster. Retained order snapshots cannot be deleted.",
            details,
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
        const cursorValue = sortBy === "createdAt"
            ? new Date(Number(cursor.value))
            : cursor.value;
        const compare = sortOrder === "asc"
            ? or(sql`${sortColumn} > ${cursorValue}`, and(eq(sortColumn, cursorValue), sql`${media.id} > ${cursor.id}`))
            : or(sql`${sortColumn} < ${cursorValue}`, and(eq(sortColumn, cursorValue), sql`${media.id} < ${cursor.id}`));
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
    return {
        files: pageRows.map(presentMediaProjection),
        pagination: {
            limit: boundedLimit,
            hasMore,
            nextCursor: hasMore && last && rawValue !== null
                ? encodeCursor({ sortBy, sortOrder, value: rawValue, id: last.id, scope })
                : null,
        },
    };
}

export async function initiateMediaUpload(db: Database, input: InitiateMediaUploadInput) {
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
        });
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
            try { await abortMediaMultipartUpload({ objectKey, uploadId: handle.uploadId }); } catch { /* expires */ }
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
}) {
    const session = await db.select().from(mediaUploadSessions)
        .where(eq(mediaUploadSessions.id, input.sessionId)).get();
    if (!session) throw new NotFoundError("Media upload session not found.");
    if (!session.uploadId) throw new ConflictError("This media upload was not initialized.");
    if (!["initiated", "uploading"].includes(session.state)) {
        throw new ConflictError("This media upload no longer accepts parts.");
    }
    if (isExpired(session.expiresAt)) {
        await expireMediaUploadSession(db, session);
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

export async function completeMediaUpload(db: Database, sessionId: string) {
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
        await expireMediaUploadSession(db, session);
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

    let object = await headMediaObject(session.objectKey);
    if (!object) {
        try {
            object = await completeMediaMultipartUpload({
                objectKey: session.objectKey,
                uploadId: session.uploadId,
                parts: parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
            });
        } catch (error) {
            object = await headMediaObject(session.objectKey);
            if (!object) throw error;
        }
    }
    if (object.size !== session.size) {
        throw new ConflictError("Stored media size does not match the declared upload.");
    }
    return commitCompletedUpload(db, session);
}

export async function abortMediaUpload(db: Database, sessionId: string) {
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
    await abortMediaMultipartUpload({ objectKey: session.objectKey, uploadId });
    await db.update(mediaUploadSessions).set({
        state: "aborted",
        version: sql`${mediaUploadSessions.version} + 1`,
        updatedAt: sql`(unixepoch())`,
    }).where(and(eq(mediaUploadSessions.id, session.id), eq(mediaUploadSessions.state, "aborting")));
}

export async function reconcileExpiredMediaUploads(db: Database, limit = 25) {
    const boundedLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
    const sessions = await db.select().from(mediaUploadSessions).where(and(
        inArray(mediaUploadSessions.state, ["initializing", "initiated", "uploading", "aborting", "failed"]),
        sql`${mediaUploadSessions.expiresAt} <= unixepoch()`,
    )).orderBy(asc(mediaUploadSessions.expiresAt), asc(mediaUploadSessions.id)).limit(boundedLimit);

    let expired = 0;
    const retrySessionIds: string[] = [];
    for (const session of sessions) {
        try {
            await expireMediaUploadSession(db, session);
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

async function loadMediaDeleteDependencies(
    db: Database,
    id: string,
): Promise<MediaDependencyConflictDetails> {
    const posterRows = await db
        .select({
            mediaId: media.id,
            filename: media.filename,
            total: sql<number>`count(*) OVER ()`,
        })
        .from(media)
        .where(and(eq(media.posterMediaId, id), ne(media.status, "deleted")))
        .orderBy(asc(media.id))
        .limit(5);
    const productRows = await db
        .select({
            productId: productMedia.productId,
            productName: products.name,
            productMediaId: productMedia.id,
            total: sql<number>`count(*) OVER ()`,
        })
        .from(productMedia)
        .innerJoin(products, eq(products.id, productMedia.productId))
        .where(eq(productMedia.mediaId, id))
        .orderBy(asc(productMedia.productId), asc(productMedia.id))
        .limit(5);
    const orderRows = await db
        .select({
            orderId: orderItems.orderId,
            orderItemId: orderItems.id,
            total: sql<number>`count(*) OVER ()`,
        })
        .from(orderItems)
        .where(eq(orderItems.productImageMediaId, id))
        .orderBy(asc(orderItems.orderId), asc(orderItems.id))
        .limit(5);
    return {
        posterReferences: {
            count: posterRows[0]?.total ?? 0,
            samples: posterRows.map(({ mediaId, filename }) => ({ mediaId, filename })),
        },
        productReferences: {
            count: productRows[0]?.total ?? 0,
            samples: productRows.map(({ productId, productName, productMediaId }) => ({
                productId,
                productName,
                productMediaId,
            })),
        },
        orderReferences: {
            count: orderRows[0]?.total ?? 0,
            samples: orderRows.map(({ orderId, orderItemId }) => ({ orderId, orderItemId })),
        },
    };
}

function hasMediaDeleteDependencies(details: MediaDependencyConflictDetails): boolean {
    return details.posterReferences.count > 0
        || details.productReferences.count > 0
        || details.orderReferences.count > 0;
}

export async function permanentlyDeleteMediaFile(db: Database, id: string, expectedVersion: number) {
    let current = await db.select().from(media).where(eq(media.id, id)).get();
    if (!current) throw new NotFoundError("Media file not found");
    if (current.status === "deleted") return;
    if (current.status === "trashed" && current.version === expectedVersion) {
        const dependencies = await loadMediaDeleteDependencies(db, id);
        if (hasMediaDeleteDependencies(dependencies)) {
            throw new MediaDependencyConflictError(dependencies);
        }
        const claimed = await db.update(media).set({
            status: "deleting",
            version: expectedVersion + 1,
            updatedAt: sql`(unixepoch())`,
        }).where(and(
            eq(media.id, id),
            eq(media.version, expectedVersion),
            eq(media.status, "trashed"),
            sql`NOT EXISTS (
                SELECT 1 FROM ${media} AS poster_owner
                WHERE poster_owner.poster_media_id = ${id}
                  AND poster_owner.status <> 'deleted'
            )`,
            sql`NOT EXISTS (
                SELECT 1 FROM ${productMedia}
                WHERE ${productMedia.mediaId} = ${id}
            )`,
            sql`NOT EXISTS (
                SELECT 1 FROM ${orderItems}
                WHERE ${orderItems.productImageMediaId} = ${id}
            )`,
        ))
            .returning().get();
        if (!claimed) {
            const latestDependencies = await loadMediaDeleteDependencies(db, id);
            if (hasMediaDeleteDependencies(latestDependencies)) {
                throw new MediaDependencyConflictError(latestDependencies);
            }
            throw new ConflictError("Media changed. Reload and try again.");
        }
        current = claimed;
    } else if (!(
        current.status === "deleting" &&
        (current.version === expectedVersion || current.version === expectedVersion + 1)
    )) {
        throw new ConflictError("Move current media to trash before deleting it permanently.");
    }
    await deleteFile(current.objectKey);
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
    const guard = buildBatchGuard(db, sql`CASE WHEN EXISTS (
        SELECT 1 FROM ${mediaFolders}
        WHERE ${mediaFolders.id} = ${id}
          AND ${mediaFolders.version} = ${expectedVersion}
          AND ${mediaFolders.deletedAt} IS NULL
    ) THEN 1 ELSE json_extract('MEDIA_FOLDER_DELETE_CONFLICT', '$') END`);
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
        if (error instanceof Error && /MEDIA_FOLDER_DELETE_CONFLICT|malformed json/i.test(error.message)) {
            throw new ConflictError("Media folder changed. Reload and try again.");
        }
        throw error;
    }
}
