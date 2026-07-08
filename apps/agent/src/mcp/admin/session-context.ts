import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

const ADMIN_PERMISSIONS_PATH = "/api/v1/admin/rbac/my-permissions";
const ADMIN_API_TARGET = `http://api.internal${ADMIN_PERMISSIONS_PATH}`;
const ADMIN_PRODUCTS_PATH = "/api/v1/admin/products";
const ADMIN_CATEGORIES_PATH = "/api/v1/admin/categories";
const ADMIN_COLLECTIONS_PATH = "/api/v1/admin/collections";
const ADMIN_PAGES_PATH = "/api/v1/admin/pages";
const ADMIN_ORDERS_PATH = "/api/v1/admin/orders";
const ADMIN_MEDIA_PATH = "/api/v1/admin/media";
const ADMIN_INVENTORY_PATH = "/api/v1/admin/inventory";
const ADMIN_DASHBOARD_SUMMARY_PATH = "/api/v1/admin/dashboard/metrics-summary";
const ADMIN_DASHBOARD_SUMMARY_TARGET = `http://api.internal${ADMIN_DASHBOARD_SUMMARY_PATH}`;
const ADMIN_SETTINGS_SUMMARY_PATH = "/api/v1/admin/settings/mcp-summary";
const ADMIN_SETTINGS_SUMMARY_TARGET = `http://api.internal${ADMIN_SETTINGS_SUMMARY_PATH}`;
const ADMIN_ANALYTICS_HEALTH_PATH = "/api/v1/admin/analytics/health";
const ADMIN_ANALYTICS_HEALTH_TARGET = `http://api.internal${ADMIN_ANALYTICS_HEALTH_PATH}`;
const ADMIN_ANALYTICS_SUMMARY_VERSION = "admin-analytics-summary:v1";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

const ADMIN_READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const MAX_ADMIN_NAVIGATION_PAGES = 24;
const ADMIN_NAVIGATION_CATALOG_VERSION = "admin-navigation-context:v1";
const ADMIN_PRODUCT_SEARCH_MAX_PRODUCTS = 10;
const ADMIN_CATEGORY_SEARCH_MAX_CATEGORIES = 10;
const ADMIN_COLLECTION_SEARCH_MAX_COLLECTIONS = 10;
const ADMIN_PAGE_SEARCH_MAX_PAGES = 10;
const ADMIN_ORDER_SEARCH_MAX_ORDERS = 10;
const ADMIN_MEDIA_SEARCH_MAX_FILES = 10;
const ADMIN_INVENTORY_LOOKUP_MAX_VARIANTS = 10;
const ADMIN_ANALYTICS_SUMMARY_MAX_PROVIDERS = 12;
const ADMIN_PRODUCTS_MAX_STRING_LENGTH = 220;
const ADMIN_CATEGORIES_MAX_STRING_LENGTH = 220;
const ADMIN_COLLECTIONS_MAX_STRING_LENGTH = 220;
const ADMIN_PAGES_MAX_STRING_LENGTH = 220;
const ADMIN_ORDERS_MAX_STRING_LENGTH = 220;
const ADMIN_MEDIA_MAX_STRING_LENGTH = 220;
const ADMIN_INVENTORY_MAX_STRING_LENGTH = 220;
const ADMIN_ANALYTICS_MAX_STRING_LENGTH = 160;

const ANALYTICS_BROWSER_STATUSES = new Set([
  "ready",
  "draft",
  "blocked",
  "not_configured",
]);
const ANALYTICS_SERVER_STATUSES = new Set([
  "ready",
  "blocked",
  "not_configured",
  "not_applicable",
]);

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

type JsonRecord = Record<string, unknown>;

const adminProductSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(ADMIN_PRODUCT_SEARCH_MAX_PRODUCTS).default(5),
  page: z.number().int().min(1).max(20).default(1),
}).strict();

type AdminProductSearchInput = z.infer<typeof adminProductSearchInputSchema>;

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

const adminOrderSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(80),
  limit: z.number().int().min(1).max(ADMIN_ORDER_SEARCH_MAX_ORDERS).default(5),
  page: z.number().int().min(1).max(20).default(1),
}).strict();

type AdminOrderSearchInput = z.infer<typeof adminOrderSearchInputSchema>;

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

const adminDashboardSummaryInputSchema = z.object({}).strict();

type AdminDashboardSummaryInput = z.infer<typeof adminDashboardSummaryInputSchema>;

const adminSettingsSummaryInputSchema = z.object({}).strict();

type AdminSettingsSummaryInput = z.infer<typeof adminSettingsSummaryInputSchema>;

const adminAnalyticsSummaryInputSchema = z.object({}).strict();

