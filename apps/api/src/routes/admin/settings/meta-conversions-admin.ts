import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import { metaConversionsLogs } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { desc, count } from "drizzle-orm";
import {
    manualLogCleanup,
    summarizeMetaRequestPayload,
    summarizeMetaResponsePayload,
    buildUnavailableMetaPixelParityDiagnostics,
    getMetaPixelParityDiagnostics,
    metaPixelParityStatuses,
} from "@scalius/core/modules/analytics";
import { metaConversionsDocument, type MetaConversionsSettings } from "@scalius/core/modules/settings";

import { ok, created } from "../../../utils/api-response";
import { ValidationError } from "../../../utils/api-error";
import {
    successEnvelope,
    messageResponse,
    conflictResponse,
    errorResponses,
    serviceUnavailableResponse,
} from "../../../schemas/responses";

import { getCredentialEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";
import { META_CAPI_BROWSER_CIRCUIT_KEY } from "../../meta-conversions";
const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED_VALUE = "••••••••••••";
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

const metaConversionsSettingsSchema = z.object({
    pixelId: z.string().max(100).optional(),
    accessToken: z.string().max(4096).optional(),
    testEventCode: z.string().max(200).optional(),
    isEnabled: z.boolean().optional(),
    logRetentionDays: z.number().int().min(1).max(365).optional(),
    expectedRevision: z.number().int().nonnegative(),
});

// ── Get Settings ──

const metaConversionsSettingsResponseSchema = z.object({
    pixelId: z.string().nullable(),
    accessToken: z.string().nullable(),
    testEventCode: z.string().nullable(),
    isEnabled: z.boolean(),
    logRetentionDays: z.number(),
});

/** Credentials never leave the API; a token that cannot be decrypted still reads as saved. */
function maskedSettings(
    value: MetaConversionsSettings,
    accessTokenStored: boolean,
): z.infer<typeof metaConversionsSettingsResponseSchema> {
    return {
        pixelId: value.pixelId || null,
        accessToken: accessTokenStored ? MASKED_VALUE : null,
        testEventCode: value.testEventCode ? MASKED_VALUE : null,
        isEnabled: value.isEnabled,
        logRetentionDays: value.logRetentionDays,
    };
}

async function readMetaSettings(db: Database, env: Env) {
    const stored = await metaConversionsDocument.readDetailed(db, {
        encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
    });
    return {
        ...stored,
        accessTokenStored: Boolean(stored.value.accessToken || stored.secretErrors.accessToken),
    };
}

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
            revision: z.number().int().nonnegative(),
        })) } } },
        ...errorResponses,
    }
});

app.openapi(getSettingsRoute, (async (c) => {
    const db = c.get("db");
    const stored = await readMetaSettings(db, c.env);
    const pixelId = stored.stored ? stored.value.pixelId || null : null;
    const pixelParity = await getMetaPixelParityDiagnostics(db, pixelId).catch((error: unknown) => {
        console.warn("Meta Pixel parity diagnostics unavailable", {
            error: error instanceof Error ? error.message : String(error),
        });
        return buildUnavailableMetaPixelParityDiagnostics(pixelId);
    });
    return ok(c, {
        settings: stored.stored ? maskedSettings(stored.value, stored.accessTokenStored) : null,
        pixelParity,
        revision: stored.revision,
    });
}) as AppRouteHandler<typeof getSettingsRoute>);

// ── Save Settings ──

const savedMetaConversionsSchema = metaConversionsSettingsResponseSchema.extend({
    revision: z.number().int().nonnegative(),
});

const saveSettingsRoute = createRoute({
    method: "post",
    path: "/",
    operationId: "dashboard.meta_conversions.update",
    tags: ["Admin - Meta Conversions"],
    summary: "Save Meta Conversions API settings",
    request: { body: { required: true, content: { "application/json": { schema: metaConversionsSettingsSchema } } } },
    responses: {
        200: { description: "Settings saved", content: { "application/json": { schema: successEnvelope(savedMetaConversionsSchema) } } },
        201: { description: "Settings created", content: { "application/json": { schema: successEnvelope(savedMetaConversionsSchema) } } },
        ...errorResponses,
        409: conflictResponse,
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
    const existing = await readMetaSettings(db, c.env);
    const pixelId = validation.pixelId === undefined
        ? existing.value.pixelId || null
        : optionalTrimmedValue(validation.pixelId);
    const isEnabled = validation.isEnabled ?? existing.value.isEnabled;
    const logRetentionDays = validation.logRetentionDays ?? existing.value.logRetentionDays;
    const rawTestEventCode = validation.testEventCode;
    const trimmedTestEventCode = typeof rawTestEventCode === "string"
        ? rawTestEventCode.trim()
        : undefined;
    const isUsingMaskedTestEventCode = trimmedTestEventCode === MASKED_VALUE;
    const testEventCode = isUsingMaskedTestEventCode || rawTestEventCode === undefined
        ? existing.value.testEventCode || null
        : optionalTrimmedValue(rawTestEventCode);
    const rawAccessToken = validation.accessToken;
    const trimmedAccessToken = typeof rawAccessToken === "string" ? rawAccessToken.trim() : undefined;
    const hasStoredAccessToken = existing.accessTokenStored;
    const isUsingMaskedAccessToken = trimmedAccessToken === MASKED_VALUE;
    const hasEffectiveAccessToken = isUsingMaskedAccessToken || rawAccessToken === undefined
        ? hasStoredAccessToken
        : Boolean(trimmedAccessToken);

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

    // A masked or omitted token keeps the stored ciphertext; an empty one clears it.
    const accessToken = isUsingMaskedAccessToken ? undefined : trimmedAccessToken;
    const saved = await metaConversionsDocument.write(db, {
        pixelId: pixelId ?? "",
        accessToken,
        testEventCode: testEventCode ?? "",
        isEnabled,
        logRetentionDays,
    }, {
        encryptionKey: accessToken
            ? requireEncryptionKey(c.env as unknown as Record<string, unknown>)
            : getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
    }, { expectedRevision: validation.expectedRevision });

    await clearMetaCapiBrowserCircuit(c.env);

    const maskedResult = {
        ...maskedSettings(
            saved.value,
            accessToken === undefined ? hasStoredAccessToken : Boolean(accessToken),
        ),
        revision: saved.revision,
    };
    return existing.stored ? ok(c, maskedResult) : created(c, maskedResult);
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

    const retentionDays = (await metaConversionsDocument.read(db)).logRetentionDays;

    return ok(c, {
        logs: logs.map((log) => ({
            id: log.id,
            eventId: log.eventId,
            eventName: log.eventName,
            status: log.status,
            requestPayload: summarizeMetaRequestPayload(log.requestPayload),
            responsePayload: summarizeMetaResponsePayload(log.responsePayload) ?? null,
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
    const retentionHours = (await metaConversionsDocument.read(db)).logRetentionDays * 24;
    const result = await manualLogCleanup(db, retentionHours);
    if (result.success) return ok(c, { message: result.message });
    throw new ValidationError(result.message);
});

export { app as metaConversionsAdminRoutes };
