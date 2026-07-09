import type { ModelMessage } from "ai";
import {
  ERROR_MESSAGES,
  type WidgetAiProvider,
} from "@scalius/core/modules/ai";
import { parseTagBasedResponse } from "@scalius/shared/tag-parser";
import { ValidationError } from "../../utils/api-error";
import {
  createNoContextFallbackWidget,
  normalizeStagedPlanOutput,
  normalizeStagedPlanText,
  normalizeWidgetGenerationText,
  normalizeWidgetOutput,
  stagedPlanOutputObjectSpec,
  stagedPlanOutputSchema,
  widgetOutputObjectSpec,
  widgetOutputSchema,
  type WidgetPromptType,
} from "./ai-response-validation";
import type {
  GenerateTextOptions,
  GenerateTextResult,
  GenerationUsage,
  WidgetGenerationResult,
} from "./ai-widget-contract";

const NO_COMMERCE_FACTS_PROMPT_MARKER =
  "FACTUALITY GATE - NO COMMERCE FACTS PROVIDED";
const AI_NO_OBJECT_GENERATED_MARKER =
  "vercel.ai.error.AI_NoObjectGeneratedError";
const AI_UNSUPPORTED_FUNCTIONALITY_MARKER =
  "vercel.ai.error.AI_UnsupportedFunctionalityError";

export function openAiCompatibleJson(
  text: string,
  provider: WidgetAiProvider,
  model: string,
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
) {
  return {
    id: crypto.randomUUID(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    provider,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: usage?.inputTokens,
      completion_tokens: usage?.outputTokens,
      total_tokens: usage?.totalTokens,
    },
  };
}

