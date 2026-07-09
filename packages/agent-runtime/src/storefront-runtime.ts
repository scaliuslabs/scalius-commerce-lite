import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { registerStorefrontCartValidationTool, type FetchLike } from "./mcp/storefront/cart-validation";
import { registerStorefrontDiscoveryPolicyTool } from "./mcp/storefront/discovery-policy";
import { blandNotFoundResponse, jsonResponse, withNoStore } from "./http";
import type { StorefrontAgentRuntimeEnv } from "./runtime-env";
import {
  storefrontAgentPlatformProfileResponse,
  UCP_VERSION,
} from "./ucp/platform-profile";
import {
  STOREFRONT_CONVERSATION_AUDIENCE,
  STOREFRONT_CONVERSATION_AUDIENCE_HEADER,
  STOREFRONT_CONVERSATION_POLICY,
  STOREFRONT_CONVERSATION_SUBJECT_HEADER,
  isStorefrontConversationSubject,
} from "./conversation/contracts";
import {
  matchInternalConversationRoute,
  proxyInternalConversationRequest,
} from "./conversation/router";

export type { StorefrontAgentRuntimeEnv } from "./runtime-env";

export type { FetchLike } from "./mcp/storefront/cart-validation";

export const DEFAULT_STOREFRONT_URL = "https://storefront.scalius.com";
export const DEFAULT_AGENT_PROFILE_URL = "https://agent.scalius.com/.well-known/ucp";
export const STOREFRONT_AGENT_INTERNAL_ORIGIN = "http://storefront-agent.internal";
export { UCP_VERSION } from "./ucp/platform-profile";

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const PUBLIC_CATEGORIES_PATH = "/api/v1/categories";
const CATALOG_CATEGORIES_DEFAULT_LIMIT = 25;
const CATALOG_CATEGORIES_MAX_LIMIT = 50;
const CATALOG_CATEGORY_DESCRIPTION_MAX_LENGTH = 240;
const CATALOG_CATEGORY_TEXT_MAX_LENGTH = 160;

const GENERIC_UPSTREAM_ERROR = {
  ucp: { status: "error", version: UCP_VERSION },
  messages: [
    {
      type: "error",
      code: "temporarily_unavailable",
      content: "Storefront catalog is temporarily unavailable.",
      severity: "recoverable",
    },
  ],
};

const FORBIDDEN_UCP_PROFILE_CAPABILITY_TOKENS = new Set([
  "cart",
  "carts",
  "checkout",
  "checkouts",
  "customer",
  "customers",
  "fulfillment",
  "fulfillments",
  "mutation",
  "mutations",
  "order",
  "orders",
  "payment",
  "payments",
  "recovery",
  "recoveries",
]);

export interface StorefrontCatalogMcpOptions {
  fetchImpl?: FetchLike;
}

type JsonRecord = Record<string, unknown>;

const catalogCategoriesInputSchema = z.object({
  limit: z.number()
    .int()
    .min(1)
    .max(CATALOG_CATEGORIES_MAX_LIMIT)
    .default(CATALOG_CATEGORIES_DEFAULT_LIMIT)
    .describe("Maximum categories to return."),
  slug: z.string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Optional public category slug to read."),
}).strict();

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFallback(body: JsonRecord): string {
  return JSON.stringify(body, null, 2);
}

function toolResult(body: JsonRecord, isError = false): CallToolResult {
  return {
    structuredContent: body,
    content: [{ type: "text", text: textFallback(body) }],
    ...(isError ? { isError: true } : {}),
  };
}

function genericToolError(code = "temporarily_unavailable"): CallToolResult {
  return toolResult({
    ...GENERIC_UPSTREAM_ERROR,
    messages: GENERIC_UPSTREAM_ERROR.messages.map((message) => ({ ...message, code })),
  }, true);
}

