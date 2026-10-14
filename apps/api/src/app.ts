// src/server/index.ts

import { productRoutes } from "./routes/products";
import authRoutes from "./routes/auth";
import { categoryRoutes } from "./routes/categories";
import { brandRoutes } from "./routes/brands";
import { collectionRoutes } from "./routes/collections";
import { attributeRoutes } from "./routes/attributes";
import { cacheControlRoutes } from "./routes/cache";
import { searchRoutes } from "./routes/search";
import { addressAutocompleteRoutes } from "./routes/address-autocomplete";
import { navigationRoutes } from "./routes/navigation";
import { pagesRoutes } from "./routes/pages";
import { articleRoutes } from "./routes/articles";
import { orderRoutes } from "./routes/storefront-orders";
import { paymentRoutes } from "./routes/payment/payment-routes";
import { paymentWebhookRoutes } from "./routes/webhooks/payments";
import { courierWebhookRoutes } from "./routes/webhooks/couriers";
import { discountRoutes } from "./routes/discounts";
import { analyticsRoutes } from "./routes/analytics";
import { partytownProxyRoutes } from "./routes/partytown-proxy";
import {
  checkoutLanguageRoutes,
  publicCheckoutLanguageRoutes,
} from "./routes/checkout-languages";
import { abandonedCheckoutsRoutes } from "./routes/abandoned-checkouts";
import { locationRoutes } from "./routes/locations";
import { addressRuleRoutes } from "./routes/address-rules";
import { shippingMethodRoutes } from "./routes/shipping-methods";
import { seoRoutes } from "./routes/seo";
import { metaConversionsRoutes } from "./routes/meta-conversions";
import { storefrontRoutes } from "./routes/storefront";
import { platformRoutes } from "./routes/platform";
import { metaRoutes } from "./routes/meta";
import { checkoutRoutes } from "./routes/checkout";
import { customerAuthRoutes } from "./routes/customer-auth";
import { readinessRoutes } from "./routes/readiness";
import { agentPrincipalMiddleware } from "./middleware/agent-principal";
import { storefrontAgentContextRoutes } from "./routes/storefront-agent-contexts";
import { storefrontAgentContinuationRoutes } from "./routes/storefront-agent-continuations";
import { agentAuthRoutes } from "./routes/agent-auth";
import { agentArtifactRoutes } from "./routes/agent-artifacts";
import { serveMediaRoute } from "./routes/media-server";
import { createContractApiApp } from "./runtime/base-app";
import { registerDocRoutes } from "./runtime/register-doc-routes";

// Admin routes
import { adminAuthMiddleware } from "./middleware/admin-auth";
import { privateNoStore } from "./middleware/private-no-store";
import {
  cookieOriginGuardMiddleware,
  dashboardOriginGuardMiddleware,
} from "./middleware/cookie-origin-guard";
import { webhookBodyLimitMiddleware } from "./middleware/webhook-body-limit";
import { adminLocationRoutes } from "./routes/admin/settings/delivery-locations";
import { adminCategoryRoutes } from "./routes/admin/categories";
import { adminBrandRoutes } from "./routes/admin/brands";
import { adminPriceListRoutes } from "./routes/admin/price-lists";
import { adminMetaobjectRoutes } from "./routes/admin/metaobjects";
import { adminCollectionRoutes } from "./routes/admin/collections";
import { adminCustomerRoutes } from "./routes/admin/customers";
import { adminCustomerMarketingRoutes } from "./routes/admin/customer-marketing";
import { marketingRoutes } from "./routes/marketing";
import { adminPageRoutes } from "./routes/admin/pages";
import { adminDiscountRoutes } from "./routes/admin/discounts";
import { adminMediaRoutes } from "./routes/admin/media";
import { adminInventoryRoutes } from "./routes/admin/inventory";
import { adminPurchaseOrderRoutes, adminSupplierRoutes, adminTransferRoutes } from "./routes/admin/inventory-purchasing";
import { adminNavigationRoutes } from "./routes/admin/navigation";
import { adminTranslationRoutes } from "./routes/admin/translations";
import { adminSearchRoutes } from "./routes/admin/search";
import { adminShipmentRoutes } from "./routes/admin/shipments";
import { adminAnalyticsRoutes } from "./routes/admin/analytics";
import { adminFraudCheckerRoutes } from "./routes/admin/fraud-checker";
import { adminWebhookRoutes } from "./routes/admin/webhooks";
import { adminEventRoutes } from "./routes/admin/events";
import { adminAppRoutes } from "./routes/admin/apps";
import { customFieldDefinitionRoutes, customFieldValueRoutes } from "./routes/admin/custom-fields";
import { adminRbacRoutes } from "./routes/admin/rbac";
import { adminSettingsRoutes } from "./routes/admin/settings";
import { adminOrdersRoutes } from "./routes/admin/orders";
import { adminConversationRoutes } from "./routes/admin/conversations";
import { adminProductsRoutes } from "./routes/admin/products";
import {
  adminAuthManagementRoutes,
  authSetupRoutes,
} from "./routes/admin/auth-management";
import { adminAttributesRoutes } from "./routes/admin/attributes";
import { adminCatalogProjectionRoutes } from "./routes/admin/catalog-projections";
import { adminDashboardRoutes } from "./routes/admin/dashboard";
import { adminReportRoutes } from "./routes/admin/reports";
import { adminSystemUtilsRoutes } from "./routes/admin/system-utils";
import { adminWebPushRoutes } from "./routes/admin/web-push";
import { adminStaffAlertRoutes } from "./routes/admin/staff-alerts";
import { adminTaxRoutes } from "./routes/admin/taxes";
import { adminAgentAccessRoutes } from "./routes/admin/agent-access";
import { adminReviewRoutes } from "./routes/admin/reviews";
import {
  adminDigitalAssetRoutes,
  adminDigitalEntitlementRoutes,
  adminProductDigitalAssetRoutes,
} from "./routes/admin/digital-assets";
import { adminWarrantyPolicyRoutes } from "./routes/admin/warranty-policies";
import { adminGiftCardRoutes } from "./routes/admin/gift-cards";
import { adminWarrantyClaimRoutes } from "./routes/admin/warranty-claims";
import { adminExportRoutes, adminImportRoutes } from "./routes/admin/store-transfer";
import { productReviewRoutes } from "./routes/product-reviews";
import { checkoutGiftCardRoutes } from "./routes/checkout-gift-cards";

