// src/server/routes/admin/widgets.ts
// Admin Hono routes for widgets.
// All DB logic is delegated to src/modules/widgets/widgets.service.ts.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
    listWidgets,
    getWidgetById,
    createWidget,
    updateWidget,
    deleteWidget,
    bulkDeleteWidgets,
    bulkActivateWidgets,
    bulkDeactivateWidgets,
    restoreWidgets,
    createWidgetSchema,
    updateWidgetSchema,
} from "@/modules/widgets";

const app = new Hono<{ Bindings: Env }>();

// GET /admin/widgets
app.get("/", async (c) => {
    const db = c.get("db");
    const result = await listWidgets(db);
    return c.json(result);
});

// POST /admin/widgets
app.post("/", zValidator("json", createWidgetSchema), async (c) => {
    const db = c.get("db");
    const widget = await createWidget(db, c.req.valid("json"));
    return c.json(widget, 201);
});

// POST /admin/widgets/bulk-delete
app.post("/bulk-delete", zValidator("json", z.object({ ids: z.array(z.string()), permanent: z.boolean().default(false) })), async (c) => {
    const db = c.get("db");
    const { ids, permanent } = c.req.valid("json");
    await bulkDeleteWidgets(db, ids, permanent);
    return c.body(null, 204);
});

// POST /admin/widgets/bulk-activate
app.post("/bulk-activate", zValidator("json", z.object({ ids: z.array(z.string()) })), async (c) => {
    const db = c.get("db");
    await bulkActivateWidgets(db, c.req.valid("json").ids);
    return c.body(null, 204);
});

// POST /admin/widgets/bulk-deactivate
app.post("/bulk-deactivate", zValidator("json", z.object({ ids: z.array(z.string()) })), async (c) => {
    const db = c.get("db");
    await bulkDeactivateWidgets(db, c.req.valid("json").ids);
    return c.body(null, 204);
});

// POST /admin/widgets/bulk-restore
app.post("/bulk-restore", zValidator("json", z.object({ ids: z.array(z.string()) })), async (c) => {
    const db = c.get("db");
    await restoreWidgets(db, c.req.valid("json").ids);
    return c.body(null, 204);
});

// GET /admin/widgets/:id
app.get("/:id", async (c) => {
    const db = c.get("db");
    const widget = await getWidgetById(db, c.req.param("id"));
    if (!widget) return c.json({ error: "Widget not found" }, 404);
    return c.json(widget);
});

// PUT /admin/widgets/:id
app.put("/:id", zValidator("json", updateWidgetSchema), async (c) => {
    const db = c.get("db");
    try {
        const result = await updateWidget(db, c.req.param("id"), c.req.valid("json"));
        return c.json(result);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

// DELETE /admin/widgets/:id
app.delete("/:id", async (c) => {
    const db = c.get("db");
    await deleteWidget(db, c.req.param("id"));
    return c.body(null, 204);
});

// DELETE /admin/widgets/:id/permanent
app.delete("/:id/permanent", async (c) => {
    const db = c.get("db");
    await bulkDeleteWidgets(db, [c.req.param("id")], true);
    return c.body(null, 204);
});

// POST /admin/widgets/:id/restore
app.post("/:id/restore", async (c) => {
    const db = c.get("db");
    await restoreWidgets(db, [c.req.param("id")]);
    return c.body(null, 204);
});

// PATCH /admin/widgets/:id/toggle-status
app.patch("/:id/toggle-status", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const widget = await getWidgetById(db, id);
    if (!widget) return c.json({ error: "Widget not found" }, 404);

    // Toggle active status
    const result = await updateWidget(db, id, { isActive: !widget.isActive });
    return c.json(result);
});

export { app as adminWidgetRoutes };
