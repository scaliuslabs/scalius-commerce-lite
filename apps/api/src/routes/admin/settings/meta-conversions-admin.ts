import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "@scalius/database/client";
import { metaConversionsSettings, metaConversionsLogs } from "@scalius/database/schema";
import { sql, eq, desc, count } from "drizzle-orm";
import { getLogRetentionHours, getCleanupCheckIntervalHours } from "@scalius/core/integrations/meta/conversions-api";
import { MetaService } from "@scalius/core/modules/analytics/meta.service";

import { ok, created } from "../../../utils/api-response";
const app = new OpenAPIHono();
const MASKED_VALUE = "••••••••••••";

const metaConversionsSettingsSchema = z.object({
    pixelId: z.string().optional(),
    accessToken: z.string().optional(),
    testEventCode: z.string().optional(),
    isEnabled: z.boolean().default(false),
    logRetentionDays: z.number().int().min(1).max(365).default(30)
});

// ── Get Settings ──

const getSettingsRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Meta Conversions"],
    summary: "Get Meta Conversions API settings",
    responses: { 200: { description: "Settings"  } }
});

app.openapi(getSettingsRoute, async (c) => {
    try {
        const settings = await db.select().from(metaConversionsSettings).where(eq(metaConversionsSettings.id, "singleton")).get();
        const maskedSettings = settings ? { ...settings, accessToken: settings.accessToken ? MASKED_VALUE : null } : null;
        return ok(c, { settings: maskedSettings });
    } catch (error: unknown) {
        throw error;
    }
});

// ── Save Settings ──

const saveSettingsRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Meta Conversions"],
    summary: "Save Meta Conversions API settings",
    request: { body: { content: { "application/json": { schema: metaConversionsSettingsSchema } } } },
    responses: { 200: { description: "Settings saved"  } }
});

app.openapi(saveSettingsRoute, async (c) => {
    try {
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

        if (!result) throw new Error("Failed to save settings");
        const maskedResult = { ...result, accessToken: result.accessToken ? MASKED_VALUE : null };
        return existingSettings ? ok(c, maskedResult) : created(c, maskedResult);
    } catch (error: unknown) {
        throw error;
    }
});

// ── Get Logs ──

const getLogsRoute = createRoute({
    method: "get",
    path: "/logs",
    tags: ["Admin - Meta Conversions"],
    summary: "Get Meta Conversions API logs",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().default(20).openapi({ description: "Items per page" })
        })
    },
    responses: { 200: { description: "Logs with pagination"  } }
});

app.openapi(getLogsRoute, async (c) => {
    try {
        const query = c.req.valid("query");
        const page = query.page;
        const limit = query.limit;
        const offset = (page - 1) * limit;

        const totalResult = await db.select({ count: count(metaConversionsLogs.id) }).from(metaConversionsLogs).get();
        const total = totalResult?.count ?? 0;
        const logs = await db.select().from(metaConversionsLogs).orderBy(desc(metaConversionsLogs.createdAt)).limit(limit).offset(offset).all();

        return ok(c, {
            logs: logs,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            retention: { hours: getLogRetentionHours(), cleanupIntervalHours: getCleanupCheckIntervalHours(), nextCleanupMessage: "Cleanup active" }
        });
    } catch (error: unknown) {
        throw error;
    }
});

// ── Clear Logs ──

const clearLogsRoute = createRoute({
    method: "delete",
    path: "/logs",
    tags: ["Admin - Meta Conversions"],
    summary: "Clear all Meta Conversions API logs",
    responses: { 200: { description: "Logs cleared"  } }
});

app.openapi(clearLogsRoute, async (c) => {
    try {
        await db.delete(metaConversionsLogs);
        return ok(c, { message: "All logs cleared" });
    } catch (error: unknown) {
        throw error;
    }
});

// ── Manual Log Cleanup ──

const manualCleanupRoute = createRoute({
    method: "post",
    path: "/logs",
    tags: ["Admin - Meta Conversions"],
    summary: "Trigger manual log cleanup",
    responses: { 200: { description: "Cleanup result"  } }
});

app.openapi(manualCleanupRoute, async (c) => {
    try {
        const result = await MetaService.manualLogCleanup(db, getLogRetentionHours());
        if (result.success) return ok(c, { message: result.message });
        throw new Error(result.message);
    } catch (error: unknown) {
        throw error;
    }
});

export { app as metaConversionsAdminRoutes };
