import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { adminToolError } from "./auth";
import {
  ADMIN_READ_ONLY_TOOL_ANNOTATIONS,
  ADMIN_PRODUCTS_MAX_STRING_LENGTH,
  adminApiHeaders,
  compactAdminPagination,
  compactBoolean,
  compactPlainText,
  compactString,
  compactTimestamp,
  failClosedStatus,
  isRecord,
  parseJsonResponse,
  setCompactBoolean,
  setCompactNumber,
  setCompactString,
  toolResult,
} from "./shared";
import type { AdminMcpOptions, Env, JsonRecord } from "./types";

const ADMIN_PRODUCTS_PATH = "/api/v1/admin/products";

const ADMIN_PRODUCT_DETAIL_PATH_TEMPLATE = "/api/v1/admin/products/{id}";

const ADMIN_PRODUCT_SEARCH_MAX_PRODUCTS = 10;

const ADMIN_PRODUCT_COPY_CONTEXT_DESCRIPTION_MAX_LENGTH = 14_000;

const ADMIN_PRODUCT_COPY_CONTEXT_EXCERPT_MAX_LENGTH = 600;

const adminProductSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(ADMIN_PRODUCT_SEARCH_MAX_PRODUCTS).default(5),
  page: z.number().int().min(1).max(20).default(1),
}).strict();

type AdminProductSearchInput = z.infer<typeof adminProductSearchInputSchema>;

const adminProductCopyContextInputSchema = z.object({
  id: z.string().trim().min(1).max(160),
}).strict();

type AdminProductCopyContextInput = z.infer<typeof adminProductCopyContextInputSchema>;

function adminProductToolError(
  code: string,
  query?: JsonRecord,
  status = 503,
): CallToolResult {
  return toolResult({
    adminProductSearch: {
      source: { path: ADMIN_PRODUCTS_PATH },
      ...(query ? { query } : {}),
      products: [],
      pagination: null,
      limits: {
        maxProducts: ADMIN_PRODUCT_SEARCH_MAX_PRODUCTS,
        includesTrashed: false,
        includesStock: false,
      },
    },
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin products are temporarily unavailable.",
    },
  }, true);
}

function adminProductCopyContextLimits(): JsonRecord {
  return {
    maxDescriptionLength: ADMIN_PRODUCT_COPY_CONTEXT_DESCRIPTION_MAX_LENGTH,
    maxDescriptionExcerptLength: ADMIN_PRODUCT_COPY_CONTEXT_EXCERPT_MAX_LENGTH,
    includesPrices: false,
    includesVariants: false,
    includesSku: false,
    includesStock: false,
    includesBarcodes: false,
    includesImages: false,
    includesDeletedFields: false,
    includesProviderPayloads: false,
    canMutate: false,
  };
}

function adminProductCopyContextToolError(
  code: string,
  request?: JsonRecord,
  status = 503,
): CallToolResult {
  return toolResult({
    adminProductCopyContext: {
      source: {
        path: ADMIN_PRODUCT_DETAIL_PATH_TEMPLATE,
        permission: "products.view",
      },
      ...(request ? { request } : {}),
      product: null,
      limits: adminProductCopyContextLimits(),
    },
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin product copy context is temporarily unavailable.",
    },
  }, true);
}

function compactAdminProduct(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const id = compactString(value.id);
  if (!id) return null;

  const product: JsonRecord = { id };
  setCompactString(product, "name", value.name);
  setCompactString(product, "slug", value.slug);
  setCompactBoolean(product, "isActive", value.isActive);

  const categoryName = compactString(
    value.categoryName ?? (isRecord(value.category) ? value.category.name : undefined),
  );
  if (categoryName) product.categoryName = categoryName;

  setCompactNumber(product, "variantCount", value.variantCount);
  setCompactNumber(product, "imageCount", value.imageCount);

  const updatedAt = compactTimestamp(value.updatedAt);
  if (updatedAt !== null) product.updatedAt = updatedAt;

  return product;
}

function compactProductRoute(slug: string, canonicalPath: unknown): string | null {
  const canonical = compactString(canonicalPath, 180);
  if (canonical && /^\/products\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(canonical)) {
    return canonical;
  }

  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(slug)
    ? `/products/${slug}`
    : null;
}

function compactAdminProductCopyContext(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const id = compactString(value.id, ADMIN_PRODUCTS_MAX_STRING_LENGTH);
  const name = compactString(value.name ?? value.title, ADMIN_PRODUCTS_MAX_STRING_LENGTH);
  const slug = compactString(value.slug, ADMIN_PRODUCTS_MAX_STRING_LENGTH);
  const isActive = compactBoolean(value.isActive);
  if (!id || !name || !slug || isActive === null) return null;

  const product: JsonRecord = {
    id,
    name,
    slug,
    isActive,
    status: isActive ? "active" : "draft",
  };

  const route = compactProductRoute(slug, value.canonicalPath);
  if (route) product.route = route;

  const categoryName = compactString(
    value.categoryName ?? (isRecord(value.category) ? value.category.name : undefined),
    ADMIN_PRODUCTS_MAX_STRING_LENGTH,
  );
  if (categoryName) product.categoryName = categoryName;

  const descriptionContent = compactPlainText(
    value.description,
    ADMIN_PRODUCT_COPY_CONTEXT_DESCRIPTION_MAX_LENGTH,
  ) ?? "";
  const descriptionExcerpt = descriptionContent.slice(
    0,
    ADMIN_PRODUCT_COPY_CONTEXT_EXCERPT_MAX_LENGTH,
  );
  product.description = {
    content: descriptionContent,
    excerpt: descriptionExcerpt,
  };

  return product;
}

