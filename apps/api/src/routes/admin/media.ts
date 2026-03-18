// src/server/routes/admin/media.ts
// Admin OpenAPI routes for media.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ok, created, noContent } from "../../utils/api-response";
import { ApiError } from "../../utils/api-error";
import {
    listMediaFiles,
    uploadMediaFiles,
    updateMediaFile,
    deleteMediaFile,
    moveMediaFiles,
    listMediaFolders,
    createMediaFolder,
    deleteMediaFolder,
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
            folderId: z.string().optional().openapi({ description: "Folder ID filter" })
        })
    },
    responses: {
        200: { description: "Media list with pagination"  }
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const result = await listMediaFiles(db, query.page, query.limit, query.search || "", query.folderId);
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
        200: { description: "Upload result"  }
    }
});

app.openapi(uploadRoute, async (c) => {
    const db = c.get("db");
    const body = await c.req.parseBody({ all: true });

    let files: unknown = body["files"];
    if (!files) files = [];
    if (!Array.isArray(files)) files = [files];

    const folderId = (body["folderId"] as string) || null;

    try {
        const validFiles = (files as unknown[]).filter((f): f is File => f instanceof File);
        const result = await uploadMediaFiles(db, validFiles, folderId);
        return result.status === 201 ? created(c, result) : ok(c, result);
    } catch (error: unknown) {
        const err = error as { message?: string; statusCode?: number };
        throw new ApiError(err.statusCode || 400, "ERROR", err.message || "Unknown error");
    }
});

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
        200: { description: "Media updated"  }
    }
});

app.openapi(patchMediaRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    try {
        const file = await updateMediaFile(db, id, data);
        return ok(c, { file });
    } catch (error: unknown) {
        const err = error as { message?: string; statusCode?: number };
        throw new ApiError(err.statusCode || 500, "ERROR", err.message || "Unknown error");
    }
});

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
        200: { description: "Media updated"  }
    }
});

app.openapi(putMediaRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    try {
        const file = await updateMediaFile(db, id, data);
        return ok(c, { file });
    } catch (error: unknown) {
        const err = error as { message?: string; statusCode?: number };
        throw new ApiError(err.statusCode || 500, "ERROR", err.message || "Unknown error");
    }
});

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
        200: { description: "Files moved"  }
    }
});

app.openapi(moveRoute, async (c) => {
    const db = c.get("db");
    const { fileIds, folderId } = c.req.valid("json");
    await moveMediaFiles(db, fileIds, folderId || null);
    return ok(c, { message: `Moved ${fileIds.length} file(s)` });
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
        204: { description: "File deleted" }
    }
});

app.openapi(deleteFileRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    try {
        await deleteMediaFile(db, id);
        return noContent(c);
    } catch (error: unknown) {
        const err = error as { message?: string; statusCode?: number };
        throw new ApiError(err.statusCode || 500, "ERROR", err.message || "Unknown error");
    }
});

// ── List Folders ──

const listFoldersRoute = createRoute({
    method: "get",
    path: "/folders",
    tags: ["Admin - Media"],
    summary: "List all media folders",
    responses: {
        200: { description: "Folder list"  }
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
        201: { description: "Folder created"  }
    }
});

app.openapi(createFolderRoute, async (c) => {
    const db = c.get("db");
    const { name, parentId } = c.req.valid("json");
    const folder = await createMediaFolder(db, name, parentId);
    return created(c, { folder });
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
        204: { description: "Folder deleted" }
    }
});

app.openapi(deleteFolderRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deleteMediaFolder(db, id);
    return noContent(c);
});

export { app as adminMediaRoutes };
