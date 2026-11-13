// src/routes/admin/settings/notification-templates.ts
// Customer message templates per event (email subject + body, SMS body): the
// order events plus the Wave B messages whose content a domain resolves at
// send time (digital delivery, gift card, review request). Test sends render a
// draft with sample data.

import { createRoute, z } from "@hono/zod-openapi";
import { adminRouter } from "../admin-router";
import {
    TEMPLATED_NOTIFICATION_TYPES,
    TEMPLATE_LIMITS,
    findUnknownVariables,
    renderSmsTemplate,
    sampleOrderEmail,
    sampleVariables,
} from "@scalius/core/modules/notifications/browser";
import {
    getNotificationTemplatesInLanguage,
    messageLanguageOf,
    saveNotificationTemplate,
    readStoreIdentity,
} from "@scalius/core/modules/notifications";
import { sendEmail } from "@scalius/core/integrations/email";
import { getActiveSmsProvider } from "@scalius/core/integrations/sms";
import { normalizeBdMobile } from "@scalius/shared/phone-input";
import { MARKET_LOCALE_PATTERN } from "@scalius/shared/markets";
import { ok } from "../../../utils/api-response";
import { successEnvelope, errorResponses, conflictResponse } from "../../../schemas/responses";
import { getCredentialEncryptionKey } from "../../../utils/encryption-key";
import { ValidationError } from "../../../utils/api-error";
import { requireWithinRateLimit } from "../../../utils/rate-limit";
import { requestAppProviders } from "../../../plugins/providers/app-providers";
import { requestActorId, requestStaffUser, requireStaffId } from "../request-actor";

const app = adminRouter();

const eventSchema = z.enum(TEMPLATED_NOTIFICATION_TYPES);
const emailTemplateSchema = z.object({
    subject: z.string().max(TEMPLATE_LIMITS.subject),
    body: z.string().max(TEMPLATE_LIMITS.emailBody),
});
const smsTemplateSchema = z.object({ body: z.string().max(TEMPLATE_LIMITS.smsBody) });
const perEvent = <T extends z.ZodTypeAny>(template: T) =>
    z.object(Object.fromEntries(TEMPLATED_NOTIFICATION_TYPES.map((event) => [event, template])) as Record<
        (typeof TEMPLATED_NOTIFICATION_TYPES)[number],
        T
    >);

const templatesSchema = z.object({
    templates: z.object({ email: perEvent(emailTemplateSchema), sms: perEvent(smsTemplateSchema) }),
    revision: z.number().int().nonnegative(),
    /** The message copy of the language shown: the defaults' language and the email frame's. */
    language: z.enum(["en", "bn"]),
});

const localeSchema = z.string().regex(MARKET_LOCALE_PATTERN).openapi({
    description: "One of the store's other languages (`bn`): its version of the templates. Omit for the default language.",
});

const templatesInLanguageSchema = templatesSchema.extend({
    locale: localeSchema.nullable().openapi({ description: "The language shown; null for the store's default language." }),
    defaultLocale: z.string().openapi({ description: "The store's default language: the merchant's main templates are in it." }),
    locales: z.array(z.object({ locale: z.string(), published: z.boolean() })).max(200).openapi({
        description: "The store's languages. Each field of another language's version falls back to the default language's template.",
    }),
});

/** The store as its emails show it, so the dashboard previews the real frame. */
const previewStoreSchema = z.object({
    name: z.string().nullable(),
    logoUrl: z.string().nullable(),
    storefrontUrl: z.string().nullable(),
    /** No business name is set, so `name` is the Store URL host. */
    nameFromAddress: z.boolean(),
});

app.openapi(createRoute({
    method: "get",
    path: "/",
    operationId: "dashboard.notifications.templates_get",
    tags: ["Admin - Settings"],
    summary: "Get customer notification templates",
    request: { query: z.object({ locale: localeSchema.optional() }) },
    responses: {
        200: {
            description: "Templates",
            content: { "application/json": { schema: successEnvelope(templatesInLanguageSchema.extend({ store: previewStoreSchema })) } },
        },
        ...errorResponses,
    },
}), async (c) => {
    const db = c.get("db");
    const { locale } = c.req.valid("query");
    const [store, templates] = await Promise.all([readStoreIdentity(db), getNotificationTemplatesInLanguage(db, locale)]);
    return ok(c, {
        ...templates,
        store: {
            name: store.name,
            logoUrl: store.logoUrl,
            storefrontUrl: c.env.STOREFRONT_URL || null,
            nameFromAddress: store.nameFromAddress,
        },
    });
});

