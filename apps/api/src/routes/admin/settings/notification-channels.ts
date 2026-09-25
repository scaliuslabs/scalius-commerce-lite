// src/routes/admin/settings/notification-channels.ts
// The notifications document: customer rules per event, staff alerts (push per
// event, email for every new order and the events that allow it) and the
// WhatsApp order template.
// One GET feeds both dashboard cards; each card saves its part with the
// revision it loaded.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    getNotificationSettings,
    updateNotificationChannels,
    updateAdminNotificationChannels,
    isWhatsAppCloudApiConfigured,
    STAFF_EMAIL_RECIPIENTS_MAX,
} from "@scalius/core/modules/settings";
import { getSmsProviderReadiness } from "@scalius/core/integrations/sms";
import { getEmailProviderReadiness } from "@scalius/core/integrations/email";
import { getFirebaseServiceAccountReadiness } from "@scalius/core/integrations/firebase/settings";
import {
    clearNotificationProviderBlocks,
    describeNotificationProviderBlock,
    getNotificationProviderBlock,
} from "@scalius/core/modules/notifications";
import {
    ORDER_NOTIFICATION_TYPES,
    RESOLVED_NOTIFICATION_TYPES,
    STAFF_ALERT_NOTIFICATION_TYPES,
    type OrderNotificationType,
} from "@scalius/core/modules/notifications/browser";
import type { Database } from "@scalius/database/client";
import {
    isReady,
    readiness,
    readinessIssue,
    type Readiness,
} from "@scalius/shared/readiness";
import { ok } from "../../../utils/api-response";
import { successEnvelope, errorResponses, conflictResponse } from "../../../schemas/responses";
import { readinessSchema } from "../../../schemas/readiness";
import { getCredentialEncryptionKey } from "../../../utils/encryption-key";
import { ValidationError } from "../../../utils/api-error";

const app = new OpenAPIHono<{ Bindings: Env }>();

/**
 * One entry per order event, plus the non-order events each audience can use:
 * thread events (Wave A §10) and the Wave B review, digital and gift card
 * events (Wave B §10). The extra events are optional so an older dashboard's
 * payload stays valid; an omitted event falls back to its default.
 */
const notificationEventsSchema = <T extends z.ZodTypeAny, C extends z.ZodTypeAny>(channel: T, extra: Record<string, C>) => z.object({
    ...Object.fromEntries(ORDER_NOTIFICATION_TYPES.map((event) => [event, z.array(channel)])) as Record<OrderNotificationType, z.ZodArray<T>>,
    ...Object.fromEntries(Object.entries(extra).map(([event, schema]) => [event, z.array(schema).optional()])),
}).strict();

/** Every extra event of one audience on the same channel list. */
function extraEvents<C extends z.ZodTypeAny>(events: readonly string[], channel: C): Record<string, C> {
    return Object.fromEntries(events.map((event) => [event, channel]));
}

const channelsSchema = z.record(z.string(), z.array(z.string()));
const expectedRevisionSchema = z.number().int().nonnegative();

const whatsappTemplateSchema = z.object({
    templateName: z.string().min(1).max(512).regex(/^[a-z0-9_]+$/),
    languageCode: z.string().min(2).max(8).regex(/^[a-z]{2}(?:_[A-Z]{2})?$/),
});

/**
 * Stable issue codes. A channel is blocked when a provider failure paused it,
 * which is distinct from the provider never having been configured.
 */
const NOTIFICATION_READINESS_CODES = {
    blocked: "notification_provider_blocked",
    whatsapp: "missing_whatsapp_credentials",
} as const;

const notificationSettingsSchema = z.object({
    /** Customer channels per event. */
    channels: channelsSchema,
    /** Staff push per event. */
    adminChannels: channelsSchema,
    staffEmailRecipients: z.array(z.string()),
    whatsappTemplate: whatsappTemplateSchema,
    whatsapp: readinessSchema,
    email: readinessSchema,
    sms: readinessSchema,
    push: readinessSchema,
    revision: z.number().int().nonnegative(),
});

const updateCustomerNotificationSettingsSchema = z.object({
    channels: notificationEventsSchema(
        z.enum(["email", "sms", "whatsapp"]),
        extraEvents(["conversation_reply", ...RESOLVED_NOTIFICATION_TYPES], z.enum(["email", "sms"])),
    ),
    whatsappTemplate: whatsappTemplateSchema.optional(),
    expectedRevision: expectedRevisionSchema,
}).strict();

const updateStaffNotificationSettingsSchema = z.object({
    channels: notificationEventsSchema(
        z.literal("push"),
        extraEvents(["conversation_message", ...STAFF_ALERT_NOTIFICATION_TYPES], z.enum(["push", "email"])),
    ),
    emailRecipients: z.array(z.string().max(254)).max(STAFF_EMAIL_RECIPIENTS_MAX),
    expectedRevision: expectedRevisionSchema,
}).strict();

const settingsResponse = {
    200: {
        description: "Notification settings",
        content: { "application/json": { schema: successEnvelope(notificationSettingsSchema) } },
    },
    ...errorResponses,
};
const savedSettingsResponse = { ...settingsResponse, 409: conflictResponse };

