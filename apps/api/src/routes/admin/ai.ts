import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  generateText,
  NoObjectGeneratedError,
  Output,
  streamText,
  UnsupportedFunctionalityError,
  type LanguageModel,
  type ModelMessage,
} from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { getClientIp, rateLimit } from '@scalius/shared/rate-limit';
import {
  AI_PROVIDER_IDS,
  GENERATION_CONFIG,
  ERROR_MESSAGES,
  getConfiguredProvider,
  getTimeout,
  getWidgetAiRuntimeSettings,
  providerHasCredentials,
  requireAllowedWidgetAiModel,
  resolveWidgetAiModelCapabilities,
  type WidgetAiProvider,
  type WidgetAiRuntimeSettings,
} from '@scalius/core/modules/ai';
import { ok } from '../../utils/api-response';
import { RateLimitError, ValidationError } from '../../utils/api-error';
import { errorResponses, successEnvelope } from '../../schemas/responses';
import { getCredentialEncryptionKey } from '../../utils/encryption-key';
import { listAllowedModelsForProvider } from './ai-models';
import {
  normalizeStagedPlanOutput,
  normalizeStagedPlanText,
  normalizeWidgetGenerationText,
  normalizeWidgetOutput,
  stagedPlanOutputObjectSpec,
  stagedPlanOutputSchema,
  widgetOutputObjectSpec,
  widgetOutputSchema,
} from './ai-response-validation';
import { normalizeMessages } from './ai-message-normalization';

const app = new OpenAPIHono<{ Bindings: Env }>();

const MAX_MESSAGES = 32;
const MAX_TEXT_CHARS = GENERATION_CONFIG.context.maxPromptChars;
const MAX_IMAGES = GENERATION_CONFIG.context.maxImages;
const MAX_MODEL_ID_CHARS = 200;
const AI_RATE_LIMIT = { limit: 20, windowMs: 60_000 };

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
  role: z.enum(['system', 'user', 'assistant']),
  content: z.union([z.string(), z.array(messagePartSchema)]),
});

const generateSchema = z
  .object({
    provider: providerEnum.optional(),
    model: z.string().max(MAX_MODEL_ID_CHARS).optional(),
    messages: z.array(messageSchema).optional(),
    prompt: z.string().optional(),
    stream: z.boolean().optional(),
    images: z.array(z.object({ url: z.string(), mimeType: z.string().optional() }).passthrough()).optional(),
    operation: z.enum(['create', 'improve']).optional(),
  })
  .refine((data) => data.messages || data.prompt, {
    message: 'Messages or prompt is required.',
  });

const generateStagedSchema = z.object({
  provider: providerEnum.optional(),
  model: z.string().max(MAX_MODEL_ID_CHARS).optional(),
  messages: z.array(messageSchema).min(1),
  stage: z.enum(['plan', 'generate', 'finalize']).optional(),
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

type GenerateTextOptions = Parameters<typeof generateText>[0];
type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;
type GenerationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

interface WidgetGenerationResult {
  text: string;
  usage: GenerationUsage;
}

function isAllowedImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'data:';
  } catch {
    return false;
  }
}

function countMessageText(content: z.infer<typeof messageSchema>['content']): number {
  if (typeof content === 'string') return content.length;
  return content.reduce((total, part) => {
    if (typeof part.text === 'string') return total + part.text.length;
    const imageUrl = part.image_url?.url ?? part.image;
    return total + (imageUrl ? String(imageUrl).length : 0);
  }, 0);
}

function countMessageImages(content: z.infer<typeof messageSchema>['content']): number {
  if (typeof content === 'string') return 0;
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
    if (typeof message.content === 'string') continue;
    for (const part of message.content) {
      const imageUrl = part.image_url?.url ?? part.image;
      if (imageUrl && !isAllowedImageUrl(String(imageUrl))) {
        throw new ValidationError('AI image URLs must use HTTPS or data URLs.');
      }
    }
  }
}

function validatePromptPayload(prompt: string, images: Array<{ url: string; mimeType?: string }> | undefined): void {
  if (prompt.length > MAX_TEXT_CHARS) {
    throw new ValidationError(`AI prompt is too large. Maximum is ${MAX_TEXT_CHARS} characters.`);
  }
  if ((images?.length ?? 0) > MAX_IMAGES) {
    throw new ValidationError(`Too many image inputs. Maximum is ${MAX_IMAGES}.`);
  }
  for (const image of images ?? []) {
    if (!isAllowedImageUrl(image.url)) {
      throw new ValidationError('AI image URLs must use HTTPS or data URLs.');
    }
  }
}