function buildAdminProductSearchUrl(input: AdminProductSearchInput): { url: URL; query: JsonRecord } {
  const url = new URL(`http://api.internal${ADMIN_PRODUCTS_PATH}`);
  const query: JsonRecord = {
    query: input.query,
    page: input.page,
    limit: input.limit,
    sort: "updatedAt",
    order: "desc",
  };

  url.searchParams.set("search", input.query);
  url.searchParams.set("page", String(input.page));
  url.searchParams.set("limit", String(input.limit));
  url.searchParams.set("sort", "updatedAt");
  url.searchParams.set("order", "desc");

  return { url, query };
}

async function fetchAdminProductSearch(
  env: Env,
  input: AdminProductSearchInput,
  {
    cookie,
    userAgent,
    signal,
  }: {
    cookie: string;
    userAgent?: string | null;
    signal?: AbortSignal;
  },
): Promise<CallToolResult> {
  const { url, query } = buildAdminProductSearchUrl(input);
  if (!env.API || typeof env.API.fetch !== "function") {
    return adminProductToolError("admin_api_unavailable", query);
  }

  try {
    const response = await env.API.fetch(url, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminProductToolError("admin_product_unavailable", query, response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    if (!body || body.success !== true || !data || !Array.isArray(data.products)) {
      return adminProductToolError("admin_product_unavailable", query);
    }

    const pagination = compactAdminPagination(data.pagination);
    if (!pagination) {
      return adminProductToolError("admin_product_unavailable", query);
    }

    const products = data.products
      .map(compactAdminProduct)
      .filter((product): product is JsonRecord => product !== null)
      .slice(0, ADMIN_PRODUCT_SEARCH_MAX_PRODUCTS);

    return toolResult({
      adminProductSearch: {
        source: { path: ADMIN_PRODUCTS_PATH },
        query,
        products,
        pagination,
        limits: {
          maxProducts: ADMIN_PRODUCT_SEARCH_MAX_PRODUCTS,
          includesTrashed: false,
          includesStock: false,
        },
      },
    });
  } catch {
    return adminProductToolError("admin_product_unavailable", query);
  }
}

function buildAdminProductDetailUrl(input: AdminProductCopyContextInput): {
  url: URL;
  request: JsonRecord;
} {
  return {
    url: new URL(`http://api.internal${ADMIN_PRODUCTS_PATH}/${encodeURIComponent(input.id)}`),
    request: { id: input.id },
  };
}

async function fetchAdminProductCopyContext(
  env: Env,
  input: AdminProductCopyContextInput,
  {
    cookie,
    userAgent,
    signal,
  }: {
    cookie: string;
    userAgent?: string | null;
    signal?: AbortSignal;
  },
): Promise<CallToolResult> {
  const { url, request } = buildAdminProductDetailUrl(input);
  if (!env.API || typeof env.API.fetch !== "function") {
    return adminProductCopyContextToolError("admin_api_unavailable", request);
  }

  try {
    const response = await env.API.fetch(url, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminProductCopyContextToolError(
        "admin_product_copy_context_unavailable",
        request,
        response.status,
      );
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    const product = data ? compactAdminProductCopyContext(data) : null;
    if (!body || body.success !== true || !data || !product) {
      return adminProductCopyContextToolError("admin_product_copy_context_unavailable", request);
    }

    return toolResult({
      adminProductCopyContext: {
        source: {
          path: ADMIN_PRODUCT_DETAIL_PATH_TEMPLATE,
          permission: "products.view",
        },
        request,
        product,
        limits: adminProductCopyContextLimits(),
      },
    });
  } catch {
    return adminProductCopyContextToolError("admin_product_copy_context_unavailable", request);
  }
}

export function registerAdminProductTools(
  server: McpServer,
  env: Env,
  options: AdminMcpOptions,
): void {
  server.registerTool(
    "admin_product_search",
    {
      title: "Admin Product Search",
      description: "Searches the dashboard product list through API-verified permissions and returns compact product identifiers.",
      inputSchema: adminProductSearchInputSchema,
      annotations: ADMIN_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input, extra) => {
      const cookie = options.cookie?.trim() ? options.cookie : null;
      if (!cookie) {
        return adminToolError({
          ok: false,
          status: 401,
          code: "admin_session_required",
        });
      }

      return fetchAdminProductSearch(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );

  server.registerTool(
    "admin_product_copy_context",
    {
      title: "Admin Product Copy Context",
      description: "Reads bounded product copy context through API-verified product permissions.",
      inputSchema: adminProductCopyContextInputSchema,
      annotations: ADMIN_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (input, extra) => {
      const cookie = options.cookie?.trim() ? options.cookie : null;
      if (!cookie) {
        return adminToolError({
          ok: false,
          status: 401,
          code: "admin_session_required",
        });
      }

      return fetchAdminProductCopyContext(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );
}
