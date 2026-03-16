// src/server/routes/admin/openrouter.ts
// Admin OpenAPI routes for OpenRouter AI generation.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { settings } from "@scalius/database/schema";
import { ok } from "../../utils/api-response";
import { ValidationError } from "../../utils/api-error";
import {
    OPENROUTER_BASE_URL,
    OPENROUTER_HEADERS,
    GENERATION_CONFIG,
    getTimeout,
    ERROR_MESSAGES
} from "@scalius/core/modules/ai/ai-config";

const app = new OpenAPIHono();

// ── List Models ──

const listModelsRoute = createRoute({
    method: "get",
    path: "/models",
    tags: ["Admin - OpenRouter"],
    summary: "List available OpenRouter models",
    responses: {
        200: { description: "Model list"  }
    }
});

app.openapi(listModelsRoute, async (c) => {
    try {
        const response = await fetch("https://openrouter.ai/api/v1/models");

        if (!response.ok) {
            throw new Error("Failed to fetch models from OpenRouter");
        }

        const data = await response.json() as { data?: Array<Record<string, unknown>> };

        interface ModelArchitecture {
            input_modalities?: string[];
            output_modalities?: string[];
            modality?: string;
        }

        const processedModels = (data.data || []).map((model: Record<string, unknown>) => {
            const architecture = model.architecture as ModelArchitecture | undefined;
            return {
                id: model.id,
                name: model.name,
                description: model.description,
                context_length: model.context_length,
                pricing: model.pricing,
                supportsVision: architecture?.input_modalities?.includes('image') || false,
                supportsAudio: architecture?.input_modalities?.includes('audio') || false,
                supportsImageGeneration: architecture?.output_modalities?.includes('image') || false,
                modality: architecture?.modality || 'text->text',
                inputModalities: architecture?.input_modalities || ['text'],
                outputModalities: architecture?.output_modalities || ['text']
            };
        });

        return ok(c, { models: processedModels });
    } catch (error: unknown) {
        console.error("Error fetching OpenRouter models:", error);
        throw error;
    }
});

// ── Generate ──

const generateRoute = createRoute({
    method: "post",
    path: "/generate",
    tags: ["Admin - OpenRouter"],
    summary: "Generate AI content via OpenRouter",
    responses: {
        200: { description: "Generation result"  }
    }
});

app.openapi(generateRoute, async (c) => {
    const db = c.get("db");
    try {
        const apiKeyRecord = await db
            .select({ value: settings.value })
            .from(settings)
            .where(eq(settings.key, "openrouter_api_key"))
            .get();

        const apiKey = apiKeyRecord?.value;
        if (!apiKey) {
            throw new ValidationError(ERROR_MESSAGES.apiKeyMissing);
        }

        const body = await c.req.json();
        const { messages, prompt, model, stream, images } = body;

        if (!model) {
            throw new ValidationError("Model is required.");
        }

        let finalMessages: Array<{ role: string; content: unknown }>;

        if (messages && Array.isArray(messages)) {
            finalMessages = messages;
        } else if (prompt) {
            if (images && Array.isArray(images) && images.length > 0) {
                const content: Array<{ type: string; text?: string }> = [
                    { type: "text", text: prompt },
                    ...images
                ];
                finalMessages = [{ role: "user", content }];
            } else {
                finalMessages = [{ role: "user", content: prompt }];
            }
        } else {
            throw new ValidationError("Messages or prompt is required.");
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
                        "X-Title": OPENROUTER_HEADERS.title
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: finalMessages,
                        stream: stream || false,
                        temperature: GENERATION_CONFIG.temperature.generation
                    }),
                    signal: controller.signal
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

                console.error("OpenRouter API Error:", errorBody);
                throw new ValidationError(errorMessage);
            }

            if (stream) {
                return new Response(response.body, {
                    headers: {
                        "Content-Type": "text/event-stream",
                        "Connection": "keep-alive",
                        "Cache-Control": "no-cache"
                    }
                });
            } else {
                const data = await response.json() as Record<string, unknown> & {
                    usage?: { total_tokens?: number; prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
                };

                if (data.usage) {
                    const cached = data.usage.prompt_tokens_details?.cached_tokens || 0;
                    const cacheRate = cached && data.usage.prompt_tokens ? Math.round((cached / data.usage.prompt_tokens) * 100) : 0;
                    console.log(`[OpenRouter] ${model} | ${requestDuration}ms | Tokens: ${data.usage.total_tokens} | Cache: ${cacheRate}%`);
                } else {
                    console.log(`[OpenRouter] ${model} | ${requestDuration}ms`);
                }

                return ok(c, data);
            }
        } catch (error: unknown) {
            clearTimeout(timeoutId);
            if (error instanceof Error && error.name === 'AbortError') {
                throw new ValidationError(ERROR_MESSAGES.timeoutError);
            }
            throw error;
        }
    } catch (error: unknown) {
        console.error("Error in generate endpoint:", error);
        throw error;
    }
});

