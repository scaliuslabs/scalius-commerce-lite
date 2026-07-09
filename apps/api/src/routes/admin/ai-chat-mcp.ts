import { z } from "@hono/zod-openapi";
import {
  ADMIN_AGENT_MCP_PROTOCOL_VERSION,
  ADMIN_AGENT_MCP_URL,
  ADMIN_CHAT_MAX_NAVIGATION_CONTEXT_CHARS,
  ADMIN_CHAT_MAX_NAVIGATION_PAGES,
  ADMIN_CHAT_MAX_PRODUCT_COPY_CONTEXT_CHARS,
  ADMIN_CHAT_MAX_PRODUCT_DESCRIPTION_CHARS,
  ADMIN_NAVIGATION_CONTEXT_TOOL,
  ADMIN_PRODUCT_COPY_CONTEXT_TOOL,
  ADMIN_PRODUCT_SEARCH_TOOL,
  chatMessageSchema,
  compactAdminChatText,
  isJsonRecord,
  latestUserChatText,
  type AdminAgentMcpSession,
  type AdminChatNavigateAction,
  type AdminChatNavigationEntry,
  type AdminChatProductCopyContext,
  type ApiContext,
  type JsonRecord,
} from "./ai-chat-contract";

export function safeAgentUserAgent(value: unknown): string | null {
  const compacted = compactAdminChatText(value, 256);
  if (!compacted) return null;
  const safe = compacted.replace(/[^\x20-\x7E]/g, "").trim();
  return safe || null;
}

export function compactAdminMcpProtocolVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const safe = value.replace(/[^\d.-]/g, "").trim();
  return safe ? safe.slice(0, 80) : null;
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

export async function parseAgentMcpJsonResponse(
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

export function safeAdminNavigationPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (!/^\/admin(?:\/[a-z0-9-]+)*$/.test(path)) return null;
  const segments = path.split("/").filter(Boolean);
  const resourceRoots = new Set([
    "attributes",
    "categories",
    "collections",
    "customers",
    "discounts",
    "inventory",
    "media",
    "orders",
    "pages",
    "products",
    "widgets",
  ]);
  if (segments.slice(1).some((segment) => /^\d+$/.test(segment))) return null;
  if (segments.length > 2 && resourceRoots.has(segments[1] ?? "")) return null;
  return path;
}

export function compactNavigationEntry(
  value: unknown,
  sectionLabel: unknown,
): AdminChatNavigationEntry | null {
  if (!isJsonRecord(value)) return null;
  const path = safeAdminNavigationPath(value.path);
  const name = compactAdminChatText(value.name, 80);
  const section = compactAdminChatText(sectionLabel, 80);
  if (!path || !name || !section) return null;
  return { path, name, section };
}

export function compactAdminNavigationEntries(
  body: unknown,
): AdminChatNavigationEntry[] {
  const response = isJsonRecord(body) ? body : null;
  const result = isJsonRecord(response?.result) ? response.result : null;
  if (!result || result.isError === true) return [];

  const structuredContent = isJsonRecord(result.structuredContent)
    ? result.structuredContent
    : null;
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

export function createAgentMcpHeaders(
  c: ApiContext,
  session?: AdminAgentMcpSession | null,
): Headers {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  });
  const cookie = c.req.header("cookie")?.trim();
  if (cookie) headers.set("Cookie", cookie);
  const userAgent = safeAgentUserAgent(c.req.header("user-agent"));
  if (userAgent) headers.set("User-Agent", userAgent);
  if (session?.sessionId) headers.set("Mcp-Session-Id", session.sessionId);
  if (session?.protocolVersion)
    headers.set("MCP-Protocol-Version", session.protocolVersion);
  return headers;
}

export async function initializeAdminAgentMcp(
  c: ApiContext,
): Promise<AdminAgentMcpSession | null> {
  const agent = c.env.ADMIN_AGENT;
  if (!agent || typeof agent.fetch !== "function") return null;

  try {
    const initializeResponse = await agent.fetch(ADMIN_AGENT_MCP_URL, {
      method: "POST",
      headers: createAgentMcpHeaders(c),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "admin-chat-navigation-initialize",
        method: "initialize",
        params: {
          protocolVersion: ADMIN_AGENT_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "scalius-api-admin-chat", version: "0.1.0" },
        },
      }),
      signal: c.req.raw.signal,
    });
    if (!initializeResponse.ok) return null;

    const initializeBody = await parseAgentMcpJsonResponse(initializeResponse);
    const initializeResult =
      isJsonRecord(initializeBody) && isJsonRecord(initializeBody.result)
        ? initializeBody.result
        : null;
    const protocolVersion = compactAdminMcpProtocolVersion(
      initializeResult?.protocolVersion,
    );
    const sessionId = compactAdminChatText(
      initializeResponse.headers.get("mcp-session-id"),
      160,
    );
    return {
      ...(protocolVersion ? { protocolVersion } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  } catch {
    return null;
  }
}

