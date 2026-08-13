import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { created, noContent, ok } from "../../utils/api-response";
import {
    conflictResponse,
    errorResponses,
    noContentResponse,
    serviceUnavailableResponse,
    successEnvelope,
} from "../../schemas/responses";
import { mediaFolderSchema, mediaSchema } from "../../schemas/entities";
import { timestampSchema } from "../../schemas/timestamps";
import {
    abortMediaUpload,
    completeMediaUpload,
    createFolderSchema,
    createMediaFolder,
    deleteMediaFolder,
    getMediaUploadSession,
    initiateMediaUpload,
    initiateMediaUploadSchema,
    listMediaFiles,
    listMediaFolders,
    mediaVersionCommandSchema,
    moveMediaFiles,
    moveMediaSchema,
    permanentlyDeleteMediaFile,
    reconcileExpiredMediaUploads,
    restoreMediaFile,
    trashMediaFile,
    updateFolderSchema,
    updateMediaFile,
    updateMediaFolder,
    updateMediaSchema,
    uploadMediaPart,
} from "@scalius/core/modules/media";
import {
    MEDIA_MULTIPART_PART_SIZE_BYTES,
    MEDIA_SIGNATURE_READ_BYTES,
} from "@scalius/shared/media-policy";
import { ValidationError } from "@scalius/core/errors";
import { invalidateMediaDependentProductCaches } from "../../utils/media-cache-invalidation";
import { readExactMediaPart } from "./media-upload-body";
import { importMediaFromUrl } from "./media-url-import";

const app = new OpenAPIHono<{ Bindings: Env }>();
const mediaErrorResponses = { ...errorResponses, 409: conflictResponse };
const idParam = z.object({ id: z.string().min(8).max(160) });
const cursorPaginationSchema = z.object({
    limit: z.number().int().positive(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
});
const uploadSessionSchema = z.object({
    id: z.string(),
    mediaId: z.string(),
    filename: z.string(),
    kind: z.enum(["image", "video"]),
    mimeType: z.string(),
    size: z.number().int().positive(),
    expectedParts: z.number().int().min(1).max(20),
    partSize: z.number().int().positive(),
    state: z.enum(["initializing", "initiated", "uploading", "completing", "committed", "aborting", "aborted", "expired", "failed"]),
    version: z.number().int().positive(),
    expiresAt: timestampSchema,
    uploadedParts: z.array(z.object({
        partNumber: z.number().int().positive(),
        size: z.number().int().positive(),
    })).optional(),
});

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Media"],
    summary: "List media with stable cursor pagination",
    operationId: "dashboard.media.list",
    request: { query: z.object({
        cursor: z.string().max(2_000).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(24),
        search: z.string().trim().max(200).optional(),
        folderId: z.string().max(160).optional(),
        sortBy: z.enum(["createdAt", "size", "filename"]).default("createdAt"),
        sortOrder: z.enum(["asc", "desc"]).default("desc"),
        mimeType: z.string().max(100).optional(),
        kind: z.enum(["image", "video"]).optional(),
        view: z.enum(["ready", "trash"]).default("ready"),
    }) },
    responses: {
        200: { description: "Media page", content: { "application/json": { schema: successEnvelope(z.object({
            files: z.array(mediaSchema),
            pagination: cursorPaginationSchema,
        })) } } },
        ...mediaErrorResponses,
    },
});
app.openapi(listRoute, async (c) => ok(c, await listMediaFiles(c.get("db"), c.req.valid("query"))));

const initiateRoute = createRoute({
    method: "post",
    path: "/uploads",
    tags: ["Admin - Media"],
    summary: "Initiate a durable image or video upload",
    description: "Start one resumable upload. Supported images: JPEG, PNG, GIF, WebP, and AVIF up to 20 MiB. Supported video: MP4 and WebM up to 100 MiB. File extension, declared MIME type, and signature must agree. Upload exactly session.expectedParts chunks of at most session.partSize bytes with dashboard.media.upload_part, then call dashboard.media.upload_complete. Resume with dashboard.media.upload_get or clean up with dashboard.media.upload_abort.",
    operationId: "dashboard.media.upload_initiate",
    request: { body: { content: { "application/json": { schema: initiateMediaUploadSchema } } } },
    responses: {
        201: { description: "Upload initiated", content: { "application/json": { schema: successEnvelope(z.object({ session: uploadSessionSchema })) } } },
        ...mediaErrorResponses,
        503: serviceUnavailableResponse,
    },
});
app.openapi(initiateRoute, async (c) => created(c, { session: await initiateMediaUpload(c.get("db"), c.req.valid("json"), c.env.BUCKET) }));

