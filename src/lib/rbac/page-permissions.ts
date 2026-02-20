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
}

// Admin page route to permission mapping.
// Routes are matched from most specific to least specific.
// Routes not listed here are accessible to any authenticated admin.
const PAGE_PERMISSION_MAP: Record<string, PagePermissionConfig> = {
  // Dashboard
  "/admin": { permission: PERMISSIONS.DASHBOARD_VIEW },

  // Inventory
  "/admin/inventory": { permission: PERMISSIONS.PRODUCTS_VIEW },

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
  "/admin/collections/trash": { permission: PERMISSIONS.COLLECTIONS_VIEW },

  // Media
  "/admin/media": { permission: PERMISSIONS.MEDIA_VIEW },

  // Pages
  "/admin/pages": { permission: PERMISSIONS.PAGES_VIEW },
  "/admin/pages/new": { permission: PERMISSIONS.PAGES_CREATE },
  "/admin/pages/trash": { permission: PERMISSIONS.PAGES_VIEW },

  // Widgets
  "/admin/widgets": { permission: PERMISSIONS.WIDGETS_VIEW },
  "/admin/widgets/create": { permission: PERMISSIONS.WIDGETS_CREATE },
  "/admin/widgets/trash": { permission: PERMISSIONS.WIDGETS_VIEW },

  // Orders
  "/admin/orders": { permission: PERMISSIONS.ORDERS_VIEW },
  "/admin/orders/new": { permission: PERMISSIONS.ORDERS_CREATE },

  // Abandoned Checkouts (requires orders.view)
  "/admin/abandoned-checkouts": { permission: PERMISSIONS.ORDERS_VIEW },

  // Discounts
  "/admin/discounts": { permission: PERMISSIONS.DISCOUNTS_VIEW },
  "/admin/discounts/new": { permission: PERMISSIONS.DISCOUNTS_CREATE },

  // Analytics
  "/admin/analytics": { permission: PERMISSIONS.ANALYTICS_VIEW },
  "/admin/analytics/new": { permission: PERMISSIONS.ANALYTICS_CREATE },

  // Customers
  "/admin/customers": { permission: PERMISSIONS.CUSTOMERS_VIEW },
  "/admin/customers/new": { permission: PERMISSIONS.CUSTOMERS_CREATE },

  // Settings - Account is always accessible (own account management)
  // "/admin/settings/account" is intentionally NOT listed here
  "/admin/settings": { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  "/admin/settings/notifications": { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
  "/admin/settings/hero-sliders": { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  "/admin/settings/delivery-locations": { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW },
  "/admin/settings/delivery-providers": { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW },
  "/admin/settings/fraud-checker": { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW },
  "/admin/settings/shipping-methods": { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW },
  "/admin/settings/checkout-languages": { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  "/admin/settings/meta-conversion": { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  "/admin/settings/payment-gateways": { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  "/admin/settings/cache": { permission: PERMISSIONS.SETTINGS_CACHE_VIEW },
};

// Dynamic route patterns for pages with parameters (e.g., /admin/products/[id]/edit)
// These match routes like /admin/products/abc123/edit
const DYNAMIC_PAGE_PERMISSIONS: Array<{
  pattern: RegExp;
  config: PagePermissionConfig;
}> = [
  // Products
  { pattern: /^\/admin\/products\/[^/]+\/edit$/, config: { permission: PERMISSIONS.PRODUCTS_EDIT } },
  { pattern: /^\/admin\/products\/[^/]+$/, config: { permission: PERMISSIONS.PRODUCTS_VIEW } },

  // Categories
  { pattern: /^\/admin\/categories\/[^/]+\/edit$/, config: { permission: PERMISSIONS.CATEGORIES_EDIT } },

  // Collections
  { pattern: /^\/admin\/collections\/[^/]+\/edit$/, config: { permission: PERMISSIONS.COLLECTIONS_EDIT } },

  // Orders
  { pattern: /^\/admin\/orders\/[^/]+\/edit$/, config: { permission: PERMISSIONS.ORDERS_EDIT } },
  { pattern: /^\/admin\/orders\/[^/]+$/, config: { permission: PERMISSIONS.ORDERS_VIEW } },

  // Customers
  { pattern: /^\/admin\/customers\/[^/]+\/edit$/, config: { permission: PERMISSIONS.CUSTOMERS_EDIT } },
  { pattern: /^\/admin\/customers\/[^/]+\/history$/, config: { permission: PERMISSIONS.CUSTOMERS_VIEW_HISTORY } },

  // Discounts
  { pattern: /^\/admin\/discounts\/[^/]+\/edit$/, config: { permission: PERMISSIONS.DISCOUNTS_EDIT } },

  // Analytics
  { pattern: /^\/admin\/analytics\/[^/]+\/edit$/, config: { permission: PERMISSIONS.ANALYTICS_EDIT } },

  // Pages
  { pattern: /^\/admin\/pages\/[^/]+\/edit$/, config: { permission: PERMISSIONS.PAGES_EDIT } },

  // Widgets (single dynamic segment, no /edit)
  { pattern: /^\/admin\/widgets\/[^/]+$/, config: { permission: PERMISSIONS.WIDGETS_EDIT } },
];

/**
 * Get the permission config for a given admin page route.
 * Returns undefined if no specific permission is required (e.g., /admin/settings/account).
 */
export function getPagePermission(pathname: string): PagePermissionConfig | undefined {
  // Strip trailing slash for consistent matching
  const normalizedPath = pathname.endsWith("/") && pathname !== "/"
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
  pathname: string
): boolean {
  if (isSuperAdmin) return true;

  const config = getPagePermission(pathname);
  if (!config) return true; // No specific permission required

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
