import { ServiceUnavailableError } from "../utils/api-error";
import { STOREFRONT_CHAT_MCP_TIMEOUT_MS } from
  "@scalius/shared/storefront-chat-boundary";
import {
  FORBIDDEN_CONTEXT_KEY_PATTERN,
  STOREFRONT_AGENT_MCP_PROTOCOL_VERSION,
  STOREFRONT_AGENT_MCP_URL,
  STOREFRONT_CHAT_MAX_CART_LINES,
  STOREFRONT_CHAT_MAX_TOOL_CONTEXT_CHARS,
  STOREFRONT_CHAT_PUBLIC_TOOLS,
  compactMcpProtocolVersion,
  compactStorefrontChatText,
  isJsonRecord,
  latestUserChatText,
  type ApiContext,
  type JsonRecord,
  type StorefrontAgentMcpSession,
  type StorefrontChatCartLine,
  type StorefrontChatPageContext,
  type StorefrontChatPayload,
  type StorefrontChatPublicTool,
  type StorefrontMcpContext,
} from "./storefront-chat-contract";
import {
  cleanNavigationTargetText,
  hasCategoryIntent,
  resolveStorefrontNavigationTarget,
} from "./storefront-chat-navigation";
import {
  classifyStorefrontChatIntent,
  storefrontIntentPrefersCurrentProduct,
  type StorefrontChatIntent,
} from "./storefront-chat-intent";

const STOREFRONT_AGENT_MCP_MAX_RESPONSE_BYTES = 512 * 1024;
type JsonRpcId = string | number;

export function createStorefrontAgentMcpHeaders(
  session?: StorefrontAgentMcpSession | null,
): Headers {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  });
  if (session?.sessionId) headers.set("Mcp-Session-Id", session.sessionId);
  if (session?.protocolVersion)
    headers.set("MCP-Protocol-Version", session.protocolVersion);
  return headers;
}

export function unavailableStorefrontToolsError(): ServiceUnavailableError {
  return new ServiceUnavailableError(
    "Storefront assistant catalog tools are temporarily unavailable.",
  );
}

export function parseJsonText(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function matchingJsonRpcResponse(
  value: unknown,
  expectedId: JsonRpcId,
): JsonRecord | null {
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    if (
      isJsonRecord(candidate) &&
      candidate.jsonrpc === "2.0" &&
      candidate.id === expectedId &&
      candidate.method === undefined &&
      (Object.prototype.hasOwnProperty.call(candidate, "result") ||
        Object.prototype.hasOwnProperty.call(candidate, "error"))
    ) {
      return candidate;
    }
  }
  return null;
}

export function parseSseJsonResponse(
  value: string,
  expectedId: JsonRpcId,
): JsonRecord | null {
  const chunks = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n\n+/);
  for (const chunk of chunks) {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => {
        const body = line.slice("data:".length);
        return body.startsWith(" ") ? body.slice(1) : body;
      })
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    const parsed = parseJsonText(data);
    const matched = matchingJsonRpcResponse(parsed, expectedId);
    if (matched) return matched;
  }
  return null;
}

async function readBoundedResponseText(response: Response): Promise<
  string | null