// ── Generate Staged ──

const generateStagedRoute = createRoute({
    method: "post",
    path: "/generate-staged",
    tags: ["Admin - OpenRouter"],
    summary: "Generate AI content in stages via OpenRouter",
    responses: {
        200: { description: "Staged generation result"  }
    }
});

app.openapi(generateStagedRoute, async (c) => {
    const db = c.get("db");
    try {
        const apiKeyRecord = await db
            .select({ value: settings.value })
            .from(settings)
            .where(eq(settings.key, "openrouter_api_key"))
            .get();

        const apiKey = apiKeyRecord?.value;
        if (!apiKey) {
            throw new ValidationError(ERROR_MESSAGES.apiKeyMissing);
        }

        const {
            model,
            messages,
            stage,
            sectionIndex,
            totalSections
        } = await c.req.json();

        if (!model || !messages) {
            throw new ValidationError("Model and messages are required.");
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
                        "X-Title": OPENROUTER_HEADERS.title
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: preparedMessages,
                        stream: false,
                        ...(stage === 'plan' ? { response_format: { type: "json_object" } } : {}),
                        temperature: stage === "plan"
                            ? GENERATION_CONFIG.temperature.planning
                            : GENERATION_CONFIG.temperature.generation
                    }),
                    signal: controller.signal
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

                console.error("OpenRouter API Error:", errorBody);
                throw new ValidationError(errorMessage);
            }

            const data = await response.json() as Record<string, unknown> & {
                usage?: { total_tokens?: number; prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
            };

            if (data.usage) {
                const cached = data.usage.prompt_tokens_details?.cached_tokens || 0;
                const cacheRate = cached && data.usage.prompt_tokens ? Math.round((cached / data.usage.prompt_tokens) * 100) : 0;
                const stageInfo = sectionIndex !== undefined ? `Section ${sectionIndex + 1}/${totalSections}` : stage;
                console.log(`[Staged] ${model} | ${stageInfo} | ${requestDuration}ms | Tokens: ${data.usage.total_tokens} | Cache: ${cacheRate}%`);
            } else {
                const stageInfo = sectionIndex !== undefined ? `Section ${sectionIndex + 1}/${totalSections}` : stage;
                console.log(`[Staged] ${model} | ${stageInfo} | ${requestDuration}ms`);
            }

            return ok(c, {
                ...data,
                stage,
                sectionIndex,
                totalSections
            });
        } catch (error: unknown) {
            clearTimeout(timeoutId);
            if (error instanceof Error && error.name === 'AbortError') {
                throw new ValidationError(ERROR_MESSAGES.timeoutError);
            }
            throw error;
        }
    } catch (error: unknown) {
        console.error("Error in staged generation endpoint:", error);
        throw error;
    }
});

export { app as adminOpenRouterRoutes };
