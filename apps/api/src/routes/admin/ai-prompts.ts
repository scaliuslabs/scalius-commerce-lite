// src/server/routes/admin/ai-prompts.ts
// Admin OpenAPI routes for AI system prompts.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { errorResponses } from "../../schemas/responses";
import { getWidgetAiPrompt } from "@scalius/core/modules/ai";

const app = new OpenAPIHono<{ Bindings: Env }>();

const getPromptRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - AI Prompts"],
    summary: "Fetch an AI system prompt by type",
    request: {
        query: z.object({
            type: z.string().optional().default("widget").openapi({ description: "Prompt type: widget, landing-page, or collection" })
        })
    },
    responses: {
        200: { description: "System prompt text", content: { "text/plain": { schema: z.string() } } },
        ...errorResponses,
    }
});

app.openapi(getPromptRoute, async (c) => {
    const { type } = c.req.valid("query");
    const db = c.get("db");
    const systemPrompt = await getWidgetAiPrompt(db, type);

    return c.text(systemPrompt, 200, {
        "Content-Type": "text/plain",
        "Cache-Control": "private, max-age=60"
    });
});

export { app as adminAiPromptsRoutes };
