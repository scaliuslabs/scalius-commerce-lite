// The merchant's SMS gateway: an installed app's SMS provider
// (`<plugin id>:<provider id>`). Its keys are the app's own settings
// (encrypted, masked there); this route saves only the choice. A choice
// saved before the Bangladesh gateways moved into the Bangladesh pack reads
// as the pack's provider and says why it cannot send until the pack is active.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getSmsSettings, saveSmsSettings } from "@scalius/core/integrations/sms";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { assertAppProviderInstalled, requestAppProviders } from "../../../plugins/providers/app-providers";
import { getCredentialEncryptionKey } from "../../../utils/encryption-key";
import { ok } from "../../../utils/api-response";
import { successEnvelope, errorResponses, conflictResponse, serviceUnavailableResponse } from "../../../schemas/responses";
import { clearNotificationProviderBlocks } from "@scalius/core/modules/notifications";

const app = new OpenAPIHono<{ Bindings: Env }>();
const SMS_PROVIDER_ERROR_MAX_LENGTH = 1_000;

/** An installed app's SMS provider (`<plugin id>:<provider id>`). */
const smsProviderChoiceSchema = z.string().max(160).refine(isQualifiedProviderId, "Name an app provider as <plugin id>:<provider id>.");

// ─────────────────────────────────────────
// GET /sms — the gateway choice and whether it can send
// ─────────────────────────────────────────

const smsSettingsSchema = z.object({
    /** An app provider's `<plugin id>:<provider id>`. */
    activeProvider: z.string().max(160).nullable(),
    activeProviderConfigured: z.boolean(),
    /** Why the chosen gateway cannot send now, in the merchant's words. */
    activeProviderError: z.string().max(SMS_PROVIDER_ERROR_MAX_LENGTH).nullable(),
    revision: z.number().int().nonnegative(),
});

function projectSmsSettings(data: Awaited<ReturnType<typeof getSmsSettings>>) {
    return {
        activeProvider: data.activeProvider && isQualifiedProviderId(data.activeProvider) ? data.activeProvider : null,
        activeProviderConfigured: data.activeProviderConfigured,
        activeProviderError: typeof data.activeProviderError === "string" ? data.activeProviderError.slice(0, SMS_PROVIDER_ERROR_MAX_LENGTH) : null,
        revision: data.revision,
    };
}

const getSmsRoute = createRoute({
    method: "get",
    path: "/sms",
    operationId: "dashboard.settings_sms.get_sms",
    tags: ["Admin - Settings"],
    summary: "Get the SMS gateway choice",
    responses: {
        200: { description: "SMS settings", content: { "application/json": { schema: successEnvelope(smsSettingsSchema) } } },
        ...errorResponses,
    },
});

app.openapi(getSmsRoute, async (c) => {
    const data = await getSmsSettings(c.get("db"), getCredentialEncryptionKey(c.env as Record<string, unknown>), requestAppProviders(c));
    return ok(c, projectSmsSettings(data));
});

// ─────────────────────────────────────────
// POST /sms — saves the gateway choice
// ─────────────────────────────────────────

const saveSmsSchema = z.object({
    activeProvider: smsProviderChoiceSchema.optional(),
    expectedRevision: z.number().int().nonnegative(),
}).strict();

const saveSmsRoute = createRoute({
    method: "post",
    path: "/sms",
    operationId: "dashboard.settings_sms.sms",
    tags: ["Admin - Settings"],
    summary: "Save the SMS gateway choice",
    request: { body: { required: true, content: { "application/json": { schema: saveSmsSchema } } } },
    responses: {
        200: { description: "SMS settings saved", content: { "application/json": { schema: successEnvelope(smsSettingsSchema) } } },
        ...errorResponses,
        409: conflictResponse,
        503: serviceUnavailableResponse,
    },
});

app.openapi(saveSmsRoute, async (c) => {
    const db = c.get("db");
    const { expectedRevision, ...body } = c.req.valid("json");
    if (body.activeProvider) await assertAppProviderInstalled(db, "sms", body.activeProvider);
    await saveSmsSettings(db, body, undefined, { expectedRevision });
    await clearNotificationProviderBlocks(db, { channel: "sms" });
    // SMS provider readiness participates in public checkout readiness when
    // customer sign-in is required; do not leave the cached projection stale.

    return ok(c, projectSmsSettings(await getSmsSettings(db, getCredentialEncryptionKey(c.env as Record<string, unknown>), requestAppProviders(c))));
});

export { app as smsSettingsRoutes };