export function openAiCompatibleStream(
  textStream: AsyncIterable<string>,
  options?: {
    finalize?: (rawText: string) => string | Promise<string>;
  },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let rawText = "";

      try {
        for await (const delta of textStream) {
          if (!delta) continue;
          rawText += delta;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`,
            ),
          );
        }

        if (options?.finalize) {
          const finalContent = await options.finalize(rawText);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: finalContent },
                    finish_reason: "stop",
                  },
                ],
              })}\n\n`,
            ),
          );
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              error: {
                message:
                  error instanceof Error ? error.message : "AI stream failed",
              },
            })}\n\n`,
          ),
        );
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export function usageFromResult(result: {
  totalUsage?: GenerationUsage;
}): GenerationUsage {
  return {
    inputTokens: result.totalUsage?.inputTokens,
    outputTokens: result.totalUsage?.outputTokens,
    totalTokens: result.totalUsage?.totalTokens,
  };
}

export function structuredGenerationFailureDetails(
  error: unknown,
): Record<string, unknown> {
  if (isAiNoObjectGeneratedError(error)) {
    return {
      type: "NoObjectGeneratedError",
      cause:
        error.cause instanceof Error
          ? error.cause.message
          : String(error.cause ?? ""),
      finishReason: error.finishReason,
      usage: error.usage,
      response: error.response,
      textSample: error.text?.slice(0, 800),
    };
  }

  if (isAiUnsupportedFunctionalityError(error)) {
    return {
      type: "UnsupportedFunctionalityError",
      functionality: error.functionality,
      message: error.message,
    };
  }

  return {
    type: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function hasAiErrorMarker(error: unknown, marker: string): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    (error as Record<symbol, unknown>)[Symbol.for(marker)] === true,
  );
}

export function isAiNoObjectGeneratedError(error: unknown): error is {
  cause?: unknown;
  finishReason?: unknown;
  usage?: unknown;
  response?: unknown;
  text?: string;
} {
  return Boolean(
    error &&
    typeof error === "object" &&
    (hasAiErrorMarker(error, AI_NO_OBJECT_GENERATED_MARKER) ||
      (error as { name?: unknown }).name === "AI_NoObjectGeneratedError" ||
      (error as { name?: unknown }).name === "NoObjectGeneratedError" ||
      (error as { constructor?: { name?: unknown } }).constructor?.name ===
        "NoObjectGeneratedError"),
  );
}

export function isAiUnsupportedFunctionalityError(error: unknown): error is {
  functionality?: unknown;
  message: string;
} {
  return Boolean(
    error instanceof Error &&
    (hasAiErrorMarker(error, AI_UNSUPPORTED_FUNCTIONALITY_MARKER) ||
      error.name === "AI_UnsupportedFunctionalityError" ||
      error.name === "UnsupportedFunctionalityError" ||
      (error as { constructor?: { name?: unknown } }).constructor?.name ===
        "UnsupportedFunctionalityError"),
  );
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function contentIncludesNoCommerceFactsMarker(
  content: unknown,
): boolean {
  if (typeof content === "string") {
    return content.includes(NO_COMMERCE_FACTS_PROMPT_MARKER);
  }

  if (!Array.isArray(content)) return false;

  return content.some((part) => {
    if (typeof part === "string") {
      return part.includes(NO_COMMERCE_FACTS_PROMPT_MARKER);
    }

    if (!part || typeof part !== "object") return false;
    const text = (part as { text?: unknown }).text;
    return (
      typeof text === "string" && text.includes(NO_COMMERCE_FACTS_PROMPT_MARKER)
    );
  });
}

export function shouldEnforceNoContextCommercePolicy(
  options: GenerateTextOptions,
): boolean {
  const prompt = (options as { prompt?: unknown }).prompt;
  if (contentIncludesNoCommerceFactsMarker(prompt)) return true;

  const messages = (options as { messages?: Array<{ content?: unknown }> })
    .messages;
  return Array.isArray(messages)
    ? messages.some((message) =>
        contentIncludesNoCommerceFactsMarker(message.content),
      )
    : false;
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message.toLowerCase().includes("aborted"))
  );
}

export function isTransientProviderError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("8005") ||
    message.includes("internal server error") ||
    message.includes("service unavailable") ||
    message.includes("temporarily unavailable") ||
    message.includes("gateway timeout") ||
    message.includes("network error") ||
    message.includes("timeout")
  );
}

export async function generateTextWithTransientRetry(
  options: GenerateTextOptions,
  operation: string,
): Promise<GenerateTextResult> {
  const { generateText } = await import("ai");
  try {
    return await generateText(options);
  } catch (error) {
    if (isAbortError(error) || !isTransientProviderError(error)) {
      throw error;
    }

    console.warn(
      `${operation} failed with a transient AI provider error; retrying once.`,
      {
        message: getErrorMessage(error),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    return await generateText({
      ...options,
      temperature:
        typeof options.temperature === "number"
          ? Math.min(options.temperature, 0.5)
          : options.temperature,
      maxRetries: 1,
    });
  }
}

export function warnStructuredGenerationFallback(
  scope: string,
  error: unknown,
): void {
  console.warn(
    `${scope} structured generation failed; falling back to text.`,
    structuredGenerationFailureDetails(error),
  );
}

export function addWidgetFormatRetryInstruction(
  options: GenerateTextOptions,
): GenerateTextOptions {
  const messages = Array.isArray(
    (options as { messages?: ModelMessage[] }).messages,
  )
    ? (options as { messages: ModelMessage[] }).messages
    : [];
  const noContextCommercePolicy = shouldEnforceNoContextCommercePolicy(options);
  const retryOptions = {
    ...options,
    prompt: undefined,
    messages: [
      ...messages,
      {
        role: "user",
        content: [
          "The previous response was not usable widget code. Regenerate the widget from the full context above and return ONLY this exact format, with complete non-truncated CSS, no dangling declarations, no markdown, JSON, or explanation. Optional JS must be root-scoped and go in <js>, not inside HTML:\n\n<htmljs>\n<!-- valid HTML fragment -->\n</htmljs>\n\n<css>\n/* complete valid CSS */\n</css>\n\n<js>\n/* optional: use widget.root/query/queryAll only */\n</js>",
          noContextCommercePolicy
            ? "No product, category, collection, policy, pricing, delivery, review, or media facts were provided. Use generic non-factual commerce copy only. Do not mention delivery, shipping, guarantees, reviews, ratings, discounts, limited/new/latest releases, absolute URLs, or buy-now links."
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    temperature:
      typeof options.temperature === "number"
        ? Math.min(options.temperature, noContextCommercePolicy ? 0.2 : 0.3)
        : 0.3,
    maxRetries: 1,
  };
  return retryOptions as GenerateTextOptions;
}

export function truncateFailedWidgetResponse(rawText: string): string {
  const trimmed = rawText.trim();
  if (trimmed.length <= 12_000) return trimmed;
  return `${trimmed.slice(0, 6_000)}\n\n<!-- middle omitted for repair prompt -->\n\n${trimmed.slice(-6_000)}`;
}

export function widgetRepairBudget(
  options: GenerateTextOptions,
  promptType: WidgetPromptType,
): number {
  const requested =
    typeof options.maxOutputTokens === "number" ? options.maxOutputTokens : 0;
  const minimum =
    promptType === "landing-page"
      ? 4600
      : promptType === "collection"
        ? 3800
        : 3600;
  return Math.max(requested, minimum);
}

export function addWidgetArtifactRepairInstruction(
  options: GenerateTextOptions,
  rawText: string,
  reason: unknown,
  promptType: WidgetPromptType,
): GenerateTextOptions {
  const messages = Array.isArray(
    (options as { messages?: ModelMessage[] }).messages,
  )
    ? (options as { messages: ModelMessage[] }).messages
    : [];
  const noContextCommercePolicy = shouldEnforceNoContextCommercePolicy(options);

  return {
    ...options,
    prompt: undefined,
    messages: [
      ...messages,
      {
        role: "user",
        content: [
          "Repair the failed widget artifact below. Keep the merchant intent and any valid catalog facts, but return ONE complete, compact, production-ready artifact only.",
          `Validation failure: ${getErrorMessage(reason)}`,
          "The repaired response must include HTML and CSS tags, with non-empty valid CSS. Do not explain. Do not use markdown. Optional JavaScript belongs in <js> and must use widget.root/query/queryAll only.",
          'Required response shape:\n<htmljs>\n<section class="destination-specific-root">...</section>\n</htmljs>\n<css>\n.destination-specific-root{margin:0;...}\n</css>\n<js>\n/* optional root-scoped behavior */\n</js>',
          "CSS requirements: complete selectors, complete declarations, balanced braces, no dangling properties, no empty stylesheet, no oversized blank image panels, and bounded product image containers.",
          noContextCommercePolicy
            ? "No product, category, collection, policy, pricing, delivery, review, or media facts were provided. Use generic non-factual commerce copy only."
            : "",
          `Failed artifact to repair:\n${truncateFailedWidgetResponse(rawText)}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    temperature:
      typeof options.temperature === "number"
        ? Math.min(options.temperature, 0.25)
        : 0.25,
    maxOutputTokens: widgetRepairBudget(options, promptType),
    maxRetries: 1,
  } as GenerateTextOptions;
}

