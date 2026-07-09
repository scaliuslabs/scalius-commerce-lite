import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  containsAssistantSensitiveText,
  redactAssistantSensitiveText,
} from "@scalius/shared/assistant-redaction";
import {
  STOREFRONT_CHAT_ANONYMOUS_RATE_LIMIT_BUCKET,
  STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER,
  storefrontChatRateLimitBucketFromIp,
} from "@scalius/shared/storefront-chat-boundary";
import { consumeAssistantRateLimit } from "@scalius/core/modules/assistant";
import { ServiceUnavailableError, ValidationError } from "../utils/api-error";

export const STOREFRONT_AGENT_MCP_URL = "http://storefront-agent.internal/mcp";
export const STOREFRONT_CHAT_INTERNAL_HOSTNAME = "api.internal";
export const STOREFRONT_CHAT_INTERNAL_PATH = "/api/v1/storefront/chat";
export const STOREFRONT_AGENT_MCP_PROTOCOL_VERSION = "2025-11-25";
export const STOREFRONT_CHAT_RATE_LIMIT = {
  scope: "storefront.chat",
  limit: 20,
  windowSeconds: 60,
} as const;
export const STOREFRONT_CHAT_MAX_MESSAGES = 16;
export const STOREFRONT_CHAT_MAX_TEXT_CHARS = 32_000;
export const STOREFRONT_CHAT_MAX_MESSAGE_CHARS = 8_000;
export const STOREFRONT_CHAT_MAX_OUTPUT_TOKENS = 1_200;
export const STOREFRONT_CHAT_MAX_CONTEXT_CHARS = 8_000;
export const STOREFRONT_CHAT_MAX_TOOL_CONTEXT_CHARS = 2_200;
export const STOREFRONT_CHAT_MAX_NAVIGATION_ACTIONS = 1;
export const STOREFRONT_CHAT_MAX_CART_LINES = 10;
export const STOREFRONT_CHAT_MAX_CART_PRICE = 10_000_000;

export const STOREFRONT_CHAT_PUBLIC_TOOLS = [
  "catalog_search",
  "catalog_lookup",
  "catalog_product",
  "catalog_profile",
  "catalog_categories",
  "storefront_discovery_policy",
  "cart_validate",
] as const;

export type StorefrontChatPublicTool =
  (typeof STOREFRONT_CHAT_PUBLIC_TOOLS)[number];
export type JsonRecord = Record<string, unknown>;
export type ApiContext = Context<{ Bindings: Env }>;
export type GenerationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};
export type StorefrontAgentMcpSession = {
  protocolVersion?: string;
  sessionId?: string;
};
export type StorefrontMcpContext = {
  tool: StorefrontChatPublicTool;
  structuredContent: JsonRecord;
  text: string;
};
export type StorefrontNavigateAction = {
  type: "navigate";
  path: string;
  label: string;
};
export type StorefrontChatAssistantText = {
  text: string;
  usedFallback: boolean;
};

export const storefrontChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(STOREFRONT_CHAT_MAX_MESSAGE_CHARS),
});

export const storefrontChatPageKindSchema = z.enum([
  "home",
  "product",
  "category",
  "collection",
  "search",
  "cart",
  "checkout",
  "account",
  "page",
  "unknown",
]);

export const storefrontChatCartLineOptionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
});

export const storefrontChatCartLineSchema = z.object({
  lineKey: z.string().trim().min(1).max(512).optional(),
  productId: z.string().trim().min(1).max(180),
  variantId: z.string().trim().min(1).max(180).optional(),
  slug: z.string().trim().min(1).max(160).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  quantity: z.number().int().min(1).max(99),
  unitPrice: z.number().min(0).max(STOREFRONT_CHAT_MAX_CART_PRICE),
  lineTotal: z.number().min(0).max(STOREFRONT_CHAT_MAX_CART_PRICE).optional(),
  options: z.array(storefrontChatCartLineOptionSchema).max(4).optional(),
});

export const storefrontChatSelectedOptionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
});

export const storefrontChatVisibleFilterSchema = z.object({
  key: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(160),
});

