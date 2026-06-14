// src/server/routes/admin/media.ts
// Admin OpenAPI routes for media.

import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import { ok, created, noContent } from "../../utils/api-response";
import { NotFoundError } from "../../utils/api-error";
import {
    successEnvelope,
    paginatedEnvelope,
    messageResponse,
    noContentResponse,
    errorResponses,
} from "../../schemas/responses";
import { mediaSchema, mediaFolderSchema } from "../../schemas/entities";
import {
    listMediaFiles,
    uploadMediaFiles,
    updateMediaFile,
    deleteMediaFile,
    moveMediaFiles,
    listMediaFolders,
    createMediaFolder,
    updateMediaFolder,
    deleteMediaFolder,
    updateMediaSchema,
    moveMediaSchema,
    createFolderSchema,
    updateFolderSchema
} from "@scalius/core/modules/media";

const app = new OpenAPIHono<{ Bindings: Env }>();

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AdminRouteContext<R extends RouteConfig> = Parameters<AdminRouteHandler<R>>[0];
type UpdateMediaFileInput = Parameters<typeof updateMediaFile>[2];

const uploadedMediaSchema = mediaSchema.pick({
    id: true,
    filename: true,
    url: true,
    size: true,
    mimeType: true,
    altText: true,
    width: true,
    height: true,
    createdAt: true,
});

const uploadResponseSchema = successEnvelope(
    z.object({
        files: z.array(uploadedMediaSchema),
        summary: z.string().optional(),
        warnings: z.array(z.object({ filename: z.string(), error: z.string() })).optional(),
        partialSuccess: z.boolean().optional(),
    }),
);

// ── List Media ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Media"],
    summary: "List all media files",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().max(100).default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            folderId: z.string().optional().openapi({ description: "Folder ID filter" }),
            sortBy: z.enum(["createdAt", "size", "filename"]).optional().default("createdAt").openapi({ description: "Sort field" }),
            sortOrder: z.enum(["asc", "desc"]).optional().default("desc").openapi({ description: "Sort direction" }),
            mimeType: z.string().optional().openapi({ description: "MIME type filter prefix (e.g. 'image/')" }),
            type: z.string().optional().openapi({ description: "Legacy MIME type filter prefix" }),
        })
    },
    responses: {
        200: {
            description: "Media list with pagination",
            content: { "application/json": { schema: paginatedEnvelope("files", mediaSchema) } },
        },
        ...errorResponses,
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const result = await listMediaFiles(
        db, query.page, query.limit, query.search || "", query.folderId,
        query.sortBy as "createdAt" | "size" | "filename",
        query.sortOrder as "asc" | "desc",
        query.mimeType ?? query.type,
    );
    return ok(c, result);
});

// ── Upload Media ──
// Note: multipart upload cannot use createRoute validation, so we use a plain route definition

const uploadRoute = createRoute({
    method: "post",
    path: "/upload",
    tags: ["Admin - Media"],
    summary: "Upload media files",
    responses: {
        200: {
            description: "Upload result (partial success or info)",
            content: { "application/json": { schema: uploadResponseSchema } },
        },
        201: {
            description: "All files uploaded successfully",
            content: { "application/json": { schema: uploadResponseSchema } },
        },
        ...errorResponses,
    }
});

app.openapi(uploadRoute, (async (c: AdminRouteContext<typeof uploadRoute>) => {
    const db = c.get("db");
    const body = await c.req.parseBody({ all: true });

    let files: unknown = body["files"];
    if (!files) files = [];
    if (!Array.isArray(files)) files = [files];

    const folderId = (body["folderId"] as string) || null;

    const validFiles = (files as unknown[]).filter((f): f is File => f instanceof File);
    const result = await uploadMediaFiles(db, validFiles, folderId);
    return result.partialSuccess ? ok(c, result) : created(c, result);
}) as unknown as AdminRouteHandler<typeof uploadRoute>);

// ── Update Media (PATCH) ──

const patchMediaRoute = createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Admin - Media"],
    summary: "Update media metadata (PATCH)",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateMediaSchema } } }
    },
    responses: {
        200: {
            description: "Media updated",
            content: { "application/json": { schema: successEnvelope(z.object({ file: mediaSchema })) } },
        },
        ...errorResponses,
    }
});

