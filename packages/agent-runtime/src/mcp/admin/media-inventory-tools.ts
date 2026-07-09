import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { adminToolError } from "./auth";
import {
  ADMIN_READ_ONLY_TOOL_ANNOTATIONS,
  adminApiHeaders,
  compactAdminPagination,
  compactNumber,
  compactString,
  failClosedStatus,
  isRecord,
  parseJsonResponse,
  setCompactNumber,
  setCompactString,
  setCompactTimestamp,
  toolResult,
} from "./shared";
import type { AdminMcpOptions, Env, JsonRecord } from "./types";

const ADMIN_MEDIA_PATH = "/api/v1/admin/media";

const ADMIN_INVENTORY_PATH = "/api/v1/admin/inventory";

const ADMIN_MEDIA_SEARCH_MAX_FILES = 10;

const ADMIN_INVENTORY_LOOKUP_MAX_VARIANTS = 10;

const ADMIN_MEDIA_MAX_STRING_LENGTH = 220;

const ADMIN_INVENTORY_MAX_STRING_LENGTH = 220;

const adminMediaSearchInputSchema = z.object({
  query: z.string().trim().max(120).optional(),
  limit: z.number().int().min(1).max(ADMIN_MEDIA_SEARCH_MAX_FILES).default(5),
  page: z.number().int().min(1).max(20).default(1),
  folderId: z.string().trim().max(160).optional(),
  mimeType: z.string().trim().max(80).optional(),
}).strict();

type AdminMediaSearchInput = z.infer<typeof adminMediaSearchInputSchema>;

const adminInventoryLookupInputSchema = z.object({
  query: z.string().trim().max(120).optional(),
  limit: z.number().int().min(1).max(ADMIN_INVENTORY_LOOKUP_MAX_VARIANTS).default(5),
  page: z.number().int().min(1).max(20).default(1),
  status: z.enum(["all", "low", "out", "reserved"]).default("all"),
  sort: z.enum(["available", "sku", "productName"]).default("available"),
  order: z.enum(["asc", "desc"]).default("asc"),
}).strict();

type AdminInventoryLookupInput = z.infer<typeof adminInventoryLookupInputSchema>;

function adminMediaToolError(
  code: string,
  query?: JsonRecord,
  status = 503,
): CallToolResult {
  return toolResult({
    adminMediaSearch: {
      source: { path: ADMIN_MEDIA_PATH },
      ...(query ? { query } : {}),
      files: [],
      pagination: null,
      limits: {
        maxFiles: ADMIN_MEDIA_SEARCH_MAX_FILES,
        includesDeletedFields: false,
        includesStorageKeys: false,
        includesUploadMetadata: false,
        includesMutationAuthority: false,
      },
    },
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin media are temporarily unavailable.",
    },
  }, true);
}

function adminInventoryToolError(
  code: string,
  query?: JsonRecord,
  status = 503,
): CallToolResult {
  return toolResult({
    adminInventoryLookup: {
      source: { path: ADMIN_INVENTORY_PATH },
      ...(query ? { query } : {}),
      variants: [],
      pagination: null,
      stats: null,
      limits: {
        maxVariants: ADMIN_INVENTORY_LOOKUP_MAX_VARIANTS,
        section: "variants",
        includesMovements: false,
        includesAlerts: false,
        includesBarcode: false,
        includesPrices: false,
        includesVersion: false,
        canMutateStock: false,
      },
    },
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin inventory is temporarily unavailable.",
    },
  }, true);
}

function compactSafeMediaUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (!url) return null;
  if (url.length > 1000) return null;
  if (/[\s\\]/.test(url)) return null;
  if (url.includes("?") || url.includes("#")) return null;

  if (url.startsWith("/")) {
    if (url.startsWith("//")) return null;
    return url;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.search || parsed.hash) return null;
    return parsed.href.length <= 1000 ? parsed.href : null;
  } catch {
    return null;
  }
}

