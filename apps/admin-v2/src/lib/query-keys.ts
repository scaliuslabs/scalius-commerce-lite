/**
 * Centralized query key factory for all TanStack Query keys.
 *
 * Every query key used in api.queries.ts and api.mutations.ts is defined here.
 * This ensures consistency between query definitions and cache invalidation.
 *
 * Convention:
 *   queryKeys.domain.all       — base key for the domain (used for broad invalidation)
 *   queryKeys.domain.list(p)   — paginated list
 *   queryKeys.domain.detail(id)— single entity
 *   queryKeys.domain.xxx()     — domain-specific sub-resources
 */

export const queryKeys = {
  // ── Dashboard ────────────────────────────────────────────────────
  dashboard: {
    all: ["dashboard"] as const,
  },

  // ── Products ─────────────────────────────────────────────────────
  products: {
    all: ["products"] as const,
    list: (params?: Record<string, unknown>) => ["products", "list", params] as const,
    detail: (id: string) => ["products", "detail", id] as const,
    stats: () => ["products", "stats"] as const,
    variants: (productId: string) => ["products", "variants", productId] as const,
    variantSortOrder: (productId: string) => ["products", "variant-sort-order", productId] as const,
  },

  // ── Categories ───────────────────────────────────────────────────
  categories: {
    all: ["categories"] as const,
    list: (params?: Record<string, unknown>) => ["categories", "list", params] as const,
    detail: (id: string) => ["categories", "detail", id] as const,
    formOptions: () => ["categories", "form-options"] as const,
  },

  // ── Collections ──────────────────────────────────────────────────
  collections: {
    all: ["collections"] as const,
    list: (params?: Record<string, unknown>) => ["collections", "list", params] as const,
    detail: (id: string) => ["collections", "detail", id] as const,
    formOptions: () => ["collections", "form-options"] as const,
  },

  // ── Orders ───────────────────────────────────────────────────────
  orders: {
    all: ["orders"] as const,
    list: (params?: Record<string, unknown>) => ["orders", "list", params] as const,
    detail: (id: string) => ["orders", "detail", id] as const,
    formData: (id: string) => ["orders", "form-data", id] as const,
    items: (orderId: string) => ["orders", "items", orderId] as const,
    payments: (orderId: string) => ["orders", "payments", orderId] as const,
    cod: (orderId: string) => ["orders", "cod", orderId] as const,
    shipments: (orderId: string) => ["orders", "shipments", orderId] as const,
  },

  // ── Customers ────────────────────────────────────────────────────
  customers: {
    all: ["customers"] as const,
    list: (params?: Record<string, unknown>) => ["customers", "list", params] as const,
    detail: (id: string) => ["customers", "detail", id] as const,
    history: (id: string) => ["customers", "history", id] as const,
  },

  // ── Discounts ────────────────────────────────────────────────────
  discounts: {
    all: ["discounts"] as const,
    list: (params?: Record<string, unknown>) => ["discounts", "list", params] as const,
    detail: (id: string) => ["discounts", "detail", id] as const,
  },

  // ── Pages ────────────────────────────────────────────────────────
  pages: {
    all: ["pages"] as const,
    list: (params?: Record<string, unknown>) => ["pages", "list", params] as const,
    detail: (id: string) => ["pages", "detail", id] as const,
  },

  // ── Widgets ──────────────────────────────────────────────────────
  widgets: {
    all: ["widgets"] as const,
    list: (params?: Record<string, unknown>) => ["widgets", "list", params] as const,
    detail: (id: string) => ["widgets", "detail", id] as const,
    history: (widgetId: string) => ["widgets", "history", widgetId] as const,
  },

  // ── Attributes ───────────────────────────────────────────────────
  attributes: {
    all: ["attributes"] as const,
    list: (params?: Record<string, unknown>) => ["attributes", "list", params] as const,
    detail: (id: string) => ["attributes", "detail", id] as const,
    values: (params?: Record<string, unknown>) => ["attributes", "values", params] as const,
  },

  // ── Analytics ────────────────────────────────────────────────────
  analytics: {
    all: ["analytics"] as const,
    list: () => ["analytics", "list"] as const,
    detail: (id: string) => ["analytics", "detail", id] as const,
  },

  // ── Inventory ────────────────────────────────────────────────────
  inventory: {
    all: ["inventory"] as const,
    list: (params?: Record<string, unknown>) => ["inventory", "list", params] as const,
  },

  // ── Media ────────────────────────────────────────────────────────
  media: {
    all: ["media"] as const,
    list: (params?: Record<string, unknown>) => ["media", "list", params] as const,
    folders: () => ["media", "folders"] as const,
  },

  // ── Navigation ───────────────────────────────────────────────────
  navigation: {
    all: ["navigation"] as const,
    items: () => ["navigation", "items"] as const,
    previewProducts: (params: Record<string, string>) => ["navigation", "preview-products", params] as const,
  },

  // ── Fraud Checker ────────────────────────────────────────────────
  fraudChecker: {
    all: ["fraud-checker"] as const,
    list: () => ["fraud-checker", "list"] as const,
  },

  // ── Abandoned Checkouts ──────────────────────────────────────────
  abandonedCheckouts: {
    all: ["abandoned-checkouts"] as const,
    list: (params?: Record<string, unknown>) => ["abandoned-checkouts", "list", params] as const,
  },

  // ── RBAC ─────────────────────────────────────────────────────────
  rbac: {
    all: ["rbac"] as const,
    roles: () => ["rbac", "roles"] as const,
    permissions: () => ["rbac", "permissions"] as const,
  },

  // ── Auth / Admin Users ───────────────────────────────────────────
  adminUsers: {
    all: ["admin-users"] as const,
    list: () => ["admin-users", "list"] as const,
  },

  auth: {
    all: ["auth"] as const,
    accountSecurity: () => ["auth", "account-security"] as const,
    twoFaInfo: () => ["auth", "2fa-info"] as const,
  },

  // ── Settings ─────────────────────────────────────────────────────
  settings: {
    all: ["settings"] as const,
    byCategory: (category: string) => ["settings", category] as const,
    general: () => ["settings", "general"] as const,
    storefrontUrl: () => ["settings", "storefront-url"] as const,
    currency: () => ["settings", "currency"] as const,
    seo: () => ["settings", "seo"] as const,
    security: () => ["settings", "security"] as const,
    auth: () => ["settings", "auth"] as const,
    email: () => ["settings", "email"] as const,
    firebase: () => ["settings", "firebase"] as const,
    business: () => ["settings", "business"] as const,
    theme: () => ["settings", "theme"] as const,
    sms: () => ["settings", "sms"] as const,
    openRouter: () => ["settings", "openrouter"] as const,
    metaConversions: () => ["settings", "meta-conversions"] as const,
    metaConversionsLogs: (params?: Record<string, unknown>) => ["settings", "meta-conversions-logs", params] as const,
    allowedCountries: () => ["settings", "allowed-countries"] as const,
    paymentMethods: () => ["settings", "payment-methods"] as const,
    paymentGateway: (gateway: string) => ["settings", "payment-gateway", gateway] as const,
    notificationChannels: () => ["settings", "notification-channels"] as const,
    adminNotificationChannels: () => ["settings", "admin-notification-channels"] as const,
    deliveryProviders: () => ["settings", "delivery-providers"] as const,
    deliveryLocations: (params?: Record<string, unknown>) => ["settings", "delivery-locations", params] as const,
    deliveryLocationsAll: (params?: Record<string, unknown>) => ["settings", "delivery-locations-all", params] as const,
    importPathaoStatus: () => ["settings", "import-pathao-status"] as const,
    checkoutLanguages: (params?: Record<string, unknown>) => ["settings", "checkout-languages", params] as const,
    shippingMethods: (params?: Record<string, unknown>) => ["settings", "shipping-methods", params] as const,
    heroSliders: () => ["settings", "hero-sliders"] as const,
  },

  // ── AI ───────────────────────────────────────────────────────────
  ai: {
    all: ["ai"] as const,
    prompts: (type: string) => ["ai", "prompts", type] as const,
  },

  // ── Cache ────────────────────────────────────────────────────────
  cache: {
    all: ["cache"] as const,
    stats: () => ["cache", "stats"] as const,
    lastCleared: () => ["cache", "last-cleared"] as const,
    groups: () => ["cache", "groups"] as const,
  },

  // ── Setup ────────────────────────────────────────────────────────
  setup: {
    all: ["setup"] as const,
    status: () => ["setup", "status"] as const,
  },

  // ── Firebase Config ──────────────────────────────────────────────
  firebase: {
    all: ["firebase"] as const,
    config: () => ["firebase", "config"] as const,
  },
} as const;
