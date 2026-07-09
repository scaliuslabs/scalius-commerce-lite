import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { adminToolError } from "./auth";
import {
  ADMIN_READ_ONLY_TOOL_ANNOTATIONS,
  adminApiHeaders,
  compactAdminPagination,
  compactString,
  failClosedStatus,
  isRecord,
  parseJsonResponse,
  setCompactBoolean,
  setCompactNumber,
  setCompactString,
  setCompactTimestamp,
  toolResult,
} from "./shared";
import type { AdminMcpOptions, Env, JsonRecord } from "./types";

const ADMIN_CATEGORIES_PATH = "/api/v1/admin/categories";

const ADMIN_COLLECTIONS_PATH = "/api/v1/admin/collections";

const ADMIN_PAGES_PATH = "/api/v1/admin/pages";

const ADMIN_CATEGORY_SEARCH_MAX_CATEGORIES = 10;

const ADMIN_COLLECTION_SEARCH_MAX_COLLECTIONS = 10;

const ADMIN_PAGE_SEARCH_MAX_PAGES = 10;

const ADMIN_CATEGORIES_MAX_STRING_LENGTH = 220;

const ADMIN_COLLECTIONS_MAX_STRING_LENGTH = 220;

const ADMIN_PAGES_MAX_STRING_LENGTH = 220;

const RESERVED_PAGE_CANONICAL_SEGMENTS = new Set([
  "account",
  "admin",
  "api",
  "buy",
  "cart",
  "categories",
  "checkout",
  "collections",
  "health",
  "404",
  "500",
  "order-success",
  "payment-recovery",
  "products",
  "robots.txt",
  "search",
  "sitemap.xml",
]);

const adminCategorySearchInputSchema = z.object({
  query: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(ADMIN_CATEGORY_SEARCH_MAX_CATEGORIES).default(5),
  page: z.number().int().min(1).max(20).default(1),
}).strict();

type AdminCategorySearchInput = z.infer<typeof adminCategorySearchInputSchema>;

const adminCollectionSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(ADMIN_COLLECTION_SEARCH_MAX_COLLECTIONS).default(5),
  page: z.number().int().min(1).max(20).default(1),
}).strict();

type AdminCollectionSearchInput = z.infer<typeof adminCollectionSearchInputSchema>;

const adminPageSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(ADMIN_PAGE_SEARCH_MAX_PAGES).default(5),
  page: z.number().int().min(1).max(20).default(1),
}).strict();

type AdminPageSearchInput = z.infer<typeof adminPageSearchInputSchema>;

function adminCategoryToolError(
  code: string,
  query?: JsonRecord,
  status = 503,
): CallToolResult {
  return toolResult({
    adminCategorySearch: {
      source: { path: ADMIN_CATEGORIES_PATH },
      ...(query ? { query } : {}),
      categories: [],
      pagination: null,
      limits: {
        maxCategories: ADMIN_CATEGORY_SEARCH_MAX_CATEGORIES,
        includesTrashed: false,
        includesDescriptions: false,
        includesMetaText: false,
        includesRawImages: false,
      },
    },
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin categories are temporarily unavailable.",
    },
  }, true);
}

function adminCollectionToolError(
  code: string,
  query?: JsonRecord,
  status = 503,
): CallToolResult {
  return toolResult({
    adminCollectionSearch: {
      source: { path: ADMIN_COLLECTIONS_PATH },
      ...(query ? { query } : {}),
      collections: [],
      pagination: null,
      limits: {
        maxCollections: ADMIN_COLLECTION_SEARCH_MAX_COLLECTIONS,
        includesTrashed: false,
        includesProducts: false,
        includesDescriptions: false,
        includesMetaText: false,
        includesRawImages: false,
        includesDeletedFields: false,
      },
    },
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin collections are temporarily unavailable.",
    },
  }, true);
}

function adminPageToolError(
  code: string,
  query?: JsonRecord,
  status = 503,
): CallToolResult {
  return toolResult({
    adminPageSearch: {
      source: { path: ADMIN_PAGES_PATH },
      ...(query ? { query } : {}),
      pages: [],
      pagination: null,
      limits: {
        maxPages: ADMIN_PAGE_SEARCH_MAX_PAGES,
        includesTrashed: false,
        includesContent: false,
        includesMetaText: false,
        includesRawImages: false,
        includesDeletedFields: false,
      },
    },
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin pages are temporarily unavailable.",
    },
  }, true);
}

function compactCategoryCanonicalPath(value: unknown): string | null {
  const canonicalPath = compactString(value, 160);
  if (!canonicalPath) return null;
  return /^\/categories\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(canonicalPath)
    ? canonicalPath
    : null;
}

