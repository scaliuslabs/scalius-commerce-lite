// src/modules/settings/settings.service.ts
// Central service for all store settings: site config, storefront URLs, currency.
// Settings that lived in shared/ or in Astro API routes are consolidated here.

import { siteSettings, settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { buildStorefrontPath } from "@scalius/shared/storefront-url";
import { getDecimalPlaces } from "@scalius/shared/currency";
import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import { ORDER_NOTIFICATION_TYPES } from "../notifications/notification-types";
import { getWhatsAppCloudApiSettings } from "../../integrations/whatsapp";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface CurrencyConfig {
    code: string;
    symbol: string;
    usdExchangeRate: number;
    decimalPlaces: number;
}

const DEFAULT_CURRENCY: CurrencyConfig = {
    code: "BDT",
    symbol: "৳",
    usdExchangeRate: 1,
    decimalPlaces: 2,
};

// ─────────────────────────────────────────
// Storefront URL
// ─────────────────────────────────────────

/**
 * Fetches the storefront base URL from the DB and builds a full path.
 * Use this instead of the old shared/storefront-url getStorefrontPath().
 */
export async function getStorefrontPath(
    db: Database,
    path: string,
    kv?: KVNamespace | null,
): Promise<string> {
    const baseUrl = await getStorefrontBaseUrl(db, kv);
    return buildStorefrontPath(path, baseUrl);
}

/**
 * Returns the storefront base URL from DB, with optional KV cache.
 */
export async function getStorefrontBaseUrl(
    db: Database,
    kv?: KVNamespace | null,
): Promise<string> {
    if (kv) {
        try {
            const cached = await kv.get("gw:storefront_url");
            if (cached) return cached;
        } catch (e: unknown) {
            console.warn("[Settings] KV read failed for storefront_url:", e instanceof Error ? e.message : e);
        }
    }

    try {
        const [row] = await db
            .select({ storefrontUrl: siteSettings.storefrontUrl })
            .from(siteSettings)
            .limit(1);

        const url = row?.storefrontUrl || "/";

        if (kv) {
            try {
                await kv.put("gw:storefront_url", url, { expirationTtl: 300 });
            } catch (e: unknown) {
                console.warn("[Settings] KV write failed for storefront_url:", e instanceof Error ? e.message : e);
            }
        }

        return url;
    } catch (e: unknown) {
        console.error("[Settings] DB read failed for storefront_url:", e instanceof Error ? e.message : e);
        return "/";
    }
}

// ─────────────────────────────────────────
// Currency
// ─────────────────────────────────────────

/**
 * Fetches currency settings from DB, with optional KV cache.
 * This is the canonical implementation; shared/currency.ts is now a thin re-export.
 */
export async function getCurrencyConfig(
    db: Database,
    kv?: KVNamespace | null,
): Promise<CurrencyConfig> {
    if (kv) {
        try {
            const cached = await kv.get("gw:currency");
            if (cached) return JSON.parse(cached);
        } catch (e: unknown) {
            console.warn("[Settings] KV read failed for currency:", e instanceof Error ? e.message : e);
        }
    }

    try {
        const rows = await db
            .select({ key: settings.key, value: settings.value })
            .from(settings)
            .where(eq(settings.category, "currency"))
            .all();

        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
        const code = map.currency_code ?? DEFAULT_CURRENCY.code;
        const config: CurrencyConfig = {
            code,
            symbol: map.currency_symbol ?? DEFAULT_CURRENCY.symbol,
            usdExchangeRate: map.usd_exchange_rate
                ? parseFloat(map.usd_exchange_rate)
                : DEFAULT_CURRENCY.usdExchangeRate,
            decimalPlaces: getDecimalPlaces(code),
        };

        if (kv) {
            try {
                await kv.put("gw:currency", JSON.stringify(config), { expirationTtl: 300 });
            } catch (e: unknown) {
                console.warn("[Settings] KV write failed for currency:", e instanceof Error ? e.message : e);
            }
        }

        return config;
    } catch (e: unknown) {
        console.error("[Settings] DB read failed for currency:", e instanceof Error ? e.message : e);
        return DEFAULT_CURRENCY;
    }
}

// ─────────────────────────────────────────
// Site Settings (header, footer, theme, etc.)
// ─────────────────────────────────────────

const SITE_SETTINGS_CACHE_KEY = "gw:site_settings";

/**
 * Returns the full siteSettings row (contains headerConfig, footerConfig, storefrontUrl, etc.)
 * With optional KV cache (5-minute TTL).
 */
export async function getSiteSettings(
    db: Database,
    kv?: KVNamespace | null,
) {
    if (kv) {
        try {
            const cached = await kv.get(SITE_SETTINGS_CACHE_KEY);
            if (cached) return JSON.parse(cached);
        } catch (e: unknown) {
            console.warn("[Settings] KV read failed for site_settings:", e instanceof Error ? e.message : e);
        }
    }

    const [row] = await db
        .select()
        .from(siteSettings)
        .limit(1);

    const result = row ?? null;

    if (kv && result) {
        try {
            await kv.put(SITE_SETTINGS_CACHE_KEY, JSON.stringify(result), { expirationTtl: 300 });
        } catch (e: unknown) {
            console.warn("[Settings] KV write failed for site_settings:", e instanceof Error ? e.message : e);
        }
    }

    return result;
}

/**
 * Invalidate the site settings KV cache.
 * Call after any admin update to the siteSettings table.
 */
export async function invalidateSiteSettingsCache(kv?: KVNamespace | null): Promise<void> {
    if (!kv) return;
    try {
        await kv.delete(SITE_SETTINGS_CACHE_KEY);
    } catch (e: unknown) {
        console.warn("[Settings] KV delete failed for site_settings:", e instanceof Error ? e.message : e);
    }
}

// ─────────────────────────────────────────
// Notification Channel Preferences
// ─────────────────────────────────────────

const NOTIFICATIONS_CATEGORY = "notifications";
const VALID_NOTIFICATION_CHANNELS = ["email", "sms", "whatsapp", "push"] as const;

export interface OrderWhatsAppTemplateSettings {
    templateName: string;
    languageCode: string;
}

export const DEFAULT_ORDER_WHATSAPP_TEMPLATE_SETTINGS: OrderWhatsAppTemplateSettings = {
    templateName: "order_status_update",
    languageCode: "en_US",
};

const DEFAULT_NOTIFICATION_CHANNELS: Record<string, string[]> = Object.fromEntries(
    ORDER_NOTIFICATION_TYPES.map((type) => [type, ["email"]]),
);

/**
 * Get notification channel preferences per order status.
 * Returns a map of status -> enabled channels (string arrays).
 *
 * The admin UI stores channels as boolean maps (Record<StatusKey, Record<ChannelKey, boolean>>).
 * This function normalizes stored data back to string arrays for the notification service,
 * and the API route wraps it as { channels: ... } for the UI to consume.
 */
export async function getNotificationChannels(
    db: Database,
): Promise<Record<string, string[]>> {
    const row = await db
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.category, NOTIFICATIONS_CATEGORY), eq(settings.key, "order_channels")))
        .get();

    if (!row?.value) return DEFAULT_NOTIFICATION_CHANNELS;
    try {
        const parsed = JSON.parse(row.value);
        // Normalize: the UI may have stored boolean maps instead of string arrays
        return normalizeParsedChannels(parsed);
    } catch (e: unknown) {
        console.error("[Settings] Failed to parse notification channels JSON:", e instanceof Error ? e.message : e);
        return DEFAULT_NOTIFICATION_CHANNELS;
    }
}

