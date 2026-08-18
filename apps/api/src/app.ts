// src/server/index.ts

import { swaggerUI } from "@hono/swagger-ui";
import { productRoutes } from "./routes/products";
import authRoutes from "./routes/auth";
import { categoryRoutes } from "./routes/categories";
import { collectionRoutes } from "./routes/collections";
import { attributeRoutes } from "./routes/attributes";
import { heroRoutes } from "./routes/hero";
import { cacheControlRoutes } from "./routes/cache";
import { searchRoutes } from "./routes/search";
import { headerRoutes } from "./routes/header";
import { navigationRoutes } from "./routes/navigation";
import { footerRoutes } from "./routes/footer";
import { pagesRoutes } from "./routes/pages";
import { articleRoutes } from "./routes/articles";
import { orderRoutes } from "./routes/orders";
import { stripePaymentRoutes } from "./routes/payment/stripe-routes";
import { sslcommerzPaymentRoutes } from "./routes/payment/sslcommerz-routes";
import { polarPaymentRoutes } from "./routes/payment/polar-routes";
import { stripeWebhookRoutes } from "./routes/webhooks/stripe";
import { sslcommerzWebhookRoutes } from "./routes/webhooks/sslcommerz";
import { polarWebhookRoutes } from "./routes/webhooks/polar";
import { pathaoWebhookRoutes } from "./routes/webhooks/pathao";
import { steadfastWebhookRoutes } from "./routes/webhooks/steadfast";
import { discountRoutes } from "./routes/discounts";
import { analyticsRoutes } from "./routes/analytics";
import { partytownProxyRoutes } from "./routes/partytown-proxy";
import {
  checkoutLanguageRoutes,
  publicCheckoutLanguageRoutes,
} from "./routes/checkout-languages";
import { abandonedCheckoutsRoutes } from "./routes/abandoned-checkouts";
import { locationRoutes } from "./routes/locations";
import { shippingMethodRoutes } from "./routes/shipping-methods";
import { seoRoutes } from "./routes/seo";
import { metaConversionsRoutes } from "./routes/meta-conversions";
import { storefrontRoutes } from "./routes/storefront";
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
import {
  OPENAPI_CONTRACT_ETAG,
  OPENAPI_CONTRACT_JSON,
} from "./generated/openapi-contract.gen";

// Admin routes
import { adminAuthMiddleware } from "./middleware/admin-auth";
import { cookieOriginGuardMiddleware } from "./middleware/cookie-origin-guard";
import { webhookBodyLimitMiddleware } from "./middleware/webhook-body-limit";
import { adminLocationRoutes } from "./routes/admin/settings/delivery-locations";
import { adminCategoryRoutes } from "./routes/admin/categories";
import { adminCollectionRoutes } from "./routes/admin/collections";
import { adminCustomerRoutes } from "./routes/admin/customers";
import { adminPageRoutes } from "./routes/admin/pages";
import { adminDiscountRoutes } from "./routes/admin/discounts";
import { adminPromotionRoutes } from "./routes/admin/promotions";
import { adminMediaRoutes } from "./routes/admin/media";
import { adminInventoryRoutes } from "./routes/admin/inventory";
import { adminNavigationRoutes } from "./routes/admin/navigation";
import { adminSearchRoutes } from "./routes/admin/search";
import { adminShipmentRoutes } from "./routes/admin/shipments";
import { adminAnalyticsRoutes } from "./routes/admin/analytics";
import { adminFraudCheckerRoutes } from "./routes/admin/fraud-checker";
import { adminRbacRoutes } from "./routes/admin/rbac";
import { adminSettingsRoutes } from "./routes/admin/settings";
import { adminOrdersRoutes } from "./routes/admin/orders";
import { adminProductsRoutes } from "./routes/admin/products";
import {
  adminAuthManagementRoutes,
  authSetupRoutes,
} from "./routes/admin/auth-management";
import { adminAttributesRoutes } from "./routes/admin/attributes";
import { adminDashboardRoutes } from "./routes/admin/dashboard";
import { adminSystemUtilsRoutes } from "./routes/admin/system-utils";
import { adminTaxRoutes } from "./routes/admin/taxes";
import { adminAgentAccessRoutes } from "./routes/admin/agent-access";

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
app.route("/hero", heroRoutes);
app.route("/search", searchRoutes);
app.route("/header", headerRoutes);
app.route("/navigation", navigationRoutes);
app.route("/footer", footerRoutes);
app.route("/pages", pagesRoutes);
app.route("/articles", articleRoutes);
app.route("/discounts", discountRoutes);
app.route("/analytics", analyticsRoutes);
app.route("/meta", metaConversionsRoutes);
app.route("/storefront", storefrontRoutes);
app.use("/storefront/agent-contexts/*", agentPrincipalMiddleware);
app.route("/storefront/agent-contexts", storefrontAgentContextRoutes);
app.route("/storefront/agent-continuations", storefrontAgentContinuationRoutes);
app.route("/checkout", checkoutRoutes);
app.use("/customer-auth/*", cookieOriginGuardMiddleware);
app.route("/customer-auth", customerAuthRoutes);
app.route("/checkout-languages", publicCheckoutLanguageRoutes);
app.route("/abandoned-checkouts", abandonedCheckoutsRoutes);
app.route("/locations", locationRoutes);
app.route("/shipping-methods", shippingMethodRoutes);
// SEO settings — used by storefront product/page routes for meta tags
app.route("/seo", seoRoutes);
// Local development media server route
if (process.env.NODE_ENV === "development") {
  app.route("/media", serveMediaRoute);
} // Add health check endpoint (relative path '/health')
app.get("/health", async (c) => {
  try {
    const { getCacheStats, getCacheType } = await import("./utils/kv-cache");
    const kv = c.env.CACHE;
    const cacheStats = await getCacheStats(kv);

    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      cache: {
        type: getCacheType(kv),
        size: cacheStats.size,
        memory: cacheStats.memory,
        uptime: cacheStats.uptime,
      },
    });
  } catch (error: unknown) {
    console.error("Error getting health stats:", error);
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      cache: {
        type: "unknown",
        error: "Failed to get cache stats",
      },
    });
  }
});
app.route("/", readinessRoutes);

