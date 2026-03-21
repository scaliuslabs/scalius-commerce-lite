import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { metaConversionsSettings, metaConversionsLogs } from "@scalius/database/schema";
import { sql, eq, desc, count } from "drizzle-orm";
import { manualLogCleanup } from "@scalius/core/modules/analytics/meta.service";

import { ok, created } from "../../../utils/api-response";
import { ValidationError } from "../../../utils/api-error";
import { successEnvelope, paginatedEnvelope, messageResponse, errorResponses } from "../../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED_VALUE = "••••••••••••";

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

const getSettingsRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Meta Conversions"],
    summary: "Get Meta Conversions API settings",
    responses: {
        200: { description: "Settings", content: { "application/json": { schema: successEnvelope(z.object({ settings: metaConversionsSettingsResponseSchema.nullable() })) } } },
        ...errorResponses,
    }
});

app.openapi(getSettingsRoute, (async (c: any) => {
    const db = c.get("db");
    const settings = await db.select().from(metaConversionsSettings).where(eq(metaConversionsSettings.id, "singleton")).get();
    const maskedSettings = settings ? { ...settings, accessToken: settings.accessToken ? MASKED_VALUE : null } : null;
    return ok(c, { settings: maskedSettings });
}) as any);

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
    }
});

app.openapi(saveSettingsRoute, (async (c: any) => {
    const db = c.get("db");
    const validation = c.req.valid("json");
    let { pixelId, accessToken, testEventCode, isEnabled, logRetentionDays } = validation;
    const existingSettings = await db.select().from(metaConversionsSettings).where(eq(metaConversionsSettings.id, "singleton")).get();

    if (accessToken === MASKED_VALUE && existingSettings?.accessToken) {
        accessToken = existingSettings.accessToken;
    }

    let resultArr;
    if (existingSettings) {
        resultArr = await db.update(metaConversionsSettings)
            .set({ pixelId, accessToken, testEventCode, isEnabled, logRetentionDays, updatedAt: sql`(cast(strftime('%s','now') as int))` })
            .where(eq(metaConversionsSettings.id, "singleton")).returning();
    } else {
        resultArr = await db.insert(metaConversionsSettings)
            .values({ id: "singleton", pixelId, accessToken, testEventCode, isEnabled, logRetentionDays, createdAt: sql`(cast(strftime('%s','now') as int))`, updatedAt: sql`(cast(strftime('%s','now') as int))` })
            .returning();
    }
    const result = resultArr[0];

    if (!result) throw new ValidationError("Failed to save settings");
    const maskedResult = { ...result, accessToken: result.accessToken ? MASKED_VALUE : null };
    return existingSettings ? ok(c, maskedResult) : created(c, maskedResult);
}) as any);

// ── Get Logs ──

const metaConversionsLogSchema = z.object({
    id: z.string(),
    eventName: z.string().nullable(),
    status: z.string().nullable(),
    requestPayload: z.string().nullable(),
    responseBody: z.string().nullable(),
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

app.openapi(getLogsRoute, (async (c: any) => {
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
        logs: logs,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        retention: { days: retentionDays, hours: retentionDays * 24 }
    });
}) as any);

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
