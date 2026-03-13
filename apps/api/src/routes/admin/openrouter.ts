import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { settings } from "@scalius/database/schema";
import {
    OPENROUTER_BASE_URL,
    OPENROUTER_HEADERS,
    GENERATION_CONFIG,
    getTimeout,
    ERROR_MESSAGES,
} from "@scalius/core/modules/ai/ai-config";

const app = new Hono<{
    Variables: {
        db: any;
        env: any;
    };
}>();

// GET /api/v1/admin/openrouter/models
app.get("/models", async (c) => {
    try {
        const response = await fetch("https://openrouter.ai/api/v1/models");

        if (!response.ok) {
            throw new Error("Failed to fetch models from OpenRouter");
        }

        const data = await response.json();

        const processedModels = (data.data || []).map((model: any) => ({
            id: model.id,
            name: model.name,
            description: model.description,
            context_length: model.context_length,
            pricing: model.pricing,
            supportsVision: model.architecture?.input_modalities?.includes('image') || false,
            supportsAudio: model.architecture?.input_modalities?.includes('audio') || false,
            supportsImageGeneration: model.architecture?.output_modalities?.includes('image') || false,
            modality: model.architecture?.modality || 'text->text',
            inputModalities: model.architecture?.input_modalities || ['text'],
            outputModalities: model.architecture?.output_modalities || ['text'],
        }));

        return c.json({ models: processedModels });
    } catch (error: any) {
        console.error("Error fetching OpenRouter models:", error);
        return c.json({ message: "Error fetching models" }, 500);
    }
});

// POST /api/v1/admin/openrouter/generate
app.post("/generate", async (c) => {
    const db = c.get("db");
    try {
        const apiKeyRecord = await db
            .select({ value: settings.value })
            .from(settings)
            .where(eq(settings.key, "openrouter_api_key"))
            .get();

        const apiKey = apiKeyRecord?.value;
        if (!apiKey) {
            return c.json({ message: ERROR_MESSAGES.apiKeyMissing }, 400);
        }

        const body = await c.req.json();
        const { messages, prompt, model, stream, images } = body;

        if (!model) {
            return c.json({ message: "Model is required." }, 400);
        }

        let finalMessages: any[];

        if (messages && Array.isArray(messages)) {
            finalMessages = messages;
        } else if (prompt) {
            if (images && Array.isArray(images) && images.length > 0) {
                const content: any[] = [
                    { type: "text", text: prompt },
                    ...images
                ];
                finalMessages = [{ role: "user", content }];
            } else {
                finalMessages = [{ role: "user", content: prompt }];
            }
        } else {
            return c.json({ message: "Messages or prompt is required." }, 400);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(
            () => controller.abort(),
            getTimeout('generation')
        );

        try {
            const requestStartTime = Date.now();

            const response = await fetch(
                `${OPENROUTER_BASE_URL}/chat/completions`,
                {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                        "HTTP-Referer": OPENROUTER_HEADERS.referer,
                        "X-Title": OPENROUTER_HEADERS.title,
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: finalMessages,
                        stream: stream || false,
                        temperature: GENERATION_CONFIG.temperature.generation,
                    }),
                    signal: controller.signal,
                }
            );

            clearTimeout(timeoutId);
            const requestDuration = Date.now() - requestStartTime;

            if (!response.ok) {
                const errorBody = await response.text();
                let errorMessage = ERROR_MESSAGES.generationFailed("Unknown error");

                try {
                    const errorJson = JSON.parse(errorBody);
                    errorMessage = errorJson.error?.message || errorMessage;
                } catch (e) {
                    errorMessage = errorBody.substring(0, 200);
                }

                console.error("❌ OpenRouter API Error:", errorBody);
                return c.json({ message: errorMessage, status: response.status }, response.status as any);
            }

            if (stream) {
                return new Response(response.body, {
                    headers: {
                        "Content-Type": "text/event-stream",
                        "Connection": "keep-alive",
                        "Cache-Control": "no-cache",
                    },
                });
            } else {
                const data = await response.json();

                if (data.usage) {
                    const cached = data.usage.prompt_tokens_details?.cached_tokens || 0;
                    const cacheRate = cached ? Math.round((cached / data.usage.prompt_tokens) * 100) : 0;
                    console.log(`[OpenRouter] ${model} | ${requestDuration}ms | Tokens: ${data.usage.total_tokens} | Cache: ${cacheRate}%`);
                } else {
                    console.log(`[OpenRouter] ${model} | ${requestDuration}ms`);
                }

                return c.json(data);
            }
        } catch (error: any) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                return c.json({ message: ERROR_MESSAGES.timeoutError }, 408);
            }
            throw error;
        }
    } catch (error: any) {
        console.error("Error in generate endpoint:", error);
        return c.json({
            message: ERROR_MESSAGES.networkError,
            details: error.message,
        }, 500);
    }
});

