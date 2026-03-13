import { Hono } from "hono";
import { db } from "@scalius/database/client";
import { metaConversionsSettings, metaConversionsLogs } from "@scalius/database/schema";
import { sql, eq, desc, count } from "drizzle-orm";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getLogRetentionHours, getCleanupCheckIntervalHours } from "@scalius/core/integrations/meta/conversions-api";
import { MetaService } from "@scalius/core/modules/analytics/meta.service";

const app = new Hono<{ Bindings: any, Variables: any }>();
const MASKED_VALUE = "••••••••••••";

const metaConversionsSettingsSchema = z.object({
    pixelId: z.string().optional(),
    accessToken: z.string().optional(),
    testEventCode: z.string().optional(),
    isEnabled: z.boolean().default(false),
    logRetentionDays: z.number().int().min(1).max(365).default(30),
});

app.get("/", async (c) => {
    try {
        const settings = await db.select().from(metaConversionsSettings).where(eq(metaConversionsSettings.id, "singleton")).get();
        const maskedSettings = settings ? { ...settings, accessToken: settings.accessToken ? MASKED_VALUE : null } : null;
        return c.json({ data: maskedSettings });
    } catch (error) {
        return c.json({ error: "Failed to fetch settings" }, 500);
    }
});

app.post("/", zValidator("json", metaConversionsSettingsSchema), async (c) => {
    try {
        const validation = c.req.valid("json");
        let { pixelId, accessToken, testEventCode, isEnabled, logRetentionDays } = validation;
        const existingSettings = await db.select().from(metaConversionsSettings).where(eq(metaConversionsSettings.id, "singleton")).get();

        if (accessToken === MASKED_VALUE && existingSettings?.accessToken) {
            accessToken = existingSettings.accessToken;
        }

        let result;
        if (existingSettings) {
            [result] = await db.update(metaConversionsSettings)
                .set({ pixelId, accessToken, testEventCode, isEnabled, logRetentionDays, updatedAt: sql`(cast(strftime('%s','now') as int))` })
                .where(eq(metaConversionsSettings.id, "singleton")).returning();
        } else {
            [result] = await db.insert(metaConversionsSettings)
                .values({ id: "singleton", pixelId, accessToken, testEventCode, isEnabled, logRetentionDays, createdAt: sql`(cast(strftime('%s','now') as int))`, updatedAt: sql`(cast(strftime('%s','now') as int))` })
                .returning();
        }

        const maskedResult = { ...result, accessToken: result.accessToken ? MASKED_VALUE : null };
        return c.json({ data: maskedResult }, existingSettings ? 200 : 201);
    } catch (error) {
        return c.json({ error: "Failed to save settings" }, 500);
    }
});

app.get("/logs", async (c) => {
    try {
        const page = parseInt(c.req.query("page") || "1");
        const limit = parseInt(c.req.query("limit") || "20");
        const offset = (page - 1) * limit;

        const totalResult = await db.select({ count: count(metaConversionsLogs.id) }).from(metaConversionsLogs).get();
        const total = totalResult?.count ?? 0;
        const logs = await db.select().from(metaConversionsLogs).orderBy(desc(metaConversionsLogs.createdAt)).limit(limit).offset(offset).all();

        return c.json({
            data: logs,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            retention: { hours: getLogRetentionHours(), cleanupIntervalHours: getCleanupCheckIntervalHours(), nextCleanupMessage: "Cleanup active" },
        });
    } catch (error) {
        return c.json({ error: "Failed to fetch logs" }, 500);
    }
});

app.delete("/logs", async (c) => {
    try {
        await db.delete(metaConversionsLogs);
        return c.json({ message: "All logs cleared" });
    } catch (error) {
        return c.json({ error: "Failed to clear logs" }, 500);
    }
});

app.post("/logs", async (c) => {
    try {
        const result = await MetaService.manualLogCleanup(db, getLogRetentionHours());
        if (result.success) return c.json({ message: result.message });
        return c.json({ error: result.message }, 500);
    } catch (error) {
        return c.json({ error: "Manual log cleanup failed" }, 500);
    }
});

export { app as metaConversionsAdminRoutes };
