// The one declarative mount table of /api/v1: every router mount and every
// path-scoped middleware, in registration order, each tagged with the lazy
// route group that serves it in production.
//
// Both apps read it: each production group app (runtime/*-app.ts) applies the
// steps of its group (route-groups.ts), and the contract app (app.ts: types,
// the OpenAPI contract, the SDK and many tests) applies every step once. A
// middleware cannot reach one and miss the other, and Worker entry classifies
// a request into its group from these same paths, so there is no second list.
//
// The table names routers and middleware; it imports neither, so classifying
// a request loads no route graph. Each group module supplies the routers and
// middleware its steps name (type-checked against this table).

export type RuntimeAppName = "probe" | "public" | "admin" | "system" | "docs" | "plugins";

/** The lazily loaded route groups and the family each belongs to. */
export const ROUTE_GROUP_FAMILIES = {
  probe: "probe",
  docs: "docs",
  system: "system",
  plugins: "plugins",
  "public-config": "public",
  "public-catalog": "public",
  "public-content": "public",
  "public-buyer": "public",
  "admin-dashboard": "admin",
  "admin-catalog": "admin",
  "admin-sales": "admin",
  "admin-content": "admin",
  "admin-access": "admin",
} as const satisfies Record<string, RuntimeAppName>;

export type RouteGroup = keyof typeof ROUTE_GROUP_FAMILIES;

/** Groups outside the OpenAPI contract (each app declares its own routes in its manifest). */
export const NON_CONTRACT_GROUPS: ReadonlySet<RouteGroup> = new Set(["plugins"]);

export type MiddlewareId =
  | "privateNoStore"
  | "dashboardOriginGuard"
  | "adminAuth"
  | "commitSeq"
  | "idempotentReplay"
  | "cookieOriginGuard"
  | "agentPrincipal"
  | "webhookBodyLimit";

/** Middleware on a path pattern, for one group or for every group of a family. */
export interface MiddlewareStep {
  readonly use: string;
  readonly middleware: readonly MiddlewareId[];
  readonly group?: RouteGroup;
  readonly family?: RuntimeAppName;
}

/**
 * A router mounted at a path. Requests classify into its group by the path
 * as a prefix, or only by `exact` paths and `prefixes` when given (a mount at
 * `/`, or one sharing its path with another group's mount).
 */
export interface MountStep {
  readonly mount: string;
  readonly router: string;
  readonly group: RouteGroup;
  readonly exact?: readonly string[];
  readonly prefixes?: readonly string[];
}

export type RouteStep = MiddlewareStep | MountStep;

/** Every dashboard operation, whatever its group: session or agent auth, RBAC, no-store, commit sequence, idempotent replay. */
const ADMIN_MIDDLEWARE = ["privateNoStore", "dashboardOriginGuard", "adminAuth", "commitSeq", "idempotentReplay"] as const;

