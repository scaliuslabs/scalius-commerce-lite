import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import { metaConversionsSettings, metaConversionsLogs } from "@scalius/database/schema";
import { eq, desc, count } from "drizzle-orm";
import { manualLogCleanup } from "@scalius/core/modules/analytics/meta.service";
import {
    buildUnavailableMetaPixelParityDiagnostics,
    getMetaPixelParityDiagnostics,
    metaPixelParityStatuses,
} from "@scalius/core/modules/analytics";
import { encryptCredentials } from "@scalius/core/utils/credential-encryption";

import { ok, created } from "../../../utils/api-response";
import { ValidationError } from "../../../utils/api-error";
import { successEnvelope, messageResponse, errorResponses, serviceUnavailableResponse } from "../../../schemas/responses";
import { invalidateApiAndScheduleStorefrontGroups } from "../../../utils/cache-invalidation";
import { requireEncryptionKey } from "../../../utils/encryption-key";
import { META_CAPI_BROWSER_CIRCUIT_KEY } from "../../meta-conversions";
const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED_VALUE = "••••••••••••";
const LAYOUT_CACHE_GROUPS = ["layout"] as const;
const PLACEHOLDER_CREDENTIALS = new Set([
    "dummy",
    "test",
    "example",
    "placeholder",
    "123456",
    "pixel123",
    "accesstoken",
    "badtoken",
    "token",
    "xxxx",
]);
type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AppRouteContext<R extends RouteConfig> = Parameters<AppRouteHandler<R>>[0];

function normalizedPlaceholderCandidate(value: string): string {
    return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function isPlaceholderCredential(value: string): boolean {
    const normalized = normalizedPlaceholderCandidate(value);
    return PLACEHOLDER_CREDENTIALS.has(normalized) || /^x{4,}$/.test(normalized);
}

function optionalTrimmedValue(value: string | undefined): string | null {
    const trimmed = value?.trim() ?? "";
    return trimmed ? trimmed : null;
}

function validateConcreteCredential(fieldLabel: string, value: string | null): void {
    if (value && isPlaceholderCredential(value)) {
        throw new ValidationError(`${fieldLabel} looks like a dummy or placeholder value. Use the real value from Meta Events Manager.`);
    }
}

function timestampForClient(value: Date | number | null): string | number | null {
    return value instanceof Date ? value.toISOString() : value;
}

const SAFE_LOG_PAYLOAD_UNAVAILABLE = JSON.stringify({ available: false });

function summarizeStoredRequestPayload(payload: string | null): string | null {
    if (!payload) {
        return payload;
    }

    try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        if (!Array.isArray(parsed.data)) {
            const eventCount = typeof parsed.eventCount === "number"
                && Number.isInteger(parsed.eventCount)
                && parsed.eventCount >= 0
                ? parsed.eventCount
                : null;
            if (eventCount === null || !Array.isArray(parsed.events)) {
                return SAFE_LOG_PAYLOAD_UNAVAILABLE;
            }

            return JSON.stringify({
                eventCount,
                events: parsed.events.slice(0, 20).map((event) => {
                    if (!event || typeof event !== "object") return { eventName: "unknown" };
                    const row = event as Record<string, unknown>;
                    return {
                        eventName: typeof row.eventName === "string"
                            ? row.eventName.slice(0, 100)
                            : "unknown",
                        actionSource: typeof row.actionSource === "string"
                            ? row.actionSource.slice(0, 50)
                            : null,
                    };
                }),
                truncated: parsed.truncated === true || eventCount > 20,
            });
        }

        return JSON.stringify({
            eventCount: parsed.data.length,
            events: parsed.data.slice(0, 20).map((event) => {
                if (!event || typeof event !== "object") return { eventName: "unknown" };
                const row = event as Record<string, unknown>;
                return {
                    eventName: typeof row.event_name === "string"
                        ? row.event_name.slice(0, 100)
                        : "unknown",
                    actionSource: typeof row.action_source === "string"
                        ? row.action_source.slice(0, 50)
                        : null,
                };
            }),
            truncated: parsed.data.length > 20,
        });
    } catch {
        return SAFE_LOG_PAYLOAD_UNAVAILABLE;
    }
}