/**
 * Normalize channel data which may be in boolean-map format (from the UI)
 * or string-array format (canonical). Returns string-array format.
 */
function normalizeParsedChannels(parsed: unknown): Record<string, string[]> {
    if (!parsed || typeof parsed !== "object") return DEFAULT_NOTIFICATION_CHANNELS;

    // If the UI wrapped it in { channels: ... }, unwrap
    const record = (parsed as Record<string, unknown>).channels
        ? (parsed as Record<string, unknown>).channels as Record<string, unknown>
        : parsed as Record<string, unknown>;

    const result: Record<string, string[]> = { ...DEFAULT_NOTIFICATION_CHANNELS };
    for (const [status, value] of Object.entries(record)) {
        if (!(ORDER_NOTIFICATION_TYPES as readonly string[]).includes(status)) continue;
        if (Array.isArray(value)) {
            // Already in string array format
            result[status] = value.filter((v): v is string => typeof v === "string");
        } else if (value && typeof value === "object") {
            // Boolean map format from UI: { email: true, sms: false, ... }
            result[status] = Object.entries(value as Record<string, boolean>)
                .filter(([, enabled]) => enabled)
                .map(([channel]) => channel);
        }
    }
    return result;
}

/**
 * Update notification channel preferences.
 * Accepts both UI format (boolean maps, possibly wrapped in { channels: ... })
 * and canonical format (string arrays). Normalizes and validates before saving.
 */
