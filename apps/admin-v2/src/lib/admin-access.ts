import { ADMIN_PERMISSIONS } from "./admin-permissions";

export const ADMIN_ACCESS_DENIED_PATH = "/admin/access-denied";

type PermissionCollection = Set<string> | string[];

interface PagePermissionConfig {
  permission?: string;
  anyOf?: string[];
  allOf?: string[];
  allowAnyAdmin?: boolean;
}

const PAGE_PERMISSION_MAP: Record<string, PagePermissionConfig> = {
  [ADMIN_ACCESS_DENIED_PATH]: { allowAnyAdmin: true },
  "/admin": { permission: ADMIN_PERMISSIONS.DASHBOARD_VIEW },
  "/admin/inventory": { permission: ADMIN_PERMISSIONS.PRODUCTS_VIEW },
  "/admin/products": { permission: ADMIN_PERMISSIONS.PRODUCTS_VIEW },
  "/admin/products/new": { permission: ADMIN_PERMISSIONS.PRODUCTS_CREATE },
  "/admin/categories": { permission: ADMIN_PERMISSIONS.CATEGORIES_VIEW },
  "/admin/categories/new": { permission: ADMIN_PERMISSIONS.CATEGORIES_CREATE },
  "/admin/attributes": { permission: ADMIN_PERMISSIONS.ATTRIBUTES_VIEW },
  "/admin/collections": { permission: ADMIN_PERMISSIONS.COLLECTIONS_VIEW },
  "/admin/collections/new": {
    permission: ADMIN_PERMISSIONS.COLLECTIONS_CREATE,
  },
  "/admin/collections/trash": {
    permission: ADMIN_PERMISSIONS.COLLECTIONS_VIEW,
  },
  "/admin/media": { permission: ADMIN_PERMISSIONS.MEDIA_VIEW },
  "/admin/pages": { permission: ADMIN_PERMISSIONS.PAGES_VIEW },
  "/admin/pages/new": { permission: ADMIN_PERMISSIONS.PAGES_CREATE },
  "/admin/pages/trash": { permission: ADMIN_PERMISSIONS.PAGES_VIEW },
  "/admin/widgets": { permission: ADMIN_PERMISSIONS.WIDGETS_VIEW },
  "/admin/widgets/create": { permission: ADMIN_PERMISSIONS.WIDGETS_CREATE },
  "/admin/widgets/new": { permission: ADMIN_PERMISSIONS.WIDGETS_CREATE },
  "/admin/widgets/trash": { permission: ADMIN_PERMISSIONS.WIDGETS_VIEW },
  "/admin/orders": { permission: ADMIN_PERMISSIONS.ORDERS_VIEW },
  "/admin/orders/new": { permission: ADMIN_PERMISSIONS.ORDERS_CREATE },
  "/admin/abandoned-checkouts": { permission: ADMIN_PERMISSIONS.ORDERS_VIEW },
  "/admin/discounts": { permission: ADMIN_PERMISSIONS.DISCOUNTS_VIEW },
  "/admin/discounts/new": { permission: ADMIN_PERMISSIONS.DISCOUNTS_CREATE },
  "/admin/analytics": { permission: ADMIN_PERMISSIONS.ANALYTICS_VIEW },
  "/admin/analytics/new": { permission: ADMIN_PERMISSIONS.ANALYTICS_CREATE },
  "/admin/customers": { permission: ADMIN_PERMISSIONS.CUSTOMERS_VIEW },
  "/admin/customers/new": { permission: ADMIN_PERMISSIONS.CUSTOMERS_CREATE },
  "/admin/settings/account": { allowAnyAdmin: true },
  "/admin/settings": { permission: ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW },
  "/admin/settings/theme": {
    permission: ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW,
  },
  "/admin/settings/notifications": {
    permission: ADMIN_PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT,
  },
  "/admin/settings/hero-sliders": {
    permission: ADMIN_PERMISSIONS.SETTINGS_HEADER_EDIT,
  },
  "/admin/settings/checkout": {
    permission: ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW,
  },
  "/admin/settings/delivery-providers": {
    permission: ADMIN_PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW,
  },
  "/admin/settings/fraud-checker": {
    permission: ADMIN_PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW,
  },
  "/admin/settings/meta-conversion": {
    permission: ADMIN_PERMISSIONS.ANALYTICS_VIEW,
  },
  "/admin/settings/cache": {
    permission: ADMIN_PERMISSIONS.SETTINGS_CACHE_VIEW,
  },
};