function summarizeStoredResponsePayload(payload: string | null): string | null {
    if (!payload) {
        return payload;
    }

    try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        const rawEventsReceived = parsed.events_received ?? parsed.eventsReceived;
        const eventsReceived = typeof rawEventsReceived === "number"
            ? rawEventsReceived
            : Number.NaN;
        const error = parsed.error && typeof parsed.error === "object"
            ? parsed.error as Record<string, unknown>
            : null;
        const storedHasError = parsed.hasError === true;
        const storedErrorType = typeof parsed.errorType === "string"
            ? parsed.errorType.slice(0, 100)
            : null;
        const storedErrorCode = typeof parsed.errorCode === "number"
            && Number.isFinite(parsed.errorCode)
            ? Math.trunc(parsed.errorCode)
            : null;
        return JSON.stringify({
            eventsReceived: Number.isFinite(eventsReceived)
                ? Math.max(0, Math.trunc(eventsReceived))
                : null,
            hasError: Boolean(error) || storedHasError,
            errorType: typeof error?.type === "string" ? error.type.slice(0, 100) : storedErrorType,
            errorCode: typeof error?.code === "number" && Number.isFinite(error.code)
                ? Math.trunc(error.code)
                : storedErrorCode,
        });
    } catch {
        return SAFE_LOG_PAYLOAD_UNAVAILABLE;
    }
}

const metaConversionsSettingsSchema = z.object({
    pixelId: z.string().max(100).optional(),
    accessToken: z.string().max(4096).optional(),
    testEventCode: z.string().max(200).optional(),
    isEnabled: z.boolean().optional(),
    logRetentionDays: z.number().int().min(1).max(365).optional()
});

// ── Get Settings ──

const metaConversionsSettingsResponseSchema = z.object({
    id: z.string(),
    pixelId: z.string().nullable(),
    accessToken: z.string().nullable(),
    testEventCode: z.string().nullable(),
    isEnabled: z.boolean(),
    logRetentionDays: z.number(),
    createdAt: z.union([z.string(), z.number()]).nullable(),
    updatedAt: z.union([z.string(), z.number()]).nullable(),
});

const metaPixelParityResponseSchema = z.object({
    status: z.enum(metaPixelParityStatuses),
    severity: z.enum(["neutral", "success", "warning"]),
    message: z.string(),
    capiPixelId: z.string().nullable(),
    activeBrowserPixelIds: z.array(z.string()),
    activeFacebookPixelScriptCount: z.number().int().nonnegative(),
    parseableFacebookPixelScriptCount: z.number().int().nonnegative(),
});

const getSettingsRoute = createRoute({
    method: "get",
    path: "/",
    operationId: "dashboard.meta_conversions.get",
    tags: ["Admin - Meta Conversions"],
    summary: "Get Meta Conversions API settings",
    responses: {
        200: { description: "Settings", content: { "application/json": { schema: successEnvelope(z.object({
            settings: metaConversionsSettingsResponseSchema.nullable(),
            pixelParity: metaPixelParityResponseSchema,
        })) } } },
        ...errorResponses,
    }
});

app.openapi(getSettingsRoute, (async (c) => {
    const db = c.get("db");
    const settings = await db.select().from(metaConversionsSettings).where(eq(metaConversionsSettings.id, "singleton")).get();
    const maskedSettings = settings ? {
        id: settings.id,
        pixelId: settings.pixelId,
        accessToken: settings.accessToken ? MASKED_VALUE : null,
        testEventCode: settings.testEventCode ? MASKED_VALUE : null,
        isEnabled: settings.isEnabled,
        logRetentionDays: settings.logRetentionDays,
        createdAt: timestampForClient(settings.createdAt),
        updatedAt: timestampForClient(settings.updatedAt),
    } : null;
    const pixelParity = await getMetaPixelParityDiagnostics(db, settings?.pixelId).catch((error: unknown) => {
        console.warn("Meta Pixel parity diagnostics unavailable", {
            error: error instanceof Error ? error.message : String(error),
        });
        return buildUnavailableMetaPixelParityDiagnostics(settings?.pixelId);
    });
    return ok(c, { settings: maskedSettings, pixelParity });
}) as AppRouteHandler<typeof getSettingsRoute>);

// ── Save Settings ──

