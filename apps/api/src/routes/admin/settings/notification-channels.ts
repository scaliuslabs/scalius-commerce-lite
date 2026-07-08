// src/routes/admin/settings/notification-channels.ts
// Admin endpoints for notification channel configuration per order status.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    getNotificationChannels,
    updateNotificationChannels,
    getAdminNotificationChannels,
    updateAdminNotificationChannels,
    getOrderWhatsAppTemplateSettings,
    updateOrderWhatsAppTemplateSettings,
    isWhatsAppCloudApiConfigured,
} from "@scalius/core/modules/settings/settings.service";
import { getSmsProviderReadiness, type SmsProviderReadiness } from "@scalius/core/integrations/sms";
import { getEmailProviderReadiness, type EmailProviderReadiness } from "@scalius/core/integrations/email";
import { getFirebaseServiceAccountReadiness } from "@scalius/core/integrations/firebase/settings";
import {
    clearNotificationProviderBlocks,
    describeNotificationProviderBlock,
    getNotificationProviderBlock,
} from "@scalius/core/modules/notifications/notification-provider-health";
import {
    ORDER_NOTIFICATION_LABELS,
    ORDER_NOTIFICATION_TYPES,
    type OrderNotificationType,
} from "@scalius/core/modules/notifications/notification-types";
import type { Database } from "@scalius/database/client";
import { ok } from "../../../utils/api-response";
import { successEnvelope, errorResponses } from "../../../schemas/responses";
import { getCredentialEncryptionKey } from "../../../utils/encryption-key";
import { ValidationError } from "../../../utils/api-error";

const app = new OpenAPIHono<{ Bindings: Env }>();

const channelsSchema = z.record(z.string(), z.array(z.string()));

const whatsappTemplateSchema = z.object({
    templateName: z.string().min(1).max(512).regex(/^[a-z0-9_]+$/),
    languageCode: z.string().min(2).max(8).regex(/^[a-z]{2}(?:_[A-Z]{2})?$/),
});

const wrappedChannelsSchema = z.object({
    channels: channelsSchema,
});

const adminNotificationSettingsSchema = z.object({
    channels: channelsSchema,
    pushConfigured: z.boolean(),
    pushError: z.string().nullable(),
});

const customerNotificationSettingsSchema = z.object({
    channels: channelsSchema,
    whatsappTemplate: whatsappTemplateSchema,
    whatsappConfigured: z.boolean(),
    whatsappError: z.string().nullable(),
    emailConfigured: z.boolean(),
    emailError: z.string().nullable(),
    smsProviderConfigured: z.boolean(),
    smsProviderError: z.string().nullable(),
});

const updateCustomerNotificationSettingsSchema = z.object({
    channels: channelsSchema,
    whatsappTemplate: whatsappTemplateSchema.optional(),
});

const CUSTOMER_NOTIFICATION_CHANNELS = ["email", "sms", "whatsapp"] as const;
const MERCHANT_NOTIFICATION_CHANNELS = ["push"] as const;

type CustomerNotificationChannel = (typeof CUSTOMER_NOTIFICATION_CHANNELS)[number];
type MerchantNotificationChannel = (typeof MERCHANT_NOTIFICATION_CHANNELS)[number];

const SUMMARY_SOURCE = {
    path: "/api/v1/admin/settings/notification-channels/mcp-summary",
    permission: "settings.general.view",
    version: "admin-notification-settings-summary:v1",
} as const;

const REDACTION_LIMITS = {
    includesCredentials: false,
    includesMaskedSecrets: false,
    includesProviderIdentifiers: false,
    includesRawProviderErrors: false,
    includesRecipients: false,
    includesOrderIds: false,
    includesDeliveryReceipts: false,
    canMutate: false,
} as const;

const readinessSummarySchema = z.object({
    configured: z.boolean(),
    ready: z.boolean(),
    issueCount: z.number(),
});

const notificationEventSummarySchema = z.object({
    type: z.enum(ORDER_NOTIFICATION_TYPES),
    label: z.string(),
    enabledChannels: z.array(z.string()),
    hasAnyChannel: z.boolean(),
});

