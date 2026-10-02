// Settings → Customer accounts → Marketing (Customers & marketing): the
// checkout consent checkbox (label per language, channels; always unchecked,
// never required) and e-mail double opt-in. One settings document with its
// revision; a stale save is a 409.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { marketingConsentDocument } from "@scalius/core/modules/settings";
import { marketingConsentSettingsSchema } from "@scalius/shared/customer-marketing";
import { ok } from "../../../utils/api-response";
import { conflictResponse, errorResponses, successEnvelope } from "../../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const payloadSchema = z.object({
    settings: marketingConsentSettingsSchema,
    revision: z.number().int().nonnegative(),
});

const getRoute = createRoute({
    method: "get",
    path: "/marketing-consent",
    operationId: "dashboard.settings.marketing_consent_get",
    tags: ["Admin - Settings"],
    summary: "Get marketing consent settings",
    responses: {
        200: { description: "Marketing consent settings", content: { "application/json": { schema: successEnvelope(payloadSchema) } } },
        ...errorResponses,
    },
});

app.openapi(getRoute, async (c) => {
    const { value, revision } = await marketingConsentDocument.readDetailed(c.get("db"), {}, { skipCache: true });
    return ok(c, { settings: value, revision });
});

const saveRoute = createRoute({
    method: "put",
    path: "/marketing-consent",
    operationId: "dashboard.settings.marketing_consent_update",
    tags: ["Admin - Settings"],
    summary: "Save marketing consent settings",
    request: {
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        settings: marketingConsentSettingsSchema,
                        expectedRevision: z.number().int().nonnegative(),
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: { description: "Saved", content: { "application/json": { schema: successEnvelope(payloadSchema) } } },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(saveRoute, async (c) => {
    const { settings, expectedRevision } = c.req.valid("json");
    const saved = await marketingConsentDocument.write(c.get("db"), settings, {}, { replace: true, expectedRevision });
    return ok(c, { settings: saved.value, revision: saved.revision });
});

export { app as marketingConsentSettingsRoutes };