type AdminAnalyticsSummaryInput = z.infer<typeof adminAnalyticsSummaryInputSchema>;

interface AdminPermissionContext {
  userId?: string;
  isSuperAdmin: boolean;
  roles: JsonRecord[];
  permissions: string[];
  overrides: {
    grants: string[];
    denials: string[];
  };
}

interface AdminNavigationCatalogEntry {
  section: string;
  name: string;
  path: string;
  requiredPermission?: string;
  anyOfPermissions?: readonly string[];
  allowAnyAdmin?: boolean;
}

const ADMIN_NAVIGATION_CATALOG = [
  {
    section: "Dashboard",
    name: "Dashboard",
    path: "/admin",
    requiredPermission: "dashboard.view",
  },
  {
    section: "Catalog",
    name: "Products",
    path: "/admin/products",
    requiredPermission: "products.view",
  },
  {
    section: "Catalog",
    name: "Categories",
    path: "/admin/categories",
    requiredPermission: "categories.view",
  },
  {
    section: "Catalog",
    name: "Attributes",
    path: "/admin/attributes",
    requiredPermission: "attributes.view",
  },
  {
    section: "Catalog",
    name: "Collections",
    path: "/admin/collections",
    requiredPermission: "collections.view",
  },
  {
    section: "Catalog",
    name: "Inventory",
    path: "/admin/inventory",
    requiredPermission: "products.view",
  },
  {
    section: "Content",
    name: "Pages",
    path: "/admin/pages",
    requiredPermission: "pages.view",
  },
  {
    section: "Content",
    name: "Widgets",
    path: "/admin/widgets",
    requiredPermission: "widgets.view",
  },
  {
    section: "Content",
    name: "Media",
    path: "/admin/media",
    requiredPermission: "media.view",
  },
  {
    section: "Sales",
    name: "Orders",
    path: "/admin/orders",
    requiredPermission: "orders.view",
  },
  {
    section: "Sales",
    name: "Abandoned",
    path: "/admin/abandoned-checkouts",
    requiredPermission: "orders.view",
  },
  {
    section: "Sales",
    name: "Customers",
    path: "/admin/customers",
    requiredPermission: "customers.view",
  },
  {
    section: "Sales",
    name: "Discounts",
    path: "/admin/discounts",
    requiredPermission: "discounts.view",
  },
  {
    section: "Sales",
    name: "Analytics",
    path: "/admin/analytics",
    requiredPermission: "analytics.view",
  },
  {
    section: "Settings",
    name: "General",
    path: "/admin/settings",
    requiredPermission: "settings.general.view",
  },
  {
    section: "Settings",
    name: "Theme",
    path: "/admin/settings/theme",
    requiredPermission: "settings.general.view",
  },
  {
    section: "Settings",
    name: "Account",
    path: "/admin/settings/account",
    allowAnyAdmin: true,
  },
  {
    section: "Settings",
    name: "Notifications",
    path: "/admin/settings/notifications",
    requiredPermission: "settings.notifications.edit",
  },
  {
    section: "Settings",
    name: "Hero Sliders",
    path: "/admin/settings/hero-sliders",
    requiredPermission: "settings.header.edit",
  },
  {
    section: "Settings",
    name: "Checkout",
    path: "/admin/settings/checkout",
    requiredPermission: "settings.general.view",
  },
  {
    section: "Settings",
    name: "Delivery",
    path: "/admin/settings/delivery-providers",
    requiredPermission: "settings.delivery_providers.view",
  },
  {
    section: "Settings",
    name: "Fraud Checker",
    path: "/admin/settings/fraud-checker",
    requiredPermission: "settings.fraud_checker.view",
  },
  {
    section: "Settings",
    name: "Meta CAPI",
    path: "/admin/settings/meta-conversion",
    requiredPermission: "analytics.view",
  },
  {
    section: "Settings",
    name: "Cache",
    path: "/admin/settings/cache",
    requiredPermission: "settings.cache.view",
  },
] as const satisfies readonly AdminNavigationCatalogEntry[];

const DEFAULT_ADMIN_PAGE_CANDIDATES = [
  "/admin",
  "/admin/products",
  "/admin/orders",
  "/admin/customers",
  "/admin/categories",
  "/admin/collections",
  "/admin/pages",
  "/admin/widgets",
  "/admin/media",
  "/admin/settings/account",
] as const;

interface AdminPermissionsSuccess {
  ok: true;
  body: JsonRecord;
}

interface AdminPermissionsFailure {
  ok: false;
  status: number;
  code: string;
}

type AdminPermissionsResult = AdminPermissionsSuccess | AdminPermissionsFailure;

export interface AdminMcpOptions {
  cookie?: string | null;
  userAgent?: string | null;
  permissionsBody?: JsonRecord;
}

