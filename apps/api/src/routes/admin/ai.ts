import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { LanguageModel, ModelMessage } from 'ai';
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
  resolveAiModelProfile,
  resolveWidgetAiModelCapabilities,
  WIDGET_DESTINATION_RUNTIME_CONTRACTS,
  type WidgetAiProvider,
  type WidgetAiRuntimeSettings,
} from '@scalius/core/modules/ai';
import { ok } from '../../utils/api-response';
import { RateLimitError, ServiceUnavailableError, ValidationError } from '../../utils/api-error';
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
const ADMIN_CHAT_MAX_MESSAGES = 24;
const ADMIN_CHAT_MAX_TEXT_CHARS = 80_000;
const ADMIN_CHAT_MAX_OUTPUT_TOKENS = 2_400;
const ADMIN_CHAT_MAX_NAVIGATION_PAGES = 24;
const ADMIN_CHAT_MAX_NAVIGATION_CONTEXT_CHARS = 1_800;
const ADMIN_CHAT_MAX_NAVIGATION_ACTIONS = 1;
const ADMIN_CHAT_MAX_PRODUCT_COPY_CONTEXT_CHARS = 18_000;
const ADMIN_CHAT_MAX_PRODUCT_DESCRIPTION_CHARS = 14_000;
const ADMIN_AGENT_MCP_URL = 'http://agent.internal/mcp/admin';
const ADMIN_NAVIGATION_CONTEXT_TOOL = 'admin_navigation_context';
const ADMIN_PRODUCT_SEARCH_TOOL = 'admin_product_search';
const ADMIN_PRODUCT_COPY_CONTEXT_TOOL = 'admin_product_copy_context';
const ADMIN_AGENT_MCP_PROTOCOL_VERSION = '2025-06-18';
const NO_COMMERCE_FACTS_PROMPT_MARKER = 'FACTUALITY GATE - NO COMMERCE FACTS PROVIDED';
const AI_NO_OBJECT_GENERATED_MARKER = 'vercel.ai.error.AI_NoObjectGeneratedError';
const AI_UNSUPPORTED_FUNCTIONALITY_MARKER = 'vercel.ai.error.AI_UnsupportedFunctionalityError';
const ADMIN_CHAT_EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const ADMIN_CHAT_BANGLADESH_PHONE_PATTERN = /(^|[^\d])(?:\+?88)?01[3-9]\d{8}(?!\d)/g;
const ADMIN_CHAT_BROAD_PHONE_PATTERN = /(^|[^\d])\+?\d[\d\s().-]{6,}\d(?!\d)/g;
const ADMIN_CHAT_TOKEN_PREFIX_PATTERN = /\b(?:chk|cst|otp|tok|token|session|secret|sk|pk)_[A-Za-z0-9_-]{6,}\b/gi;
const ADMIN_CHAT_LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;
const ADMIN_CHAT_SYSTEM_PROMPT = [
  'You are the Scalius Commerce admin assistant for merchants and operators.',
  'Answer from the conversation and general platform knowledge only. This endpoint cannot read live store data, change settings, mutate products, modify orders, adjust inventory, trigger payments, deploy code, inspect logs, or clear caches.',
  'When a safe dashboard destination list is provided, you may mention those real dashboard pages. The API may attach a separate click-confirmed navigation button for a matched destination; do not claim navigation is impossible when that safe action is available.',
  'When read-only product or page context is provided, use it for drafting and explanation only. Never claim that a product, setting, order, payment, inventory row, or credential has been changed unless a verified workflow explicitly reports success.',
  'When the merchant asks for an action, give safe step-by-step guidance and say that they must perform it in the dashboard or ask an operator to run a verified workflow.',
  'Do not ask for or repeat secrets, OTPs, API keys, credential material, payment proofs, customer contact details, or session tokens. If the user includes sensitive data, acknowledge only that it should be removed or rotated.',
  'Keep answers concise, practical, and explicit about uncertainty.',
].join('\n');

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

const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(MAX_TEXT_CHARS),
});

const chatSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(ADMIN_CHAT_MAX_MESSAGES),
});

