// src/server/routes/admin/media.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
    MediaService,
    updateMediaSchema,
    moveMediaSchema,
    createFolderSchema
} from "@/modules/media";

const app = new Hono<{ Bindings: any }>();

// GET - List all media
app.get("/", async (c) => {
    const db = c.get("db");
    const query = c.req.query();

    const page = parseInt(query.page || "1");
    const limit = parseInt(query.limit || "10");
    const search = query.search || "";
    const folderId = query.folderId;

    const result = await MediaService.listFiles(db, page, limit, search, folderId);
    return c.json(result);
});

// POST - Upload media
app.post("/upload", async (c) => {
    const db = c.get("db");
    const body = await c.req.parseBody({ all: true });

    // parseBody handles multipart/form-data
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

// PATCH/PUT - Update specific media metadata
app.patch("/:id", zValidator("json", updateMediaSchema), async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const data = c.req.valid("json");

    try {
        const file = await MediaService.updateFile(db, id, data);
        return c.json({ file });
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 500);
    }
});

app.put("/:id", zValidator("json", updateMediaSchema), async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const data = c.req.valid("json");

    try {
        const file = await MediaService.updateFile(db, id, data);
        return c.json({ file });
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 500);
    }
});

// POST - Move files
app.post("/move", zValidator("json", moveMediaSchema), async (c) => {
    const db = c.get("db");
    const { fileIds, folderId } = c.req.valid("json");

    await MediaService.moveFiles(db, fileIds, folderId || null);
    return c.json({ success: true, message: `Moved ${fileIds.length} file(s)` });
});

// DELETE - Delete a specific file
app.delete("/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    try {
        await MediaService.deleteFile(db, id);
        return c.body(null, 204);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 500);
    }
});

// -------- FoldERS API --------

// GET - List all folders
app.get("/folders", async (c) => {
    const db = c.get("db");
    const folders = await MediaService.listFolders(db);
    return c.json({ folders });
});

// POST - Create a new folder
app.post("/folders", zValidator("json", createFolderSchema), async (c) => {
    const db = c.get("db");
    const { name, parentId } = c.req.valid("json");

    const folder = await MediaService.createFolder(db, name, parentId);
    return c.json({ folder }, 201);
});

// DELETE - Delete a folder
app.delete("/folders/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    await MediaService.deleteFolder(db, id);
    return c.body(null, 204);
});

// We need to order routes correctly, however Hono routing is exact match or prefix match.
// /upload, /move, /folders are specific routes.
// /:id catches anything. We should structure correctly:
// The router mounts are linear.
// It's already fine since /upload is defined before /:id in Hono.

export { app as adminMediaRoutes };
