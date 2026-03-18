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
    createHistoryEntry,
    getWidgetHistory,
    restoreFromHistory,
    deleteHistoryEntry,
} from "@scalius/core/modules/widgets";
import { NotFoundError, ApiError } from "../../utils/api-error";

import { ok, created, noContent } from "../../utils/api-response";
const app = new OpenAPIHono();

// ── List Widgets ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Widgets"],
    summary: "List all widgets",
    responses: {
        200: { description: "Widget list"  }
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const result = await listWidgets(db);
    return ok(c, result);
});

// ── Create Widget ──

const createWidgetRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Widgets"],
    summary: "Create a widget",
    request: {
        body: { content: { "application/json": { schema: createWidgetSchema } } }
    },
    responses: {
        201: { description: "Widget created"  }
    }
});

app.openapi(createWidgetRoute, async (c) => {
    const db = c.get("db");
    const widget = await createWidget(db, c.req.valid("json"));
    return created(c, widget);
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
                    schema: z.object({ ids: z.array(z.string()), permanent: z.boolean().default(false) })
                }
            }
        }
    },
    responses: {
        204: { description: "Widgets deleted" }
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { ids, permanent } = c.req.valid("json");
    await bulkDeleteWidgets(db, ids, permanent);
    return noContent(c);
});

// ── Bulk Activate Widgets ──

const bulkActivateRoute = createRoute({
    method: "post",
    path: "/bulk-activate",
    tags: ["Admin - Widgets"],
    summary: "Bulk activate widgets",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string()) }) } } }
    },
    responses: {
        204: { description: "Widgets activated" }
    }
});

app.openapi(bulkActivateRoute, async (c) => {
    const db = c.get("db");
    await bulkActivateWidgets(db, c.req.valid("json").ids);
    return noContent(c);
});

// ── Bulk Deactivate Widgets ──

const bulkDeactivateRoute = createRoute({
    method: "post",
    path: "/bulk-deactivate",
    tags: ["Admin - Widgets"],
    summary: "Bulk deactivate widgets",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string()) }) } } }
    },
    responses: {
        204: { description: "Widgets deactivated" }
    }
});

app.openapi(bulkDeactivateRoute, async (c) => {
    const db = c.get("db");
    await bulkDeactivateWidgets(db, c.req.valid("json").ids);
    return noContent(c);
});

// ── Bulk Restore Widgets ──

const bulkRestoreRoute = createRoute({
    method: "post",
    path: "/bulk-restore",
    tags: ["Admin - Widgets"],
    summary: "Bulk restore widgets",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string()) }) } } }
    },
    responses: {
        204: { description: "Widgets restored" }
    }
});

app.openapi(bulkRestoreRoute, async (c) => {
    const db = c.get("db");
    await restoreWidgets(db, c.req.valid("json").ids);
    return noContent(c);
});

// ── Get Widget By ID ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Widgets"],
    summary: "Get a widget by ID",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Widget details"  }
    }
});

app.openapi(getByIdRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const widget = await getWidgetById(db, id);
    if (!widget) throw new NotFoundError("Widget not found");
    return ok(c, widget);
});

// ── Update Widget ──

const updateWidgetRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Widgets"],
    summary: "Update a widget",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateWidgetSchema } } }
    },
    responses: {
        200: { description: "Widget updated"  }
    }
});

app.openapi(updateWidgetRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    try {
        const result = await updateWidget(db, id, c.req.valid("json"));
        return ok(c, result);
    } catch (error: unknown) {
        const err = error as { message?: string; statusCode?: number };
        throw new ApiError(err.statusCode || 400, "ERROR", err.message || "Unknown error");
    }
});

// ── Delete Widget ──

const deleteWidgetRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Widgets"],
    summary: "Soft-delete a widget",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: { description: "Widget deleted" }
    }
});

app.openapi(deleteWidgetRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deleteWidget(db, id);
    return noContent(c);
});

// ── Permanent Delete Widget ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    tags: ["Admin - Widgets"],
    summary: "Permanently delete a widget",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: { description: "Widget permanently deleted" }
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await bulkDeleteWidgets(db, [id], true);
    return noContent(c);
});

// ── Restore Widget ──

const restoreWidgetRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Widgets"],
    summary: "Restore a soft-deleted widget",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: { description: "Widget restored" }
    }
});

app.openapi(restoreWidgetRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await restoreWidgets(db, [id]);
    return noContent(c);
});

// ── Toggle Widget Status ──

const toggleStatusRoute = createRoute({
    method: "patch",
    path: "/{id}/toggle-status",
    tags: ["Admin - Widgets"],
    summary: "Toggle widget active status",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Widget status toggled"  }
    }
});

app.openapi(toggleStatusRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const widget = await getWidgetById(db, id);
    if (!widget) throw new NotFoundError("Widget not found");
    const result = await updateWidget(db, id, { isActive: !widget.isActive });
    return ok(c, result);
});

// ── Get Widget History ──

const getHistoryRoute = createRoute({
    method: "get",
    path: "/{id}/history",
    tags: ["Admin - Widgets"],
    summary: "List all history entries for a widget",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Widget history entries" },
        404: { description: "Widget not found" }
    }
});

app.openapi(getHistoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const history = await getWidgetHistory(db, id);
    return ok(c, history);
});

// ── Create Widget History Entry ──

const createHistoryRoute = createRoute({
    method: "post",
    path: "/{id}/history",
    tags: ["Admin - Widgets"],
    summary: "Save current widget state as a history entry",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({ reason: z.string().optional().default("Manual save") })
                }
            }
        }
    },
    responses: {
        201: { description: "History entry created" },
        404: { description: "Widget not found" }
    }
});

app.openapi(createHistoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const entry = await createHistoryEntry(db, id, reason);
    return created(c, entry);
});

// ── Restore Widget History Version ──

const restoreHistoryRoute = createRoute({
    method: "post",
    path: "/{id}/history/restore",
    tags: ["Admin - Widgets"],
    summary: "Restore a widget to a previous history version",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({ historyId: z.string() })
                }
            }
        }
    },
    responses: {
        200: { description: "Widget restored from history" },
        404: { description: "Widget or history entry not found" }
    }
});

app.openapi(restoreHistoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { historyId } = c.req.valid("json");
    const result = await restoreFromHistory(db, id, historyId);
    return ok(c, result);
});

// ── Delete Widget History Entry ──

const deleteHistoryRoute = createRoute({
    method: "delete",
    path: "/{id}/history/{versionId}",
    tags: ["Admin - Widgets"],
    summary: "Delete a widget history entry",
    request: {
        params: z.object({ id: z.string(), versionId: z.string() }),
    },
    responses: {
        204: { description: "History entry deleted" },
        404: { description: "History entry not found" }
    }
});

app.openapi(deleteHistoryRoute, async (c) => {
    const db = c.get("db");
    const { id, versionId } = c.req.valid("param");
    await deleteHistoryEntry(db, id, versionId);
    return noContent(c);
});

export { app as adminWidgetRoutes };
