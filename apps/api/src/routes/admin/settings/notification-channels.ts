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
import type { Database } from "@scalius/database/client";
import {
    isReady,
    readiness,
    readinessIssue,
    type Readiness,
} from "@scalius/shared/readiness";
import { ok } from "../../../utils/api-response";
import { successEnvelope, errorResponses } from "../../../schemas/responses";
import { readinessSchema } from "../../../schemas/readiness";
import { getCredentialEncryptionKey } from "../../../utils/encryption-key";
import { ValidationError } from "../../../utils/api-error";

const app = new OpenAPIHono<{ Bindings: Env }>();

const notificationEventsSchema = <T extends z.ZodTypeAny>(channel: T) => z.object({
    order_created: z.array(channel),
    order_confirmed: z.array(channel),
    order_processing: z.array(channel),
    order_shipped: z.array(channel),
    order_delivered: z.array(channel),
    order_completed: z.array(channel),
    order_cancelled: z.array(channel),
    order_returned: z.array(channel),
    refund_processing: z.array(channel),
    refund_failed: z.array(channel),
    order_refunded: z.array(channel),
    order_partially_refunded: z.array(channel),
    payment_balance_paid: z.array(channel),
    support_request_submitted: z.array(channel),
    support_request_status_updated: z.array(channel),
}).strict();

const channelsSchema = z.record(z.string(), z.array(z.string()));
const adminChannelsSchema = notificationEventsSchema(z.literal("push"));
const customerChannelsSchema = notificationEventsSchema(z.enum(["email", "sms", "whatsapp"]));

const whatsappTemplateSchema = z.object({
    templateName: z.string().min(1).max(512).regex(/^[a-z0-9_]+$/),
    languageCode: z.string().min(2).max(8).regex(/^[a-z]{2}(?:_[A-Z]{2})?$/),
});

const wrappedChannelsSchema = z.object({
    channels: adminChannelsSchema,
}).strict();

/**
 * Stable issue codes. A channel is blocked when a provider failure paused it,
 * which is distinct from the provider never having been configured.
 */
const NOTIFICATION_READINESS_CODES = {
    blocked: "notification_provider_blocked",
    whatsapp: "missing_whatsapp_credentials",
} as const;

const adminNotificationSettingsSchema = z.object({
    channels: channelsSchema,
    push: readinessSchema,
});

const customerNotificationSettingsSchema = z.object({
    channels: channelsSchema,
    whatsappTemplate: whatsappTemplateSchema,
    whatsapp: readinessSchema,
    email: readinessSchema,
    sms: readinessSchema,
});

const updateCustomerNotificationSettingsSchema = z.object({
    channels: customerChannelsSchema,
    whatsappTemplate: whatsappTemplateSchema.optional(),
}).strict();

// GET /notification-channels
const getChannelsRoute = createRoute({
    method: "get",
    path: "/",
    operationId: "dashboard.notifications.customer_rules_get",
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
        whatsapp: whatsappReadiness,
        email: emailNotificationReadiness,
        sms: smsNotificationReadiness,
    });
});

// PUT /notification-channels
const updateChannelsRoute = createRoute({
    method: "put",
    path: "/",
    operationId: "dashboard.notifications.customer_rules_update",
    tags: ["Admin - Settings"],
    summary: "Update notification channel settings per order status",
    request: {
        body: { required: true, content: { "application/json": { schema: updateCustomerNotificationSettingsSchema } } },
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
        whatsapp: whatsappReadiness,
        email: emailNotificationReadiness,
        sms: smsNotificationReadiness,
    });
});

// GET /notification-channels/admin-channels
const getAdminChannelsRoute = createRoute({
    method: "get",
    path: "/admin-channels",
    operationId: "dashboard.notifications.admin_rules_get",
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
    const pushReadiness = await getFirebaseServiceAccountReadiness(db, encryptionKey);
    const pushNotificationReadiness = await getPushNotificationReadiness(db, pushReadiness);
    return ok(c, {
        channels,
        push: pushNotificationReadiness,
    });
});

