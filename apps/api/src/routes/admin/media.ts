// src/server/routes/admin/media.ts
// Admin OpenAPI routes for media.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    MediaService,
    updateMediaSchema,
    moveMediaSchema,
    createFolderSchema
} from "@scalius/core/modules/media";

const app = new OpenAPIHono();

// ── List Media ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Media"],
    summary: "List all media files",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            folderId: z.string().optional().openapi({ description: "Folder ID filter" }),
        }),
    },
    responses: {
        200: { description: "Media list with pagination", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const result = await MediaService.listFiles(db, query.page, query.limit, query.search || "", query.folderId);
    return c.json(result, 200);
});

// ── Upload Media ──
// Note: multipart upload cannot use createRoute validation, so we use a plain route definition

const uploadRoute = createRoute({
    method: "post",
    path: "/upload",
    tags: ["Admin - Media"],
    summary: "Upload media files",
    responses: {
        200: { description: "Upload result", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(uploadRoute, async (c) => {
    const db = c.get("db");
    const body = await c.req.parseBody({ all: true });

    let files: any = body["files"];
    if (!files) files = [];
    if (!Array.isArray(files)) files = [files];

    const folderId = (body["folderId"] as string) || null;

    try {
        const result = await MediaService.uploadFiles(db, files, folderId);
        return c.json(result, result.status);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

// ── Update Media (PATCH) ──

const patchMediaRoute = createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Admin - Media"],
    summary: "Update media metadata (PATCH)",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Media ID" }) }),
        body: { content: { "application/json": { schema: updateMediaSchema } } },
    },
    responses: {
        200: { description: "Media updated", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(patchMediaRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    try {
        const file = await MediaService.updateFile(db, id, data);
        return c.json({ file }, 200);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 500);
    }
});

// ── Update Media (PUT) ──

const putMediaRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Media"],
    summary: "Update media metadata (PUT)",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Media ID" }) }),
        body: { content: { "application/json": { schema: updateMediaSchema } } },
    },
    responses: {
        200: { description: "Media updated", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(putMediaRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    try {
        const file = await MediaService.updateFile(db, id, data);
        return c.json({ file }, 200);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 500);
    }
});

// ── Move Files ──

const moveRoute = createRoute({
    method: "post",
    path: "/move",
    tags: ["Admin - Media"],
    summary: "Move media files to a folder",
    request: {
        body: { content: { "application/json": { schema: moveMediaSchema } } },
    },
    responses: {
        200: { description: "Files moved", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(moveRoute, async (c) => {
    const db = c.get("db");
    const { fileIds, folderId } = c.req.valid("json");
    await MediaService.moveFiles(db, fileIds, folderId || null);
    return c.json({ success: true, message: `Moved ${fileIds.length} file(s)` }, 200);
});

// ── Delete File ──

const deleteFileRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Media"],
    summary: "Delete a media file",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Media ID" }) }),
    },
    responses: {
        204: { description: "File deleted" },
    },
});

app.openapi(deleteFileRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    try {
        await MediaService.deleteFile(db, id);
        return c.body(null, 204);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 500);
    }
});

// ── List Folders ──

const listFoldersRoute = createRoute({
    method: "get",
    path: "/folders",
    tags: ["Admin - Media"],
    summary: "List all media folders",
    responses: {
        200: { description: "Folder list", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(listFoldersRoute, async (c) => {
    const db = c.get("db");
    const folders = await MediaService.listFolders(db);
    return c.json({ folders }, 200);
});

// ── Create Folder ──

const createFolderRoute = createRoute({
    method: "post",
    path: "/folders",
    tags: ["Admin - Media"],
    summary: "Create a media folder",
    request: {
        body: { content: { "application/json": { schema: createFolderSchema } } },
    },
    responses: {
        201: { description: "Folder created", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(createFolderRoute, async (c) => {
    const db = c.get("db");
    const { name, parentId } = c.req.valid("json");
    const folder = await MediaService.createFolder(db, name, parentId);
    return c.json({ folder }, 201);
});

// ── Delete Folder ──

const deleteFolderRoute = createRoute({
    method: "delete",
    path: "/folders/{id}",
    tags: ["Admin - Media"],
    summary: "Delete a media folder",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Folder ID" }) }),
    },
    responses: {
        204: { description: "Folder deleted" },
    },
});

app.openapi(deleteFolderRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await MediaService.deleteFolder(db, id);
    return c.body(null, 204);
});

export { app as adminMediaRoutes };