export async function updateNotificationChannels(
    db: Database,
    input: Record<string, unknown>,
    encryptionKey?: string,
): Promise<Record<string, string[]>> {
    // Normalize from whatever format the UI sends
    const channels = normalizeParsedChannels(input);

    // Validate channel values against the known set
    for (const [status, statusChannels] of Object.entries(channels)) {
        channels[status] = statusChannels.filter((c) =>
            (VALID_NOTIFICATION_CHANNELS as readonly string[]).includes(c),
        );
    }

    if (channelsRequireWhatsApp(channels) && !(await isWhatsAppCloudApiConfigured(db, encryptionKey))) {
        throw new ValidationError("Configure Meta WhatsApp Cloud API credentials before enabling WhatsApp order notifications.");
    }

    // Import upsertSetting from gateway-settings (same pattern used by site-settings.service.ts)
    const { upsertSetting } = await import("../payments/gateway-settings");
    await upsertSetting(db, NOTIFICATIONS_CATEGORY, "order_channels", JSON.stringify(channels));
    return channels;
}

export async function isWhatsAppCloudApiConfigured(
    db: Database,
    encryptionKey?: string,
): Promise<boolean> {
    const config = await getWhatsAppCloudApiSettings(db, encryptionKey);
    return Boolean(config.accessTokenConfigured && config.phoneNumberId);
}

export async function getOrderWhatsAppTemplateSettings(
    db: Database,
): Promise<OrderWhatsAppTemplateSettings> {
    const rows = await db
        .select({ key: settings.key, value: settings.value })
        .from(settings)
        .where(eq(settings.category, NOTIFICATIONS_CATEGORY));

    const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return normalizeOrderWhatsAppTemplateSettings({
        templateName: map.whatsapp_order_template_name,
        languageCode: map.whatsapp_order_template_language,
    });
}

export async function updateOrderWhatsAppTemplateSettings(
    db: Database,
    input: Partial<OrderWhatsAppTemplateSettings>,
): Promise<OrderWhatsAppTemplateSettings> {
    const normalized = normalizeOrderWhatsAppTemplateSettings(input);
    const { upsertSetting } = await import("../payments/gateway-settings");
    await upsertSetting(
        db,
        NOTIFICATIONS_CATEGORY,
        "whatsapp_order_template_name",
        normalized.templateName,
    );
    await upsertSetting(
        db,
        NOTIFICATIONS_CATEGORY,
        "whatsapp_order_template_language",
        normalized.languageCode,
    );
    return normalized;
}