app.openapi(createRoute({
    method: "put",
    path: "/",
    operationId: "dashboard.notifications.templates_update",
    tags: ["Admin - Settings"],
    summary: "Save the customer message templates for one event",
    request: {
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        event: eventSchema,
                        email: emailTemplateSchema.optional(),
                        sms: smsTemplateSchema.optional(),
                        locale: localeSchema.optional(),
                        expectedRevision: z.number().int().nonnegative(),
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: { description: "Saved templates", content: { "application/json": { schema: successEnvelope(templatesSchema) } } },
        ...errorResponses,
        409: conflictResponse,
    },
}), async (c) => {
    const { expectedRevision, ...input } = c.req.valid("json");
    return ok(c, await saveNotificationTemplate(c.get("db"), input, { expectedRevision }));
});

const testSendSchema = z.discriminatedUnion("channel", [
    z.object({
        channel: z.literal("email"),
        event: eventSchema,
        subject: emailTemplateSchema.shape.subject,
        body: emailTemplateSchema.shape.body,
        locale: localeSchema.optional(),
    }).strict(),
    z.object({
        channel: z.literal("sms"),
        event: eventSchema,
        body: smsTemplateSchema.shape.body,
        phone: z.string().max(32),
        locale: localeSchema.optional(),
    }).strict(),
]);

app.openapi(createRoute({
    method: "post",
    path: "/test",
    operationId: "dashboard.notifications.template_test_send",
    tags: ["Admin - Settings"],
    summary: "Send a draft template with sample data (email to yourself, SMS to a number you enter)",
    request: { body: { required: true, content: { "application/json": { schema: testSendSchema } } } },
    responses: {
        200: {
            description: "Test sent",
            content: { "application/json": { schema: successEnvelope(z.object({ sentTo: z.string() })) } },
        },
        ...errorResponses,
    },
}), async (c) => {
    const db = c.get("db");
    const input = c.req.valid("json");

    const fields = input.channel === "email" ? { subject: input.subject, body: input.body } : { body: input.body };
    for (const [field, text] of Object.entries(fields)) {
        const unknown = findUnknownVariables(text, input.event);
        if (unknown.length > 0) {
            const message = `${unknown.map((name) => `{{${name}}}`).join(", ")} can't be used in this message.`;
            throw new ValidationError(message, { issues: [{ path: [input.channel, field], message }] });
        }
    }

    const phone = input.channel === "sms" ? normalizeBdMobile(input.phone) : null;
    if (input.channel === "sms" && !phone) {
        const message = "Enter a Bangladesh mobile number like 01712-345678.";
        throw new ValidationError(message, { issues: [{ path: ["phone"], message }] });
    }
    await requireWithinRateLimit(c.env, "RL_STRICT", "notification-test-send", requestActorId(c) ?? "anonymous", "Too many test messages. Wait a minute and try again.");

    const store = await readStoreIdentity(db);
    // A draft of another language's version is sent in that language's frame and digits.
    const language = messageLanguageOf(store, input.locale);
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);

    if (input.channel === "email") {
        // The test goes to the signed-in staff member's own address: an app has none to send to.
        requireStaffId(c, "Sign in again to send a test email.");
        const to = requestStaffUser(c)?.email ?? "";
        const email = sampleOrderEmail({
            event: input.event,
            language,
            store,
            template: { subject: input.subject, body: input.body },
            origin: c.env.STOREFRONT_URL,
        });
        const result = await sendEmail({ ...email, to, fromName: store.name ?? undefined }, {
            db,
            env: c.env as unknown as Record<string, unknown>,
            encryptionKey,
            appProviders: requestAppProviders(c),
        }).catch(() => null);
        if (!result?.success) {
            throw new ValidationError("Couldn't send the test email. Check the email sending setup under Sending.");
        }
        return ok(c, { sentTo: to });
    }

    const provider = await getActiveSmsProvider(db, encryptionKey, requestAppProviders(c));
    if (!provider) throw new ValidationError("Set up SMS under Sending before sending a test.");
    const message = renderSmsTemplate(input.event, language, input.body, sampleVariables(store.name ?? "", language));
    const result = await provider.send({ to: phone!, text: message }, {})
        .catch(() => ({ success: false as const, rawStatus: "provider_error" }));
    if (!result.success) {
        // Masked: the provider status only, never the number or the message.
        const status = String(result.rawStatus ?? "unknown").replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]").slice(0, 120);
        console.warn(`[Notifications] Test SMS via ${provider.id} failed: ${status}`);
        throw new ValidationError(`${provider.label} didn't accept the test SMS. Check the SMS setup under Sending.`);
    }
    return ok(c, { sentTo: `0${phone!.slice(4)}` });
});

export { app as notificationTemplatesRoutes };
