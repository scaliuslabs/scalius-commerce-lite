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
  "/api/products/bulk-delete": {
    POST: { permission: PERMISSIONS.PRODUCTS_BULK_OPERATIONS },
    DELETE: { permission: PERMISSIONS.PRODUCTS_BULK_OPERATIONS },
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
  "/api/products/*/permanent": {
    DELETE: { permission: PERMISSIONS.PRODUCTS_PERMANENT_DELETE },
  },
  "/api/products/*/variants": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/products/*/variants/*": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
    DELETE: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/products/*/variants/bulk-create": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/products/*/variants/bulk-delete": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
    DELETE: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/products/*/variants/sort-order": {
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/products/*/variants/*/duplicate": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },

  // =============================================
  // Categories API
  // =============================================
  "/api/categories": {
    GET: { permission: PERMISSIONS.CATEGORIES_VIEW },
    POST: { permission: PERMISSIONS.CATEGORIES_CREATE },
  },
  "/api/categories/bulk-delete": {
    POST: { permission: PERMISSIONS.CATEGORIES_DELETE },
    DELETE: { permission: PERMISSIONS.CATEGORIES_DELETE },
  },
  "/api/categories/bulk-restore": {
    POST: { permission: PERMISSIONS.CATEGORIES_RESTORE },
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
  "/api/categories/*/permanent": {
    DELETE: { permission: PERMISSIONS.CATEGORIES_PERMANENT_DELETE },
  },

  // =============================================
  // Collections API
  // =============================================
  "/api/collections": {
    GET: { permission: PERMISSIONS.COLLECTIONS_VIEW },
    POST: { permission: PERMISSIONS.COLLECTIONS_CREATE },
  },
  "/api/collections/bulk-activate": {
    POST: { permission: PERMISSIONS.COLLECTIONS_TOGGLE_STATUS },
  },
  "/api/collections/bulk-deactivate": {
    POST: { permission: PERMISSIONS.COLLECTIONS_TOGGLE_STATUS },
  },
  "/api/collections/bulk-delete": {
    POST: { permission: PERMISSIONS.COLLECTIONS_DELETE },
    DELETE: { permission: PERMISSIONS.COLLECTIONS_DELETE },
  },
  "/api/collections/bulk-restore": {
    POST: { permission: PERMISSIONS.COLLECTIONS_RESTORE },
  },
  "/api/collections/*": {
    GET: { permission: PERMISSIONS.COLLECTIONS_VIEW },
    PUT: { permission: PERMISSIONS.COLLECTIONS_EDIT },
    PATCH: { permission: PERMISSIONS.COLLECTIONS_EDIT },
    DELETE: { permission: PERMISSIONS.COLLECTIONS_DELETE },
  },
  "/api/collections/*/restore": {
    POST: { permission: PERMISSIONS.COLLECTIONS_RESTORE },
  },
  "/api/collections/*/permanent": {
    DELETE: { permission: PERMISSIONS.COLLECTIONS_DELETE },
  },

  // =============================================
  // Orders API
  // =============================================
  "/api/orders": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_CREATE },
  },
  "/api/orders/bulk-delete": {
    POST: { permission: PERMISSIONS.ORDERS_DELETE },
    DELETE: { permission: PERMISSIONS.ORDERS_DELETE },
  },
  "/api/orders/bulk-ship": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
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
    POST: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
  },
  "/api/orders/*/restore": {
    POST: { permission: PERMISSIONS.ORDERS_RESTORE },
  },
  "/api/orders/*/shipments": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/orders/*/shipments/*": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    PUT: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
    DELETE: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/orders/*/shipments/*/status": {
    PUT: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
    PATCH: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/orders/*/shipments/*/refresh": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/orders/*/fulfill": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/orders/*/items": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/orders/*/payments": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/orders/*/cod": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },

  // =============================================
  // Shipments API
  // =============================================
  "/api/shipments/*": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    PUT: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
    DELETE: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/shipments/*/check-status": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },

  // =============================================
  // Customers API
  // =============================================
  "/api/customers": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
    POST: { permission: PERMISSIONS.CUSTOMERS_CREATE },
  },
  "/api/customers/bulk-delete": {
    POST: { permission: PERMISSIONS.CUSTOMERS_DELETE },
    DELETE: { permission: PERMISSIONS.CUSTOMERS_DELETE },
  },
  "/api/customers/sync": {
    POST: { permission: PERMISSIONS.CUSTOMERS_SYNC },
  },
  "/api/customers/*": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
    PUT: { permission: PERMISSIONS.CUSTOMERS_EDIT },
    PATCH: { permission: PERMISSIONS.CUSTOMERS_EDIT },
    DELETE: { permission: PERMISSIONS.CUSTOMERS_DELETE },
  },
  "/api/customers/*/restore": {
    POST: { permission: PERMISSIONS.CUSTOMERS_EDIT },
  },
  "/api/customers/*/permanent": {
    DELETE: { permission: PERMISSIONS.CUSTOMERS_DELETE },
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
  "/api/pages/bulk-delete": {
    POST: { permission: PERMISSIONS.PAGES_DELETE },
    DELETE: { permission: PERMISSIONS.PAGES_DELETE },
  },
  "/api/pages/bulk-restore": {
    POST: { permission: PERMISSIONS.PAGES_EDIT },
  },
  "/api/pages/bulk-publish": {
    POST: { permission: PERMISSIONS.PAGES_PUBLISH },
  },
  "/api/pages/bulk-unpublish": {
    POST: { permission: PERMISSIONS.PAGES_PUBLISH },
  },
  "/api/pages/*": {
    GET: { permission: PERMISSIONS.PAGES_VIEW },
    PUT: { permission: PERMISSIONS.PAGES_EDIT },
    PATCH: { permission: PERMISSIONS.PAGES_EDIT },
    DELETE: { permission: PERMISSIONS.PAGES_DELETE },
  },
  "/api/pages/*/restore": {
    POST: { permission: PERMISSIONS.PAGES_EDIT },
  },
  "/api/pages/*/permanent": {
    DELETE: { permission: PERMISSIONS.PAGES_DELETE },
  },

  // =============================================
  // Widgets API
  // =============================================
  "/api/widgets": {
    GET: { permission: PERMISSIONS.WIDGETS_VIEW },
    POST: { permission: PERMISSIONS.WIDGETS_CREATE },
  },
  "/api/widgets/bulk-delete": {
    POST: { permission: PERMISSIONS.WIDGETS_DELETE },
    DELETE: { permission: PERMISSIONS.WIDGETS_DELETE },
  },
  "/api/widgets/bulk-restore": {
    POST: { permission: PERMISSIONS.WIDGETS_EDIT },
  },
  "/api/widgets/bulk-activate": {
    POST: { permission: PERMISSIONS.WIDGETS_TOGGLE_STATUS },
  },
  "/api/widgets/bulk-deactivate": {
    POST: { permission: PERMISSIONS.WIDGETS_TOGGLE_STATUS },
  },
  "/api/widgets/*": {
    GET: { permission: PERMISSIONS.WIDGETS_VIEW },
    PUT: { permission: PERMISSIONS.WIDGETS_EDIT },
    PATCH: { permission: PERMISSIONS.WIDGETS_EDIT },
    DELETE: { permission: PERMISSIONS.WIDGETS_DELETE },
  },
  "/api/widgets/*/restore": {
    POST: { permission: PERMISSIONS.WIDGETS_EDIT },
  },
  "/api/widgets/*/permanent": {
    DELETE: { permission: PERMISSIONS.WIDGETS_DELETE },
  },
  "/api/widgets/*/toggle-status": {
    POST: { permission: PERMISSIONS.WIDGETS_TOGGLE_STATUS },
    PUT: { permission: PERMISSIONS.WIDGETS_TOGGLE_STATUS },
  },
  "/api/widgets/*/history": {
    GET: { permission: PERMISSIONS.WIDGETS_VIEW },
  },
  "/api/widgets/*/history/*": {
    GET: { permission: PERMISSIONS.WIDGETS_VIEW },
    DELETE: { permission: PERMISSIONS.WIDGETS_EDIT },
  },
  "/api/widgets/*/history/restore": {
    POST: { permission: PERMISSIONS.WIDGETS_EDIT },
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
  // Attributes API (under /api/admin/)
  // =============================================
  "/api/admin/attributes": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    POST: { permission: PERMISSIONS.ATTRIBUTES_CREATE },
  },
  "/api/admin/attributes/bulk-delete": {
    POST: { permission: PERMISSIONS.ATTRIBUTES_DELETE },
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_DELETE },
  },
  "/api/admin/attributes/bulk-restore": {
    POST: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
  },
  "/api/admin/attributes/values/search": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    POST: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
  },
  "/api/admin/attributes/*": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    PUT: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    PATCH: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_DELETE },
  },
  "/api/admin/attributes/*/restore": {
    POST: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
  },
  "/api/admin/attributes/*/permanent": {
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_DELETE },
  },
  "/api/admin/attributes/*/usage": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
  },
  "/api/admin/attributes/*/values": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    POST: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    PUT: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
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
  "/api/settings/stripe": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/settings/sslcommerz": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/settings/header": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/settings/footer": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_FOOTER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_FOOTER_EDIT },
  },
  "/api/settings/seo": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_SEO_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_SEO_EDIT },
  },
  "/api/settings/firebase": {
    GET: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
  },
  "/api/settings/openrouter": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/settings/storefront-url": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/settings/hero-sliders": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/settings/hero-sliders/*": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/settings/delivery-locations": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
  },
  "/api/settings/delivery-locations/all": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW },
  },
  "/api/settings/delivery-locations/import-pathao": {
    POST: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
  },
  "/api/settings/delivery-locations/*": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
  },
  "/api/settings/delivery-providers": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT },
  },
  "/api/settings/delivery-providers/create-test": {
    POST: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT },
  },
  "/api/settings/delivery-providers/*": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT },
  },
  "/api/settings/fraud-checker": {
    GET: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT },
  },
  "/api/settings/fraud-checker/*": {
    GET: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT },
  },
  "/api/settings/fraud-checker/*/test": {
    POST: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW },
  },
  "/api/settings/cache/stats": {
    GET: { permission: PERMISSIONS.SETTINGS_CACHE_VIEW },
  },
  "/api/settings/cache/clear": {
    POST: { permission: PERMISSIONS.SETTINGS_CACHE_MANAGE },
    DELETE: { permission: PERMISSIONS.SETTINGS_CACHE_MANAGE },
  },
  "/api/settings/cache/clear-*": {
    POST: { permission: PERMISSIONS.SETTINGS_CACHE_MANAGE },
    DELETE: { permission: PERMISSIONS.SETTINGS_CACHE_MANAGE },
  },

  // Admin Settings
  "/api/admin/settings/shipping-methods": {
    GET: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
  },
  "/api/admin/settings/shipping-methods/*": {
    GET: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
  },
  "/api/admin/settings/shipping-methods/*/restore": {
    POST: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
  },
  "/api/admin/settings/shipping-methods/*/permanent-delete": {
    DELETE: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
  },
  "/api/admin/settings/checkout-languages": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/admin/settings/checkout-languages/*": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/admin/settings/checkout-languages/*/restore": {
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/admin/settings/meta-conversions": {
    GET: { permission: PERMISSIONS.ANALYTICS_VIEW },
    POST: { permission: PERMISSIONS.ANALYTICS_EDIT },
    PUT: { permission: PERMISSIONS.ANALYTICS_EDIT },
  },
  "/api/admin/settings/meta-conversions/logs": {
    GET: { permission: PERMISSIONS.ANALYTICS_VIEW },
  },

  // =============================================
  // Navigation API
  // =============================================
  "/api/navigation": {
    GET: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/navigation/*": {
    GET: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/admin/navigation/preview-products": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },

  // =============================================
  // Admin Abandoned Checkouts
  // =============================================
  "/api/admin/abandoned-checkouts": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },

  // =============================================
  // Search API
  // =============================================
  "/api/search": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/search/reindex": {
    POST: { permission: PERMISSIONS.PRODUCTS_BULK_OPERATIONS },
  },

  // =============================================
  // System Prompt API
  // =============================================
  "/api/system-prompt": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },

  // =============================================
  // Dashboard API
  // =============================================
  "/api/dashboard": {
    GET: { permission: PERMISSIONS.DASHBOARD_VIEW },
  },
  "/api/dashboard/*": {
    GET: { permission: PERMISSIONS.DASHBOARD_VIEW },
  },

  // =============================================
  // Team/Admin User Management API
  // =============================================
  "/api/auth/admin-users": {
    GET: { permission: PERMISSIONS.TEAM_VIEW },
    POST: { permission: PERMISSIONS.TEAM_MANAGE },
    DELETE: { permission: PERMISSIONS.TEAM_MANAGE },
  },

  // =============================================
  // RBAC API
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
  "/api/admin/rbac/my-permissions": {
    GET: { permission: PERMISSIONS.DASHBOARD_VIEW }, // Any authenticated user can view their own permissions
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
  // Inventory API
  // =============================================
  "/api/inventory/alerts": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/inventory/*/adjust": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },

  // =============================================
  // FCM Token API
  // =============================================
  "/api/admin/fcm-token": {
    POST: { permission: PERMISSIONS.DASHBOARD_VIEW }, // Any admin can register their token
  },
  "/api/admin/fcm-token-cleanup": {
    POST: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
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
  // Sort patterns by specificity (longer patterns first, patterns with more specific segments first)
  const sortedPatterns = Object.keys(ROUTE_PERMISSIONS).sort((a, b) => {
    // More specific patterns (with more path segments) should come first
    const aSegments = a.split("/").length;
    const bSegments = b.split("/").length;
    if (aSegments !== bSegments) return bSegments - aSegments;

    // Patterns without wildcards should come before patterns with wildcards
    const aWildcards = (a.match(/\*/g) || []).length;
    const bWildcards = (b.match(/\*/g) || []).length;
    return aWildcards - bWildcards;
  });

  for (const pattern of sortedPatterns) {
    if (matchPattern(pattern, pathname)) {
      const config = ROUTE_PERMISSIONS[pattern];
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
  // Escape special regex chars (including backslash) before converting globs
  const regexPattern = pattern
    .replace(/[\\^$.|?+()[\]{}]/g, "\\$&") // Escape regex special chars
    .replace(/\*/g, "[^/]+") // * matches anything except /
    .replace(/\//g, "\\/"); // Escape forward slashes

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(pathname);
}