const adminNotificationSettingsSummarySchema = z.object({
    adminNotificationSettingsSummary: z.object({
        source: z.object({
            path: z.literal(SUMMARY_SOURCE.path),
            permission: z.literal(SUMMARY_SOURCE.permission),
            version: z.literal(SUMMARY_SOURCE.version),
        }),
        customer: z.object({
            supportedChannels: z.array(z.enum(CUSTOMER_NOTIFICATION_CHANNELS)),
            readiness: z.object({
                email: readinessSummarySchema,
                sms: readinessSummarySchema,
                whatsapp: readinessSummarySchema,
            }),
            enabledEventCounts: z.object({
                email: z.number(),
                sms: z.number(),
                whatsapp: z.number(),
            }),
            events: z.array(notificationEventSummarySchema),
            whatsappTemplate: z.object({
                configured: z.boolean(),
                languageConfigured: z.boolean(),
            }),
        }),
        merchant: z.object({
            supportedChannels: z.array(z.enum(MERCHANT_NOTIFICATION_CHANNELS)),
            readiness: z.object({
                push: readinessSummarySchema,
            }),
            enabledEventCounts: z.object({
                push: z.number(),
            }),
            events: z.array(notificationEventSummarySchema),
        }),
        totals: z.object({
            orderEventCount: z.number(),
            customerEventsWithAnyChannel: z.number(),
            merchantEventsWithPush: z.number(),
            readinessIssueCount: z.number(),
        }),
        limits: z.object({
            includesCredentials: z.literal(false),
            includesMaskedSecrets: z.literal(false),
            includesProviderIdentifiers: z.literal(false),
            includesRawProviderErrors: z.literal(false),
            includesRecipients: z.literal(false),
            includesOrderIds: z.literal(false),
            includesDeliveryReceipts: z.literal(false),
            canMutate: z.literal(false),
        }),
    }),
});

