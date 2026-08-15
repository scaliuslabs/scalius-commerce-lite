import { type Database } from "@scalius/database/client";
import { metaConversionsSettings, metaConversionsLogs, type MetaConversionsSettings } from "@scalius/database/schema";
import { eq, lt } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { readStoredCredentialStrict } from "../../utils/credential-encryption";

const SAFE_META_LOG_PAYLOAD_UNAVAILABLE = JSON.stringify({ available: false });
const META_MATCH_SIGNAL_FIELDS = [
    "client_ip_address",
    "client_user_agent",
    "ct",
    "country",
    "db",
    "em",
    "external_id",
    "fbc",
    "fbp",
    "fn",
    "ge",
    "lead_id",
    "ln",
    "ph",
    "st",
    "subscription_id",
    "zp",
] as const;
const HASHED_META_MATCH_SIGNAL_FIELDS = new Set([
    "ct",
    "country",
    "db",
    "em",
    "external_id",
    "fn",
    "ge",
    "ln",
    "ph",
    "st",
    "zp",
]);
const META_COMMERCE_FIELDS = [
    "content_category",
    "content_ids",
    "content_name",
    "content_type",
    "contents",
    "currency",
    "num_items",
    "order_id",
    "predicted_ltv",
    "search_string",
    "status",
    "value",
] as const;

function boundedNonnegativeInteger(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
        ? value
        : null;
}

function boundedFiniteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summarizeEventSource(value: unknown): { origin: string | null; path: string | null } {
    if (typeof value !== "string") return { origin: null, path: null };
    try {
        const url = new URL(value);
        return {
            origin: url.origin.slice(0, 255),
            path: url.pathname.slice(0, 512),
        };
    } catch {
        return { origin: null, path: null };
    }
}

function summarizeMatchSignals(value: unknown): {
    count: number;
    fields: string[];
    hashedFields: string[];
    ipAddressSupplied: boolean;
    userAgentSupplied: boolean;
} {
    const row = value && typeof value === "object"
        ? value as Record<string, unknown>
        : {};
    const existingFields = Array.isArray(row.fields) ? new Set(row.fields) : null;
    const fields = META_MATCH_SIGNAL_FIELDS.filter((field) => (
        existingFields ? existingFields.has(field) : Object.hasOwn(row, field)
    ));
    return {
        count: fields.length,
        fields,
        hashedFields: fields.filter((field) => HASHED_META_MATCH_SIGNAL_FIELDS.has(field)),
        ipAddressSupplied: fields.includes("client_ip_address"),
        userAgentSupplied: fields.includes("client_user_agent"),
    };
}

function summarizeCommerceData(value: unknown): Record<string, unknown> {
    const row = value && typeof value === "object"
        ? value as Record<string, unknown>
        : {};
    const existingFields = Array.isArray(row.fields) ? new Set(row.fields) : null;
    const fields = META_COMMERCE_FIELDS.filter((field) => (
        existingFields ? existingFields.has(field) : Object.hasOwn(row, field)
    ));
    const contents = Array.isArray(row.contents) ? row.contents : null;
    const contentIds = Array.isArray(row.content_ids) ? row.content_ids : null;
    const quantity = contents?.reduce((total, content) => {
        if (!content || typeof content !== "object") return total;
        const rawQuantity = (content as Record<string, unknown>).quantity;
        return total + (typeof rawQuantity === "number" && Number.isFinite(rawQuantity)
            ? Math.max(0, rawQuantity)
            : 0);
    }, 0) ?? null;
    const rawCurrency = typeof row.currency === "string" ? row.currency.trim() : "";
    const currency = /^[A-Za-z]{3,8}$/.test(rawCurrency)
        ? rawCurrency.toUpperCase()
        : null;
    const contentType = row.content_type === "product" || row.content_type === "product_group"
        ? row.content_type
        : row.contentType === "product" || row.contentType === "product_group"
            ? row.contentType
            : null;
    return {
        fields,
        currency,
        value: boundedFiniteNumber(row.value),
        contentType,
        contentCount: contentIds?.length ?? boundedNonnegativeInteger(row.contentIdCount),
        lineCount: contents?.length ?? boundedNonnegativeInteger(row.lineCount),
        quantity: quantity ?? boundedFiniteNumber(row.quantity),
        itemCount: boundedNonnegativeInteger(row.num_items ?? row.itemCount),
        orderIdSupplied: fields.includes("order_id"),
        searchStringSupplied: fields.includes("search_string"),
    };
}

