// src/routes/admin/settings/notification-channels.ts
// Admin endpoints for notification channel configuration per order status.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getNotificationChannels, updateNotificationChannels } from "@scalius/core/modules/settings/settings.service";
import { ok } from "../../../utils/api-response";
import { successEnvelope, errorResponses } from "../../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const channelsSchema = z.record(z.string(), z.array(z.string()));

const wrappedChannelsSchema = z.object({
    channels: channelsSchema,
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
            content: { "application/json": { schema: successEnvelope(wrappedChannelsSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(getChannelsRoute, async (c) => {
    const db = c.get("db");
    const channels = await getNotificationChannels(db);
    return ok(c, { channels });
});

// PUT /notification-channels
const updateChannelsRoute = createRoute({
    method: "put",
    path: "/",
    tags: ["Admin - Settings"],
    summary: "Update notification channel settings per order status",
    request: {
        body: { content: { "application/json": { schema: wrappedChannelsSchema } } },
    },
    responses: {
        200: {
            description: "Updated notification channel configuration",
            content: { "application/json": { schema: successEnvelope(wrappedChannelsSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(updateChannelsRoute, async (c) => {
    const db = c.get("db");
    const { channels } = c.req.valid("json");
    const updated = await updateNotificationChannels(db, channels);
    return ok(c, { channels: updated });
});

export { app as notificationChannelsRoutes };
