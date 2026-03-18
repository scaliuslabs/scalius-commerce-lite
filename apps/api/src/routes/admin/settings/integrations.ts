import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

import { ok } from "../../../utils/api-response";
const app = new OpenAPIHono();
const MASKED_VALUE = "••••••••••••";

// ─────────────────────────────────────────
// OPENROUTER
// ─────────────────────────────────────────

const getOpenRouterRoute = createRoute({
    method: "get",
    path: "/openrouter",
    tags: ["Admin - Settings"],
    summary: "Get OpenRouter API key status",
    responses: { 200: { description: "API key status"  } }
});

app.openapi(getOpenRouterRoute, async (c) => {
    try {
        const db = c.get("db");
        const result = await db
            .select({ value: settings.value })
            .from(settings)
            .where(and(eq(settings.key, "openrouter_api_key"), eq(settings.category, "integrations")))
            .get();

        const maskedApiKey = result?.value ? MASKED_VALUE : "";
        return ok(c, { apiKey: maskedApiKey });
    } catch (error: unknown) {
        throw error;
    }
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
    responses: { 200: { description: "API key saved"  } }
});

app.openapi(saveOpenRouterRoute, async (c) => {
    try {
        const db = c.get("db");
        const { apiKey } = c.req.valid("json");
        if (apiKey === MASKED_VALUE) return ok(c, { message: "API key unchanged" });

        await db
            .insert(settings)
            .values({
                id: `set_${nanoid(10)}`,
                key: "openrouter_api_key",
                value: apiKey,
                type: "string",
                category: "integrations"
            })
            .onConflictDoUpdate({
                target: [settings.key, settings.category],
                set: { value: apiKey }
            });

        return ok(c, { message: "API key saved successfully" });
    } catch (error: unknown) {
        throw error;
    }
});

export { app as integrationSettingsRoutes };
