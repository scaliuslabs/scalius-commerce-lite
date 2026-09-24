// src/modules/settings/settings.service.ts
// Currency configuration and order-notification rules. Storage lives in
// ./documents; this module owns the cross-provider rules for enabling a
// notification channel.

import { getDecimalPlaces } from "@scalius/shared/currency";
import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import { isReady } from "@scalius/shared/readiness";
import {
    describeNotificationProviderBlock,
    getNotificationProviderBlock,
    type NotificationProviderHealthChannel,
} from "../notifications/notification-provider-health";
import { getWhatsAppCloudApiSettings } from "../../integrations/whatsapp";
import { getSmsProviderReadiness } from "../../integrations/sms";
import { getEmailProviderReadiness } from "../../integrations/email";
import {
    currencyDocument,
    DEFAULT_ADMIN_NOTIFICATION_CHANNELS,
    DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS,
    normalizeNotificationChannelRules,
    notificationsDocument,
    STAFF_EMAIL_RECIPIENTS_MAX,
    type NotificationChannelRules,
    type NotificationSettings,
} from "./documents";

// ─────────────────────────────────────────
// Currency
// ─────────────────────────────────────────

export interface CurrencyConfig {
    code: string;
    symbol: string;
    usdExchangeRate: number;
    decimalPlaces: number;
}

export async function getCurrencyConfig(db: Database): Promise<CurrencyConfig> {
    const currency = await currencyDocument.read(db);
    const usdExchangeRate = Number(currency.usdExchangeRate);
    return {
        code: currency.currencyCode,
        symbol: currency.currencySymbol,
        usdExchangeRate: Number.isFinite(usdExchangeRate) && usdExchangeRate > 0 ? usdExchangeRate : 1,
        decimalPlaces: getDecimalPlaces(currency.currencyCode),
    };
}

// ─────────────────────────────────────────
// Customer order notifications
// ─────────────────────────────────────────

const CUSTOMER_CHANNELS = ["email", "sms", "whatsapp"] as const;
type CustomerChannel = (typeof CUSTOMER_CHANNELS)[number];

export interface OrderWhatsAppTemplateSettings {
    templateName: string;
    languageCode: string;
}

/** Event -> enabled customer channels. */
export async function getNotificationChannels(db: Database): Promise<NotificationChannelRules> {
    return (await notificationsDocument.read(db)).orderChannels;
}

/** The whole notifications document with the revision an editor must send back. */
export async function getNotificationSettings(
    db: Database,
): Promise<NotificationSettings & { revision: number }> {
    const { value, revision } = await notificationsDocument.readDetailed(db);
    return { ...value, revision };
}

/**
 * Accepts the dashboard's boolean maps or canonical arrays. A channel can only
 * be newly enabled while its provider is configured and not paused. The rules
 * and the WhatsApp order template are saved together in one write.
 */
export async function updateNotificationChannels(
    db: Database,
    input: Record<string, unknown>,
    encryptionKey?: string,
    env?: Record<string, unknown>,
    options: { whatsappTemplate?: OrderWhatsAppTemplateSettings; expectedRevision?: number } = {},
): Promise<NotificationChannelRules> {
    const currentChannels = await getNotificationChannels(db);
    const requested = normalizeNotificationChannelRules(input, DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS, null);
    if (Object.values(requested).some((channels) => channels.includes("push"))) {
        throw new ValidationError("Customer push notifications are not implemented yet. Use Email, SMS, or WhatsApp for customer order notifications.");
    }
    const channels = normalizeNotificationChannelRules(input, DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS, CUSTOMER_CHANNELS);
    const template = options.whatsappTemplate ? normalizeWhatsAppTemplate(options.whatsappTemplate) : null;

    if (channelWasEnabled(channels, currentChannels, "email")) {
        const emailReadiness = await getEmailProviderReadiness({ db, encryptionKey, env });
        if (!isReady(emailReadiness)) {
            throw new ValidationError(
                emailReadiness.issues[0]?.message
                    ?? "Configure a transactional email provider before enabling email order notifications.",
            );
        }
        await assertNotificationProviderNotPaused(db, { channel: "email", provider: emailReadiness.provider });
        await assertNotificationProviderNotPaused(db, { channel: "email", provider: "email" });
    }

    if (channelWasEnabled(channels, currentChannels, "sms")) {
        const smsReadiness = await getSmsProviderReadiness(db, encryptionKey);
        if (!isReady(smsReadiness)) {
            const detail = smsReadiness.issues[0]?.message;
            throw new ValidationError(
                `Configure an active SMS provider before enabling SMS order notifications.${detail ? ` ${detail}` : ""}`,
            );
        }
        if (smsReadiness.activeProvider) {
            await assertNotificationProviderNotPaused(db, { channel: "sms", provider: smsReadiness.activeProvider });
        }
    }

    if (channelWasEnabled(channels, currentChannels, "whatsapp")) {
        if (!(await isWhatsAppCloudApiConfigured(db, encryptionKey))) {
            throw new ValidationError("Configure Meta WhatsApp Cloud API credentials before enabling WhatsApp order notifications.");
        }
        await assertNotificationProviderNotPaused(db, { channel: "whatsapp", provider: "whatsapp" });
    }

    const { value } = await notificationsDocument.write(db, {
        orderChannels: channels,
        ...(template
            ? { whatsappOrderTemplateName: template.templateName, whatsappOrderTemplateLanguage: template.languageCode }
            : {}),
    }, {}, { expectedRevision: options.expectedRevision });
    return value.orderChannels;
}

