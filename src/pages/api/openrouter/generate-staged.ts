import type { APIRoute } from "astro";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_HEADERS,
  GENERATION_CONFIG,
  getTimeout,
  ERROR_MESSAGES,
} from "@/lib/ai-config";

/**
 * Staged Generation API
 * Handles multi-stage widget generation with progressive rendering
 * Supports prompt caching for efficiency
 */

export const POST: APIRoute = async ({ request }) => {
  try {
    // 1. Get API Key from DB
    const apiKeyRecord = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, "openrouter_api_key"))
      .get();

    const apiKey = apiKeyRecord?.value;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ message: ERROR_MESSAGES.apiKeyMissing }),
        { status: 400 }
      );
    }

    // 2. Get request body
    const {
      model,
      messages,
      stage, // 'plan' | 'generate'
      sectionIndex,
      totalSections,
    } = await request.json();

    if (!model || !messages) {
      return new Response(
        JSON.stringify({ message: "Model and messages are required." }),
        { status: 400 }
      );
    }

    // 3. Messages already have cache_control applied by generateStructuredPrompt()
    // for Anthropic models. Auto-caching models (Gemini, Grok, OpenAI) cache automatically.
    // No server-side modification needed.
    const preparedMessages = messages;

    // 4. Create AbortController for timeout
    const controller = new AbortController();
    const timeoutMs = stage === 'plan' ? getTimeout('planning') : getTimeout('generation');
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const requestStartTime = Date.now();

      // 6. Call OpenRouter API (NO JSON MODE - use tag-based format)
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
            stream: false, // Non-streaming for staged generation
            // Planning stage needs JSON for structured plan, generation stage uses tags
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

        // Parse OpenRouter error format
        try {
          const errorJson = JSON.parse(errorBody);
          errorMessage = errorJson.error?.message || errorMessage;
        } catch (e) {
          errorMessage = errorBody.substring(0, 200);
        }

        console.error("❌ OpenRouter API Error:", errorBody);
        return new Response(
          JSON.stringify({
            message: errorMessage,
            details: errorBody,
          }),
          { status: response.status }
        );
      }

      // 5. Return response with usage info
      const data = await response.json();

      // Log only critical production info
      if (data.usage) {
        const cached = data.usage.prompt_tokens_details?.cached_tokens || 0;
        const cacheRate = cached ? Math.round((cached / data.usage.prompt_tokens) * 100) : 0;
        const stageInfo = sectionIndex !== undefined ? `Section ${sectionIndex + 1}/${totalSections}` : stage;
        console.log(`[Staged] ${model} | ${stageInfo} | ${requestDuration}ms | Tokens: ${data.usage.total_tokens} | Cache: ${cacheRate}%`);
      } else {
        const stageInfo = sectionIndex !== undefined ? `Section ${sectionIndex + 1}/${totalSections}` : stage;
        console.log(`[Staged] ${model} | ${stageInfo} | ${requestDuration}ms`);
      }

      return new Response(
        JSON.stringify({
          ...data,
          stage,
          sectionIndex,
          totalSections,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    } catch (error: any) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        return new Response(
          JSON.stringify({ message: ERROR_MESSAGES.timeoutError }),
          { status: 408 }
        );
      }

      throw error;
    }
  } catch (error: any) {
    console.error("Error in staged generation endpoint:", error);
    return new Response(
      JSON.stringify({
        message: ERROR_MESSAGES.networkError,
        details: error.message,
      }),
      { status: 500 }
    );
  }
};
