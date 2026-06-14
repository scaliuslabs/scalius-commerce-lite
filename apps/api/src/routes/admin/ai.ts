import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
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
  createWidgetCompositionContract,
  getTimeout,
  getWidgetAiRuntimeSettings,
  providerHasCredentials,
  requireAllowedWidgetAiModel,
  resolveWidgetAiModelCapabilities,
  WIDGET_DESTINATION_RUNTIME_CONTRACTS,
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
  createNoContextFallbackWidget,
  stagedPlanOutputObjectSpec,
  stagedPlanOutputSchema,
  widgetOutputObjectSpec,
  widgetOutputSchema,
  type WidgetPromptType,
} from './ai-response-validation';
import { normalizeMessages } from './ai-message-normalization';
import { parseTagBasedResponse } from '@scalius/shared/tag-parser';

const app = new OpenAPIHono<{ Bindings: Env }>();

const MAX_MESSAGES = 32;
const MAX_TEXT_CHARS = GENERATION_CONFIG.context.maxPromptChars;
const MAX_IMAGES = GENERATION_CONFIG.context.maxImages;
const MAX_MODEL_ID_CHARS = 200;
const AI_RATE_LIMIT = { limit: 20, windowMs: 60_000 };
const NO_COMMERCE_FACTS_PROMPT_MARKER = 'FACTUALITY GATE - NO COMMERCE FACTS PROVIDED';

const providerEnum = z.enum(AI_PROVIDER_IDS);
const promptTypeEnum = z.enum(['widget', 'landing-page', 'collection']);

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
    promptType: promptTypeEnum.optional(),
    compositionMode: z.boolean().optional(),
  })
  .refine((data) => data.messages || data.prompt, {
    message: 'Messages or prompt is required.',
  });