export const ROUTE_TABLE = [
  // Public root and storefront reads.
  { mount: "/", router: "welcomeRoutes", group: "public-config", exact: ["/"] },
  { mount: "/auth", router: "authRoutes", group: "system" },
  { mount: "/agent-auth", router: "agentAuthRoutes", group: "system" },
  { mount: "/agent-artifacts", router: "agentArtifactRoutes", group: "system" },
  { mount: "/attributes", router: "attributeRoutes", group: "public-catalog" },
  { mount: "/collections", router: "collectionRoutes", group: "public-catalog" },
  { mount: "/brands", router: "brandRoutes", group: "public-catalog" },
  { mount: "/objects", router: "publicObjectRoutes", group: "public-content" },
  { mount: "/search", router: "searchRoutes", group: "public-catalog" },
  { mount: "/navigation", router: "navigationRoutes", group: "public-config" },
  { mount: "/pages", router: "pagesRoutes", group: "public-content" },
  { mount: "/articles", router: "articleRoutes", group: "public-content" },
  { mount: "/discounts", router: "discountRoutes", group: "public-buyer" },
  { mount: "/analytics", router: "analyticsRoutes", group: "public-buyer" },
  { mount: "/meta", router: "metaConversionsRoutes", group: "public-buyer" },
  { mount: "/storefront", router: "storefrontRoutes", group: "public-config" },
  // Public platform origins consumed by the storefront Worker and the dashboard.
  { mount: "/platform", router: "platformRoutes", group: "public-config" },
  // Compatibility discovery for automated deployments (release, API majors, schema revision).
  { mount: "/meta", router: "metaRoutes", group: "probe", exact: ["/meta"] },
  { use: "/storefront/agent-contexts/*", middleware: ["agentPrincipal"], group: "public-buyer" },
  { mount: "/storefront/agent-contexts", router: "storefrontAgentContextRoutes", group: "public-buyer" },
  { mount: "/storefront/agent-continuations", router: "storefrontAgentContinuationRoutes", group: "public-buyer" },
  // Checkout settings are a public read every storefront render batches with
  // the layout; serving them from the config group keeps the buyer graph
  // (orders, customer auth, agent contexts) out of page renders.
  { mount: "/checkout", router: "checkoutRoutes", group: "public-config" },
  { mount: "/checkout/gift-cards", router: "checkoutGiftCardRoutes", group: "public-config" },
  { use: "/customer-auth/*", middleware: ["cookieOriginGuard"], group: "public-buyer" },
  { mount: "/customer-auth", router: "customerAuthRoutes", group: "public-buyer" },
  { mount: "/checkout-languages", router: "publicCheckoutLanguageRoutes", group: "public-config" },
  { mount: "/abandoned-checkouts", router: "abandonedCheckoutsRoutes", group: "public-buyer" },
  { mount: "/marketing", router: "marketingRoutes", group: "public-buyer" },
  { mount: "/locations", router: "locationRoutes", group: "public-config" },
  { mount: "/address-rules/autocomplete", router: "addressAutocompleteRoutes", group: "public-config" },
  { mount: "/address-rules", router: "addressRuleRoutes", group: "public-config" },
  { mount: "/shipping-methods", router: "shippingMethodRoutes", group: "public-config" },
  // SEO settings: storefront product and page meta tags.
  { mount: "/seo", router: "seoRoutes", group: "public-config" },
  // Public media bytes: local development's media address and the storefront's
  // same-origin media (service binding only; a public address answers 404).
  { mount: "/media", router: "serveMediaRoute", group: "public-catalog" },
  // Probes.
  { mount: "/health", router: "healthRoutes", group: "probe", exact: ["/health"] },
  { mount: "/", router: "readinessRoutes", group: "probe", exact: ["/readyz"] },
  // Webhooks: no auth middleware (the signature is the auth), bounded bodies.
  { use: "/webhooks/*", middleware: ["webhookBodyLimit"], group: "system" },
  // Couriers: /webhooks/couriers/{provider}; payment gateways: /webhooks/{provider}, after them.
  { mount: "/webhooks/couriers", router: "courierWebhookRoutes", group: "system" },
  { mount: "/webhooks", router: "paymentWebhookRoutes", group: "system" },
  // The dashboard's cache controls carry merchant data and need a dashboard session.
  { use: "/cache/*", middleware: ["privateNoStore", "dashboardOriginGuard", "adminAuth"], group: "system" },
  // The storefront order router is public but proof and origin guarded:
  // create, cart validation, status and receipt stay reachable without a bearer token.
  { use: "/orders/*", middleware: ["cookieOriginGuard"], group: "public-buyer" },
  { mount: "/products", router: "productRoutes", group: "public-catalog" },
  { mount: "/products", router: "productReviewRoutes", group: "public-catalog" },
  { mount: "/categories", router: "categoryRoutes", group: "public-catalog" },
  { mount: "/cache", router: "cacheControlRoutes", group: "system" },
  { mount: "/orders", router: "orderRoutes", group: "public-buyer" },

  // The dashboard API.
  { use: "/admin/*", middleware: ADMIN_MIDDLEWARE, family: "admin" },
  // The stable app API's resources (orders, products, customers and their
  // parts), bulk runs, gift cards, PIM product writes and an app's own webhooks.
  { mount: "/admin/resources", router: "adminResourceRoutes", group: "admin-sales" },
  { mount: "/admin/resources", router: "adminResourceBulkRoutes", group: "admin-sales" },
  { mount: "/admin/resources", router: "adminResourceGiftCardRoutes", group: "admin-sales" },
  { mount: "/admin/resources", router: "adminResourceProductRoutes", group: "admin-sales" },
  { mount: "/admin/resources", router: "adminResourceRefundRoutes", group: "admin-sales" },
  { mount: "/admin/resources", router: "adminResourceWebhookRoutes", group: "admin-sales" },
  { mount: "/admin/categories", router: "adminCategoryRoutes", group: "admin-catalog" },
  { mount: "/admin/brands", router: "adminBrandRoutes", group: "admin-catalog" },
  { mount: "/admin/price-lists", router: "adminPriceListRoutes", group: "admin-catalog" },
  { mount: "/admin/objects", router: "adminObjectRoutes", group: "admin-content" },
  { mount: "/admin/collections", router: "adminCollectionRoutes", group: "admin-catalog" },
  // Static customer paths (tags, segments, export) before the /{id} routes.
  { mount: "/admin/customers", router: "adminCustomerMarketingRoutes", group: "admin-sales" },
  { mount: "/admin/customers", router: "adminCustomerRoutes", group: "admin-sales" },
  { mount: "/admin/pages", router: "adminPageRoutes", group: "admin-content" },
  { mount: "/admin/discounts", router: "adminDiscountRoutes", group: "admin-sales" },
  { mount: "/admin/media", router: "adminMediaRoutes", group: "admin-catalog" },
  { mount: "/admin/inventory/suppliers", router: "adminSupplierRoutes", group: "admin-catalog" },
  { mount: "/admin/inventory/purchase-orders", router: "adminPurchaseOrderRoutes", group: "admin-catalog" },
  { mount: "/admin/inventory/transfers", router: "adminTransferRoutes", group: "admin-catalog" },
  { mount: "/admin/inventory", router: "adminInventoryRoutes", group: "admin-catalog" },
  { mount: "/admin/navigation", router: "adminNavigationRoutes", group: "admin-content" },
  { mount: "/admin/translations", router: "adminTranslationRoutes", group: "admin-content" },
  { mount: "/admin/search", router: "adminSearchRoutes", group: "admin-dashboard" },
  { mount: "/admin/analytics", router: "adminAnalyticsRoutes", group: "admin-dashboard" },
  { mount: "/admin/dashboard", router: "adminDashboardRoutes", group: "admin-dashboard" },
  { mount: "/admin/reports", router: "adminReportRoutes", group: "admin-dashboard" },
  { mount: "/admin/fraud-checker", router: "adminFraudCheckerRoutes", group: "admin-dashboard" },
  { mount: "/admin/rbac", router: "adminRbacRoutes", group: "admin-access" },
  { mount: "/admin/settings", router: "adminSettingsRoutes", group: "admin-content" },
  { mount: "/admin/orders", router: "adminOrdersRoutes", group: "admin-sales" },
  { mount: "/admin/conversations", router: "adminConversationRoutes", group: "admin-sales" },
  { mount: "/admin/products", router: "adminProductsRoutes", group: "admin-catalog" },
  { mount: "/admin/products", router: "adminProductDigitalAssetRoutes", group: "admin-catalog" },
  { mount: "/admin/auth", router: "adminAuthManagementRoutes", group: "admin-access" },
  { mount: "/admin/attributes", router: "adminAttributesRoutes", group: "admin-catalog" },
  { mount: "/admin/catalog", router: "adminCatalogProjectionRoutes", group: "admin-catalog" },
  { mount: "/admin/taxes", router: "adminTaxRoutes", group: "admin-sales" },
  { mount: "/admin/agent-access", router: "adminAgentAccessRoutes", group: "admin-access" },
  { mount: "/admin/webhooks", router: "adminWebhookRoutes", group: "admin-access" },
  { mount: "/admin/events", router: "adminEventRoutes", group: "admin-access" },
  { mount: "/admin/apps", router: "adminAppRoutes", group: "admin-access" },
  { mount: "/admin/custom-field-definitions", router: "customFieldDefinitionRoutes", group: "admin-content" },
  { mount: "/admin/custom-fields", router: "customFieldValueRoutes", group: "admin-content" },
  { mount: "/admin/reviews", router: "adminReviewRoutes", group: "admin-catalog" },
  { mount: "/admin/digital-assets", router: "adminDigitalAssetRoutes", group: "admin-catalog" },
  { mount: "/admin/digital-entitlements", router: "adminDigitalEntitlementRoutes", group: "admin-catalog" },
  { mount: "/admin/warranty-policies", router: "adminWarrantyPolicyRoutes", group: "admin-catalog" },
  { mount: "/admin/gift-cards", router: "adminGiftCardRoutes", group: "admin-sales" },
  { mount: "/admin/warranty-claims", router: "adminWarrantyClaimRoutes", group: "admin-sales" },
  // Store migration: products, customers and inventory in one group.
  { mount: "/admin/import", router: "adminImportRoutes", group: "admin-catalog" },
  { mount: "/admin/export", router: "adminExportRoutes", group: "admin-catalog" },
  { mount: "/admin/web-push", router: "adminWebPushRoutes", group: "admin-dashboard" },
  { mount: "/admin/notifications", router: "adminStaffAlertRoutes", group: "admin-dashboard" },
  {
    mount: "/admin",
    router: "adminSystemUtilsRoutes",
    group: "admin-dashboard",
    exact: ["/admin"],
    prefixes: ["/admin/abandoned-checkouts", "/admin/fcm-token", "/admin/fcm-token-cleanup"],
  },
  { mount: "/admin/settings/delivery-locations", router: "adminLocationRoutes", group: "admin-content" },
  { mount: "/admin/settings/checkout-languages", router: "checkoutLanguageRoutes", group: "admin-content" },

  // First-admin setup (its own token rules) and hosted payment sessions.
  { mount: "/setup", router: "authSetupRoutes", group: "system" },
  { mount: "/payment", router: "paymentRoutes", group: "system" },
  // The generated OpenAPI contract.
  { mount: "/", router: "docRoutes", group: "docs", exact: ["/openapi.json"] },
  // Installed apps' admin, public and webhook routes (plugins/routes.ts).
  { mount: "/", router: "pluginRoutes", group: "plugins", prefixes: ["/plugins"] },
] as const satisfies readonly RouteStep[];

