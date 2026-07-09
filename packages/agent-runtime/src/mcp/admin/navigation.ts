import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  ADMIN_PERMISSIONS_PATH,
  adminToolError,
  buildAdminSessionContext,
  fetchAdminPermissions,
  parseAdminPermissionContext,
} from "./auth";
import type { AdminPermissionContext } from "./auth";
import { ADMIN_READ_ONLY_TOOL_ANNOTATIONS, toolResult } from "./shared";
import type { AdminMcpOptions, Env, JsonRecord } from "./types";

const MAX_ADMIN_NAVIGATION_PAGES = 24;

const ADMIN_NAVIGATION_CATALOG_VERSION = "admin-navigation-context:v1";

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

export function registerAdminContextTools(
  server: McpServer,
  env: Env,
  options: AdminMcpOptions,
): void {
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
}
