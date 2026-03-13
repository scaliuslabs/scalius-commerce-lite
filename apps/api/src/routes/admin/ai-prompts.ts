// src/server/routes/admin/ai-prompts.ts
// Admin OpenAPI routes for AI system prompts.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

const app = new OpenAPIHono();

const PROMPT_URLS = {
    widget: "https://text.wrygo.com/home-page-prompt.txt",
    "landing-page": "https://text.wrygo.com/pages-prompt.txt",
    collection: "https://text.wrygo.com/collection-prompt.txt",
};

const getPromptRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - AI Prompts"],
    summary: "Fetch an AI system prompt by type",
    request: {
        query: z.object({
            type: z.string().optional().default("widget").openapi({ description: "Prompt type: widget, landing-page, or collection" }),
        }),
    },
    responses: {
        200: { description: "System prompt text" },
    },
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
                "User-Agent": "Scalius-Commerce-Widget-System/1.0",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch system prompt from ${promptUrl}: ${response.status} ${response.statusText}`);
        }

        const systemPrompt = await response.text();

        if (!systemPrompt || systemPrompt.trim().length === 0) {
            throw new Error("System prompt is empty");
        }

        return c.text(systemPrompt, 200, {
            "Content-Type": "text/plain",
            "Cache-Control": "public, max-age=300",
        });
    } catch (error: any) {
        console.error("Error fetching system prompt:", error);
        return c.json({
            error: "Failed to fetch system prompt",
            message: error.message || "Unknown error occurred",
        }, 500);
    }
});

export { app as adminAiPromptsRoutes };
