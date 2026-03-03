// src/modules/analytics/analytics.service.ts
import { analytics } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

export class AnalyticsService {
    /**
     * Format dates for consistent API responses
     */
    private static formatScriptResponse(script: any) {
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

    static async listScripts(db: any) {
        const results = await db.select().from(analytics);
        return results.map(this.formatScriptResponse);
    }

    static async getScript(db: any, id: string) {
        const script = await db
            .select()
            .from(analytics)
            .where(eq(analytics.id, id))
            .get();

        return this.formatScriptResponse(script);
    }

    static async createScript(db: any, data: any) {
        const analyticsId = "analytics_" + nanoid();

        const [script] = await db
            .insert(analytics)
            .values({
                id: analyticsId,
                name: data.name,
                type: data.type,
                isActive: data.isActive,
                usePartytown: data.usePartytown,
                config: data.config,
                location: data.location,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            })
            .returning();

        return { id: analyticsId, script: this.formatScriptResponse(script) };
    }

    static async updateScript(db: any, id: string, data: any) {
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
                name: data.name,
                type: data.type,
                isActive: data.isActive,
                usePartytown: data.usePartytown,
                config: data.config,
                location: data.location,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(analytics.id, id));

        return this.getScript(db, id);
    }

    static async toggleScript(db: any, id: string, isActive: boolean) {
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

        return this.getScript(db, id);
    }

    static async deleteScript(db: any, id: string) {
        const script = await db
            .select()
            .from(analytics)
            .where(eq(analytics.id, id))
            .get();

        if (!script) {
            return null;
        }

        const formattedScript = this.formatScriptResponse(script);
        await db.delete(analytics).where(eq(analytics.id, id));

        return formattedScript;
    }
}
