import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, streamText, type LanguageModel, type ModelMessage } from "ai";
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
import { RateLimitError, ServiceUnavailableError, ValidationError } from "../../utils/api-error";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { getEncryptionKey } from "../../utils/encryption-key";

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
  })
  .refine((data) => data.messages || data.prompt, {
    message: "Messages or prompt is required.",
  });

const generateStagedSchema = z.object({
  provider: providerEnum.optional(),
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  stage: z.string().optional(),
  sectionIndex: z.number().optional(),
  totalSections: z.number().optional(),
});

interface AiModelInfo {
  id: string;
  name: string;
  provider: WidgetAiProvider;
  description?: string | null;
  context_length?: number;
  supportsVision: boolean;
  supportsAudio?: boolean;
  modality?: string;
  source?: "api" | "configured" | "fallback";
}

type AiUserPart =
  | { type: "text"; text: string }
  | { type: "image"; image: URL; mediaType?: string };

const MAX_MESSAGES = 32;
const MAX_TEXT_CHARS = GENERATION_CONFIG.context.maxPromptChars;
const MAX_IMAGES = GENERATION_CONFIG.context.maxImages;
const MAX_MODEL_ID_CHARS = 200;
const AI_RATE_LIMIT = { limit: 20, windowMs: 60_000 };

function jsonHeaders(headers: HeadersInit = {}) {
  return { Accept: "application/json", ...headers };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new ServiceUnavailableError(
      `AI provider request failed: ${response.status} ${body.slice(0, 200)}`,
    );
  }
  return response.json() as Promise<T>;
}

function configuredModel(
  provider: WidgetAiProvider,
  settings: WidgetAiRuntimeSettings,
): AiModelInfo[] {
  const model = settings.providers[provider].defaultModel;
  return model
    ? [
        {
          id: model,
          name: model,
          provider,
          supportsVision: provider === "gemini",
          source: "configured",
        },
      ]
    : [];
}

