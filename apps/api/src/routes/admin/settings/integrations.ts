import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

import { ok } from "../../../utils/api-response";
import { getEncryptionKey } from "../../../utils/encryption-key";
import { upsertEncryptedSetting } from "@scalius/core/modules/payments/gateway-settings";
import { successEnvelope, messageResponse, errorResponses } from "../../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED_VALUE = "••••••••••••";

// ─────────────────────────────────────────
// OPENROUTER
// ─────────────────────────────────────────

const getOpenRouterRoute = createRoute({
    method: "get",
    path: "/openrouter",
    tags: ["Admin - Settings"],
    summary: "Get OpenRouter API key status",
    responses: {
        200: { description: "API key status", content: { "application/json": { schema: successEnvelope(z.object({ apiKey: z.string() })) } } },
        ...errorResponses,
    }
});

app.openapi(getOpenRouterRoute, async (c) => {
    const db = c.get("db");
    const result = await db
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.key, "openrouter_api_key"), eq(settings.category, "integrations")))
        .get();

    const maskedApiKey = result?.value ? MASKED_VALUE : "";
    return ok(c, { apiKey: maskedApiKey });
});

const saveOpenRouterSchema = z.object({
    apiKey: z.string(),
});

const saveOpenRouterRoute = createRoute({
    method: "post",
    path: "/openrouter",
    tags: ["Admin - Settings"],
    summary: "Save OpenRouter API key",
    request: { body: { content: { "application/json": { schema: saveOpenRouterSchema } } } },
    responses: {
        200: { description: "API key saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(saveOpenRouterRoute, async (c) => {
    const db = c.get("db");
    const { apiKey } = c.req.valid("json");
    if (apiKey === MASKED_VALUE) return ok(c, { message: "API key unchanged" });

    const encKey = getEncryptionKey(c.env as Record<string, unknown>);
    await upsertEncryptedSetting(db, "integrations", "openrouter_api_key", apiKey, encKey);

    return ok(c, { message: "API key saved successfully" });
});

export { app as integrationSettingsRoutes };
