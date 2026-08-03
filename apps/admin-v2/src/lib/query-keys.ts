/**
 * Centralized query key factory for all TanStack Query keys.
 *
 * Every query key used in api-query-options and api-mutations is defined here.
 * This ensures consistency between query definitions and cache invalidation.
 *
 * Convention:
 *   queryKeys.domain.all       — base key for the domain (used for broad invalidation)
 *   queryKeys.domain.list(p)   — paginated list (with params → exact key; without → prefix for invalidation)
 *   queryKeys.domain.detail(id)— single entity
 *   queryKeys.domain.xxx()     — domain-specific sub-resources
 *
 * IMPORTANT: list() without params returns a 2-element prefix ["domain", "list"]
 * which matches ALL parameterized list queries via TanStack Query's partial matching.
 * This is critical for cache invalidation — mutations call list() without params
 * to invalidate all list variants regardless of pagination/sorting/filtering.
 */

/** Helper: returns prefix key when no params, exact key when params provided */
function listKey(domain: string, params?: Record<string, unknown>) {
  return params !== undefined
    ? ([domain, "list", params] as const)
    : ([domain, "list"] as const);
}

export const queryKeys = {
  // ── Dashboard ────────────────────────────────────────────────────
  dashboard: {
    all: ["dashboard"] as const,
    summary: () => ["dashboard", "summary"] as const,
    activity: () => ["dashboard", "activity"] as const,
  },

  // ── Products ─────────────────────────────────────────────────────
  products: {
    all: ["products"] as const,
    list: (params?: Record<string, unknown>) => listKey("products", params),
    detail: (id: string) => ["products", "detail", id] as const,
    byIds: (ids?: readonly string[]) =>
      ids !== undefined
        ? (["products", "by-ids", ids] as const)
        : (["products", "by-ids"] as const),
    collectionOptions: (params?: Record<string, unknown>) =>
      params !== undefined
        ? (["products", "collection-options", params] as const)
        : (["products", "collection-options"] as const),
    stats: () => ["products", "stats"] as const,
    variants: (productId: string) =>
      ["products", "variants", productId] as const,
  },

  // ── Categories ───────────────────────────────────────────────────
  categories: {
    all: ["categories"] as const,
    list: (params?: Record<string, unknown>) => listKey("categories", params),
    detail: (id: string) => ["categories", "detail", id] as const,
    formOptions: () => ["categories", "form-options"] as const,
  },

  // ── Collections ──────────────────────────────────────────────────
  collections: {
    all: ["collections"] as const,
    list: (params?: Record<string, unknown>) => listKey("collections", params),
    detail: (id: string) => ["collections", "detail", id] as const,
    byIds: (ids?: readonly string[]) =>
      ids !== undefined
        ? (["collections", "by-ids", ids] as const)
        : (["collections", "by-ids"] as const),
    categoryOptions: () => ["collections", "category-options"] as const,
    formOptions: () => ["collections", "form-options"] as const,
  },

  // ── Orders ───────────────────────────────────────────────────────
  orders: {
    all: ["orders"] as const,
    list: (params?: Record<string, unknown>) => listKey("orders", params),
    detail: (id: string) => ["orders", "detail", id] as const,
    catalogProducts: (params: Record<string, unknown>) =>
      ["orders", "catalog-products", params] as const,
    manualQuote: (input: Record<string, unknown>) =>
      ["orders", "manual-quote", input] as const,
    formData: (id: string) => ["orders", "form-data", id] as const,
    items: (orderId: string) => ["orders", "items", orderId] as const,
    payments: (orderId: string) => ["orders", "payments", orderId] as const,
    notifications: (orderId: string) => ["orders", "notifications", orderId] as const,
    returns: (orderId: string) => ["orders", "returns", orderId] as const,
    cod: (orderId: string) => ["orders", "cod", orderId] as const,
    shipments: (orderId: string) => ["orders", "shipments", orderId] as const,
  },

  // ── Customers ────────────────────────────────────────────────────
  customers: {
    all: ["customers"] as const,
    list: (params?: Record<string, unknown>) => listKey("customers", params),
    detail: (id: string) => ["customers", "detail", id] as const,
    history: (id: string, params?: Record<string, unknown>) =>
      params !== undefined
        ? (["customers", "history", id, params] as const)
        : (["customers", "history", id] as const),
  },

  // ── Discounts ────────────────────────────────────────────────────
  discounts: {
    all: ["discounts"] as const,
    list: (params?: Record<string, unknown>) => listKey("discounts", params),
    detail: (id: string) => ["discounts", "detail", id] as const,
  },

  // ── Promotions ───────────────────────────────────────────────────
  promotions: {
    all: ["promotions"] as const,
    list: (params?: Record<string, unknown>) => listKey("promotions", params),
    detail: (id: string) => ["promotions", "detail", id] as const,
  },

  // ── Pages ────────────────────────────────────────────────────────
  pages: {
    all: ["pages"] as const,
    list: (params?: Record<string, unknown>) => listKey("pages", params),
    detail: (id: string) => ["pages", "detail", id] as const,
  },

  // ── Attributes ───────────────────────────────────────────────────
  attributes: {
    all: ["attributes"] as const,
    list: (params?: Record<string, unknown>) => listKey("attributes", params),
    detail: (id: string) => ["attributes", "detail", id] as const,
    values: (params?: Record<string, unknown>) =>
      params !== undefined
        ? (["attributes", "values", params] as const)
        : (["attributes", "values"] as const),
  },

  // ── Analytics ────────────────────────────────────────────────────
  analytics: {
    all: ["analytics"] as const,
    list: (params?: Record<string, unknown>) => listKey("analytics", params),
    detail: (id: string) => ["analytics", "detail", id] as const,
    providerHealth: () => ["analytics", "provider-health"] as const,
  },

  // ── Inventory ────────────────────────────────────────────────────
  inventory: {
    all: ["inventory"] as const,
    list: (params?: Record<string, unknown>) => listKey("inventory", params),
  },

  // ── Media ────────────────────────────────────────────────────────
  media: {
    all: ["media"] as const,
    list: (params?: Record<string, unknown>) => listKey("media", params),
    folders: () => ["media", "folders"] as const,
  },

  // ── Navigation ───────────────────────────────────────────────────
  navigation: {
    all: ["navigation"] as const,
    items: () => ["navigation", "items"] as const,
    resources: (params: {
      type: "page" | "category" | "collection" | "product";
      query: string;
      limit: number;
      selectedId?: string;
    }) => ["navigation", "resources", params] as const,
    menus: () => ["navigation", "menus"] as const,
    menu: (menuId: string) => ["navigation", "menus", menuId] as const,
    menuItems: (menuId: string, parentId: string | null) =>
      ["navigation", "menus", menuId, "items", parentId ?? "root"] as const,
    publications: (menuId: string) =>
      ["navigation", "menus", menuId, "publications"] as const,
    placements: () => ["navigation", "placements"] as const,
    previewProducts: (params: Record<string, string>) =>
      ["navigation", "preview-products", params] as const,
  },

  // ── Fraud Checker ────────────────────────────────────────────────
  fraudChecker: {
    all: ["fraud-checker"] as const,
    list: () => ["fraud-checker", "list"] as const,
  },

  // ── Abandoned Checkouts ──────────────────────────────────────────
  abandonedCheckouts: {
    all: ["abandoned-checkouts"] as const,
    list: (params?: Record<string, unknown>) =>
      listKey("abandoned-checkouts", params),
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
    sessions: () => ["auth", "sessions"] as const,
    twoFaInfo: () => ["auth", "2fa-info"] as const,
  },

  // ── Settings ─────────────────────────────────────────────────────
  settings: {
    all: ["settings"] as const,
    byCategory: (category: string) => ["settings", category] as const,
    general: () => ["settings", "general"] as const,
    storefrontUrl: () => ["settings", "storefront-url"] as const,
    homepagePresentation: () =>
      ["settings", "homepage-presentation"] as const,
    seoDiscoveryLiveProbe: () =>
      ["settings", "seo-discovery-live-probe"] as const,
    seoFeedDiagnostics: () => ["settings", "seo-feed-diagnostics"] as const,
    currency: () => ["settings", "currency"] as const,
    seo: () => ["settings", "seo"] as const,
    security: () => ["settings", "security"] as const,
    auth: () => ["settings", "auth"] as const,
    checkoutFlow: () => ["settings", "checkout-flow"] as const,
    checkoutReadiness: () => ["settings", "checkout-readiness"] as const,
    customerRequests: () => ["settings", "customer-requests"] as const,
    email: () => ["settings", "email"] as const,
    firebase: () => ["settings", "firebase"] as const,
    business: () => ["settings", "business"] as const,
    taxes: () => ["settings", "taxes"] as const,
    taxClassifications: (params?: Record<string, unknown>) =>
      params !== undefined
        ? (["settings", "tax-classifications", params] as const)
        : (["settings", "tax-classifications"] as const),
    theme: () => ["settings", "theme"] as const,
    media: () => ["settings", "media"] as const,
    sms: () => ["settings", "sms"] as const,
    metaConversions: () => ["settings", "meta-conversions"] as const,
    metaConversionsLogs: (params?: Record<string, unknown>) =>
      params !== undefined
        ? (["settings", "meta-conversions-logs", params] as const)
        : (["settings", "meta-conversions-logs"] as const),
    allowedCountries: () => ["settings", "allowed-countries"] as const,
    paymentMethods: () => ["settings", "payment-methods"] as const,
    paymentGateway: (gateway: string) =>
      ["settings", "payment-gateway", gateway] as const,
    notificationChannels: () => ["settings", "notification-channels"] as const,
    adminNotificationChannels: () =>
      ["settings", "admin-notification-channels"] as const,
    deliveryProviders: () => ["settings", "delivery-providers"] as const,
    deliveryLocations: (params?: Record<string, unknown>) =>
      params !== undefined
        ? (["settings", "delivery-locations", params] as const)
        : (["settings", "delivery-locations"] as const),
    deliveryLocationsAll: (params?: Record<string, unknown>) =>
      params !== undefined
        ? (["settings", "delivery-locations-all", params] as const)
        : (["settings", "delivery-locations-all"] as const),
    importPathaoStatus: () => ["settings", "import-pathao-status"] as const,
    checkoutLanguages: (params?: Record<string, unknown>) =>
      params !== undefined
        ? (["settings", "checkout-languages", params] as const)
        : (["settings", "checkout-languages"] as const),
    shippingMethods: (params?: Record<string, unknown>) =>
      params !== undefined
        ? (["settings", "shipping-methods", params] as const)
        : (["settings", "shipping-methods"] as const),
    heroSliders: () => ["settings", "hero-sliders"] as const,
  },

  // ── Cache ────────────────────────────────────────────────────────
  cache: {
    all: ["cache"] as const,
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