function normalizeOrderWhatsAppTemplateSettings(
    input: Partial<OrderWhatsAppTemplateSettings>,
): OrderWhatsAppTemplateSettings {
    const templateName = (input.templateName ?? DEFAULT_ORDER_WHATSAPP_TEMPLATE_SETTINGS.templateName).trim();
    const languageCode = (input.languageCode ?? DEFAULT_ORDER_WHATSAPP_TEMPLATE_SETTINGS.languageCode).trim();

    if (!/^[a-z0-9_]{1,512}$/.test(templateName)) {
        throw new ValidationError("WhatsApp order template name must use lowercase letters, numbers, and underscores.");
    }

    if (!/^[a-z]{2}(?:_[A-Z]{2})?$/.test(languageCode)) {
        throw new ValidationError("WhatsApp order template language must look like en_US or bn.");
    }

    return { templateName, languageCode };
}

function channelsRequireWhatsApp(channels: Record<string, string[]>): boolean {
    return Object.values(channels).some((statusChannels) =>
        statusChannels.includes("whatsapp"),
    );
}

// ─────────────────────────────────────────
// Admin Notification Channel Preferences
// ─────────────────────────────────────────

const VALID_ADMIN_CHANNELS = ["push"] as const;

const DEFAULT_ADMIN_CHANNELS: Record<string, string[]> = Object.fromEntries(
    ORDER_NOTIFICATION_TYPES.map((type) => [
        type,
        type === "order_created" || type === "order_cancelled" ? ["push"] : [],
    ]),
);

/**
 * Get admin notification channel preferences per order status.
 * Returns a map of status -> enabled channels (string arrays).
 * Defaults to push enabled for order_created and order_cancelled only.
 */
export async function getAdminNotificationChannels(
    db: Database,
): Promise<Record<string, string[]>> {
    const row = await db
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.category, NOTIFICATIONS_CATEGORY), eq(settings.key, "admin_channels")))
        .get();

    if (!row?.value) return DEFAULT_ADMIN_CHANNELS;
    try {
        const parsed = JSON.parse(row.value);
        return normalizeAdminChannels(parsed);
    } catch (e: unknown) {
        console.error("[Settings] Failed to parse admin notification channels JSON:", e instanceof Error ? e.message : e);
        return DEFAULT_ADMIN_CHANNELS;
    }
}

/**
 * Normalize admin channel data which may be in boolean-map format (from the UI)
 * or string-array format (canonical). Returns string-array format.
 */
function normalizeAdminChannels(parsed: unknown): Record<string, string[]> {
    if (!parsed || typeof parsed !== "object") return DEFAULT_ADMIN_CHANNELS;

    // If the UI wrapped it in { channels: ... }, unwrap
    const record = (parsed as Record<string, unknown>).channels
        ? (parsed as Record<string, unknown>).channels as Record<string, unknown>
        : parsed as Record<string, unknown>;

    const result: Record<string, string[]> = { ...DEFAULT_ADMIN_CHANNELS };
    for (const [status, value] of Object.entries(record)) {
        if (!(ORDER_NOTIFICATION_TYPES as readonly string[]).includes(status)) continue;
        if (Array.isArray(value)) {
            result[status] = value.filter((v): v is string => typeof v === "string");
        } else if (value && typeof value === "object") {
            result[status] = Object.entries(value as Record<string, boolean>)
                .filter(([, enabled]) => enabled)
                .map(([channel]) => channel);
        }
    }
    return result;
}

/**
 * Update admin notification channel preferences.
 * Accepts both UI format (boolean maps, possibly wrapped in { channels: ... })
 * and canonical format (string arrays). Normalizes and validates before saving.
 */
export async function updateAdminNotificationChannels(
    db: Database,
    input: Record<string, unknown>,
): Promise<Record<string, string[]>> {
    const channels = normalizeAdminChannels(input);

    // Validate channel values against the known admin set
    for (const [status, statusChannels] of Object.entries(channels)) {
        channels[status] = statusChannels.filter((c) =>
            (VALID_ADMIN_CHANNELS as readonly string[]).includes(c),
        );
    }

    const { upsertSetting } = await import("../payments/gateway-settings");
    await upsertSetting(db, NOTIFICATIONS_CATEGORY, "admin_channels", JSON.stringify(channels));
    return channels;
}