function compactAdminCategory(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const id = compactString(value.id, ADMIN_CATEGORIES_MAX_STRING_LENGTH);
  if (!id) return null;

  const category: JsonRecord = { id };
  setCompactString(category, "name", value.name, ADMIN_CATEGORIES_MAX_STRING_LENGTH);
  setCompactString(category, "slug", value.slug, ADMIN_CATEGORIES_MAX_STRING_LENGTH);
  setCompactNumber(category, "productCount", value.productCount);

  setCompactBoolean(category, "noIndex", value.noIndex);
  setCompactBoolean(category, "excludeFromSitemap", value.excludeFromSitemap);

  const canonicalPath = compactCategoryCanonicalPath(value.canonicalPath);
  if (canonicalPath) category.canonicalPath = canonicalPath;

  setCompactTimestamp(category, "updatedAt", value.updatedAt);

  return category;
}

function compactCollectionCanonicalPath(value: unknown, id: string): string | null {
  const canonicalPath = compactString(value, 180);
  if (!canonicalPath) return null;
  return canonicalPath === `/collections/${id}` &&
    /^\/collections\/[A-Za-z0-9_-]{1,128}$/.test(canonicalPath)
    ? canonicalPath
    : null;
}

function compactAdminCollection(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const id = compactString(value.id, ADMIN_COLLECTIONS_MAX_STRING_LENGTH);
  if (!id) return null;

  const collection: JsonRecord = { id };
  setCompactString(collection, "name", value.name, ADMIN_COLLECTIONS_MAX_STRING_LENGTH);
  setCompactNumber(collection, "productCount", value.productCount);

  setCompactBoolean(collection, "noIndex", value.noIndex);
  setCompactBoolean(collection, "excludeFromSitemap", value.excludeFromSitemap);

  const canonicalPath = compactCollectionCanonicalPath(value.canonicalPath, id);
  if (canonicalPath) collection.canonicalPath = canonicalPath;

  setCompactTimestamp(collection, "updatedAt", value.updatedAt);

  return collection;
}

function compactPageCanonicalPath(value: unknown): string | null {
  const canonicalPath = compactString(value, 180);
  if (!canonicalPath) return null;
  if (!/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(canonicalPath)) return null;
  const segment = canonicalPath.slice(1);
  return RESERVED_PAGE_CANONICAL_SEGMENTS.has(segment) ? null : canonicalPath;
}

function compactAdminPage(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const id = compactString(value.id, ADMIN_PAGES_MAX_STRING_LENGTH);
  if (!id) return null;

  const slug = compactString(value.slug, ADMIN_PAGES_MAX_STRING_LENGTH);
  const page: JsonRecord = { id };
  setCompactString(page, "title", value.title, ADMIN_PAGES_MAX_STRING_LENGTH);
  if (slug) page.slug = slug;

  setCompactBoolean(page, "isPublished", value.isPublished);
  setCompactBoolean(page, "noIndex", value.noIndex);
  setCompactBoolean(page, "excludeFromSitemap", value.excludeFromSitemap);

  const canonicalPath = compactPageCanonicalPath(value.canonicalPath);
  if (canonicalPath) page.canonicalPath = canonicalPath;

  setCompactBoolean(page, "hideHeader", value.hideHeader);
  setCompactBoolean(page, "hideFooter", value.hideFooter);
  setCompactBoolean(page, "hideTitle", value.hideTitle);
  setCompactTimestamp(page, "publishedAt", value.publishedAt);
  setCompactTimestamp(page, "updatedAt", value.updatedAt);

  return page;
}

