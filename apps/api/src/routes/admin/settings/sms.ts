import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getSmsSettings, saveSmsSettings, invalidateSmsCache, SMS_PROVIDER_IDS } from "@scalius/core/integrations/sms";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";
import { ok } from "../../../utils/api-response";
import { successEnvelope, messageResponse, errorResponses } from "../../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─────────────────────────────────────────
// GET /sms — returns SMS provider settings with masked credentials
// ─────────────────────────────────────────

const smsSettingsSchema = z.object({
    activeProvider: z.string().nullable(),
    activeProviderConfigured: z.boolean(),
    activeProviderError: z.string().nullable(),
    bdbulksmsToken: z.string(),
    mimsmsUsername: z.string(),
    mimsmsApiKey: z.string(),
    mimsmsSenderName: z.string(),
    smsnetbdApiKey: z.string(),
    smsnetbdSenderId: z.string(),
    gennetApiToken: z.string(),
    gennetBaseUrl: z.string(),
    gennetSid: z.string(),
});

const getSmsRoute = createRoute({
    method: "get",
    path: "/sms",
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
    return ok(c, data);
});

// ─────────────────────────────────────────
// POST /sms — saves SMS provider settings (encrypted where needed)
// ─────────────────────────────────────────

const saveSmsSchema = z.object({
    activeProvider: z.enum(SMS_PROVIDER_IDS).optional(),
    bdbulksmsToken: z.string().optional(),
    mimsmsUsername: z.string().optional(),
    mimsmsApiKey: z.string().optional(),
    mimsmsSenderName: z.string().optional(),
    smsnetbdApiKey: z.string().optional(),
    smsnetbdSenderId: z.string().optional(),
    gennetApiToken: z.string().optional(),
    gennetBaseUrl: z.string().optional(),
    gennetSid: z.string().optional(),
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
    tags: ["Admin - Settings"],
    summary: "Save SMS provider settings",
    request: { body: { content: { "application/json": { schema: saveSmsSchema } } } },
    responses: {
        200: { description: "SMS settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    },
});

app.openapi(saveSmsRoute, async (c) => {
    const db = c.get("db");
    const body = c.req.valid("json");
    const encKey = hasSmsSecretWrite(body)
        ? requireEncryptionKey(c.env as Record<string, unknown>)
        : getCredentialEncryptionKey(c.env as Record<string, unknown>);
    await saveSmsSettings(db, body, encKey);
    invalidateSmsCache();
    return ok(c, { message: "SMS settings saved successfully" });
});

export { app as smsSettingsRoutes };