const DYNAMIC_PAGE_PERMISSIONS: Array<{
  pattern: RegExp;
  config: PagePermissionConfig;
}> = [
  {
    pattern: /^\/admin\/products\/[^/]+\/edit$/,
    config: { permission: ADMIN_PERMISSIONS.PRODUCTS_EDIT },
  },
  {
    pattern: /^\/admin\/products\/[^/]+$/,
    config: { permission: ADMIN_PERMISSIONS.PRODUCTS_VIEW },
  },
  {
    pattern: /^\/admin\/categories\/[^/]+\/edit$/,
    config: { permission: ADMIN_PERMISSIONS.CATEGORIES_EDIT },
  },
  {
    pattern: /^\/admin\/collections\/[^/]+\/edit$/,
    config: { permission: ADMIN_PERMISSIONS.COLLECTIONS_EDIT },
  },
  {
    pattern: /^\/admin\/orders\/[^/]+\/edit$/,
    config: { permission: ADMIN_PERMISSIONS.ORDERS_EDIT },
  },
  {
    pattern: /^\/admin\/orders\/[^/]+$/,
    config: { permission: ADMIN_PERMISSIONS.ORDERS_VIEW },
  },
  {
    pattern: /^\/admin\/customers\/[^/]+\/edit$/,
    config: { permission: ADMIN_PERMISSIONS.CUSTOMERS_EDIT },
  },
  {
    pattern: /^\/admin\/customers\/[^/]+\/history$/,
    config: { permission: ADMIN_PERMISSIONS.CUSTOMERS_VIEW_HISTORY },
  },
  {
    pattern: /^\/admin\/discounts\/[^/]+\/edit$/,
    config: { permission: ADMIN_PERMISSIONS.DISCOUNTS_EDIT },
  },
  {
    pattern: /^\/admin\/analytics\/[^/]+\/edit$/,
    config: { permission: ADMIN_PERMISSIONS.ANALYTICS_EDIT },
  },
  {
    pattern: /^\/admin\/pages\/[^/]+\/edit$/,
    config: { permission: ADMIN_PERMISSIONS.PAGES_EDIT },
  },
  {
    pattern: /^\/admin\/widgets\/[^/]+$/,
    config: { permission: ADMIN_PERMISSIONS.WIDGETS_EDIT },
  },
];

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

export interface AdminAccessContext {
  isSuperAdmin: boolean;
  permissions: PermissionCollection;
  hasAdminAccess?: boolean;
}

function toPermissionSet(permissions: PermissionCollection): Set<string> {
  return Array.isArray(permissions) ? new Set(permissions) : permissions;
}

function normalizeAdminPath(pathname: string): string {
  if (pathname === "/admin/") return "/admin";
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export function getAdminPagePermission(
  pathname: string,
): PagePermissionConfig | undefined {
  const normalizedPath = normalizeAdminPath(pathname);
  const exactMatch = PAGE_PERMISSION_MAP[normalizedPath];
  if (exactMatch) return exactMatch;

  for (const { pattern, config } of DYNAMIC_PAGE_PERMISSIONS) {
    if (pattern.test(normalizedPath)) return config;
  }

  return undefined;
}

function hasPageAccess(
  permissions: Set<string>,
  isSuperAdmin: boolean,
  pathname: string,
): boolean {
  if (isSuperAdmin) return true;

  const config = getAdminPagePermission(pathname);
  if (!config) return false;
  if (config.allowAnyAdmin) return true;
  if (config.permission) return permissions.has(config.permission);
  if (config.anyOf) return config.anyOf.some((p) => permissions.has(p));
  if (config.allOf) return config.allOf.every((p) => permissions.has(p));
  return true;
}

function getDefaultAdminPage(
  permissions: Set<string>,
  isSuperAdmin: boolean,
): string | null {
  return (
    DEFAULT_ADMIN_PAGE_CANDIDATES.find((path) =>
      hasPageAccess(permissions, isSuperAdmin, path),
    ) ?? null
  );
}

export function hasRbacAdminAccess({
  isSuperAdmin,
  permissions,
}: {
  isSuperAdmin: boolean;
  permissions: PermissionCollection;
}): boolean {
  const permissionCount = Array.isArray(permissions)
    ? permissions.length
    : permissions.size;
  return isSuperAdmin || permissionCount > 0;
}

export function canAccessAdminPath(
  pathname: string,
  context: AdminAccessContext,
): boolean {
  const normalizedPath = normalizeAdminPath(pathname);
  if (normalizedPath === ADMIN_ACCESS_DENIED_PATH) return true;

  const hasAdminAccess =
    context.hasAdminAccess ??
    hasRbacAdminAccess({
      isSuperAdmin: context.isSuperAdmin,
      permissions: context.permissions,
    });
  if (!hasAdminAccess) return false;

  return hasPageAccess(
    toPermissionSet(context.permissions),
    context.isSuperAdmin,
    normalizedPath,
  );
}

export function getDefaultAdminPath(context: AdminAccessContext): string {
  const hasAdminAccess =
    context.hasAdminAccess ??
    hasRbacAdminAccess({
      isSuperAdmin: context.isSuperAdmin,
      permissions: context.permissions,
    });
  if (!hasAdminAccess) return ADMIN_ACCESS_DENIED_PATH;

  return (
    getDefaultAdminPage(
      toPermissionSet(context.permissions),
      context.isSuperAdmin,
    ) ?? ADMIN_ACCESS_DENIED_PATH
  );
}

export function shouldAllowAdminPath(
  pathname: string,
  access: boolean | AdminAccessContext,
): boolean {
  if (typeof access === "boolean") {
    return access || normalizeAdminPath(pathname) === ADMIN_ACCESS_DENIED_PATH;
  }
  return canAccessAdminPath(pathname, access);
}