export const storefrontChatListingSurfaceFields = {
  visibleProductIds: z.array(z.string().trim().min(1).max(120)).max(40),
  visibleFilters: z.array(storefrontChatVisibleFilterSchema).max(20),
  totalResults: z.number().int().min(0).max(99_999),
  page: z.number().int().min(1).max(100_000),
  sortBy: z.string().trim().min(1).max(80).optional(),
};

export const storefrontChatSurfaceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("product"),
    productId: z.string().trim().min(1).max(120),
    slug: z.string().trim().min(1).max(120).optional(),
    selectedVariantId: z.string().trim().min(1).max(120).optional(),
    selectedOptions: z.array(storefrontChatSelectedOptionSchema).max(2),
    displayedPrice: z.number().min(0).max(999_999_999),
    availability: z.enum([
      "in_stock",
      "out_of_stock",
      "selection_required",
      "unavailable",
    ]),
  }),
  z.object({
    kind: z.literal("category"),
    categoryId: z.string().trim().min(1).max(120),
    slug: z.string().trim().min(1).max(120),
    ...storefrontChatListingSurfaceFields,
  }),
  z.object({
    kind: z.literal("collection"),
    collectionId: z.string().trim().min(1).max(120),
    ...storefrontChatListingSurfaceFields,
  }),
  z.object({
    kind: z.literal("search"),
    query: z.string().trim().max(180),
    ...storefrontChatListingSurfaceFields,
  }),
  z.object({
    kind: z.literal("cart"),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    fingerprint: z.string().regex(/^cart_v1_[a-f0-9]{8}$/),
    exactLineKeys: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(512)
          .regex(/^line:v2:/),
      )
      .max(20),
    totalItems: z.number().int().min(0).max(99_999),
    lineCount: z.number().int().min(0).max(1_000),
  }),
]);

export const storefrontChatPageContextSchema = z
  .object({
    version: z.literal(1).optional(),
    contextVersion: z.literal(2).optional(),
    source: z.literal("storefront").optional(),
    page: z
      .object({
        path: z.string().trim().max(512).optional(),
        route: z.string().trim().max(512).nullable().optional(),
        canonicalUrl: z.string().trim().max(2048).nullable().optional(),
        title: z.string().trim().max(180).optional(),
        kind: storefrontChatPageKindSchema.optional(),
      })
      .passthrough()
      .optional(),
    cart: z
      .object({
        totalItems: z.number().int().min(0).max(99_999).optional(),
        subtotalAmount: z.number().min(0).max(999_999_999).optional(),
        lineCount: z.number().int().min(0).max(1_000).optional(),
        lines: z.array(storefrontChatCartLineSchema).max(20).optional(),
        hasDiscount: z.boolean().optional(),
        truncated: z.boolean().optional(),
        revision: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
        fingerprint: z
          .string()
          .regex(/^cart_v1_[a-f0-9]{8}$/)
          .optional(),
      })
      .passthrough()
      .optional(),
    surface: storefrontChatSurfaceSchema.nullable().optional(),
  })
  .passthrough();

export const storefrontChatSchema = z.object({
  messages: z
    .array(storefrontChatMessageSchema)
    .min(1)
    .max(STOREFRONT_CHAT_MAX_MESSAGES),
  pageContext: storefrontChatPageContextSchema.nullable().optional(),
});

export type StorefrontChatPayload = z.infer<typeof storefrontChatSchema>;
export type StorefrontChatMessage = z.infer<typeof storefrontChatMessageSchema>;
export type StorefrontChatPageContext = z.infer<
  typeof storefrontChatSchema
>["pageContext"];
export type StorefrontChatCartLine = z.infer<
  typeof storefrontChatCartLineSchema
>;
export type StorefrontChatSurface = z.infer<typeof storefrontChatSurfaceSchema>;

