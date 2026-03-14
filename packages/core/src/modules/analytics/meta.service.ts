import { type Database } from "@scalius/database/client";
import { metaConversionsSettings, metaConversionsLogs, type MetaConversionsSettings } from "@scalius/database/schema";
import { eq, lt } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";

export class MetaService {
    /**
     * Fetches the Meta Conversions API settings from the database.
     */
    static async getCapiSettings(db: Database): Promise<MetaConversionsSettings | null> {
        try {
            const settings = await db
                .select()
                .from(metaConversionsSettings)
                .where(eq(metaConversionsSettings.id, "singleton"))
                .get();
            return settings || null;
        } catch (error) {
            console.error("Error fetching Meta CAPI settings:", error);
            return null;
        }
    }

    /**
     * Logs a CAPI event to the database and triggers lazy cleanup.
     */
    static async logCapiEvent(
        db: Database,
        logData: {
            eventId: string;
            eventName: string;
            status: "success" | "failed";
            requestPayload: string;
            responsePayload?: string;
            errorMessage?: string;
            eventTime: number;
        },
        retentionHours: number = 12
    ): Promise<void> {
        try {
            const { eventTime, ...restOfLogData } = logData;
            await db.insert(metaConversionsLogs).values({
                id: createId(),
                ...restOfLogData,
                eventTime: new Date(eventTime * 1000),
            });

            // Implement lazy cleanup directly in the service
            this.performLogCleanup(db, retentionHours);
        } catch (error) {
            console.error("Failed to write to Meta CAPI log:", error);
        }
    }

    /**
     * Performs automatic log cleanup based on configurable retention period.
     */
    static async performLogCleanup(db: Database, retentionHours: number): Promise<void> {
        try {
            const now = Date.now();
            const retentionMs = retentionHours * 60 * 60 * 1000;
            const cutoffTime = new Date(now - retentionMs);

            await db
                .delete(metaConversionsLogs)
                .where(lt(metaConversionsLogs.createdAt, cutoffTime));
        } catch (error) {
            console.error("Error during Meta CAPI log cleanup:", error);
        }
    }

    /**
     * Manually trigger log cleanup (for admin use).
     */
    static async manualLogCleanup(
        db: Database,
        retentionHours: number
    ): Promise<{ success: boolean; message: string }> {
        try {
            const now = Date.now();
            const retentionMs = retentionHours * 60 * 60 * 1000;
            const cutoffTime = new Date(now - retentionMs);

            await db
                .delete(metaConversionsLogs)
                .where(lt(metaConversionsLogs.createdAt, cutoffTime));

            return {
                success: true,
                message: `Log cleanup completed. Retention period: ${retentionHours} hours.`,
            };
        } catch (error: unknown) {
            console.error("Error during manual Meta CAPI log cleanup:", error);
            return {
                success: false,
                message: `Log cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }
}