async function enforceAiRateLimit(c: any): Promise<void> {
  const kv = c.env.CACHE as KVNamespace | undefined;
  if (!kv) return;

  const user = c.get('user') as { id?: string } | undefined;
  const identity = user?.id || getClientIp(c.req.raw);
  const result = await rateLimit({
    kv,
    key: `admin-ai:${identity}`,
    limit: AI_RATE_LIMIT.limit,
    windowMs: AI_RATE_LIMIT.windowMs,
  });

  if (!result.allowed) {
    throw new RateLimitError(ERROR_MESSAGES.rateLimitError, Math.ceil((result.resetAt - Date.now()) / 1000));
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

  if (provider === 'openrouter') {
    const openrouter = createOpenRouter({
      apiKey: settings.apiKeys.openrouter,
      baseURL: settings.providers.openrouter.baseUrl,
      appName: settings.providers.openrouter.appName || undefined,
      appUrl: settings.providers.openrouter.appUrl || undefined,
      compatibility: 'strict',
    });
    return openrouter(modelId);
  }

  if (provider === 'openai') {
    const openai = createOpenAI({
      apiKey: settings.apiKeys.openai,
      baseURL: settings.providers.openai.baseUrl,
    });
    return openai(modelId);
  }

  if (provider === 'gemini') {
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

function promptToMessages(
  prompt: string,
  images: Array<{ url: string; mimeType?: string }> | undefined,
): ModelMessage[] {
  if (!images?.length) return [{ role: 'user', content: prompt }];
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...images.map((image) => {
          try {
            return {
              type: 'image' as const,
              image: new URL(image.url),
              mediaType: image.mimeType,
            };
          } catch {
            return {
              type: 'text' as const,
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
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    provider,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: usage?.inputTokens,
      completion_tokens: usage?.outputTokens,
      total_tokens: usage?.totalTokens,
    },
  };
}

function openAiCompatibleStream(
  textStream: AsyncIterable<string>,
  options?: {
    finalize?: (rawText: string) => string | Promise<string>;
  },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let rawText = '';

      try {
        for await (const delta of textStream) {
          if (!delta) continue;
          rawText += delta;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`),
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
                    message: { role: 'assistant', content: finalContent },
                    finish_reason: 'stop',
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
                message: error instanceof Error ? error.message : 'AI stream failed',
              },
            })}\n\n`,
          ),
        );
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

function usageFromResult(result: { totalUsage?: GenerationUsage }): GenerationUsage {
  return {
    inputTokens: result.totalUsage?.inputTokens,
    outputTokens: result.totalUsage?.outputTokens,
    totalTokens: result.totalUsage?.totalTokens,
  };
}

function structuredGenerationFailureDetails(error: unknown): Record<string, unknown> {
  if (NoObjectGeneratedError.isInstance(error)) {
    return {
      type: 'NoObjectGeneratedError',
      cause: error.cause instanceof Error ? error.cause.message : String(error.cause ?? ''),
      finishReason: error.finishReason,
      usage: error.usage,
      response: error.response,
      textSample: error.text?.slice(0, 800),
    };
  }

  if (UnsupportedFunctionalityError.isInstance(error)) {
    return {
      type: 'UnsupportedFunctionalityError',
      functionality: error.functionality,
      message: error.message,
    };
  }

  return {
    type: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted'));
}

function isTransientProviderError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('8005') ||
    message.includes('internal server error') ||
    message.includes('service unavailable') ||
    message.includes('temporarily unavailable') ||
    message.includes('gateway timeout') ||
    message.includes('network error') ||
    message.includes('timeout')
  );
}

async function generateTextWithTransientRetry(
  options: GenerateTextOptions,
  operation: string,
): Promise<GenerateTextResult> {
  try {
    return await generateText(options);
  } catch (error) {
    if (isAbortError(error) || !isTransientProviderError(error)) {
      throw error;
    }

    console.warn(`${operation} failed with a transient AI provider error; retrying once.`, {
      message: getErrorMessage(error),
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    return await generateText({
      ...options,
      temperature: typeof options.temperature === 'number' ? Math.min(options.temperature, 0.5) : options.temperature,
      maxRetries: 1,
    });
  }
}

function warnStructuredGenerationFallback(scope: string, error: unknown): void {
  console.warn(
    `${scope} structured generation failed; falling back to text.`,
    structuredGenerationFailureDetails(error),
  );
}

function addWidgetFormatRetryInstruction(options: GenerateTextOptions): GenerateTextOptions {
  const messages = Array.isArray((options as { messages?: ModelMessage[] }).messages)
    ? (options as { messages: ModelMessage[] }).messages
    : [];
  const retryOptions = {
    ...options,
    prompt: undefined,
    messages: [
      ...messages,
      {
        role: 'user',
        content:
          'The previous streamed response was not usable widget code. Regenerate the widget from the full context above and return ONLY this exact format, with no markdown, JSON, explanation, or script tags:\n\n<htmljs>\n<!-- valid HTML only -->\n</htmljs>\n\n<css>\n/* valid CSS only */\n</css>',
      },
    ],
    temperature: typeof options.temperature === 'number' ? Math.min(options.temperature, 0.3) : 0.3,
    maxRetries: 1,
  };
  return retryOptions as GenerateTextOptions;
}

function addStagedPlanRetryInstruction(options: GenerateTextOptions): GenerateTextOptions {
  const messages = Array.isArray((options as { messages?: ModelMessage[] }).messages)
    ? (options as { messages: ModelMessage[] }).messages
    : [];
  return {
    ...options,
    prompt: undefined,
    messages: [
      ...messages,
      {
        role: 'user',
        content:
          'Return ONLY a valid JSON generation plan. No markdown, HTML, CSS, comments, or explanation. Shape: {"totalSections":3,"compositionBrief":"One continuous destination-appropriate storefront composition","sharedDesignSystem":"Consistent palette, cards, media treatment, and CTAs","spacingStrategy":"Final wrapper has gap 0; sections connect with shared background and internal padding","sectionDescriptions":["Opening section","Core merchandising section","Closing action section"],"sectionContinuity":["Establish design tokens","Continue with the same rhythm and components","Close without external spacing"],"estimatedTokens":1200}.',
      },
    ],
    temperature: 0.1,
    maxRetries: 1,
  } as GenerateTextOptions;
}

async function generateWidgetContent(
  options: GenerateTextOptions,
  capabilities: { supportsStructuredOutput: boolean },
): Promise<WidgetGenerationResult> {
  if (capabilities.supportsStructuredOutput) {
    const result = await generateText({
      ...options,
      output: Output.object({
        ...widgetOutputObjectSpec,
      }),
    }).catch((error) => {
      warnStructuredGenerationFallback('Widget', error);
      return null;
    });

    if (result) {
      const output = widgetOutputSchema.safeParse(result.output);
      if (!output.success) {
        throw new ValidationError(ERROR_MESSAGES.jsonParseFailed, {
          issues: output.error.issues,
        });
      }
      return {
        text: normalizeWidgetOutput(output.data),
        usage: usageFromResult(result),
      };
    }
  }

  const result = await generateTextWithTransientRetry(options, 'Widget generation');
  try {
    return {
      text: normalizeWidgetGenerationText(result.text),
      usage: usageFromResult(result),
    };
  } catch (error) {
    console.warn('Widget response failed validation; retrying once:', error);
    const retry = await generateTextWithTransientRetry(
      addWidgetFormatRetryInstruction(options),
      'Widget format repair',
    );
    return {
      text: normalizeWidgetGenerationText(retry.text),
      usage: usageFromResult(retry),
    };
  }
}

async function finalizeStreamedWidgetContent(
  rawText: string,
  options: GenerateTextOptions,
  capabilities: { supportsStructuredOutput: boolean },
): Promise<string> {
  try {
    return normalizeWidgetGenerationText(rawText);
  } catch (error) {
    console.warn('Streamed widget response failed validation; retrying once:', error);
    const retryOptions = addWidgetFormatRetryInstruction(options);
    const retry = await generateWidgetContent(retryOptions, capabilities);
    return retry.text;
  }
}

async function generateStagedPlan(
  options: GenerateTextOptions,
  capabilities: { supportsStructuredOutput: boolean },
): Promise<WidgetGenerationResult> {
  if (capabilities.supportsStructuredOutput) {
    const result = await generateText({
      ...options,
      output: Output.object({
        ...stagedPlanOutputObjectSpec,
      }),
    }).catch((error) => {
      warnStructuredGenerationFallback('Staged plan', error);
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
      console.warn('Structured staged plan output failed validation; falling back to text:', output.error);
    }
  }

  const result = await generateTextWithTransientRetry(options, 'Staged plan generation');
  try {
    return {
      text: normalizeStagedPlanText(result.text),
      usage: usageFromResult(result),
    };
  } catch (error) {
    console.warn('Text staged plan failed validation; retrying once:', error);
    const retry = await generateTextWithTransientRetry(
      addStagedPlanRetryInstruction(options),
      'Staged plan repair',
    );
    return {
      text: normalizeStagedPlanText(retry.text),
      usage: usageFromResult(retry),
    };
  }
}

async function runtimeSettings(c: any) {
  const db = c.get('db');
  return getWidgetAiRuntimeSettings(db, c.env, getCredentialEncryptionKey(c.env));
}

const listModelsRoute = createRoute({
  method: 'get',
  path: '/models',
  tags: ['Admin - AI'],
  summary: 'List available models for the configured AI provider',
  request: {
    query: z.object({ provider: providerEnum.optional() }),
  },
  responses: {
    200: {
      description: 'AI model list',
      content: {
        'application/json': {
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
  const query = c.req.valid('query');
  const provider = getConfiguredProvider(settings, query.provider);
  const models = await listAllowedModelsForProvider(provider, settings);

  return ok(c, {
    provider,
    defaultModel: settings.providers[provider].defaultModel,
    models,
  });
});

const generateRoute = createRoute({
  method: 'post',
  path: '/generate',
  tags: ['Admin - AI'],
  summary: 'Generate widget content with the configured AI provider',
  request: {
    body: { content: { 'application/json': { schema: generateSchema } } },
  },
  responses: {
    200: {
      description: 'Generation result',
      content: {
        'application/json': {
          schema: successEnvelope(z.object({}).passthrough()),
        },
        'text/event-stream': { schema: z.string() },
      },
    },
    ...errorResponses,
  },
});

app.openapi(generateRoute, async (c) => {
  await enforceAiRateLimit(c);
  const payload = c.req.valid('json');
  if (payload.messages) {
    validateMessagePayload(payload.messages);
  } else {
    validatePromptPayload(payload.prompt ?? '', payload.images);
  }
  const settings = await runtimeSettings(c);
  const provider = getConfiguredProvider(settings, payload.provider);
  const modelId = requireAllowedWidgetAiModel(settings, provider, payload.model);
  const model = getLanguageModel(provider, modelId, settings, c.env);
  const capabilities = resolveWidgetAiModelCapabilities(provider, modelId, settings.providers[provider].capabilities);
  const messages = payload.messages
    ? normalizeMessages(payload.messages)
    : promptToMessages(payload.prompt ?? '', payload.images);

  const generationOptions = {
    model,
    messages,
    allowSystemInMessages: true,
    temperature:
      payload.operation === 'improve'
        ? settings.generation.improvementTemperature
        : settings.generation.generationTemperature,
    maxOutputTokens:
      payload.operation === 'improve'
        ? settings.generation.maxOutputTokens
        : settings.generation.fastGenerationMaxOutputTokens,
    timeout: {
      totalMs: getTimeout(payload.operation === 'improve' ? 'improvement' : 'generation'),
    },
    maxRetries: 2,
    abortSignal: c.req.raw.signal,
  };

  if (payload.stream) {
    const result = streamText(generationOptions);
    return openAiCompatibleStream(result.textStream, {
      finalize: (rawText) => finalizeStreamedWidgetContent(rawText, generationOptions, capabilities),
    });
  }

  const result = await generateWidgetContent(generationOptions, capabilities);
  return ok(c, openAiCompatibleJson(result.text, provider, modelId, result.usage));
});

const generateStagedRoute = createRoute({
  method: 'post',
  path: '/generate-staged',
  tags: ['Admin - AI'],
  summary: 'Generate staged widget content with the configured AI provider',
  request: {
    body: { content: { 'application/json': { schema: generateStagedSchema } } },
  },
  responses: {
    200: {
      description: 'Staged generation result',
      content: {
        'application/json': {
          schema: successEnvelope(z.object({}).passthrough()),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(generateStagedRoute, async (c) => {
  await enforceAiRateLimit(c);
  const payload = c.req.valid('json');
  validateMessagePayload(payload.messages);
  const settings = await runtimeSettings(c);
  const provider = getConfiguredProvider(settings, payload.provider);
  const modelId = requireAllowedWidgetAiModel(settings, provider, payload.model);
  const model = getLanguageModel(provider, modelId, settings, c.env);
  const capabilities = resolveWidgetAiModelCapabilities(provider, modelId, settings.providers[provider].capabilities);
  const generationOptions = {
    model,
    messages: normalizeMessages(payload.messages),
    allowSystemInMessages: true,
    temperature:
      payload.stage === 'plan'
        ? settings.generation.planningTemperature
        : payload.stage === 'finalize'
          ? Math.min(settings.generation.improvementTemperature, 0.45)
          : settings.generation.generationTemperature,
    maxOutputTokens: settings.generation.maxOutputTokens,
    timeout: {
      totalMs:
        payload.stage === 'plan'
          ? getTimeout('planning')
          : payload.stage === 'finalize'
            ? getTimeout('improvement')
            : getTimeout('generation'),
    },
    maxRetries: 2,
    abortSignal: c.req.raw.signal,
  };

  const result =
    payload.stage === 'plan'
      ? await generateStagedPlan(generationOptions, capabilities)
      : await generateWidgetContent(generationOptions, capabilities);

  const response = {
    ...openAiCompatibleJson(result.text, provider, modelId, result.usage),
  } as Record<string, unknown>;

  if (payload.stage !== undefined) response.stage = payload.stage;
  if (payload.sectionIndex !== undefined) response.sectionIndex = payload.sectionIndex;
  if (payload.totalSections !== undefined) response.totalSections = payload.totalSections;

  return ok(c, response);
});

export { app as adminAiRoutes };
