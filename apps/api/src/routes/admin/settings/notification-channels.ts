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
    getWhatsAppSender,
    STAFF_EMAIL_RECIPIENTS_MAX,
} from "@scalius/core/modules/notifications";
import { getSmsProviderReadiness } from "@scalius/core/integrations/sms";
import { getEmailProviderReadiness } from "@scalius/core/integrations/email";
import type { AppProviders } from "@scalius/core/integrations/provider-port";
import { assertAppProviderInstalled, requestAppProviders } from "../../../plugins/providers/app-providers";
import { resolveAppProvider } from "@scalius/core/integrations/provider-port";
import { getFirebaseServiceAccountReadiness } from "@scalius/core/integrations/firebase/settings";
import { webPushSender } from "@scalius/core/modules/notifications";
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
    /** Buyers' browser notifications: Web Push (built in, ready when the Worker can sign) or the chosen app push provider. */
    customerPush: readinessSchema,
    pushProvider: z.string(),
    revision: z.number().int().nonnegative(),
});

const updateCustomerNotificationSettingsSchema = z.object({
    channels: notificationEventsSchema(
        z.enum(["email", "sms", "whatsapp", "push"]),
        extraEvents(["conversation_reply", ...RESOLVED_NOTIFICATION_TYPES], z.enum(["email", "sms"])),
    ),
    whatsappTemplate: whatsappTemplateSchema.optional(),
    /** Who delivers buyers' browser notifications: "" for Web Push, or an app push provider (`GET /admin/settings/providers?kind=push`). */
    pushProvider: z.string().max(160).optional(),
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

async function readNotificationSettings(db: Database, env: Env, appProviders: AppProviders) {
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
        whatsapp: await getWhatsAppNotificationReadiness(db, encryptionKey, appProviders),
        email: await getEmailNotificationReadiness(db, encryptionKey, env, appProviders),
        sms: await getSmsNotificationReadiness(db, encryptionKey, appProviders),
        push: await getPushNotificationReadiness(db, encryptionKey, env),
        customerPush: await customerPushReadiness(settings.pushProvider, env, appProviders),
        pushProvider: settings.pushProvider,
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
}), async (c) => ok(c, await readNotificationSettings(c.get("db"), c.env, requestAppProviders(c))));

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
    const { channels, whatsappTemplate, pushProvider, expectedRevision } = c.req.valid("json");
    if (pushProvider) await assertAppProviderInstalled(db, "push", pushProvider);
    await updateNotificationChannels(db, channels, encryptionKey, c.env as Record<string, unknown>, {
        whatsappTemplate,
        expectedRevision,
        ...(pushProvider === undefined ? {} : { pushProvider }),
        appProviders: requestAppProviders(c),
    });
    // A new order template is the fix for a paused Meta template.
    if (whatsappTemplate) await clearNotificationProviderBlocks(db, { channel: "whatsapp" });
    return ok(c, await readNotificationSettings(db, c.env, requestAppProviders(c)));
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
        const push = await getPushNotificationReadiness(db, encryptionKey, c.env);
        if (!isReady(push)) {
            throw new ValidationError(
                push.issues[0]?.message
                    ?? "Configure Firebase service account credentials before enabling admin push notifications.",
            );
        }
    }
    await updateAdminNotificationChannels(db, { channels, emailRecipients }, { expectedRevision });
    return ok(c, await readNotificationSettings(db, c.env, requestAppProviders(c)));
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
    appProviders: AppProviders,
): Promise<Readiness> {
    const providerReadiness = await getEmailProviderReadiness({ db, encryptionKey, env: env as Record<string, unknown>, appProviders });
    if (!isReady(providerReadiness)) return bareReadiness(providerReadiness);

    const block = await getNotificationProviderBlock(db, { channel: "email", provider: providerReadiness.provider })
        ?? await getNotificationProviderBlock(db, { channel: "email", provider: "email" });
    return block ? providerBlockedReadiness(block) : readiness.ready();
}

async function getSmsNotificationReadiness(db: Database, encryptionKey: string | undefined, appProviders: AppProviders): Promise<Readiness> {
    const providerReadiness = await getSmsProviderReadiness(db, encryptionKey, appProviders);
    if (!isReady(providerReadiness) || !providerReadiness.activeProvider) {
        return bareReadiness(providerReadiness);
    }
    const block = await getNotificationProviderBlock(db, {
        channel: "sms",
        provider: providerReadiness.activeProvider,
    });
    return block ? providerBlockedReadiness(block) : readiness.ready();
}

async function getWhatsAppNotificationReadiness(db: Database, encryptionKey: string | undefined, appProviders: AppProviders): Promise<Readiness> {
    // The built-in Meta Cloud API, or the app the merchant chose; a pause is keyed by whichever sends.
    const sender = await getWhatsAppSender(db, encryptionKey, appProviders);
    if (!sender.ready) {
        return readiness.incomplete([readinessIssue(NOTIFICATION_READINESS_CODES.whatsapp, sender.reason)]);
    }
    const block = await getNotificationProviderBlock(db, { channel: "whatsapp", provider: sender.provider });
    return block ? providerBlockedReadiness(block) : readiness.ready();
}

/** Buyers' push: the chosen app provider's readiness, else whether Web Push can sign. */
async function customerPushReadiness(pushProvider: string, env: Env, appProviders: AppProviders): Promise<Readiness> {
    if (pushProvider) {
        const choice = await resolveAppProvider(appProviders, "push", pushProvider);
        return choice.provider ? readiness.ready() : readiness.incomplete([readinessIssue("push_provider_not_ready", choice.issue)]);
    }
    return await webPushSender(env) ? readiness.ready() : readiness.incomplete([readinessIssue(
        "web_push_unavailable",
        "Browser notifications need your store's https web address. Add it in Settings → Store details → Web addresses.",
    )]);
}

/**
 * Staff push is ready with Web Push (built in: a master secret and an https
 * dashboard origin to sign with) or with a configured Firebase project.
 */
async function getPushNotificationReadiness(db: Database, encryptionKey: string | undefined, env: Env): Promise<Readiness> {
    if (await webPushSender(env)) return readiness.ready();
    const providerReadiness = await getFirebaseServiceAccountReadiness(db, encryptionKey);
    if (!isReady(providerReadiness)) return bareReadiness(providerReadiness);
    const block = await getNotificationProviderBlock(db, { channel: "push", provider: "fcm" });
    return block ? providerBlockedReadiness(block) : readiness.ready();
}

export { app as notificationChannelsRoutes };