// Create typed OpenAPIHono app with Cloudflare Workers Env bindings
// basePath("/api/v1") — standalone worker receives full URLs (e.g. /api/v1/products)
const app = createContractApiApp();

// Error handling is handled by app.onError() above.
// All uncaught errors propagate to the global onError handler which
// returns properly formatted JSON error responses.

// Public root (relative path '/') - handles requests to /api/v1/
// Update welcome message if desired, path remains '/'
app.get("/", (c) =>
  c.json({
    success: true,
    message: "Welcome to Scalius Commerce API", // Reverted message
    version: process.env.npm_package_version || "1.0.0",
    environment: process.env.NODE_ENV || "development",
  }),
);

// ==========================================
// STOREFRONT API ROUTES
// ==========================================
// Public Storefront routes (no auth required)
// Mount directly on app, paths are relative
app.route("/auth", authRoutes);
app.route("/agent-auth", agentAuthRoutes);
app.route("/agent-artifacts", agentArtifactRoutes);
app.route("/attributes", attributeRoutes);
app.route("/collections", collectionRoutes);
app.route("/brands", brandRoutes);
app.route("/search", searchRoutes);
app.route("/navigation", navigationRoutes);
app.route("/pages", pagesRoutes);
app.route("/articles", articleRoutes);
app.route("/discounts", discountRoutes);
app.route("/analytics", analyticsRoutes);
app.route("/meta", metaConversionsRoutes);
app.route("/storefront", storefrontRoutes);
// Public platform origins consumed by the storefront Worker and the dashboard
app.route("/platform", platformRoutes);
// Compatibility discovery for automated deployments (release, API majors, schema revision)
app.route("/meta", metaRoutes);
app.use("/storefront/agent-contexts/*", agentPrincipalMiddleware);
app.route("/storefront/agent-contexts", storefrontAgentContextRoutes);
app.route("/storefront/agent-continuations", storefrontAgentContinuationRoutes);
app.route("/checkout", checkoutRoutes);
app.route("/checkout/gift-cards", checkoutGiftCardRoutes);
app.use("/customer-auth/*", cookieOriginGuardMiddleware);
app.route("/customer-auth", customerAuthRoutes);
app.route("/checkout-languages", publicCheckoutLanguageRoutes);
app.route("/abandoned-checkouts", abandonedCheckoutsRoutes);
app.route("/marketing", marketingRoutes);
app.route("/locations", locationRoutes);
app.route("/address-rules/autocomplete", addressAutocompleteRoutes);
app.route("/address-rules", addressRuleRoutes);
app.route("/shipping-methods", shippingMethodRoutes);
// SEO settings — used by storefront product/page routes for meta tags
app.route("/seo", seoRoutes);
// Public media bytes: local development's media address and the storefront's
// same-origin media (service binding only; a public address answers 404).
app.route("/media", serveMediaRoute);
// Add health check endpoint (relative path '/health')
app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));
app.route("/", readinessRoutes);

// Adding Partytown proxy route (publicly accessible, no authMiddleware)
app.route("/__ptproxy", partytownProxyRoutes);

// --- Protected API routes ---

// Webhook routes — NO auth middleware (signature verification IS the auth)
// Must be registered BEFORE the auth middleware block
app.use("/webhooks/*", webhookBodyLimitMiddleware);
// Couriers: /webhooks/couriers/{provider}.
app.route("/webhooks/couriers", courierWebhookRoutes);
// Payment gateways: /webhooks/{provider}. Registered after the courier routes.
app.route("/webhooks", paymentWebhookRoutes);