export const RAW_PATH_TRAVERSAL_PATTERN = /(^|\/)\.{1,2}(?:\/|$|[?#])/;
export const ENCODED_UNSAFE_PATH_PATTERN = /%(?:2e|2f|5c)/i;
export const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
export const SAFE_QUERY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const SENSITIVE_QUERY_NAME_PATTERN =
  /(?:auth|bearer|credential|customer|email|jwt|key|mobile|otp|pass|password|passwd|phone|proof|receipt|secret|session|sig|signature|token)/i;
export const TOKEN_LIKE_VALUE_PATTERN =
  /(?:\bBearer\s+|(?:chk|cst|otp|tok|token|session|secret|sk|pk)_[A-Za-z0-9_-]{6,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?|[A-Fa-f0-9]{32,})/i;
export const NAVIGATION_TARGET_PATTERN =
  /(?:https?:\/\/[^\s<>()]+|\/(?:[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)*)(?:\?[A-Za-z0-9._~%=&-]*)?)/gi;
export const FORBIDDEN_CONTEXT_KEY_PATTERN =
  /(?:admin|authorization|bearer|checkout|cookie|credential|customer|email|order|password|payment|phone|proof|provider|raw|receipt|recovery|secret|session|signature|token|otp)/i;
export const BLOCKED_BUYER_PATH_SEGMENTS = new Set([
  "account",
  "admin",
  "api",
  "auth",
  "buy",
  "checkout",
  "order",
  "order-success",
  "orders",
  "payment",
  "payment-recovery",
  "private",
  "receipt",
  "receipts",
  "recovery",
  "status",
]);
export const RESERVED_CMS_PAGE_SLUGS = new Set([
  ...BLOCKED_BUYER_PATH_SEGMENTS,
  "cart",
  "categories",
  "collections",
  "products",
  "search",
]);
export const SENSITIVE_STOREFRONT_PAGE_KINDS = new Set(["account", "checkout"]);

export const STOREFRONT_CHAT_SYSTEM_PROMPT = [
  "You are the Scalius Commerce storefront catalog assistant for public buyers.",
  "Use only the verified public catalog, discovery, page, and cart-validation context in this request plus the conversation. If context is missing, say you cannot verify it.",
  "This endpoint cannot mutate carts, start checkout, access accounts, inspect orders, recover payments, read customer sessions, take payment, contact support, or use admin APIs.",
  "Never ask for or repeat phone numbers, email addresses, OTPs, credentials, payment proofs, receipt proofs, session tokens, or order identifiers.",
  "For checkout, account, order, payment, recovery, admin, or support requests, refuse briefly and point the buyer to visible storefront controls without inventing private status.",
  "If a safe click-confirmed navigation action is provided, mention the visible button without claiming navigation happened automatically.",
  "Keep answers concise, practical, and clear about uncertainty.",
].join("\n");

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function isInternalStorefrontChatRequest(request: Request): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }

  if (
    url.protocol !== "http:" ||
    url.pathname !== STOREFRONT_CHAT_INTERNAL_PATH ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return false;
  }
  if (url.hostname === STOREFRONT_CHAT_INTERNAL_HOSTNAME)
    return url.port === "";
  return isLoopbackHostname(url.hostname);
}

export function isExactStorefrontChatServiceRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    return (
      url.protocol === "http:" &&
      url.hostname === STOREFRONT_CHAT_INTERNAL_HOSTNAME &&
      url.port === "" &&
      url.pathname === STOREFRONT_CHAT_INTERNAL_PATH &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function replaceControlCharacters(value: string): string {
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : char;
  }).join("");
}

export function compactStorefrontChatText(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const compacted = replaceControlCharacters(value).replace(/\s+/g, " ").trim();
  if (!compacted) return null;
  const redacted = redactAssistantSensitiveText(compacted);
  return redacted.length <= maxLength
    ? redacted
    : redacted.slice(0, maxLength).trimEnd();
}

export function containsEncodedAssistantSensitiveText(value: string): boolean {
  if (containsAssistantSensitiveText(value)) return true;
  try {
    return containsAssistantSensitiveText(decodeURIComponent(value));
  } catch {
    return true;
  }
}