async function readNotificationSettings(db: Database, env: Env) {
    const encryptionKey = getCredentialEncryptionKey(env as Record<string, unknown>);
    const settings = await getNotificationSettings(db);
    return {
        channels: settings.orderChannels,
        adminChannels: settings.adminChannels,
        staffEmailRecipients: settings.staffEmailRecipients,
        whatsappTemplate: {
            templateName: settings.whatsappOrderTemplateName,
            languageCode: settings.whatsappOrderTemplateLanguage,
        },
        whatsapp: await getWhatsAppNotificationReadiness(db, encryptionKey),
        email: await getEmailNotificationReadiness(db, encryptionKey, env),
        sms: await getSmsNotificationReadiness(db, encryptionKey),
        push: await getPushNotificationReadiness(db, encryptionKey),
        revision: settings.revision,
    };
}

// GET /notification-channels
app.openapi(createRoute({
    method: "get",
    path: "/",
    operationId: "dashboard.notifications.customer_rules_get",
    tags: ["Admin - Settings"],
    summary: "Get customer and staff notification settings",
    responses: settingsResponse,
}), async (c) => ok(c, await readNotificationSettings(c.get("db"), c.env)));

// PUT /notification-channels
app.openapi(createRoute({
    method: "put",
    path: "/",
    operationId: "dashboard.notifications.customer_rules_update",
    tags: ["Admin - Settings"],
    summary: "Update customer notification channels per order status",
    request: {
        body: { required: true, content: { "application/json": { schema: updateCustomerNotificationSettingsSchema } } },
    },
    responses: savedSettingsResponse,
}), async (c) => {
    const db = c.get("db");
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const { channels, whatsappTemplate, expectedRevision } = c.req.valid("json");
    await updateNotificationChannels(db, channels, encryptionKey, c.env as Record<string, unknown>, {
        whatsappTemplate,
        expectedRevision,
    });
    // A new order template is the fix for a paused Meta template.
    if (whatsappTemplate) await clearNotificationProviderBlocks(db, { channel: "whatsapp" });
    return ok(c, await readNotificationSettings(db, c.env));
});

// PUT /notification-channels/admin-channels
app.openapi(createRoute({
    method: "put",
    path: "/admin-channels",
    operationId: "dashboard.notifications.admin_rules_update",
    tags: ["Admin - Settings"],
    summary: "Update staff notifications: push per order status and new-order emails",
    request: {
        body: { required: true, content: { "application/json": { schema: updateStaffNotificationSettingsSchema } } },
    },
    responses: savedSettingsResponse,
}), async (c) => {
    const db = c.get("db");
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const { channels, emailRecipients, expectedRevision } = c.req.valid("json");
    const current = await getNotificationSettings(db);
    const newlyPushed = Object.entries(channels).some(([event, enabled]) =>
        enabled.includes("push") && !current.adminChannels[event]?.includes("push"));
    if (newlyPushed) {
        const push = await getPushNotificationReadiness(db, encryptionKey);
        if (!isReady(push)) {
            throw new ValidationError(
                push.issues[0]?.message
                    ?? "Configure Firebase service account credentials before enabling admin push notifications.",
            );
        }
    }
    await updateAdminNotificationChannels(db, { channels, emailRecipients }, { expectedRevision });
    return ok(c, await readNotificationSettings(db, c.env));
});

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
    encryptionKey: string | undefined,
    env: Env,
): Promise<Readiness> {
    const providerReadiness = await getEmailProviderReadiness({ db, encryptionKey, env: env as Record<string, unknown> });
    if (!isReady(providerReadiness)) return bareReadiness(providerReadiness);

    const block = await getNotificationProviderBlock(db, { channel: "email", provider: providerReadiness.provider })
        ?? await getNotificationProviderBlock(db, { channel: "email", provider: "email" });
    return block ? providerBlockedReadiness(block) : readiness.ready();
}

async function getSmsNotificationReadiness(db: Database, encryptionKey: string | undefined): Promise<Readiness> {
    const providerReadiness = await getSmsProviderReadiness(db, encryptionKey);
    if (!isReady(providerReadiness) || !providerReadiness.activeProvider) {
        return bareReadiness(providerReadiness);
    }
    const block = await getNotificationProviderBlock(db, {
        channel: "sms",
        provider: providerReadiness.activeProvider,
    });
    return block ? providerBlockedReadiness(block) : readiness.ready();
}

async function getWhatsAppNotificationReadiness(db: Database, encryptionKey: string | undefined): Promise<Readiness> {
    if (!(await isWhatsAppCloudApiConfigured(db, encryptionKey))) {
        return readiness.incomplete([readinessIssue(
            NOTIFICATION_READINESS_CODES.whatsapp,
            "Configure Meta WhatsApp Cloud API credentials before enabling WhatsApp order notifications.",
        )]);
    }
    const block = await getNotificationProviderBlock(db, { channel: "whatsapp", provider: "whatsapp" });
    return block ? providerBlockedReadiness(block) : readiness.ready();
}

async function getPushNotificationReadiness(db: Database, encryptionKey: string | undefined): Promise<Readiness> {
    const providerReadiness = await getFirebaseServiceAccountReadiness(db, encryptionKey);
    if (!isReady(providerReadiness)) return bareReadiness(providerReadiness);
    const block = await getNotificationProviderBlock(db, { channel: "push", provider: "fcm" });
    return block ? providerBlockedReadiness(block) : readiness.ready();
}

export { app as notificationChannelsRoutes };