const importUrlRoute = createRoute({
    method: "post",
    path: "/uploads/import-url",
    tags: ["Admin - Media"],
    summary: "Import supported media from a public HTTPS URL",
    description: "Fetch one credential-free public HTTPS asset into the same durable, signature-checked media authority used by direct uploads. Redirects are revalidated, Content-Type and Content-Length must be exact, and the source is never persisted as authority.",
    operationId: "dashboard.media.import_url",
    request: { body: { content: { "application/json": { schema: z.object({
        sourceUrl: z.string().url().max(2_048),
        filename: z.string().trim().min(1).max(255).optional(),
        folderId: z.string().min(8).max(160).nullable().optional(),
    }) } } } },
    responses: {
        201: { description: "Remote media committed", content: { "application/json": { schema: successEnvelope(z.object({ file: mediaSchema })) } } },
        ...mediaErrorResponses,
        503: serviceUnavailableResponse,
    },
});
app.openapi(importUrlRoute, async (c) => {
    const input = c.req.valid("json");
    return created(c, { file: await importMediaFromUrl({
        db: c.get("db"),
        bucket: c.env.BUCKET,
        sourceUrl: input.sourceUrl,
        filename: input.filename,
        folderId: input.folderId,
    }) });
});

const getUploadRoute = createRoute({
    method: "get",
    path: "/uploads/{id}",
    tags: ["Admin - Media"],
    summary: "Read resumable upload status",
    operationId: "dashboard.media.upload_get",
    request: { params: idParam },
    responses: {
        200: { description: "Upload status", content: { "application/json": { schema: successEnvelope(z.object({ session: uploadSessionSchema })) } } },
        ...mediaErrorResponses,
    },
});
app.openapi(getUploadRoute, async (c) => ok(c, { session: await getMediaUploadSession(c.get("db"), c.req.valid("param").id) }));

const uploadPartRoute = createRoute({
    method: "put",
    path: "/uploads/{id}/parts/{partNumber}",
    tags: ["Admin - Media"],
    summary: "Stream one bounded media upload part",
    description: "Upload one exact raw application/octet-stream chunk for an initiated media session. Use the session ID and 1-based part number returned by dashboard.media.upload_initiate. Send an exact Content-Length; every non-final chunk must equal session.partSize and the final chunk carries the remainder.",
    operationId: "dashboard.media.upload_part",
    request: { params: z.object({
        id: z.string().min(8).max(160),
        partNumber: z.coerce.number().int().min(1).max(20),
    }), body: {
        required: true,
        content: {
            "application/octet-stream": {
                schema: z.string()
                    .min(1)
                    .max(MEDIA_MULTIPART_PART_SIZE_BYTES)
                    .openapi({ format: "binary" }),
            },
        },
    } },
    responses: {
        200: { description: "Part stored", content: { "application/json": { schema: successEnvelope(z.object({
            partNumber: z.number().int().positive(),
            size: z.number().int().positive(),
        })) } } },
        ...mediaErrorResponses,
        503: serviceUnavailableResponse,
    },
});
app.openapi(uploadPartRoute, async (c) => {
    if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
        throw new ValidationError("Media parts require application/octet-stream.");
    }
    const declaredLength = Number(c.req.header("content-length"));
    if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength < 1 ||
        declaredLength > MEDIA_MULTIPART_PART_SIZE_BYTES
    ) {
        throw new ValidationError("Media parts require an exact Content-Length header.");
    }
    const body = c.req.raw.body;
    if (!body) throw new ValidationError("Media part body is required.");
    const { id, partNumber } = c.req.valid("param");
    const value = await readExactMediaPart(body, declaredLength);
    return ok(c, await uploadMediaPart(c.get("db"), {
        sessionId: id,
        partNumber,
        size: declaredLength,
        value,
        signatureBytes: partNumber === 1
            ? value.slice(0, Math.min(declaredLength, MEDIA_SIGNATURE_READ_BYTES))
            : undefined,
    }, c.env.BUCKET));
});