function channelWasEnabled(
    channels: NotificationChannelRules,
    currentChannels: NotificationChannelRules,
    channel: CustomerChannel,
): boolean {
    return Object.entries(channels).some(([event, selected]) =>
        selected.includes(channel) && !currentChannels[event]?.includes(channel),
    );
}

async function assertNotificationProviderNotPaused(
    db: Database,
    options: { channel: NotificationProviderHealthChannel; provider: string },
): Promise<void> {
    const block = await getNotificationProviderBlock(db, options);
    if (block) throw new ValidationError(describeNotificationProviderBlock(block));
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
    const stored = await notificationsDocument.read(db);
    return {
        templateName: stored.whatsappOrderTemplateName,
        languageCode: stored.whatsappOrderTemplateLanguage,
    };
}

function normalizeWhatsAppTemplate(input: OrderWhatsAppTemplateSettings): OrderWhatsAppTemplateSettings {
    const templateName = input.templateName.trim();
    const languageCode = input.languageCode.trim();
    if (!/^[a-z0-9_]{1,512}$/.test(templateName)) {
        throw new ValidationError("WhatsApp order template name must use lowercase letters, numbers, and underscores.");
    }
    if (!/^[a-z]{2}(?:_[A-Z]{2})?$/.test(languageCode)) {
        throw new ValidationError("WhatsApp order template language must look like en_US or bn.");
    }
    return { templateName, languageCode };
}

// ─────────────────────────────────────────
// Staff order notifications: push per event, email for every new order
// ─────────────────────────────────────────

/** Event -> enabled staff channels. Defaults to push for new/cancelled orders and support requests. */
export async function getAdminNotificationChannels(db: Database): Promise<NotificationChannelRules> {
    return (await notificationsDocument.read(db)).adminChannels;
}

const STAFF_EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export async function updateAdminNotificationChannels(
    db: Database,
    input: { channels: Record<string, unknown>; emailRecipients: readonly string[] },
    options: { expectedRevision?: number } = {},
): Promise<Pick<NotificationSettings, "adminChannels" | "staffEmailRecipients">> {
    const adminChannels = normalizeNotificationChannelRules(input.channels, DEFAULT_ADMIN_NOTIFICATION_CHANNELS, ["push"]);
    const staffEmailRecipients: string[] = [];
    const issues: Array<{ path: Array<string | number>; message: string }> = [];
    input.emailRecipients.forEach((raw, index) => {
        const email = raw.trim().toLowerCase();
        if (!STAFF_EMAIL_PATTERN.test(email) || email.length > 254) {
            issues.push({ path: ["emailRecipients", index], message: "Enter an email like name@example.com." });
        } else if (!staffEmailRecipients.includes(email)) {
            staffEmailRecipients.push(email);
        }
    });
    if (staffEmailRecipients.length > STAFF_EMAIL_RECIPIENTS_MAX) {
        issues.push({ path: ["emailRecipients"], message: `Add up to ${STAFF_EMAIL_RECIPIENTS_MAX} email addresses.` });
    }
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, { issues });

    const { value } = await notificationsDocument.write(
        db,
        { adminChannels, staffEmailRecipients },
        {},
        { expectedRevision: options.expectedRevision },
    );
    return { adminChannels: value.adminChannels, staffEmailRecipients: value.staffEmailRecipients };
}
