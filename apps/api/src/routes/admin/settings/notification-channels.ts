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
import { getSmsProviderReadiness } from "@scalius/core/integrations/sms";
import { getFirebaseServiceAccountReadiness } from "@scalius/core/integrations/firebase/settings";
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
    smsProviderConfigured: z.boolean(),
    smsProviderError: z.string().nullable(),
});

const updateCustomerNotificationSettingsSchema = z.object({
    channels: channelsSchema,
    whatsappTemplate: whatsappTemplateSchema.optional(),
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
    const whatsappConfigured = await isWhatsAppCloudApiConfigured(db, encryptionKey);
    const smsReadiness = await getSmsProviderReadiness(db, encryptionKey);
    return ok(c, {
        channels,
        whatsappTemplate,
        whatsappConfigured,
        smsProviderConfigured: smsReadiness.configured,
        smsProviderError: smsReadiness.error,
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
    const updated = await updateNotificationChannels(db, channels, encryptionKey);
    const whatsappTemplate = whatsappTemplateInput
        ? await updateOrderWhatsAppTemplateSettings(db, whatsappTemplateInput)
        : await getOrderWhatsAppTemplateSettings(db);
    const whatsappConfigured = await isWhatsAppCloudApiConfigured(db, encryptionKey);
    const smsReadiness = await getSmsProviderReadiness(db, encryptionKey);
    return ok(c, {
        channels: updated,
        whatsappTemplate,
        whatsappConfigured,
        smsProviderConfigured: smsReadiness.configured,
        smsProviderError: smsReadiness.error,
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
    return ok(c, {
        channels,
        pushConfigured: pushReadiness.configured,
        pushError: pushReadiness.error,
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
    if (adminChannelsRequirePush(channels) && !pushReadiness.configured) {
        throw new ValidationError(
            pushReadiness.error
                ?? "Configure Firebase service account credentials before enabling admin push notifications.",
        );
    }
    const updated = await updateAdminNotificationChannels(db, channels);
    return ok(c, {
        channels: updated,
        pushConfigured: pushReadiness.configured,
        pushError: pushReadiness.error,
    });
});

function adminChannelsRequirePush(channels: Record<string, string[]>): boolean {
    return Object.values(channels).some((enabledChannels) => enabledChannels.includes("push"));
}

export { app as notificationChannelsRoutes };