type GenerateTextOptions = Parameters<typeof import('ai')['generateText']>[0];
type GenerateTextResult = Awaited<ReturnType<typeof import('ai')['generateText']>>;
type GenerationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};
type ApiContext = Context<{ Bindings: Env }>;
type JsonRecord = Record<string, unknown>;
type AdminChatNavigationEntry = {
  path: string;
  name: string;
  section: string;
};
type AdminChatNavigateAction = {
  type: 'navigate';
  path: string;
  label: string;
};
type AdminChatGenerationResult = {
  text: string;
  usage: GenerationUsage;
};
type AdminAgentMcpSession = {
  protocolVersion?: string;
  sessionId?: string;
};
type AdminChatProductCopyContext = {
  id: string;
  name: string;
  slug?: string;
  route?: string;
  status?: string;
  categoryName?: string;
  descriptionText?: string;
};

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

function validateAdminChatPayload(messages: Array<z.infer<typeof chatMessageSchema>>): void {
  const textChars = messages.reduce((total, message) => total + message.content.length, 0);
  if (textChars > ADMIN_CHAT_MAX_TEXT_CHARS) {
    throw new ValidationError(`AI chat is too large. Maximum is ${ADMIN_CHAT_MAX_TEXT_CHARS} characters.`);
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compactAdminChatText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (!compacted) return null;
  const redacted = compacted
    .replace(ADMIN_CHAT_EMAIL_PATTERN, '[redacted-email]')
    .replace(ADMIN_CHAT_BANGLADESH_PHONE_PATTERN, '$1[redacted-phone]')
    .replace(ADMIN_CHAT_BROAD_PHONE_PATTERN, '$1[redacted-number]')
    .replace(ADMIN_CHAT_TOKEN_PREFIX_PATTERN, '[redacted-token]')
    .replace(ADMIN_CHAT_LONG_TOKEN_PATTERN, '[redacted-token]');
  return redacted.length <= maxLength ? redacted : redacted.slice(0, maxLength).trimEnd();
}

function safeAgentUserAgent(value: unknown): string | null {
  const compacted = compactAdminChatText(value, 256);
  if (!compacted) return null;
  const safe = compacted.replace(/[^\x20-\x7E]/g, '').trim();
  return safe || null;
}

function compactAdminMcpProtocolVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const safe = value.replace(/[^\d.-]/g, '').trim();
  return safe ? safe.slice(0, 80) : null;
}

function safeAdminNavigationPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  if (!/^\/admin(?:\/[a-z0-9-]+)*$/.test(path)) return null;
  const segments = path.split('/').filter(Boolean);
  const resourceRoots = new Set([
    'attributes',
    'categories',
    'collections',
    'customers',
    'discounts',
    'inventory',
    'media',
    'orders',
    'pages',
    'products',
    'widgets',
  ]);
  if (segments.slice(1).some((segment) => /^\d+$/.test(segment))) return null;
  if (segments.length > 2 && resourceRoots.has(segments[1] ?? '')) return null;
  return path;
}

function compactNavigationEntry(value: unknown, sectionLabel: unknown): AdminChatNavigationEntry | null {
  if (!isJsonRecord(value)) return null;
  const path = safeAdminNavigationPath(value.path);
  const name = compactAdminChatText(value.name, 80);
  const section = compactAdminChatText(sectionLabel, 80);
  if (!path || !name || !section) return null;
  return { path, name, section };
}

function compactAdminNavigationEntries(body: unknown): AdminChatNavigationEntry[] {
  const response = isJsonRecord(body) ? body : null;
  const result = isJsonRecord(response?.result) ? response.result : null;
  if (!result || result.isError === true) return [];

  const structuredContent = isJsonRecord(result.structuredContent) ? result.structuredContent : null;
  const context = isJsonRecord(structuredContent?.adminNavigationContext)
    ? structuredContent.adminNavigationContext
    : null;
  const sections = Array.isArray(context?.sections) ? context.sections : [];
  const entries: AdminChatNavigationEntry[] = [];
  const seenPaths = new Set<string>();

  for (const section of sections) {
    if (!isJsonRecord(section) || !Array.isArray(section.pages)) continue;
    for (const page of section.pages) {
      const entry = compactNavigationEntry(page, section.label);
      if (!entry || seenPaths.has(entry.path)) continue;
      seenPaths.add(entry.path);
      entries.push(entry);
      if (entries.length >= ADMIN_CHAT_MAX_NAVIGATION_PAGES) return entries;
    }
  }

  return entries;
}

