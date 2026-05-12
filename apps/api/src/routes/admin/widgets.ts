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
import {
    successEnvelope,
    messageResponse,
    noContentResponse,
    errorResponses,
} from "../../schemas/responses";
import { widgetPlacementSchema, widgetSchema } from "../../schemas/entities";
import {
    invalidateGroups,
    triggerStorefrontPurgeForGroups,
} from "../../utils/cache-invalidation";

import { ok, created, noContent } from "../../utils/api-response";

// Widget list item — uses casted timestamps from the list query
const widgetListItemSchema = z.object({
    id: z.string(),
    name: z.string(),
    htmlContent: z.string(),
    cssContent: z.string().nullable(),
    aiContext: z.string().nullable(),
    isActive: z.boolean(),
    displayTarget: z.string(),
    placementRule: z.string(),
    referenceCollectionId: z.string().nullable(),
    sortOrder: z.number(),
    placements: z.array(widgetPlacementSchema).optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    deletedAt: z.number().nullable(),
}).passthrough();

const collectionSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    sortOrder: z.number(),
    type: z.string(),
}).passthrough();

const pageSummarySchema = z.object({
    id: z.string(),
    title: z.string(),
    slug: z.string(),
    sortOrder: z.number(),
}).passthrough();

const widgetHistoryEntrySchema = z.object({
    id: z.string(),
    widgetId: z.string(),
    htmlContent: z.string(),
    cssContent: z.string().nullable(),
    reason: z.string(),
    createdAt: z.union([z.string(), z.number()]),
}).passthrough();

const app = new OpenAPIHono<{ Bindings: Env }>();
const WIDGET_CACHE_GROUPS = ["homepage", "pages"];

async function invalidateWidgetCaches(c: { env: Env; executionCtx: ExecutionContext }): Promise<void> {
    await invalidateGroups(WIDGET_CACHE_GROUPS, c.env?.CACHE);
    triggerStorefrontPurgeForGroups(WIDGET_CACHE_GROUPS, c.env, c.executionCtx);
}

// ── List Widgets ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Widgets"],
    summary: "List all widgets",
    request: {
        query: z.object({
            trashed: z.string().optional().openapi({ description: "Show trashed items" }),
        })
    },
    responses: {
        200: {
            description: "Widget list",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        widgets: z.array(widgetListItemSchema),
                        availableCollections: z.array(collectionSummarySchema),
                        availablePages: z.array(pageSummarySchema).optional(),
                    })),
                },
            },
        },
        ...errorResponses,
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const result = await listWidgets(db, { showTrashed: query.trashed === "true" });
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
        201: {
            description: "Widget created",
            content: { "application/json": { schema: successEnvelope(widgetSchema) } },
        },
        ...errorResponses,
    }
});

app.openapi(createWidgetRoute, async (c) => {
    const db = c.get("db");
    const widget = await createWidget(db, c.req.valid("json"));
    await invalidateWidgetCaches(c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { ids, permanent } = c.req.valid("json");
    await bulkDeleteWidgets(db, ids, permanent);
    await invalidateWidgetCaches(c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkActivateRoute, async (c) => {
    const db = c.get("db");
    await bulkActivateWidgets(db, c.req.valid("json").ids);
    await invalidateWidgetCaches(c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkDeactivateRoute, async (c) => {
    const db = c.get("db");
    await bulkDeactivateWidgets(db, c.req.valid("json").ids);
    await invalidateWidgetCaches(c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkRestoreRoute, async (c) => {
    const db = c.get("db");
    await restoreWidgets(db, c.req.valid("json").ids);
    await invalidateWidgetCaches(c);
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
        200: {
            description: "Widget details",
            content: { "application/json": { schema: successEnvelope(widgetSchema) } },
        },
        ...errorResponses,
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
        200: {
            description: "Widget updated",
            content: { "application/json": { schema: successEnvelope(widgetSchema) } },
        },
        ...errorResponses,
    }
});

app.openapi(updateWidgetRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const result = await updateWidget(db, id, c.req.valid("json"));
    await invalidateWidgetCaches(c);
    return ok(c, result);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(deleteWidgetRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deleteWidget(db, id);
    await invalidateWidgetCaches(c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await bulkDeleteWidgets(db, [id], true);
    await invalidateWidgetCaches(c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(restoreWidgetRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await restoreWidgets(db, [id]);
    await invalidateWidgetCaches(c);
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
        200: {
            description: "Widget status toggled",
            content: { "application/json": { schema: successEnvelope(widgetSchema) } },
        },
        ...errorResponses,
    }
});

app.openapi(toggleStatusRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const widget = await getWidgetById(db, id);
    if (!widget) throw new NotFoundError("Widget not found");
    const result = await updateWidget(db, id, { isActive: !widget.isActive });
    await invalidateWidgetCaches(c);
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
        200: {
            description: "Widget history entries",
            content: { "application/json": { schema: successEnvelope(z.array(widgetHistoryEntrySchema)) } },
        },
        ...errorResponses,
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
        201: {
            description: "History entry created",
            content: { "application/json": { schema: successEnvelope(widgetHistoryEntrySchema) } },
        },
        ...errorResponses,
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
        200: {
            description: "Widget restored from history",
            content: { "application/json": { schema: messageResponse } },
        },
        ...errorResponses,
    }
});

app.openapi(restoreHistoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { historyId } = c.req.valid("json");
    const result = await restoreFromHistory(db, id, historyId);
    await invalidateWidgetCaches(c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(deleteHistoryRoute, async (c) => {
    const db = c.get("db");
    const { id, versionId } = c.req.valid("param");
    await deleteHistoryEntry(db, id, versionId);
    return noContent(c);
});

export { app as adminWidgetRoutes };