// GET /notification-channels
const getChannelsRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Settings"],
    summary: "Get notification channel settings per order status",
    responses: {
        200: {
            description: "Notification channel configuration",
            content: { "application/json": { schema: successEnvelope(customerNotificationSettingsSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(getChannelsRoute, async (c) => {
    const db = c.get("db");
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const channels = await getNotificationChannels(db);
    const whatsappTemplate = await getOrderWhatsAppTemplateSettings(db);
    const whatsappReadiness = await getWhatsAppNotificationReadiness(db, encryptionKey);
    const emailReadiness = await getEmailProviderReadiness({ db, encryptionKey, env: c.env as Record<string, unknown> });
    const emailNotificationReadiness = await getEmailNotificationReadiness(db, emailReadiness);
    const smsReadiness = await getSmsProviderReadiness(db, encryptionKey);
    const smsNotificationReadiness = await getSmsNotificationReadiness(db, smsReadiness);
    return ok(c, {
        channels,
        whatsappTemplate,
        whatsappConfigured: whatsappReadiness.configured,
        whatsappError: whatsappReadiness.error,
        emailConfigured: emailNotificationReadiness.configured,
        emailError: emailNotificationReadiness.error,
        smsProviderConfigured: smsNotificationReadiness.configured,
        smsProviderError: smsNotificationReadiness.error,
    });
});

// PUT /notification-channels
const updateChannelsRoute = createRoute({
    method: "put",
    path: "/",
    tags: ["Admin - Settings"],
    summary: "Update notification channel settings per order status",
    request: {
        body: { content: { "application/json": { schema: updateCustomerNotificationSettingsSchema } } },
    },
    responses: {
        200: {
            description: "Updated notification channel configuration",
            content: { "application/json": { schema: successEnvelope(customerNotificationSettingsSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(updateChannelsRoute, async (c) => {
    const db = c.get("db");
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const { channels, whatsappTemplate: whatsappTemplateInput } = c.req.valid("json");
    const whatsappTemplate = whatsappTemplateInput
        ? await updateOrderWhatsAppTemplateSettings(db, whatsappTemplateInput)
        : await getOrderWhatsAppTemplateSettings(db);
    if (whatsappTemplateInput) {
        await clearNotificationProviderBlocks(db, { channel: "whatsapp" });
    }
    const updated = await updateNotificationChannels(db, channels, encryptionKey, c.env as Record<string, unknown>);
    const whatsappReadiness = await getWhatsAppNotificationReadiness(db, encryptionKey);
    const emailReadiness = await getEmailProviderReadiness({ db, encryptionKey, env: c.env as Record<string, unknown> });
    const emailNotificationReadiness = await getEmailNotificationReadiness(db, emailReadiness);
    const smsReadiness = await getSmsProviderReadiness(db, encryptionKey);
    const smsNotificationReadiness = await getSmsNotificationReadiness(db, smsReadiness);
    return ok(c, {
        channels: updated,
        whatsappTemplate,
        whatsappConfigured: whatsappReadiness.configured,
        whatsappError: whatsappReadiness.error,
        emailConfigured: emailNotificationReadiness.configured,
        emailError: emailNotificationReadiness.error,
        smsProviderConfigured: smsNotificationReadiness.configured,
        smsProviderError: smsNotificationReadiness.error,
    });
});

// GET /notification-channels/admin-channels
const getAdminChannelsRoute = createRoute({
    method: "get",
    path: "/admin-channels",
    tags: ["Admin - Settings"],
    summary: "Get admin notification channel settings per order status",
    responses: {
        200: {
            description: "Admin notification channel configuration",
            content: { "application/json": { schema: successEnvelope(adminNotificationSettingsSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(getAdminChannelsRoute, async (c) => {
    const db = c.get("db");
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const channels = await getAdminNotificationChannels(db);
    const pushReadiness = await getFirebaseServiceAccountReadiness(
        db,
        encryptionKey,
        c.env as Record<string, unknown>,
    );
    const pushNotificationReadiness = await getPushNotificationReadiness(db, pushReadiness);
    return ok(c, {
        channels,
        pushConfigured: pushNotificationReadiness.configured,
        pushError: pushNotificationReadiness.error,
    });
});

// PUT /notification-channels/admin-channels
const updateAdminChannelsRoute = createRoute({
    method: "put",
    path: "/admin-channels",
    tags: ["Admin - Settings"],
    summary: "Update admin notification channel settings per order status",
    request: {
        body: { content: { "application/json": { schema: wrappedChannelsSchema } } },
    },
    responses: {
        200: {
            description: "Updated admin notification channel configuration",
            content: { "application/json": { schema: successEnvelope(adminNotificationSettingsSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(updateAdminChannelsRoute, async (c) => {
    const db = c.get("db");
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const { channels } = c.req.valid("json");
    const pushReadiness = await getFirebaseServiceAccountReadiness(
        db,
        encryptionKey,
        c.env as Record<string, unknown>,
    );
    const pushNotificationReadiness = await getPushNotificationReadiness(db, pushReadiness);
    if (adminChannelsRequirePush(channels) && !pushNotificationReadiness.configured) {
        throw new ValidationError(
            pushNotificationReadiness.error
                ?? "Configure Firebase service account credentials before enabling admin push notifications.",
        );
    }
    const updated = await updateAdminNotificationChannels(db, channels);
    return ok(c, {
        channels: updated,
        pushConfigured: pushNotificationReadiness.configured,
        pushError: pushNotificationReadiness.error,
    });
});

// GET /notification-channels/mcp-summary
const getAdminNotificationSettingsSummaryRoute = createRoute({
    method: "get",
    path: "/mcp-summary",
    tags: ["Admin - Settings"],
    summary: "Get redacted Admin MCP notification settings summary",
    responses: {
        200: {
            description: "Redacted Admin MCP notification settings summary",
            content: {
                "application/json": { schema: successEnvelope(adminNotificationSettingsSummarySchema) },
            },
        },
        ...errorResponses,
    },
});

app.openapi(getAdminNotificationSettingsSummaryRoute, async (c) => {
    const db = c.get("db");
    const env = c.env as Record<string, unknown>;
    const encryptionKey = getCredentialEncryptionKey(env);

    const [
        customerChannels,
        merchantChannels,
        whatsappTemplate,
        customerReadiness,
        merchantReadiness,
    ] = await Promise.all([
        getNotificationChannels(db),
        getAdminNotificationChannels(db),
        getWhatsAppTemplateSummary(db),
        getCustomerReadinessSummary(db, encryptionKey, env),
        getMerchantReadinessSummary(db, encryptionKey, env),
    ]);

    const customerEvents = buildNotificationEventSummaries(
        customerChannels,
        CUSTOMER_NOTIFICATION_CHANNELS,
    );
    const merchantEvents = buildNotificationEventSummaries(
        merchantChannels,
        MERCHANT_NOTIFICATION_CHANNELS,
    );
    const customerEnabledEventCounts = countEnabledEvents(
        customerEvents,
        CUSTOMER_NOTIFICATION_CHANNELS,
    );
    const merchantEnabledEventCounts = countEnabledEvents(
        merchantEvents,
        MERCHANT_NOTIFICATION_CHANNELS,
    );

    const readinessIssueCount =
        customerReadiness.email.issueCount
        + customerReadiness.sms.issueCount
        + customerReadiness.whatsapp.issueCount
        + merchantReadiness.push.issueCount;

    return ok(c, {
        adminNotificationSettingsSummary: {
            source: SUMMARY_SOURCE,
            customer: {
                supportedChannels: [...CUSTOMER_NOTIFICATION_CHANNELS],
                readiness: customerReadiness,
                enabledEventCounts: customerEnabledEventCounts,
                events: customerEvents,
                whatsappTemplate,
            },
            merchant: {
                supportedChannels: [...MERCHANT_NOTIFICATION_CHANNELS],
                readiness: merchantReadiness,
                enabledEventCounts: merchantEnabledEventCounts,
                events: merchantEvents,
            },
            totals: {
                orderEventCount: ORDER_NOTIFICATION_TYPES.length,
                customerEventsWithAnyChannel: customerEvents.filter((event) => event.hasAnyChannel).length,
                merchantEventsWithPush: merchantEnabledEventCounts.push,
                readinessIssueCount,
            },
            limits: REDACTION_LIMITS,
        },
    });
});

function adminChannelsRequirePush(channels: Record<string, string[]>): boolean {
    return Object.values(channels).some((enabledChannels) => enabledChannels.includes("push"));
}

function countReadinessHints(readiness: { blockers?: unknown[]; error?: unknown }): number {
    if (Array.isArray(readiness.blockers) && readiness.blockers.length > 0) {
        return readiness.blockers.length;
    }
    return readiness.error ? 1 : 0;
}

function redactedUnavailableReadiness() {
    return { configured: false, ready: false, issueCount: 1 };
}

function summarizeNotificationReadiness(
    providerConfigured: boolean,
    notificationReady: boolean,
    issueHintCount: number,
) {
    return {
        configured: providerConfigured,
        ready: notificationReady,
        issueCount: notificationReady ? 0 : Math.max(1, issueHintCount),
    };
}

async function getCustomerReadinessSummary(
    db: Database,
    encryptionKey: string | undefined,
    env: Record<string, unknown>,
): Promise<Record<CustomerNotificationChannel, { configured: boolean; ready: boolean; issueCount: number }>> {
    const [email, sms, whatsapp] = await Promise.all([
        getEmailReadinessSummary(db, encryptionKey, env),
        getSmsReadinessSummary(db, encryptionKey),
        getWhatsAppReadinessSummary(db, encryptionKey),
    ]);
    return { email, sms, whatsapp };
}

async function getMerchantReadinessSummary(
    db: Database,
    encryptionKey: string | undefined,
    env: Record<string, unknown>,
): Promise<Record<MerchantNotificationChannel, { configured: boolean; ready: boolean; issueCount: number }>> {
    try {
        const providerReadiness = await getFirebaseServiceAccountReadiness(db, encryptionKey, env);
        const notificationReadiness = await getPushNotificationReadiness(db, providerReadiness);
        return {
            push: summarizeNotificationReadiness(
                providerReadiness.configured,
                notificationReadiness.configured,
                providerReadiness.error || notificationReadiness.error ? 1 : 0,
            ),
        };
    } catch {
        return { push: redactedUnavailableReadiness() };
    }
}

async function getEmailReadinessSummary(
    db: Database,
    encryptionKey: string | undefined,
    env: Record<string, unknown>,
): Promise<{ configured: boolean; ready: boolean; issueCount: number }> {
    try {
        const providerReadiness = await getEmailProviderReadiness({ db, encryptionKey, env });
        const notificationReadiness = await getEmailNotificationReadiness(db, providerReadiness);
        return summarizeNotificationReadiness(
            providerReadiness.configured,
            notificationReadiness.configured,
            countReadinessHints(providerReadiness) || (notificationReadiness.error ? 1 : 0),
        );
    } catch {
        return redactedUnavailableReadiness();
    }
}

async function getSmsReadinessSummary(
    db: Database,
    encryptionKey: string | undefined,
): Promise<{ configured: boolean; ready: boolean; issueCount: number }> {
    try {
        const providerReadiness = await getSmsProviderReadiness(db, encryptionKey);
        const notificationReadiness = await getSmsNotificationReadiness(db, providerReadiness);
        return summarizeNotificationReadiness(
            providerReadiness.configured,
            notificationReadiness.configured,
            providerReadiness.error || notificationReadiness.error ? 1 : 0,
        );
    } catch {
        return redactedUnavailableReadiness();
    }
}

async function getWhatsAppReadinessSummary(
    db: Database,
    encryptionKey: string | undefined,
): Promise<{ configured: boolean; ready: boolean; issueCount: number }> {
    try {
        const configured = await isWhatsAppCloudApiConfigured(db, encryptionKey);
        const notificationReadiness = await getWhatsAppNotificationReadiness(db, encryptionKey, configured);
        return summarizeNotificationReadiness(
            configured,
            notificationReadiness.configured,
            notificationReadiness.error ? 1 : 0,
        );
    } catch {
        return redactedUnavailableReadiness();
    }
}

async function getWhatsAppTemplateSummary(
    db: Database,
): Promise<{ configured: boolean; languageConfigured: boolean }> {
    try {
        const whatsappTemplate = await getOrderWhatsAppTemplateSettings(db);
        return {
            configured: Boolean(whatsappTemplate.templateName.trim()),
            languageConfigured: Boolean(whatsappTemplate.languageCode.trim()),
        };
    } catch {
        return { configured: false, languageConfigured: false };
    }
}

function buildNotificationEventSummaries<TChannel extends string>(
    channels: Record<string, string[]>,
    supportedChannels: readonly TChannel[],
): Array<{
    type: OrderNotificationType;
    label: string;
    enabledChannels: TChannel[];
    hasAnyChannel: boolean;
}> {
    return ORDER_NOTIFICATION_TYPES.map((type) => {
        const configuredChannels = new Set(channels[type] ?? []);
        const enabledChannels = supportedChannels.filter((channel) => configuredChannels.has(channel));
        return {
            type,
            label: ORDER_NOTIFICATION_LABELS[type],
            enabledChannels,
            hasAnyChannel: enabledChannels.length > 0,
        };
    });
}

function countEnabledEvents<TChannel extends string>(
    events: Array<{ enabledChannels: TChannel[] }>,
    supportedChannels: readonly TChannel[],
): Record<TChannel, number> {
    const counts = Object.fromEntries(supportedChannels.map((channel) => [channel, 0])) as Record<TChannel, number>;
    for (const event of events) {
        for (const channel of event.enabledChannels) {
            counts[channel] += 1;
        }
    }
    return counts;
}

async function getEmailNotificationReadiness(
    db: Database,
    readiness: EmailProviderReadiness,
): Promise<{ configured: boolean; error: string | null }> {
    if (!readiness.configured) {
        return { configured: false, error: readiness.error };
    }
    const providerBlock = await getNotificationProviderBlock(db, {
        channel: "email",
        provider: readiness.provider,
    });
    if (providerBlock) return { configured: false, error: describeNotificationProviderBlock(providerBlock) };

    const genericBlock = await getNotificationProviderBlock(db, {
        channel: "email",
        provider: "email",
    });
    if (genericBlock) return { configured: false, error: describeNotificationProviderBlock(genericBlock) };

    return { configured: true, error: null };
}

async function getSmsNotificationReadiness(
    db: Database,
    readiness: SmsProviderReadiness,
): Promise<{ configured: boolean; error: string | null }> {
    if (!readiness.configured || !readiness.activeProvider) {
        return { configured: readiness.configured, error: readiness.error };
    }
    const block = await getNotificationProviderBlock(db, {
        channel: "sms",
        provider: readiness.activeProvider,
    });
    if (!block) return { configured: true, error: null };
    return { configured: false, error: describeNotificationProviderBlock(block) };
}

async function getWhatsAppNotificationReadiness(
    db: Database,
    encryptionKey: string | undefined,
    configuredOverride?: boolean,
): Promise<{ configured: boolean; error: string | null }> {
    const configured = configuredOverride ?? await isWhatsAppCloudApiConfigured(db, encryptionKey);
    if (!configured) {
        return {
            configured: false,
            error: "Configure Meta WhatsApp Cloud API credentials before enabling WhatsApp order notifications.",
        };
    }
    const block = await getNotificationProviderBlock(db, {
        channel: "whatsapp",
        provider: "whatsapp",
    });
    if (!block) return { configured: true, error: null };
    return { configured: false, error: describeNotificationProviderBlock(block) };
}

async function getPushNotificationReadiness(
    db: Database,
    readiness: { configured: boolean; error: string | null },
): Promise<{ configured: boolean; error: string | null }> {
    if (!readiness.configured) return readiness;
    const block = await getNotificationProviderBlock(db, {
        channel: "push",
        provider: "fcm",
    });
    if (!block) return readiness;
    return { configured: false, error: describeNotificationProviderBlock(block) };
}

export { app as notificationChannelsRoutes };