function createAgentMcpHeaders(c: ApiContext, session?: AdminAgentMcpSession | null): Headers {
  const headers = new Headers({
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });
  const cookie = c.req.header('cookie')?.trim();
  if (cookie) headers.set('Cookie', cookie);
  const userAgent = safeAgentUserAgent(c.req.header('user-agent'));
  if (userAgent) headers.set('User-Agent', userAgent);
  if (session?.sessionId) headers.set('Mcp-Session-Id', session.sessionId);
  if (session?.protocolVersion) headers.set('MCP-Protocol-Version', session.protocolVersion);
  return headers;
}

async function initializeAdminAgentMcp(c: ApiContext): Promise<AdminAgentMcpSession | null> {
  const agent = c.env.AGENT;
  if (!agent || typeof agent.fetch !== 'function') return null;

  try {
    const initializeResponse = await agent.fetch(ADMIN_AGENT_MCP_URL, {
      method: 'POST',
      headers: createAgentMcpHeaders(c),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'admin-chat-navigation-initialize',
        method: 'initialize',
        params: {
          protocolVersion: ADMIN_AGENT_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'scalius-api-admin-chat', version: '0.1.0' },
        },
      }),
      signal: c.req.raw.signal,
    });
    if (!initializeResponse.ok) return null;

    const initializeBody = await initializeResponse.json();
    const initializeResult = isJsonRecord(initializeBody) && isJsonRecord(initializeBody.result)
      ? initializeBody.result
      : null;
    const protocolVersion = compactAdminMcpProtocolVersion(initializeResult?.protocolVersion);
    const sessionId = compactAdminChatText(initializeResponse.headers.get('mcp-session-id'), 160);
    return {
      ...(protocolVersion ? { protocolVersion } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  } catch {
    return null;
  }
}

async function callAdminAgentTool(
  c: ApiContext,
  session: AdminAgentMcpSession | null,
  toolName: string,
  toolArguments: JsonRecord,
  id: string,
): Promise<unknown | null> {
  const agent = c.env.AGENT;
  if (!agent || typeof agent.fetch !== 'function' || !session) return null;

  try {
    const response = await agent.fetch(ADMIN_AGENT_MCP_URL, {
      method: 'POST',
      headers: createAgentMcpHeaders(c, session),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: toolArguments,
        },
      }),
      signal: c.req.raw.signal,
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

function readMcpStructuredContent(body: unknown): JsonRecord | null {
  const response = isJsonRecord(body) ? body : null;
  const result = isJsonRecord(response?.result) ? response.result : null;
  if (!result || result.isError === true) return null;
  return isJsonRecord(result.structuredContent) ? result.structuredContent : null;
}

async function getAdminChatNavigationEntries(
  c: ApiContext,
  session: AdminAgentMcpSession | null,
): Promise<AdminChatNavigationEntry[]> {
  const body = await callAdminAgentTool(
    c,
    session,
    ADMIN_NAVIGATION_CONTEXT_TOOL,
    {},
    'admin-chat-navigation-context',
  );
  return compactAdminNavigationEntries(body);
}

function hasProductCopyIntent(text: string): boolean {
  return (
    /\b(?:improve|rewrite|write|draft|generate|polish|optimi[sz]e|fix|make|update|better)\b/i.test(text) &&
    /\b(?:product|description|copy|content|seo|listing)\b/i.test(text)
  );
}

function extractProductTitleFromDashboardContext(messages: Array<z.infer<typeof chatMessageSchema>>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content ?? '';
    if (!content.includes('Current safe dashboard context')) continue;
    const match = content.match(/\btitle:\s*([^|,\n]+)/i);
    const title = compactAdminChatText(match?.[1], 120);
    if (title) return title;
  }
  return null;
}