export async function callAdminAgentTool(
  c: ApiContext,
  session: AdminAgentMcpSession | null,
  toolName: string,
  toolArguments: JsonRecord,
  id: string,
): Promise<unknown | null> {
  const agent = c.env.ADMIN_AGENT;
  if (!agent || typeof agent.fetch !== "function" || !session) return null;

  try {
    const response = await agent.fetch(ADMIN_AGENT_MCP_URL, {
      method: "POST",
      headers: createAgentMcpHeaders(c, session),
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
    return parseAgentMcpJsonResponse(response);
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

export async function getAdminChatNavigationEntries(
  c: ApiContext,
  session: AdminAgentMcpSession | null,
): Promise<AdminChatNavigationEntry[]> {
  const body = await callAdminAgentTool(
    c,
    session,
    ADMIN_NAVIGATION_CONTEXT_TOOL,
    {},
    "admin-chat-navigation-context",
  );
  return compactAdminNavigationEntries(body);
}

export function hasProductCopyIntent(text: string): boolean {
  return (
    /\b(?:improve|rewrite|write|draft|generate|polish|optimi[sz]e|fix|make|update|better)\b/i.test(
      text,
    ) && /\b(?:product|description|copy|content|seo|listing)\b/i.test(text)
  );
}

export function extractProductTitleFromDashboardContext(
  messages: Array<z.infer<typeof chatMessageSchema>>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content ?? "";
    if (!content.includes("Current safe dashboard context")) continue;
    const match = content.match(/\btitle:\s*([^|,\n]+)/i);
    const title = compactAdminChatText(match?.[1], 120);
    if (title) return title;
  }
  return null;
}

export function extractProductIdFromDashboardContext(
  messages: Array<z.infer<typeof chatMessageSchema>>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content ?? "";
    if (!content.includes("Current safe dashboard context")) continue;
    const match = content.match(
      /\bRoute:\s*\/admin\/products\/([A-Za-z0-9_-]{1,160})\b/i,
    );
    const id = compactAdminChatText(match?.[1], 160);
    if (id) return id;
  }
  return null;
}

export function extractProductCopySearchQuery(
  messages: Array<z.infer<typeof chatMessageSchema>>,
): string | null {
  const latest = latestUserChatText(messages);
  if (!hasProductCopyIntent(latest)) return null;

  const cleaned = compactAdminChatText(
    latest
      .replace(/['’]s\b/gi, " ")
      .replace(/[?!.,"“”]+/g, " ")
      .replace(
        /\b(?:can|could|you|please|pls|improve|rewrite|write|draft|generate|polish|optimi[sz]e|fix|make|update|better|our|this|current|the|a|an|for|of|product|products|description|copy|content|seo|listing)\b/gi,
        " ",
      ),
    120,
  );
  if (cleaned && cleaned.length >= 2) return cleaned;
  return extractProductTitleFromDashboardContext(messages);
}

export function readAdminProductSearchCandidates(body: unknown): JsonRecord[] {
  const structuredContent = readMcpStructuredContent(body);
  const productSearch = isJsonRecord(structuredContent?.adminProductSearch)
    ? structuredContent.adminProductSearch
    : null;
  const products = Array.isArray(productSearch?.products)
    ? productSearch.products
    : [];
  return products.filter(isJsonRecord);
}

export function stripHtmlForAdminChat(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

export function readAdminProductDescriptionText(
  product: JsonRecord,
): string | null {
  const description =
    product.descriptionText ??
    product.currentDescription ??
    product.plainDescription ??
    product.descriptionExcerpt;
  if (typeof description === "string") return description;

  if (isJsonRecord(product.description)) {
    const content = product.description.content ?? product.description.excerpt;
    return typeof content === "string" ? content : null;
  }

  return typeof product.description === "string" ? product.description : null;
}

export function compactAdminProductCopyContext(
  body: unknown,
): AdminChatProductCopyContext | null {
  const structuredContent = readMcpStructuredContent(body);
  const copyContext = isJsonRecord(structuredContent?.adminProductCopyContext)
    ? structuredContent.adminProductCopyContext
    : null;
  const product = isJsonRecord(copyContext?.product)
    ? copyContext.product
    : copyContext;
  if (!product) return null;

  const id = compactAdminChatText(product.id, 120);
  const name = compactAdminChatText(product.name ?? product.title, 160);
  if (!id || !name) return null;

  const rawDescription = readAdminProductDescriptionText(product);
  const descriptionText = compactAdminChatText(
    typeof rawDescription === "string"
      ? stripHtmlForAdminChat(rawDescription)
      : null,
    ADMIN_CHAT_MAX_PRODUCT_DESCRIPTION_CHARS,
  );

  return {
    id,
    name,
    ...(compactAdminChatText(product.slug, 120)
      ? { slug: compactAdminChatText(product.slug, 120)! }
      : {}),
    ...(compactAdminChatText(product.route ?? product.path, 180)
      ? { route: compactAdminChatText(product.route ?? product.path, 180)! }
      : {}),
    ...(typeof product.isActive === "boolean"
      ? { status: product.isActive ? "active" : "draft" }
      : {}),
    ...(compactAdminChatText(product.status, 80)
      ? { status: compactAdminChatText(product.status, 80)! }
      : {}),
    ...(compactAdminChatText(product.categoryName, 120)
      ? { categoryName: compactAdminChatText(product.categoryName, 120)! }
      : {}),
    ...(descriptionText ? { descriptionText } : {}),
  };
}

export async function getAdminChatProductCopyContext(
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
      "admin-chat-product-copy-context",
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
    "admin-chat-product-search",
  );
  const [candidate] = readAdminProductSearchCandidates(searchBody);
  const id = compactAdminChatText(candidate?.id, 120);
  if (!id) return null;

  const copyBody = await callAdminAgentTool(
    c,
    session,
    ADMIN_PRODUCT_COPY_CONTEXT_TOOL,
    { id },
    "admin-chat-product-copy-context",
  );
  return compactAdminProductCopyContext(copyBody);
}

export function formatAdminChatProductCopyContext(
  context: AdminChatProductCopyContext | null,
): string | null {
  if (!context) return null;
  const lines = [
    "Read-only product copy context from verified admin read tools:",
    `Product: ${context.name} (${context.id})`,
    context.status ? `Status: ${context.status}` : null,
    context.categoryName ? `Category: ${context.categoryName}` : null,
    (context.route ?? context.slug)
      ? `Buyer route: ${context.route ?? `/products/${context.slug}`}`
      : null,
    context.descriptionText
      ? `Current description:\n${context.descriptionText}`
      : "Current description: not provided",
    "Use this context only to draft suggested copy. Do not say the description was saved or changed.",
  ].filter(Boolean);

  return compactAdminChatText(
    lines.join("\n"),
    ADMIN_CHAT_MAX_PRODUCT_COPY_CONTEXT_CHARS,
  );
}

export function formatAdminChatNavigationContext(
  entries: AdminChatNavigationEntry[],
): string | null {
  if (entries.length === 0) return null;
  const lines = entries.map(
    (entry) => `- ${entry.section} > ${entry.name}: ${entry.path}`,
  );
  return compactAdminChatText(
    [
      "Allowed dashboard destinations from the current admin session:",
      ...lines,
      "Only mention these destinations when relevant. Do not invent dashboard paths.",
    ].join("\n"),
    ADMIN_CHAT_MAX_NAVIGATION_CONTEXT_CHARS,
  );
}

export function formatAdminChatNavigationActionContext(
  actions: AdminChatNavigateAction[],
): string | null {
  if (actions.length === 0) return null;
  const lines = actions.map((action) => `- ${action.label}: ${action.path}`);
  return compactAdminChatText(
    [
      "Click-confirmed navigation action that will be shown beside this answer:",
      ...lines,
      "Tell the merchant they can use the visible action button. Do not say you cannot navigate, do not invent a different path, and do not imply the page was opened automatically.",
    ].join("\n"),
    500,
  );
}
