import { type Database } from "@scalius/database/client";
import { metaConversionsSettings, metaConversionsLogs, type MetaConversionsSettings } from "@scalius/database/schema";
import { eq, lt } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { decryptCredentialsGraceful } from "../../utils/credential-encryption";

/**
 * Fetches the Meta Conversions API settings from the database.
 */
export async function getCapiSettings(
    db: Database,
    encryptionKey?: string,
): Promise<MetaConversionsSettings | null> {
    try {
        const settings = await db
            .select()
            .from(metaConversionsSettings)
            .where(eq(metaConversionsSettings.id, "singleton"))
            .get();
        if (!settings) {
            return null;
        }

        return {
            ...settings,
            accessToken: settings.accessToken
                ? await decryptCredentialsGraceful(settings.accessToken, encryptionKey)
                : settings.accessToken,
        };
    } catch (error: unknown) {
        console.error("Error fetching Meta CAPI settings:", error);
        return null;
    }
}

/**
 * Logs a CAPI event to the database and triggers lazy cleanup.
 */
export async function logCapiEvent(
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

        // Fire-and-forget: cleanup is best-effort and non-critical.
        // Not awaited intentionally — the caller should not wait for cleanup
        // to complete before returning. Errors are caught inside performLogCleanup.
        void performLogCleanup(db, retentionHours);
    } catch (error: unknown) {
        console.error("Failed to write to Meta CAPI log:", error);
    }
}

/**
 * Performs automatic log cleanup based on configurable retention period.
 */
export async function performLogCleanup(db: Database, retentionHours: number): Promise<void> {
    try {
        const now = Date.now();
        const retentionMs = retentionHours * 60 * 60 * 1000;
        const cutoffTime = new Date(now - retentionMs);

        await db
            .delete(metaConversionsLogs)
            .where(lt(metaConversionsLogs.createdAt, cutoffTime));
    } catch (error: unknown) {
        console.error("Error during Meta CAPI log cleanup:", error);
    }
}

/**
 * Manually trigger log cleanup (for admin use).
 * Delegates to performLogCleanup for the actual deletion.
 */
export async function manualLogCleanup(
    db: Database,
    retentionHours: number
): Promise<{ success: boolean; message: string }> {
    try {
        await performLogCleanup(db, retentionHours);
        return {
            success: true,
            message: `Log cleanup completed. Retention period: ${retentionHours} hours.`,
        };
    } catch (error: unknown) {
        return {
            success: false,
            message: `Log cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
