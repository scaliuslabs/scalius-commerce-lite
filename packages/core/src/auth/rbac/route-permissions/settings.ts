// Route permissions for the settings, tax, fraud-checker and cache API.
import { PERMISSIONS } from "../permissions";
import { ANY_STAFF, type RoutePermissionMap } from "./shared";

export const SETTINGS_ROUTE_PERMISSIONS: RoutePermissionMap = {
  // =============================================
  // Settings API (SENSITIVE)
  // =============================================
  "/api/v1/cache/clear": {
    POST: { permission: PERMISSIONS.SETTINGS_CACHE_MANAGE },
  },
  // Store-wide display facts (money format, store address, search listing
  // defaults) are already public on the storefront; every staff screen needs them.
  "/api/v1/admin/settings/currency": {
    GET: { anyOf: ANY_STAFF },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/taxes": {
    GET: { permission: PERMISSIONS.TAXES_VIEW },
  },
  "/api/v1/admin/taxes/settings": {
    GET: { permission: PERMISSIONS.TAXES_VIEW },
    PUT: { permission: PERMISSIONS.TAXES_MANAGE },
  },
  "/api/v1/admin/taxes/classes": {
    GET: { permission: PERMISSIONS.TAXES_VIEW },
    POST: { permission: PERMISSIONS.TAXES_MANAGE },
  },
  "/api/v1/admin/taxes/classes/*": {
    PUT: { permission: PERMISSIONS.TAXES_MANAGE },
    DELETE: { permission: PERMISSIONS.TAXES_MANAGE },
  },
  "/api/v1/admin/taxes/rates": {
    GET: { permission: PERMISSIONS.TAXES_VIEW },
    POST: { permission: PERMISSIONS.TAXES_MANAGE },
  },
  "/api/v1/admin/taxes/rates/*": {
    PUT: { permission: PERMISSIONS.TAXES_MANAGE },
    DELETE: { permission: PERMISSIONS.TAXES_MANAGE },
  },
  "/api/v1/admin/taxes/classifications": {
    GET: { permission: PERMISSIONS.TAXES_VIEW },
  },
  "/api/v1/admin/taxes/jurisdictions": {
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
  "/api/v1/admin/settings/theme/workspace": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  },
  "/api/v1/admin/settings/theme/draft": {
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/theme/draft/rebase": {
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/theme/publish": {
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/theme/versions": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  },
  "/api/v1/admin/settings/theme/rollback": {
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/theme/preview-session": {
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
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
    GET: { anyOf: [PERMISSIONS.SETTINGS_GENERAL_VIEW, PERMISSIONS.ORDERS_ISSUE_INVOICE] },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/payment-methods": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/checkout-readiness": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  },
  "/api/v1/admin/settings/checkout-flow": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/customer-requests": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/policies": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_SEO_EDIT },
  },
  "/api/v1/admin/settings/stripe": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/sslcommerz": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/auth": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/security": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/security/runtime-sources": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  },
  "/api/v1/admin/settings/platform": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
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
    GET: { anyOf: ANY_STAFF },
    PUT: { permission: PERMISSIONS.SETTINGS_SEO_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_SEO_EDIT },
  },
  "/api/v1/admin/settings/seo/feed-diagnostics": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  },
  "/api/v1/admin/settings/seo/feed-row-preview/*": {
    GET: {
      allOf: [
        PERMISSIONS.SETTINGS_GENERAL_VIEW,
        PERMISSIONS.PRODUCTS_VIEW,
      ],
    },
  },
  "/api/v1/admin/settings/seo/live-probe": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
  },
  "/api/v1/admin/settings/firebase": {
    GET: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
  },
  "/api/v1/admin/settings/storefront-url": {
    GET: { anyOf: ANY_STAFF },
    PUT: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/settings/homepage-presentation": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
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
    GET: {
      anyOf: [
        PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW,
        PERMISSIONS.ORDERS_MANAGE_SHIPMENTS,
      ],
    },
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
  // Admin Settings
  "/api/v1/admin/settings/shipping-methods": {
    GET: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
  },
  "/api/v1/admin/settings/shipping-methods/*": {
    PUT: { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
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
    PUT: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
  },
  "/api/v1/admin/settings/notification-channels/templates/test": {
    POST: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
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
  "/api/v1/admin/settings/abandoned-checkouts": {
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/settings/abandoned-checkouts/cleanup": {
    POST: { permission: PERMISSIONS.ORDERS_DELETE },
  },
};
