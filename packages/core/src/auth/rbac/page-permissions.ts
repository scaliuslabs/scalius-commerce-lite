// src/lib/rbac/page-permissions.ts
// Maps admin page routes to their required permissions for UI filtering and middleware enforcement.
import { PERMISSIONS } from "./permissions";

export interface PagePermissionConfig {
  // Single permission required to view this page
  permission?: string;
  // Any of these permissions is sufficient
  anyOf?: string[];
  // All of these permissions are required
  allOf?: string[];
  // Authenticated users with any admin access may open this page.
  allowAnyAdmin?: boolean;
}

const TEAM_PAGE_PERMISSIONS = [
  PERMISSIONS.TEAM_VIEW,
  PERMISSIONS.TEAM_MANAGE,
  PERMISSIONS.TEAM_MANAGE_ROLES,
] as const;
const SHIPPING_PAGE_PERMISSIONS = [
  PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW,
  PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW,
  PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW,
] as const;
const APPS_PAGE_PERMISSIONS = [
  PERMISSIONS.ANALYTICS_VIEW,
  PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW,
  PERMISSIONS.AGENT_ACCESS_VIEW,
  PERMISSIONS.SETTINGS_GENERAL_VIEW,
] as const;
const SETTINGS_PAGE_PERMISSIONS = [
  PERMISSIONS.SETTINGS_GENERAL_VIEW,
  PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT,
  PERMISSIONS.TAXES_VIEW,
  ...TEAM_PAGE_PERMISSIONS,
  ...SHIPPING_PAGE_PERMISSIONS,
  ...APPS_PAGE_PERMISSIONS,
] as const;

