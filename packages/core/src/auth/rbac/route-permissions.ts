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
  // Any authenticated user with at least one admin permission is allowed.
  allowAnyAdmin?: boolean;
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
  "/api/v1/admin/products": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_CREATE },
  },
  "/api/v1/admin/products/bulk-delete": {
    POST: { permission: PERMISSIONS.PRODUCTS_BULK_OPERATIONS },
    DELETE: { permission: PERMISSIONS.PRODUCTS_BULK_OPERATIONS },
  },
  "/api/v1/admin/products/*": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
    DELETE: { permission: PERMISSIONS.PRODUCTS_DELETE },
  },
  "/api/v1/admin/products/*/restore": {
    POST: { permission: PERMISSIONS.PRODUCTS_RESTORE },
  },
  "/api/v1/admin/products/*/permanent": {
    DELETE: { permission: PERMISSIONS.PRODUCTS_PERMANENT_DELETE },
  },
  "/api/v1/admin/products/*/variants": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/products/*/variants/*": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
    DELETE: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/products/*/variants/bulk-create": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/products/*/variants/bulk-delete": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
    DELETE: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/products/*/variants/bulk-update": {
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/products/*/variants/sort-order": {
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/products/*/variants/*/duplicate": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
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
  "/api/v1/admin/categories": {
    GET: { permission: PERMISSIONS.CATEGORIES_VIEW },
    POST: { permission: PERMISSIONS.CATEGORIES_CREATE },
  },
  "/api/v1/admin/categories/bulk-delete": {
    POST: { permission: PERMISSIONS.CATEGORIES_DELETE },
    DELETE: { permission: PERMISSIONS.CATEGORIES_DELETE },
  },
  "/api/v1/admin/categories/bulk-restore": {
    POST: { permission: PERMISSIONS.CATEGORIES_RESTORE },
  },
  "/api/v1/admin/categories/*": {
    GET: { permission: PERMISSIONS.CATEGORIES_VIEW },
    PUT: { permission: PERMISSIONS.CATEGORIES_EDIT },
    PATCH: { permission: PERMISSIONS.CATEGORIES_EDIT },
    DELETE: { permission: PERMISSIONS.CATEGORIES_DELETE },
  },
  "/api/v1/admin/categories/*/restore": {
    POST: { permission: PERMISSIONS.CATEGORIES_RESTORE },
  },
  "/api/v1/admin/categories/*/permanent": {
    DELETE: { permission: PERMISSIONS.CATEGORIES_PERMANENT_DELETE },
  },

  // =============================================
  // Collections API
  // =============================================
  "/api/v1/admin/collections": {
    GET: { permission: PERMISSIONS.COLLECTIONS_VIEW },
    POST: { permission: PERMISSIONS.COLLECTIONS_CREATE },
  },
  "/api/v1/admin/collections/bulk-activate": {
    POST: { permission: PERMISSIONS.COLLECTIONS_TOGGLE_STATUS },
  },
  "/api/v1/admin/collections/bulk-deactivate": {
    POST: { permission: PERMISSIONS.COLLECTIONS_TOGGLE_STATUS },
  },
  "/api/v1/admin/collections/bulk-delete": {
    POST: { permission: PERMISSIONS.COLLECTIONS_DELETE },
    DELETE: { permission: PERMISSIONS.COLLECTIONS_DELETE },
  },
  "/api/v1/admin/collections/bulk-restore": {
    POST: { permission: PERMISSIONS.COLLECTIONS_RESTORE },
  },
  "/api/v1/admin/collections/reorder": {
    POST: { permission: PERMISSIONS.COLLECTIONS_EDIT },
  },
  "/api/v1/admin/collections/*": {
    GET: { permission: PERMISSIONS.COLLECTIONS_VIEW },
    PUT: { permission: PERMISSIONS.COLLECTIONS_EDIT },
    PATCH: { permission: PERMISSIONS.COLLECTIONS_EDIT },
    DELETE: { permission: PERMISSIONS.COLLECTIONS_DELETE },
  },
  "/api/v1/admin/collections/*/restore": {
    POST: { permission: PERMISSIONS.COLLECTIONS_RESTORE },
  },
  "/api/v1/admin/collections/*/permanent": {
    DELETE: { permission: PERMISSIONS.COLLECTIONS_DELETE },
  },

  // =============================================
  // Orders API
  // =============================================
  "/api/v1/admin/orders": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_CREATE },
  },
  "/api/v1/admin/orders/bulk-delete": {
    POST: { permission: PERMISSIONS.ORDERS_DELETE },
    DELETE: { permission: PERMISSIONS.ORDERS_DELETE },
  },
  "/api/v1/admin/orders/bulk-ship": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/payment-recovery": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/payment-recovery/export": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/payment-recovery-link": {
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    PUT: { permission: PERMISSIONS.ORDERS_EDIT },
    PATCH: { permission: PERMISSIONS.ORDERS_EDIT },
    DELETE: { permission: PERMISSIONS.ORDERS_DELETE },
  },
  "/api/v1/admin/orders/*/permanent": {
    DELETE: { permission: PERMISSIONS.ORDERS_DELETE },
  },
  "/api/v1/admin/orders/*/status": {
    PUT: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
    PATCH: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
    POST: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
  },
  "/api/v1/admin/orders/*/restore": {
    POST: { permission: PERMISSIONS.ORDERS_RESTORE },
  },
  "/api/v1/admin/orders/*/shipments": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/shipments/*": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    PUT: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
    DELETE: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/shipments/*/status": {
    PUT: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
    PATCH: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/shipments/*/refresh": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/shipments/*/reconcile": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/fulfill": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/items": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/form-data": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/payments": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/notifications": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/notifications/*/retry": {
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*/notifications/*/resend": {
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*/support-requests/*/status": {
    PUT: { permission: PERMISSIONS.ORDERS_EDIT },
    PATCH: { permission: PERMISSIONS.ORDERS_EDIT },
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*/invoice": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/cod": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*/return": {
    POST: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
  },
  "/api/v1/admin/orders/*/refund": {
    POST: { permission: PERMISSIONS.ORDERS_REFUND },
  },
  "/api/v1/admin/orders/*/refund-attempts/*/reconcile": {
    POST: { permission: PERMISSIONS.ORDERS_REFUND },
  },
  "/api/v1/admin/orders/*/fulfillment-status": {
    PUT: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
    PATCH: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },

  // =============================================
  // Shipments API
  // =============================================
  "/api/v1/admin/shipments/*": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    PUT: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
    DELETE: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/shipments/*/check-status": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },

  // =============================================
  // Customers API
  // =============================================
  "/api/v1/admin/customers": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
    POST: { permission: PERMISSIONS.CUSTOMERS_CREATE },
  },
  "/api/v1/admin/customers/bulk-delete": {
    POST: { permission: PERMISSIONS.CUSTOMERS_DELETE },
    DELETE: { permission: PERMISSIONS.CUSTOMERS_DELETE },
  },
  "/api/v1/admin/customers/sync": {
    POST: { permission: PERMISSIONS.CUSTOMERS_SYNC },
  },
  "/api/v1/admin/customers/mcp-search": {
    POST: { permission: PERMISSIONS.CUSTOMERS_VIEW },
  },
  "/api/v1/admin/customers/*": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
    PUT: { permission: PERMISSIONS.CUSTOMERS_EDIT },
    PATCH: { permission: PERMISSIONS.CUSTOMERS_EDIT },
    DELETE: { permission: PERMISSIONS.CUSTOMERS_DELETE },
  },
  "/api/v1/admin/customers/*/history": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
  },
  "/api/v1/admin/customers/*/restore": {
    POST: { permission: PERMISSIONS.CUSTOMERS_EDIT },
  },
  "/api/v1/admin/customers/*/permanent": {
    DELETE: { permission: PERMISSIONS.CUSTOMERS_DELETE },
  },

  // =============================================
  // Discounts API (SENSITIVE)
  // =============================================
  "/api/v1/admin/discounts": {
    GET: { permission: PERMISSIONS.DISCOUNTS_VIEW },
    POST: { permission: PERMISSIONS.DISCOUNTS_CREATE },
  },
  "/api/v1/admin/discounts/bulk-delete": {
    POST: { permission: PERMISSIONS.DISCOUNTS_DELETE },
    DELETE: { permission: PERMISSIONS.DISCOUNTS_DELETE },
  },
  "/api/v1/admin/discounts/bulk-restore": {
    POST: { permission: PERMISSIONS.DISCOUNTS_EDIT },
  },
  "/api/v1/admin/discounts/*": {
    GET: { permission: PERMISSIONS.DISCOUNTS_VIEW },
    PUT: { permission: PERMISSIONS.DISCOUNTS_EDIT },
    PATCH: { permission: PERMISSIONS.DISCOUNTS_EDIT },
    DELETE: { permission: PERMISSIONS.DISCOUNTS_DELETE },
  },
  "/api/v1/admin/discounts/*/toggle": {
    POST: { permission: PERMISSIONS.DISCOUNTS_TOGGLE_STATUS },
  },
  "/api/v1/admin/discounts/*/toggle-status": {
    POST: { permission: PERMISSIONS.DISCOUNTS_TOGGLE_STATUS },
  },
  "/api/v1/admin/discounts/*/restore": {
    POST: { permission: PERMISSIONS.DISCOUNTS_EDIT },
  },
  "/api/v1/admin/discounts/*/permanent": {
    DELETE: { permission: PERMISSIONS.DISCOUNTS_DELETE },
  },

  // =============================================
  // Pages API
  // =============================================
  "/api/v1/admin/pages": {
    GET: { permission: PERMISSIONS.PAGES_VIEW },
    POST: { permission: PERMISSIONS.PAGES_CREATE },
  },
  "/api/v1/admin/pages/bulk-delete": {
    POST: { permission: PERMISSIONS.PAGES_DELETE },
    DELETE: { permission: PERMISSIONS.PAGES_DELETE },
  },
  "/api/v1/admin/pages/bulk-restore": {
    POST: { permission: PERMISSIONS.PAGES_EDIT },
  },
  "/api/v1/admin/pages/bulk-publish": {
    POST: { permission: PERMISSIONS.PAGES_PUBLISH },
  },
  "/api/v1/admin/pages/bulk-unpublish": {
    POST: { permission: PERMISSIONS.PAGES_PUBLISH },
  },
  "/api/v1/admin/pages/*": {
    GET: { permission: PERMISSIONS.PAGES_VIEW },
    PUT: { permission: PERMISSIONS.PAGES_EDIT },
    PATCH: { permission: PERMISSIONS.PAGES_EDIT },
    DELETE: { permission: PERMISSIONS.PAGES_DELETE },
  },
  "/api/v1/admin/pages/*/restore": {
    POST: { permission: PERMISSIONS.PAGES_EDIT },
  },
  "/api/v1/admin/pages/*/permanent": {
    DELETE: { permission: PERMISSIONS.PAGES_DELETE },
  },

  // =============================================
  // Widgets API
  // =============================================
  "/api/v1/admin/widgets": {
    GET: { permission: PERMISSIONS.WIDGETS_VIEW },
    POST: { permission: PERMISSIONS.WIDGETS_CREATE },
  },
  "/api/v1/admin/widgets/bulk-delete": {
    POST: { permission: PERMISSIONS.WIDGETS_DELETE },
    DELETE: { permission: PERMISSIONS.WIDGETS_DELETE },
  },
  "/api/v1/admin/widgets/bulk-restore": {
    POST: { permission: PERMISSIONS.WIDGETS_EDIT },
  },
  "/api/v1/admin/widgets/bulk-activate": {
    POST: { permission: PERMISSIONS.WIDGETS_TOGGLE_STATUS },
  },
  "/api/v1/admin/widgets/bulk-deactivate": {
    POST: { permission: PERMISSIONS.WIDGETS_TOGGLE_STATUS },
  },
  "/api/v1/admin/widgets/*": {
    GET: { permission: PERMISSIONS.WIDGETS_VIEW },
    PUT: { permission: PERMISSIONS.WIDGETS_EDIT },
    PATCH: { permission: PERMISSIONS.WIDGETS_EDIT },
    DELETE: { permission: PERMISSIONS.WIDGETS_DELETE },
  },
  "/api/v1/admin/widgets/*/restore": {
    POST: { permission: PERMISSIONS.WIDGETS_EDIT },
  },
  "/api/v1/admin/widgets/*/permanent": {
    DELETE: { permission: PERMISSIONS.WIDGETS_DELETE },
  },
  "/api/v1/admin/widgets/*/toggle-status": {
    PATCH: { permission: PERMISSIONS.WIDGETS_TOGGLE_STATUS },
    POST: { permission: PERMISSIONS.WIDGETS_TOGGLE_STATUS },
    PUT: { permission: PERMISSIONS.WIDGETS_TOGGLE_STATUS },
  },
  "/api/v1/admin/widgets/*/history": {
    GET: { permission: PERMISSIONS.WIDGETS_VIEW },
    POST: { permission: PERMISSIONS.WIDGETS_EDIT },
  },
  "/api/v1/admin/widgets/*/history/*": {
    GET: { permission: PERMISSIONS.WIDGETS_VIEW },
    DELETE: { permission: PERMISSIONS.WIDGETS_EDIT },
  },
  "/api/v1/admin/widgets/*/history/restore": {
    POST: { permission: PERMISSIONS.WIDGETS_EDIT },
  },

  // =============================================
  // Media API
  // =============================================
  "/api/v1/admin/media": {
    GET: { permission: PERMISSIONS.MEDIA_VIEW },
    POST: { permission: PERMISSIONS.MEDIA_UPLOAD },
  },
  "/api/v1/admin/media/upload": {
    POST: { permission: PERMISSIONS.MEDIA_UPLOAD },
  },
  "/api/v1/admin/media/move": {
    POST: { permission: PERMISSIONS.MEDIA_MANAGE_FOLDERS },
  },
  "/api/v1/admin/media/*": {
    GET: { permission: PERMISSIONS.MEDIA_VIEW },
    PUT: { permission: PERMISSIONS.MEDIA_UPLOAD },
    PATCH: { permission: PERMISSIONS.MEDIA_UPLOAD },
    DELETE: { permission: PERMISSIONS.MEDIA_DELETE },
  },
  "/api/v1/admin/media/folders": {
    GET: { permission: PERMISSIONS.MEDIA_VIEW },
    POST: { permission: PERMISSIONS.MEDIA_MANAGE_FOLDERS },
  },
  "/api/v1/admin/media/folders/*": {
    PUT: { permission: PERMISSIONS.MEDIA_MANAGE_FOLDERS },
    DELETE: { permission: PERMISSIONS.MEDIA_MANAGE_FOLDERS },
  },

  // =============================================
  // Attributes API (under /api/v1/admin/)
  // =============================================
  "/api/v1/admin/attributes": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    POST: { permission: PERMISSIONS.ATTRIBUTES_CREATE },
  },
  "/api/v1/admin/attributes/bulk-delete": {
    POST: { permission: PERMISSIONS.ATTRIBUTES_DELETE },
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_DELETE },
  },
  "/api/v1/admin/attributes/bulk-restore": {
    POST: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
  },
  "/api/v1/admin/attributes/values/search": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    POST: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
  },
  "/api/v1/admin/attributes/*": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    PUT: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    PATCH: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_DELETE },
  },
  "/api/v1/admin/attributes/*/restore": {
    POST: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
  },
  "/api/v1/admin/attributes/*/permanent": {
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_DELETE },
  },
  "/api/v1/admin/attributes/*/usage": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
  },
  "/api/v1/admin/attributes/*/values": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    POST: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    PUT: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
  },

  // =============================================
  // Analytics API
  // =============================================
  "/api/v1/admin/analytics": {
    GET: { permission: PERMISSIONS.ANALYTICS_VIEW },
    POST: { permission: PERMISSIONS.ANALYTICS_CREATE },
  },
  "/api/v1/admin/analytics/*": {
    GET: { permission: PERMISSIONS.ANALYTICS_VIEW },
    PUT: { permission: PERMISSIONS.ANALYTICS_EDIT },
    PATCH: { permission: PERMISSIONS.ANALYTICS_EDIT },
    DELETE: { permission: PERMISSIONS.ANALYTICS_EDIT },
  },
  "/api/v1/admin/analytics/*/toggle": {
    POST: { permission: PERMISSIONS.ANALYTICS_TOGGLE },
  },

  // =============================================
  // Settings API (SENSITIVE)
  // =============================================
  "/api/v1/cache/stats": {
    GET: { permission: PERMISSIONS.SETTINGS_CACHE_VIEW },
  },
  "/api/v1/cache/groups": {
    GET: { permission: PERMISSIONS.SETTINGS_CACHE_VIEW },
  },
  "/api/v1/cache/last-cleared": {
    GET: { permission: PERMISSIONS.SETTINGS_CACHE_VIEW },
  },
  "/api/v1/cache/storefront-dlq": {
    GET: { permission: PERMISSIONS.SETTINGS_CACHE_VIEW },
  },
  "/api/v1/cache/storefront-dlq/*/replay": {
    POST: { permission: PERMISSIONS.SETTINGS_CACHE_MANAGE },
  },
  "/api/v1/cache/storefront-dlq/*/ignore": {
    POST: { permission: PERMISSIONS.SETTINGS_CACHE_MANAGE },
  },
  "/api/v1/cache/clear": {
    POST: { permission: PERMISSIONS.SETTINGS_CACHE_MANAGE },
    DELETE: { permission: PERMISSIONS.SETTINGS_CACHE_MANAGE },
  },
  "/api/v1/cache/clear-group": {
    POST: { permission: PERMISSIONS.SETTINGS_CACHE_MANAGE },
  },
  "/api/v1/admin/settings/currency": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/taxes": {
    GET: { permission: PERMISSIONS.TAXES_VIEW },
  },
  "/api/v1/admin/taxes/settings": {
    PUT: { permission: PERMISSIONS.TAXES_MANAGE },
  },
  "/api/v1/admin/taxes/classes": {
    POST: { permission: PERMISSIONS.TAXES_MANAGE },
  },
  "/api/v1/admin/taxes/classes/*": {
    PUT: { permission: PERMISSIONS.TAXES_MANAGE },
    DELETE: { permission: PERMISSIONS.TAXES_MANAGE },
  },
  "/api/v1/admin/taxes/rates": {
    POST: { permission: PERMISSIONS.TAXES_MANAGE },
  },
  "/api/v1/admin/taxes/rates/*": {
    PUT: { permission: PERMISSIONS.TAXES_MANAGE },
    DELETE: { permission: PERMISSIONS.TAXES_MANAGE },
  },
  "/api/v1/admin/taxes/classifications": {
    GET: { permission: PERMISSIONS.TAXES_VIEW },
  },
  "/api/v1/admin/taxes/classifications/*/*": {
    PUT: { permission: PERMISSIONS.TAXES_MANAGE },
  },
  "/api/v1/admin/taxes/preview": {
    POST: { permission: PERMISSIONS.TAXES_VIEW },
  },
  "/api/v1/admin/settings/general": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  },
  "/api/v1/admin/settings/theme": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/media": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/allowed-countries": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/business": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/payment-methods": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/checkout-readiness": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  },
  "/api/v1/admin/settings/mcp-summary": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  },
  "/api/v1/admin/settings/stripe": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/sslcommerz": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/polar": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/auth": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/security": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/email": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/sms": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
  },
  "/api/v1/admin/settings/header": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/v1/admin/settings/footer": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_FOOTER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_FOOTER_EDIT },
  },
  "/api/v1/admin/settings/seo": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_SEO_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_SEO_EDIT },
  },
  "/api/v1/admin/settings/seo/feed-diagnostics": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  },
  "/api/v1/admin/settings/firebase": {
    GET: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
  },
  "/api/v1/admin/settings/storefront-url": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/hero-sliders": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/v1/admin/settings/hero-sliders/*": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/v1/admin/settings/delivery-locations": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
  },
  "/api/v1/admin/settings/delivery-locations/all": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW },
    DELETE: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
  },
  "/api/v1/admin/settings/delivery-locations/import-pathao": {
    POST: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
  },
  "/api/v1/admin/settings/delivery-locations/import-pathao/status": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
  },
  "/api/v1/admin/settings/delivery-locations/*": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT },
  },
  "/api/v1/admin/settings/delivery-providers": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT },
  },
  "/api/v1/admin/settings/delivery-providers/create-test": {
    POST: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT },
  },
  "/api/v1/admin/settings/delivery-providers/*": {
    GET: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT },
  },
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
  "/api/v1/admin/fraud-checker": {
    GET: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT },
  },
  "/api/v1/admin/fraud-checker/lookup": {
    POST: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW },
  },
  "/api/v1/admin/fraud-checker/*": {
    GET: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT },
  },
  "/api/v1/admin/fraud-checker/*/test": {
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
  "/api/v1/admin/settings/widget-ai": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/shipping-methods": {
    GET: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
  },
  "/api/v1/admin/settings/shipping-methods/*": {
    GET: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
  },
  "/api/v1/admin/settings/shipping-methods/*/restore": {
    POST: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
  },
  "/api/v1/admin/settings/shipping-methods/*/permanent-delete": {
    DELETE: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
  },
  "/api/v1/admin/settings/checkout-languages": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/checkout-languages/*": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    PATCH: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/checkout-languages/*/restore": {
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/meta-conversions": {
    GET: { permission: PERMISSIONS.ANALYTICS_VIEW },
    POST: { permission: PERMISSIONS.ANALYTICS_EDIT },
    PUT: { permission: PERMISSIONS.ANALYTICS_EDIT },
  },
  "/api/v1/admin/settings/meta-conversions/logs": {
    GET: { permission: PERMISSIONS.ANALYTICS_VIEW },
    POST: { permission: PERMISSIONS.ANALYTICS_EDIT },
    DELETE: { permission: PERMISSIONS.ANALYTICS_EDIT },
  },
  "/api/v1/admin/settings/notification-channels": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
  },
  "/api/v1/admin/settings/notification-channels/admin-channels": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
  },
  "/api/v1/admin/settings/notification-channels/mcp-summary": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  },
  "/api/v1/admin/settings/notification-channels/*": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
  },
  "/api/v1/admin/settings": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    PATCH: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },

  // =============================================
  // Navigation API
  // =============================================
  "/api/v1/admin/navigation": {
    GET: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/v1/admin/navigation/*": {
    GET: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/v1/admin/navigation/preview-products": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },

  // =============================================
  // Admin Abandoned Checkouts
  // =============================================
  "/api/v1/admin/abandoned-checkouts": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_DELETE },
    DELETE: { permission: PERMISSIONS.ORDERS_DELETE },
  },
  "/api/v1/admin/abandoned-checkouts/bulk-delete": {
    POST: { permission: PERMISSIONS.ORDERS_DELETE },
  },
  "/api/v1/admin/abandoned-checkouts/*": {
    DELETE: { permission: PERMISSIONS.ORDERS_DELETE },
  },
  "/api/v1/admin/settings/abandoned-checkouts": {
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/settings/abandoned-checkouts/cleanup": {
    POST: { permission: PERMISSIONS.ORDERS_DELETE },
  },

  // =============================================
  // Search API
  // =============================================
  "/api/v1/admin/search": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/search/reindex": {
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
  "/api/v1/admin/dashboard": {
    GET: { permission: PERMISSIONS.DASHBOARD_VIEW },
  },
  "/api/v1/admin/dashboard/*": {
    GET: { permission: PERMISSIONS.DASHBOARD_VIEW },
  },
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
  "/api/v1/admin/rbac/roles": {
    GET: { anyOf: [PERMISSIONS.TEAM_VIEW, PERMISSIONS.TEAM_MANAGE_ROLES] },
    POST: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
  },
  "/api/v1/admin/rbac/roles/*": {
    GET: { anyOf: [PERMISSIONS.TEAM_VIEW, PERMISSIONS.TEAM_MANAGE_ROLES] },
    PUT: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
    DELETE: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
  },
  "/api/v1/admin/rbac/permissions": {
    GET: { anyOf: [PERMISSIONS.TEAM_VIEW, PERMISSIONS.TEAM_MANAGE_ROLES] },
  },
  "/api/v1/admin/rbac/my-permissions": {
    GET: { allowAnyAdmin: true },
  },
  "/api/v1/admin/rbac/user-roles": {
    POST: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
    DELETE: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
  },
  "/api/v1/admin/rbac/user-permissions": {
    POST: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
    DELETE: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
  },

  // Internal Admin assistant authority facade. These routes require any fully
  // onboarded, 2FA-verified Admin session here, then enforce each capability's
  // exact current permission again inside the authority facade.
  "/api/v1/internal/admin-assistant/session/*": {
    POST: { allowAnyAdmin: true },
  },
  "/api/v1/internal/admin-assistant/workflows/create": {
    POST: { allowAnyAdmin: true },
  },
  "/api/v1/internal/admin-assistant/events/list": {
    POST: { allowAnyAdmin: true },
  },
  "/api/v1/internal/admin-assistant/capabilities/*": {
    POST: { allowAnyAdmin: true },
  },

  // =============================================
  // Inventory API
  // =============================================
  "/api/v1/admin/inventory": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/alerts": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/scanner/lookup": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/stock-adjust": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/stock-set": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/*/adjust": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
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
  "/api/v1/admin/fcm-token": {
    POST: { allowAnyAdmin: true },
  },
  "/api/v1/admin/fcm-token-cleanup": {
    POST: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
  },

  // =============================================
  // Auth Management API (admin user CRUD, 2FA, profile)
  // =============================================
  "/api/v1/admin/auth/users": {
    GET: {
      anyOf: [
        PERMISSIONS.TEAM_VIEW,
        PERMISSIONS.TEAM_MANAGE,
        PERMISSIONS.TEAM_MANAGE_ROLES,
      ],
    },
    POST: { permission: PERMISSIONS.TEAM_MANAGE },
  },
  "/api/v1/admin/auth/users/*": {
    DELETE: { permission: PERMISSIONS.TEAM_MANAGE },
  },
  "/api/v1/admin/auth/change-password": {
    POST: { allowAnyAdmin: true },
  },
  "/api/v1/admin/auth/update-profile": {
    POST: { allowAnyAdmin: true },
  },
  "/api/v1/admin/auth/2fa/*": {
    GET: { allowAnyAdmin: true },
    POST: { allowAnyAdmin: true },
  },
  "/api/v1/admin/auth/account-security": {
    GET: { allowAnyAdmin: true },
  },

  // =============================================
  // AI Context & Prompts API
  // =============================================
  "/api/v1/admin/ai-context": {
    GET: { permission: PERMISSIONS.WIDGETS_VIEW },
    POST: { permission: PERMISSIONS.WIDGETS_EDIT },
  },
  "/api/v1/admin/ai-context/*": {
    GET: { permission: PERMISSIONS.WIDGETS_VIEW },
    POST: { permission: PERMISSIONS.WIDGETS_EDIT },
  },
  "/api/v1/admin/ai-prompts": {
    GET: { permission: PERMISSIONS.WIDGETS_EDIT },
    POST: { permission: PERMISSIONS.WIDGETS_EDIT },
  },
  "/api/v1/admin/ai-prompts/*": {
    GET: { permission: PERMISSIONS.WIDGETS_EDIT },
  },

  // =============================================
  // Widget AI Generation API
  // =============================================
  "/api/v1/admin/ai/chat": {
    POST: { permission: PERMISSIONS.DASHBOARD_VIEW },
  },
  "/api/v1/admin/ai": {
    POST: { permission: PERMISSIONS.WIDGETS_EDIT },
  },
  "/api/v1/admin/ai/*": {
    GET: { permission: PERMISSIONS.WIDGETS_EDIT },
    POST: { permission: PERMISSIONS.WIDGETS_EDIT },
  },
  "/api/v1/admin/widget-generation-runs": {
    POST: { permission: PERMISSIONS.WIDGETS_EDIT },
  },
  "/api/v1/admin/widget-generation-runs/*": {
    POST: { permission: PERMISSIONS.WIDGETS_EDIT },
  },
  "/api/v1/admin/widget-generation-runs/sessions/*/status": {
    GET: { permission: PERMISSIONS.WIDGETS_EDIT },
  },

};

/**
 * Get the permission configuration for a route and method
 */
export function getRoutePermission(
  pathname: string,
  method: HttpMethod
): RoutePermission | null {
  const normalizedPathname = normalizePathname(pathname);

  // Try exact match first
  const exactMatch = ROUTE_PERMISSIONS[normalizedPathname];
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
    if (matchPattern(pattern, normalizedPathname)) {
      const config = ROUTE_PERMISSIONS[pattern];
      if (config && config[method]) {
        return config[method] ?? null;
      }
    }
  }

  return null;
}

function normalizePathname(pathname: string): string {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
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