function tokenizeCapabilityName(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isForbiddenUcpProfileCapabilityName(value: string): boolean {
  const tokens = tokenizeCapabilityName(value);
  return tokens.some((token) => FORBIDDEN_UCP_PROFILE_CAPABILITY_TOKENS.has(token));
}

function containsForbiddenUcpProfileCapability(value: unknown): boolean {
  if (typeof value === "string") {
    return isForbiddenUcpProfileCapabilityName(value);
  }

  if (Array.isArray(value)) {
    return value.some((item) =>
      typeof item === "string" && isForbiddenUcpProfileCapabilityName(item)
    );
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).some(([key, item]) =>
    isForbiddenUcpProfileCapabilityName(key) ||
    (Array.isArray(item) && item.some((arrayItem) =>
      typeof arrayItem === "string" && isForbiddenUcpProfileCapabilityName(arrayItem)
    ))
  );
}

function hasAdvertisedPaymentHandlers(value: unknown): boolean {
  if (value == null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function hasForbiddenUcpProfileAdvertisement(body: JsonRecord): boolean {
  const ucp = isRecord(body.ucp) ? body.ucp : {};
  const capabilityBranches = [
    ucp.capabilities,
    body.capabilities,
  ];

  if (capabilityBranches.some((branch) => containsForbiddenUcpProfileCapability(branch))) {
    return true;
  }

  return [
    ucp.payment_handlers,
    ucp.paymentHandlers,
    body.payment_handlers,
    body.paymentHandlers,
  ].some((branch) => hasAdvertisedPaymentHandlers(branch));
}

export function resolveStorefrontBaseUrl(
  env: Pick<StorefrontAgentRuntimeEnv, "STOREFRONT_URL">,
): string {
  const configured = env.STOREFRONT_URL?.trim() || DEFAULT_STOREFRONT_URL;
  const parsed = new URL(configured);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("STOREFRONT_URL must be an absolute http(s) URL");
  }

  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function resolveAgentProfileUrl(
  env: Pick<StorefrontAgentRuntimeEnv, "AGENT_PROFILE_URL">,
): string {
  const configured = env.AGENT_PROFILE_URL?.trim();
  if (!configured) return DEFAULT_AGENT_PROFILE_URL;

  try {
    const parsed = new URL(configured);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash) {
      return parsed.toString();
    }
  } catch {
    return DEFAULT_AGENT_PROFILE_URL;
  }

  return DEFAULT_AGENT_PROFILE_URL;
}

function ucpAgentHeader(
  env: Pick<StorefrontAgentRuntimeEnv, "AGENT_PROFILE_URL">,
): string {
  return `profile="${resolveAgentProfileUrl(env)}"`;
}

function isUcpApplicationError(status: number, body: JsonRecord): boolean {
  const ucp = isRecord(body.ucp) ? body.ucp : null;
  return status >= 400 || ucp?.status === "error";
}

async function parseJsonResponse(response: Response): Promise<JsonRecord | null> {
  try {
    const body = await response.json();
    return isRecord(body) ? body : { value: body };
  } catch {
    return null;
  }
}

async function callStorefrontUcp(
  env: StorefrontAgentRuntimeEnv,
  path: string,
  init: {
    method: "GET" | "POST";
    body?: JsonRecord;
    signal?: AbortSignal;
  },
  fetchImpl: FetchLike,
  options: {
    validateBody?: (body: JsonRecord) => CallToolResult | null;
  } = {},
): Promise<CallToolResult> {
  let url: URL;
  try {
    url = new URL(path, `${resolveStorefrontBaseUrl(env)}/`);
  } catch {
    return genericToolError("upstream_config_invalid");
  }

  try {
    const headers = new Headers({
      Accept: "application/json",
      "UCP-Agent": ucpAgentHeader(env),
    });
    if (init.method === "POST") {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetchImpl(url, {
      method: init.method,
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
    const body = await parseJsonResponse(response);
    if (!body) {
      return genericToolError("upstream_response_invalid");
    }

    const validationError = options.validateBody?.(body);
    if (validationError) return validationError;

    return toolResult(body, isUcpApplicationError(response.status, body));
  } catch {
    return genericToolError();
  }
}

function validateCatalogProfileBody(body: JsonRecord): CallToolResult | null {
  if (!hasForbiddenUcpProfileAdvertisement(body)) return null;
  return genericToolError("ucp_profile_not_catalog_only");
}

function compactString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function compactPlainText(value: unknown, maxLength: number): string | null {
  const text = compactString(value, 10_000);
  if (!text) return null;

  const plain = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

  return plain ? plain.slice(0, maxLength) : null;
}

function safeCategoryCanonicalPath(value: unknown): string | null {
  const path = compactString(value, CATALOG_CATEGORY_TEXT_MAX_LENGTH);
  if (!path) return null;
  if (!/^\/categories\/[A-Za-z0-9][A-Za-z0-9_-]*$/.test(path)) return null;
  return path;
}

function categoryPath(slug: string, canonicalPath: unknown): string {
  return safeCategoryCanonicalPath(canonicalPath) ?? `/categories/${encodeURIComponent(slug)}`;
}

function categoryUrl(env: StorefrontAgentRuntimeEnv, path: string): string | null {
  try {
    return `${resolveStorefrontBaseUrl(env)}${path}`;
  } catch {
    return null;
  }
}

function compactCategory(
  value: unknown,
  env: StorefrontAgentRuntimeEnv,
): JsonRecord | null {
  if (!isRecord(value)) return null;

  const id = compactString(value.id, CATALOG_CATEGORY_TEXT_MAX_LENGTH);
  const name = compactString(value.name, CATALOG_CATEGORY_TEXT_MAX_LENGTH);
  const slug = compactString(value.slug, 100);
  if (!id || !name || !slug) return null;

  const path = categoryPath(slug, value.canonicalPath);
  const compact: JsonRecord = {
    id,
    name,
    slug,
    path,
  };

  const url = categoryUrl(env, path);
  if (url) compact.url = url;

  const description = compactPlainText(value.description, CATALOG_CATEGORY_DESCRIPTION_MAX_LENGTH);
  if (description) compact.description = description;

  const updatedAt = compactString(value.updatedAt, CATALOG_CATEGORY_TEXT_MAX_LENGTH);
  if (updatedAt) compact.updatedAt = updatedAt;

  const discovery: JsonRecord = {};
  if (typeof value.noIndex === "boolean") discovery.noIndex = value.noIndex;
  if (typeof value.excludeFromSitemap === "boolean") {
    discovery.excludeFromSitemap = value.excludeFromSitemap;
  }
  if (Object.keys(discovery).length > 0) compact.discovery = discovery;

  return compact;
}

function catalogCategoriesToolError(): CallToolResult {
  return toolResult({
    catalogCategories: {
      categories: [],
    },
    error: {
      code: "temporarily_unavailable",
      message: "Storefront categories are temporarily unavailable.",
    },
  }, true);
}

async function callPublicCategoriesApi(
  env: StorefrontAgentRuntimeEnv,
  {
    limit,
    slug,
    signal,
  }: {
    limit: number;
    slug?: string;
    signal?: AbortSignal;
  },
): Promise<CallToolResult> {
  if (!env.API || typeof env.API.fetch !== "function") {
    return catalogCategoriesToolError();
  }

  const url = new URL(`http://api.internal${PUBLIC_CATEGORIES_PATH}`);
  if (slug) {
    url.pathname = `${PUBLIC_CATEGORIES_PATH}/${encodeURIComponent(slug)}`;
  }

  try {
    const response = await env.API.fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal,
    });
    const body = await parseJsonResponse(response);
    if (!body || !response.ok || body.success !== true || !isRecord(body.data)) {
      return catalogCategoriesToolError();
    }

    const rawCategories = slug
      ? (isRecord(body.data.category) ? [body.data.category] : null)
      : (Array.isArray(body.data.categories) ? body.data.categories : null);
    if (!rawCategories) return catalogCategoriesToolError();

    const categories = rawCategories
      .map((category) => compactCategory(category, env))
      .filter((category): category is JsonRecord => category !== null)
      .slice(0, slug ? 1 : limit);

    return toolResult({
      catalogCategories: {
        categories,
      },
    });
  } catch {
    return catalogCategoriesToolError();
  }
}

export function createStorefrontCatalogMcpServer(
  env: StorefrontAgentRuntimeEnv,
  options: StorefrontCatalogMcpOptions = {},
): McpServer {
  const fetchImpl = options.fetchImpl ?? fetch;
  const server = new McpServer({
    name: env.AGENT_NAME?.trim() || "scalius-storefront-catalog-agent",
    version: env.AGENT_VERSION?.trim() || "0.1.0",
  });

  server.registerTool(
    "catalog_search",
    {
      title: "Catalog Search",
      description: "Searches the public storefront catalog. Returns UCP catalog search JSON.",
      inputSchema: {
        query: z.string().trim().min(1).max(160).describe("Search text."),
        limit: z.number().int().min(1).max(10).default(5).describe("Maximum products to return."),
        cursor: z.string().trim().min(1).max(64).optional().describe("Opaque catalog page cursor."),
        category: z.string().trim().min(1).max(120).optional().describe("Optional merchant category name or slug."),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ query, limit, cursor, category }, extra) => {
      const body: JsonRecord = {
        ucp: { version: UCP_VERSION },
        query,
        pagination: {
          limit,
          ...(cursor ? { cursor } : {}),
        },
        ...(category ? { filters: { categories: [category] } } : {}),
      };

      return callStorefrontUcp(env, "/ucp/catalog/search", {
        method: "POST",
        body,
        signal: extra.signal,
      }, fetchImpl);
    },
  );

  server.registerTool(
    "catalog_lookup",
    {
      title: "Catalog Lookup",
      description: "Looks up public catalog products or variants by id, SKU, handle, or product URL. Returns UCP catalog lookup JSON.",
      inputSchema: {
        ids: z.array(z.string().trim().min(1).max(220)).min(1).max(10).describe("Product, variant, SKU, handle, or product URL identifiers."),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ ids }, extra) =>
      callStorefrontUcp(env, "/ucp/catalog/lookup", {
        method: "POST",
        body: {
          ucp: { version: UCP_VERSION },
          ids,
        },
        signal: extra.signal,
      }, fetchImpl),
  );

  server.registerTool(
    "catalog_product",
    {
      title: "Catalog Product",
      description: "Reads one public catalog product detail by product id, variant id, SKU, handle, or product URL. Returns UCP product JSON.",
      inputSchema: {
        id: z.string().trim().min(1).max(220).describe("Product, variant, SKU, handle, or product URL identifier."),
        selected: z.array(z.object({
          name: z.string().trim().min(1).max(80),
          label: z.string().trim().min(1).max(120),
        })).max(4).optional().describe("Optional selected variant options."),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ id, selected }, extra) =>
      callStorefrontUcp(env, "/ucp/catalog/product", {
        method: "POST",
        body: {
          ucp: { version: UCP_VERSION },
          id,
          ...(selected ? { selected } : {}),
        },
        signal: extra.signal,
      }, fetchImpl),
  );

  server.registerTool(
    "catalog_categories",
    {
      title: "Catalog Categories",
      description: "Reads compact public storefront category discovery data.",
      inputSchema: catalogCategoriesInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ limit, slug }, extra) =>
      callPublicCategoriesApi(env, {
        limit,
        slug,
        signal: extra.signal,
      }),
  );

  server.registerTool(
    "catalog_profile",
    {
      title: "Catalog Profile",
      description: "Reads the public UCP catalog discovery profile from the storefront.",
      inputSchema: {},
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (_args, extra) =>
      callStorefrontUcp(env, "/.well-known/ucp", {
        method: "GET",
        signal: extra.signal,
      }, fetchImpl, {
        validateBody: validateCatalogProfileBody,
      }),
  );

  registerStorefrontCartValidationTool(server, {
    fetchImpl,
    resolveStorefrontBaseUrl: () => resolveStorefrontBaseUrl(env),
  });
  registerStorefrontDiscoveryPolicyTool(server, env);

  return server;
}

export function createStorefrontAgentWorker(
  options: StorefrontCatalogMcpOptions = {},
) {
  return {
    async fetch(
      request: Request,
      env: StorefrontAgentRuntimeEnv,
      ctx: ExecutionContext,
    ): Promise<Response> {
      const url = new URL(request.url);

      const conversationRoute = matchInternalConversationRoute(
        request,
        STOREFRONT_AGENT_INTERNAL_ORIGIN,
      );
      if (conversationRoute) {
        if (request.headers.has("Cookie") || request.headers.has("Authorization")) {
          return jsonResponse({
            success: false,
            error: {
              code: "storefront_conversation_credentials_forbidden",
              message: "Storefront conversation facades must exchange browser credentials before forwarding.",
            },
          }, 400);
        }
        const audience = request.headers.get(STOREFRONT_CONVERSATION_AUDIENCE_HEADER);
        const subject = request.headers.get(STOREFRONT_CONVERSATION_SUBJECT_HEADER)?.trim() ?? "";
        if (
          audience !== STOREFRONT_CONVERSATION_AUDIENCE ||
          !isStorefrontConversationSubject(subject)
        ) {
          return jsonResponse({
            success: false,
            error: {
              code: "storefront_conversation_subject_required",
              message: "Storefront conversation access requires an API-verified opaque subject.",
            },
          }, 401);
        }
        return proxyInternalConversationRequest({
          request,
          route: conversationRoute,
          namespace: env.STOREFRONT_CONVERSATIONS,
          policy: STOREFRONT_CONVERSATION_POLICY,
          subject,
        });
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          success: true,
          status: "ok",
          service: "scalius-storefront-agent",
        });
      }

      if (
        (request.method === "GET" || request.method === "HEAD") &&
        url.pathname === "/.well-known/ucp" &&
        url.search === "" &&
        url.hash === ""
      ) {
        return storefrontAgentPlatformProfileResponse(request.method);
      }

      if (url.pathname === "/mcp") {
        const { createMcpHandler } = await import("agents/mcp");
        const server = createStorefrontCatalogMcpServer(env, options);
        const response = await createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
        return withNoStore(response);
      }

      return blandNotFoundResponse();
    },
  } satisfies ExportedHandler<StorefrontAgentRuntimeEnv>;
}
