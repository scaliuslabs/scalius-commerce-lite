// src/server/routes/admin/ai-prompts.ts
// Admin OpenAPI routes for AI system prompts.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { errorResponses } from "../../schemas/responses";
import { ServiceUnavailableError } from "../../utils/api-error";

const app = new OpenAPIHono<{ Bindings: Env }>();

const PROMPT_URLS = {
    widget: "https://text.wrygo.com/home-page-prompt.txt",
    "landing-page": "https://text.wrygo.com/pages-prompt.txt",
    collection: "https://text.wrygo.com/collection-prompt.txt"
};

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
    const promptType = type as keyof typeof PROMPT_URLS;
    const promptUrl = PROMPT_URLS[promptType] || PROMPT_URLS.widget;

    try {
        const response = await fetch(promptUrl, {
            method: "GET",
            headers: {
                Accept: "text/plain",
                "User-Agent": "Scalius-Commerce-Widget-System/1.0"
            }
        });

        if (!response.ok) {
            throw new ServiceUnavailableError(`Failed to fetch system prompt from ${promptUrl}: ${response.status} ${response.statusText}`);
        }

        const systemPrompt = await response.text();

        if (!systemPrompt || systemPrompt.trim().length === 0) {
            throw new ServiceUnavailableError("System prompt is empty");
        }

        return c.text(systemPrompt, 200, {
            "Content-Type": "text/plain",
            "Cache-Control": "public, max-age=300"
        });
    } catch (error: unknown) {
        console.error("Error fetching system prompt:", error);
        throw error;
    }
});

export { app as adminAiPromptsRoutes };