function compactAdminMediaFile(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const id = compactString(value.id, ADMIN_MEDIA_MAX_STRING_LENGTH);
  const filename = compactString(value.filename, ADMIN_MEDIA_MAX_STRING_LENGTH);
  if (!id || !filename) return null;

  const file: JsonRecord = { id, filename };

  const url = compactSafeMediaUrl(value.url);
  if (url) file.url = url;

  setCompactString(file, "mimeType", value.mimeType, 80);
  setCompactNumber(file, "size", value.size);
  setCompactString(file, "altText", value.altText, ADMIN_MEDIA_MAX_STRING_LENGTH);
  setCompactNumber(file, "width", value.width);
  setCompactNumber(file, "height", value.height);
  setCompactString(file, "folderId", value.folderId, 160);
  setCompactTimestamp(file, "createdAt", value.createdAt);
  setCompactTimestamp(file, "updatedAt", value.updatedAt);

  return file;
}

function compactAdminInventoryVariant(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const id = compactString(value.id, ADMIN_INVENTORY_MAX_STRING_LENGTH);
  if (!id) return null;

  const variant: JsonRecord = { id };
  setCompactString(variant, "productId", value.productId, ADMIN_INVENTORY_MAX_STRING_LENGTH);
  setCompactString(variant, "productName", value.productName, ADMIN_INVENTORY_MAX_STRING_LENGTH);
  setCompactString(variant, "sku", value.sku, ADMIN_INVENTORY_MAX_STRING_LENGTH);
  setCompactString(variant, "size", value.size, ADMIN_INVENTORY_MAX_STRING_LENGTH);
  setCompactString(variant, "color", value.color, ADMIN_INVENTORY_MAX_STRING_LENGTH);
  setCompactNumber(variant, "stock", value.stock);
  setCompactNumber(variant, "reservedStock", value.reservedStock);
  setCompactNumber(variant, "available", value.available);
  setCompactNumber(variant, "lowStockThreshold", value.lowStockThreshold);

  return variant;
}

function compactAdminInventoryStats(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const stats: JsonRecord = {};
  for (const key of [
    "totalVariants",
    "totalOnHand",
    "totalReserved",
    "totalAvailable",
    "outOfStockCount",
    "lowStockCount",
  ] as const) {
    if (!(key in value)) return null;
    const compact = compactNumber(value[key]);
    if (compact === null) return null;
    stats[key] = compact;
  }

  return stats;
}

function buildAdminMediaSearchUrl(input: AdminMediaSearchInput): { url: URL; query: JsonRecord } {
  const url = new URL(`http://api.internal${ADMIN_MEDIA_PATH}`);
  const query: JsonRecord = {
    page: input.page,
    limit: input.limit,
    sortBy: "createdAt",
    sortOrder: "desc",
  };

  url.searchParams.set("page", String(input.page));
  url.searchParams.set("limit", String(input.limit));

  if (input.query) {
    query.query = input.query;
    url.searchParams.set("search", input.query);
  }

  if (input.folderId) {
    query.folderId = input.folderId;
    url.searchParams.set("folderId", input.folderId);
  }

  if (input.mimeType) {
    query.mimeType = input.mimeType;
    url.searchParams.set("mimeType", input.mimeType);
  }

  url.searchParams.set("sortBy", "createdAt");
  url.searchParams.set("sortOrder", "desc");

  return { url, query };
}

