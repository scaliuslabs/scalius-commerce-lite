import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    analyticsProviderHealthBrowserStatuses,
    analyticsProviderHealthServerStatuses,
    createAnalyticsScript,
    deleteAnalyticsScript,
    getAnalyticsProviderHealth,
    getAnalyticsScript,
    getTrackingHealth,
    sendTrackingTestEvent,
    listAnalyticsScripts,
    permanentlyDeleteAnalyticsScript,
    restoreAnalyticsScript,
    toggleAnalyticsScript,
    updateAnalyticsScript,
} from "@scalius/core/modules/analytics";
import {
    analyticsRevisionSchema,
    analyticsScriptTypes,
    createAnalyticsSchema,
    toggleAnalyticsSchema,
    updateAnalyticsSchema,
} from "@scalius/core/modules/analytics/browser";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { NotFoundError, ValidationError } from "../../utils/api-error";
import { created, ok } from "../../utils/api-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import {
    conflictResponse,
    errorResponses,
    paginatedEnvelope,
    successEnvelope,
} from "../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const timestampSchema = z.string().nullable();
const analyticsSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    isActive: z.boolean(),
    usePartytown: z.boolean(),
    location: z.string(),
    revision: z.number().int().min(1),
    identifier: z.string().nullable(),
    readiness: z.string(),
    configIssue: z.string().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: timestampSchema,
});

const analyticsDetailSchema = analyticsSummarySchema.omit({
    identifier: true,
    readiness: true,
    configIssue: true,
}).extend({ config: z.string() });