const saveSettingsRoute = createRoute({
    method: "post",
    path: "/",
    operationId: "dashboard.meta_conversions.update",
    tags: ["Admin - Meta Conversions"],
    summary: "Save Meta Conversions API settings",
    request: { body: { content: { "application/json": { schema: metaConversionsSettingsSchema } } } },
    responses: {
        200: { description: "Settings saved", content: { "application/json": { schema: successEnvelope(metaConversionsSettingsResponseSchema) } } },
        201: { description: "Settings created", content: { "application/json": { schema: successEnvelope(metaConversionsSettingsResponseSchema) } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    }
});

async function clearMetaCapiBrowserCircuit(env: Env): Promise<void> {
    try {
        await env.CACHE?.delete(META_CAPI_BROWSER_CIRCUIT_KEY);
    } catch (error) {
        console.warn("Meta CAPI browser-event circuit could not be cleared", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

app.openapi(saveSettingsRoute, (async (c: AppRouteContext<typeof saveSettingsRoute>) => {
    const db = c.get("db");
    const validation = c.req.valid("json");
    const existingSettings = await db.select().from(metaConversionsSettings).where(eq(metaConversionsSettings.id, "singleton")).get();
    const pixelId = validation.pixelId === undefined
        ? existingSettings?.pixelId ?? null
        : optionalTrimmedValue(validation.pixelId);
    const isEnabled = validation.isEnabled ?? existingSettings?.isEnabled ?? false;
    const logRetentionDays = validation.logRetentionDays
        ?? existingSettings?.logRetentionDays
        ?? 30;
    const rawTestEventCode = validation.testEventCode;
    const trimmedTestEventCode = typeof rawTestEventCode === "string"
        ? rawTestEventCode.trim()
        : undefined;
    const isUsingMaskedTestEventCode = trimmedTestEventCode === MASKED_VALUE;
    const testEventCode = isUsingMaskedTestEventCode || rawTestEventCode === undefined
        ? existingSettings?.testEventCode ?? null
        : optionalTrimmedValue(rawTestEventCode);
    const rawAccessToken = validation.accessToken;
    const trimmedAccessToken = typeof rawAccessToken === "string" ? rawAccessToken.trim() : undefined;
    const hasStoredAccessToken = Boolean(existingSettings?.accessToken);
    const isUsingMaskedAccessToken = trimmedAccessToken === MASKED_VALUE;
    const hasEffectiveAccessToken = isUsingMaskedAccessToken || rawAccessToken === undefined
        ? hasStoredAccessToken
        : Boolean(trimmedAccessToken);
    let accessToken: string | null | undefined;

    validateConcreteCredential("Pixel ID", pixelId);
    validateConcreteCredential("access token", !isUsingMaskedAccessToken && trimmedAccessToken ? trimmedAccessToken : null);
    validateConcreteCredential(
        "test event code",
        !isUsingMaskedTestEventCode ? testEventCode : null,
    );

    if (isEnabled) {
        const missingFields = [
            pixelId ? null : "Pixel ID",
            hasEffectiveAccessToken ? null : "access token",
        ].filter((field): field is string => Boolean(field));
        if (missingFields.length > 0) {
            throw new ValidationError(
                `Meta Conversions API needs ${missingFields.join(" and ")} before it can be enabled. Use your Pixel ID and access token from Meta Events Manager, then test with a test event code.`,
            );
        }
    }

    if (isUsingMaskedAccessToken) {
        accessToken = existingSettings?.accessToken ?? null;
    } else if (typeof trimmedAccessToken === "string") {
        accessToken = trimmedAccessToken
            ? await encryptCredentials(
                trimmedAccessToken,
                requireEncryptionKey(c.env as unknown as Record<string, unknown>),
            )
            : null;
    }

    const now = new Date();
    const resultArr = existingSettings
        ? await db.update(metaConversionsSettings)
            .set({ pixelId, accessToken, testEventCode, isEnabled, logRetentionDays, updatedAt: now })
            .where(eq(metaConversionsSettings.id, "singleton")).returning()
        : await db.insert(metaConversionsSettings)
            .values({ id: "singleton", pixelId, accessToken: accessToken ?? null, testEventCode, isEnabled, logRetentionDays, createdAt: now, updatedAt: now })
            .returning();
    const result = resultArr[0];

    if (!result) throw new ValidationError("Failed to save settings");
    await clearMetaCapiBrowserCircuit(c.env);
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    const maskedResult = {
        id: result.id,
        pixelId: result.pixelId,
        accessToken: result.accessToken ? MASKED_VALUE : null,
        testEventCode: result.testEventCode ? MASKED_VALUE : null,
        isEnabled: result.isEnabled,
        logRetentionDays: result.logRetentionDays,
        createdAt: timestampForClient(result.createdAt),
        updatedAt: timestampForClient(result.updatedAt),
    };
    return existingSettings ? ok(c, maskedResult) : created(c, maskedResult);
}) as unknown as AppRouteHandler<typeof saveSettingsRoute>);

// ── Get Logs ──

const metaConversionsLogSchema = z.object({
    id: z.string(),
    eventId: z.string(),
    eventName: z.string().nullable(),
    status: z.string().nullable(),
    requestPayload: z.string().nullable(),
    responsePayload: z.string().nullable(),
    errorMessage: z.string().nullable(),
    eventTime: z.union([z.string(), z.number()]).nullable(),
    createdAt: z.union([z.string(), z.number()]).nullable(),
});

const getLogsRoute = createRoute({
    method: "get",
    path: "/logs",
    operationId: "dashboard.meta_conversions.logs_list",
    tags: ["Admin - Meta Conversions"],
    summary: "Get Meta Conversions API logs",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().int().min(1).max(20).default(20).openapi({ description: "Items per page" })
        })
    },
    responses: {
        200: { description: "Logs with pagination", content: { "application/json": { schema: successEnvelope(z.object({
            logs: z.array(metaConversionsLogSchema),
            pagination: z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() }),
            retention: z.object({ days: z.number(), hours: z.number() }),
        })) } } },
        ...errorResponses,
    }
});

