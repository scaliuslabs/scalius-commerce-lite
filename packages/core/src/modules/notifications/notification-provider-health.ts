import type { Database } from "@scalius/database/client";
import { orderNotificationDeliveryReceipts, settings } from "@scalius/database/schema";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";

export type NotificationProviderHealthChannel = "email" | "sms" | "whatsapp" | "push";

export interface NotificationProviderBlock {
    channel: NotificationProviderHealthChannel;
    provider: string;
    reason: string;
    blockedAt: number;
    source?: "marker" | "receipt";
}

const PROVIDER_HEALTH_CATEGORY = "notification_provider_health";
const MAX_REASON_LENGTH = 240;
const RECENT_RECEIPT_SCAN_LIMIT = 25;
const RECOVERABLE_SETTINGS_CATEGORIES: Partial<Record<NotificationProviderHealthChannel, string[]>> = {
    email: ["email"],
    sms: ["sms"],
    whatsapp: ["whatsapp"],
    push: ["firebase"],
};

export async function getNotificationProviderBlock(
  db: Database,
  options: {
    channel: NotificationProviderHealthChannel;
    provider: string;
  },
): Promise<NotificationProviderBlock | null> {
    const row = await db
        .select({ value: settings.value })
        .from(settings)
        .where(and(
            eq(settings.category, PROVIDER_HEALTH_CATEGORY),
            eq(settings.key, providerHealthKey(options.channel, options.provider)),
        ))
        .get();

    if (row?.value) return parseProviderBlock(row.value);
    return await recoverProviderBlockFromReceipts(db, options);
}

export async function markNotificationProviderBlocked(
  db: Database,
  options: {
    channel: NotificationProviderHealthChannel;
    provider: string;
    reason: string;
  },
): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const value: NotificationProviderBlock = {
        channel: options.channel,
        provider: normalizeProvider(options.provider),
        reason: normalizeReason(options.reason),
        blockedAt: now,
    };

    await db
        .insert(settings)
        .values({
            id: crypto.randomUUID(),
            key: providerHealthKey(value.channel, value.provider),
            value: JSON.stringify(value),
            type: "json",
            category: PROVIDER_HEALTH_CATEGORY,
        })
        .onConflictDoUpdate({
            target: [settings.key, settings.category],
            set: { value: JSON.stringify(value), updatedAt: sql`unixepoch()` },
        });
}

export async function clearNotificationProviderBlocks(
  db: Database,
  options: {
    channel: NotificationProviderHealthChannel;
    provider?: string;
  },
): Promise<void> {
    const key = options.provider
        ? providerHealthKey(options.channel, options.provider)
        : `${options.channel}:%`;

    await db
        .delete(settings)
        .where(and(
            eq(settings.category, PROVIDER_HEALTH_CATEGORY),
            options.provider
                ? eq(settings.key, key)
                : like(settings.key, key),
        ));
}

export function isNotificationProviderBreakerFailure(value: string | null | undefined): boolean {
    const status = value?.trim();
    if (!status) return false;

    return PROVIDER_BREAKER_PATTERNS.some((pattern) => pattern.test(status));
}

export function describeNotificationProviderBlock(
  block: Pick<NotificationProviderBlock, "channel" | "provider" | "reason">,
): string {
    const channelLabel = humanizeChannel(block.channel);
    const providerLabel = block.provider ? ` via ${block.provider}` : "";
    return `${channelLabel}${providerLabel} sending is paused after a provider setup failure. Save corrected ${channelLabel.toLowerCase()} settings to resume notifications.`;
}

function providerHealthKey(
  channel: NotificationProviderHealthChannel,
  provider: string,
): string {
    return `${channel}:${normalizeProvider(provider)}`;
}

function normalizeProvider(provider: string): string {
    return provider.trim().toLowerCase() || "unknown";
}