const listRoute = createRoute({
    method: "get",
    path: "/",
    operationId: "dashboard.analytics.list",
    tags: ["Admin - Analytics"],
    summary: "List analytics scripts without executable source",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1),
            limit: z.coerce.number().int().min(1).max(100).default(20),
            search: z.string().max(100).optional().default(""),
            type: z.enum(analyticsScriptTypes).optional(),
            status: z.enum(["active", "inactive"]).optional(),
            trashed: z.enum(["true", "false"]).optional(),
            sort: z.enum(["name", "type", "createdAt", "updatedAt"]).default("updatedAt"),
            order: z.enum(["asc", "desc"]).default("desc"),
        }),
    },
    responses: {
        200: {
            description: "Paginated safe analytics summaries",
            content: {
                "application/json": {
                    schema: paginatedEnvelope("scripts", analyticsSummarySchema),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(listRoute, async (c) => {
    const query = c.req.valid("query");
    return ok(c, await listAnalyticsScripts(c.get("db"), {
        ...query,
        showTrashed: query.trashed === "true",
    }));
});

const createRouteDefinition = createRoute({
    method: "post",
    path: "/",
    operationId: "dashboard.analytics.create",
    tags: ["Admin - Analytics"],
    summary: "Create an inactive analytics draft",
    request: { body: { content: { "application/json": { schema: createAnalyticsSchema } } } },
    responses: {
        201: {
            description: "Analytics script created",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        id: z.string(),
                        revision: z.number().int().min(1),
                        script: analyticsDetailSchema.nullable(),
                    })),
                },
            },
        },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(createRouteDefinition, async (c) => {
    const result = await createAnalyticsScript(c.get("db"), c.req.valid("json"), {
        canToggle: c.get("adminPermissions").has(PERMISSIONS.ANALYTICS_TOGGLE),
    });

    return created(c, result);
});

const providerHealthBrowserSchema = z.object({
    status: z.enum(analyticsProviderHealthBrowserStatuses),
    configured: z.boolean(),
    activeScriptCount: z.number().int().nonnegative(),
    readyScriptCount: z.number().int().nonnegative(),
    draftScriptCount: z.number().int().nonnegative(),
    blockedScriptCount: z.number().int().nonnegative(),
    message: z.string(),
    issues: z.array(z.string()),
});
const providerHealthServerSchema = z.object({
    status: z.enum(analyticsProviderHealthServerStatuses),
    configured: z.boolean(),
    label: z.string(),
    message: z.string(),
});

const providerHealthRoute = createRoute({
    method: "get",
    path: "/health",
    operationId: "dashboard.analytics.health",
    tags: ["Admin - Analytics"],
    summary: "Get analytics provider readiness without provider calls",
    description: "Check analytics health, operational status, configuration issues, and provider readiness.",
    responses: {
        200: {
            description: "Analytics provider health",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        summary: z.object({
                            totalProviders: z.number().int().nonnegative(),
                            browserReadyProviders: z.number().int().nonnegative(),
                            draftProviders: z.number().int().nonnegative(),
                            blockedProviders: z.number().int().nonnegative(),
                            notConfiguredProviders: z.number().int().nonnegative(),
                            serverReadyProviders: z.number().int().nonnegative(),
                        }),
                        providers: z.array(z.object({
                            provider: z.enum(analyticsScriptTypes),
                            label: z.string(),
                            browser: providerHealthBrowserSchema,
                            serverSide: providerHealthServerSchema,
                        })),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(providerHealthRoute, async (c) => ok(c, await getAnalyticsProviderHealth(
    c.get("db"),
    { credentialEncryptionKey: c.env.CREDENTIAL_ENCRYPTION_KEY },
)));

// ── Server tracking (audit spec S4) ──

const deliveryCountsSchema = z.object({
    sent: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
});

const trackingHealthSchema = z.object({
    windowHours: z.number().int().positive(),
    since: z.string(),
    consent: z.object({
        otherRegions: z.string(),
        orders: z.number().int().nonnegative(),
        analyticsGranted: z.number().int().nonnegative(),
        marketingGranted: z.number().int().nonnegative(),
        saleOfDataGranted: z.number().int().nonnegative(),
        bySource: z.object({ banner: z.number().int(), default: z.number().int(), gpc: z.number().int() }),
    }),
    matchSignalCoverage: z.object({
        orders: z.number().int().nonnegative(),
        percent: z.record(z.string(), z.number()),
    }),
    destinations: z.array(z.object({
        destination: z.enum(["meta", "ga4", "tiktok"]),
        configured: z.boolean(),
        testMode: z.boolean(),
        events: z.array(deliveryCountsSchema.extend({ event: z.string() })),
        skippedByConsent: z.number().int().nonnegative(),
        matchSignals: z.record(z.string(), z.number().int().nonnegative()),
        lastError: z.object({ at: z.string(), message: z.string() }).nullable(),
    })),
});

const trackingHealthRoute = createRoute({
    method: "get",
    path: "/tracking-health",
    operationId: "dashboard.analytics.tracking_health",
    tags: ["Admin - Analytics"],
    summary: "Get server tracking health for the last 24 hours",
    description: "Per destination (Meta CAPI, GA4 Measurement Protocol, TikTok Events API): configuration, test mode, server events sent, failed, skipped and pending, purchases skipped by consent, match-signal counts and the latest error; across orders: consent outcomes and match-signal coverage (percent of orders carrying em, ph, fbp, fbc, ip, ua, ttp, ttclid and GA ids). Counts only: no identifier or contact data.",
    responses: {
        200: { description: "Tracking health", content: { "application/json": { schema: successEnvelope(trackingHealthSchema) } } },
        ...errorResponses,
    },
});

app.openapi(trackingHealthRoute, async (c) => ok(c, await getTrackingHealth(c.get("db"), {
    encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
})));

const testEventRoute = createRoute({
    method: "post",
    path: "/test-event",
    operationId: "dashboard.analytics.send_test_event",
    tags: ["Admin - Analytics"],
    summary: "Send one test event to a tracking destination",
    description: "Meta and TikTok send a ViewContent under their saved test event code (409 without one), so it shows in Events Manager > Test events and never in live data. GA4 sends a sample purchase to the Measurement Protocol validation server and returns its validation messages (nothing is recorded).",
    request: {
        body: {
            required: true,
            content: { "application/json": { schema: z.object({ destination: z.enum(["meta", "ga4", "tiktok"]) }).strict() } },
        },
    },
    responses: {
        200: {
            description: "The provider's answer",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        destination: z.enum(["meta", "ga4", "tiktok"]),
                        accepted: z.boolean(),
                        mode: z.enum(["test_event_code", "ga4_validation"]),
                        eventId: z.string(),
                        details: z.record(z.string(), z.unknown()),
                    })),
                },
            },
        },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(testEventRoute, async (c) => ok(c, await sendTrackingTestEvent(c.get("db"), c.req.valid("json").destination, {
    encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
    storefrontUrl: c.env.STOREFRONT_URL,
})));

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}/source",
    operationId: "dashboard.analytics.get",
    tags: ["Admin - Analytics"],
    summary: "Get analytics script source for the editor",
    request: { params: z.object({ id: z.string() }) },
    responses: {
        200: {
            description: "Analytics script detail",
            content: { "application/json": { schema: successEnvelope(analyticsDetailSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(getByIdRoute, async (c) => {
    const script = await getAnalyticsScript(c.get("db"), c.req.valid("param").id);
    if (!script) throw new NotFoundError("Analytics script not found");
    return ok(c, script);
});

const updateRoute = createRoute({
    method: "put",
    path: "/{id}",
    operationId: "dashboard.analytics.update",
    tags: ["Admin - Analytics"],
    summary: "Update an analytics script with optimistic concurrency",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateAnalyticsSchema } } },
    },
    responses: {
        200: {
            description: "Analytics script updated",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({ script: analyticsDetailSchema })),
                },
            },
        },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(updateRoute, async (c) => {
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    if (data.id !== id) throw new ValidationError("ID mismatch");
    const script = await updateAnalyticsScript(c.get("db"), id, data, {
        canToggle: c.get("adminPermissions").has(PERMISSIONS.ANALYTICS_TOGGLE),
    });
    if (!script) throw new NotFoundError("Analytics script not found");

    return ok(c, { script });
});

const toggleRoute = createRoute({
    method: "post",
    path: "/{id}/toggle",
    operationId: "dashboard.analytics.set_active",
    tags: ["Admin - Analytics"],
    summary: "Activate or deactivate an analytics script with revision protection",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: toggleAnalyticsSchema } } },
    },
    responses: {
        200: {
            description: "Analytics script status updated",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({ message: z.string(), script: analyticsDetailSchema })),
                },
            },
        },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(toggleRoute, async (c) => {
    const data = c.req.valid("json");
    const script = await toggleAnalyticsScript(c.get("db"), c.req.valid("param").id, data);
    if (!script) throw new NotFoundError("Analytics script not found");

    return ok(c, {
        message: `Analytics script ${data.isActive ? "activated" : "deactivated"}`,
        script,
    });
});

