// src/server/routes/admin/widgets.ts
// Admin OpenAPI routes for widgets.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    listWidgets,
    listWidgetPlacementTargets,
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
    getWidgetCacheSubjects,
    type WidgetCacheSubject,
} from "@scalius/core/modules/widgets";
import { NotFoundError } from "../../utils/api-error";
import {
    successEnvelope,
    messageResponse,
    noContentResponse,
    errorResponses,
} from "../../schemas/responses";
import { widgetPlacementSchema, widgetSchema } from "../../schemas/entities";
import {
    invalidateApiCachePatterns,
    collectCmsShortcodePageInvalidation,
    getOptionalExecutionContext,
    resolveCmsShortcodePageTargets,
    triggerStorefrontPurgeForPrefixes,
} from "../../utils/cache-invalidation";
import type { Database } from "@scalius/database/client";

import { ok, created, noContent } from "../../utils/api-response";

// Widget list item — uses casted timestamps from the list query
const widgetListItemSchema = z.object({
    id: z.string(),
    name: z.string(),
    htmlContent: z.string(),
    cssContent: z.string().nullable(),
    jsContent: z.string().nullable(),
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
});

const collectionSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    sortOrder: z.number(),
    type: z.string(),
});

const pageSummarySchema = z.object({
    id: z.string(),
    title: z.string(),
    slug: z.string(),
    sortOrder: z.number(),
});

const referencedProductSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
});

const referencedCategorySummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
});

const placementTargetTypeSchema = z.enum(["page", "product", "category", "collection"]);

const placementTargetSchema = z.object({
    id: z.string(),
    label: z.string(),
    description: z.string().nullable(),
    type: placementTargetTypeSchema,
});

const widgetHistoryEntrySchema = z.object({
    id: z.string(),
    widgetId: z.string(),
    htmlContent: z.string(),
    cssContent: z.string().nullable(),
    jsContent: z.string().nullable(),
    reason: z.string(),
    createdAt: z.union([z.string(), z.number()]),
});

const app = new OpenAPIHono<{ Bindings: Env }>();

function isPublicWidgetSubject(subject: WidgetCacheSubject): boolean {
    return subject.isActive && subject.deletedAt == null;
}

function isLivePlacement(placement: WidgetCacheSubject["placements"][number]): boolean {
    return placement.isActive && placement.deletedAt == null;
}

function collectWidgetCacheInvalidation(subjects: WidgetCacheSubject[]) {
    const apiPatterns = new Set<string>();
    const storefrontPrefixes = new Set<string>();
    const htmlPaths = new Set<string>();
    let warmHomepage = false;

    for (const subject of subjects) {
        if (!isPublicWidgetSubject(subject)) continue;

        apiPatterns.add(`api:widgets:single:/api/v1/widgets/${subject.id}*`);
        storefrontPrefixes.add(`widget_${subject.id}`);

        for (const placement of subject.placements.filter(isLivePlacement)) {
            if (placement.scope === "homepage") {
                apiPatterns.add("api:widgets:active-homepage:*");
                apiPatterns.add("api:storefront:homepage:*");
                storefrontPrefixes.add("global_homepage_widgets");
                storefrontPrefixes.add("widgets_scope_homepage_global");
                storefrontPrefixes.add("storefront_homepage_");
                warmHomepage = true;
                continue;
            }

            if (!placement.scopeId) continue;
            storefrontPrefixes.add(`widgets_scope_${placement.scope}_${placement.scopeId}`);

            if (placement.scope === "page" && placement.targetSlug) {
                apiPatterns.add(
                    `api:storefront:page:/api/v1/storefront/pages/slug/${placement.targetSlug}*`,
                );
                storefrontPrefixes.add(`page_render_${placement.targetSlug}_`);
                htmlPaths.add(`/${placement.targetSlug}`);
            } else if (placement.scope === "product" && placement.targetSlug) {
                htmlPaths.add(`/products/${placement.targetSlug}`);
            } else if (placement.scope === "category" && placement.targetSlug) {
                htmlPaths.add(`/categories/${placement.targetSlug}`);
            } else if (placement.scope === "collection") {
                htmlPaths.add(`/collections/${placement.scopeId}`);
            }
        }
    }

    return {
        apiPatterns: [...apiPatterns],
        storefrontPrefixes: [...storefrontPrefixes],
        htmlPaths: [...htmlPaths],
        warmHomepage,
    };
}