// Apply protection only to paths needing it. The storefront order router is
// public but proof/origin guarded: checkout create/cart-validation/status/receipt
// must stay reachable without a bearer token.
// Dashboard responses (including refusals) carry merchant data: never let a
// browser, proxy or back/forward cache keep them.
app.use("/cache/*", privateNoStore);
app.use("/admin/*", privateNoStore);
app.use("/cache/*", dashboardOriginGuardMiddleware);
app.use("/cache/*", adminAuthMiddleware);
app.use("/orders/*", cookieOriginGuardMiddleware);

// Register routes (mix of public and protected)
app.route("/products", productRoutes);
app.route("/products", productReviewRoutes);
app.route("/categories", categoryRoutes);
app.route("/cache", cacheControlRoutes);
app.route("/orders", orderRoutes);

// ==========================================
// ADMIN API ROUTES
// ==========================================
// The /admin/* routes are strictly protected by adminAuthMiddleware.
// It verifies an active Better Auth dashboard session; scanner cookies are
// limited to exact scanner workflow endpoints inside the middleware.
app.use("/admin/*", dashboardOriginGuardMiddleware);
app.use("/admin/*", adminAuthMiddleware);

// Register Admin routes
app.route("/admin/categories", adminCategoryRoutes);
app.route("/admin/brands", adminBrandRoutes);
app.route("/admin/price-lists", adminPriceListRoutes);
app.route("/admin/metaobjects", adminMetaobjectRoutes);
app.route("/admin/collections", adminCollectionRoutes);
// Static customer paths (tags, segments, export) before the /{id} routes.
app.route("/admin/customers", adminCustomerMarketingRoutes);
app.route("/admin/customers", adminCustomerRoutes);
app.route("/admin/pages", adminPageRoutes);
app.route("/admin/discounts", adminDiscountRoutes);
app.route("/admin/media", adminMediaRoutes);
app.route("/admin/inventory/suppliers", adminSupplierRoutes);
app.route("/admin/inventory/purchase-orders", adminPurchaseOrderRoutes);
app.route("/admin/inventory/transfers", adminTransferRoutes);
app.route("/admin/inventory", adminInventoryRoutes);
app.route("/admin/navigation", adminNavigationRoutes);
app.route("/admin/translations", adminTranslationRoutes);
app.route("/admin/search", adminSearchRoutes);
app.route("/admin/shipments", adminShipmentRoutes);
app.route("/admin/analytics", adminAnalyticsRoutes);
app.route("/admin/dashboard", adminDashboardRoutes);
app.route("/admin/reports", adminReportRoutes);
app.route("/admin/fraud-checker", adminFraudCheckerRoutes);
app.route("/admin/rbac", adminRbacRoutes);
app.route("/admin/settings", adminSettingsRoutes);
app.route("/admin/orders", adminOrdersRoutes);
app.route("/admin/conversations", adminConversationRoutes);
app.route("/admin/products", adminProductsRoutes);
app.route("/admin/products", adminProductDigitalAssetRoutes);
app.route("/admin/auth", adminAuthManagementRoutes);
app.route("/admin/attributes", adminAttributesRoutes);
app.route("/admin/catalog", adminCatalogProjectionRoutes);
app.route("/admin/taxes", adminTaxRoutes);
app.route("/admin/agent-access", adminAgentAccessRoutes);
app.route("/admin/webhooks", adminWebhookRoutes);
app.route("/admin/events", adminEventRoutes);
app.route("/admin/apps", adminAppRoutes);
app.route("/admin/custom-field-definitions", customFieldDefinitionRoutes);
app.route("/admin/custom-fields", customFieldValueRoutes);
app.route("/admin/reviews", adminReviewRoutes);
app.route("/admin/digital-assets", adminDigitalAssetRoutes);
app.route("/admin/digital-entitlements", adminDigitalEntitlementRoutes);
app.route("/admin/warranty-policies", adminWarrantyPolicyRoutes);
app.route("/admin/gift-cards", adminGiftCardRoutes);
app.route("/admin/warranty-claims", adminWarrantyClaimRoutes);
app.route("/admin/import", adminImportRoutes);
app.route("/admin/export", adminExportRoutes);
app.route("/admin/web-push", adminWebPushRoutes);
app.route("/admin/notifications", adminStaffAlertRoutes);
app.route("/admin", adminSystemUtilsRoutes);
app.route("/admin/settings/delivery-locations", adminLocationRoutes);
app.route("/admin/settings/checkout-languages", checkoutLanguageRoutes);
app.route("/admin/settings/abandoned-checkouts", abandonedCheckoutsRoutes);

// Setup routes - bypassing normal auth rules, used only during initial deployment
app.route("/setup", authSetupRoutes);

// Payment routes — session/intent creation is public (storefront)
app.route("/payment", paymentRoutes);

// Swagger UI and the generated OpenAPI contract
registerDocRoutes(app);

// Register the security scheme for the OpenAPI spec
app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

// Export the main app
export type AppType = typeof app;
export default app;