const generateStagedSchema = z.object({
  provider: providerEnum.optional(),
  model: z.string().max(MAX_MODEL_ID_CHARS).optional(),
  promptType: promptTypeEnum.optional(),
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
type ApiContext = Context<{ Bindings: Env }>;

export interface WidgetGenerationResult {
  text: string;
  usage: GenerationUsage;
}

function modelMessageContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function inferPromptTypeFromMessages(messages: ModelMessage[]): WidgetPromptType {
  const text = messages.map((message) => modelMessageContentText(message.content)).join('\n').toLowerCase();
  if (text.includes('homepage widget contract:')) return 'widget';
  if (text.includes('collection section contract:')) return 'collection';
  if (text.includes('landing section contract:')) return 'landing-page';
  return 'widget';
}

export function withDestinationRuntimeContract(
  messages: ModelMessage[],
  promptType: WidgetPromptType,
  options: { compositionMode?: boolean } = {},
): ModelMessage[] {
  const compositionContract = options.compositionMode ? `\n\n${createWidgetCompositionContract(promptType)}` : '';

  return [
    ...messages,
    {
      role: 'system',
      content: `${WIDGET_DESTINATION_RUNTIME_CONTRACTS[promptType]}

SERVER PERFORMANCE CONTRACT:
- Produce one complete artifact in this call. Do not wait for a later stage to make it coherent.
- Keep the artifact compact: one root section, concise HTML, and CSS that can finish comfortably inside the output budget. Emit <css> before <htmljs>.
- Homepage and collection widgets should usually be one connected commerce section with 2-4 product cards, not a mini-page.
- Finish the core CSS before optional hover states, decorative effects, or extra responsive refinements. Never leave a CSS rule or property unfinished.
- Do not emit inline SVG icons, icon sprites, long comments, duplicate selectors, or decorative code that does not materially improve the merchant-facing section.
- Put optional JavaScript in <js> only when it improves local widget interaction. JS must use widget.root, widget.query(), or widget.queryAll() and must not touch global storefront state.
- Use no markdown.
- The platform owns runtime wrappers. Do not emit widget-container, cms-widget-frame, widget-placement-zone, data-scalius-widget-root, or data-widget-id in generated HTML.
- Use one content wrapper or section with destination-specific classes and margin: 0. Avoid min-height: 100vh, fixed viewport heights, large spacer elements, or disconnected full-page bands.
- Bound every product image in a stable card/media container with aspect-ratio, max-height, and object-fit. Do not generate blank white media panels, off-canvas crops, absolutely positioned product cutouts, or oversized empty columns.
- The rendered first viewport must look intentionally filled on desktop and mobile: no dead rows, no decorative whitespace blocks, and no product image region larger than its useful content.${compositionContract}`,
    } as ModelMessage,
  ];
}

export function getCreateOutputBudget(settings: WidgetAiRuntimeSettings, promptType: WidgetPromptType, operation?: 'create' | 'improve'): number {
  if (operation === 'improve') return settings.generation.maxOutputTokens;

  const fastBudget = settings.generation.fastGenerationMaxOutputTokens;
  const maxBudget = settings.generation.maxOutputTokens;
  const targetBudget =
    promptType === 'landing-page'
      ? Math.max(fastBudget, 4400)
      : promptType === 'collection'
        ? Math.max(fastBudget, 3600)
        : Math.max(fastBudget, 3200);

  return Math.min(maxBudget, targetBudget);
}

function getStagedOutputBudget(
  settings: WidgetAiRuntimeSettings,
  stage: 'plan' | 'generate' | 'finalize' | undefined,
  promptType: WidgetPromptType,
): number {
  if (stage === 'plan') return Math.min(settings.generation.maxOutputTokens, 1200);
  if (stage === 'finalize') return Math.min(settings.generation.maxOutputTokens, promptType === 'landing-page' ? 3600 : 2800);
  if (promptType === 'landing-page') return Math.min(settings.generation.maxOutputTokens, 3200);
  if (promptType === 'collection') return Math.min(settings.generation.maxOutputTokens, 2800);
  return Math.min(settings.generation.maxOutputTokens, 2400);
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

export async function enforceAiRateLimit(c: ApiContext): Promise<void> {
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

export function getLanguageModel(
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

export function openAiCompatibleJson(
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

function contentIncludesNoCommerceFactsMarker(content: unknown): boolean {
  if (typeof content === 'string') {
    return content.includes(NO_COMMERCE_FACTS_PROMPT_MARKER);
  }

  if (!Array.isArray(content)) return false;

  return content.some((part) => {
    if (typeof part === 'string') {
      return part.includes(NO_COMMERCE_FACTS_PROMPT_MARKER);
    }

    if (!part || typeof part !== 'object') return false;
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' && text.includes(NO_COMMERCE_FACTS_PROMPT_MARKER);
  });
}

function shouldEnforceNoContextCommercePolicy(options: GenerateTextOptions): boolean {
  const prompt = (options as { prompt?: unknown }).prompt;
  if (contentIncludesNoCommerceFactsMarker(prompt)) return true;

  const messages = (options as { messages?: Array<{ content?: unknown }> }).messages;
  return Array.isArray(messages)
    ? messages.some((message) => contentIncludesNoCommerceFactsMarker(message.content))
    : false;
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
  const noContextCommercePolicy = shouldEnforceNoContextCommercePolicy(options);
  const retryOptions = {
    ...options,
    prompt: undefined,
    messages: [
      ...messages,
      {
        role: 'user',
        content: [
          'The previous response was not usable widget code. Regenerate the widget from the full context above and return ONLY this exact format, with complete non-truncated CSS, no dangling declarations, no markdown, JSON, or explanation. Optional JS must be root-scoped and go in <js>, not inside HTML:\n\n<htmljs>\n<!-- valid HTML fragment -->\n</htmljs>\n\n<css>\n/* complete valid CSS */\n</css>\n\n<js>\n/* optional: use widget.root/query/queryAll only */\n</js>',
          noContextCommercePolicy
            ? 'No product, category, collection, policy, pricing, delivery, review, or media facts were provided. Use generic non-factual commerce copy only. Do not mention delivery, shipping, guarantees, reviews, ratings, discounts, limited/new/latest releases, absolute URLs, or buy-now links.'
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    temperature: typeof options.temperature === 'number' ? Math.min(options.temperature, noContextCommercePolicy ? 0.2 : 0.3) : 0.3,
    maxRetries: 1,
  };
  return retryOptions as GenerateTextOptions;
}

function truncateFailedWidgetResponse(rawText: string): string {
  const trimmed = rawText.trim();
  if (trimmed.length <= 12_000) return trimmed;
  return `${trimmed.slice(0, 6_000)}\n\n<!-- middle omitted for repair prompt -->\n\n${trimmed.slice(-6_000)}`;
}

function widgetRepairBudget(options: GenerateTextOptions, promptType: WidgetPromptType): number {
  const requested = typeof options.maxOutputTokens === 'number' ? options.maxOutputTokens : 0;
  const minimum =
    promptType === 'landing-page'
      ? 4600
      : promptType === 'collection'
        ? 3800
        : 3600;
  return Math.max(requested, minimum);
}

function addWidgetArtifactRepairInstruction(
  options: GenerateTextOptions,
  rawText: string,
  reason: unknown,
  promptType: WidgetPromptType,
): GenerateTextOptions {
  const messages = Array.isArray((options as { messages?: ModelMessage[] }).messages)
    ? (options as { messages: ModelMessage[] }).messages
    : [];
  const noContextCommercePolicy = shouldEnforceNoContextCommercePolicy(options);

  return {
    ...options,
    prompt: undefined,
    messages: [
      ...messages,
      {
        role: 'user',
        content: [
          'Repair the failed widget artifact below. Keep the merchant intent and any valid catalog facts, but return ONE complete, compact, production-ready artifact only.',
          `Validation failure: ${getErrorMessage(reason)}`,
          'The repaired response must include HTML and CSS tags, with non-empty valid CSS. Do not explain. Do not use markdown. Optional JavaScript belongs in <js> and must use widget.root/query/queryAll only.',
          'Required response shape:\n<htmljs>\n<section class="destination-specific-root">...</section>\n</htmljs>\n<css>\n.destination-specific-root{margin:0;...}\n</css>\n<js>\n/* optional root-scoped behavior */\n</js>',
          'CSS requirements: complete selectors, complete declarations, balanced braces, no dangling properties, no empty stylesheet, no oversized blank image panels, and bounded product image containers.',
          noContextCommercePolicy
            ? 'No product, category, collection, policy, pricing, delivery, review, or media facts were provided. Use generic non-factual commerce copy only.'
            : '',
          `Failed artifact to repair:\n${truncateFailedWidgetResponse(rawText)}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    temperature: typeof options.temperature === 'number' ? Math.min(options.temperature, 0.25) : 0.25,
    maxOutputTokens: widgetRepairBudget(options, promptType),
    maxRetries: 1,
  } as GenerateTextOptions;
}

function addMissingCssCompletionInstruction(
  options: GenerateTextOptions,
  rawText: string,
  promptType: WidgetPromptType,
): GenerateTextOptions {
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
        content: [
          'The generated widget artifact included usable HTML but no usable CSS. Complete it now.',
          `Destination: ${promptType}`,
          'Return ONE complete artifact only. Keep the HTML structure and merchant/catalog facts, but add a polished, compact, scoped stylesheet.',
          'The CSS must make the section visually pleasing on desktop and mobile, bound product images inside stable media containers, define responsive layout, spacing, typography, buttons, cards, focus states, and avoid blank image panels or large empty gaps.',
          'Required response shape, no markdown and no explanation:\n<htmljs>\n<!-- same or minimally cleaned HTML fragment -->\n</htmljs>\n<css>\n/* complete scoped CSS with balanced braces */\n</css>\n<js>\n/* optional root-scoped behavior only if needed */\n</js>',
          `HTML-only artifact:\n${truncateFailedWidgetResponse(rawText)}`,
        ].join('\n\n'),
      },
    ],
    temperature: typeof options.temperature === 'number' ? Math.min(options.temperature, 0.25) : 0.25,
    maxOutputTokens: widgetRepairBudget(options, promptType),
    maxRetries: 1,
  } as GenerateTextOptions;
}

async function completeMissingCssArtifact(
  rawText: string,
  options: GenerateTextOptions,
  promptType: WidgetPromptType,
  normalizationOptions: { commerceFactsProvided: boolean },
): Promise<WidgetGenerationResult | null> {
  const parsed = parseTagBasedResponse(rawText);
  const html = parsed.data?.html?.trim() ?? '';
  const css = parsed.data?.css?.trim() ?? '';
  if (!parsed.success || !html || css) return null;

  const completion = await generateTextWithTransientRetry(
    addMissingCssCompletionInstruction(options, rawText, promptType),
    'Widget missing CSS completion',
  );

  return {
    text: normalizeWidgetGenerationText(completion.text, normalizationOptions),
    usage: usageFromResult(completion),
  };
}

async function repairInvalidWidgetArtifact(
  rawText: string,
  error: unknown,
  options: GenerateTextOptions,
  promptType: WidgetPromptType,
  normalizationOptions: { commerceFactsProvided: boolean },
): Promise<WidgetGenerationResult> {
  if (!rawText.trim()) {
    throw error;
  }

  const repairOptions = addWidgetArtifactRepairInstruction(options, rawText, error, promptType);
  const repair = await generateTextWithTransientRetry(repairOptions, 'Widget artifact repair');
  return {
    text: normalizeWidgetGenerationText(repair.text, normalizationOptions),
    usage: usageFromResult(repair),
  };
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

function fallbackNoContextWidgetIfAllowed(
  options: GenerateTextOptions,
  promptType: WidgetPromptType,
): WidgetGenerationResult | null {
  if (!shouldEnforceNoContextCommercePolicy(options)) return null;
  console.warn('No-context widget generation could not produce a policy-safe artifact; returning deterministic safe fallback.');
  return {
    text: createNoContextFallbackWidget(promptType),
    usage: {},
  };
}

export async function generateWidgetContent(
  options: GenerateTextOptions,
  capabilities: { supportsStructuredOutput: boolean },
  promptType: WidgetPromptType = 'widget',
): Promise<WidgetGenerationResult> {
  const normalizationOptions = {
    commerceFactsProvided: !shouldEnforceNoContextCommercePolicy(options),
  };

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
        warnStructuredGenerationFallback('Widget structured output validation', error);
      }
    }
  }

  const result = await generateTextWithTransientRetry(options, 'Widget generation');
  try {
    return {
      text: normalizeWidgetGenerationText(result.text, normalizationOptions),
      usage: usageFromResult(result),
    };
  } catch (error) {
    console.warn('Widget response failed validation; using fallback or retrying once:', error);
    const fallback = fallbackNoContextWidgetIfAllowed(options, promptType);
    if (fallback) return fallback;

    try {
      return await repairInvalidWidgetArtifact(result.text, error, options, promptType, normalizationOptions);
    } catch (repairError) {
      console.warn('Widget artifact repair failed; regenerating from the original brief:', repairError);
    }

    const retry = await generateTextWithTransientRetry(
      addWidgetFormatRetryInstruction(options),
      'Widget format repair',
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

async function finalizeStreamedWidgetContent(
  rawText: string,
  options: GenerateTextOptions,
  capabilities: { supportsStructuredOutput: boolean },
  promptType: WidgetPromptType = 'widget',
): Promise<string> {
  const normalizationOptions = {
    commerceFactsProvided: !shouldEnforceNoContextCommercePolicy(options),
  };

  try {
    return normalizeWidgetGenerationText(rawText, normalizationOptions);
  } catch (error) {
    console.warn('Streamed widget response failed validation; using fallback or retrying once:', error);
    const fallback = fallbackNoContextWidgetIfAllowed(options, promptType);
    if (fallback) return fallback.text;

    try {
      const completed = await completeMissingCssArtifact(rawText, options, promptType, normalizationOptions);
      if (completed) return completed.text;
    } catch (completionError) {
      console.warn('Streamed widget missing CSS completion failed; trying full artifact repair:', completionError);
    }

    try {
      const repaired = await repairInvalidWidgetArtifact(rawText, error, options, promptType, normalizationOptions);
      return repaired.text;
    } catch (repairError) {
      console.warn('Streamed widget artifact repair failed; regenerating from the original brief:', repairError);
    }

    const retryOptions = addWidgetFormatRetryInstruction(options);
    try {
      const retry = await generateWidgetContent(retryOptions, capabilities, promptType);
      return retry.text;
    } catch (retryError) {
      const fallback = fallbackNoContextWidgetIfAllowed(options, promptType);
      if (fallback) return fallback.text;
      throw retryError;
    }
  }
}

export function streamWidgetContent(
  options: GenerateTextOptions,
  capabilities: { supportsStructuredOutput: boolean },
  promptType: WidgetPromptType = 'widget',
): {
  textStream: AsyncIterable<string>;
  finalize: (rawText: string) => Promise<WidgetGenerationResult>;
} {
  const result = streamText(options);

  return {
    textStream: result.textStream,
    async finalize(rawText: string) {
      let completeRawText = rawText;
      if (!completeRawText.trim()) {
        try {
          const finalText = (result as unknown as { text?: PromiseLike<string> }).text;
          if (finalText) completeRawText = await finalText;
        } catch {
          completeRawText = rawText;
        }
      }

      const text = await finalizeStreamedWidgetContent(completeRawText, options, capabilities, promptType);
      const usage: GenerationUsage = await (async () => {
        try {
          const usageResult = (result as unknown as { totalUsage?: PromiseLike<GenerationUsage> }).totalUsage;
          const totalUsage = usageResult ? await usageResult : undefined;
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

export async function runtimeSettings(c: ApiContext) {
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
  const normalizedMessages = payload.messages
    ? normalizeMessages(payload.messages)
    : promptToMessages(payload.prompt ?? '', payload.images);
  const promptType = payload.promptType ?? inferPromptTypeFromMessages(normalizedMessages);
  const messages = withDestinationRuntimeContract(normalizedMessages, promptType, {
    compositionMode: payload.compositionMode === true,
  });

  const generationOptions = {
    model,
    messages,
    allowSystemInMessages: true,
    temperature:
      payload.operation === 'improve'
        ? settings.generation.improvementTemperature
        : settings.generation.generationTemperature,
    maxOutputTokens:
      getCreateOutputBudget(settings, promptType, payload.operation),
    timeout: {
      totalMs: getTimeout(payload.operation === 'improve' ? 'improvement' : 'generation'),
    },
    maxRetries: 2,
    abortSignal: c.req.raw.signal,
  };

  if (payload.stream) {
    const result = streamText(generationOptions);
    return openAiCompatibleStream(result.textStream, {
      finalize: (rawText) => finalizeStreamedWidgetContent(rawText, generationOptions, capabilities, promptType),
    });
  }

  const result = await generateWidgetContent(generationOptions, capabilities, promptType);
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
  const normalizedMessages = normalizeMessages(payload.messages);
  const promptType = payload.promptType ?? inferPromptTypeFromMessages(normalizedMessages);
  const generationOptions = {
    model,
    messages: withDestinationRuntimeContract(normalizedMessages, promptType, {
      compositionMode: payload.stage !== 'plan',
    }),
    allowSystemInMessages: true,
    temperature:
      payload.stage === 'plan'
        ? settings.generation.planningTemperature
        : payload.stage === 'finalize'
          ? Math.min(settings.generation.improvementTemperature, 0.45)
          : settings.generation.generationTemperature,
    maxOutputTokens: getStagedOutputBudget(settings, payload.stage, promptType),
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
      : await generateWidgetContent(generationOptions, capabilities, promptType);

  const response = {
    ...openAiCompatibleJson(result.text, provider, modelId, result.usage),
  } as Record<string, unknown>;

  if (payload.stage !== undefined) response.stage = payload.stage;
  response.promptType = promptType;
  if (payload.sectionIndex !== undefined) response.sectionIndex = payload.sectionIndex;
  if (payload.totalSections !== undefined) response.totalSections = payload.totalSections;

  return ok(c, response);
});

export { app as adminAiRoutes };