app.openapi(getLogsRoute, (async (c: AppRouteContext<typeof getLogsRoute>) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const page = query.page;
    const limit = query.limit;
    const offset = (page - 1) * limit;

    const totalResult = await db.select({ count: count(metaConversionsLogs.id) }).from(metaConversionsLogs).get();
    const total = totalResult?.count ?? 0;
    const logs = await db.select().from(metaConversionsLogs).orderBy(desc(metaConversionsLogs.createdAt)).limit(limit).offset(offset).all();

    const settings = await db.select({ logRetentionDays: metaConversionsSettings.logRetentionDays }).from(metaConversionsSettings).where(eq(metaConversionsSettings.id, "singleton")).get();
    const retentionDays = settings?.logRetentionDays ?? 30;

    return ok(c, {
        logs: logs.map((log) => ({
            id: log.id,
            eventId: log.eventId,
            eventName: log.eventName,
            status: log.status,
            requestPayload: summarizeStoredRequestPayload(log.requestPayload),
            responsePayload: summarizeStoredResponsePayload(log.responsePayload),
            errorMessage: log.errorMessage
                ? "Meta delivery failed. Review the response summary and provider configuration."
                : null,
            eventTime: timestampForClient(log.eventTime),
            createdAt: timestampForClient(log.createdAt),
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        retention: { days: retentionDays, hours: retentionDays * 24 }
    });
}) as unknown as AppRouteHandler<typeof getLogsRoute>);

// ── Clear Logs ──

const clearLogsRoute = createRoute({
    method: "delete",
    path: "/logs",
    operationId: "dashboard.meta_conversions.logs_clear",
    tags: ["Admin - Meta Conversions"],
    summary: "Clear all Meta Conversions API logs",
    responses: {
        200: { description: "Logs cleared", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(clearLogsRoute, async (c) => {
    const db = c.get("db");
    await db.delete(metaConversionsLogs);
    return ok(c, { message: "All logs cleared" });
});

// ── Manual Log Cleanup ──

const manualCleanupRoute = createRoute({
    method: "post",
    path: "/logs",
    operationId: "dashboard.meta_conversions.logs_cleanup",
    tags: ["Admin - Meta Conversions"],
    summary: "Trigger manual log cleanup",
    responses: {
        200: { description: "Cleanup result", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(manualCleanupRoute, async (c) => {
    const db = c.get("db");
    const settings = await db.select({ logRetentionDays: metaConversionsSettings.logRetentionDays }).from(metaConversionsSettings).where(eq(metaConversionsSettings.id, "singleton")).get();
    const retentionHours = (settings?.logRetentionDays ?? 30) * 24;
    const result = await manualLogCleanup(db, retentionHours);
    if (result.success) return ok(c, { message: result.message });
    throw new ValidationError(result.message);
});

export { app as metaConversionsAdminRoutes };
