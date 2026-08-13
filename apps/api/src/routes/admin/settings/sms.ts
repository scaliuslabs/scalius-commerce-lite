import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getSmsSettings, saveSmsSettings, SMS_PROVIDER_IDS } from "@scalius/core/integrations/sms";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";
import { ok } from "../../../utils/api-response";
import { successEnvelope, messageResponse, errorResponses, serviceUnavailableResponse } from "../../../schemas/responses";
import { clearNotificationProviderBlocks } from "@scalius/core/modules/notifications/notification-provider-health";
import { invalidateApiAndScheduleStorefrontGroups } from "../../../utils/cache-invalidation";

const app = new OpenAPIHono<{ Bindings: Env }>();
const CHECKOUT_CACHE_GROUPS = ["checkout"] as const;
const MASKED = "••••••••••••";
const SMS_SECRET_MAX_LENGTH = 2_048;
const SMS_USERNAME_MAX_LENGTH = 320;
const SMS_SENDER_MAX_LENGTH = 128;
const SMS_BASE_URL_MAX_LENGTH = 2_048;
const SMS_PROVIDER_ERROR_MAX_LENGTH = 1_000;

// ─────────────────────────────────────────
// GET /sms — returns SMS provider settings with masked credentials
// ─────────────────────────────────────────

const smsSettingsSchema = z.object({
    activeProvider: z.enum(SMS_PROVIDER_IDS).nullable(),
    activeProviderConfigured: z.boolean(),
    activeProviderError: z.string().max(SMS_PROVIDER_ERROR_MAX_LENGTH).nullable(),
    bdbulksmsToken: z.string().max(MASKED.length),
    mimsmsUsername: z.string().max(SMS_USERNAME_MAX_LENGTH),
    mimsmsApiKey: z.string().max(MASKED.length),
    mimsmsSenderName: z.string().max(SMS_SENDER_MAX_LENGTH),
    smsnetbdApiKey: z.string().max(MASKED.length),
    smsnetbdSenderId: z.string().max(SMS_SENDER_MAX_LENGTH),
    gennetApiToken: z.string().max(MASKED.length),
    gennetBaseUrl: z.string().max(SMS_BASE_URL_MAX_LENGTH),
    gennetSid: z.string().max(SMS_SENDER_MAX_LENGTH),
});

function projectSmsSettings(
    data: Awaited<ReturnType<typeof getSmsSettings>>,
) {
    const masked = (value: string) => (value ? MASKED : "");
    return {
        activeProvider: SMS_PROVIDER_IDS.includes(data.activeProvider as never)
            ? data.activeProvider
            : null,
        activeProviderConfigured: data.activeProviderConfigured,
        activeProviderError:
            typeof data.activeProviderError === "string"
                ? data.activeProviderError.slice(0, SMS_PROVIDER_ERROR_MAX_LENGTH)
                : null,
        bdbulksmsToken: masked(data.bdbulksmsToken),
        mimsmsUsername: data.mimsmsUsername.slice(0, SMS_USERNAME_MAX_LENGTH),
        mimsmsApiKey: masked(data.mimsmsApiKey),
        mimsmsSenderName: data.mimsmsSenderName.slice(0, SMS_SENDER_MAX_LENGTH),
        smsnetbdApiKey: masked(data.smsnetbdApiKey),
        smsnetbdSenderId: data.smsnetbdSenderId.slice(0, SMS_SENDER_MAX_LENGTH),
        gennetApiToken: masked(data.gennetApiToken),
        gennetBaseUrl: data.gennetBaseUrl.slice(0, SMS_BASE_URL_MAX_LENGTH),
        gennetSid: data.gennetSid.slice(0, SMS_SENDER_MAX_LENGTH),
    };
}

const getSmsRoute = createRoute({
    method: "get",
    path: "/sms",
    operationId: "dashboard.settings_sms.get_sms",
    tags: ["Admin - Settings"],
    summary: "Get SMS provider settings",
    responses: {
        200: { description: "SMS settings", content: { "application/json": { schema: successEnvelope(smsSettingsSchema) } } },
        ...errorResponses,
    },
});

app.openapi(getSmsRoute, async (c) => {
    const db = c.get("db");
    const data = await getSmsSettings(db, getCredentialEncryptionKey(c.env as Record<string, unknown>));
    return ok(c, projectSmsSettings(data));
});

// ─────────────────────────────────────────
// POST /sms — saves SMS provider settings (encrypted where needed)
// ─────────────────────────────────────────

const saveSmsSchema = z.object({
    activeProvider: z.enum(SMS_PROVIDER_IDS).optional(),
    bdbulksmsToken: z.string().max(SMS_SECRET_MAX_LENGTH).optional(),
    mimsmsUsername: z.string().max(SMS_USERNAME_MAX_LENGTH).optional(),
    mimsmsApiKey: z.string().max(SMS_SECRET_MAX_LENGTH).optional(),
    mimsmsSenderName: z.string().max(SMS_SENDER_MAX_LENGTH).optional(),
    smsnetbdApiKey: z.string().max(SMS_SECRET_MAX_LENGTH).optional(),
    smsnetbdSenderId: z.string().max(SMS_SENDER_MAX_LENGTH).optional(),
    gennetApiToken: z.string().max(SMS_SECRET_MAX_LENGTH).optional(),
    gennetBaseUrl: z.string().max(SMS_BASE_URL_MAX_LENGTH).optional(),
    gennetSid: z.string().max(SMS_SENDER_MAX_LENGTH).optional(),
});

const SMS_SECRET_FIELDS = [
    "bdbulksmsToken",
    "mimsmsApiKey",
    "smsnetbdApiKey",
    "gennetApiToken",
] as const;

function hasSmsSecretWrite(body: z.infer<typeof saveSmsSchema>): boolean {
    return SMS_SECRET_FIELDS.some((field) => {
        const value = body[field];
        return typeof value === "string" && value.trim() !== "" && !value.startsWith("••••");
    });
}

const saveSmsRoute = createRoute({
    method: "post",
    path: "/sms",
    operationId: "dashboard.settings_sms.sms",
    tags: ["Admin - Settings"],
    summary: "Save SMS provider settings",
    request: { body: { required: true, content: { "application/json": { schema: saveSmsSchema } } } },
    responses: {
        200: { description: "SMS settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(saveSmsRoute, async (c) => {
    const db = c.get("db");
    const body = c.req.valid("json");
    const encKey = hasSmsSecretWrite(body)
        ? requireEncryptionKey(c.env as Record<string, unknown>)
        : getCredentialEncryptionKey(c.env as Record<string, unknown>);
    await saveSmsSettings(db, body, encKey);
    await clearNotificationProviderBlocks(db, { channel: "sms" });
    // SMS provider readiness participates in public checkout readiness when
    // customer sign-in is required; do not leave the cached projection stale.
    await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
    return ok(c, { message: "SMS settings saved successfully" });
});

export { app as smsSettingsRoutes };