> {
  if (!response.body) return null;
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > STOREFRONT_AGENT_MCP_MAX_RESPONSE_BYTES
  ) {
    await response.body.cancel().catch(() => undefined);
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > STOREFRONT_AGENT_MCP_MAX_RESPONSE_BYTES) {
        await reader.cancel("MCP response exceeded byte limit");
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export async function parseJsonResponse(
  response: Response,
  expectedId: JsonRpcId,
): Promise<JsonRecord | null> {
  try {
    const text = await readBoundedResponseText(response);
    if (text === null) return null;
    const direct = parseJsonText(text.trim());
    const directMatch = matchingJsonRpcResponse(direct, expectedId);
    if (directMatch) return directMatch;
    return parseSseJsonResponse(text, expectedId);
  } catch {
    return null;
  }
}

export async function initializeStorefrontAgentMcp(
  c: ApiContext,
  signal: AbortSignal = c.req.raw.signal,
): Promise<StorefrontAgentMcpSession> {
  const agent = c.env.STOREFRONT_AGENT;
  if (!agent || typeof agent.fetch !== "function") {
    throw unavailableStorefrontToolsError();
  }

  try {
    const response = await agent.fetch(STOREFRONT_AGENT_MCP_URL, {
      method: "POST",
      headers: createStorefrontAgentMcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "storefront-chat-initialize",
        method: "initialize",
        params: {
          protocolVersion: STOREFRONT_AGENT_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "scalius-api-storefront-chat", version: "0.1.0" },
        },
      }),
      signal,
    });
    if (!response.ok) throw unavailableStorefrontToolsError();

    const initializeId = "storefront-chat-initialize";
    const body = await parseJsonResponse(response, initializeId);
    const result =
      isJsonRecord(body) && isJsonRecord(body.result) ? body.result : null;
    if (!result) throw unavailableStorefrontToolsError();

    const protocolVersion = compactMcpProtocolVersion(result.protocolVersion);
    if (!protocolVersion) throw unavailableStorefrontToolsError();
    const sessionId = compactStorefrontChatText(
      response.headers.get("mcp-session-id"),
      160,
    );
    const session = {
      protocolVersion,
      ...(sessionId ? { sessionId } : {}),
    };
    const initialized = await agent.fetch(STOREFRONT_AGENT_MCP_URL, {
      method: "POST",
      headers: createStorefrontAgentMcpHeaders(session),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      signal,
    });
    if (initialized.status !== 202) {
      await initialized.body?.cancel().catch(() => undefined);
      throw unavailableStorefrontToolsError();
    }
    await initialized.body?.cancel().catch(() => undefined);
    return session;
  } catch (error) {
    if (error instanceof ServiceUnavailableError) throw error;
    throw unavailableStorefrontToolsError();
  }
}

export function isAllowedStorefrontTool(
  toolName: string,
): toolName is StorefrontChatPublicTool {
  return (STOREFRONT_CHAT_PUBLIC_TOOLS as readonly string[]).includes(toolName);
}

export async function callStorefrontAgentTool(
  c: ApiContext,
  session: StorefrontAgentMcpSession,
  toolName: StorefrontChatPublicTool,
  toolArguments: JsonRecord,
  id: string,
  signal: AbortSignal = c.req.raw.signal,
): Promise<unknown | null> {
  if (!isAllowedStorefrontTool(toolName)) return null;
  const agent = c.env.STOREFRONT_AGENT;
  if (!agent || typeof agent.fetch !== "function") return null;

  try {
    const response = await agent.fetch(STOREFRONT_AGENT_MCP_URL, {
      method: "POST",
      headers: createStorefrontAgentMcpHeaders(session),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: toolArguments,
        },
      }),
      signal,
    });
    if (!response.ok) return null;
    return parseJsonResponse(response, id);
  } catch {
    return null;
  }
}

export function readMcpStructuredContent(body: unknown): JsonRecord | null {
  const response = isJsonRecord(body) ? body : null;
  const result = isJsonRecord(response?.result) ? response.result : null;
  if (!result || result.isError === true) return null;
  return isJsonRecord(result.structuredContent)
    ? result.structuredContent
    : null;
}

export function sanitizeToolContextValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return undefined;
  if (value == null) return null;
  if (typeof value === "string") return compactStorefrontChatText(value, 300);
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 10)
      .map((item) => sanitizeToolContextValue(item, depth + 1))
      .filter((item) => item !== undefined);
    return items;
  }
  if (!isJsonRecord(value)) return undefined;

  const output: JsonRecord = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (FORBIDDEN_CONTEXT_KEY_PATTERN.test(key)) continue;
    const sanitized = sanitizeToolContextValue(item, depth + 1);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

