import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output, type LanguageModel, type ModelMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { getClientIp, rateLimit } from "@scalius/shared/rate-limit";
import {
  AI_PROVIDER_IDS,
  GENERATION_CONFIG,
  ERROR_MESSAGES,
  getConfiguredProvider,
  getTimeout,
  getWidgetAiRuntimeSettings,
  providerHasCredentials,
  type WidgetAiProvider,
  type WidgetAiRuntimeSettings,
} from "@scalius/core/modules/ai";
import { ok } from "../../utils/api-response";
import { RateLimitError, ValidationError } from "../../utils/api-error";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { listModelsForProvider } from "./ai-models";

const app = new OpenAPIHono<{ Bindings: Env }>();

const providerEnum = z.enum(AI_PROVIDER_IDS);

const messagePartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    image_url: z.object({ url: z.string() }).optional(),
    image: z.string().optional(),
    mediaType: z.string().optional(),
    cache_control: z.unknown().optional(),
  })
  .passthrough();

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.union([z.string(), z.array(messagePartSchema)]),
});

const generateSchema = z
  .object({
    provider: providerEnum.optional(),
    model: z.string().optional(),
    messages: z.array(messageSchema).optional(),
    prompt: z.string().optional(),
    stream: z.boolean().optional(),
    images: z
      .array(z.object({ url: z.string(), mimeType: z.string().optional() }).passthrough())
      .optional(),
    operation: z.enum(["create", "improve"]).optional(),
  })
  .refine((data) => data.messages || data.prompt, {
    message: "Messages or prompt is required.",
  });

const generateStagedSchema = z.object({
  provider: providerEnum.optional(),
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  stage: z.enum(["plan", "generate"]).optional(),
  sectionIndex: z.number().int().min(0).max(GENERATION_CONFIG.stagedGeneration.maxSections - 1).optional(),
  totalSections: z
    .number()
    .int()
    .min(GENERATION_CONFIG.stagedGeneration.minSections)
    .max(GENERATION_CONFIG.stagedGeneration.maxSections)
    .optional(),
});

type AiUserPart =
  | { type: "text"; text: string }
  | { type: "image"; image: URL; mediaType?: string };

const MAX_MESSAGES = 32;
const MAX_TEXT_CHARS = GENERATION_CONFIG.context.maxPromptChars;
const MAX_IMAGES = GENERATION_CONFIG.context.maxImages;
const MAX_MODEL_ID_CHARS = 200;
const AI_RATE_LIMIT = { limit: 20, windowMs: 60_000 };

const widgetOutputSchema = z.object({
  html: z.string().min(1),
  css: z.string().optional(),
});

const stagedPlanOutputSchema = z.object({
  totalSections: z
    .number()
    .int()
    .min(GENERATION_CONFIG.stagedGeneration.minSections)
    .max(GENERATION_CONFIG.stagedGeneration.maxSections),
  sectionDescriptions: z
    .array(z.string().min(1).max(160))
    .min(GENERATION_CONFIG.stagedGeneration.minSections)
    .max(GENERATION_CONFIG.stagedGeneration.maxSections),
  estimatedTokens: z.number().int().positive().optional(),
});

type GenerateTextOptions = Parameters<typeof generateText>[0];
type GenerationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

interface WidgetGenerationResult {
  text: string;
  usage: GenerationUsage;
}

function shouldUseStructuredOutput(provider: WidgetAiProvider): boolean {
  // Cloudflare documents structured outputs for Kimi, but the current
  // workers-ai-provider + AI SDK output path can trigger upstream 504s with
  // the Workers AI binding. Keep Cloudflare fast and reliable with text/tag
  // output until we add a native Cloudflare structured-output adapter.
  return provider !== "cloudflare";
}

function getModelId(
  provider: WidgetAiProvider,
  requestedModel: string | undefined,
  settings: WidgetAiRuntimeSettings,
): string {
  const model = requestedModel?.trim() || settings.providers[provider].defaultModel;
  if (!model) throw new ValidationError(ERROR_MESSAGES.modelNotSelected);
  if (model.length > MAX_MODEL_ID_CHARS) {
    throw new ValidationError("AI model ID is too long.");
  }
  return model;
}

function isAllowedImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "data:";
  } catch {
    return false;
  }
}

function countMessageText(content: z.infer<typeof messageSchema>["content"]): number {
  if (typeof content === "string") return content.length;
  return content.reduce((total, part) => {
    if (typeof part.text === "string") return total + part.text.length;
    const imageUrl = part.image_url?.url ?? part.image;
    return total + (imageUrl ? String(imageUrl).length : 0);
  }, 0);
}