// Admin page route to permission mapping.
// Routes are matched from most specific to least specific.
// Routes not listed here should be treated as unmapped and denied by the admin shell.
const PAGE_PERMISSION_MAP: Record<string, PagePermissionConfig> = {
  // Explicit permissionless admin utility pages
  "/admin/access-denied": { allowAnyAdmin: true },
  // Own profile, password, two-step verification and sessions.
  "/admin/account": { allowAnyAdmin: true },

  // Dashboard
  "/admin": { permission: PERMISSIONS.DASHBOARD_VIEW },

  // Inventory
  "/admin/inventory": { permission: PERMISSIONS.PRODUCTS_VIEW },
  "/admin/inventory/labels": { permission: PERMISSIONS.PRODUCTS_VIEW },

  // Products
  "/admin/products": { permission: PERMISSIONS.PRODUCTS_VIEW },
  "/admin/products/new": { permission: PERMISSIONS.PRODUCTS_CREATE },

  // Categories
  "/admin/categories": { permission: PERMISSIONS.CATEGORIES_VIEW },
  "/admin/categories/new": { permission: PERMISSIONS.CATEGORIES_CREATE },

  // Attributes
  "/admin/attributes": { permission: PERMISSIONS.ATTRIBUTES_VIEW },

  // Collections
  "/admin/collections": { permission: PERMISSIONS.COLLECTIONS_VIEW },
  "/admin/collections/new": { permission: PERMISSIONS.COLLECTIONS_CREATE },

  // Media
  "/admin/media": { permission: PERMISSIONS.MEDIA_VIEW },

  // Pages
  "/admin/pages": { permission: PERMISSIONS.PAGES_VIEW },
  "/admin/pages/new": { permission: PERMISSIONS.PAGES_CREATE },
  "/admin/articles": { permission: PERMISSIONS.PAGES_VIEW },
  "/admin/articles/new": { permission: PERMISSIONS.PAGES_CREATE },

  // Online store
  "/admin/online-store/theme": { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  "/admin/online-store/navigation": {
    permission: PERMISSIONS.SETTINGS_HEADER_EDIT,
  },
  "/admin/online-store/banners": {
    permission: PERMISSIONS.SETTINGS_HEADER_EDIT,
  },
  "/admin/online-store/preferences": {
    permission: PERMISSIONS.SETTINGS_GENERAL_VIEW,
  },

  // Orders
  "/admin/orders": { permission: PERMISSIONS.ORDERS_VIEW },
  "/admin/orders/new": { permission: PERMISSIONS.ORDERS_CREATE },

  // Abandoned checkouts live under Orders (requires orders.view)
  "/admin/orders/abandoned": { permission: PERMISSIONS.ORDERS_VIEW },

  // Discounts
  "/admin/discounts": { permission: PERMISSIONS.DISCOUNTS_VIEW },
  "/admin/discounts/new": { permission: PERMISSIONS.DISCOUNTS_CREATE },


  // Customers
  "/admin/customers": { permission: PERMISSIONS.CUSTOMERS_VIEW },
  "/admin/customers/new": { permission: PERMISSIONS.CUSTOMERS_CREATE },

  // Settings - Account is always accessible (own account management)
  "/admin/settings/account": { allowAnyAdmin: true },

  // Settings list: each page is gated by the permission its cards read with.
  "/admin/settings": { anyOf: [...SETTINGS_PAGE_PERMISSIONS] },
  "/admin/settings/store": { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  "/admin/settings/users": { anyOf: [...TEAM_PAGE_PERMISSIONS] },
  "/admin/settings/payments": { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  "/admin/settings/checkout": { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  "/admin/settings/shipping": { anyOf: [...SHIPPING_PAGE_PERMISSIONS] },
  "/admin/settings/shipping/areas": {
    permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW,
  },
  "/admin/settings/taxes": { permission: PERMISSIONS.TAXES_VIEW },
  "/admin/settings/notifications": {
    anyOf: [
      PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT,
      PERMISSIONS.SETTINGS_GENERAL_VIEW,
    ],
  },
  "/admin/settings/policies": { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  "/admin/settings/apps": { anyOf: [...APPS_PAGE_PERMISSIONS] },
  "/admin/settings/customer-accounts": {
    permission: PERMISSIONS.SETTINGS_GENERAL_VIEW,
  },
  "/admin/settings/advanced": { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
};

// Dynamic route patterns for pages with parameters (e.g., /admin/products/[id]/edit)
// These match routes like /admin/products/abc123/edit
const DYNAMIC_PAGE_PERMISSIONS: Array<{
  pattern: RegExp;
  config: PagePermissionConfig;
}> = [
  // OAuth connection consent is an authority mutation, not a read-only page.
  {
    pattern: /^\/admin\/settings\/agent-access\/authorize\/[^/]+$/,
    config: { permission: PERMISSIONS.AGENT_ACCESS_MANAGE },
  },

  // Online store menu editor
  {
    pattern: /^\/admin\/online-store\/navigation\/[^/]+$/,
    config: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },

  // Products: one detail page; saving still requires products.edit.
  {
    pattern: /^\/admin\/products\/[^/]+\/edit$/,
    config: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },

  // Catalog and content records open read-only for view roles; saving still
  // needs the edit permission.
  {
    pattern: /^\/admin\/categories\/[^/]+\/edit$/,
    config: { permission: PERMISSIONS.CATEGORIES_VIEW },
  },
  {
    pattern: /^\/admin\/collections\/[^/]+\/edit$/,
    config: { permission: PERMISSIONS.COLLECTIONS_VIEW },
  },

  // Orders
  {
    pattern: /^\/admin\/orders\/[^/]+\/edit$/,
    config: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  {
    pattern: /^\/admin\/orders\/[^/]+$/,
    config: { permission: PERMISSIONS.ORDERS_VIEW },
  },

  // Customers: one customer page; saving and order history are gated inside it.
  {
    pattern: /^\/admin\/customers\/[^/]+\/edit$/,
    config: { permission: PERMISSIONS.CUSTOMERS_VIEW },
  },

  // Discounts (one editor; saving still needs discounts.edit)
  {
    pattern: /^\/admin\/discounts\/[^/]+$/,
    config: { permission: PERMISSIONS.DISCOUNTS_VIEW },
  },

  {
    pattern: /^\/admin\/pages\/[^/]+\/edit$/,
    config: { permission: PERMISSIONS.PAGES_VIEW },
  },
  {
    pattern: /^\/admin\/articles\/[^/]+\/edit$/,
    config: { permission: PERMISSIONS.PAGES_VIEW },
  },

  // Staff and roles: one page each, opened from Settings → Users.
  {
    pattern: /^\/admin\/settings\/users\/roles\/[^/]+$/,
    config: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
  },
  {
    pattern: /^\/admin\/settings\/users\/[^/]+$/,
    config: { anyOf: [PERMISSIONS.TEAM_MANAGE, PERMISSIONS.TEAM_MANAGE_ROLES] },
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
  "/admin/articles",
  "/admin/media",
  "/admin/account",
] as const;

/**
 * Get the permission config for a given admin page route.
 * Returns undefined if no specific permission is required (e.g., /admin/account).
 */
export function getPagePermission(
  pathname: string,
): PagePermissionConfig | undefined {
  // Strip trailing slash for consistent matching
  const normalizedPath =
    pathname.endsWith("/") && pathname !== "/"
      ? pathname.slice(0, -1)
      : pathname;

  // Check exact match first (static routes)
  const exactMatch = PAGE_PERMISSION_MAP[normalizedPath];
  if (exactMatch) {
    return exactMatch;
  }

  // Check dynamic route patterns
  for (const { pattern, config } of DYNAMIC_PAGE_PERMISSIONS) {
    if (pattern.test(normalizedPath)) {
      return config;
    }
  }

  return undefined;
}

/**
 * Check if a user has the required permission for a page.
 * Super admins always have access.
 */
export function hasPageAccess(
  permissions: Set<string>,
  isSuperAdmin: boolean,
  pathname: string,
): boolean {
  if (isSuperAdmin) return true;

  const config = getPagePermission(pathname);
  if (!config) return false;
  if (config.allowAnyAdmin) return true;

  if (config.permission) {
    return permissions.has(config.permission);
  }

  if (config.anyOf) {
    return config.anyOf.some((p) => permissions.has(p));
  }

  if (config.allOf) {
    return config.allOf.every((p) => permissions.has(p));
  }

  return true;
}

export function getDefaultAdminPage(
  permissions: Set<string>,
  isSuperAdmin: boolean,
): string | null {
  return (
    DEFAULT_ADMIN_PAGE_CANDIDATES.find((path) =>
      hasPageAccess(permissions, isSuperAdmin, path),
    ) ?? null
  );
}
