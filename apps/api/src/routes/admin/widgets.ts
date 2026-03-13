// src/server/routes/admin/widgets.ts
// Admin OpenAPI routes for widgets.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
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
} from "@scalius/core/modules/widgets";
import { NotFoundError } from "../../utils/api-error";

const app = new OpenAPIHono();

// ── List Widgets ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Widgets"],
    summary: "List all widgets",
    responses: {
        200: { description: "Widget list", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const result = await listWidgets(db);
    return c.json(result, 200);
});

// ── Create Widget ──

const createWidgetRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Widgets"],
    summary: "Create a widget",
    request: {
        body: { content: { "application/json": { schema: createWidgetSchema } } },
    },
    responses: {
        201: { description: "Widget created", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(createWidgetRoute, async (c) => {
    const db = c.get("db");
    const widget = await createWidget(db, c.req.valid("json"));
    return c.json(widget, 201);
});

// ── Bulk Delete Widgets ──

const bulkDeleteRoute = createRoute({
    method: "post",
    path: "/bulk-delete",
    tags: ["Admin - Widgets"],
    summary: "Bulk delete widgets",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({ ids: z.array(z.string()), permanent: z.boolean().default(false) }),
                },
            },
        },
    },
    responses: {
        204: { description: "Widgets deleted" },
    },
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { ids, permanent } = c.req.valid("json");
    await bulkDeleteWidgets(db, ids, permanent);
    return c.body(null, 204);
});

// ── Bulk Activate Widgets ──

const bulkActivateRoute = createRoute({
    method: "post",
    path: "/bulk-activate",
    tags: ["Admin - Widgets"],
    summary: "Bulk activate widgets",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string()) }) } } },
    },
    responses: {
        204: { description: "Widgets activated" },
    },
});

app.openapi(bulkActivateRoute, async (c) => {
    const db = c.get("db");
    await bulkActivateWidgets(db, c.req.valid("json").ids);
    return c.body(null, 204);
});

// ── Bulk Deactivate Widgets ──

const bulkDeactivateRoute = createRoute({
    method: "post",
    path: "/bulk-deactivate",
    tags: ["Admin - Widgets"],
    summary: "Bulk deactivate widgets",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string()) }) } } },
    },
    responses: {
        204: { description: "Widgets deactivated" },
    },
});

app.openapi(bulkDeactivateRoute, async (c) => {
    const db = c.get("db");
    await bulkDeactivateWidgets(db, c.req.valid("json").ids);
    return c.body(null, 204);
});

// ── Bulk Restore Widgets ──

const bulkRestoreRoute = createRoute({
    method: "post",
    path: "/bulk-restore",
    tags: ["Admin - Widgets"],
    summary: "Bulk restore widgets",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string()) }) } } },
    },
    responses: {
        204: { description: "Widgets restored" },
    },
});

app.openapi(bulkRestoreRoute, async (c) => {
    const db = c.get("db");
    await restoreWidgets(db, c.req.valid("json").ids);
    return c.body(null, 204);
});

// ── Get Widget By ID ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Widgets"],
    summary: "Get a widget by ID",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Widget ID" }) }),
    },
    responses: {
        200: { description: "Widget details", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(getByIdRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const widget = await getWidgetById(db, id);
    if (!widget) throw new NotFoundError("Widget not found");
    return c.json(widget, 200);
});

// ── Update Widget ──

const updateWidgetRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Widgets"],
    summary: "Update a widget",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Widget ID" }) }),
        body: { content: { "application/json": { schema: updateWidgetSchema } } },
    },
    responses: {
        200: { description: "Widget updated", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(updateWidgetRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    try {
        const result = await updateWidget(db, id, c.req.valid("json"));
        return c.json(result, 200);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

// ── Delete Widget ──

const deleteWidgetRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Widgets"],
    summary: "Soft-delete a widget",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Widget ID" }) }),
    },
    responses: {
        204: { description: "Widget deleted" },
    },
});

app.openapi(deleteWidgetRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deleteWidget(db, id);
    return c.body(null, 204);
});

// ── Permanent Delete Widget ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    tags: ["Admin - Widgets"],
    summary: "Permanently delete a widget",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Widget ID" }) }),
    },
    responses: {
        204: { description: "Widget permanently deleted" },
    },
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await bulkDeleteWidgets(db, [id], true);
    return c.body(null, 204);
});

// ── Restore Widget ──

const restoreWidgetRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Widgets"],
    summary: "Restore a soft-deleted widget",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Widget ID" }) }),
    },
    responses: {
        204: { description: "Widget restored" },
    },
});

app.openapi(restoreWidgetRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await restoreWidgets(db, [id]);
    return c.body(null, 204);
});

// ── Toggle Widget Status ──

const toggleStatusRoute = createRoute({
    method: "patch",
    path: "/{id}/toggle-status",
    tags: ["Admin - Widgets"],
    summary: "Toggle widget active status",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Widget ID" }) }),
    },
    responses: {
        200: { description: "Widget status toggled", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(toggleStatusRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const widget = await getWidgetById(db, id);
    if (!widget) throw new NotFoundError("Widget not found");
    const result = await updateWidget(db, id, { isActive: !widget.isActive });
    return c.json(result, 200);
});

export { app as adminWidgetRoutes };