function countMessageImages(content: z.infer<typeof messageSchema>["content"]): number {
  if (typeof content === "string") return 0;
  return content.reduce((total, part) => {
    return total + (part.image_url?.url || part.image ? 1 : 0);
  }, 0);
}

function validateMessagePayload(messages: Array<z.infer<typeof messageSchema>>): void {
  if (messages.length > MAX_MESSAGES) {
    throw new ValidationError(`Too many AI messages. Maximum is ${MAX_MESSAGES}.`);
  }

  const textChars = messages.reduce((total, message) => total + countMessageText(message.content), 0);
  if (textChars > MAX_TEXT_CHARS) {
    throw new ValidationError(`AI prompt is too large. Maximum is ${MAX_TEXT_CHARS} characters.`);
  }

  const imageCount = messages.reduce((total, message) => total + countMessageImages(message.content), 0);
  if (imageCount > MAX_IMAGES) {
    throw new ValidationError(`Too many image inputs. Maximum is ${MAX_IMAGES}.`);
  }

  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      const imageUrl = part.image_url?.url ?? part.image;
      if (imageUrl && !isAllowedImageUrl(String(imageUrl))) {
        throw new ValidationError("AI image URLs must use HTTPS or data URLs.");
      }
    }
  }
}

function validatePromptPayload(
  prompt: string,
  images: Array<{ url: string; mimeType?: string }> | undefined,
): void {
  if (prompt.length > MAX_TEXT_CHARS) {
    throw new ValidationError(`AI prompt is too large. Maximum is ${MAX_TEXT_CHARS} characters.`);
  }
  if ((images?.length ?? 0) > MAX_IMAGES) {
    throw new ValidationError(`Too many image inputs. Maximum is ${MAX_IMAGES}.`);
  }
  for (const image of images ?? []) {
    if (!isAllowedImageUrl(image.url)) {
      throw new ValidationError("AI image URLs must use HTTPS or data URLs.");
    }
  }
}

async function enforceAiRateLimit(c: any): Promise<void> {
  const kv = c.env.CACHE as KVNamespace | undefined;
  if (!kv) return;

  const user = c.get("user") as { id?: string } | undefined;
  const identity = user?.id || getClientIp(c.req.raw);
  const result = await rateLimit({
    kv,
    key: `admin-ai:${identity}`,
    limit: AI_RATE_LIMIT.limit,
    windowMs: AI_RATE_LIMIT.windowMs,
  });

  if (!result.allowed) {
    throw new RateLimitError(
      ERROR_MESSAGES.rateLimitError,
      Math.ceil((result.resetAt - Date.now()) / 1000),
    );
  }
}

function getLanguageModel(
  provider: WidgetAiProvider,
  modelId: string,
  settings: WidgetAiRuntimeSettings,
  env: Env,
): LanguageModel {
  if (!providerHasCredentials(settings, provider)) {
    throw new ValidationError(ERROR_MESSAGES.apiKeyMissing);
  }

  if (provider === "openrouter") {
    const openrouter = createOpenRouter({
      apiKey: settings.apiKeys.openrouter,
      baseURL: settings.providers.openrouter.baseUrl,
      appName: settings.providers.openrouter.appName || undefined,
      appUrl: settings.providers.openrouter.appUrl || undefined,
      compatibility: "strict",
    });
    return openrouter(modelId);
  }

  if (provider === "openai") {
    const openai = createOpenAI({
      apiKey: settings.apiKeys.openai,
      baseURL: settings.providers.openai.baseUrl,
    });
    return openai(modelId);
  }

  if (provider === "gemini") {
    const google = createGoogleGenerativeAI({
      apiKey: settings.apiKeys.gemini,
      baseURL: settings.providers.gemini.baseUrl,
    });
    return google(modelId);
  }

  if (env.AI) {
    const workersai = createWorkersAI({ binding: env.AI as Ai });
    return workersai(modelId);
  }

  const accountId = settings.providers.cloudflare.accountId;
  const apiKey = settings.apiKeys.cloudflare;
  if (!accountId || !apiKey) {
    throw new ValidationError(ERROR_MESSAGES.apiKeyMissing);
  }
  const workersai = createWorkersAI({ accountId, apiKey });
  return workersai(modelId);
}

function contentPartToText(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const data = part as Record<string, unknown>;
  if (typeof data.text === "string") return data.text;
  if (
    data.image_url &&
    typeof data.image_url === "object" &&
    typeof (data.image_url as Record<string, unknown>).url === "string"
  ) {
    return `[Image: ${(data.image_url as Record<string, unknown>).url}]`;
  }
  if (typeof data.image === "string") return `[Image: ${data.image}]`;
  return "";
}