function fallbackModels(
  provider: WidgetAiProvider,
  settings: WidgetAiRuntimeSettings,
): AiModelInfo[] {
  const configured = configuredModel(provider, settings);
  const fallbacks: Record<WidgetAiProvider, AiModelInfo[]> = {
    openrouter: [],
    openai: [],
    gemini: [],
    cloudflare: [
      {
        id: "@cf/moonshotai/kimi-k2.5",
        name: "Kimi K2.5",
        provider,
        supportsVision: true,
        source: "fallback",
      },
      {
        id: "@cf/openai/gpt-oss-120b",
        name: "GPT OSS 120B",
        provider,
        supportsVision: false,
        source: "fallback",
      },
    ],
  };
  const seen = new Set<string>();
  return [...configured, ...fallbacks[provider]].filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

async function listOpenRouterModels(
  settings: WidgetAiRuntimeSettings,
): Promise<AiModelInfo[]> {
  const provider = "openrouter" as const;
  const baseUrl = settings.providers.openrouter.baseUrl || "https://openrouter.ai/api/v1";
  const data = await fetchJson<{ data?: Array<Record<string, unknown>> }>(
    `${baseUrl.replace(/\/$/, "")}/models`,
    { headers: jsonHeaders() },
  );

  return (data.data ?? []).map((model) => {
    const architecture = model.architecture as
      | { input_modalities?: string[]; output_modalities?: string[]; modality?: string }
      | undefined;
    return {
      id: String(model.id ?? ""),
      name: String(model.name ?? model.id ?? ""),
      provider,
      description:
        typeof model.description === "string" ? model.description : null,
      context_length:
        typeof model.context_length === "number" ? model.context_length : undefined,
      supportsVision: architecture?.input_modalities?.includes("image") ?? false,
      supportsAudio: architecture?.input_modalities?.includes("audio") ?? false,
      modality: architecture?.modality ?? "text->text",
      source: "api" as const,
    };
  }).filter((model) => model.id);
}

async function listOpenAiModels(
  settings: WidgetAiRuntimeSettings,
): Promise<AiModelInfo[]> {
  const provider = "openai" as const;
  const apiKey = settings.apiKeys.openai;
  if (!apiKey) return fallbackModels(provider, settings);
  const baseUrl = settings.providers.openai.baseUrl || "https://api.openai.com/v1";
  const data = await fetchJson<{ data?: Array<{ id?: string; owned_by?: string }> }>(
    `${baseUrl.replace(/\/$/, "")}/models`,
    { headers: jsonHeaders({ Authorization: `Bearer ${apiKey}` }) },
  );

  return (data.data ?? [])
    .map((model) => {
      const id = model.id ?? "";
      return {
        id,
        name: id,
        provider,
        description: model.owned_by ? `Owned by ${model.owned_by}` : null,
        supportsVision: /gpt-4o|gpt-4\.1|gpt-5|vision|omni/i.test(id),
        modality: "text->text",
        source: "api" as const,
      };
    })
    .filter((model) => model.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function listGeminiModels(
  settings: WidgetAiRuntimeSettings,
): Promise<AiModelInfo[]> {
  const provider = "gemini" as const;
  const apiKey = settings.apiKeys.gemini;
  if (!apiKey) return fallbackModels(provider, settings);
  const baseUrl =
    settings.providers.gemini.baseUrl ||
    "https://generativelanguage.googleapis.com/v1beta";
  const data = await fetchJson<{
    models?: Array<{
      name?: string;
      displayName?: string;
      description?: string;
      inputTokenLimit?: number;
      supportedGenerationMethods?: string[];
    }>;
  }>(`${baseUrl.replace(/\/$/, "")}/models?key=${encodeURIComponent(apiKey)}`, {
    headers: jsonHeaders(),
  });

  return (data.models ?? [])
    .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
    .map((model) => {
      const id = (model.name ?? "").replace(/^models\//, "");
      return {
        id,
        name: model.displayName || id,
        provider,
        description: model.description ?? null,
        context_length: model.inputTokenLimit,
        supportsVision: /gemini/i.test(id),
        modality: "text->text",
        source: "api" as const,
      };
    })
    .filter((model) => model.id);
}

async function listCloudflareModels(
  settings: WidgetAiRuntimeSettings,
): Promise<AiModelInfo[]> {
  const provider = "cloudflare" as const;
  const accountId = settings.providers.cloudflare.accountId;
  const apiKey = settings.apiKeys.cloudflare;
  if (!accountId || !apiKey) return fallbackModels(provider, settings);

  const data = await fetchJson<{ result?: Array<Record<string, unknown>> }>(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?task=text-generation`,
    { headers: jsonHeaders({ Authorization: `Bearer ${apiKey}` }) },
  );

  return (data.result ?? [])
    .map((model) => {
      const id = String(model.name ?? model.id ?? "");
      return {
        id,
        name: String(model.display_name ?? model.name ?? id),
        provider,
        description:
          typeof model.description === "string" ? model.description : null,
        supportsVision: /vision|kimi/i.test(id),
        modality: "text->text",
        source: "api" as const,
      };
    })
    .filter((model) => model.id);
}

async function listModelsForProvider(
  provider: WidgetAiProvider,
  settings: WidgetAiRuntimeSettings,
): Promise<AiModelInfo[]> {
  try {
    if (provider === "openrouter") return await listOpenRouterModels(settings);
    if (provider === "openai") return await listOpenAiModels(settings);
    if (provider === "gemini") return await listGeminiModels(settings);
    return await listCloudflareModels(settings);
  } catch (error) {
    console.warn(`Failed to list ${provider} models:`, error);
    return fallbackModels(provider, settings);
  }
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

async function runtimeSettings(c: any) {
  const db = c.get("db");
  return getWidgetAiRuntimeSettings(db, c.env, getEncryptionKey(c.env));
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
    temperature: settings.generation.generationTemperature,
    maxOutputTokens: settings.generation.maxOutputTokens,
    timeout: { totalMs: getTimeout("generation") },
    maxRetries: 2,
  };

  if (payload.stream) {
    const result = streamText(generationOptions);
    return openAiCompatibleStream(result.textStream);
  }

  const result = await generateText(generationOptions);
  return ok(
    c,
    openAiCompatibleJson(result.text, provider, modelId, {
      inputTokens: result.totalUsage.inputTokens,
      outputTokens: result.totalUsage.outputTokens,
      totalTokens: result.totalUsage.totalTokens,
    }),
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
  const result = await generateText({
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
  });

  const response = {
    ...openAiCompatibleJson(result.text, provider, modelId, {
      inputTokens: result.totalUsage.inputTokens,
      outputTokens: result.totalUsage.outputTokens,
      totalTokens: result.totalUsage.totalTokens,
    }),
  } as Record<string, unknown>;

  if (payload.stage !== undefined) response.stage = payload.stage;
  if (payload.sectionIndex !== undefined) response.sectionIndex = payload.sectionIndex;
  if (payload.totalSections !== undefined) response.totalSections = payload.totalSections;

  return ok(c, response);
});

export { app as adminAiRoutes };