export function safeSurfaceText(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const compacted = replaceControlCharacters(value).replace(/\s+/g, " ").trim();
  if (
    !compacted ||
    compacted.length > maxLength ||
    containsEncodedAssistantSensitiveText(compacted)
  ) {
    return null;
  }
  return compacted;
}

export function safeSurfaceIdentifier(value: unknown): string | null {
  const identifier = safeSurfaceText(value, 120);
  return identifier && SAFE_PATH_SEGMENT_PATTERN.test(identifier)
    ? identifier
    : null;
}

export function sanitizeStorefrontListingSurface(
  surface: Extract<
    StorefrontChatSurface,
    { kind: "category" | "collection" | "search" }
  >,
) {
  const visibleProductIds = surface.visibleProductIds
    .map(safeSurfaceIdentifier)
    .filter((id): id is string => Boolean(id))
    .slice(0, 40);
  const visibleFilters = surface.visibleFilters
    .map((filter) => {
      const key = safeSurfaceText(filter.key, 80);
      const value = safeSurfaceText(filter.value, 160);
      if (!key || !value || FORBIDDEN_CONTEXT_KEY_PATTERN.test(key))
        return null;
      return { key, value };
    })
    .filter((filter): filter is { key: string; value: string } =>
      Boolean(filter),
    )
    .slice(0, 20);
  const sortBy = safeSurfaceText(surface.sortBy, 80);
  return {
    visibleProductIds,
    visibleFilters,
    totalResults: surface.totalResults,
    page: surface.page,
    ...(sortBy ? { sortBy } : {}),
  };
}

export function sanitizeStorefrontChatSurface(
  surface: StorefrontChatSurface | null | undefined,
  pageKind: z.infer<typeof storefrontChatPageKindSchema> | undefined,
): StorefrontChatSurface | null {
  if (!surface || surface.kind !== pageKind) return null;

  if (surface.kind === "product") {
    const productId = safeSurfaceIdentifier(surface.productId);
    if (!productId) return null;
    const slug = safeSurfaceIdentifier(surface.slug);
    const selectedVariantId = safeSurfaceIdentifier(surface.selectedVariantId);
    const selectedOptions = surface.selectedOptions
      .map((option) => {
        const name = safeSurfaceText(option.name, 80);
        const label = safeSurfaceText(option.label, 80);
        if (!name || !label || FORBIDDEN_CONTEXT_KEY_PATTERN.test(name))
          return null;
        return { name, label };
      })
      .filter((option): option is { name: string; label: string } =>
        Boolean(option),
      )
      .slice(0, 2);
    return {
      kind: "product",
      productId,
      ...(slug ? { slug } : {}),
      ...(selectedVariantId ? { selectedVariantId } : {}),
      selectedOptions,
      displayedPrice: surface.displayedPrice,
      availability: surface.availability,
    };
  }

  if (surface.kind === "category") {
    const categoryId = safeSurfaceIdentifier(surface.categoryId);
    const slug = safeSurfaceIdentifier(surface.slug);
    if (!categoryId || !slug) return null;
    return {
      kind: "category",
      categoryId,
      slug,
      ...sanitizeStorefrontListingSurface(surface),
    };
  }

  if (surface.kind === "collection") {
    const collectionId = safeSurfaceIdentifier(surface.collectionId);
    if (!collectionId) return null;
    return {
      kind: "collection",
      collectionId,
      ...sanitizeStorefrontListingSurface(surface),
    };
  }

  if (surface.kind === "search") {
    return {
      kind: "search",
      query: safeSurfaceText(surface.query, 180) ?? "",
      ...sanitizeStorefrontListingSurface(surface),
    };
  }

  const exactLineKeys = surface.exactLineKeys
    .map((key) => safeSurfaceText(key, 512))
    .filter((key): key is string => Boolean(key?.startsWith("line:v2:")))
    .slice(0, 20);
  return {
    kind: "cart",
    revision: surface.revision,
    fingerprint: surface.fingerprint,
    exactLineKeys,
    totalItems: surface.totalItems,
    lineCount: surface.lineCount,
  };
}

