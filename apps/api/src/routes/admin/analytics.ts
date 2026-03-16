// src/server/routes/admin/analytics.ts
// Admin OpenAPI routes for analytics scripts.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AnalyticsService, createAnalyticsSchema, updateAnalyticsSchema, toggleAnalyticsSchema } from "@scalius/core/modules/analytics";
import { NotFoundError, ValidationError } from "../../utils/api-error";

import { ok, created } from "../../utils/api-response";
const app = new OpenAPIHono();

// ── List Analytics Scripts ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Analytics"],
    summary: "List all analytics scripts",
    responses: {
        200: { description: "Analytics script list"  }
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const scripts = await AnalyticsService.listScripts(db);
    return ok(c, scripts);
});

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
        201: { description: "Script created"  }
    }
});

app.openapi(createScriptRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const result = await AnalyticsService.createScript(db, data);
    return created(c, result);
});

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
        200: { description: "Script details"  }
    }
});

app.openapi(getByIdRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const script = await AnalyticsService.getScript(db, id);
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
        200: { description: "Script updated"  }
    }
});

app.openapi(updateScriptRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");

    if (data.id && data.id !== id) {
        throw new ValidationError("ID mismatch");
    }

    const updated = await AnalyticsService.updateScript(db, id, data);
    if (!updated) throw new NotFoundError("Analytics script not found");
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
        200: { description: "Script deleted"  }
    }
});

app.openapi(deleteScriptRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const deleted = await AnalyticsService.deleteScript(db, id);
    if (!deleted) throw new NotFoundError("Analytics script not found");
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
        200: { description: "Script toggled"  }
    }
});

app.openapi(toggleScriptRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    const toggled = await AnalyticsService.toggleScript(db, id, data.isActive);
    if (!toggled) throw new NotFoundError("Analytics script not found");
    return ok(c, {
        message: `Analytics script ${data.isActive ? "activated" : "deactivated"}`,
        script: toggled
    });
});

export { app as adminAnalyticsRoutes };
