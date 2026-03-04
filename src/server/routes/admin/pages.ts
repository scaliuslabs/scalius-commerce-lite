// src/server/routes/admin/pages.ts
// Admin Hono routes for CMS pages.
// All DB logic is delegated to src/modules/pages/pages.service.ts.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
    listPages,
    getPageById,
    createPage,
    updatePage,
    deletePage,
    bulkDeletePages,
    bulkPublishPages,
    bulkUnpublishPages,
    restorePages,
    createPageSchema,
    updatePageSchema,
} from "@/modules/pages";

const app = new Hono<{ Bindings: Env }>();

// GET /admin/pages
app.get("/", async (c) => {
    const db = c.get("db");
    const q = c.req.query();
    const result = await listPages(db, {
        page: parseInt(q.page || "1"),
        limit: parseInt(q.limit || "10"),
        search: q.search || "",
        showTrashed: q.trashed === "true",
        sort: (q.sort as any) || "updatedAt",
        order: (q.order as any) || "desc",
    });
    return c.json(result);
});

// POST /admin/pages
app.post("/", zValidator("json", createPageSchema), async (c) => {
    const db = c.get("db");
    try {
        const result = await createPage(db, c.req.valid("json"));
        return c.json(result, 201);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

// POST /admin/pages/bulk-delete
app.post("/bulk-delete", zValidator("json", z.object({ pageIds: z.array(z.string()), permanent: z.boolean().default(false) })), async (c) => {
    const db = c.get("db");
    const { pageIds, permanent } = c.req.valid("json");
    await bulkDeletePages(db, pageIds, permanent);
    return c.body(null, 204);
});

// POST /admin/pages/bulk-publish
app.post("/bulk-publish", zValidator("json", z.object({ ids: z.array(z.string()) })), async (c) => {
    const db = c.get("db");
    await bulkPublishPages(db, c.req.valid("json").ids);
    return c.body(null, 204);
});

// POST /admin/pages/bulk-unpublish
app.post("/bulk-unpublish", zValidator("json", z.object({ ids: z.array(z.string()) })), async (c) => {
    const db = c.get("db");
    await bulkUnpublishPages(db, c.req.valid("json").ids);
    return c.body(null, 204);
});

// POST /admin/pages/bulk-restore
app.post("/bulk-restore", zValidator("json", z.object({ ids: z.array(z.string()) })), async (c) => {
    const db = c.get("db");
    await restorePages(db, c.req.valid("json").ids);
    return c.body(null, 204);
});

// GET /admin/pages/:id
app.get("/:id", async (c) => {
    const db = c.get("db");
    const page = await getPageById(db, c.req.param("id"));
    if (!page) return c.json({ error: "Page not found" }, 404);
    return c.json(page);
});

// PUT /admin/pages/:id
app.put("/:id", zValidator("json", updatePageSchema), async (c) => {
    const db = c.get("db");
    try {
        await updatePage(db, c.req.param("id"), c.req.valid("json"));
        return c.json({ success: true });
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

// DELETE /admin/pages/:id
app.delete("/:id", async (c) => {
    const db = c.get("db");
    await deletePage(db, c.req.param("id"));
    return c.body(null, 204);
});

// DELETE /admin/pages/:id/permanent
app.delete("/:id/permanent", async (c) => {
    const db = c.get("db");
    await bulkDeletePages(db, [c.req.param("id")], true);
    return c.body(null, 204);
});

export { app as adminPageRoutes };