export function sanitizeStorefrontChatCartLine(
  line: StorefrontChatCartLine,
): StorefrontChatCartLine | null {
  const productId = compactStorefrontChatText(line.productId, 180);
  const variantId = compactStorefrontChatText(line.variantId, 180);
  if (!productId || !variantId || variantId === "default") return null;

  const slug = compactStorefrontChatText(line.slug, 160);
  const name = compactStorefrontChatText(line.name, 160);
  const lineKey = safeSurfaceText(line.lineKey, 512);
  const options = line.options
    ?.map((option) => {
      const optionName = compactStorefrontChatText(option.name, 80);
      const label = compactStorefrontChatText(option.label, 120);
      return optionName && label ? { name: optionName, label } : null;
    })
    .filter(
      (option): option is { name: string; label: string } => option !== null,
    )
    .slice(0, 4);

  return {
    ...(lineKey?.startsWith("line:v2:") ? { lineKey } : {}),
    productId,
    variantId,
    ...(slug ? { slug } : {}),
    ...(name ? { name } : {}),
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    ...(line.lineTotal !== undefined ? { lineTotal: line.lineTotal } : {}),
    ...(options?.length ? { options } : {}),
  };
}

export function inferSensitiveStorefrontPageKind(
  page: NonNullable<StorefrontChatPageContext>["page"],
): "account" | "checkout" | null {
  if (!page) return null;
  if (page.kind && SENSITIVE_STOREFRONT_PAGE_KINDS.has(page.kind)) {
    return page.kind as "account" | "checkout";
  }

  const paths = [page.path, page.route, page.canonicalUrl].flatMap((value) => {
    if (typeof value !== "string") return [];
    try {
      return [
        new URL(value, "https://storefront.invalid").pathname.toLowerCase(),
      ];
    } catch {
      return [];
    }
  });
  if (
    paths.some((path) => path === "/account" || path.startsWith("/account/"))
  ) {
    return "account";
  }
  if (
    paths.some(
      (path) =>
        path === "/checkout" ||
        path === "/order-success" ||
        path === "/payment-recovery" ||
        path.startsWith("/buy/"),
    )
  ) {
    return "checkout";
  }
  return null;
}

export function sanitizeStorefrontChatPageContext(
  pageContext: StorefrontChatPageContext,
): StorefrontChatPageContext {
  if (!pageContext) return pageContext;

  const sensitivePageKind = inferSensitiveStorefrontPageKind(pageContext.page);
  if (sensitivePageKind) {
    return {
      version: 1,
      contextVersion: 2,
      source: "storefront",
      page: { kind: sensitivePageKind },
    };
  }

  const page = pageContext.page;
  const cart = pageContext.cart;
  const lines = cart?.lines
    ?.map(sanitizeStorefrontChatCartLine)
    .filter((line): line is StorefrontChatCartLine => line !== null)
    .slice(0, 20);
  const pagePath = compactStorefrontChatText(page?.path, 512);
  const pageRoute = compactStorefrontChatText(page?.route, 512);
  const canonicalUrl = compactStorefrontChatText(page?.canonicalUrl, 2_048);
  const pageTitle = compactStorefrontChatText(page?.title, 180);
  const surface = sanitizeStorefrontChatSurface(
    pageContext.surface,
    page?.kind,
  );

  return {
    version: 1,
    contextVersion: 2,
    source: "storefront",
    ...(page
      ? {
          page: {
            ...(pagePath ? { path: pagePath } : {}),
            ...(pageRoute ? { route: pageRoute } : {}),
            ...(canonicalUrl ? { canonicalUrl } : {}),
            ...(pageTitle ? { title: pageTitle } : {}),
            ...(page.kind ? { kind: page.kind } : {}),
          },
        }
      : {}),
    ...(cart
      ? {
          cart: {
            ...(cart.totalItems !== undefined
              ? { totalItems: cart.totalItems }
              : {}),
            ...(cart.subtotalAmount !== undefined
              ? { subtotalAmount: cart.subtotalAmount }
              : {}),
            ...(cart.lineCount !== undefined
              ? { lineCount: cart.lineCount }
              : {}),
            ...(lines ? { lines } : {}),
            ...(cart.hasDiscount !== undefined
              ? { hasDiscount: cart.hasDiscount }
              : {}),
            ...(cart.truncated !== undefined
              ? { truncated: cart.truncated }
              : {}),
            ...(cart.revision !== undefined ? { revision: cart.revision } : {}),
            ...(cart.fingerprint ? { fingerprint: cart.fingerprint } : {}),
          },
        }
      : {}),
    ...(surface ? { surface } : {}),
  };
}

