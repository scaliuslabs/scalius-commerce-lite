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

    // 2. Parse request - NOW ACCEPTS MESSAGES ARRAY OR LEGACY PROMPT
    const body = await request.json();
    const { messages, prompt, model, stream, images } = body;

    if (!model) {
      return new Response(
        JSON.stringify({ message: "Model is required." }),
        { status: 400 }
      );
    }

    // 3. Prepare messages (support both old and new format)
    let finalMessages: any[];

    if (messages && Array.isArray(messages)) {
      // NEW FORMAT: Structured messages with caching support
      finalMessages = messages;
    } else if (prompt) {
      // LEGACY FORMAT: Single prompt string (for backward compatibility)
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
      return new Response(
        JSON.stringify({ message: "Messages or prompt is required." }),
        { status: 400 }
      );
    }

    // 4. Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      getTimeout('generation')
    );

    try {
      const requestStartTime = Date.now();

      // 5. Call OpenRouter API with structured messages (NO JSON MODE - use tag-based format)
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
            // REMOVED: response_format - Let LLM use tag-based format freely
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
            status: response.status,
          }),
          { status: response.status }
        );
      }

      // 6. Return response to client
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

        // Log only critical production info
        if (data.usage) {
          const cached = data.usage.prompt_tokens_details?.cached_tokens || 0;
          const cacheRate = cached ? Math.round((cached / data.usage.prompt_tokens) * 100) : 0;
          console.log(`[OpenRouter] ${model} | ${requestDuration}ms | Tokens: ${data.usage.total_tokens} | Cache: ${cacheRate}%`);
        } else {
          console.log(`[OpenRouter] ${model} | ${requestDuration}ms`);
        }

        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
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
    console.error("Error in generate endpoint:", error);
    return new Response(
      JSON.stringify({
        message: ERROR_MESSAGES.networkError,
        details: error.message,
      }),
      { status: 500 }
    );
  }
};