export function addMissingCssCompletionInstruction(
  options: GenerateTextOptions,
  rawText: string,
  promptType: WidgetPromptType,
): GenerateTextOptions {
  const messages = Array.isArray(
    (options as { messages?: ModelMessage[] }).messages,
  )
    ? (options as { messages: ModelMessage[] }).messages
    : [];

  return {
    ...options,
    prompt: undefined,
    messages: [
      ...messages,
      {
        role: "user",
        content: [
          "The generated widget artifact included usable HTML but no usable CSS. Complete it now.",
          `Destination: ${promptType}`,
          "Return ONE complete artifact only. Keep the HTML structure and merchant/catalog facts, but add a polished, compact, scoped stylesheet.",
          "The CSS must make the section visually pleasing on desktop and mobile, bound product images inside stable media containers, define responsive layout, spacing, typography, buttons, cards, focus states, and avoid blank image panels or large empty gaps.",
          "Required response shape, no markdown and no explanation:\n<htmljs>\n<!-- same or minimally cleaned HTML fragment -->\n</htmljs>\n<css>\n/* complete scoped CSS with balanced braces */\n</css>\n<js>\n/* optional root-scoped behavior only if needed */\n</js>",
          `HTML-only artifact:\n${truncateFailedWidgetResponse(rawText)}`,
        ].join("\n\n"),
      },
    ],
    temperature:
      typeof options.temperature === "number"
        ? Math.min(options.temperature, 0.25)
        : 0.25,
    maxOutputTokens: widgetRepairBudget(options, promptType),
    maxRetries: 1,
  } as GenerateTextOptions;
}

export async function completeMissingCssArtifact(
  rawText: string,
  options: GenerateTextOptions,
  promptType: WidgetPromptType,
  normalizationOptions: { commerceFactsProvided: boolean },
): Promise<WidgetGenerationResult | null> {
  const parsed = parseTagBasedResponse(rawText);
  const html = parsed.data?.html?.trim() ?? "";
  const css = parsed.data?.css?.trim() ?? "";
  if (!parsed.success || !html || css) return null;

  const completion = await generateTextWithTransientRetry(
    addMissingCssCompletionInstruction(options, rawText, promptType),
    "Widget missing CSS completion",
  );

  return {
    text: normalizeWidgetGenerationText(completion.text, normalizationOptions),
    usage: usageFromResult(completion),
  };
}