const trashRoute = createRoute({
    method: "delete",
    path: "/{id}",
    operationId: "dashboard.analytics.trash",
    tags: ["Admin - Analytics"],
    summary: "Move an analytics script to trash",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: analyticsRevisionSchema } } },
    },
    responses: {
        200: {
            description: "Analytics script moved to trash",
            content: { "application/json": { schema: successEnvelope(analyticsSummarySchema) } },
        },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(trashRoute, async (c) => {
    const result = await deleteAnalyticsScript(
        c.get("db"),
        c.req.valid("param").id,
        c.req.valid("json").expectedRevision,
    );

    return ok(c, result);
});

const restoreRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    operationId: "dashboard.analytics.restore",
    tags: ["Admin - Analytics"],
    summary: "Restore an analytics script as inactive",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: analyticsRevisionSchema } } },
    },
    responses: {
        200: {
            description: "Analytics script restored",
            content: { "application/json": { schema: successEnvelope(analyticsSummarySchema) } },
        },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(restoreRoute, async (c) => {
    const result = await restoreAnalyticsScript(
        c.get("db"),
        c.req.valid("param").id,
        c.req.valid("json").expectedRevision,
    );

    return ok(c, result);
});

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    operationId: "dashboard.analytics.delete_permanently",
    tags: ["Admin - Analytics"],
    summary: "Permanently delete a trashed analytics script",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: analyticsRevisionSchema } } },
    },
    responses: {
        200: {
            description: "Analytics script permanently deleted",
            content: { "application/json": { schema: successEnvelope(z.object({ id: z.string() })) } },
        },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(permanentDeleteRoute, async (c) => {
    const result = await permanentlyDeleteAnalyticsScript(
        c.get("db"),
        c.req.valid("param").id,
        c.req.valid("json").expectedRevision,
    );

    return ok(c, result);
});

export { app as adminAnalyticsRoutes };