function buildAdminCategorySearchUrl(input: AdminCategorySearchInput): { url: URL; query: JsonRecord } {
  const url = new URL(`http://api.internal${ADMIN_CATEGORIES_PATH}`);
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

async function fetchAdminCategorySearch(
  env: Env,
  input: AdminCategorySearchInput,
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
  const { url, query } = buildAdminCategorySearchUrl(input);
  if (!env.API || typeof env.API.fetch !== "function") {
    return adminCategoryToolError("admin_api_unavailable", query);
  }

  try {
    const response = await env.API.fetch(url, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminCategoryToolError("admin_category_unavailable", query, response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    if (!body || body.success !== true || !data || !Array.isArray(data.categories)) {
      return adminCategoryToolError("admin_category_unavailable", query);
    }

    const pagination = compactAdminPagination(data.pagination);
    if (!pagination) {
      return adminCategoryToolError("admin_category_unavailable", query);
    }

    const categories = data.categories
      .map(compactAdminCategory)
      .filter((category): category is JsonRecord => category !== null)
      .slice(0, ADMIN_CATEGORY_SEARCH_MAX_CATEGORIES);

    return toolResult({
      adminCategorySearch: {
        source: { path: ADMIN_CATEGORIES_PATH },
        query,
        categories,
        pagination,
        limits: {
          maxCategories: ADMIN_CATEGORY_SEARCH_MAX_CATEGORIES,
          includesTrashed: false,
          includesDescriptions: false,
          includesMetaText: false,
          includesRawImages: false,
        },
      },
    });
  } catch {
    return adminCategoryToolError("admin_category_unavailable", query);
  }
}

function buildAdminCollectionSearchUrl(input: AdminCollectionSearchInput): { url: URL; query: JsonRecord } {
  const url = new URL(`http://api.internal${ADMIN_COLLECTIONS_PATH}`);
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

async function fetchAdminCollectionSearch(
  env: Env,
  input: AdminCollectionSearchInput,
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
  const { url, query } = buildAdminCollectionSearchUrl(input);
  if (!env.API || typeof env.API.fetch !== "function") {
    return adminCollectionToolError("admin_api_unavailable", query);
  }

  try {
    const response = await env.API.fetch(url, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminCollectionToolError("admin_collection_unavailable", query, response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    if (!body || body.success !== true || !data || !Array.isArray(data.collections)) {
      return adminCollectionToolError("admin_collection_unavailable", query);
    }

    const pagination = compactAdminPagination(data.pagination);
    if (!pagination) {
      return adminCollectionToolError("admin_collection_unavailable", query);
    }

    const collections = data.collections
      .map(compactAdminCollection)
      .filter((collection): collection is JsonRecord => collection !== null)
      .slice(0, ADMIN_COLLECTION_SEARCH_MAX_COLLECTIONS);

    return toolResult({
      adminCollectionSearch: {
        source: { path: ADMIN_COLLECTIONS_PATH },
        query,
        collections,
        pagination,
        limits: {
          maxCollections: ADMIN_COLLECTION_SEARCH_MAX_COLLECTIONS,
          includesTrashed: false,
          includesProducts: false,
          includesDescriptions: false,
          includesMetaText: false,
          includesRawImages: false,
          includesDeletedFields: false,
        },
      },
    });
  } catch {
    return adminCollectionToolError("admin_collection_unavailable", query);
  }
}

function buildAdminPageSearchUrl(input: AdminPageSearchInput): { url: URL; query: JsonRecord } {
  const url = new URL(`http://api.internal${ADMIN_PAGES_PATH}`);
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

async function fetchAdminPageSearch(
  env: Env,
  input: AdminPageSearchInput,
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
  const { url, query } = buildAdminPageSearchUrl(input);
  if (!env.API || typeof env.API.fetch !== "function") {
    return adminPageToolError("admin_api_unavailable", query);
  }

  try {
    const response = await env.API.fetch(url, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminPageToolError("admin_page_unavailable", query, response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    if (!body || body.success !== true || !data || !Array.isArray(data.pages)) {
      return adminPageToolError("admin_page_unavailable", query);
    }

    const pagination = compactAdminPagination(data.pagination);
    if (!pagination) {
      return adminPageToolError("admin_page_unavailable", query);
    }

    const pages = data.pages
      .map(compactAdminPage)
      .filter((page): page is JsonRecord => page !== null)
      .slice(0, ADMIN_PAGE_SEARCH_MAX_PAGES);

    return toolResult({
      adminPageSearch: {
        source: { path: ADMIN_PAGES_PATH },
        query,
        pages,
        pagination,
        limits: {
          maxPages: ADMIN_PAGE_SEARCH_MAX_PAGES,
          includesTrashed: false,
          includesContent: false,
          includesMetaText: false,
          includesRawImages: false,
          includesDeletedFields: false,
        },
      },
    });
  } catch {
    return adminPageToolError("admin_page_unavailable", query);
  }
}

export function registerAdminContentTools(
  server: McpServer,
  env: Env,
  options: AdminMcpOptions,
): void {
  server.registerTool(
    "admin_category_search",
    {
      title: "Admin Category Search",
      description: "Searches the dashboard category list through API-verified permissions and returns compact category identifiers.",
      inputSchema: adminCategorySearchInputSchema,
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

      return fetchAdminCategorySearch(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );

  server.registerTool(
    "admin_collection_search",
    {
      title: "Admin Collection Search",
      description: "Searches the dashboard collection list through API-verified permissions and returns compact collection identifiers.",
      inputSchema: adminCollectionSearchInputSchema,
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

      return fetchAdminCollectionSearch(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );

  server.registerTool(
    "admin_page_search",
    {
      title: "Admin Page Search",
      description: "Searches the dashboard CMS page list through API-verified permissions and returns compact page identifiers.",
      inputSchema: adminPageSearchInputSchema,
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

      return fetchAdminPageSearch(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );
}
