import { type Database } from "@scalius/database/client";
import { metaConversionsSettings, metaConversionsLogs, type MetaConversionsSettings } from "@scalius/database/schema";
import { eq, lt } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { readStoredCredentialStrict } from "../../utils/credential-encryption";

const SAFE_META_LOG_PAYLOAD_UNAVAILABLE = JSON.stringify({ available: false });

function summarizeRequestPayload(payload: string): string {
    try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        if (!Array.isArray(parsed.data)) return SAFE_META_LOG_PAYLOAD_UNAVAILABLE;
        return JSON.stringify({
            eventCount: parsed.data.length,
            events: parsed.data.slice(0, 20).map((event) => {
                if (!event || typeof event !== "object") return { eventName: "unknown" };
                const row = event as Record<string, unknown>;
                return {
                    eventName: typeof row.event_name === "string"
                        ? row.event_name.slice(0, 100)
                        : "unknown",
                    actionSource: typeof row.action_source === "string"
                        ? row.action_source.slice(0, 50)
                        : null,
                };
            }),
            truncated: parsed.data.length > 20,
        });
    } catch {
        return SAFE_META_LOG_PAYLOAD_UNAVAILABLE;
    }
}

function summarizeResponsePayload(payload: string | undefined): string | undefined {
    if (!payload) return undefined;
    try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        const eventsReceived = Number(parsed.events_received);
        const error = parsed.error && typeof parsed.error === "object"
            ? parsed.error as Record<string, unknown>
            : null;
        return JSON.stringify({
            eventsReceived: Number.isFinite(eventsReceived)
                ? Math.max(0, Math.trunc(eventsReceived))
                : null,
            hasError: Boolean(error),
            errorType: typeof error?.type === "string" ? error.type.slice(0, 100) : null,
            errorCode: typeof error?.code === "number" && Number.isFinite(error.code)
                ? Math.trunc(error.code)
                : null,
        });
    } catch {
        return SAFE_META_LOG_PAYLOAD_UNAVAILABLE;
    }
}

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

        const accessTokenRead = await readStoredCredentialStrict(
            settings.accessToken,
            encryptionKey,
            "Meta Conversions API access token",
        );
        if (accessTokenRead.error) {
            console.warn("[Meta CAPI] Access token is not ready:", accessTokenRead.error);
        }

        return {
            ...settings,
            accessToken: accessTokenRead.value || null,
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
        const { eventTime } = logData;
        const safeLogData = {
            eventId: logData.eventId.slice(0, 200),
            eventName: logData.eventName.slice(0, 100),
            status: logData.status,
            requestPayload: summarizeRequestPayload(logData.requestPayload),
            responsePayload: summarizeResponsePayload(logData.responsePayload),
            errorMessage: logData.errorMessage
                ? "Meta delivery failed. Review provider configuration."
                : undefined,
        };
        const values = {
            id: createId(),
            ...safeLogData,
            eventTime: new Date(eventTime * 1000),
        };

        try {
            await db.insert(metaConversionsLogs).values(values);
        } catch (insertError) {
            const existing = await getCapiEventLog(db, logData.eventId);
            if (!existing) throw insertError;

            if (existing.status === "success" && logData.status === "failed") {
                return;
            }

            await db
                .update(metaConversionsLogs)
                .set({
                    eventName: safeLogData.eventName,
                    status: safeLogData.status,
                    requestPayload: safeLogData.requestPayload,
                    responsePayload: safeLogData.responsePayload,
                    errorMessage: safeLogData.errorMessage,
                    eventTime: new Date(eventTime * 1000),
                })
                .where(eq(metaConversionsLogs.eventId, logData.eventId));
        }

        // Fire-and-forget: cleanup is best-effort and non-critical.
        // Not awaited intentionally — the caller should not wait for cleanup
        // to complete before returning. Errors are caught inside performLogCleanup.
        void performLogCleanup(db, retentionHours);
    } catch {
        console.error("Failed to write to Meta CAPI log");
    }
}

export async function getCapiEventLog(
    db: Database,
    eventId: string,
): Promise<typeof metaConversionsLogs.$inferSelect | undefined> {
    return await db
        .select()
        .from(metaConversionsLogs)
        .where(eq(metaConversionsLogs.eventId, eventId))
        .get();
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
    } catch {
        console.error("Error during Meta CAPI log cleanup");
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
    } catch {
        return {
            success: false,
            message: "Log cleanup failed",
        };
    }
}