// POST /api/v1/admin/openrouter/generate-staged
app.post("/generate-staged", async (c) => {
    const db = c.get("db");
    try {
        const apiKeyRecord = await db
            .select({ value: settings.value })
            .from(settings)
            .where(eq(settings.key, "openrouter_api_key"))
            .get();

        const apiKey = apiKeyRecord?.value;
        if (!apiKey) {
            return c.json({ message: ERROR_MESSAGES.apiKeyMissing }, 400);
        }

        const {
            model,
            messages,
            stage,
            sectionIndex,
            totalSections,
        } = await c.req.json();

        if (!model || !messages) {
            return c.json({ message: "Model and messages are required." }, 400);
        }

        const preparedMessages = messages;
        const controller = new AbortController();
        const timeoutMs = stage === 'plan' ? getTimeout('planning') : getTimeout('generation');
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const requestStartTime = Date.now();

            const response = await fetch(
                `${OPENROUTER_BASE_URL}/chat/completions`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                        "HTTP-Referer": OPENROUTER_HEADERS.referer,
                        "X-Title": OPENROUTER_HEADERS.title,
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: preparedMessages,
                        stream: false,
                        ...(stage === 'plan' ? { response_format: { type: "json_object" } } : {}),
                        temperature: stage === "plan"
                            ? GENERATION_CONFIG.temperature.planning
                            : GENERATION_CONFIG.temperature.generation,
                    }),
                    signal: controller.signal,
                }
            );

            clearTimeout(timeoutId);
            const requestDuration = Date.now() - requestStartTime;

            if (!response.ok) {
                const errorBody = await response.text();
                let errorMessage = ERROR_MESSAGES.generationFailed("Unknown error");

                try {
                    const errorJson = JSON.parse(errorBody);
                    errorMessage = errorJson.error?.message || errorMessage;
                } catch (e) {
                    errorMessage = errorBody.substring(0, 200);
                }

                console.error("❌ OpenRouter API Error:", errorBody);
                return c.json({ message: errorMessage, details: errorBody }, response.status as any);
            }

            const data = await response.json();

            if (data.usage) {
                const cached = data.usage.prompt_tokens_details?.cached_tokens || 0;
                const cacheRate = cached ? Math.round((cached / data.usage.prompt_tokens) * 100) : 0;
                const stageInfo = sectionIndex !== undefined ? `Section ${sectionIndex + 1}/${totalSections}` : stage;
                console.log(`[Staged] ${model} | ${stageInfo} | ${requestDuration}ms | Tokens: ${data.usage.total_tokens} | Cache: ${cacheRate}%`);
            } else {
                const stageInfo = sectionIndex !== undefined ? `Section ${sectionIndex + 1}/${totalSections}` : stage;
                console.log(`[Staged] ${model} | ${stageInfo} | ${requestDuration}ms`);
            }

            return c.json({
                ...data,
                stage,
                sectionIndex,
                totalSections,
            });
        } catch (error: any) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                return c.json({ message: ERROR_MESSAGES.timeoutError }, 408);
            }
            throw error;
        }
    } catch (error: any) {
        console.error("Error in staged generation endpoint:", error);
        return c.json({
            message: ERROR_MESSAGES.networkError,
            details: error.message,
        }, 500);
    }
});

export { app as adminOpenRouterRoutes };