export function sanitizeStorefrontChatPayload(
  payload: StorefrontChatPayload,
): StorefrontChatPayload {
  const sensitivePageKind = inferSensitiveStorefrontPageKind(
    payload.pageContext?.page,
  );
  const pageContext =
    payload.pageContext !== undefined
      ? sanitizeStorefrontChatPageContext(payload.pageContext)
      : undefined;
  if (sensitivePageKind) {
    return {
      messages: [
        {
          role: "user",
          content: `The buyer requested general help while viewing a sensitive ${sensitivePageKind} page. Provide only generic guidance using visible storefront controls.`,
        },
      ],
      ...(pageContext !== undefined ? { pageContext } : {}),
    };
  }

  const messages = payload.messages.map((message) => {
    const content = compactStorefrontChatText(
      message.content,
      STOREFRONT_CHAT_MAX_MESSAGE_CHARS,
    );
    if (!content)
      throw new ValidationError("Storefront chat messages must contain text.");
    return { role: message.role, content };
  });

  return {
    messages,
    ...(pageContext !== undefined ? { pageContext } : {}),
  };
}

export function compactMcpProtocolVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const safe = value.replace(/[^\d.-]/g, "").trim();
  return safe ? safe.slice(0, 80) : null;
}

export function validateStorefrontChatPayload(
  messages: StorefrontChatMessage[],
): void {
  const textChars = messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  if (textChars > STOREFRONT_CHAT_MAX_TEXT_CHARS) {
    throw new ValidationError(
      `Storefront chat is too large. Maximum is ${STOREFRONT_CHAT_MAX_TEXT_CHARS} characters.`,
    );
  }
}

export async function readJsonPayload(c: ApiContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON.");
  }
}

export async function parseStorefrontChatPayload(
  c: ApiContext,
): Promise<StorefrontChatPayload> {
  const parsed = storefrontChatSchema.safeParse(await readJsonPayload(c));
  if (!parsed.success) {
    throw new ValidationError("Invalid storefront chat request.", {
      issues: parsed.error.issues,
    });
  }
  validateStorefrontChatPayload(parsed.data.messages);
  const sanitized = sanitizeStorefrontChatPayload(parsed.data);
  return sanitized;
}

export async function enforceStorefrontChatRateLimit(
  c: ApiContext,
): Promise<void> {
  const hashKey = requireStorefrontChatRateLimitHashKey(
    c.env.ASSISTANT_RATE_LIMIT_HMAC_KEY,
  );
  const clientBucket = isExactStorefrontChatServiceRequest(c.req.raw)
    ? storefrontChatRateLimitBucketFromIp(
        c.req.header(STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER),
      )
    : null;

  await consumeAssistantRateLimit(c.get("db"), {
    scope: STOREFRONT_CHAT_RATE_LIMIT.scope,
    bucket:
      clientBucket ?? STOREFRONT_CHAT_ANONYMOUS_RATE_LIMIT_BUCKET,
    hashKey,
    limit: STOREFRONT_CHAT_RATE_LIMIT.limit,
    windowSeconds: STOREFRONT_CHAT_RATE_LIMIT.windowSeconds,
  });
}

export function requireStorefrontChatRateLimitHashKey(
  value: string | null | undefined,
): string {
  const key = value?.trim();
  if (!key || new TextEncoder().encode(key).byteLength < 32) {
    throw new ServiceUnavailableError(
      "ASSISTANT_RATE_LIMIT_HMAC_KEY must contain at least 32 bytes.",
    );
  }
  return key;
}

export function latestUserChatText(messages: StorefrontChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.content;
  }
  return "";
}
