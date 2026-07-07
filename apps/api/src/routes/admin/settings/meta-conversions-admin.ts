import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import { metaConversionsSettings, metaConversionsLogs } from "@scalius/database/schema";
import { sql, eq, desc, count } from "drizzle-orm";
import { manualLogCleanup } from "@scalius/core/modules/analytics/meta.service";
import {
    buildUnavailableMetaPixelParityDiagnostics,
    getMetaPixelParityDiagnostics,
    metaPixelParityStatuses,
} from "@scalius/core/modules/analytics";
import { encryptCredentials } from "@scalius/core/utils/credential-encryption";
import { redactCapiPayloadForLog } from "@scalius/core/integrations/meta/conversions-api";

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

function redactStoredRequestPayload(payload: string | null): string | null {
    if (!payload) {
        return payload;
    }

    try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        if (!Array.isArray(parsed.data)) {
            return payload;
        }

        return JSON.stringify(
            redactCapiPayloadForLog(
                parsed as unknown as Parameters<typeof redactCapiPayloadForLog>[0],
            ),
            null,
            2,
        );
    } catch {
        return payload;
    }
}

function redactTokenishResponseValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(redactTokenishResponseValue);
    }

    if (!value || typeof value !== "object") {
        return value;
    }

    return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => {
            const normalizedKey = key.toLowerCase().replace(/[\s_-]+/g, "");
            if (["token", "accesstoken", "authtoken", "authorization", "bearer"].includes(normalizedKey)) {
                return [key, "[redacted]"];
            }
            return [key, redactTokenishResponseValue(nested)];
        }),
    );
}

function redactStoredResponsePayload(payload: string | null): string | null {
    if (!payload) {
        return payload;
    }

    try {
        return JSON.stringify(redactTokenishResponseValue(JSON.parse(payload)), null, 2);
    } catch {
        return payload;
    }
}

const metaConversionsSettingsSchema = z.object({
    pixelId: z.string().optional(),
    accessToken: z.string().optional(),
    testEventCode: z.string().optional(),
    isEnabled: z.boolean().default(false),
    logRetentionDays: z.number().int().min(1).max(365).default(30)
});

// ── Get Settings ──

const metaConversionsSettingsResponseSchema = z.object({
    id: z.string(),
    pixelId: z.string().nullable(),
    accessToken: z.string().nullable(),
    testEventCode: z.string().nullable(),
    isEnabled: z.boolean(),
    logRetentionDays: z.number(),
    createdAt: z.number().nullable(),
    updatedAt: z.number().nullable(),
}).passthrough();

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
    const maskedSettings = settings ? { ...settings, accessToken: settings.accessToken ? MASKED_VALUE : null } : null;
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
    const pixelId = optionalTrimmedValue(validation.pixelId);
    const testEventCode = optionalTrimmedValue(validation.testEventCode);
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
    validateConcreteCredential("test event code", testEventCode);

    if (validation.isEnabled) {
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

    const resultArr = existingSettings
        ? await db.update(metaConversionsSettings)
            .set({ pixelId, accessToken, testEventCode, isEnabled: validation.isEnabled, logRetentionDays: validation.logRetentionDays, updatedAt: sql`(cast(strftime('%s','now') as int))` })
            .where(eq(metaConversionsSettings.id, "singleton")).returning()
        : await db.insert(metaConversionsSettings)
            .values({ id: "singleton", pixelId, accessToken: accessToken ?? null, testEventCode, isEnabled: validation.isEnabled, logRetentionDays: validation.logRetentionDays, createdAt: sql`(cast(strftime('%s','now') as int))`, updatedAt: sql`(cast(strftime('%s','now') as int))` })
            .returning();
    const result = resultArr[0];

    if (!result) throw new ValidationError("Failed to save settings");
    await clearMetaCapiBrowserCircuit(c.env);
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    const maskedResult = { ...result, accessToken: result.accessToken ? MASKED_VALUE : null };
    return existingSettings ? ok(c, maskedResult) : created(c, maskedResult);
}) as unknown as AppRouteHandler<typeof saveSettingsRoute>);

// ── Get Logs ──

const metaConversionsLogSchema = z.object({
    id: z.string(),
    eventName: z.string().nullable(),
    status: z.string().nullable(),
    requestPayload: z.string().nullable(),
    responsePayload: z.string().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: z.number().nullable(),
}).passthrough();

const getLogsRoute = createRoute({
    method: "get",
    path: "/logs",
    tags: ["Admin - Meta Conversions"],
    summary: "Get Meta Conversions API logs",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().max(100).default(20).openapi({ description: "Items per page" })
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
            ...log,
            requestPayload: redactStoredRequestPayload(log.requestPayload),
            responsePayload: redactStoredResponsePayload(log.responsePayload),
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        retention: { days: retentionDays, hours: retentionDays * 24 }
    });
}) as unknown as AppRouteHandler<typeof getLogsRoute>);

// ── Clear Logs ──

const clearLogsRoute = createRoute({
    method: "delete",
    path: "/logs",
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