function summarizeRequestEvent(event: unknown): Record<string, unknown> {
    if (!event || typeof event !== "object") return { eventName: "unknown" };
    const row = event as Record<string, unknown>;
    const storedSource = row.source && typeof row.source === "object"
        ? row.source as Record<string, unknown>
        : null;
    const source = storedSource
        && typeof storedSource.origin === "string"
        && typeof storedSource.path === "string"
        ? summarizeEventSource(`${storedSource.origin}${storedSource.path}`)
        : summarizeEventSource(row.event_source_url);
    return {
        eventName: typeof (row.event_name ?? row.eventName) === "string"
            ? String(row.event_name ?? row.eventName).slice(0, 100)
            : "unknown",
        actionSource: typeof (row.action_source ?? row.actionSource) === "string"
            ? String(row.action_source ?? row.actionSource).slice(0, 50)
            : null,
        source: {
            origin: typeof source.origin === "string" ? source.origin.slice(0, 255) : null,
            path: typeof source.path === "string" ? source.path.slice(0, 512) : null,
        },
        matchSignals: summarizeMatchSignals(row.user_data ?? row.matchSignals),
        commerce: summarizeCommerceData(row.custom_data ?? row.commerce),
    };
}

export function summarizeMetaRequestPayload(payload: string | null): string | null {
    if (!payload) return payload;
    try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        const rawEvents = Array.isArray(parsed.data)
            ? parsed.data
            : Array.isArray(parsed.events)
                ? parsed.events
                : null;
        const eventCount = Array.isArray(parsed.data)
            ? parsed.data.length
            : boundedNonnegativeInteger(parsed.eventCount);
        if (!rawEvents || eventCount === null) return SAFE_META_LOG_PAYLOAD_UNAVAILABLE;
        return JSON.stringify({
            eventCount,
            events: rawEvents.slice(0, 20).map(summarizeRequestEvent),
            testMode: parsed.test_event_code !== undefined || parsed.testMode === true,
            truncated: parsed.truncated === true || eventCount > 20,
        });
    } catch {
        return SAFE_META_LOG_PAYLOAD_UNAVAILABLE;
    }
}

export function summarizeMetaResponsePayload(
    payload: string | null | undefined,
): string | null | undefined {
    if (!payload) return undefined;
    try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        const rawEventsReceived = parsed.events_received ?? parsed.eventsReceived;
        const eventsReceived = typeof rawEventsReceived === "number"
            ? rawEventsReceived
            : Number.NaN;
        const error = parsed.error && typeof parsed.error === "object"
            ? parsed.error as Record<string, unknown>
            : null;
        const rawMessageCount = Array.isArray(parsed.messages)
            ? parsed.messages.length
            : parsed.messageCount;
        return JSON.stringify({
            eventsReceived: Number.isFinite(eventsReceived)
                ? Math.max(0, Math.trunc(eventsReceived))
                : null,
            hasError: Boolean(error) || parsed.hasError === true,
            errorType: typeof error?.type === "string"
                ? error.type.slice(0, 100)
                : typeof parsed.errorType === "string"
                    ? parsed.errorType.slice(0, 100)
                    : null,
            errorCode: typeof error?.code === "number" && Number.isFinite(error.code)
                ? Math.trunc(error.code)
                : typeof parsed.errorCode === "number" && Number.isFinite(parsed.errorCode)
                    ? Math.trunc(parsed.errorCode)
                    : null,
            messageCount: boundedNonnegativeInteger(rawMessageCount),
            providerTraceId: typeof (parsed.fbtrace_id ?? parsed.providerTraceId) === "string"
                && /^[A-Za-z0-9_-]{1,200}$/.test(String(parsed.fbtrace_id ?? parsed.providerTraceId))
                ? String(parsed.fbtrace_id ?? parsed.providerTraceId)
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
            requestPayload: summarizeMetaRequestPayload(logData.requestPayload) ?? SAFE_META_LOG_PAYLOAD_UNAVAILABLE,
            responsePayload: summarizeMetaResponsePayload(logData.responsePayload) ?? undefined,
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
