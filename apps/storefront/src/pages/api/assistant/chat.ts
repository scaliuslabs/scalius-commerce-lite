import type { APIRoute } from "astro";
import { env as cfEnv } from "cloudflare:workers";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import {
  containsAssistantSensitiveText,
  redactAssistantSensitiveText,
} from "@scalius/shared/assistant-redaction";
import {
  appendStorefrontAssistantCatalogReferences,
  splitStorefrontAssistantCatalogReferences,
} from "@scalius/shared/storefront-assistant-references";
import {
  assistantMessagePartSchema,
  type AssistantMessagePart,
} from "@scalius/shared/assistant-contracts";
import {
  STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER,
  STOREFRONT_CHAT_FACADE_TIMEOUT_MS,
  normalizeStorefrontChatClientIp,
} from "@scalius/shared/storefront-chat-boundary";

import {
  buildStorefrontAssistantPageContext,
  normalizeStorefrontAssistantSurfaceContext,
  type StorefrontAssistantPageContextSnapshot,
  type StorefrontAssistantPageKind,
} from "@/lib/assistant-page-context";
import type { CartStateSnapshot, VariantCartItem } from "@/store/cart";
import {
  STOREFRONT_CHAT_MAX_RESPONSE_BYTES,
  readBoundedResponseJson,
} from "@/lib/storefront-assistant-facade-contract";

export const prerender = false;

const STOREFRONT_CHAT_API_PATH = "/api/v1/storefront/chat";
const MAX_MESSAGE_CHARS = 2_000;
const MAX_HISTORY_MESSAGES = 6;
const MAX_RESPONSE_CHARS = 4_000;
const MAX_ACTIONS = 3;
const MAX_ACTION_LABEL_CHARS = 80;