// PUT /notification-channels/admin-channels
const updateAdminChannelsRoute = createRoute({
    method: "put",
    path: "/admin-channels",
    operationId: "dashboard.notifications.admin_rules_update",
    tags: ["Admin - Settings"],
    summary: "Update admin notification channel settings per order status",
    request: {
        body: { required: true, content: { "application/json": { schema: wrappedChannelsSchema } } },
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
    const pushReadiness = await getFirebaseServiceAccountReadiness(db, encryptionKey);
    const pushNotificationReadiness = await getPushNotificationReadiness(db, pushReadiness);
    if (adminChannelsRequirePush(channels) && !isReady(pushNotificationReadiness)) {
        throw new ValidationError(
            pushNotificationReadiness.issues[0]?.message
                ?? "Configure Firebase service account credentials before enabling admin push notifications.",
        );
    }
    const updated = await updateAdminNotificationChannels(db, channels);
    return ok(c, {
        channels: updated,
        push: pushNotificationReadiness,
    });
});

function adminChannelsRequirePush(channels: Record<string, string[]>): boolean {
    return Object.values(channels).some((enabledChannels) => enabledChannels.includes("push"));
}

/** A paused provider is merchant-actionable setup, not a platform error. */
function providerBlockedReadiness(block: Parameters<typeof describeNotificationProviderBlock>[0]): Readiness {
    return readiness.incomplete([readinessIssue(
        NOTIFICATION_READINESS_CODES.blocked,
        describeNotificationProviderBlock(block),
    )]);
}

/** Drops provider-specific extras so only the shared shape is published. */
function bareReadiness(value: Readiness): Readiness {
    return { status: value.status, issues: value.issues };
}

async function getEmailNotificationReadiness(
    db: Database,
    providerReadiness: EmailProviderReadiness,
): Promise<Readiness> {
    if (!isReady(providerReadiness)) return bareReadiness(providerReadiness);

    const providerBlock = await getNotificationProviderBlock(db, {
        channel: "email",
        provider: providerReadiness.provider,
    });
    if (providerBlock) return providerBlockedReadiness(providerBlock);

    const genericBlock = await getNotificationProviderBlock(db, {
        channel: "email",
        provider: "email",
    });
    if (genericBlock) return providerBlockedReadiness(genericBlock);

    return readiness.ready();
}

async function getSmsNotificationReadiness(
    db: Database,
    providerReadiness: SmsProviderReadiness,
): Promise<Readiness> {
    if (!isReady(providerReadiness) || !providerReadiness.activeProvider) {
        return bareReadiness(providerReadiness);
    }
    const block = await getNotificationProviderBlock(db, {
        channel: "sms",
        provider: providerReadiness.activeProvider,
    });
    return block ? providerBlockedReadiness(block) : readiness.ready();
}

async function getWhatsAppNotificationReadiness(
    db: Database,
    encryptionKey: string | undefined,
    configuredOverride?: boolean,
): Promise<Readiness> {
    const configured = configuredOverride ?? await isWhatsAppCloudApiConfigured(db, encryptionKey);
    if (!configured) {
        return readiness.incomplete([readinessIssue(
            NOTIFICATION_READINESS_CODES.whatsapp,
            "Configure Meta WhatsApp Cloud API credentials before enabling WhatsApp order notifications.",
        )]);
    }
    const block = await getNotificationProviderBlock(db, {
        channel: "whatsapp",
        provider: "whatsapp",
    });
    return block ? providerBlockedReadiness(block) : readiness.ready();
}

async function getPushNotificationReadiness(
    db: Database,
    providerReadiness: Readiness,
): Promise<Readiness> {
    if (!isReady(providerReadiness)) return bareReadiness(providerReadiness);
    const block = await getNotificationProviderBlock(db, {
        channel: "push",
        provider: "fcm",
    });
    return block ? providerBlockedReadiness(block) : readiness.ready();
}

export { app as notificationChannelsRoutes };
