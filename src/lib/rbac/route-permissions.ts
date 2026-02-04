// src/lib/rbac/route-permissions.ts
// Mapping of API routes to required permissions

import { PERMISSIONS } from "./permissions";
import type { PermissionName } from "./types";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RoutePermission {
  // Single permission required
  permission?: PermissionName;
  // Any of these permissions is sufficient
  anyOf?: PermissionName[];
  // All of these permissions are required
  allOf?: PermissionName[];
}

type RouteConfig = {
  [method in HttpMethod]?: RoutePermission;
};

/**
 * Route permission mapping
 * Keys are URL patterns (glob-like)
 * Values define required permissions per HTTP method
 */
export const ROUTE_PERMISSIONS: Record<string, RouteConfig> = {
  // =============================================
  // Products API
  // =============================================
  "/api/products": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_CREATE },
  },
  "/api/products/*": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
    DELETE: { permission: PERMISSIONS.PRODUCTS_DELETE },
  },
  "/api/products/*/restore": {
    POST: { permission: PERMISSIONS.PRODUCTS_RESTORE },
  },
  "/api/products/*/permanent-delete": {
    DELETE: { permission: PERMISSIONS.PRODUCTS_PERMANENT_DELETE },
  },
  "/api/products/bulk": {
    POST: { permission: PERMISSIONS.PRODUCTS_BULK_OPERATIONS },
    DELETE: { permission: PERMISSIONS.PRODUCTS_BULK_OPERATIONS },
  },

  // =============================================
  // Categories API
  // =============================================
  "/api/categories": {
    GET: { permission: PERMISSIONS.CATEGORIES_VIEW },
    POST: { permission: PERMISSIONS.CATEGORIES_CREATE },
  },
  "/api/categories/*": {
    GET: { permission: PERMISSIONS.CATEGORIES_VIEW },
    PUT: { permission: PERMISSIONS.CATEGORIES_EDIT },
    PATCH: { permission: PERMISSIONS.CATEGORIES_EDIT },
    DELETE: { permission: PERMISSIONS.CATEGORIES_DELETE },
  },
  "/api/categories/*/restore": {
    POST: { permission: PERMISSIONS.CATEGORIES_RESTORE },
  },

  // =============================================
  // Collections API
  // =============================================
  "/api/collections": {
    GET: { permission: PERMISSIONS.COLLECTIONS_VIEW },
    POST: { permission: PERMISSIONS.COLLECTIONS_CREATE },
  },
  "/api/collections/*": {
    GET: { permission: PERMISSIONS.COLLECTIONS_VIEW },
    PUT: { permission: PERMISSIONS.COLLECTIONS_EDIT },
    PATCH: { permission: PERMISSIONS.COLLECTIONS_EDIT },
    DELETE: { permission: PERMISSIONS.COLLECTIONS_DELETE },
  },
  "/api/collections/*/toggle": {
    POST: { permission: PERMISSIONS.COLLECTIONS_TOGGLE_STATUS },
  },

  // =============================================
  // Orders API
  // =============================================
  "/api/orders": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_CREATE },
  },
  "/api/orders/*": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    PUT: { permission: PERMISSIONS.ORDERS_EDIT },
    PATCH: { permission: PERMISSIONS.ORDERS_EDIT },
    DELETE: { permission: PERMISSIONS.ORDERS_DELETE },
  },
  "/api/orders/*/status": {
    PUT: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
    PATCH: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
  },
  "/api/orders/*/restore": {
    POST: { permission: PERMISSIONS.ORDERS_RESTORE },
  },

  // =============================================
  // Shipments API
  // =============================================
  "/api/shipments": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/shipments/*": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    PUT: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
    DELETE: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },

  // =============================================
  // Customers API
  // =============================================
  "/api/customers": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
    POST: { permission: PERMISSIONS.CUSTOMERS_CREATE },
  },
  "/api/customers/*": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
    PUT: { permission: PERMISSIONS.CUSTOMERS_EDIT },
    PATCH: { permission: PERMISSIONS.CUSTOMERS_EDIT },
    DELETE: { permission: PERMISSIONS.CUSTOMERS_DELETE },
  },
  "/api/customers/*/history": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW_HISTORY },
  },
  "/api/customers/sync": {
    POST: { permission: PERMISSIONS.CUSTOMERS_SYNC },
  },

  // =============================================
  // Discounts API (SENSITIVE)
  // =============================================
  "/api/discounts": {
    GET: { permission: PERMISSIONS.DISCOUNTS_VIEW },
    POST: { permission: PERMISSIONS.DISCOUNTS_CREATE },
  },
  "/api/discounts/*": {
    GET: { permission: PERMISSIONS.DISCOUNTS_VIEW },
    PUT: { permission: PERMISSIONS.DISCOUNTS_EDIT },
    PATCH: { permission: PERMISSIONS.DISCOUNTS_EDIT },
    DELETE: { permission: PERMISSIONS.DISCOUNTS_DELETE },
  },
  "/api/discounts/*/toggle": {
    POST: { permission: PERMISSIONS.DISCOUNTS_TOGGLE_STATUS },
  },

  // =============================================
  // Pages API
  // =============================================
  "/api/pages": {
    GET: { permission: PERMISSIONS.PAGES_VIEW },
    POST: { permission: PERMISSIONS.PAGES_CREATE },
  },
  "/api/pages/*": {
    GET: { permission: PERMISSIONS.PAGES_VIEW },
    PUT: { permission: PERMISSIONS.PAGES_EDIT },
    PATCH: { permission: PERMISSIONS.PAGES_EDIT },
    DELETE: { permission: PERMISSIONS.PAGES_DELETE },
  },
  "/api/pages/*/publish": {
    POST: { permission: PERMISSIONS.PAGES_PUBLISH },
  },

  // =============================================
  // Widgets API
  // =============================================
  "/api/widgets": {
    GET: { permission: PERMISSIONS.WIDGETS_VIEW },
    POST: { permission: PERMISSIONS.WIDGETS_CREATE },
  },
  "/api/widgets/*": {
    GET: { permission: PERMISSIONS.WIDGETS_VIEW },
    PUT: { permission: PERMISSIONS.WIDGETS_EDIT },
    PATCH: { permission: PERMISSIONS.WIDGETS_EDIT },
    DELETE: { permission: PERMISSIONS.WIDGETS_DELETE },
  },
  "/api/widgets/*/toggle": {
    POST: { permission: PERMISSIONS.WIDGETS_TOGGLE_STATUS },
  },

  // =============================================
  // Media API
  // =============================================
  "/api/media": {
    GET: { permission: PERMISSIONS.MEDIA_VIEW },
    POST: { permission: PERMISSIONS.MEDIA_UPLOAD },
  },
  "/api/media/*": {
    GET: { permission: PERMISSIONS.MEDIA_VIEW },
    DELETE: { permission: PERMISSIONS.MEDIA_DELETE },
  },
  "/api/media/folders": {
    GET: { permission: PERMISSIONS.MEDIA_VIEW },
    POST: { permission: PERMISSIONS.MEDIA_MANAGE_FOLDERS },
  },
  "/api/media/folders/*": {
    PUT: { permission: PERMISSIONS.MEDIA_MANAGE_FOLDERS },
    DELETE: { permission: PERMISSIONS.MEDIA_MANAGE_FOLDERS },
  },

  // =============================================
  // Attributes API
  // =============================================
  "/api/attributes": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    POST: { permission: PERMISSIONS.ATTRIBUTES_CREATE },
  },
  "/api/attributes/*": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    PUT: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    PATCH: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_DELETE },
  },

  // =============================================
  // Analytics API
  // =============================================
  "/api/analytics": {
    GET: { permission: PERMISSIONS.ANALYTICS_VIEW },
    POST: { permission: PERMISSIONS.ANALYTICS_CREATE },
  },
  "/api/analytics/*": {
    GET: { permission: PERMISSIONS.ANALYTICS_VIEW },
    PUT: { permission: PERMISSIONS.ANALYTICS_EDIT },
    PATCH: { permission: PERMISSIONS.ANALYTICS_EDIT },
    DELETE: { permission: PERMISSIONS.ANALYTICS_EDIT },
  },
  "/api/analytics/*/toggle": {
    POST: { permission: PERMISSIONS.ANALYTICS_TOGGLE },
  },

  // =============================================
  // Settings API (SENSITIVE)
  // =============================================
  "/api/settings": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  },
  "/api/admin/settings/general": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/admin/settings/header": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/admin/settings/footer": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_FOOTER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_FOOTER_EDIT },
  },
  "/api/admin/settings/seo": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_SEO_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_SEO_EDIT },
  },
  "/api/admin/settings/delivery-locations": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
  },
  "/api/admin/settings/delivery-locations/*": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
  },
  "/api/admin/settings/delivery-providers": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT },
  },
  "/api/admin/settings/delivery-providers/*": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT },
  },
  "/api/admin/settings/shipping-methods": {
    GET: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
  },
  "/api/admin/settings/shipping-methods/*": {
    GET: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
  },
  "/api/admin/settings/fraud-checker": {
    GET: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT },
  },
  "/api/admin/settings/cache": {
    GET: { permission: PERMISSIONS.SETTINGS_CACHE_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_CACHE_MANAGE },
    DELETE: { permission: PERMISSIONS.SETTINGS_CACHE_MANAGE },
  },
  "/api/admin/settings/notifications": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
  },

  // =============================================
  // Team/Admin API
  // =============================================
  "/api/admin/users": {
    GET: { permission: PERMISSIONS.TEAM_VIEW },
    POST: { permission: PERMISSIONS.TEAM_MANAGE },
  },
  "/api/admin/users/*": {
    GET: { permission: PERMISSIONS.TEAM_VIEW },
    PUT: { permission: PERMISSIONS.TEAM_MANAGE },
    DELETE: { permission: PERMISSIONS.TEAM_MANAGE },
  },

  // =============================================
  // RBAC API (protected separately in individual files)
  // =============================================
  "/api/admin/rbac/roles": {
    GET: { anyOf: [PERMISSIONS.TEAM_VIEW, PERMISSIONS.TEAM_MANAGE_ROLES] },
    POST: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
  },
  "/api/admin/rbac/roles/*": {
    GET: { anyOf: [PERMISSIONS.TEAM_VIEW, PERMISSIONS.TEAM_MANAGE_ROLES] },
    PUT: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
    DELETE: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
  },
  "/api/admin/rbac/permissions": {
    GET: { anyOf: [PERMISSIONS.TEAM_VIEW, PERMISSIONS.TEAM_MANAGE_ROLES] },
  },
  "/api/admin/rbac/user-roles": {
    POST: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
    DELETE: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
  },
  "/api/admin/rbac/user-permissions": {
    POST: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
    DELETE: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
  },

  // =============================================
  // Dashboard API
  // =============================================
  "/api/dashboard": {
    GET: { permission: PERMISSIONS.DASHBOARD_VIEW },
  },
  "/api/dashboard/analytics": {
    GET: { permission: PERMISSIONS.DASHBOARD_ANALYTICS },
  },
};

/**
 * Get the permission configuration for a route and method
 */
export function getRoutePermission(
  pathname: string,
  method: HttpMethod
): RoutePermission | null {
  // Try exact match first
  const exactMatch = ROUTE_PERMISSIONS[pathname];
  if (exactMatch && exactMatch[method]) {
    return exactMatch[method] || null;
  }

  // Try pattern matching with wildcards
  for (const [pattern, config] of Object.entries(ROUTE_PERMISSIONS)) {
    if (matchPattern(pattern, pathname)) {
      if (config[method]) {
        return config[method] || null;
      }
    }
  }

  return null;
}

/**
 * Simple pattern matching with * wildcard
 */
function matchPattern(pattern: string, pathname: string): boolean {
  if (!pattern.includes("*")) {
    return pattern === pathname;
  }

  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/\*/g, "[^/]+") // * matches anything except /
    .replace(/\//g, "\\/"); // Escape forward slashes

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(pathname);
}