function normalizeContentParts(parts: unknown[]): AiUserPart[] {
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return null;
      const data = part as Record<string, unknown>;
      if (data.type === "text" && typeof data.text === "string") {
        return { type: "text" as const, text: data.text };
      }
      const imageUrl =
        data.type === "image_url" &&
        data.image_url &&
        typeof data.image_url === "object" &&
        typeof (data.image_url as Record<string, unknown>).url === "string"
          ? String((data.image_url as Record<string, unknown>).url)
          : data.type === "image" && typeof data.image === "string"
            ? data.image
            : "";
      if (imageUrl) {
        try {
          return {
            type: "image" as const,
            image: new URL(imageUrl),
            mediaType:
              typeof data.mediaType === "string" ? data.mediaType : undefined,
          };
        } catch {
          return { type: "text" as const, text: `[Image: ${imageUrl}]` };
        }
      }
      const text = contentPartToText(data);
      return text ? { type: "text" as const, text } : null;
    })
    .filter(Boolean) as AiUserPart[];
}

function normalizeMessages(messages: Array<z.infer<typeof messageSchema>>): ModelMessage[] {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return { role: message.role, content: message.content } as ModelMessage;
    }

    if (message.role === "user") {
      return {
        role: "user",
        content: normalizeContentParts(message.content),
      } as ModelMessage;
    }

    return {
      role: message.role,
      content: message.content.map(contentPartToText).filter(Boolean).join("\n"),
    } as ModelMessage;
  });
}

function promptToMessages(
  prompt: string,
  images: Array<{ url: string; mimeType?: string }> | undefined,
): ModelMessage[] {
  if (!images?.length) return [{ role: "user", content: prompt }];
  return [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...images.map((image) => {
          try {
            return {
              type: "image" as const,
              image: new URL(image.url),
              mediaType: image.mimeType,
            };
          } catch {
            return {
              type: "text" as const,
              text: `[Image: ${image.url}]`,
            };
          }
        }),
      ],
    },
  ];
}

