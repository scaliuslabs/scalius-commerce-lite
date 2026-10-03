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

  // ── Analytics overview and reports (sales numbers) ───────────────
  reports: {
    all: ["reports"] as const,
    overview: (params: Record<string, unknown>) => ["reports", "overview", params] as const,
    catalog: () => ["reports", "catalog"] as const,
    report: (reportId: string, params: Record<string, unknown>) => ["reports", "report", reportId, params] as const,
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

  // ── Brands ───────────────────────────────────────────────────────
  brands: {
    all: ["brands"] as const,
    list: (params?: Record<string, unknown>) => listKey("brands", params),
    detail: (id: string) => ["brands", "detail", id] as const,
    formOptions: () => ["brands", "form-options"] as const,
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

  // ── Addresses ────────────────────────────────────────────────────
  /** Address rules are code (libaddressinput): they change only with a release. */
  addressRules: {
    countries: () => ["address-rules", "countries"] as const,
    country: (countryCode: string) => ["address-rules", "country", countryCode] as const,
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
    /** The store's tags with counts; without `q`, every tag search (for invalidation). */
    tags: (q?: string) =>
      q !== undefined ? (["customers", "tags", q] as const) : (["customers", "tags"] as const),
    /** One customer's consent per channel, consent log and tags. */
    marketing: (id: string) => ["customers", "marketing", id] as const,
    /** Saved segments: the list, and (below it) each segment, its count and previews. */
    segments: () => ["customers", "segments"] as const,
    segment: (id: string) => ["customers", "segments", "detail", id] as const,
    segmentCount: (id: string) => ["customers", "segments", "count", id] as const,
    segmentPreview: (definition: unknown) => ["customers", "segments", "preview", definition] as const,
  },

  // ── Discounts ────────────────────────────────────────────────────
  discounts: {
    all: ["discounts"] as const,
    list: (params?: Record<string, unknown>) => listKey("discounts", params),
    detail: (id: string) => ["discounts", "detail", id] as const,
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
    placements: () => ["navigation", "placements"] as const,
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
    storefrontUrl: () => ["settings", "storefront-url"] as const,
    platform: () => ["settings", "platform"] as const,
    currency: () => ["settings", "currency"] as const,
    seo: () => ["settings", "seo"] as const,
    security: () => ["settings", "security"] as const,
    auth: () => ["settings", "auth"] as const,
    checkoutFlow: () => ["settings", "checkout-flow"] as const,
    checkoutReadiness: () => ["settings", "checkout-readiness"] as const,
    customerRequests: () => ["settings", "customer-requests"] as const,
    marketingConsent: () => ["settings", "marketing-consent"] as const,
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
    /** Installed apps' providers of one port (payment, courier, sms, email, fraud), with readiness. */
    appProviders: (kind: string) => ["settings", "app-providers", kind] as const,
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

  // ── Webhooks (commerce hook H3) ──────────────────────────────────
  webhooks: {
    all: ["webhooks"] as const,
    list: () => ["webhooks", "list"] as const,
    /** Without `status`: every status filter of one subscription (for invalidation). */
    deliveries: (id: string, status?: string) =>
      status !== undefined
        ? (["webhooks", "deliveries", id, status] as const)
        : (["webhooks", "deliveries", id] as const),
  },

  // ── Apps (installed plugins) ─────────────────────────────────────
  apps: {
    all: ["apps"] as const,
    list: () => ["apps", "list"] as const,
    detail: (id: string) => ["apps", "detail", id] as const,
    logs: (id: string) => ["apps", "logs", id] as const,
    /** Without `status`: every status filter of one app (for invalidation). */
    deliveries: (id: string, status?: string) =>
      status !== undefined
        ? (["apps", "deliveries", id, status] as const)
        : (["apps", "deliveries", id] as const),
    /** Every active app's pages, cards, actions and widgets (the dashboard's app surfaces). */
    surfaces: () => ["apps", "surfaces"] as const,
    /**
     * One app UI request (a page, card or widget document). Without `route`:
     * every document of one app; without `pluginId`: every app document.
     */
    document: (pluginId?: string, route?: string, query?: Readonly<Record<string, string>>) =>
      pluginId === undefined
        ? (["apps", "document"] as const)
        : route === undefined
          ? (["apps", "document", pluginId] as const)
          : (["apps", "document", pluginId, route, query ?? {}] as const),
  },
} as const;