async function fetchAdminMediaSearch(
  env: Env,
  input: AdminMediaSearchInput,
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
  const { url, query } = buildAdminMediaSearchUrl(input);
  if (!env.API || typeof env.API.fetch !== "function") {
    return adminMediaToolError("admin_api_unavailable", query);
  }

  try {
    const response = await env.API.fetch(url, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminMediaToolError("admin_media_unavailable", query, response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    if (!body || body.success !== true || !data || !Array.isArray(data.files)) {
      return adminMediaToolError("admin_media_unavailable", query);
    }

    const pagination = compactAdminPagination(data.pagination);
    if (!pagination) {
      return adminMediaToolError("admin_media_unavailable", query);
    }

    const files = data.files
      .map(compactAdminMediaFile)
      .filter((file): file is JsonRecord => file !== null)
      .slice(0, ADMIN_MEDIA_SEARCH_MAX_FILES);

    return toolResult({
      adminMediaSearch: {
        source: { path: ADMIN_MEDIA_PATH },
        query,
        files,
        pagination,
        limits: {
          maxFiles: ADMIN_MEDIA_SEARCH_MAX_FILES,
          includesDeletedFields: false,
          includesStorageKeys: false,
          includesUploadMetadata: false,
          includesMutationAuthority: false,
        },
      },
    });
  } catch {
    return adminMediaToolError("admin_media_unavailable", query);
  }
}

function buildAdminInventoryLookupUrl(input: AdminInventoryLookupInput): { url: URL; query: JsonRecord } {
  const url = new URL(`http://api.internal${ADMIN_INVENTORY_PATH}`);
  const query: JsonRecord = {
    section: "variants",
    page: input.page,
    limit: input.limit,
    status: input.status,
    sort: input.sort,
    order: input.order,
  };

  url.searchParams.set("section", "variants");

  if (input.query) {
    query.query = input.query;
    url.searchParams.set("search", input.query);
  }

  url.searchParams.set("page", String(input.page));
  url.searchParams.set("limit", String(input.limit));
  url.searchParams.set("status", input.status);
  url.searchParams.set("sort", input.sort);
  url.searchParams.set("order", input.order);

  return { url, query };
}

async function fetchAdminInventoryLookup(
  env: Env,
  input: AdminInventoryLookupInput,
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
  const { url, query } = buildAdminInventoryLookupUrl(input);
  if (!env.API || typeof env.API.fetch !== "function") {
    return adminInventoryToolError("admin_api_unavailable", query);
  }

  try {
    const response = await env.API.fetch(url, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminInventoryToolError("admin_inventory_unavailable", query, response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    if (!body || body.success !== true || !data || !Array.isArray(data.variants)) {
      return adminInventoryToolError("admin_inventory_unavailable", query);
    }

    const pagination = compactAdminPagination(data.pagination);
    const stats = compactAdminInventoryStats(data.stats);
    if (!pagination || !stats) {
      return adminInventoryToolError("admin_inventory_unavailable", query);
    }

    const variants = data.variants
      .map(compactAdminInventoryVariant)
      .filter((variant): variant is JsonRecord => variant !== null)
      .slice(0, ADMIN_INVENTORY_LOOKUP_MAX_VARIANTS);

    return toolResult({
      adminInventoryLookup: {
        source: { path: ADMIN_INVENTORY_PATH },
        query,
        variants,
        pagination,
        stats,
        limits: {
          maxVariants: ADMIN_INVENTORY_LOOKUP_MAX_VARIANTS,
          section: "variants",
          includesMovements: false,
          includesAlerts: false,
          includesBarcode: false,
          includesPrices: false,
          includesVersion: false,
          canMutateStock: false,
        },
      },
    });
  } catch {
    return adminInventoryToolError("admin_inventory_unavailable", query);
  }
}

export function registerAdminMediaInventoryTools(
  server: McpServer,
  env: Env,
  options: AdminMcpOptions,
): void {
  server.registerTool(
    "admin_media_search",
    {
      title: "Admin Media Search",
      description: "Searches or lists the latest dashboard media files through API-verified permissions and returns compact media identifiers.",
      inputSchema: adminMediaSearchInputSchema,
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

      return fetchAdminMediaSearch(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );

  server.registerTool(
    "admin_inventory_lookup",
    {
      title: "Admin Inventory Lookup",
      description: "Read-only inventory variant lookup through API-verified permissions.",
      inputSchema: adminInventoryLookupInputSchema,
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

      return fetchAdminInventoryLookup(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );
}