export interface AdminMcpAuthContext {
  cookie: string;
  userAgent: string | null;
  permissionsBody: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function getCookieHeader(headers: Headers): string | null {
  const cookie = headers.get("Cookie");
  return cookie?.trim() ? cookie : null;
}

function adminApiHeaders(cookie: string, userAgent?: string | null): Headers {
  const headers = new Headers({
    Accept: "application/json",
    Cookie: cookie,
  });
  const safeUserAgent = userAgent?.trim();
  if (safeUserAgent) {
    headers.set("User-Agent", safeUserAgent.slice(0, 256));
  }
  return headers;
}

function failureCodeForStatus(status: number): string {
  if (status === 401) return "admin_session_invalid";
  if (status === 403) return "admin_session_forbidden";
  if (status >= 400 && status < 500) return "admin_session_denied";
  return "admin_session_unavailable";
}

function failClosedStatus(status: number): number {
  if (status === 401 || status === 403) return status;
  if (status >= 400 && status < 500) return 403;
  return 503;
}

function adminAuthFailureResponse(failure: AdminPermissionsFailure): Response {
  const status = failClosedStatus(failure.status);
  return jsonResponse({
    success: false,
    error: {
      code: failure.code,
      message: status === 503
        ? "Admin session verification is temporarily unavailable."
        : "Admin session is not authorized for MCP.",
    },
  }, status);
}

async function parseJsonResponse(response: Response): Promise<JsonRecord | null> {
  try {
    const body = await response.json();
    return isRecord(body) ? body : { value: body };
  } catch {
    return null;
  }
}

async function fetchAdminPermissions(
  env: Env,
  {
    cookie,
    userAgent,
    signal,
  }: {
    cookie: string;
    userAgent?: string | null;
    signal?: AbortSignal;
  },
): Promise<AdminPermissionsResult> {
  if (!env.API || typeof env.API.fetch !== "function") {
    return { ok: false, status: 503, code: "admin_api_unavailable" };
  }

  try {
    const response = await env.API.fetch(ADMIN_API_TARGET, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: failureCodeForStatus(response.status),
      };
    }

    const body = await parseJsonResponse(response);
    if (!body || body.success === false) {
      return { ok: false, status: 503, code: "admin_permissions_invalid" };
    }

    return { ok: true, body };
  } catch {
    return { ok: false, status: 503, code: "admin_session_unavailable" };
  }
}

export async function resolveAdminMcpRequestAuth(
  request: Request,
  env: Env,
): Promise<AdminMcpAuthContext | Response> {
  const cookie = getCookieHeader(request.headers);
  if (!cookie) {
    return jsonResponse({
      success: false,
      error: {
        code: "admin_session_required",
        message: "Admin MCP requires an active dashboard session.",
      },
    }, 401);
  }

  const userAgent = request.headers.get("User-Agent");
  const result = await fetchAdminPermissions(env, {
    cookie,
    userAgent,
    signal: request.signal,
  });
  if (!result.ok) return adminAuthFailureResponse(result);

  return {
    cookie,
    userAgent,
    permissionsBody: result.body,
  };
}

export async function guardAdminMcpRequest(request: Request, env: Env): Promise<Response | null> {
  const auth = await resolveAdminMcpRequestAuth(request, env);
  return auth instanceof Response ? auth : null;
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

function adminToolError(failure: AdminPermissionsFailure): CallToolResult {
  return toolResult({
    error: {
      code: failure.code,
      status: failClosedStatus(failure.status),
      message: failure.status >= 500
        ? "Admin session context is temporarily unavailable."
        : "Admin session is not authorized for MCP.",
    },
  }, true);
}

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

function adminOrderToolError(
  code: string,
  query?: JsonRecord,
  status = 503,
): CallToolResult {
  return toolResult({
    adminOrderSearch: {
      source: { path: ADMIN_ORDERS_PATH },
      ...(query ? { query } : {}),
      orders: [],
      pagination: null,
      limits: {
        maxOrders: ADMIN_ORDER_SEARCH_MAX_ORDERS,
        includesTrashed: false,
        includesAddresses: false,
        includesItems: false,
        includesPaymentRecovery: false,
        includesTracking: false,
      },
    },
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin orders are temporarily unavailable.",
    },
  }, true);
}

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

function adminDashboardSummaryToolError(
  code: string,
  status = 503,
): CallToolResult {
  return toolResult({
    adminDashboardSummary: {
      source: {
        path: ADMIN_DASHBOARD_SUMMARY_PATH,
        permission: "dashboard.view",
      },
      stats: null,
      limits: adminDashboardSummaryLimits(),
    },
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin dashboard summary is temporarily unavailable.",
    },
  }, true);
}