const completeRoute = createRoute({
    method: "post",
    path: "/uploads/{id}/complete",
    tags: ["Admin - Media"],
    summary: "Complete and reconcile a media upload",
    description: "Commit an upload only after every expected part is present. The returned file.id is the media asset ID used by product media associations. If completion fails, inspect dashboard.media.upload_get and resume missing parts instead of initiating a duplicate session.",
    operationId: "dashboard.media.upload_complete",
    request: { params: idParam },
    responses: {
        200: { description: "Media committed", content: { "application/json": { schema: successEnvelope(z.object({ file: mediaSchema })) } } },
        ...mediaErrorResponses,
        503: serviceUnavailableResponse,
    },
});
app.openapi(completeRoute, async (c) => ok(c, { file: await completeMediaUpload(c.get("db"), c.req.valid("param").id, c.env.BUCKET) }));

const abortRoute = createRoute({
    method: "delete",
    path: "/uploads/{id}",
    tags: ["Admin - Media"],
    summary: "Abort a media upload",
    operationId: "dashboard.media.upload_abort",
    request: { params: idParam },
    responses: { 204: noContentResponse, ...mediaErrorResponses, 503: serviceUnavailableResponse },
});
app.openapi(abortRoute, async (c) => {
    await abortMediaUpload(c.get("db"), c.req.valid("param").id, c.env.BUCKET);
    return noContent(c);
});

const reconcileRoute = createRoute({
    method: "post",
    path: "/uploads/reconcile",
    tags: ["Admin - Media"],
    summary: "Reconcile a bounded page of expired uploads",
    operationId: "dashboard.media.upload_reconcile",
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(25) }) },
    responses: {
        200: { description: "Reconciliation result", content: { "application/json": { schema: successEnvelope(z.object({
            scanned: z.number().int(), expired: z.number().int(), retrySessionIds: z.array(z.string()), hasMore: z.boolean(),
        })) } } },
        ...mediaErrorResponses,
    },
});
app.openapi(reconcileRoute, async (c) => ok(c, await reconcileExpiredMediaUploads(c.get("db"), c.env.BUCKET, c.req.valid("query").limit)));

const patchMediaRoute = createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Admin - Media"],
    summary: "Update ready media metadata with CAS",
    operationId: "dashboard.media.update",
    request: { params: idParam, body: { content: { "application/json": { schema: updateMediaSchema } } } },
    responses: { 200: { description: "Media updated", content: { "application/json": { schema: successEnvelope(z.object({ file: mediaSchema })) } } }, ...mediaErrorResponses },
});
app.openapi(patchMediaRoute, async (c) => {
    const db = c.get("db");
    const id = c.req.valid("param").id;
    const file = await updateMediaFile(db, id, c.req.valid("json"));
    await invalidateMediaDependentProductCaches(db, id, c);
    return ok(c, { file });
});