function normalizeReason(reason: string): string {
    const normalized = maskSensitiveReasonText(reason).replace(/\s+/g, " ").trim();
    return normalized.slice(0, MAX_REASON_LENGTH) || "provider_setup_failure";
}

function parseProviderBlock(value: string): NotificationProviderBlock | null {
    try {
        const parsed = JSON.parse(value) as Partial<NotificationProviderBlock>;
        const channel = parsed.channel;
        if (
            channel !== "email" &&
            channel !== "sms" &&
            channel !== "whatsapp" &&
            channel !== "push"
        ) {
            return null;
        }

        return {
            channel,
            provider: normalizeProvider(String(parsed.provider ?? "")),
            reason: normalizeReason(String(parsed.reason ?? "")),
            blockedAt: Number.isFinite(Number(parsed.blockedAt))
                ? Number(parsed.blockedAt)
                : 0,
            source: "marker",
        };
    } catch {
        return null;
    }
}

async function recoverProviderBlockFromReceipts(
  db: Database,
  options: {
    channel: NotificationProviderHealthChannel;
    provider: string;
  },
): Promise<NotificationProviderBlock | null> {
    const settingsCategories = RECOVERABLE_SETTINGS_CATEGORIES[options.channel];
    if (!settingsCategories?.length) return null;

    const provider = normalizeProvider(options.provider);
    const latestSettingsUpdatedAt = await getLatestSettingsUpdateTime(db, settingsCategories);
    const rows = await db
        .select({
            providerStatus: orderNotificationDeliveryReceipts.providerStatus,
            rawResponse: orderNotificationDeliveryReceipts.rawResponse,
            lastError: orderNotificationDeliveryReceipts.lastError,
            skippedAt: orderNotificationDeliveryReceipts.skippedAt,
            failedAt: orderNotificationDeliveryReceipts.failedAt,
            updatedAt: orderNotificationDeliveryReceipts.updatedAt,
        })
        .from(orderNotificationDeliveryReceipts)
        .where(and(
            eq(orderNotificationDeliveryReceipts.channel, options.channel),
            eq(orderNotificationDeliveryReceipts.provider, provider),
            inArray(orderNotificationDeliveryReceipts.status, ["skipped", "failed"]),
        ))
        .orderBy(desc(orderNotificationDeliveryReceipts.updatedAt))
        .limit(RECENT_RECEIPT_SCAN_LIMIT)
        .all();

    for (const row of rows) {
        const blockedAt = Math.max(
            timestampSeconds(row.skippedAt),
            timestampSeconds(row.failedAt),
            timestampSeconds(row.updatedAt),
        );
        if (blockedAt <= latestSettingsUpdatedAt) continue;

        const reason = [
            row.providerStatus,
            row.rawResponse,
            row.lastError,
        ].find((value): value is string =>
            typeof value === "string" && isNotificationProviderBreakerFailure(value),
        );
        if (!reason) continue;

        return {
            channel: options.channel,
            provider,
            reason: normalizeReason(reason),
            blockedAt,
            source: "receipt",
        };
    }

    return null;
}

async function getLatestSettingsUpdateTime(
  db: Database,
  categories: string[],
): Promise<number> {
    const row = await db
        .select({ updatedAt: settings.updatedAt })
        .from(settings)
        .where(inArray(settings.category, categories))
        .orderBy(desc(settings.updatedAt))
        .limit(1)
        .get();

    return timestampSeconds(row?.updatedAt);
}

function timestampSeconds(value: unknown): number {
    if (value instanceof Date) {
        return Math.floor(value.getTime() / 1000);
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? Math.floor(value) : 0;
    }
    if (typeof value === "string") {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return Math.floor(numeric);
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
    }
    return 0;
}

function humanizeChannel(channel: NotificationProviderHealthChannel): string {
    if (channel === "sms") return "SMS";
    if (channel === "whatsapp") return "WhatsApp";
    if (channel === "push") return "Admin push";
    return "Email";
}