// Adding Partytown proxy route (publicly accessible, no authMiddleware)
app.route("/__ptproxy", partytownProxyRoutes);

// --- Protected API routes ---

// Webhook routes — NO auth middleware (signature verification IS the auth)
// Must be registered BEFORE the auth middleware block
app.use("/webhooks/*", webhookBodyLimitMiddleware);
app.route("/webhooks/stripe", stripeWebhookRoutes);
app.route("/webhooks/sslcommerz", sslcommerzWebhookRoutes);
app.route("/webhooks/polar", polarWebhookRoutes);
app.route("/webhooks/pathao", pathaoWebhookRoutes);
app.route("/webhooks/steadfast", steadfastWebhookRoutes);

// Apply protection only to paths needing it. The storefront order router is
// public but proof/origin guarded: checkout create/cart-validation/status/receipt
// must stay reachable without a bearer token.
app.use("/cache/*", cookieOriginGuardMiddleware);
app.use("/cache/*", adminAuthMiddleware);
app.use("/orders/*", cookieOriginGuardMiddleware);

// Register routes (mix of public and protected)
app.route("/products", productRoutes);
app.route("/categories", categoryRoutes);
app.route("/cache", cacheControlRoutes);
app.route("/orders", orderRoutes);

// ==========================================
// ADMIN API ROUTES
// ==========================================
// The /admin/* routes are strictly protected by adminAuthMiddleware.
// It verifies an active Better Auth dashboard session; scanner cookies are
// limited to exact scanner workflow endpoints inside the middleware.
app.use("/admin/*", cookieOriginGuardMiddleware);
app.use("/admin/*", adminAuthMiddleware);

// Register Admin routes
app.route("/admin/categories", adminCategoryRoutes);
app.route("/admin/collections", adminCollectionRoutes);
app.route("/admin/customers", adminCustomerRoutes);
app.route("/admin/pages", adminPageRoutes);
app.route("/admin/discounts", adminDiscountRoutes);
app.route("/admin/promotions", adminPromotionRoutes);
app.route("/admin/media", adminMediaRoutes);
app.route("/admin/inventory", adminInventoryRoutes);
app.route("/admin/navigation", adminNavigationRoutes);
app.route("/admin/search", adminSearchRoutes);
app.route("/admin/shipments", adminShipmentRoutes);
app.route("/admin/analytics", adminAnalyticsRoutes);
app.route("/admin/dashboard", adminDashboardRoutes);
app.route("/admin/fraud-checker", adminFraudCheckerRoutes);
app.route("/admin/rbac", adminRbacRoutes);
app.route("/admin/settings", adminSettingsRoutes);
app.route("/admin/orders", adminOrdersRoutes);
app.route("/admin/products", adminProductsRoutes);
app.route("/admin/auth", adminAuthManagementRoutes);
app.route("/admin/attributes", adminAttributesRoutes);
app.route("/admin/taxes", adminTaxRoutes);
app.route("/admin/agent-access", adminAgentAccessRoutes);
app.route("/admin", adminSystemUtilsRoutes);
app.route("/admin/settings/delivery-locations", adminLocationRoutes);
app.route("/admin/settings/checkout-languages", checkoutLanguageRoutes);
app.route("/admin/settings/abandoned-checkouts", abandonedCheckoutsRoutes);

// Setup routes - bypassing normal auth rules, used only during initial deployment
app.route("/setup", authSetupRoutes);

// Payment routes — session/intent creation is public (storefront)
app.route("/payment/stripe", stripePaymentRoutes);
app.route("/payment/sslcommerz", sslcommerzPaymentRoutes);
app.route("/payment/polar", polarPaymentRoutes);

// Add Swagger UI documentation (relative path '/docs')
// Swagger URL needs full path as it's resolved by browser/Swagger tool
app.get("/docs", swaggerUI({ url: "/api/v1/openapi.json" }));

// Add OpenAPI specification
app.get("/openapi.json", (c) => {
  c.header("Cache-Control", "public, max-age=0, must-revalidate");
  c.header("ETag", OPENAPI_CONTRACT_ETAG);
  if (c.req.header("If-None-Match") === OPENAPI_CONTRACT_ETAG) {
    return c.body(null, 304);
  }
  return c.body(OPENAPI_CONTRACT_JSON, 200, {
    "Content-Type": "application/json; charset=UTF-8",
  });
});

// Register the security scheme for the OpenAPI spec
app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

// Export the main app
export type AppType = typeof app;
export default app;
