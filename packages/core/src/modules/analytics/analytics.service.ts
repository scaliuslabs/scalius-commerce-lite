// src/modules/analytics/analytics.service.ts
import { analytics } from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import type { Analytics } from "@scalius/database/schema";
import type { z } from "zod";
import {
    isMainThreadOnlyAnalyticsType,
    normalizeCloudflareWebAnalyticsConfig,
    type createAnalyticsSchema,
    type updateAnalyticsSchema,
} from "./analytics.validation";

type CreateAnalyticsInput = z.infer<typeof createAnalyticsSchema>;
type UpdateAnalyticsInput = z.infer<typeof updateAnalyticsSchema>;

/**
 * Format dates for consistent API responses.
 * Drizzle's mode: "timestamp" returns Date objects, so call .toISOString() directly.
 */
function formatScriptResponse(script: Analytics | undefined | null) {
    if (!script) return null;
    return {
        ...script,
        createdAt: script.createdAt instanceof Date
            ? script.createdAt.toISOString()
            : script.createdAt ? new Date(Number(script.createdAt) * 1000).toISOString() : null,
        updatedAt: script.updatedAt instanceof Date
            ? script.updatedAt.toISOString()
            : script.updatedAt ? new Date(Number(script.updatedAt) * 1000).toISOString() : null,
    };
}

function normalizeAnalyticsScriptValues(
    data: CreateAnalyticsInput | UpdateAnalyticsInput,
) {
    const config =
        data.type === "cloudflare_web_analytics"
            ? normalizeCloudflareWebAnalyticsConfig(data.config)
            : data.config;

    return {
        config,
        usePartytown: isMainThreadOnlyAnalyticsType(data.type)
            ? false
            : data.usePartytown,
    };
}

export async function listAnalyticsScripts(db: Database) {
    const results = await db.select().from(analytics).limit(50);
    return results.map(formatScriptResponse);
}

export async function getAnalyticsScript(db: Database, id: string) {
    const script = await db
        .select()
        .from(analytics)
        .where(eq(analytics.id, id))
        .get();

    return formatScriptResponse(script);
}

export async function createAnalyticsScript(db: Database, data: CreateAnalyticsInput) {
    const analyticsId = "analytics_" + nanoid();
    const normalized = normalizeAnalyticsScriptValues(data);

    const [script] = await db
        .insert(analytics)
        .values({
            id: analyticsId,
            name: data.name,
            type: data.type,
            isActive: data.isActive,
            usePartytown: normalized.usePartytown,
            config: normalized.config,
            location: data.location,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .returning();

    return { id: analyticsId, script: formatScriptResponse(script) };
}

export async function updateAnalyticsScript(db: Database, id: string, data: UpdateAnalyticsInput) {
    const existingScript = await db
        .select({ id: analytics.id })
        .from(analytics)
        .where(eq(analytics.id, id))
        .get();

    if (!existingScript) {
        return null;
    }

    const normalized = normalizeAnalyticsScriptValues(data);

    await db
        .update(analytics)
        .set({
            name: data.name,
            type: data.type,
            isActive: data.isActive,
            usePartytown: normalized.usePartytown,
            config: normalized.config,
            location: data.location,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(analytics.id, id));

    return getAnalyticsScript(db, id);
}

export async function toggleAnalyticsScript(db: Database, id: string, isActive: boolean) {
    const existingScript = await db
        .select({ id: analytics.id })
        .from(analytics)
        .where(eq(analytics.id, id))
        .get();

    if (!existingScript) {
        return null;
    }

    await db
        .update(analytics)
        .set({
            isActive,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(analytics.id, id));

    return getAnalyticsScript(db, id);
}

export async function deleteAnalyticsScript(db: Database, id: string) {
    const script = await db
        .select()
        .from(analytics)
        .where(eq(analytics.id, id))
        .get();

    if (!script) {
        return null;
    }

    const formattedScript = formatScriptResponse(script);
    await db.delete(analytics).where(eq(analytics.id, id));

    return formattedScript;
}