function openAiCompatibleJson(
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

function openAiCompatibleStream(textStream: AsyncIterable<string>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const delta of textStream) {
          if (!delta) continue;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`,
            ),
          );
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              error: {
                message:
                  error instanceof Error
                    ? error.message
                    : "AI stream failed",
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

async function* singleChunkStream(text: string): AsyncIterable<string> {
  yield text;
}

function usageFromResult(result: { totalUsage?: GenerationUsage }): GenerationUsage {
  return {
    inputTokens: result.totalUsage?.inputTokens,
    outputTokens: result.totalUsage?.outputTokens,
    totalTokens: result.totalUsage?.totalTokens,
  };
}

function widgetOutputToTaggedText(output: z.infer<typeof widgetOutputSchema>): string {
  return `<htmljs>\n${output.html.trim()}\n</htmljs>\n\n<css>\n${(output.css ?? "").trim()}\n</css>`;
}

async function generateWidgetContent(
  options: GenerateTextOptions,
  provider: WidgetAiProvider,
): Promise<WidgetGenerationResult> {
  if (shouldUseStructuredOutput(provider)) {
    try {
      const result = await generateText({
        ...options,
        output: Output.object({
          schema: widgetOutputSchema,
        }),
      });

      const output = widgetOutputSchema.parse(result.output);
      return {
        text: widgetOutputToTaggedText(output),
        usage: usageFromResult(result),
      };
    } catch (error) {
      console.warn("Structured widget generation failed, falling back to text:", error);
    }
  }

  const result = await generateText(options);
  return {
    text: result.text,
    usage: usageFromResult(result),
  };
}

async function generateStagedPlan(
  options: GenerateTextOptions,
  provider: WidgetAiProvider,
): Promise<WidgetGenerationResult> {
  if (shouldUseStructuredOutput(provider)) {
    try {
      const result = await generateText({
        ...options,
        output: Output.object({
          schema: stagedPlanOutputSchema,
        }),
      });

      const output = stagedPlanOutputSchema.parse(result.output);
      return {
        text: JSON.stringify(output),
        usage: usageFromResult(result),
      };
    } catch (error) {
      console.warn("Structured staged plan generation failed, falling back to text:", error);
    }
  }

  const result = await generateText(options);
  return {
    text: result.text,
    usage: usageFromResult(result),
  };
}

async function runtimeSettings(c: any) {
  const db = c.get("db");
  return getWidgetAiRuntimeSettings(db, c.env, getCredentialEncryptionKey(c.env));
}

const listModelsRoute = createRoute({
  method: "get",
  path: "/models",
  tags: ["Admin - AI"],
  summary: "List available models for the configured AI provider",
  request: {
    query: z.object({ provider: providerEnum.optional() }),
  },
  responses: {
    200: {
      description: "AI model list",
      content: {
        "application/json": {
          schema: successEnvelope(
            z.object({
              provider: providerEnum,
              defaultModel: z.string(),
              models: z.array(z.object({}).passthrough()),
            }),
          ),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(listModelsRoute, async (c) => {
  const settings = await runtimeSettings(c);
  const query = c.req.valid("query");
  const provider = getConfiguredProvider(settings, query.provider);
  const models = await listModelsForProvider(provider, settings);

  return ok(c, {
    provider,
    defaultModel: settings.providers[provider].defaultModel,
    models,
  });
});

const generateRoute = createRoute({
  method: "post",
  path: "/generate",
  tags: ["Admin - AI"],
  summary: "Generate widget content with the configured AI provider",
  request: {
    body: { content: { "application/json": { schema: generateSchema } } },
  },
  responses: {
    200: {
      description: "Generation result",
      content: {
        "application/json": { schema: successEnvelope(z.object({}).passthrough()) },
        "text/event-stream": { schema: z.string() },
      },
    },
    ...errorResponses,
  },
});

app.openapi(generateRoute, async (c) => {
  await enforceAiRateLimit(c);
  const payload = c.req.valid("json");
  if (payload.messages) {
    validateMessagePayload(payload.messages);
  } else {
    validatePromptPayload(payload.prompt ?? "", payload.images);
  }
  const settings = await runtimeSettings(c);
  const provider = getConfiguredProvider(settings, payload.provider);
  const modelId = getModelId(provider, payload.model, settings);
  const model = getLanguageModel(provider, modelId, settings, c.env);
  const messages = payload.messages
    ? normalizeMessages(payload.messages)
    : promptToMessages(payload.prompt ?? "", payload.images);

  const generationOptions = {
    model,
    messages,
    allowSystemInMessages: true,
    temperature:
      payload.operation === "improve"
        ? settings.generation.improvementTemperature
        : settings.generation.generationTemperature,
    maxOutputTokens: settings.generation.maxOutputTokens,
    timeout: { totalMs: getTimeout(payload.operation === "improve" ? "improvement" : "generation") },
    maxRetries: 2,
  };

  if (payload.stream) {
    const result = await generateWidgetContent(generationOptions, provider);
    return openAiCompatibleStream(singleChunkStream(result.text));
  }

  const result = await generateWidgetContent(generationOptions, provider);
  return ok(
    c,
    openAiCompatibleJson(result.text, provider, modelId, result.usage),
  );
});

const generateStagedRoute = createRoute({
  method: "post",
  path: "/generate-staged",
  tags: ["Admin - AI"],
  summary: "Generate staged widget content with the configured AI provider",
  request: {
    body: { content: { "application/json": { schema: generateStagedSchema } } },
  },
  responses: {
    200: {
      description: "Staged generation result",
      content: {
        "application/json": { schema: successEnvelope(z.object({}).passthrough()) },
      },
    },
    ...errorResponses,
  },
});

app.openapi(generateStagedRoute, async (c) => {
  await enforceAiRateLimit(c);
  const payload = c.req.valid("json");
  validateMessagePayload(payload.messages);
  const settings = await runtimeSettings(c);
  const provider = getConfiguredProvider(settings, payload.provider);
  const modelId = getModelId(provider, payload.model, settings);
  const model = getLanguageModel(provider, modelId, settings, c.env);
  const generationOptions = {
    model,
    messages: normalizeMessages(payload.messages),
    allowSystemInMessages: true,
    temperature:
      payload.stage === "plan"
        ? settings.generation.planningTemperature
        : settings.generation.generationTemperature,
    maxOutputTokens: settings.generation.maxOutputTokens,
    timeout: {
      totalMs:
        payload.stage === "plan" ? getTimeout("planning") : getTimeout("generation"),
    },
    maxRetries: 2,
  };

  const result =
    payload.stage === "plan"
      ? await generateStagedPlan(generationOptions, provider)
      : await generateWidgetContent(generationOptions, provider);

  const response = {
    ...openAiCompatibleJson(result.text, provider, modelId, result.usage),
  } as Record<string, unknown>;

  if (payload.stage !== undefined) response.stage = payload.stage;
  if (payload.sectionIndex !== undefined) response.sectionIndex = payload.sectionIndex;
  if (payload.totalSections !== undefined) response.totalSections = payload.totalSections;

  return ok(c, response);
});

export { app as adminAiRoutes };
