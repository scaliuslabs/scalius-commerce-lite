// src/server/routes/admin/analytics.ts
// Admin OpenAPI routes for analytics scripts.

import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import { listAnalyticsScripts, getAnalyticsScript, createAnalyticsScript, updateAnalyticsScript, deleteAnalyticsScript, toggleAnalyticsScript, createAnalyticsSchema, updateAnalyticsSchema, toggleAnalyticsSchema } from "@scalius/core/modules/analytics";
import { NotFoundError, ValidationError } from "../../utils/api-error";

import { ok, created } from "../../utils/api-response";
import { successEnvelope, errorResponses } from "../../schemas/responses";
import { invalidateApiAndScheduleStorefrontGroups } from "../../utils/cache-invalidation";
const app = new OpenAPIHono<{ Bindings: Env }>();
const LAYOUT_CACHE_GROUPS = ["layout"] as const;

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AdminRouteContext<R extends RouteConfig> = Parameters<AdminRouteHandler<R>>[0];

// ── List Analytics Scripts ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Analytics"],
    summary: "List all analytics scripts",
    responses: {
        200: { description: "Analytics script list", content: { "application/json": { schema: successEnvelope(z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), config: z.string(), isActive: z.boolean(), usePartytown: z.boolean(), location: z.string(), createdAt: z.union([z.string(), z.number()]), updatedAt: z.union([z.string(), z.number()]) }).passthrough().nullable())) } } },
        ...errorResponses,
    }
});

app.openapi(listRoute, (async (c: AdminRouteContext<typeof listRoute>) => {
    const db = c.get("db");
    const scripts = await listAnalyticsScripts(db);
    return ok(c, scripts);
}) as unknown as AdminRouteHandler<typeof listRoute>);

// ── Create Analytics Script ──

const createScriptRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Analytics"],
    summary: "Create an analytics script",
    request: {
        body: { content: { "application/json": { schema: createAnalyticsSchema } } }
    },
    responses: {
        201: { description: "Script created", content: { "application/json": { schema: successEnvelope(z.object({ id: z.string(), name: z.string(), type: z.string(), isActive: z.boolean() }).passthrough()) } } },
        ...errorResponses,
    }
});

app.openapi(createScriptRoute, (async (c: AdminRouteContext<typeof createScriptRoute>) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const result = await createAnalyticsScript(db, data);
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    return created(c, result);
}) as unknown as AdminRouteHandler<typeof createScriptRoute>);

// ── Get Analytics Script ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Analytics"],
    summary: "Get an analytics script by ID",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Script details", content: { "application/json": { schema: successEnvelope(z.object({ id: z.string(), name: z.string(), type: z.string(), config: z.string(), isActive: z.boolean(), usePartytown: z.boolean(), location: z.string() }).passthrough()) } } },
        ...errorResponses,
    }
});

app.openapi(getByIdRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const script = await getAnalyticsScript(db, id);
    if (!script) throw new NotFoundError("Analytics script not found");
    return ok(c, script);
});

// ── Update Analytics Script ──

const updateScriptRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Analytics"],
    summary: "Update an analytics script",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateAnalyticsSchema } } }
    },
    responses: {
        200: { description: "Script updated", content: { "application/json": { schema: successEnvelope(z.object({ script: z.object({ id: z.string(), name: z.string(), type: z.string(), isActive: z.boolean() }).passthrough() })) } } },
        ...errorResponses,
    }
});

app.openapi(updateScriptRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");

    if (data.id && data.id !== id) {
        throw new ValidationError("ID mismatch");
    }

    const updated = await updateAnalyticsScript(db, id, data);
    if (!updated) throw new NotFoundError("Analytics script not found");
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    return ok(c, { script: updated });
});

// ── Delete Analytics Script ──

const deleteScriptRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Analytics"],
    summary: "Delete an analytics script",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Script deleted", content: { "application/json": { schema: successEnvelope(z.object({ message: z.string(), deletedScript: z.object({ id: z.string() }).passthrough() })) } } },
        ...errorResponses,
    }
});

app.openapi(deleteScriptRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const deleted = await deleteAnalyticsScript(db, id);
    if (!deleted) throw new NotFoundError("Analytics script not found");
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    return ok(c, { message: "Analytics script deleted", deletedScript: deleted });
});

// ── Toggle Analytics Script ──

const toggleScriptRoute = createRoute({
    method: "post",
    path: "/{id}/toggle",
    tags: ["Admin - Analytics"],
    summary: "Toggle an analytics script active status",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: toggleAnalyticsSchema } } }
    },
    responses: {
        200: { description: "Script toggled", content: { "application/json": { schema: successEnvelope(z.object({ message: z.string(), script: z.object({ id: z.string(), isActive: z.boolean() }).passthrough() })) } } },
        ...errorResponses,
    }
});

app.openapi(toggleScriptRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    const toggled = await toggleAnalyticsScript(db, id, data.isActive);
    if (!toggled) throw new NotFoundError("Analytics script not found");
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    return ok(c, {
        message: `Analytics script ${data.isActive ? "activated" : "deactivated"}`,
        script: toggled
    });
});

export { app as adminAnalyticsRoutes };