for (const [path, summary, operationId, action] of [
    ["/{id}/trash", "Move media to trash", "dashboard.media.trash", trashMediaFile],
    ["/{id}/restore", "Restore trashed media", "dashboard.media.restore", restoreMediaFile],
] as const) {
    const route = createRoute({
        method: "post",
        path,
        tags: ["Admin - Media"],
        summary,
        operationId,
        request: { params: idParam, body: { content: { "application/json": { schema: mediaVersionCommandSchema } } } },
        responses: { 200: { description: summary, content: { "application/json": { schema: successEnvelope(z.object({ file: mediaSchema })) } } }, ...mediaErrorResponses },
    });
    app.openapi(route, async (c) => {
        const db = c.get("db");
        const id = c.req.valid("param").id;
        const file = await action(db, id, c.req.valid("json").expectedVersion);
        await invalidateMediaDependentProductCaches(db, id, c);
        return ok(c, { file });
    });
}

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    tags: ["Admin - Media"],
    summary: "Permanently delete unreferenced trashed media",
    operationId: "dashboard.media.permanently_delete",
    request: { params: idParam, query: z.object({ expectedVersion: z.coerce.number().int().min(1) }) },
    responses: { 204: noContentResponse, ...mediaErrorResponses, 503: serviceUnavailableResponse },
});
app.openapi(permanentDeleteRoute, async (c) => {
    await permanentlyDeleteMediaFile(c.get("db"), c.req.valid("param").id, c.req.valid("query").expectedVersion, c.env.BUCKET);
    return noContent(c);
});

const moveRoute = createRoute({
    method: "post",
    path: "/move",
    tags: ["Admin - Media"],
    summary: "Move ready media with per-item CAS",
    operationId: "dashboard.media.move",
    request: { body: { content: { "application/json": { schema: moveMediaSchema } } } },
    responses: { 200: { description: "Media moved", content: { "application/json": { schema: successEnvelope(z.object({ movedCount: z.number().int() })) } } }, ...mediaErrorResponses },
});
app.openapi(moveRoute, async (c) => {
    const body = c.req.valid("json");
    return ok(c, await moveMediaFiles(c.get("db"), body.items, body.folderId ?? null));
});

const listFoldersRoute = createRoute({
    method: "get",
    path: "/folders",
    tags: ["Admin - Media"],
    summary: "List flat media folders with cursors",
    operationId: "dashboard.media_folders.list",
    request: { query: z.object({
        cursor: z.string().max(2_000).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
    }) },
    responses: { 200: { description: "Folder page", content: { "application/json": { schema: successEnvelope(z.object({
        folders: z.array(mediaFolderSchema), pagination: cursorPaginationSchema,
    })) } } }, ...mediaErrorResponses },
});
app.openapi(listFoldersRoute, async (c) => ok(c, await listMediaFolders(c.get("db"), c.req.valid("query"))));

const createFolderRoute = createRoute({
    method: "post", path: "/folders", tags: ["Admin - Media"], summary: "Create a flat media folder",
    operationId: "dashboard.media_folders.create",
    request: { body: { content: { "application/json": { schema: createFolderSchema } } } },
    responses: { 201: { description: "Folder created", content: { "application/json": { schema: successEnvelope(z.object({ folder: mediaFolderSchema })) } } }, ...mediaErrorResponses },
});
app.openapi(createFolderRoute, async (c) => created(c, { folder: await createMediaFolder(c.get("db"), c.req.valid("json").name) }));

const updateFolderRoute = createRoute({
    method: "put", path: "/folders/{id}", tags: ["Admin - Media"], summary: "Rename a media folder with CAS",
    operationId: "dashboard.media_folders.update",
    request: { params: idParam, body: { content: { "application/json": { schema: updateFolderSchema } } } },
    responses: { 200: { description: "Folder renamed", content: { "application/json": { schema: successEnvelope(z.object({ folder: mediaFolderSchema })) } } }, ...mediaErrorResponses },
});
app.openapi(updateFolderRoute, async (c) => {
    const body = c.req.valid("json");
    return ok(c, { folder: await updateMediaFolder(c.get("db"), c.req.valid("param").id, body.name, body.expectedVersion) });
});

const deleteFolderRoute = createRoute({
    method: "delete", path: "/folders/{id}", tags: ["Admin - Media"], summary: "Delete a media folder with CAS",
    operationId: "dashboard.media_folders.delete",
    request: { params: idParam, query: z.object({ expectedVersion: z.coerce.number().int().min(1) }) },
    responses: { 204: noContentResponse, ...mediaErrorResponses },
});
app.openapi(deleteFolderRoute, async (c) => {
    await deleteMediaFolder(c.get("db"), c.req.valid("param").id, c.req.valid("query").expectedVersion);
    return noContent(c);
});

export { app as adminMediaRoutes };
