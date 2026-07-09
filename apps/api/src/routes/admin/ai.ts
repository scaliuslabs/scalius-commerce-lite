import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AI_PROVIDER_IDS,
  GENERATION_CONFIG,
  getConfiguredProvider,
  getTimeout,
  requireAllowedWidgetAiModel,
  resolveWidgetAiModelCapabilities,
} from "@scalius/core/modules/ai";
import {
  createAiLanguageModel,
  loadAiRuntimeSettings,
} from "../../modules/ai/model-runtime";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { adminAiChatRoutes } from "./ai-chat-route";
import { enforceAiRateLimit } from "./ai-rate-limit";
import { listAllowedModelsForProvider } from "./ai-models";
import { normalizeMessages } from "./ai-message-normalization";
import {
  getCreateOutputBudget,
  getStagedOutputBudget,
  inferPromptTypeFromMessages,
  messageSchema,
  promptToMessages,
  validateMessagePayload,
  validatePromptPayload,
  withDestinationRuntimeContract,
} from "./ai-widget-contract";
import {
  generateStagedPlan,
  generateWidgetContent,
  openAiCompatibleJson,
  openAiCompatibleStream,
  streamWidgetContent,
} from "./ai-widget-runtime";

const app = new OpenAPIHono<{ Bindings: Env }>();
const MAX_MODEL_ID_CHARS = 200;

const providerEnum = z.enum(AI_PROVIDER_IDS);
const promptTypeEnum = z.enum(["widget", "landing-page", "collection"]);
const generateSchema = z
  .object({
    provider: providerEnum.optional(),
    model: z.string().max(MAX_MODEL_ID_CHARS).optional(),
    messages: z.array(messageSchema).optional(),
    prompt: z.string().optional(),
    stream: z.boolean().optional(),
    images: z
      .array(
        z
          .object({ url: z.string(), mimeType: z.string().optional() })
          .passthrough(),
      )
      .optional(),
    operation: z.enum(["create", "improve"]).optional(),
    promptType: promptTypeEnum.optional(),
    compositionMode: z.boolean().optional(),
  })
  .refine((data) => data.messages || data.prompt, {
    message: "Messages or prompt is required.",
  });

