// src/modules/analytics/analytics.service.ts
import { analytics } from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import type { Analytics } from "@scalius/database/schema";

/**
 * Format dates for consistent API responses
 */
function formatScriptResponse(script: Analytics | undefined | null) {
    if (!script) return null;
    return {
        ...script,
        createdAt: script.createdAt
            ? new Date(Number(script.createdAt) * 1000).toISOString()
            : null,
        updatedAt: script.updatedAt
            ? new Date(Number(script.updatedAt) * 1000).toISOString()
            : null,
    };
}

export async function listAnalyticsScripts(db: Database) {
    const results = await db.select().from(analytics);
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

export async function createAnalyticsScript(db: Database, data: Record<string, unknown>) {
    const analyticsId = "analytics_" + nanoid();

    const [script] = await db
        .insert(analytics)
        .values({
            id: analyticsId,
            name: data.name as string,
            type: data.type as string,
            isActive: data.isActive as boolean,
            usePartytown: data.usePartytown as boolean,
            config: data.config as string,
            location: data.location as string,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .returning();

    return { id: analyticsId, script: formatScriptResponse(script) };
}

export async function updateAnalyticsScript(db: Database, id: string, data: Record<string, unknown>) {
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
            name: data.name as string,
            type: data.type as string,
            isActive: data.isActive as boolean,
            usePartytown: data.usePartytown as boolean,
            config: data.config as string,
            location: data.location as string,
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