export function formatStorefrontToolContext(
  tool: StorefrontChatPublicTool,
  structuredContent: JsonRecord,
): string | null {
  const sanitized = sanitizeToolContextValue(structuredContent);
  if (
    !sanitized ||
    (isJsonRecord(sanitized) && Object.keys(sanitized).length === 0)
  ) {
    return null;
  }

  const text = compactStorefrontChatText(
    JSON.stringify(sanitized),
    STOREFRONT_CHAT_MAX_TOOL_CONTEXT_CHARS,
  );
  return text ? `${tool}: ${text}` : null;
}

export function hasCartValidationIntent(
  text: string,
  pageContext: StorefrontChatPageContext,
): boolean {
  return (
    pageContext?.surface?.kind === "cart" ||
    pageContext?.page?.kind === "cart" ||
    /\b(?:cart|available|availability|stock|price|quantity)\b/i.test(text)
  );
}

export function productIdentifierFromPageContext(
  pageContext: StorefrontChatPageContext,
): string | null {
  if (pageContext?.page?.kind !== "product") return null;
  if (pageContext.surface?.kind === "product") {
    return pageContext.surface.selectedVariantId ??
      pageContext.surface.productId;
  }
  const candidates = [pageContext.page.path, pageContext.page.route];
  for (const candidate of candidates) {
    const path = cleanNavigationTargetText(candidate, 512);
    if (
      path &&
      resolveStorefrontNavigationTarget(
        path,
        "https://storefront.invalid",
      )?.startsWith("/products/")
    ) {
      return path;
    }
  }
  return null;
}

export function searchQueryFromPageSurface(
  pageContext: StorefrontChatPageContext,
): string | null {
  return pageContext?.surface?.kind === "search" && pageContext.surface.query
    ? pageContext.surface.query
    : null;
}

export function visibleListingProductIds(
  pageContext: StorefrontChatPageContext,
): string[] {
  const surface = pageContext?.surface;
  return surface &&
      (surface.kind === "category" ||
        surface.kind === "collection" ||
        surface.kind === "search")
    ? surface.visibleProductIds.slice(0, 5)
    : [];
}

export function cartValidationItems(
  pageContext: StorefrontChatPageContext,
): JsonRecord[] {
  const lines = pageContext?.cart?.lines ?? [];
  return lines
    .slice(0, STOREFRONT_CHAT_MAX_CART_LINES)
    .map((line: StorefrontChatCartLine) => ({
      productId: line.productId,
      ...(line.variantId ? { variantId: line.variantId } : {}),
      ...(line.slug ? { slug: line.slug } : {}),
      ...(line.name ? { name: line.name } : {}),
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      ...(line.options?.length
        ? {
            options: line.options.map((option) => ({
              name: option.name,
              value: option.label,
            })),
          }
        : {}),
    }));
}