const generateStagedSchema = z.object({
  provider: providerEnum.optional(),
  model: z.string().max(MAX_MODEL_ID_CHARS).optional(),
  promptType: promptTypeEnum.optional(),
  messages: z.array(messageSchema).min(1),
  stage: z.enum(["plan", "generate", "finalize"]).optional(),
  sectionIndex: z
    .number()
    .int()
    .min(0)
    .max(GENERATION_CONFIG.stagedGeneration.maxSections - 1)
    .optional(),
  totalSections: z
    .number()
    .int()
    .min(GENERATION_CONFIG.stagedGeneration.minSections)
    .max(GENERATION_CONFIG.stagedGeneration.maxSections)
    .optional(),
});

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
  const settings = await loadAiRuntimeSettings(c);
  const query = c.req.valid("query");
  const provider = getConfiguredProvider(settings, query.provider);
  const models = await listAllowedModelsForProvider(provider, settings);

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
        "application/json": {
          schema: successEnvelope(z.object({}).passthrough()),
        },
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
  const settings = await loadAiRuntimeSettings(c);
  const provider = getConfiguredProvider(settings, payload.provider);
  const modelId = requireAllowedWidgetAiModel(
    settings,
    provider,
    payload.model,
  );
  const model = await createAiLanguageModel(provider, modelId, settings, c.env);
  const capabilities = resolveWidgetAiModelCapabilities(
    provider,
    modelId,
    settings.providers[provider].capabilities,
  );
  const normalizedMessages = payload.messages
    ? normalizeMessages(payload.messages)
    : promptToMessages(payload.prompt ?? "", payload.images);
  const promptType =
    payload.promptType ?? inferPromptTypeFromMessages(normalizedMessages);
  const messages = withDestinationRuntimeContract(
    normalizedMessages,
    promptType,
    {
      compositionMode: payload.compositionMode === true,
    },
  );

  const generationOptions = {
    model,
    messages,
    allowSystemInMessages: true,
    temperature:
      payload.operation === "improve"
        ? settings.generation.improvementTemperature
        : settings.generation.generationTemperature,
    maxOutputTokens: getCreateOutputBudget(
      settings,
      promptType,
      payload.operation,
    ),
    timeout: {
      totalMs: getTimeout(
        payload.operation === "improve" ? "improvement" : "generation",
      ),
    },
    maxRetries: 2,
    abortSignal: c.req.raw.signal,
  };

  if (payload.stream) {
    const result = await streamWidgetContent(
      generationOptions,
      capabilities,
      promptType,
    );
    return openAiCompatibleStream(result.textStream, {
      finalize: async (rawText) => (await result.finalize(rawText)).text,
    });
  }

  const result = await generateWidgetContent(
    generationOptions,
    capabilities,
    promptType,
  );
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
        "application/json": {
          schema: successEnvelope(z.object({}).passthrough()),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(generateStagedRoute, async (c) => {
  await enforceAiRateLimit(c);
  const payload = c.req.valid("json");
  validateMessagePayload(payload.messages);
  const settings = await loadAiRuntimeSettings(c);
  const provider = getConfiguredProvider(settings, payload.provider);
  const modelId = requireAllowedWidgetAiModel(
    settings,
    provider,
    payload.model,
  );
  const model = await createAiLanguageModel(provider, modelId, settings, c.env);
  const capabilities = resolveWidgetAiModelCapabilities(
    provider,
    modelId,
    settings.providers[provider].capabilities,
  );
  const normalizedMessages = normalizeMessages(payload.messages);
  const promptType =
    payload.promptType ?? inferPromptTypeFromMessages(normalizedMessages);
  const generationOptions = {
    model,
    messages: withDestinationRuntimeContract(normalizedMessages, promptType, {
      compositionMode: payload.stage !== "plan",
    }),
    allowSystemInMessages: true,
    temperature:
      payload.stage === "plan"
        ? settings.generation.planningTemperature
        : payload.stage === "finalize"
          ? Math.min(settings.generation.improvementTemperature, 0.45)
          : settings.generation.generationTemperature,
    maxOutputTokens: getStagedOutputBudget(settings, payload.stage, promptType),
    timeout: {
      totalMs:
        payload.stage === "plan"
          ? getTimeout("planning")
          : payload.stage === "finalize"
            ? getTimeout("improvement")
            : getTimeout("generation"),
    },
    maxRetries: 2,
    abortSignal: c.req.raw.signal,
  };

  const result =
    payload.stage === "plan"
      ? await generateStagedPlan(generationOptions, capabilities)
      : await generateWidgetContent(
          generationOptions,
          capabilities,
          promptType,
        );

  const response = {
    ...openAiCompatibleJson(result.text, provider, modelId, result.usage),
  } as Record<string, unknown>;

  if (payload.stage !== undefined) response.stage = payload.stage;
  response.promptType = promptType;
  if (payload.sectionIndex !== undefined)
    response.sectionIndex = payload.sectionIndex;
  if (payload.totalSections !== undefined)
    response.totalSections = payload.totalSections;

  return ok(c, response);
});

app.route("/", adminAiChatRoutes);

export { enforceAiRateLimit } from "./ai-rate-limit";
export {
  getCreateOutputBudget,
  inferPromptTypeFromMessages,
  withDestinationRuntimeContract,
} from "./ai-widget-contract";
export type { WidgetGenerationResult } from "./ai-widget-contract";
export {
  generateWidgetContent,
  openAiCompatibleJson,
  streamWidgetContent,
} from "./ai-widget-runtime";
export { app as adminAiRoutes };
