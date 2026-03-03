// src/server/routes/admin/collections.ts
// Admin Hono routes for collections.
// All DB logic is delegated to src/modules/collections/collections.service.ts.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
    listCollections,
    getCollectionById,
    createCollection,
    updateCollection,
    deleteCollection,
    bulkDeleteCollections,
    bulkActivateCollections,
    bulkDeactivateCollections,
    restoreCollections,
    reorderCollections,
    createCollectionSchema,
    updateCollectionSchema,
} from "@/modules/collections";

const app = new Hono<{ Bindings: Env }>();

// GET /admin/collections
app.get("/", async (c) => {
    const db = c.get("db");
    const q = c.req.query();
    const result = await listCollections(db, {
        page: parseInt(q.page || "1"),
        limit: parseInt(q.limit || "20"),
        search: q.search || "",
        showTrashed: q.trashed === "true",
        sort: (q.sort as any) || "sortOrder",
        order: (q.order as any) || "asc",
    });
    return c.json(result);
});

// POST /admin/collections
app.post("/", zValidator("json", createCollectionSchema), async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const collection = await createCollection(db, data);
    return c.json(collection, 201);
});

// POST /admin/collections/bulk-delete
app.post("/bulk-delete", zValidator("json", z.object({ ids: z.array(z.string()), permanent: z.boolean().default(false) })), async (c) => {
    const db = c.get("db");
    const { ids, permanent } = c.req.valid("json");
    await bulkDeleteCollections(db, ids, permanent);
    return c.body(null, 204);
});

// POST /admin/collections/bulk-activate
app.post("/bulk-activate", zValidator("json", z.object({ ids: z.array(z.string()) })), async (c) => {
    const db = c.get("db");
    const { ids } = c.req.valid("json");
    await bulkActivateCollections(db, ids);
    return c.body(null, 204);
});

// POST /admin/collections/bulk-deactivate
app.post("/bulk-deactivate", zValidator("json", z.object({ ids: z.array(z.string()) })), async (c) => {
    const db = c.get("db");
    const { ids } = c.req.valid("json");
    await bulkDeactivateCollections(db, ids);
    return c.body(null, 204);
});

// POST /admin/collections/bulk-restore
app.post("/bulk-restore", zValidator("json", z.object({ ids: z.array(z.string()) })), async (c) => {
    const db = c.get("db");
    const { ids } = c.req.valid("json");
    await restoreCollections(db, ids);
    return c.body(null, 204);
});

// POST /admin/collections/reorder
app.post("/reorder", zValidator("json", z.object({ items: z.array(z.object({ id: z.string(), sortOrder: z.number() })) })), async (c) => {
    const db = c.get("db");
    const { items } = c.req.valid("json");
    await reorderCollections(db, items);
    return c.json({ success: true });
});

// GET /admin/collections/:id
app.get("/:id", async (c) => {
    const db = c.get("db");
    const collection = await getCollectionById(db, c.req.param("id"));
    if (!collection) return c.json({ error: "Collection not found" }, 404);
    return c.json(collection);
});

// PUT /admin/collections/:id
app.put("/:id", zValidator("json", updateCollectionSchema), async (c) => {
    const db = c.get("db");
    const result = await updateCollection(db, c.req.param("id"), c.req.valid("json"));
    return c.json(result);
});

// DELETE /admin/collections/:id
app.delete("/:id", async (c) => {
    const db = c.get("db");
    try {
        await deleteCollection(db, c.req.param("id"));
        return c.body(null, 204);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

export { app as adminCollectionRoutes };