function maskSensitiveReasonText(value: string): string {
    return maskPhoneLikeText(maskEmailLikeText(value));
}

function maskEmailLikeText(value: string): string {
    let output = "";
    let copiedThrough = 0;

    for (let at = value.indexOf("@"); at >= 0; at = value.indexOf("@", at + 1)) {
        let start = at;
        while (start > copiedThrough && isEmailLocalCharacter(value[start - 1])) start -= 1;

        let end = at + 1;
        while (end < value.length && isEmailDomainCharacter(value[end])) end += 1;
        const domain = value.slice(at + 1, end);
        const lastDot = domain.lastIndexOf(".");
        if (start === at || lastDot <= 0 || lastDot >= domain.length - 2) continue;

        output += value.slice(copiedThrough, start) + "[email]";
        copiedThrough = end;
    }

    return output + value.slice(copiedThrough);
}

function isEmailLocalCharacter(character: string | undefined): boolean {
    if (!character) return false;
    return (
        isAsciiLetterOrDigit(character)
        || character === "."
        || character === "_"
        || character === "%"
        || character === "+"
        || character === "-"
    );
}

function isEmailDomainCharacter(character: string | undefined): boolean {
    if (!character) return false;
    return (
        isAsciiLetterOrDigit(character)
        || character === "."
        || character === "-"
    );
}

function isAsciiLetterOrDigit(character: string): boolean {
    const code = character.charCodeAt(0);
    return (code >= 48 && code <= 57)
        || (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122);
}

function maskPhoneLikeText(value: string): string {
    let output = "";
    let cursor = 0;

    while (cursor < value.length) {
        const start = cursor;
        if (value[cursor] !== "+" && !isAsciiDigit(value[cursor])) {
            output += value[cursor];
            cursor += 1;
            continue;
        }

        let end = cursor;
        let digits = 0;
        let lastDigitEnd = cursor;
        while (end < value.length && isPhoneCandidateCharacter(value[end])) {
            if (isAsciiDigit(value[end])) {
                digits += 1;
                lastDigitEnd = end + 1;
            }
            end += 1;
        }

        if (digits >= 10) {
            output += "[phone]" + value.slice(lastDigitEnd, end);
            cursor = end;
        } else {
            output += value.slice(start, Math.max(start + 1, end));
            cursor = Math.max(start + 1, end);
        }
    }

    return output;
}

function isAsciiDigit(character: string | undefined): boolean {
    return Boolean(character && character >= "0" && character <= "9");
}

function isPhoneCandidateCharacter(character: string | undefined): boolean {
    return isAsciiDigit(character)
        || character === "+"
        || character === " "
        || character === "\t"
        || character === "("
        || character === ")"
        || character === "."
        || character === "-";
}

const PROVIDER_BREAKER_PATTERNS = [
    /no configured .*provider/i,
    /no active .*provider/i,
    /provider .*not ready/i,
    /not configured/i,
    /missing[_\s-]?credentials/i,
    /looks like a placeholder/i,
    /auth(?:orization|entication)?\s+(?:required|failed|error)/i,
    /unauthori[sz]ed/i,
    /forbidden/i,
    /invalid\s+(?:api\s*)?(?:key|token|credential)/i,
    /api\s*(?:key|token)\s+(?:invalid|expired|missing|not configured)/i,
    /could not be decrypted/i,
    /mismatched credential/i,
    /mismatch(?:ed)?\s+credential/i,
    /invalid[_\s-]?grant/i,
    /private key/i,
    /service account/i,
    /permission/i,
    /sender(?:\s+id)?(?:\s+is)?\s+(?:not\s+approved|rejected|invalid|mismatch)/i,
    /account\s+(?:expired|suspended|inactive|disabled)/i,
    /\b(?:http|status|code|error)[^0-9]*(?:400|401|402|403|404|405|422)\b/i,
];