export async function repairInvalidWidgetArtifact(
  rawText: string,
  error: unknown,
  options: GenerateTextOptions,
  promptType: WidgetPromptType,
  normalizationOptions: { commerceFactsProvided: boolean },
): Promise<WidgetGenerationResult> {
  if (!rawText.trim()) {
    throw error;
  }

  const repairOptions = addWidgetArtifactRepairInstruction(
    options,
    rawText,
    error,
    promptType,
  );
  const repair = await generateTextWithTransientRetry(
    repairOptions,
    "Widget artifact repair",
  );
  return {
    text: normalizeWidgetGenerationText(repair.text, normalizationOptions),
    usage: usageFromResult(repair),
  };
}

export function addStagedPlanRetryInstruction(
  options: GenerateTextOptions,
): GenerateTextOptions {
  const messages = Array.isArray(
    (options as { messages?: ModelMessage[] }).messages,
  )
    ? (options as { messages: ModelMessage[] }).messages
    : [];
  return {
    ...options,
    prompt: undefined,
    messages: [
      ...messages,
      {
        role: "user",
        content:
          'Return ONLY a valid JSON generation plan. No markdown, HTML, CSS, comments, or explanation. Shape: {"totalSections":3,"compositionBrief":"One continuous destination-appropriate storefront composition","sharedDesignSystem":"Consistent palette, cards, media treatment, and CTAs","spacingStrategy":"Final wrapper has gap 0; sections connect with shared background and internal padding","sectionDescriptions":["Opening section","Core merchandising section","Closing action section"],"sectionContinuity":["Establish design tokens","Continue with the same rhythm and components","Close without external spacing"],"estimatedTokens":1200}.',
      },
    ],
    temperature: 0.1,
    maxRetries: 1,
  } as GenerateTextOptions;
}

export function fallbackNoContextWidgetIfAllowed(
  options: GenerateTextOptions,
  promptType: WidgetPromptType,
): WidgetGenerationResult | null {
  if (!shouldEnforceNoContextCommercePolicy(options)) return null;
  console.warn(
    "No-context widget generation could not produce a policy-safe artifact; returning deterministic safe fallback.",
  );
  return {
    text: createNoContextFallbackWidget(promptType),
    usage: {},
  };
}

export async function generateWidgetContent(
  options: GenerateTextOptions,
  capabilities: { supportsStructuredOutput: boolean },
  promptType: WidgetPromptType = "widget",
): Promise<WidgetGenerationResult> {
  const normalizationOptions = {
    commerceFactsProvided: !shouldEnforceNoContextCommercePolicy(options),
  };

  if (capabilities.supportsStructuredOutput) {
    const { generateText, Output } = await import("ai");
    const result = await generateText({
      ...options,
      output: Output.object({
        ...widgetOutputObjectSpec,
      }),
    }).catch((error) => {
      warnStructuredGenerationFallback("Widget", error);
      return null;
    });

    if (result) {
      try {
        const output = widgetOutputSchema.safeParse(result.output);
        if (!output.success) {
          throw new ValidationError(ERROR_MESSAGES.jsonParseFailed, {
            issues: output.error.issues,
          });
        }
        return {
          text: normalizeWidgetOutput(output.data, normalizationOptions),
          usage: usageFromResult(result),
        };
      } catch (error) {
        warnStructuredGenerationFallback(
          "Widget structured output validation",
          error,
        );
      }
    }
  }

  const result = await generateTextWithTransientRetry(
    options,
    "Widget generation",
  );
  try {
    return {
      text: normalizeWidgetGenerationText(result.text, normalizationOptions),
      usage: usageFromResult(result),
    };
  } catch (error) {
    console.warn(
      "Widget response failed validation; using fallback or retrying once:",
      error,
    );
    const fallback = fallbackNoContextWidgetIfAllowed(options, promptType);
    if (fallback) return fallback;

    try {
      return await repairInvalidWidgetArtifact(
        result.text,
        error,
        options,
        promptType,
        normalizationOptions,
      );
    } catch (repairError) {
      console.warn(
        "Widget artifact repair failed; regenerating from the original brief:",
        repairError,
      );
    }

    const retry = await generateTextWithTransientRetry(
      addWidgetFormatRetryInstruction(options),
      "Widget format repair",
    );
    try {
      return {
        text: normalizeWidgetGenerationText(retry.text, normalizationOptions),
        usage: usageFromResult(retry),
      };
    } catch (retryError) {
      const fallback = fallbackNoContextWidgetIfAllowed(options, promptType);
      if (fallback) return fallback;
      throw retryError;
    }
  }
}