type TableStep = (typeof ROUTE_TABLE)[number];
type FamilyOf<G extends RouteGroup> = (typeof ROUTE_GROUP_FAMILIES)[G];

/** The router names a group's module supplies. */
export type RouterIdOf<G extends RouteGroup> = Extract<TableStep, { group: G; router: string }>["router"];

/** The middleware names a group's module supplies. */
export type MiddlewareIdOf<G extends RouteGroup> =
  | Extract<TableStep, { group: G; middleware: readonly string[] }>["middleware"][number]
  | Extract<TableStep, { family: FamilyOf<G>; middleware: readonly string[] }>["middleware"][number];

export function isMountStep(step: RouteStep): step is MountStep {
  return "mount" in step;
}

/** The steps a group's app applies, in table order. */
export function routeStepsOf(group: RouteGroup): RouteStep[] {
  const family = ROUTE_GROUP_FAMILIES[group];
  return ROUTE_TABLE.filter((step: RouteStep) =>
    isMountStep(step) ? step.group === group : step.group === group || step.family === family);
}

// ── Classification ───────────────────────────────────────────────────────────

const API_BASE = "/api/v1";

/** Exact paths and boundary-safe prefixes (relative to /api/v1), longest prefix first. */
const EXACT = new Map<string, RouteGroup>();
const PREFIXES: Array<readonly [string, RouteGroup]> = [];
for (const step of ROUTE_TABLE as readonly RouteStep[]) {
  if (!isMountStep(step)) continue;
  for (const path of step.exact ?? []) EXACT.set(path, step.group);
  const prefixes = step.prefixes ?? (step.exact ? [] : [step.mount]);
  for (const prefix of prefixes) PREFIXES.push([prefix, step.group]);
}
PREFIXES.sort(([left], [right]) => right.length - left.length);

/**
 * The route group serving a request path, or null for a path no mount
 * serves (it loads no route graph). An exact path wins over a prefix, a
 * longer prefix over a shorter one; prefixes match whole segments only.
 */
export function classifyRouteGroup(pathname: string): RouteGroup | null {
  if (pathname !== API_BASE && !pathname.startsWith(`${API_BASE}/`)) return null;
  let path = pathname.slice(API_BASE.length) || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const exact = EXACT.get(path);
  if (exact) return exact;
  for (const [prefix, group] of PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return group;
  }
  return null;
}
