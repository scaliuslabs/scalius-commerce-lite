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
import { mediaVariantWidths } from "@scalius/shared/media-variants";
import {
    MEDIA_MULTIPART_PART_SIZE_BYTES,
    MEDIA_SIGNATURE_READ_BYTES,
    validateMediaFileMetadata,
    validateMediaSignature,
} from "@scalius/shared/media-policy";
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { containsText, startsWithText } from "../../utils/text-match";
import { alias, type SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import {
    AppError,
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    StateConflictError,
    ValidationError,
} from "@scalius/core/errors";
import type { InitiateMediaUploadInput, UpdateMediaInput } from "./media.validation";
import { presentMediaProjection } from "../media-references";
import { countMediaUsage, loadMediaUsage, noMediaUsage, type MediaUsage } from "./media.usage";
import {
    MEDIA_MACHINE,
    MEDIA_TRASH_STATES,
    MEDIA_UPLOAD_EXPIRABLE_STATES,
    MEDIA_UPLOAD_MACHINE,
    type MediaMove,
    type MediaUploadMove,
} from "./media.machines";

const MAX_COMMAND_IDS = 90;
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export class MediaDependencyConflictError extends AppError {
    constructor(usage: MediaUsage) {
        super(
            409,
            "media_dependency_conflict",
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

/** Current metadata for inspection and optimistic-version conflict recovery. */
export async function getMediaFile(db: Database, id: string) {
    const file = await readPresentedMedia(db, id);
    if (!file || (file.status !== "ready" && !(MEDIA_TRASH_STATES as readonly string[]).includes(file.status))) {
        throw new NotFoundError("Media file not found");
    }
    return file;
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

/**
 * The one way an upload session's state moves: the update of `move`, from its
 * source states only, and from `version` when the caller read one.
 */
function moveUploadSession(
    db: Database,
    id: string,
    move: MediaUploadMove,
    options: { version?: number; set?: SQLiteUpdateSetSource<typeof mediaUploadSessions> } = {},
) {
    const { from, to } = MEDIA_UPLOAD_MACHINE.moves[move];
    return db.update(mediaUploadSessions).set({
        ...options.set,
        state: to,
        version: sql`${mediaUploadSessions.version} + 1`,
        updatedAt: sql`(unixepoch())`,
    }).where(and(
        eq(mediaUploadSessions.id, id),
        inArray(mediaUploadSessions.state, [...from]),
        options.version === undefined ? undefined : eq(mediaUploadSessions.version, options.version),
    ));
}

/**
 * Ends a session that is not committed: `end` (`abort` or `expire`) after the
 * storage abort, or `fail` for a session storage never gave a handle.
 */
async function endMediaUploadSession(
    db: Database,
    initial: typeof mediaUploadSessions.$inferSelect,
    end: "abort" | "expire",
    bucket: R2Bucket,
) {
    let session = initial;
    const changed = () => new ConflictError("Media upload changed. Reload and try again.");
    if (session.state === "initializing") {
        const failed = await moveUploadSession(db, session.id, "fail", { version: session.version }).returning().get();
        if (!failed) throw changed();
        return;
    }
    if (MEDIA_UPLOAD_MACHINE.can(session.state, "stop")) {
        const claimed = await moveUploadSession(db, session.id, "stop", { version: session.version }).returning().get();
        if (!claimed) throw changed();
        session = claimed;
    }
    if (!MEDIA_UPLOAD_MACHINE.can(session.state, end) || !session.uploadId) {
        throw new StateConflictError(MEDIA_UPLOAD_MACHINE, session.state, end);
    }
    await abortMediaMultipartUpload({ objectKey: session.objectKey, uploadId: session.uploadId, bucket });
    // An abandoned completion may have left a completed object; this session owns its key now
    // (`aborting` commits nothing), so one no file holds is removed.
    const held = await db.select({ id: media.id }).from(media).where(eq(media.objectKey, session.objectKey)).get();
    if (!held) await deleteFile(session.objectKey, bucket);
    await moveUploadSession(db, session.id, end, { version: session.version });
}

async function expireMediaUploadSession(
    db: Database,
    session: typeof mediaUploadSessions.$inferSelect,
    bucket: R2Bucket,
) {
    await endMediaUploadSession(db, session, "expire", bucket);
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

type MediaListInput = {
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
};

const MAX_STALLED_DELETES_LISTED = 50;

/** One page of files in a stable cursor order, without usage. */
async function pageMediaFiles(db: Database, input: MediaListInput) {
    const boundedLimit = Math.min(100, Math.max(1, input.limit ?? 24));
    const sortBy = input.sortBy ?? "createdAt";
    const sortOrder = input.sortOrder ?? "desc";
    const search = input.search?.trim() ?? "";
    const mimeType = input.mimeType?.trim().toLowerCase() ?? "";
    // The filters other than status, which the stalled deletes below share.
    const conditions: SQL[] = [];
    const scope = JSON.stringify({
        search,
        folderId: input.folderId ?? "all",
        mimeType,
        kind: input.kind ?? "all",
        view: input.view ?? "ready",
        variants: input.variants ?? "all",
    });

    if (search) conditions.push(containsText(media.filename, search));
    if (input.folderId !== undefined && input.folderId !== "all") {
        conditions.push(
            input.folderId === "" || input.folderId === "root" || input.folderId === "null"
                ? isNull(media.folderId)
                : eq(media.folderId, input.folderId),
        );
    }
    if (mimeType) conditions.push(startsWithText(media.mimeType, mimeType));
    if (input.kind) conditions.push(eq(media.kind, input.kind));
    if (input.variants === "missing") {
        conditions.push(
            eq(media.kind, "image"),
            isNull(media.variantWidth),
            inArray(media.mimeType, [...VARIANT_SOURCE_MIME_TYPES]),
        );
    }

    const sortColumn = sortBy === "size" ? media.size : sortBy === "filename" ? media.filename : media.createdAt;
    const order = [(sortOrder === "asc" ? asc : desc)(sortColumn), (sortOrder === "asc" ? asc : desc)(media.id)];
    // Deletes that stopped halfway lead the first trash page, so staff can finish them. Few and
    // short-lived (the upload sweep finishes them), they keep the trashed walk on its index order.
    const stalled = input.view === "trash" && !input.cursor
        ? await db.select(mediaProjection).from(media)
            .leftJoin(poster, eq(poster.id, media.posterMediaId))
            .where(and(eq(media.status, "deleting"), ...conditions)).orderBy(...order).limit(MAX_STALLED_DELETES_LISTED)
        : [];
    conditions.push(eq(media.status, input.view === "trash" ? "trashed" : "ready"));
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
        .where(and(...conditions)).orderBy(...order).limit(boundedLimit + 1);
    const hasMore = rows.length > boundedLimit;
    const pageRows = hasMore ? rows.slice(0, boundedLimit) : rows;
    const last = pageRows.at(-1);
    const rawValue = last
        ? sortBy === "size" ? last.size : sortBy === "filename" ? last.filename : last.createdAt.getTime()
        : null;
    return {
        rows: [...stalled, ...pageRows],
        nextCursor: hasMore && last && rawValue !== null
            ? encodeCursor({ sortBy, sortOrder, value: rawValue, id: last.id, scope })
            : null,
    };
}

/** The Files list and picker: each file with where it is used. */
export async function listMediaFiles(db: Database, input: MediaListInput) {
    const page = await pageMediaFiles(db, input);
    const usage = await countMediaUsage(db, page.rows.map((row) => row.id));
    return {
        files: page.rows.map((row) => ({
            ...presentMediaProjection(row),
            usageCount: usage.get(row.id)?.usageCount ?? 0,
            keptForOrders: usage.get(row.id)?.keptForOrders ?? false,
        })),
        nextCursor: page.nextCursor,
    };
}

/**
 * Images still waiting for pre-generated renditions, oldest first, for the
 * dashboard's background renderer. It never reads usage (the renderer has no
 * use for it, and the usage index reads content blocks, text surfaces and
 * order lines for every page); the partial `media_pending_variants_idx`
 * answers the idle "anything pending?" check without walking rendered images.
 */
export async function listMediaPendingRenditions(db: Database, input: { cursor?: string; limit?: number } = {}) {
    const page = await pageMediaFiles(db, { cursor: input.cursor, limit: input.limit, variants: "missing", sortOrder: "asc" });
    return { files: page.rows.map((row) => presentMediaProjection(row)), nextCursor: page.nextCursor };
}

/** Ids a caller may choose for new media (store import names them after their source URL). */
const CHOSEN_MEDIA_ID = /^media_[A-Za-z0-9_-]{8,100}$/u;

export async function initiateMediaUpload(
    db: Database,
    input: InitiateMediaUploadInput,
    bucket: R2Bucket,
    options: { mediaId?: string } = {},
) {
    const validation = validateMediaFileMetadata(input);
    if (!validation.ok) throw new ValidationError(validation.error);
    if (options.mediaId !== undefined && !CHOSEN_MEDIA_ID.test(options.mediaId)) {
        throw new ValidationError("Media asset ID is invalid.");
    }
    await assertActiveFolder(db, input.folderId);
    const file = validation.value;
    const parts = expectedPartCount(file.size);
    const mediaId = options.mediaId ?? `media_${nanoid()}`;
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
        const session = await moveUploadSession(db, claim.id, "initiate", {
            version: claim.version,
            set: { uploadId: handle.uploadId },
        }).returning().get();
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
        await moveUploadSession(db, claim.id, "fail");
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
    if (!MEDIA_UPLOAD_MACHINE.can(session.state, "receive_part")) {
        throw new StateConflictError(MEDIA_UPLOAD_MACHINE, session.state, "receive_part", "This media upload no longer accepts parts.");
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
        moveUploadSession(db, session.id, "receive_part"),
    ]);
    return { partNumber: uploaded.partNumber, size: input.size };
}

const MEDIA_COMPLETION_ABANDONED = "media_completion_abandoned";

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
    // Only while the session is still `completing`: a completion the sweep gave up on writes no file.
    const stillCompleting = buildBatchGuard(db, sql`EXISTS (
        SELECT 1 FROM ${mediaUploadSessions}
        WHERE ${mediaUploadSessions.id} = ${session.id} AND ${mediaUploadSessions.state} = 'completing'
    )`, MEDIA_COMPLETION_ABANDONED);
    try {
        await safeBatch(db, [
        stillCompleting,
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
        moveUploadSession(db, session.id, "commit", {
            set: {
                r2CompletedAt: sql`coalesce(${mediaUploadSessions.r2CompletedAt}, unixepoch())`,
                committedAt: sql`(unixepoch())`,
            },
        }),
        ] as never);
    } catch (error) {
        if (isBatchGuardError(error, MEDIA_COMPLETION_ABANDONED)) {
            throw new ConflictError("This media upload expired before it was completed. Upload the file again.");
        }
        throw error;
    }
    const row = await readPresentedMedia(db, session.mediaId);
    if (!row) throw new ServiceUnavailableError("Media completion could not be committed.");
    return row;
}

/**
 * Completes an upload. The original is committed alone: the WebP renditions
 * come from the dashboard browser pipeline (or the CLI's local encoder), and an
 * image that has none yet stays "pending" (`needsMediaVariants`) and serves its
 * original until a dashboard tab renders them.
 */
export async function completeMediaUpload(
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
    if (session.state !== "completing" && !MEDIA_UPLOAD_MACHINE.can(session.state, "complete")) {
        throw new StateConflictError(MEDIA_UPLOAD_MACHINE, session.state, "complete", "This media upload cannot be completed.");
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
        const claimed = await moveUploadSession(db, session.id, "complete", { version: session.version }).returning().get();
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
    const session = await db.select().from(mediaUploadSessions)
        .where(eq(mediaUploadSessions.id, sessionId)).get();
    if (!session) throw new NotFoundError("Media upload session not found.");
    if (session.state === "committed" || session.state === "completing") {
        throw new StateConflictError(MEDIA_UPLOAD_MACHINE, session.state, "stop", "Completed media cannot be aborted. Move it to trash instead.");
    }
    // An ended session stays ended: a repeated abort is a no-op.
    if ((MEDIA_UPLOAD_MACHINE.final as readonly string[]).includes(session.state)) return;
    await endMediaUploadSession(db, session, "abort", bucket);
}

/** A session untouched this long is left by its client: the sweep may act on it. */
const STALLED_SECONDS = 15 * 60;

/**
 * Ends what uploads left behind, least recently tried first: expired sessions
 * (`expire`), and completions the client left (`completing`, untouched for a
 * stall period), which are finished, or abandoned once they have expired. A
 * session that fails is touched, so it goes to the back of the line (a stalled
 * completion waits a stall period again) and never keeps the others waiting.
 * The scheduled upload sweep runs this; the admin route runs it on demand.
 */
export async function reconcileExpiredMediaUploads(
    db: Database,
    bucket: R2Bucket,
    limit = 25,
) {
    const boundedLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
    const sessions = await db.select().from(mediaUploadSessions).where(or(
        and(
            inArray(mediaUploadSessions.state, [...MEDIA_UPLOAD_EXPIRABLE_STATES]),
            sql`${mediaUploadSessions.expiresAt} <= unixepoch()`,
        ),
        and(
            eq(mediaUploadSessions.state, "completing"),
            sql`${mediaUploadSessions.updatedAt} <= unixepoch() - ${STALLED_SECONDS}`,
        ),
    )).orderBy(asc(mediaUploadSessions.updatedAt), asc(mediaUploadSessions.id)).limit(boundedLimit);

    let expired = 0;
    let completed = 0;
    const retrySessionIds: string[] = [];
    for (const session of sessions) {
        try {
            if (session.state !== "completing") {
                await expireMediaUploadSession(db, session, bucket);
                expired += 1;
            } else if (await finishStalledCompletion(db, session, bucket)) completed += 1;
            else expired += 1;
        } catch {
            retrySessionIds.push(session.id);
            await db.update(mediaUploadSessions).set({ updatedAt: sql`(unixepoch())` })
                .where(eq(mediaUploadSessions.id, session.id)).catch(() => undefined);
        }
    }
    return {
        scanned: sessions.length,
        expired,
        completed,
        retrySessionIds,
        hasMore: sessions.length === boundedLimit,
    };
}

/**
 * Finishes a completion its client left, as the complete route would (true).
 * One that still cannot finish once its session has expired is abandoned
 * (false): the session is claimed first (`abandon`, guarded on its state and
 * version), so a completion that lands after it commits nothing and one that
 * committed first wins; then it ends as an expiry does, which also removes an
 * object at its key that no file holds.
 */
async function finishStalledCompletion(
    db: Database,
    session: typeof mediaUploadSessions.$inferSelect,
    bucket: R2Bucket,
): Promise<boolean> {
    try {
        await completeMediaUpload(db, session.id, bucket);
        return true;
    } catch (error) {
        if (!isExpired(session.expiresAt)) throw error;
    }
    const claimed = await moveUploadSession(db, session.id, "abandon", { version: session.version }).returning().get();
    if (!claimed) throw new ConflictError("Media upload changed while it was abandoned.");
    await endMediaUploadSession(db, claimed, "expire", bucket);
    return false;
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

/** The one way a file's status moves: the update of `move`, from its source states and `version` only. */
function moveMedia(
    db: Database,
    id: string,
    move: MediaMove,
    version: number,
    set: SQLiteUpdateSetSource<typeof media> = {},
    guard?: SQL,
) {
    const { from, to } = MEDIA_MACHINE.moves[move];
    return db.update(media).set({
        ...set,
        status: to,
        version: version + 1,
        updatedAt: sql`(unixepoch())`,
    }).where(and(eq(media.id, id), eq(media.version, version), inArray(media.status, [...from]), guard));
}

/** Moves a file as staff asked; a file in another state is refused with the moves it allows. */
async function moveMediaFile(db: Database, id: string, move: "trash" | "restore", expectedVersion: number) {
    const set = move === "trash" ? { trashedAt: sql`(unixepoch())` } : { trashedAt: null };
    const row = await moveMedia(db, id, move, expectedVersion, set).returning().get();
    if (!row) {
        const current = await db.select({ status: media.status, version: media.version }).from(media).where(eq(media.id, id)).get();
        if (!current) throw new NotFoundError("Media file not found");
        if (!MEDIA_MACHINE.can(current.status, move)) throw new StateConflictError(MEDIA_MACHINE, current.status, move);
        throw new ConflictError("Media changed. Reload and try again.");
    }
    const presented = await readPresentedMedia(db, row.id);
    if (!presented) throw new ConflictError("Media changed while it was being read. Reload and try again.");
    return presented;
}

export async function trashMediaFile(db: Database, id: string, expectedVersion: number) {
    return moveMediaFile(db, id, "trash", expectedVersion);
}

export async function restoreMediaFile(db: Database, id: string, expectedVersion: number) {
    return moveMediaFile(db, id, "restore", expectedVersion);
}

function isMediaInUse(usage: MediaUsage): boolean {
    return usage.count > 0 || usage.orderCount > 0;
}

/**
 * Deletes a trashed file for good: claims `deleting` (after the usage check),
 * deletes storage, then records `deleted`. A delete that stops after the
 * claim stays listed in trash at its new version, where staff finish it, and
 * the scheduled upload sweep finishes it too (`finishStalledMediaDeletes`).
 */
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
        const claimed = await moveMedia(db, id, "delete", expectedVersion, {}, noMediaUsage(id, current.objectKey))
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
        if (current.status !== "trashed" && current.status !== "deleting") {
            throw new StateConflictError(MEDIA_MACHINE, current.status, "delete", "Move current media to trash before deleting it permanently.");
        }
        throw new ConflictError("Media changed. Reload and try again.");
    }
    await finishMediaDelete(db, current, bucket);
}

async function finishMediaDelete(db: Database, row: typeof media.$inferSelect, bucket: R2Bucket) {
    await deleteFile(row.objectKey, bucket);
    await deleteMediaVariants(row.objectKey, row.variantWidth, bucket);
    const finalized = await moveMedia(db, row.id, "finish_delete", row.version, { deletedAt: sql`(unixepoch())` })
        .returning({ id: media.id }).get();
    if (!finalized) {
        const terminal = await db.select({ status: media.status }).from(media).where(eq(media.id, row.id)).get();
        if (terminal?.status !== "deleted") {
            throw new ConflictError("Media deletion changed while storage was being finalized. Reload and retry.");
        }
    }
}

/** A delete that stopped after its claim, untouched this long, is finished by the sweep. */
const STALLED_DELETE_SECONDS = 15 * 60;

/**
 * Finishes permanent deletes that stopped after their `deleting` claim,
 * least recently tried first. One that fails again is touched, so it goes to
 * the back of the line.
 */
export async function finishStalledMediaDeletes(db: Database, bucket: R2Bucket, limit = 10) {
    const rows = await db.select().from(media).where(and(
        inArray(media.status, [...MEDIA_MACHINE.moves.finish_delete.from]),
        sql`${media.updatedAt} <= unixepoch() - ${STALLED_DELETE_SECONDS}`,
    )).orderBy(asc(media.updatedAt), asc(media.id)).limit(Math.min(50, Math.max(1, Math.trunc(limit))));
    let finished = 0;
    for (const row of rows) {
        try {
            await finishMediaDelete(db, row, bucket);
            finished += 1;
        } catch {
            await db.update(media).set({ updatedAt: sql`(unixepoch())` })
                .where(and(eq(media.id, row.id), eq(media.status, "deleting"))).catch(() => undefined);
        }
    }
    return { scanned: rows.length, finished };
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

/** Streams a stored original so a dashboard tab can render the pending renditions. */
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

/** Whether a presented or stored media row still publishes only its original. */
export function needsMediaVariants(row: { kind: string; mimeType: string; variantWidth?: number | null }): boolean {
    return canHaveVariants(row) && row.variantWidth == null;
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
    )`, "media_folder_delete_conflict");
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
        if (isBatchGuardError(error, "media_folder_delete_conflict")) {
            throw new ConflictError("Media folder changed. Reload and try again.");
        }
        throw error;
    }
}