app.openapi(patchMediaRoute, (async (c: AdminRouteContext<typeof patchMediaRoute>) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json") as unknown as UpdateMediaFileInput;
    const file = await updateMediaFile(db, id, data);
    return ok(c, { file });
}) as unknown as AdminRouteHandler<typeof patchMediaRoute>);

// ── Update Media (PUT) ──

const putMediaRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Media"],
    summary: "Update media metadata (PUT)",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateMediaSchema } } }
    },
    responses: {
        200: {
            description: "Media updated",
            content: { "application/json": { schema: successEnvelope(z.object({ file: mediaSchema })) } },
        },
        ...errorResponses,
    }
});

app.openapi(putMediaRoute, (async (c: AdminRouteContext<typeof putMediaRoute>) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json") as unknown as UpdateMediaFileInput;
    const file = await updateMediaFile(db, id, data);
    return ok(c, { file });
}) as unknown as AdminRouteHandler<typeof putMediaRoute>);

// ── Move Files ──

const moveRoute = createRoute({
    method: "post",
    path: "/move",
    tags: ["Admin - Media"],
    summary: "Move media files to a folder",
    request: {
        body: { content: { "application/json": { schema: moveMediaSchema } } }
    },
    responses: {
        200: {
            description: "Files moved",
            content: { "application/json": { schema: messageResponse } },
        },
        ...errorResponses,
    }
});

app.openapi(moveRoute, async (c) => {
    const db = c.get("db");
    const { fileIds, folderId } = c.req.valid("json");
    const { movedCount } = await moveMediaFiles(db, fileIds, folderId || null);
    if (movedCount === 0) {
        throw new NotFoundError("No files were moved — they may have been deleted");
    }
    return ok(c, { message: `Moved ${movedCount} file(s)`, movedCount });
});

// ── Delete File ──

const deleteFileRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Media"],
    summary: "Delete a media file",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(deleteFileRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deleteMediaFile(db, id);
    return noContent(c);
});

// ── List Folders ──

const listFoldersRoute = createRoute({
    method: "get",
    path: "/folders",
    tags: ["Admin - Media"],
    summary: "List all media folders",
    responses: {
        200: {
            description: "Folder list",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({ folders: z.array(mediaFolderSchema) })),
                },
            },
        },
        ...errorResponses,
    }
});

app.openapi(listFoldersRoute, async (c) => {
    const db = c.get("db");
    const folders = await listMediaFolders(db);
    return ok(c, { folders });
});

// ── Create Folder ──

const createFolderRoute = createRoute({
    method: "post",
    path: "/folders",
    tags: ["Admin - Media"],
    summary: "Create a media folder",
    request: {
        body: { content: { "application/json": { schema: createFolderSchema } } }
    },
    responses: {
        201: {
            description: "Folder created",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({ folder: mediaFolderSchema })),
                },
            },
        },
        ...errorResponses,
    }
});

app.openapi(createFolderRoute, (async (c: AdminRouteContext<typeof createFolderRoute>) => {
    const db = c.get("db");
    const { name, parentId } = c.req.valid("json");
    const folder = await createMediaFolder(db, name, parentId);
    return created(c, { folder });
}) as unknown as AdminRouteHandler<typeof createFolderRoute>);

// ── Update Folder ──

const updateFolderRoute = createRoute({
    method: "put",
    path: "/folders/{id}",
    tags: ["Admin - Media"],
    summary: "Rename a media folder",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateFolderSchema } } }
    },
    responses: {
        200: {
            description: "Folder renamed",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({ folder: mediaFolderSchema })),
                },
            },
        },
        ...errorResponses,
    }
});

app.openapi(updateFolderRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { name } = c.req.valid("json");
    const folder = await updateMediaFolder(db, id, name);
    return ok(c, { folder });
});

// ── Delete Folder ──

const deleteFolderRoute = createRoute({
    method: "delete",
    path: "/folders/{id}",
    tags: ["Admin - Media"],
    summary: "Delete a media folder",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(deleteFolderRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deleteMediaFolder(db, id);
    return noContent(c);
});

export { app as adminMediaRoutes };