async function invalidateWidgetCaches(
    db: Database,
    c: { env: Env; executionCtx?: ExecutionContext },
    subjects: WidgetCacheSubject[],
): Promise<void> {
    const widgetIds = [
        ...new Set(
            subjects
                .filter(isPublicWidgetSubject)
                .map((subject) => subject.id)
                .filter(Boolean),
        ),
    ];
    let shortcodeScanFailed = false;
    const shortcodeTargets = widgetIds.length > 0
        ? await resolveCmsShortcodePageTargets(db, { widgetIds }).catch((error) => {
            console.error("[Cache] Failed to resolve widget shortcode pages:", error);
            shortcodeScanFailed = true;
            return [];
        })
        : [];
    const shortcodeInvalidation = collectCmsShortcodePageInvalidation(shortcodeTargets);
    const placementInvalidation =
        collectWidgetCacheInvalidation(subjects);
    const apiPatterns = [
        ...placementInvalidation.apiPatterns,
        ...shortcodeInvalidation.apiPatterns,
    ];
    const storefrontPrefixes = [
        ...placementInvalidation.storefrontPrefixes,
        ...shortcodeInvalidation.storefrontPrefixes,
    ];
    const htmlPaths = [
        ...placementInvalidation.htmlPaths,
        ...shortcodeInvalidation.storefrontHtmlPaths,
    ];
    const bumpVersion =
        placementInvalidation.warmHomepage
        || shortcodeInvalidation.bumpVersion
        || shortcodeScanFailed;
    if (apiPatterns.length > 0) {
        await invalidateApiCachePatterns(apiPatterns, c.env?.CACHE);
    }
    if (storefrontPrefixes.length > 0 || htmlPaths.length > 0 || bumpVersion) {
        triggerStorefrontPurgeForPrefixes(
            storefrontPrefixes,
            c.env,
            {
                groups: ["widgets"],
                bumpVersion,
                ...(htmlPaths.length > 0 ? { htmlPaths } : {}),
            },
            getOptionalExecutionContext(c),
        );
    }
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
                        referencedProducts: z.array(referencedProductSummarySchema).optional(),
                        referencedCategories: z.array(referencedCategorySummarySchema).optional(),
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

// ── Placement Targets ──

const placementTargetsRoute = createRoute({
    method: "get",
    path: "/placement-targets",
    tags: ["Admin - Widgets"],
    summary: "Search widget placement targets",
    request: {
        query: z.object({
            type: placementTargetTypeSchema,
            search: z.string().optional().openapi({ description: "Target search term" }),
            ids: z.string().optional().openapi({ description: "Comma-separated selected IDs to hydrate" }),
            limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
    },
    responses: {
        200: {
            description: "Widget placement target options",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        targets: z.array(placementTargetSchema),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(placementTargetsRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const selectedIds = query.ids
        ? query.ids.split(",").map((id) => id.trim()).filter(Boolean)
        : [];
    const targets = await listWidgetPlacementTargets(db, {
        targetType: query.type,
        search: query.search,
        selectedIds,
        limit: query.limit,
    });
    return ok(c, { targets });
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
    const subjects = await getWidgetCacheSubjects(db, [widget.id]);
    await invalidateWidgetCaches(db, c, subjects);
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
    const before = await getWidgetCacheSubjects(db, ids, { includeDeleted: true });
    await bulkDeleteWidgets(db, ids, permanent);
    await invalidateWidgetCaches(db, c, before);
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
    const { ids } = c.req.valid("json");
    await bulkActivateWidgets(db, ids);
    const after = await getWidgetCacheSubjects(db, ids);
    await invalidateWidgetCaches(db, c, after);
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
    const { ids } = c.req.valid("json");
    const before = await getWidgetCacheSubjects(db, ids);
    await bulkDeactivateWidgets(db, ids);
    await invalidateWidgetCaches(db, c, before);
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
    const { ids } = c.req.valid("json");
    await restoreWidgets(db, ids);
    const after = await getWidgetCacheSubjects(db, ids);
    await invalidateWidgetCaches(db, c, after);
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
    const before = await getWidgetCacheSubjects(db, [id], { includeDeleted: true });
    const result = await updateWidget(db, id, c.req.valid("json"));
    const after = await getWidgetCacheSubjects(db, [id]);
    await invalidateWidgetCaches(db, c, [...before, ...after]);
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
    const before = await getWidgetCacheSubjects(db, [id]);
    await deleteWidget(db, id);
    await invalidateWidgetCaches(db, c, before);
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
    const before = await getWidgetCacheSubjects(db, [id], { includeDeleted: true });
    await bulkDeleteWidgets(db, [id], true);
    await invalidateWidgetCaches(db, c, before);
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
    const after = await getWidgetCacheSubjects(db, [id]);
    await invalidateWidgetCaches(db, c, after);
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
    const before = await getWidgetCacheSubjects(db, [id]);
    const widget = await getWidgetById(db, id);
    if (!widget) throw new NotFoundError("Widget not found");
    const result = await updateWidget(db, id, { isActive: !widget.isActive });
    const after = await getWidgetCacheSubjects(db, [id]);
    await invalidateWidgetCaches(db, c, [...before, ...after]);
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
                    schema: z.object({
                        reason: z.string().optional().default("Manual save"),
                        htmlContent: z.string().optional(),
                        cssContent: z.string().nullable().optional(),
                        jsContent: z.string().nullable().optional(),
                    })
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
    const { reason, htmlContent, cssContent, jsContent } = c.req.valid("json");
    const entry = await createHistoryEntry(db, id, reason, { htmlContent, cssContent, jsContent });
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
    const before = await getWidgetCacheSubjects(db, [id]);
    const result = await restoreFromHistory(db, id, historyId);
    await invalidateWidgetCaches(db, c, before);
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