export async function collectStorefrontMcpContexts(
  c: ApiContext,
  payload: StorefrontChatPayload,
  session: StorefrontAgentMcpSession,
  intent: StorefrontChatIntent = classifyStorefrontChatIntent(payload),
  signal?: AbortSignal,
): Promise<StorefrontMcpContext[]> {
  const stageSignal = signal ?? AbortSignal.any([
    c.req.raw.signal,
    AbortSignal.timeout(STOREFRONT_CHAT_MCP_TIMEOUT_MS),
  ]);
  const latestText = intent.latestText || latestUserChatText(payload.messages);

  type ToolPlan = {
    tool: StorefrontChatPublicTool;
    args: JsonRecord;
    id: string;
    expectedProductIds?: string[];
  };
  const plans: ToolPlan[] = [{
    tool: "storefront_discovery_policy",
    args: {},
    id: "storefront-chat-discovery-policy",
  }];

  async function addToolContext(
    plan: ToolPlan,
  ): Promise<StorefrontMcpContext | null> {
    const body = await callStorefrontAgentTool(
      c,
      session,
      plan.tool,
      plan.args,
      plan.id,
      stageSignal,
    );
    const structuredContent = readMcpStructuredContent(body);
    if (!structuredContent) return null;
    if (plan.expectedProductIds) {
      const products = plan.tool === "catalog_product"
        ? isJsonRecord(structuredContent.product)
          ? [structuredContent.product]
          : []
        : Array.isArray(structuredContent.products)
          ? structuredContent.products.filter(isJsonRecord)
          : [];
      const returnedIds = products.flatMap((product) =>
        typeof product.id === "string" ? [product.id] : []
      );
      if (
        returnedIds.length !== plan.expectedProductIds.length ||
        new Set(returnedIds).size !== returnedIds.length ||
        plan.expectedProductIds.some((id) => !returnedIds.includes(id))
      ) {
        return null;
      }
    }
    const text = formatStorefrontToolContext(plan.tool, structuredContent);
    return text ? { tool: plan.tool, structuredContent, text } : null;
  }

  const referencedProductIds = intent.referencedProductIds ?? [];
  if (
    !intent.unresolvedOrdinalReference &&
    referencedProductIds.length === 1
  ) {
    plans.push({
      tool: "catalog_product",
      args: { id: referencedProductIds[0] },
      id: "storefront-chat-referenced-product",
      expectedProductIds: referencedProductIds,
    });
  } else if (
    !intent.unresolvedOrdinalReference &&
    referencedProductIds.length > 1
  ) {
    plans.push({
      tool: "catalog_lookup",
      args: { ids: referencedProductIds },
      id: "storefront-chat-referenced-products",
      expectedProductIds: referencedProductIds,
    });
  } else if (
    !intent.unresolvedOrdinalReference &&
    intent.kind !== "ordinal_product"
  ) {
    const productId = productIdentifierFromPageContext(payload.pageContext);
    const selected = payload.pageContext?.surface?.kind === "product"
      ? payload.pageContext.surface.selectedOptions.map((option) => ({
          name: option.name,
          label: option.label,
        }))
      : [];
    if (productId) {
      plans.push({
        tool: "catalog_product",
        args: {
        id: productId,
        ...(selected.length > 0 ? { selected } : {}),
      },
        id: "storefront-chat-catalog-product",
      });
    }
  }

  const visibleProductIds = visibleListingProductIds(payload.pageContext);
  if (visibleProductIds.length > 0 && referencedProductIds.length === 0) {
    plans.push({
      tool: "catalog_lookup",
      args: { ids: visibleProductIds },
      id: "storefront-chat-visible-products",
    });
  }

  if (hasCategoryIntent(latestText, payload.pageContext)) {
    const categorySlug = payload.pageContext?.surface?.kind === "category"
      ? payload.pageContext.surface.slug
      : null;
    plans.push({
      tool: "catalog_categories",
      args: categorySlug ? { limit: 1, slug: categorySlug } : { limit: 8 },
      id: "storefront-chat-catalog-categories",
    });
  }

  const suppressSearch = referencedProductIds.length > 0 ||
    intent.unresolvedOrdinalReference ||
    storefrontIntentPrefersCurrentProduct(intent, payload) ||
    ((intent.kind === "factual_comparison" ||
      intent.kind === "recommendation_comparison") &&
      visibleProductIds.length > 0);
  const searchQuery = suppressSearch
    ? null
    : searchQueryFromPageSurface(payload.pageContext) ?? intent.searchQuery;
  if (searchQuery) {
    plans.push({
      tool: "catalog_search",
      args: { query: searchQuery, limit: 5 },
      id: "storefront-chat-catalog-search",
    });
  }

  const cartItems = cartValidationItems(payload.pageContext);
  if (
    cartItems.length > 0 &&
    hasCartValidationIntent(latestText, payload.pageContext)
  ) {
    plans.push({
      tool: "cart_validate",
      args: { items: cartItems },
      id: "storefront-chat-cart-validate",
    });
  }

  const contexts = (await Promise.all(plans.map(addToolContext)))
    .filter((context): context is StorefrontMcpContext => context !== null);

  if (contexts.length === 0) {
    throw unavailableStorefrontToolsError();
  }

  return contexts;
}