const RAW_PATH_TRAVERSAL_PATTERN = /(^|\/)\.{1,2}(?:\/|$|[?#])/;
const ENCODED_UNSAFE_PATH_PATTERN = /%(?:2e|2f|5c)/i;
const SAFE_QUERY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SENSITIVE_QUERY_NAME_PATTERN =
  /(?:auth|bearer|code|credential|customer|email|jwt|key|mobile|otp|pass|password|passwd|phone|proof|receipt|secret|session|sig|signature|token)/i;
const SENSITIVE_PATH_SEGMENT_PATTERN =
  /(?:\b(?:approval|chk|cst|otp|pk|secret|session|sk|tok|token)_[A-Za-z0-9_-]{6,}\b|\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b|\b[A-Fa-f0-9]{32,}\b|(?:^|[^\d])(?:88)?01[3-9]\d{8}(?!\d))/i;

const BLOCKED_NAVIGATION_SEGMENTS = new Set([
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

type ChatRole = "user" | "assistant";

type StorefrontAssistantChatAction = {
  type: "navigate";
  path: string;
  label: string;
};

type StorefrontAssistantChatResult =
  | {
      status: "ok";
      profile?: "storefrontChat";
      provider?: string;
      model?: string;
      message: {
        role: "assistant";
        content: string;
        parts?: AssistantMessagePart[];
      };
      actions?: StorefrontAssistantChatAction[];
      usage?: Record<string, number | undefined> | null;
    }
  | {
      status: "disabled";
      reason: "api-missing" | "profile-disabled" | "unconfigured";
      message: string;
    }
  | {
      status: "error";
      message: string;
    };

type NormalizedChatInput = {
  message: string;
  history: Array<{ role: ChatRole; content: string }>;
  pageContext: StorefrontAssistantPageContextSnapshot | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(body: StorefrontAssistantChatResult, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function replaceControlCharacters(value: string, preserveNewlines = false): string {
  return Array.from(value, (char) => {
    if (preserveNewlines && (char === "\n" || char === "\t")) return char;
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : char;
  }).join("");
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const cleaned = replaceControlCharacters(value)
    .replace(/[\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return redactAssistantSensitiveText(cleaned).slice(0, maxLength);
}

function cleanAssistantResponseText(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = replaceControlCharacters(value.replace(/\r\n?/g, "\n"), true)
    .replace(/[\u2028\u2029]/g, " ")
    .trim();
  if (!cleaned) return "";
  return redactAssistantSensitiveText(cleaned).slice(0, MAX_RESPONSE_CHARS);
}

function normalizeHistory(value: unknown): NormalizedChatInput["history"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => isRecord(item) && (item.role === "user" || item.role === "assistant"))
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => {
      const role = item.role as ChatRole;
      if (typeof item.content !== "string") {
        return { role, content: "" };
      }
      const split = splitStorefrontAssistantCatalogReferences(item.content);
      const content = cleanText(split.content, MAX_MESSAGE_CHARS);
      if (role === "user") return { role, content };
      return {
        role,
        content: appendStorefrontAssistantCatalogReferences(
          content,
          split.productIds,
          MAX_MESSAGE_CHARS,
        ),
      };
    })
    .filter((item) => item.content.length > 0);
}

function normalizePageKind(value: unknown): StorefrontAssistantPageKind | null {
  return typeof value === "string" &&
    [
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
    ].includes(value)
    ? (value as StorefrontAssistantPageKind)
    : null;
}

function contextSnapshotToCartState(value: unknown): CartStateSnapshot | null {
  if (!isRecord(value)) return null;
  const rawLines = Array.isArray(value.lines) ? value.lines : [];
  const items: Record<string, VariantCartItem> = {};

  rawLines.slice(0, 20).forEach((line, index) => {
    if (!isRecord(line)) return;
    const productId = cleanText(line.productId, 120);
    const variantId = cleanText(line.variantId, 120);
    const name = cleanText(line.name, 160);
    if (!productId || !variantId || variantId === "default" || !name) return;
    const quantity = typeof line.quantity === "number" ? Math.floor(line.quantity) : 0;
    if (quantity <= 0 || quantity > 99) return;
    const unitPrice =
      typeof line.unitPrice === "number" &&
      Number.isFinite(line.unitPrice) &&
      line.unitPrice >= 0 &&
      line.unitPrice <= 10_000_000
        ? line.unitPrice
        : null;
    if (unitPrice === null) return;
    const options = Array.isArray(line.options)
      ? line.options
          .slice(0, 2)
          .map((option) => {
            if (!isRecord(option)) return null;
            const optionName = cleanText(option.name, 80);
            const label = cleanText(option.label, 80);
            return optionName && label ? { name: optionName, label } : null;
          })
          .filter((option): option is { name: string; label: string } =>
            Boolean(option),
          )
      : undefined;

    items[`line_${index}`] = {
      id: productId,
      variantId,
      slug: cleanText(line.slug, 120) || undefined,
      name,
      quantity,
      price: unitPrice,
      ...(options?.length ? { options } : {}),
    };
  });

  return {
    items,
    totalItems: 0,
    totalAmount: 0,
    discount:
      value.hasDiscount === true
        ? {
            id: "assistant-discount-present",
            code: "[redacted]",
            type: "unknown",
            valueType: "unknown",
            discountValue: 0,
            discountAmount: 0,
          }
        : null,
  };
}

function normalizePageContext(value: unknown): StorefrontAssistantPageContextSnapshot | null {
  if (!isRecord(value) || !isRecord(value.page)) return null;

  const page = value.page;
  const normalized = buildStorefrontAssistantPageContext({
    path: typeof page.path === "string" ? page.path : null,
    route: typeof page.route === "string" ? page.route : null,
    canonicalUrl:
      typeof page.canonicalUrl === "string" ? page.canonicalUrl : null,
    title: typeof page.title === "string" ? page.title : null,
    pageKind: normalizePageKind(page.kind),
    cart: contextSnapshotToCartState(value.cart),
  });
  const surface = Object.prototype.hasOwnProperty.call(value, "surface")
    ? normalizeStorefrontAssistantSurfaceContext(
        value.surface,
        normalized.page.kind,
      )
    : normalized.surface;
  return { ...normalized, surface };
}

function normalizeChatInput(payload: unknown): NormalizedChatInput {
  const record = isRecord(payload) ? payload : {};
  const message = typeof record.message === "string"
    ? splitStorefrontAssistantCatalogReferences(record.message).content
    : record.message;
  return {
    message: cleanText(message, MAX_MESSAGE_CHARS),
    history: normalizeHistory(record.history),
    pageContext: normalizePageContext(record.pageContext),
  };
}

function createUpstreamPayload(input: NormalizedChatInput) {
  const messages: Array<{ role: ChatRole; content: string }> = [...input.history];
  if (input.message) messages.push({ role: "user", content: input.message });

  return {
    messages,
    pageContext: input.pageContext,
  };
}

function getEnv(): Env | undefined {
  try {
    const env = cfEnv as unknown as Env;
    return env?.BACKEND_API || env?.PUBLIC_API_BASE_URL ? env : undefined;
  } catch {
    return undefined;
  }
}

function isLocalApiBase(apiBase: string | undefined): boolean {
  if (!apiBase) return false;
  try {
    const hostname = new URL(apiBase).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function resolveUpstream(): {
  fetcher: typeof fetch;
  url: string;
  forwardsClientIp: boolean;
} | null {
  const env = getEnv();
  const apiBase = typeof env?.PUBLIC_API_BASE_URL === "string" ? env.PUBLIC_API_BASE_URL : undefined;

  if (env?.BACKEND_API && !isLocalApiBase(apiBase)) {
    return {
      fetcher: env.BACKEND_API.fetch.bind(env.BACKEND_API),
      url: `http://api.internal${STOREFRONT_CHAT_API_PATH}`,
      forwardsClientIp: true,
    };
  }

  if (apiBase) {
    return {
      fetcher: fetch,
      url: `${apiBase.replace(/\/$/, "")}${STOREFRONT_CHAT_API_PATH}`,
      forwardsClientIp: false,
    };
  }

  return null;
}

function unwrapApiEnvelope(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.success === true && value.data !== undefined) return value.data;
  return value;
}

function readAssistantContent(value: unknown): string {
  if (typeof value === "string") return cleanAssistantResponseText(value);
  if (!isRecord(value)) return "";
  return cleanAssistantResponseText(value.content);
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function hasSensitiveTargetText(value: string): boolean {
  return containsAssistantSensitiveText(value);
}

function isSafeNavigationQuery(search: string, params: URLSearchParams): boolean {
  if (search.length > 512) return false;
  const entries = Array.from(params.entries());
  if (entries.length > 20) return false;
  return entries.every(([key, value]) => {
    if (
      !key ||
      key.length > 64 ||
      value.length > 180 ||
      hasControlCharacter(key) ||
      hasControlCharacter(value) ||
      !SAFE_QUERY_KEY_PATTERN.test(key) ||
      SENSITIVE_QUERY_NAME_PATTERN.test(key) ||
      hasSensitiveTargetText(value)
    ) {
      return false;
    }
    return true;
  });
}

function sanitizeNavigationPath(value: unknown, origin: string): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (
    text !== value ||
    !text ||
    text.length > 2_048 ||
    hasControlCharacter(text) ||
    text.startsWith("//") ||
    text.includes("\\") ||
    RAW_PATH_TRAVERSAL_PATTERN.test(text) ||
    ENCODED_UNSAFE_PATH_PATTERN.test(text)
  ) {
    return null;
  }

  const isAbsoluteHttpUrl = /^https?:\/\//i.test(text);
  if (!text.startsWith("/") && !isAbsoluteHttpUrl) return null;

  let url: URL;
  try {
    url = new URL(text, origin);
  } catch {
    return null;
  }

  if (
    url.origin !== origin ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hash ||
    url.username ||
    url.password
  ) {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.some((segment) => BLOCKED_NAVIGATION_SEGMENTS.has(segment.toLowerCase()))) {
    return null;
  }
  if (segments.some((segment) => SENSITIVE_PATH_SEGMENT_PATTERN.test(segment))) {
    return null;
  }
  if (segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(segment))) {
    return null;
  }

  if (url.pathname === "/cart") return url.search === "" ? "/cart" : null;
  if (url.pathname === "/search") {
    return isSafeNavigationQuery(url.search, url.searchParams)
      ? `${url.pathname}${url.search}`
      : null;
  }
  if (url.search) return null;

  const root = segments[0]?.toLowerCase();
  if (root === "products" || root === "categories" || root === "collections") {
    return segments.length > 1 ? url.pathname : null;
  }
  return segments.length === 1 && root !== undefined ? url.pathname : null;
}

function normalizeActions(value: unknown, origin: string): StorefrontAssistantChatAction[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const actions: StorefrontAssistantChatAction[] = [];
  for (const action of value.slice(0, MAX_ACTIONS)) {
    if (!isRecord(action) || action.type !== "navigate") continue;
    const path = sanitizeNavigationPath(action.path, origin);
    if (!path) continue;
    actions.push({
      type: "navigate",
      path,
      label: cleanText(action.label, MAX_ACTION_LABEL_CHARS) || "Open page",
    });
  }

  return actions.length > 0 ? actions : undefined;
}

type StorefrontProductPart = Extract<
  AssistantMessagePart,
  { type: "product_grid" }
>["products"][number];

function sanitizeRichImageUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 1_000 || containsAssistantSensitiveText(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return undefined;
    }
    for (const [name, queryValue] of url.searchParams) {
      if (
        SENSITIVE_QUERY_NAME_PATTERN.test(name) ||
        containsAssistantSensitiveText(queryValue)
      ) {
        return undefined;
      }
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function sanitizeRichProduct(
  product: StorefrontProductPart,
  origin: string,
): StorefrontProductPart | null {
  const path = sanitizeNavigationPath(product.path, origin);
  const title = cleanText(product.title, 240);
  if (!path?.startsWith("/products/") || !title) return null;
  const imageUrl = sanitizeRichImageUrl(product.imageUrl);
  const { imageUrl: _unsafeImageUrl, ...safeProduct } = product;
  return {
    ...safeProduct,
    title,
    path,
    ...(imageUrl ? { imageUrl } : {}),
    badges: product.badges
      .map((badge) => cleanText(badge, 60))
      .filter(Boolean)
      .slice(0, 6),
    ...(product.rationale
      ? { rationale: cleanText(product.rationale, 500) || undefined }
      : {}),
  };
}

function sanitizeRichPart(
  value: unknown,
  origin: string,
): AssistantMessagePart | null {
  if (
    isRecord(value) &&
    value.type === "product_grid" &&
    Array.isArray(value.products)
  ) {
    const products = value.products.slice(0, 12).flatMap((candidate) => {
      const productPart = assistantMessagePartSchema.safeParse({
        type: "product_grid",
        products: [candidate],
      });
      if (!productPart.success || productPart.data.type !== "product_grid") {
        return [];
      }
      const product = sanitizeRichProduct(
        productPart.data.products[0]!,
        origin,
      );
      return product ? [product] : [];
    });
    const title = cleanText(value.title, 160);
    return products.length > 0
      ? {
          type: "product_grid",
          ...(title ? { title } : {}),
          products,
        }
      : null;
  }

  const parsed = assistantMessagePartSchema.safeParse(value);
  if (!parsed.success) return null;
  const part = parsed.data;

  if (part.type === "text") {
    const text = cleanAssistantResponseText(part.text);
    return text ? { type: "text", text } : null;
  }
  if (part.type === "product_grid") {
    const products = part.products
      .map((product) => sanitizeRichProduct(product, origin))
      .filter((product): product is StorefrontProductPart => product !== null);
    return products.length > 0
      ? {
          type: "product_grid",
          ...(part.title ? { title: cleanText(part.title, 160) } : {}),
          products,
        }
      : null;
  }
  if (part.type === "comparison") {
    const products = part.products
      .map((product) => sanitizeRichProduct(product, origin))
      .filter((product): product is StorefrontProductPart => product !== null);
    if (products.length < 2) return null;
    const productIds = new Set(products.map((product) => product.id));
    const rows = part.rows.flatMap((row) => {
      const label = cleanText(row.label, 120);
      const cellsByProductId = new Map<
        string,
        (typeof row.cells)[number]
      >();
      for (const cell of row.cells) {
        if (
          !productIds.has(cell.productId) ||
          cellsByProductId.has(cell.productId)
        ) {
          return [];
        }
        cellsByProductId.set(cell.productId, cell);
      }
      if (!label || cellsByProductId.size !== products.length) return [];
      const cells = products.map((product) => {
        const cell = cellsByProductId.get(product.id)!;
        return {
          ...cell,
          value: cell.value === null
            ? null
            : cleanText(cell.value, 500) || null,
        };
      });
      return [{ label, cells }];
    });
    return rows.length > 0
      ? {
          type: "comparison",
          title: cleanText(part.title, 160) || "Catalog comparison",
          products,
          rows,
        }
      : null;
  }
  if (part.type === "navigation") {
    const path = sanitizeNavigationPath(part.path, origin);
    const label = cleanText(part.label, 120);
    return path && label
      ? { type: "navigation", path, label, requiresConfirmation: true }
      : null;
  }
  if (part.type === "source") {
    const label = cleanText(part.label, 240);
    const path = part.path ? sanitizeNavigationPath(part.path, origin) : null;
    if (!label || (part.path && !path)) return null;
    return {
      type: "source",
      sourceId: part.sourceId,
      label,
      ...(part.description
        ? { description: cleanText(part.description, 600) || undefined }
        : {}),
      ...(path ? { path } : {}),
    };
  }
  if (part.type === "error") {
    const message = cleanAssistantResponseText(part.message);
    return message ? { ...part, message } : null;
  }

  return null;
}

function normalizeRichParts(
  value: unknown,
  origin: string,
): AssistantMessagePart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .slice(0, 40)
    .map((part) => sanitizeRichPart(part, origin))
    .filter((part): part is AssistantMessagePart => part !== null);
  return parts.length > 0 ? parts : undefined;
}

function normalizeUsage(value: unknown): Record<string, number | undefined> | null {
  if (!isRecord(value)) return null;
  const usage: Record<string, number | undefined> = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
    const amount = value[key];
    usage[key] = typeof amount === "number" && Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : undefined;
  }
  return usage;
}

function normalizeUpstreamResult(value: unknown, origin: string): StorefrontAssistantChatResult {
  const record = unwrapApiEnvelope(value);
  if (!isRecord(record)) {
    return { status: "error", message: "Assistant returned an empty response." };
  }

  if (record.status === "disabled") {
    const reason =
      record.reason === "api-missing" || record.reason === "profile-disabled"
        ? record.reason
        : "unconfigured";
    return {
      status: "disabled",
      reason,
      message:
        cleanText(record.message, 500) ||
        "Storefront chat is not ready. Configure the storefrontChat AI profile first.",
    };
  }

  const content =
    readAssistantContent(record.message) ||
    readAssistantContent(record.reply) ||
    readAssistantContent(record.text);
  if (!content) {
    return { status: "error", message: "Assistant returned no readable message." };
  }

  const actions = normalizeActions(record.actions, origin);
  const messageRecord = isRecord(record.message) ? record.message : null;
  const parts = normalizeRichParts(
    messageRecord?.parts ?? record.parts,
    origin,
  );
  return {
    status: "ok",
    ...(record.profile === "storefrontChat" ? { profile: "storefrontChat" as const } : {}),
    ...(typeof record.provider === "string" ? { provider: cleanText(record.provider, 80) } : {}),
    ...(typeof record.model === "string" ? { model: cleanText(record.model, 160) } : {}),
    message: {
      role: "assistant",
      content,
      ...(parts ? { parts } : {}),
    },
    usage: normalizeUsage(record.usage),
    ...(actions ? { actions } : {}),
  };
}

function disabledForStatus(status: number, body: unknown): StorefrontAssistantChatResult | null {
  if (status === 404) {
    return {
      status: "disabled",
      reason: "api-missing",
      message:
        "Storefront chat is not enabled on this deployment yet. The storefront UI is ready, but the storefrontChat API route is not available.",
    };
  }

  const errorText = cleanText(
    isRecord(body) && isRecord(body.error)
      ? body.error.message
      : isRecord(body)
        ? body.error ?? body.message
        : "",
    500,
  );
  if (/profile[^.]*disabled|disabled/i.test(errorText)) {
    return {
      status: "disabled",
      reason: "profile-disabled",
      message: "Storefront chat is disabled. Enable the storefrontChat AI profile before using the assistant.",
    };
  }
  if (/credential|api key|unconfigured|not configured|not enabled/i.test(errorText)) {
    return {
      status: "disabled",
      reason: "unconfigured",
      message: "Storefront chat is not ready. Configure the storefrontChat AI profile before using the assistant.",
    };
  }
  return null;
}

export async function handleStorefrontAssistantChat(
  request: Request,
): Promise<Response> {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return jsonResponse(
      { status: "error", message: "Cross-origin cookie request denied" },
      403,
    );
  }

  const payload = await request.json().catch(() => null);
  const input = normalizeChatInput(payload);
  if (!input.message) {
    return jsonResponse({ status: "error", message: "Message is required." }, 400);
  }

  const upstream = resolveUpstream();
  if (!upstream) {
    return jsonResponse(
      {
        status: "disabled",
        reason: "api-missing",
        message:
          "Storefront chat is not enabled on this deployment yet. The same-origin assistant proxy is present, but no backend chat route is configured.",
      },
      503,
    );
  }

  try {
    const upstreamHeaders = new Headers({
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    if (upstream.forwardsClientIp) {
      const clientIp = normalizeStorefrontChatClientIp(
        request.headers.get("cf-connecting-ip"),
      );
      if (clientIp) {
        upstreamHeaders.set(
          STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER,
          clientIp,
        );
      }
    }

    const response = await upstream.fetcher(upstream.url, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(createUpstreamPayload(input)),
      cache: "no-store",
      signal: AbortSignal.timeout(STOREFRONT_CHAT_FACADE_TIMEOUT_MS),
    });

    const body = await readBoundedResponseJson(
      response,
      STOREFRONT_CHAT_MAX_RESPONSE_BYTES,
    ).catch(() => null);
    if (!response.ok) {
      const disabled = disabledForStatus(response.status, body);
      return jsonResponse(
        disabled ?? { status: "error", message: "Assistant service request failed. Nothing was changed." },
        response.status === 404 ? 503 : response.status,
      );
    }

    return jsonResponse(normalizeUpstreamResult(body, new URL(request.url).origin), 200);
  } catch {
    return jsonResponse(
      { status: "error", message: "Assistant service is unavailable. Nothing was changed." },
      502,
    );
  }
}

export const POST: APIRoute = async ({ request }) =>
  handleStorefrontAssistantChat(request);