function adminSettingsSummaryToolError(
  code: string,
  status = 503,
): CallToolResult {
  return toolResult({
    adminSettingsSummary: null,
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin settings summary is temporarily unavailable.",
    },
  }, true);
}

function adminAnalyticsSummaryToolError(
  code: string,
  status = 503,
): CallToolResult {
  return toolResult({
    adminAnalyticsSummary: {
      source: {
        path: ADMIN_ANALYTICS_HEALTH_PATH,
        permission: "analytics.view",
        version: ADMIN_ANALYTICS_SUMMARY_VERSION,
      },
      summary: null,
      providers: [],
      limits: adminAnalyticsSummaryLimits(),
    },
    error: {
      code,
      status: failClosedStatus(status),
      message: "Admin analytics summary is temporarily unavailable.",
    },
  }, true);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

function compactRoles(value: unknown): JsonRecord[] | null {
  if (!Array.isArray(value)) return null;

  return value.flatMap((role) => {
    if (!isRecord(role)) return [];
    const compact: JsonRecord = {};
    if (typeof role.id === "string") compact.id = role.id;
    if (typeof role.name === "string") compact.name = role.name;
    return Object.keys(compact).length > 0 ? [compact] : [];
  });
}

function compactKnownPermissionContext(value: JsonRecord): JsonRecord | null {
  const context: JsonRecord = {};
  if (typeof value.userId === "string") context.userId = value.userId;
  if (typeof value.isSuperAdmin === "boolean") context.isSuperAdmin = value.isSuperAdmin;

  const roles = compactRoles(value.roles);
  if (roles) context.roles = roles;

  const permissions = stringArray(value.permissions);
  if (permissions) context.permissions = permissions;

  if (isRecord(value.overrides)) {
    const overrides: JsonRecord = {};
    const grants = stringArray(value.overrides.grants);
    const denials = stringArray(value.overrides.denials);
    if (grants) overrides.grants = grants;
    if (denials) overrides.denials = denials;
    if (Object.keys(overrides).length > 0) context.overrides = overrides;
  }

  return Object.keys(context).length > 0 ? context : null;
}

function parseAdminPermissionContext(body: JsonRecord): AdminPermissionContext {
  const payload = isRecord(body.data) ? body.data : body;
  const roles = compactRoles(payload.roles) ?? [];
  const permissions = stringArray(payload.permissions) ?? [];
  const grants = isRecord(payload.overrides)
    ? stringArray(payload.overrides.grants) ?? []
    : [];
  const denials = isRecord(payload.overrides)
    ? stringArray(payload.overrides.denials) ?? []
    : [];

  return {
    ...(typeof payload.userId === "string" ? { userId: payload.userId } : {}),
    isSuperAdmin: payload.isSuperAdmin === true,
    roles,
    permissions,
    overrides: { grants, denials },
  };
}

function hasAdminAccess(context: AdminPermissionContext): boolean {
  return context.isSuperAdmin || context.permissions.length > 0;
}

function canAccessNavigationEntry(
  entry: AdminNavigationCatalogEntry,
  permissions: Set<string>,
  context: AdminPermissionContext,
): boolean {
  if (!hasAdminAccess(context)) return false;
  if (context.isSuperAdmin) return true;
  if (entry.allowAnyAdmin) return true;
  if (entry.requiredPermission) return permissions.has(entry.requiredPermission);
  if (entry.anyOfPermissions) {
    return entry.anyOfPermissions.some((permission) => permissions.has(permission));
  }
  return false;
}

function compactNavigationPage(entry: AdminNavigationCatalogEntry): JsonRecord {
  return {
    name: entry.name,
    path: entry.path,
    ...(entry.requiredPermission
      ? { requiredPermission: entry.requiredPermission }
      : {}),
    ...(entry.anyOfPermissions
      ? { anyOfPermissions: [...entry.anyOfPermissions] }
      : {}),
    ...(entry.allowAnyAdmin ? { allowAnyAdmin: true } : {}),
  };
}

function groupNavigationPages(pages: AdminNavigationCatalogEntry[]): JsonRecord[] {
  const sections = new Map<string, JsonRecord[]>();
  for (const page of pages) {
    const existing = sections.get(page.section) ?? [];
    existing.push(compactNavigationPage(page));
    sections.set(page.section, existing);
  }

  return Array.from(sections, ([label, sectionPages]) => ({
    label,
    pages: sectionPages,
  }));
}

function findDefaultAdminPath(accessiblePages: AdminNavigationCatalogEntry[]): string | null {
  const accessiblePaths = new Set(accessiblePages.map((page) => page.path));
  return DEFAULT_ADMIN_PAGE_CANDIDATES.find((path) => accessiblePaths.has(path)) ?? null;
}

function buildAdminSessionContext(body: JsonRecord): JsonRecord {
  const payload = isRecord(body.data) ? body.data : body;
  const knownContext = compactKnownPermissionContext(payload);

  return {
    adminSessionContext: knownContext ?? {
      permissionsResponse: payload,
    },
  };
}

function buildAdminNavigationContext(body: JsonRecord): JsonRecord {
  const context = parseAdminPermissionContext(body);
  const permissions = new Set(context.permissions);
  const accessiblePages = ADMIN_NAVIGATION_CATALOG
    .filter((entry) => canAccessNavigationEntry(entry, permissions, context))
    .slice(0, MAX_ADMIN_NAVIGATION_PAGES);

  return {
    adminNavigationContext: {
      source: {
        permissions: ADMIN_PERMISSIONS_PATH,
        catalog: ADMIN_NAVIGATION_CATALOG_VERSION,
      },
      session: {
        ...(context.userId ? { userId: context.userId } : {}),
        isSuperAdmin: context.isSuperAdmin,
        roles: context.roles,
        roleCount: context.roles.length,
        permissionCount: context.permissions.length,
        deniedPermissionCount: context.overrides.denials.length,
      },
      defaultPath: findDefaultAdminPath(accessiblePages),
      limits: {
        maxPages: MAX_ADMIN_NAVIGATION_PAGES,
        returnedPages: accessiblePages.length,
        catalogPages: ADMIN_NAVIGATION_CATALOG.length,
        includesDynamicRoutes: false,
      },
      sections: groupNavigationPages(accessiblePages),
    },
  };
}

function compactString(value: unknown, maxLength = ADMIN_PRODUCTS_MAX_STRING_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function compactNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function compactTimestamp(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return compactString(value, 80);
}

function setCompactString(
  target: JsonRecord,
  key: string,
  value: unknown,
  maxLength = ADMIN_PRODUCTS_MAX_STRING_LENGTH,
): void {
  const compact = compactString(value, maxLength);
  if (compact) target[key] = compact;
}

function setCompactNumber(target: JsonRecord, key: string, value: unknown): void {
  const compact = compactNumber(value);
  if (compact !== null) target[key] = compact;
}

function setCompactBoolean(target: JsonRecord, key: string, value: unknown): void {
  const compact = compactBoolean(value);
  if (compact !== null) target[key] = compact;
}

function compactMaskedContact(value: unknown): string | null {
  const compact = compactString(value, 160);
  if (!compact) return null;
  return /[*•…xX]/.test(compact) ? compact : null;
}

function setCompactTimestamp(target: JsonRecord, key: string, value: unknown): void {
  const compact = compactTimestamp(value);
  if (compact !== null) target[key] = compact;
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

function compactAdminPagination(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const page = compactNumber(value.page);
  const limit = compactNumber(value.limit);
  const total = compactNumber(value.total);
  const totalPages = compactNumber(value.totalPages);
  if (page === null || limit === null || total === null || totalPages === null) {
    return null;
  }

  return { page, limit, total, totalPages };
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

function compactAdminOrder(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const id = compactString(value.id, ADMIN_ORDERS_MAX_STRING_LENGTH);
  const orderNumber = compactString(value.orderNumber, ADMIN_ORDERS_MAX_STRING_LENGTH);
  const code = compactString(value.code, ADMIN_ORDERS_MAX_STRING_LENGTH);
  if (!id && !orderNumber && !code) return null;

  const order: JsonRecord = {};
  if (id) order.id = id;
  if (orderNumber) order.orderNumber = orderNumber;
  if (code) order.code = code;

  setCompactTimestamp(order, "createdAt", value.createdAt);
  setCompactTimestamp(order, "updatedAt", value.updatedAt);
  setCompactString(order, "orderStatus", value.orderStatus ?? value.status, ADMIN_ORDERS_MAX_STRING_LENGTH);
  setCompactString(order, "paymentStatus", value.paymentStatus, ADMIN_ORDERS_MAX_STRING_LENGTH);
  setCompactString(order, "fulfillmentStatus", value.fulfillmentStatus, ADMIN_ORDERS_MAX_STRING_LENGTH);
  setCompactString(order, "paymentMethod", value.paymentMethod, ADMIN_ORDERS_MAX_STRING_LENGTH);
  setCompactNumber(order, "totalAmount", value.totalAmount);
  setCompactString(order, "currency", value.currency, 12);
  setCompactNumber(order, "itemCount", value.itemCount);

  const customerEmailMasked = compactMaskedContact(
    value.customerEmailMasked ?? value.maskedCustomerEmail,
  );
  if (customerEmailMasked) order.customerEmailMasked = customerEmailMasked;

  const customerPhoneMasked = compactMaskedContact(
    value.customerPhoneMasked ?? value.maskedCustomerPhone,
  );
  if (customerPhoneMasked) order.customerPhoneMasked = customerPhoneMasked;

  return order;
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

function compactAnalyticsStatus(value: unknown, allowed: Set<string>): string | null {
  const status = compactString(value, 80);
  return status && allowed.has(status) ? status : null;
}

function compactAdminAnalyticsSummaryStats(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const stats: JsonRecord = {};
  for (const key of [
    "totalProviders",
    "browserReadyProviders",
    "draftProviders",
    "blockedProviders",
    "notConfiguredProviders",
    "serverReadyProviders",
  ] as const) {
    const compact = compactNumber(value[key]);
    if (compact === null) return null;
    stats[key] = compact;
  }

  return stats;
}

function compactAdminAnalyticsBrowser(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const status = compactAnalyticsStatus(value.status, ANALYTICS_BROWSER_STATUSES);
  const configured = compactBoolean(value.configured);
  const activeScriptCount = compactNumber(value.activeScriptCount);
  const readyScriptCount = compactNumber(value.readyScriptCount);
  const draftScriptCount = compactNumber(value.draftScriptCount);
  const blockedScriptCount = compactNumber(value.blockedScriptCount);
  if (
    !status ||
    configured === null ||
    activeScriptCount === null ||
    readyScriptCount === null ||
    draftScriptCount === null ||
    blockedScriptCount === null
  ) {
    return null;
  }

  const issueCount = Array.isArray(value.issues) ? value.issues.length : 0;
  return {
    status,
    configured,
    activeScriptCount,
    readyScriptCount,
    draftScriptCount,
    blockedScriptCount,
    issueCount,
  };
}

function compactAdminAnalyticsServerSide(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const status = compactAnalyticsStatus(value.status, ANALYTICS_SERVER_STATUSES);
  const configured = compactBoolean(value.configured);
  if (!status || configured === null) return null;

  const serverSide: JsonRecord = { status, configured };
  setCompactString(serverSide, "label", value.label, ADMIN_ANALYTICS_MAX_STRING_LENGTH);
  return serverSide;
}

function compactAdminAnalyticsProvider(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const provider = compactString(value.provider, ADMIN_ANALYTICS_MAX_STRING_LENGTH);
  const label = compactString(value.label, ADMIN_ANALYTICS_MAX_STRING_LENGTH);
  const browser = compactAdminAnalyticsBrowser(value.browser);
  const serverSide = compactAdminAnalyticsServerSide(value.serverSide);
  if (!provider || !label || !browser || !serverSide) return null;

  return { provider, label, browser, serverSide };
}

function adminAnalyticsSummaryLimits(): JsonRecord {
  return {
    includesScriptConfig: false,
    includesAnalyticsSnippets: false,
    includesCustomCode: false,
    includesProviderIdentifiers: false,
    includesCredentials: false,
    includesRawIssues: false,
    includesProviderMessages: false,
    includesProviderPayloads: false,
    canMutate: false,
  };
}

function adminDashboardSummaryLimits(): JsonRecord {
  return {
    includesRecentOrders: false,
    includesOrderIds: false,
    includesCustomerPii: false,
    includesCustomerContacts: false,
    includesPaymentEvidence: false,
    includesProviderPayloads: false,
    includesLifetimeRevenue: false,
    includesDailyActivity: false,
    canMutate: false,
  };
}

function compactAdminDashboardOrderStatus(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const delivered = compactNumber(value.delivered);
  const processing = compactNumber(value.processing);
  const shipping = compactNumber(value.shipping);
  const cancelled = compactNumber(value.cancelled);
  if (
    delivered === null ||
    processing === null ||
    shipping === null ||
    cancelled === null
  ) {
    return null;
  }

  return { delivered, processing, shipping, cancelled };
}

function compactAdminDashboardCurrentMonth(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const orders = compactNumber(value.orders);
  const revenue = compactNumber(value.revenue);
  const orderGrowth = compactNumber(value.orderGrowth);
  const revenueGrowth = compactNumber(value.revenueGrowth);
  const orderStatus = compactAdminDashboardOrderStatus(value.orderStatus);
  if (
    orders === null ||
    revenue === null ||
    orderGrowth === null ||
    revenueGrowth === null ||
    !orderStatus
  ) {
    return null;
  }

  return { orders, revenue, orderGrowth, revenueGrowth, orderStatus };
}

function compactAdminDashboardLastMonth(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const orders = compactNumber(value.orders);
  const revenue = compactNumber(value.revenue);
  if (orders === null || revenue === null) return null;

  return { orders, revenue };
}

function compactAdminDashboardStats(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;

  const totalProducts = compactNumber(value.totalProducts);
  const totalCustomers = compactNumber(value.totalCustomers);
  const currentMonth = compactAdminDashboardCurrentMonth(value.currentMonth);
  const lastMonth = compactAdminDashboardLastMonth(value.lastMonth);
  if (
    totalProducts === null ||
    totalCustomers === null ||
    !currentMonth ||
    !lastMonth
  ) {
    return null;
  }

  return { totalProducts, totalCustomers, currentMonth, lastMonth };
}

function buildAdminOrderSearchUrl(input: AdminOrderSearchInput): { url: URL; query: JsonRecord } {
  const url = new URL(`http://api.internal${ADMIN_ORDERS_PATH}`);
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

async function fetchAdminOrderSearch(
  env: Env,
  input: AdminOrderSearchInput,
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
  const { url, query } = buildAdminOrderSearchUrl(input);
  if (!env.API || typeof env.API.fetch !== "function") {
    return adminOrderToolError("admin_api_unavailable", query);
  }

  try {
    const response = await env.API.fetch(url, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminOrderToolError("admin_order_unavailable", query, response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    if (!body || body.success !== true || !data || !Array.isArray(data.orders)) {
      return adminOrderToolError("admin_order_unavailable", query);
    }

    const pagination = compactAdminPagination(data.pagination);
    if (!pagination) {
      return adminOrderToolError("admin_order_unavailable", query);
    }

    const orders = data.orders
      .map(compactAdminOrder)
      .filter((order): order is JsonRecord => order !== null)
      .slice(0, ADMIN_ORDER_SEARCH_MAX_ORDERS);

    return toolResult({
      adminOrderSearch: {
        source: { path: ADMIN_ORDERS_PATH },
        query,
        orders,
        pagination,
        limits: {
          maxOrders: ADMIN_ORDER_SEARCH_MAX_ORDERS,
          includesTrashed: false,
          includesAddresses: false,
          includesItems: false,
          includesPaymentRecovery: false,
          includesTracking: false,
        },
      },
    });
  } catch {
    return adminOrderToolError("admin_order_unavailable", query);
  }
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

async function fetchAdminDashboardSummary(
  env: Env,
  _input: AdminDashboardSummaryInput,
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
  if (!env.API || typeof env.API.fetch !== "function") {
    return adminDashboardSummaryToolError("admin_api_unavailable");
  }

  try {
    const response = await env.API.fetch(ADMIN_DASHBOARD_SUMMARY_TARGET, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminDashboardSummaryToolError("admin_dashboard_summary_unavailable", response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    const stats = data ? compactAdminDashboardStats(data.stats) : null;
    if (!body || body.success !== true || !data || !stats) {
      return adminDashboardSummaryToolError("admin_dashboard_summary_unavailable");
    }

    const structuredContent = {
      adminDashboardSummary: {
        source: {
          path: ADMIN_DASHBOARD_SUMMARY_PATH,
          permission: "dashboard.view",
        },
        stats,
        limits: adminDashboardSummaryLimits(),
      },
    };

    return {
      structuredContent,
      content: [{
        type: "text",
        text: "Admin dashboard summary aggregates are available.",
      }],
    };
  } catch {
    return adminDashboardSummaryToolError("admin_dashboard_summary_unavailable");
  }
}

async function fetchAdminSettingsSummary(
  env: Env,
  _input: AdminSettingsSummaryInput,
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
  if (!env.API || typeof env.API.fetch !== "function") {
    return adminSettingsSummaryToolError("admin_api_unavailable");
  }

  try {
    const response = await env.API.fetch(ADMIN_SETTINGS_SUMMARY_TARGET, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminSettingsSummaryToolError("admin_settings_summary_unavailable", response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    if (!body || body.success !== true || !data) {
      return adminSettingsSummaryToolError("admin_settings_summary_unavailable");
    }

    return {
      structuredContent: {
        adminSettingsSummary: data,
      },
      content: [{
        type: "text",
        text: "Admin settings summary is available.",
      }],
    };
  } catch {
    return adminSettingsSummaryToolError("admin_settings_summary_unavailable");
  }
}

async function fetchAdminAnalyticsSummary(
  env: Env,
  _input: AdminAnalyticsSummaryInput,
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
  if (!env.API || typeof env.API.fetch !== "function") {
    return adminAnalyticsSummaryToolError("admin_api_unavailable");
  }

  try {
    const response = await env.API.fetch(ADMIN_ANALYTICS_HEALTH_TARGET, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });
    if (!response.ok) {
      return adminAnalyticsSummaryToolError("admin_analytics_summary_unavailable", response.status);
    }

    const body = await parseJsonResponse(response);
    const data = body && isRecord(body.data) ? body.data : null;
    const summary = compactAdminAnalyticsSummaryStats(data?.summary);
    const rawProviders = Array.isArray(data?.providers) ? data.providers : null;
    if (!body || body.success !== true || !data || !summary || !rawProviders) {
      return adminAnalyticsSummaryToolError("admin_analytics_summary_unavailable");
    }

    const compactProviders = rawProviders.map(compactAdminAnalyticsProvider);
    if (compactProviders.some((provider) => provider === null)) {
      return adminAnalyticsSummaryToolError("admin_analytics_summary_unavailable");
    }
    const providers = compactProviders
      .filter((provider): provider is JsonRecord => provider !== null)
      .slice(0, ADMIN_ANALYTICS_SUMMARY_MAX_PROVIDERS);

    return {
      structuredContent: {
        adminAnalyticsSummary: {
          source: {
            path: ADMIN_ANALYTICS_HEALTH_PATH,
            permission: "analytics.view",
            version: ADMIN_ANALYTICS_SUMMARY_VERSION,
          },
          summary,
          providers,
          limits: adminAnalyticsSummaryLimits(),
        },
      },
      content: [{
        type: "text",
        text: "Admin analytics summary is available.",
      }],
    };
  } catch {
    return adminAnalyticsSummaryToolError("admin_analytics_summary_unavailable");
  }
}

export function createAdminMcpServer(
  env: Env,
  options: AdminMcpOptions = {},
): McpServer {
  const server = new McpServer({
    name: env.AGENT_NAME?.trim() || "scalius-admin-agent",
    version: env.AGENT_VERSION?.trim() || "0.1.0",
  });

  server.registerTool(
    "admin_session_context",
    {
      title: "Admin Session Context",
      description: "Reads the current dashboard admin session permission context through the API.",
      inputSchema: {},
      annotations: ADMIN_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (_args, extra) => {
      const cookie = options.cookie?.trim() ? options.cookie : null;
      if (!cookie) {
        return adminToolError({
          ok: false,
          status: 401,
          code: "admin_session_required",
        });
      }

      const permissionsBody = options.permissionsBody;
      if (permissionsBody) {
        return toolResult(buildAdminSessionContext(permissionsBody));
      }

      const result = await fetchAdminPermissions(env, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
      if (!result.ok) {
        return adminToolError(result);
      }

      return toolResult(buildAdminSessionContext(result.body));
    },
  );

  server.registerTool(
    "admin_navigation_context",
    {
      title: "Admin Navigation Context",
      description: "Reads the current dashboard admin session summary and allowed static page catalog through API-verified permissions.",
      inputSchema: {},
      annotations: ADMIN_READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (_args, extra) => {
      const cookie = options.cookie?.trim() ? options.cookie : null;
      if (!cookie) {
        return adminToolError({
          ok: false,
          status: 401,
          code: "admin_session_required",
        });
      }

      const permissionsBody = options.permissionsBody;
      if (permissionsBody) {
        return toolResult(buildAdminNavigationContext(permissionsBody));
      }

      const result = await fetchAdminPermissions(env, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
      if (!result.ok) {
        return adminToolError(result);
      }

      return toolResult(buildAdminNavigationContext(result.body));
    },
  );

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

  server.registerTool(
    "admin_order_search",
    {
      title: "Admin Order Search",
      description: "Searches the dashboard order list through API-verified permissions and returns compact order identifiers.",
      inputSchema: adminOrderSearchInputSchema,
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

      return fetchAdminOrderSearch(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );

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

  server.registerTool(
    "admin_dashboard_summary",
    {
      title: "Admin Dashboard Summary",
      description: "Reads safe aggregate dashboard metrics through API-verified dashboard permissions.",
      inputSchema: adminDashboardSummaryInputSchema,
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

      return fetchAdminDashboardSummary(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );

  server.registerTool(
    "admin_settings_summary",
    {
      title: "Admin Settings Summary",
      description: "Reads the redacted dashboard settings summary through API-verified settings permissions.",
      inputSchema: adminSettingsSummaryInputSchema,
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

      return fetchAdminSettingsSummary(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );

  server.registerTool(
    "admin_analytics_summary",
    {
      title: "Admin Analytics Summary",
      description: "Reads redacted analytics readiness through API-verified analytics permissions.",
      inputSchema: adminAnalyticsSummaryInputSchema,
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

      return fetchAdminAnalyticsSummary(env, input, {
        cookie,
        userAgent: options.userAgent,
        signal: extra.signal,
      });
    },
  );

  return server;
}