export async function finalizeStreamedWidgetContent(
  rawText: string,
  options: GenerateTextOptions,
  capabilities: { supportsStructuredOutput: boolean },
  promptType: WidgetPromptType = "widget",
): Promise<string> {
  const normalizationOptions = {
    commerceFactsProvided: !shouldEnforceNoContextCommercePolicy(options),
  };

  try {
    return normalizeWidgetGenerationText(rawText, normalizationOptions);
  } catch (error) {
    console.warn(
      "Streamed widget response failed validation; using fallback or retrying once:",
      error,
    );
    const fallback = fallbackNoContextWidgetIfAllowed(options, promptType);
    if (fallback) return fallback.text;

    try {
      const completed = await completeMissingCssArtifact(
        rawText,
        options,
        promptType,
        normalizationOptions,
      );
      if (completed) return completed.text;
    } catch (completionError) {
      console.warn(
        "Streamed widget missing CSS completion failed; trying full artifact repair:",
        completionError,
      );
    }

    try {
      const repaired = await repairInvalidWidgetArtifact(
        rawText,
        error,
        options,
        promptType,
        normalizationOptions,
      );
      return repaired.text;
    } catch (repairError) {
      console.warn(
        "Streamed widget artifact repair failed; regenerating from the original brief:",
        repairError,
      );
    }

    const retryOptions = addWidgetFormatRetryInstruction(options);
    try {
      const retry = await generateWidgetContent(
        retryOptions,
        capabilities,
        promptType,
      );
      return retry.text;
    } catch (retryError) {
      const fallback = fallbackNoContextWidgetIfAllowed(options, promptType);
      if (fallback) return fallback.text;
      throw retryError;
    }
  }
}

export async function streamWidgetContent(
  options: GenerateTextOptions,
  capabilities: { supportsStructuredOutput: boolean },
  promptType: WidgetPromptType = "widget",
): Promise<{
  textStream: AsyncIterable<string>;
  finalize: (rawText: string) => Promise<WidgetGenerationResult>;
}> {
  const { streamText } = await import("ai");
  const result = streamText(options);

  return {
    textStream: result.textStream,
    async finalize(rawText: string) {
      let completeRawText = rawText;
      if (!completeRawText.trim()) {
        try {
          completeRawText = await result.text;
        } catch {
          completeRawText = rawText;
        }
      }

      const text = await finalizeStreamedWidgetContent(
        completeRawText,
        options,
        capabilities,
        promptType,
      );
      const usage: GenerationUsage = await (async () => {
        try {
          const totalUsage = await result.totalUsage;
          return {
            inputTokens: totalUsage?.inputTokens,
            outputTokens: totalUsage?.outputTokens,
            totalTokens: totalUsage?.totalTokens,
          };
        } catch {
          return {};
        }
      })();

      return { text, usage };
    },
  };
}

export async function generateStagedPlan(
  options: GenerateTextOptions,
  capabilities: { supportsStructuredOutput: boolean },
): Promise<WidgetGenerationResult> {
  if (capabilities.supportsStructuredOutput) {
    const { generateText, Output } = await import("ai");
    const result = await generateText({
      ...options,
      output: Output.object({
        ...stagedPlanOutputObjectSpec,
      }),
    }).catch((error) => {
      warnStructuredGenerationFallback("Staged plan", error);
      return null;
    });

    if (result) {
      const output = stagedPlanOutputSchema.safeParse(result.output);
      if (output.success) {
        return {
          text: normalizeStagedPlanOutput(output.data),
          usage: usageFromResult(result),
        };
      }
      console.warn(
        "Structured staged plan output failed validation; falling back to text:",
        output.error,
      );
    }
  }

  const result = await generateTextWithTransientRetry(
    options,
    "Staged plan generation",
  );
  try {
    return {
      text: normalizeStagedPlanText(result.text),
      usage: usageFromResult(result),
    };
  } catch (error) {
    console.warn("Text staged plan failed validation; retrying once:", error);
    const retry = await generateTextWithTransientRetry(
      addStagedPlanRetryInstruction(options),
      "Staged plan repair",
    );
    return {
      text: normalizeStagedPlanText(retry.text),
      usage: usageFromResult(retry),
    };
  }
}
