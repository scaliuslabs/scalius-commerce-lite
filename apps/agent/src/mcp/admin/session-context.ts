import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const ADMIN_PERMISSIONS_PATH = "/api/v1/admin/rbac/my-permissions";
const ADMIN_API_TARGET = `http://api.internal${ADMIN_PERMISSIONS_PATH}`;

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

type JsonRecord = Record<string, unknown>;

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

  const headers = new Headers({
    Accept: "application/json",
    Cookie: cookie,
  });
  const safeUserAgent = userAgent?.trim();
  if (safeUserAgent) {
    headers.set("User-Agent", safeUserAgent.slice(0, 256));
  }

  try {
    const response = await env.API.fetch(ADMIN_API_TARGET, {
      method: "GET",
      headers,
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

  return server;
}
