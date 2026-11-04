import { type Database } from "@scalius/database/client";
import { metaConversionsLogs } from "@scalius/database/schema";
import { metaConversionsDocument, type MetaConversionsSettings } from "../../modules/settings";
import { eq, inArray, lt, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";

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

/** A request summary (a JSON object) with the events one row stands for, when more than one. */
function withSampleWeight(summary: string, weight: number): string {
    if (weight <= 1) return summary;
    try {
        const parsed = JSON.parse(summary) as Record<string, unknown>;
        return JSON.stringify({ ...parsed, sampleWeight: weight });
    } catch {
        return JSON.stringify({ available: false, sampleWeight: weight });
    }
}

/**
 * The Meta Conversions API settings with the access token strictly decrypted
 * (empty when unreadable), or null when never saved or unreadable.
 */
export async function getCapiSettings(
    db: Database,
    encryptionKey?: string,
): Promise<MetaConversionsSettings | null> {
    try {
        const stored = await metaConversionsDocument.readDetailed(db, { encryptionKey });
        return stored.stored ? stored.value : null;
    } catch (error: unknown) {
        console.error("Error fetching Meta CAPI settings:", error);
        return null;
    }
}

/**
 * One success in this many is logged when a caller samples its successes
 * (browser events); each logged one carries the weight in its request
 * summary (`sampleWeight`). Failures are always logged.
 */
export const CAPI_SUCCESS_LOG_SAMPLE = 100;

/** Server randomness in [0, 1): the caller of a browser event cannot steer it. */
function serverDraw(): number {
    return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

export interface CapiLogOptions {
    /**
     * `every`: log every success (the server's own events: order purchases
     * and staff test events). `sample` (the default, every browser event):
     * one success in CAPI_SUCCESS_LOG_SAMPLE, chosen by server randomness,
     * so a page view costs no D1 write whatever event id it sends.
     */
    successLog?: "every" | "sample";
    /** Test seam: a draw in [0, 1); a success is sampled when it is below 1 / CAPI_SUCCESS_LOG_SAMPLE. */
    draw?: () => number;
}

/**
 * How many events one success row stands for in a count (tracking health):
 * the `sampleWeight` its request summary stores, else one (rows logged in full,
 * and every row written before sampling).
 */
export function capiSuccessWeightSql(requestPayloadColumn: SQL | AnyColumn): SQL {
    return sql`(case when json_valid(${requestPayloadColumn}) then coalesce(cast(json_extract(${requestPayloadColumn}, '$.sampleWeight') as integer), 1) else 1 end)`;
}

/**
 * Logs a CAPI event: every failure, and every success or a sample of them as
 * the caller says (`CapiLogOptions`). It never deletes: expired rows go in
 * the maintenance sweep (`purgeExpiredCapiLogs`), a bounded delete, not a
 * whole-table delete on every event.
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
    /** Unused: retention is the maintenance sweep's (callers may still pass it). */
    _retentionHours?: number,
    options: CapiLogOptions = {},
): Promise<void> {
    const sampled = logData.status === "success" && options.successLog !== "every";
    if (sampled && (options.draw ?? serverDraw)() >= 1 / CAPI_SUCCESS_LOG_SAMPLE) return;
    try {
        const { eventTime } = logData;
        const safeLogData = {
            eventId: logData.eventId.slice(0, 200),
            eventName: logData.eventName.slice(0, 100),
            status: logData.status,
            requestPayload: withSampleWeight(
                summarizeMetaRequestPayload(logData.requestPayload) ?? SAFE_META_LOG_PAYLOAD_UNAVAILABLE,
                sampled ? CAPI_SUCCESS_LOG_SAMPLE : 1,
            ),
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

/** Expired log rows one sweep run deletes at most (Paid; Free scales it). */
export const CAPI_LOG_PURGE_LIMIT = 200;

/**
 * Deletes up to `limit` log rows older than the store's retention
 * (`logRetentionDays`) through the `created_at` range: the maintenance
 * sweep's bounded share. Returns the rows deleted.
 */
export async function purgeExpiredCapiLogs(
    db: Database,
    options: { nowSeconds: number; limit: number },
): Promise<number> {
    const { logRetentionDays } = await metaConversionsDocument.read(db);
    const days = Math.max(1, Math.min(365, Math.floor(Number(logRetentionDays) || 30)));
    const cutoff = new Date((options.nowSeconds - days * 86_400) * 1000);
    const expired = db.select({ id: metaConversionsLogs.id }).from(metaConversionsLogs)
        .where(lt(metaConversionsLogs.createdAt, cutoff))
        .limit(Math.max(1, Math.floor(options.limit)));
    const deleted = await db.delete(metaConversionsLogs)
        .where(inArray(metaConversionsLogs.id, expired))
        .returning({ id: metaConversionsLogs.id });
    return deleted.length;
}

/**
 * Deletes every log row older than the retention at once: the staff's manual
 * cleanup only, never a buyer's request.
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
