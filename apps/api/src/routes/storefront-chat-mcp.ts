import { ServiceUnavailableError } from "../utils/api-error";
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
  searchQueryFromMessages,
} from "./storefront-chat-navigation";

export function createStorefrontAgentMcpHeaders(
  session?: StorefrontAgentMcpSession | null,
): Headers {
  const headers = new Headers({
    Accept: "application/json",
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

export function parseSseJsonResponse(value: string): unknown | null {
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
    if (parsed !== null) return parsed;
  }
  return null;
}

export async function parseJsonResponse(
  response: Response,
): Promise<unknown | null> {
  try {
    const text = await response.text();
    const direct = parseJsonText(text.trim());
    if (direct !== null) return direct;
    return parseSseJsonResponse(text);
  } catch {
    return null;
  }
}

export async function initializeStorefrontAgentMcp(
  c: ApiContext,
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
      signal: c.req.raw.signal,
    });
    if (!response.ok) throw unavailableStorefrontToolsError();

    const body = await parseJsonResponse(response);
    const result =
      isJsonRecord(body) && isJsonRecord(body.result) ? body.result : null;
    if (!result) throw unavailableStorefrontToolsError();

    const protocolVersion = compactMcpProtocolVersion(result.protocolVersion);
    const sessionId = compactStorefrontChatText(
      response.headers.get("mcp-session-id"),
      160,
    );
    return {
      ...(protocolVersion ? { protocolVersion } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
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
      signal: c.req.raw.signal,
    });
    if (!response.ok) return null;
    return parseJsonResponse(response);
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
    return pageContext.surface.productId;
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
): Promise<StorefrontMcpContext[]> {
  const contexts: StorefrontMcpContext[] = [];
  const latestText = latestUserChatText(payload.messages);

  async function addToolContext(
    tool: StorefrontChatPublicTool,
    args: JsonRecord,
    id: string,
  ): Promise<void> {
    const body = await callStorefrontAgentTool(c, session, tool, args, id);
    const structuredContent = readMcpStructuredContent(body);
    if (!structuredContent) return;
    const text = formatStorefrontToolContext(tool, structuredContent);
    if (text) contexts.push({ tool, structuredContent, text });
  }

  await addToolContext(
    "storefront_discovery_policy",
    {},
    "storefront-chat-discovery-policy",
  );

  const productId = productIdentifierFromPageContext(payload.pageContext);
  if (productId) {
    await addToolContext(
      "catalog_product",
      { id: productId },
      "storefront-chat-catalog-product",
    );
  }

  if (hasCategoryIntent(latestText, payload.pageContext)) {
    await addToolContext(
      "catalog_categories",
      { limit: 8 },
      "storefront-chat-catalog-categories",
    );
  }

  const searchQuery =
    searchQueryFromPageSurface(payload.pageContext) ??
    searchQueryFromMessages(payload.messages);
  if (searchQuery) {
    await addToolContext(
      "catalog_search",
      { query: searchQuery, limit: 5 },
      "storefront-chat-catalog-search",
    );
  }

  const cartItems = cartValidationItems(payload.pageContext);
  if (
    cartItems.length > 0 &&
    hasCartValidationIntent(latestText, payload.pageContext)
  ) {
    await addToolContext(
      "cart_validate",
      { items: cartItems },
      "storefront-chat-cart-validate",
    );
  }

  if (contexts.length === 0) {
    throw unavailableStorefrontToolsError();
  }

  return contexts;
}
