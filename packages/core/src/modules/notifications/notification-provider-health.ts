import type { Database } from "@scalius/database/client";
import { settings } from "@scalius/database/schema";
import { and, eq, like, sql } from "drizzle-orm";

export type NotificationProviderHealthChannel = "email" | "sms" | "whatsapp" | "push";

export interface NotificationProviderBlock {
    channel: NotificationProviderHealthChannel;
    provider: string;
    reason: string;
    blockedAt: number;
}

const PROVIDER_HEALTH_CATEGORY = "notification_provider_health";
const MAX_REASON_LENGTH = 240;

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

    if (!row?.value) return null;
    return parseProviderBlock(row.value);
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
    return `${channelLabel}${providerLabel} sending is paused after a provider setup failure. Save corrected ${channelLabel.toLowerCase()} settings to resume notifications. Last error: ${block.reason}`;
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
    const normalized = reason.replace(/\s+/g, " ").trim();
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
        };
    } catch {
        return null;
    }
}

function humanizeChannel(channel: NotificationProviderHealthChannel): string {
    if (channel === "sms") return "SMS";
    if (channel === "whatsapp") return "WhatsApp";
    if (channel === "push") return "Admin push";
    return "Email";
}

const PROVIDER_BREAKER_PATTERNS = [
    /auth(?:orization|entication)?\s+(?:required|failed|error)/i,
    /unauthori[sz]ed/i,
    /forbidden/i,
    /invalid\s+(?:api\s*)?(?:key|token|credential)/i,
    /api\s*(?:key|token)\s+(?:invalid|expired|missing|not configured)/i,
    /could not be decrypted/i,
    /mismatched credential/i,
    /invalid[_\s-]?grant/i,
    /private key/i,
    /service account/i,
    /permission/i,
    /sender(?:\s+id)?(?:\s+is)?\s+(?:not\s+approved|rejected|invalid|mismatch)/i,
    /account\s+(?:expired|suspended|inactive|disabled)/i,
    /\b(?:http|status|code|error)[^0-9]*(?:401|402|403|405)\b/i,
];