function extractProductIdFromDashboardContext(messages: Array<z.infer<typeof chatMessageSchema>>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content ?? '';
    if (!content.includes('Current safe dashboard context')) continue;
    const match = content.match(/\bRoute:\s*\/admin\/products\/([A-Za-z0-9_-]{1,160})\b/i);
    const id = compactAdminChatText(match?.[1], 160);
    if (id) return id;
  }
  return null;
}

function extractProductCopySearchQuery(messages: Array<z.infer<typeof chatMessageSchema>>): string | null {
  const latest = latestUserChatText(messages);
  if (!hasProductCopyIntent(latest)) return null;

  const cleaned = compactAdminChatText(
    latest
      .replace(/['’]s\b/gi, ' ')
      .replace(/[?!.,"“”]+/g, ' ')
      .replace(
        /\b(?:can|could|you|please|pls|improve|rewrite|write|draft|generate|polish|optimi[sz]e|fix|make|update|better|our|this|current|the|a|an|for|of|product|products|description|copy|content|seo|listing)\b/gi,
        ' ',
      ),
    120,
  );
  if (cleaned && cleaned.length >= 2) return cleaned;
  return extractProductTitleFromDashboardContext(messages);
}

function readAdminProductSearchCandidates(body: unknown): JsonRecord[] {
  const structuredContent = readMcpStructuredContent(body);
  const productSearch = isJsonRecord(structuredContent?.adminProductSearch)
    ? structuredContent.adminProductSearch
    : null;
  const products = Array.isArray(productSearch?.products) ? productSearch.products : [];
  return products.filter(isJsonRecord);
}

function stripHtmlForAdminChat(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function readAdminProductDescriptionText(product: JsonRecord): string | null {
  const description =
    product.descriptionText ??
    product.currentDescription ??
    product.plainDescription ??
    product.descriptionExcerpt;
  if (typeof description === 'string') return description;

  if (isJsonRecord(product.description)) {
    const content = product.description.content ?? product.description.excerpt;
    return typeof content === 'string' ? content : null;
  }

  return typeof product.description === 'string' ? product.description : null;
}

function compactAdminProductCopyContext(body: unknown): AdminChatProductCopyContext | null {
  const structuredContent = readMcpStructuredContent(body);
  const copyContext = isJsonRecord(structuredContent?.adminProductCopyContext)
    ? structuredContent.adminProductCopyContext
    : null;
  const product = isJsonRecord(copyContext?.product) ? copyContext.product : copyContext;
  if (!product) return null;

  const id = compactAdminChatText(product.id, 120);
  const name = compactAdminChatText(product.name ?? product.title, 160);
  if (!id || !name) return null;

  const rawDescription = readAdminProductDescriptionText(product);
  const descriptionText = compactAdminChatText(
    typeof rawDescription === 'string' ? stripHtmlForAdminChat(rawDescription) : null,
    ADMIN_CHAT_MAX_PRODUCT_DESCRIPTION_CHARS,
  );

  return {
    id,
    name,
    ...(compactAdminChatText(product.slug, 120) ? { slug: compactAdminChatText(product.slug, 120)! } : {}),
    ...(compactAdminChatText(product.route ?? product.path, 180) ? { route: compactAdminChatText(product.route ?? product.path, 180)! } : {}),
    ...(typeof product.isActive === 'boolean' ? { status: product.isActive ? 'active' : 'draft' } : {}),
    ...(compactAdminChatText(product.status, 80) ? { status: compactAdminChatText(product.status, 80)! } : {}),
    ...(compactAdminChatText(product.categoryName, 120) ? { categoryName: compactAdminChatText(product.categoryName, 120)! } : {}),
    ...(descriptionText ? { descriptionText } : {}),
  };
}

async function getAdminChatProductCopyContext(
  c: ApiContext,
  session: AdminAgentMcpSession | null,
  messages: Array<z.infer<typeof chatMessageSchema>>,
): Promise<AdminChatProductCopyContext | null> {
  if (!hasProductCopyIntent(latestUserChatText(messages))) return null;

  const currentProductId = extractProductIdFromDashboardContext(messages);
  if (currentProductId) {
    const copyBody = await callAdminAgentTool(
      c,
      session,
      ADMIN_PRODUCT_COPY_CONTEXT_TOOL,
      { id: currentProductId },
      'admin-chat-product-copy-context',
    );
    const context = compactAdminProductCopyContext(copyBody);
    if (context) return context;
  }

  const query = extractProductCopySearchQuery(messages);
  if (!query) return null;

  const searchBody = await callAdminAgentTool(
    c,
    session,
    ADMIN_PRODUCT_SEARCH_TOOL,
    { query, limit: 2, page: 1 },
    'admin-chat-product-search',
  );
  const [candidate] = readAdminProductSearchCandidates(searchBody);
  const id = compactAdminChatText(candidate?.id, 120);
  if (!id) return null;

  const copyBody = await callAdminAgentTool(
    c,
    session,
    ADMIN_PRODUCT_COPY_CONTEXT_TOOL,
    { id },
    'admin-chat-product-copy-context',
  );
  return compactAdminProductCopyContext(copyBody);
}

function formatAdminChatProductCopyContext(context: AdminChatProductCopyContext | null): string | null {
  if (!context) return null;
  const lines = [
    'Read-only product copy context from verified admin read tools:',
    `Product: ${context.name} (${context.id})`,
    context.status ? `Status: ${context.status}` : null,
    context.categoryName ? `Category: ${context.categoryName}` : null,
    context.route ?? context.slug ? `Buyer route: ${context.route ?? `/products/${context.slug}`}` : null,
    context.descriptionText ? `Current description:\n${context.descriptionText}` : 'Current description: not provided',
    'Use this context only to draft suggested copy. Do not say the description was saved or changed.',
  ].filter(Boolean);

  return compactAdminChatText(
    lines.join('\n'),
    ADMIN_CHAT_MAX_PRODUCT_COPY_CONTEXT_CHARS,
  );
}

function formatAdminChatNavigationContext(entries: AdminChatNavigationEntry[]): string | null {
  if (entries.length === 0) return null;
  const lines = entries.map((entry) => `- ${entry.section} > ${entry.name}: ${entry.path}`);
  return compactAdminChatText(
    [
      'Allowed dashboard destinations from the current admin session:',
      ...lines,
      'Only mention these destinations when relevant. Do not invent dashboard paths.',
    ].join('\n'),
    ADMIN_CHAT_MAX_NAVIGATION_CONTEXT_CHARS,
  );
}

function formatAdminChatNavigationActionContext(actions: AdminChatNavigateAction[]): string | null {
  if (actions.length === 0) return null;
  const lines = actions.map((action) => `- ${action.label}: ${action.path}`);
  return compactAdminChatText(
    [
      'Click-confirmed navigation action that will be shown beside this answer:',
      ...lines,
      'Tell the merchant they can use the visible action button. Do not say you cannot navigate, do not invent a different path, and do not imply the page was opened automatically.',
    ].join('\n'),
    500,
  );
}

function latestUserChatText(messages: Array<z.infer<typeof chatMessageSchema>>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return message.content;
  }
  return '';
}

function normalizeNavigationMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\/admin(?:\/[a-z0-9-]+)*/g, (path) => ` ${path} `)
    .replace(/[^a-z0-9/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function navigationTokens(value: string): string[] {
  return normalizeNavigationMatchText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

function tokenVariants(token: string): string[] {
  if (token.length > 3 && token.endsWith('s')) return [token, token.slice(0, -1)];
  return [token];
}

function textContainsPhrase(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalizeNavigationMatchText(needle);
  if (!normalizedNeedle) return false;
  return ` ${haystack} `.includes(` ${normalizedNeedle} `);
}

function textContainsTokens(haystackTokens: Set<string>, needle: string): boolean {
  const tokens = navigationTokens(needle);
  if (tokens.length === 0) return false;
  return tokens.every((token) => tokenVariants(token).some((variant) => haystackTokens.has(variant)));
}

function hasNavigationIntent(text: string): boolean {
  return /\b(?:go|open|navigate|visit|show|view|take|send|jump|link|page|screen|section|where|manage)\b/i.test(text);
}

function createAdminChatNavigationActions(
  entries: AdminChatNavigationEntry[],
  messages: Array<z.infer<typeof chatMessageSchema>>,
): AdminChatNavigateAction[] {
  if (entries.length === 0) return [];

  const latestText = latestUserChatText(messages);
  const normalizedText = normalizeNavigationMatchText(latestText);
  if (!normalizedText) return [];

  const tokens = new Set(navigationTokens(latestText).flatMap(tokenVariants));
  const intent = hasNavigationIntent(latestText);
  const candidates = entries
    .map((entry, index) => {
      const exactPath = latestText.toLowerCase().includes(entry.path.toLowerCase());
      let score = exactPath ? 100 : 0;
      if (textContainsPhrase(normalizedText, entry.name)) score += 50;
      else if (textContainsTokens(tokens, entry.name)) score += 35;
      if (textContainsPhrase(normalizedText, entry.section)) score += 10;
      else if (textContainsTokens(tokens, entry.section)) score += 5;
      return { entry, exactPath, index, score };
    })
    .filter((candidate) => candidate.score > 0 && (intent || candidate.exactPath))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return candidates.slice(0, ADMIN_CHAT_MAX_NAVIGATION_ACTIONS).map(({ entry }) => ({
    type: 'navigate' as const,
    path: entry.path,
    label: `Open ${entry.name}`,
  }));
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

export async function getLanguageModel(
  provider: WidgetAiProvider,
  modelId: string,
  settings: WidgetAiRuntimeSettings,
  env: Env,
): Promise<LanguageModel> {
  if (!providerHasCredentials(settings, provider)) {
    throw new ValidationError(ERROR_MESSAGES.apiKeyMissing);
  }

  if (provider === 'openrouter') {
    const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
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
    const { createOpenAI } = await import('@ai-sdk/openai');
    const openai = createOpenAI({
      apiKey: settings.apiKeys.openai,
      baseURL: settings.providers.openai.baseUrl,
    });
    return openai(modelId);
  }

  if (provider === 'gemini') {
    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    const google = createGoogleGenerativeAI({
      apiKey: settings.apiKeys.gemini,
      baseURL: settings.providers.gemini.baseUrl,
    });
    return google(modelId);
  }

  const { createWorkersAI } = await import('workers-ai-provider');
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

function isCloudflareGeminiModel(modelId: string): boolean {
  return /^google\/gemini-/i.test(modelId.trim());
}

function modelMessageRoleLabel(role: ModelMessage['role']): string {
  if (role === 'assistant') return 'Assistant';
  if (role === 'system') return 'System';
  return 'Merchant';
}

function modelMessageToGeminiText(message: ModelMessage): string {
  const text = modelMessageContentText(message.content);
  return text ? `${modelMessageRoleLabel(message.role)}:\n${text}` : '';
}

function buildCloudflareGeminiChatInput(
  messages: ModelMessage[],
  options: { temperature: number; maxOutputTokens: number },
): Record<string, unknown> {
  const systemInstruction = messages
    .filter((message) => message.role === 'system')
    .map((message) => modelMessageContentText(message.content))
    .filter(Boolean)
    .join('\n\n');

  const conversationText = messages
    .filter((message) => message.role !== 'system')
    .map(modelMessageToGeminiText)
    .filter(Boolean)
    .join('\n\n');

  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: conversationText || 'Continue the admin assistant conversation.' }],
      },
    ],
    generationConfig: {
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
    },
    ...(systemInstruction
      ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
      : {}),
  };
}

function readCloudflareGeminiText(response: unknown): string {
  if (!response || typeof response !== 'object') return '';
  const candidates = (response as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return '';

  return candidates
    .flatMap((candidate) => {
      const parts = (candidate as { content?: { parts?: unknown } })?.content?.parts;
      if (!Array.isArray(parts)) return [];
      return parts
        .map((part) => (part && typeof part === 'object' ? (part as { text?: unknown }).text : undefined))
        .filter((text): text is string => typeof text === 'string' && text.trim().length > 0);
    })
    .join('\n')
    .trim();
}

function readCloudflareGeminiUsage(response: unknown): GenerationUsage {
  const usage = response && typeof response === 'object'
    ? (response as { usageMetadata?: Record<string, unknown> }).usageMetadata
    : undefined;
  return {
    inputTokens: typeof usage?.promptTokenCount === 'number' ? usage.promptTokenCount : undefined,
    outputTokens: typeof usage?.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : undefined,
    totalTokens: typeof usage?.totalTokenCount === 'number' ? usage.totalTokenCount : undefined,
  };
}

function safeCloudflareAiErrorDetail(error: unknown): string | null {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const sanitized = raw
    .replace(/\b(?:Bearer|token|secret|key)\s+[A-Za-z0-9._~+/-]+=*/gi, '[redacted-token]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted-token]')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized ? sanitized.slice(0, 240) : null;
}

async function runCloudflareGeminiChat(
  ai: Ai,
  modelId: string,
  messages: ModelMessage[],
  options: { temperature: number; maxOutputTokens: number },
): Promise<AdminChatGenerationResult> {
  try {
    const response = await ai.run(
      modelId as never,
      buildCloudflareGeminiChatInput(messages, options) as never,
    );
    const text = readCloudflareGeminiText(response);
    if (!text) {
      throw new ServiceUnavailableError(
        `Cloudflare AI model "${modelId}" did not return a readable text response.`,
      );
    }
    return {
      text,
      usage: readCloudflareGeminiUsage(response),
    };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) throw error;
    const detail = safeCloudflareAiErrorDetail(error);
    throw new ServiceUnavailableError(
      `Cloudflare AI model "${modelId}" failed.${detail ? ` ${detail}` : ''}`,
    );
  }
}

async function generateAdminChatCompletion(options: {
  provider: WidgetAiProvider;
  modelId: string;
  settings: WidgetAiRuntimeSettings;
  env: Env;
  messages: ModelMessage[];
  temperature: number;
  maxOutputTokens: number;
  abortSignal: AbortSignal;
}): Promise<AdminChatGenerationResult> {
  if (options.provider === 'cloudflare' && options.env.AI && isCloudflareGeminiModel(options.modelId)) {
    return runCloudflareGeminiChat(options.env.AI as Ai, options.modelId, options.messages, {
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
    });
  }

  const model = await getLanguageModel(options.provider, options.modelId, options.settings, options.env);
  const { generateText } = await import('ai');
  const result = await generateText({
    model,
    messages: options.messages,
    allowSystemInMessages: true,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    timeout: { totalMs: getTimeout('planning') },
    maxRetries: 1,
    abortSignal: options.abortSignal,
  });

  return {
    text: result.text.trim(),
    usage: usageFromResult(result),
  };
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
  if (isAiNoObjectGeneratedError(error)) {
    return {
      type: 'NoObjectGeneratedError',
      cause: error.cause instanceof Error ? error.cause.message : String(error.cause ?? ''),
      finishReason: error.finishReason,
      usage: error.usage,
      response: error.response,
      textSample: error.text?.slice(0, 800),
    };
  }

  if (isAiUnsupportedFunctionalityError(error)) {
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

function hasAiErrorMarker(error: unknown, marker: string): boolean {
  return Boolean(error && typeof error === 'object' && (error as Record<symbol, unknown>)[Symbol.for(marker)] === true);
}

function isAiNoObjectGeneratedError(error: unknown): error is {
  cause?: unknown;
  finishReason?: unknown;
  usage?: unknown;
  response?: unknown;
  text?: string;
} {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (hasAiErrorMarker(error, AI_NO_OBJECT_GENERATED_MARKER) ||
        (error as { name?: unknown }).name === 'AI_NoObjectGeneratedError' ||
        (error as { name?: unknown }).name === 'NoObjectGeneratedError' ||
        (error as { constructor?: { name?: unknown } }).constructor?.name === 'NoObjectGeneratedError'),
  );
}

function isAiUnsupportedFunctionalityError(error: unknown): error is {
  functionality?: unknown;
  message: string;
} {
  return Boolean(
    error instanceof Error &&
      (hasAiErrorMarker(error, AI_UNSUPPORTED_FUNCTIONALITY_MARKER) ||
        error.name === 'AI_UnsupportedFunctionalityError' ||
        error.name === 'UnsupportedFunctionalityError' ||
        (error as { constructor?: { name?: unknown } }).constructor?.name === 'UnsupportedFunctionalityError'),
  );
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
  const { generateText } = await import('ai');
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
    const { generateText, Output } = await import('ai');
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

export async function streamWidgetContent(
  options: GenerateTextOptions,
  capabilities: { supportsStructuredOutput: boolean },
  promptType: WidgetPromptType = 'widget',
): Promise<{
  textStream: AsyncIterable<string>;
  finalize: (rawText: string) => Promise<WidgetGenerationResult>;
}> {
  const { streamText } = await import('ai');
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

      const text = await finalizeStreamedWidgetContent(completeRawText, options, capabilities, promptType);
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

async function generateStagedPlan(
  options: GenerateTextOptions,
  capabilities: { supportsStructuredOutput: boolean },
): Promise<WidgetGenerationResult> {
  if (capabilities.supportsStructuredOutput) {
    const { generateText, Output } = await import('ai');
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
  const model = await getLanguageModel(provider, modelId, settings, c.env);
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
    const result = await streamWidgetContent(generationOptions, capabilities, promptType);
    return openAiCompatibleStream(result.textStream, {
      finalize: async (rawText) => (await result.finalize(rawText)).text,
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
  const model = await getLanguageModel(provider, modelId, settings, c.env);
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

const chatRoute = createRoute({
  method: 'post',
  path: '/chat',
  tags: ['Admin - AI'],
  summary: 'Chat with the read-only admin assistant',
  request: {
    body: { content: { 'application/json': { schema: chatSchema } } },
  },
  responses: {
    200: {
      description: 'Admin chat response',
      content: {
        'application/json': {
          schema: successEnvelope(
            z.object({
              profile: z.literal('adminChat'),
              provider: providerEnum,
              model: z.string(),
              message: z.object({
                role: z.literal('assistant'),
                content: z.string(),
              }),
              usage: z
                .object({
                  inputTokens: z.number().optional(),
                  outputTokens: z.number().optional(),
                  totalTokens: z.number().optional(),
                })
                .optional(),
              actions: z
                .array(
                  z.object({
                    type: z.literal('navigate'),
                    path: z.string(),
                    label: z.string(),
                  }),
                )
                .optional(),
            }),
          ),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(chatRoute, async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  await enforceAiRateLimit(c);
  const payload = c.req.valid('json');
  validateMessagePayload(payload.messages);
  validateAdminChatPayload(payload.messages);

  const settings = await runtimeSettings(c);
  const profile = resolveAiModelProfile(settings, 'adminChat');
  const agentSession = await initializeAdminAgentMcp(c);
  const navigationEntries = await getAdminChatNavigationEntries(c, agentSession);
  const navigationContext = formatAdminChatNavigationContext(navigationEntries);
  const navigationActions = createAdminChatNavigationActions(navigationEntries, payload.messages);
  const navigationActionContext = formatAdminChatNavigationActionContext(navigationActions);
  const productCopyContext = formatAdminChatProductCopyContext(
    await getAdminChatProductCopyContext(c, agentSession, payload.messages),
  );
  const messages: ModelMessage[] = [
    { role: 'system', content: ADMIN_CHAT_SYSTEM_PROMPT },
    ...(navigationContext ? [{ role: 'system' as const, content: navigationContext }] : []),
    ...(navigationActionContext ? [{ role: 'system' as const, content: navigationActionContext }] : []),
    ...(productCopyContext ? [{ role: 'system' as const, content: productCopyContext }] : []),
    ...normalizeMessages(payload.messages),
  ];
  const result = await generateAdminChatCompletion({
    provider: profile.provider,
    modelId: profile.model,
    settings,
    env: c.env,
    messages,
    temperature: Math.min(settings.generation.planningTemperature, 0.3),
    maxOutputTokens: Math.min(settings.generation.maxOutputTokens, ADMIN_CHAT_MAX_OUTPUT_TOKENS),
    abortSignal: c.req.raw.signal,
  });

  return ok(c, {
    profile: 'adminChat' as const,
    provider: profile.provider,
    model: profile.model,
    message: {
      role: 'assistant' as const,
      content: result.text,
    },
    usage: result.usage,
    ...(navigationActions.length > 0 ? { actions: navigationActions } : {}),
  });
});

export { app as adminAiRoutes };
