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
import { ok } from "../../../utils/api-response";
import { successEnvelope, errorResponses } from "../../../schemas/responses";
import { getCredentialEncryptionKey } from "../../../utils/encryption-key";

const app = new OpenAPIHono<{ Bindings: Env }>();

const channelsSchema = z.record(z.string(), z.array(z.string()));

const whatsappTemplateSchema = z.object({
    templateName: z.string().min(1).max(512).regex(/^[a-z0-9_]+$/),
    languageCode: z.string().min(2).max(8).regex(/^[a-z]{2}(?:_[A-Z]{2})?$/),
});

const wrappedChannelsSchema = z.object({
    channels: channelsSchema,
});

const customerNotificationSettingsSchema = z.object({
    channels: channelsSchema,
    whatsappTemplate: whatsappTemplateSchema,
    whatsappConfigured: z.boolean(),
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
    return ok(c, { channels, whatsappTemplate, whatsappConfigured });
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
    return ok(c, { channels: updated, whatsappTemplate, whatsappConfigured });
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
            content: { "application/json": { schema: successEnvelope(wrappedChannelsSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(getAdminChannelsRoute, async (c) => {
    const db = c.get("db");
    const channels = await getAdminNotificationChannels(db);
    return ok(c, { channels });
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
            content: { "application/json": { schema: successEnvelope(wrappedChannelsSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(updateAdminChannelsRoute, async (c) => {
    const db = c.get("db");
    const { channels } = c.req.valid("json");
    const updated = await updateAdminNotificationChannels(db, channels);
    return ok(c, { channels: updated });
});

export { app as notificationChannelsRoutes };
