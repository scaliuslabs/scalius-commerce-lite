// src/server/index.ts

import { Hono } from "hono";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import { getDb } from "@/db";
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
import { orderRoutes } from "./routes/orders";
import { stripePaymentRoutes } from "./routes/payment/stripe-routes";
import { sslcommerzPaymentRoutes } from "./routes/payment/sslcommerz-routes";
import { polarPaymentRoutes } from "./routes/payment/polar-routes";
import { stripeWebhookRoutes } from "./routes/webhooks/stripe";
import { sslcommerzWebhookRoutes } from "./routes/webhooks/sslcommerz";
import { polarWebhookRoutes } from "./routes/webhooks/polar";
import { pathaoWebhookRoutes } from "./routes/webhooks/pathao";
import { steadfastWebhookRoutes } from "./routes/webhooks/steadfast";
import { authMiddleware } from "./middleware/auth";
import { adminAuthMiddleware } from "./middleware/admin-auth";
import { locationRoutes } from "./routes/locations";
import { discountRoutes } from "./routes/discounts";
import { widgetRoutes } from "./routes/widgets";
import { analyticsRoutes } from "./routes/analytics";
import { partytownProxyRoutes } from "./routes/partytown-proxy";
import { shippingMethodRoutes } from "./routes/shipping-methods";
import { seoRoutes } from "./routes/seo";
import { checkoutLanguageRoutes } from "./routes/checkout-languages";
import { abandonedCheckoutsRoutes } from "./routes/abandoned-checkouts";
import { metaConversionsRoutes } from "./routes/meta-conversions";
import { storefrontRoutes } from "./routes/storefront";
import { checkoutRoutes } from "./routes/checkout";
import { customerAuthRoutes } from "./routes/customer-auth";
import { openApiSpec } from "./openapi";
import { getCorsOriginContext } from "@/shared/cors-helper";

// Admin routes
import { adminCategoryRoutes } from "./routes/admin/categories";
import { adminCollectionRoutes } from "./routes/admin/collections";
import { adminCustomerRoutes } from "./routes/admin/customers";
import { adminPageRoutes } from "./routes/admin/pages";
import { adminWidgetRoutes } from "./routes/admin/widgets";
import { adminDiscountRoutes } from "./routes/admin/discounts";
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
import { adminAuthManagementRoutes, authSetupRoutes } from "./routes/admin/auth-management";
import { adminAiContextRoutes } from "./routes/admin/ai-context";
import { adminAiPromptsRoutes } from "./routes/admin/ai-prompts";
import { adminOpenRouterRoutes } from "./routes/admin/openrouter";
import { adminAttributesRoutes } from "./routes/admin/attributes";
import { adminSystemUtilsRoutes } from "./routes/admin/system-utils";

// Create typed Hono app with Cloudflare Workers Env bindings
const app = new Hono<{ Bindings: Env }>();

// NOTE: Do NOT add compress() middleware here. Cloudflare Workers handles
// compression at the edge automatically. Application-level compression
// breaks the cache middleware (compressed body stored as garbled text).

// Database injection middleware
// Creates per-request database connection using CF Workers env
app.use("*", async (c, next) => {
  const db = getDb(c.env);
  c.set("db", db);
  await next();
});

app.use("*", async (c, next) => {
  const origin = c.req.header("Origin");
  const method = c.req.method;
  if (origin && method === "OPTIONS") {
    console.log(`[CORS] Preflight request from origin: ${origin}`);
  }
  await next();
});

app.use("*", async (c, next) => {
  const corsMiddleware = cors({
    origin: await getCorsOriginContext(c),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowHeaders: ["Content-Type", "Authorization", "X-API-Token", "Accept"],
    exposeHeaders: ["Content-Type", "Cache-Control"],
    credentials: true,
  });
  return corsMiddleware(c, next);
});

app.use("*", async (c, next) => {
  // Use PUBLIC_API_BASE_URL from CF Workers env binding, fallback to request origin
  const baseUrl = (c.env.PUBLIC_API_BASE_URL || new URL(c.req.url).origin).trim();

  c.header("X-Proxy-Base-URL", `${baseUrl}/api/v1`);
  await next();
});

// Error handling middleware
app.use("*", async (c, next) => {
  try {
    await next();
  } catch (error) {
    console.error("API Error:", error);

    if (error instanceof Error) {
      return c.json(
        {
          success: false,
          error: error.message,
          stack:
            process.env.NODE_ENV === "development" ? error.stack : undefined,
        },
        500,
      );
    }

    return c.json(
      {
        success: false,
        error: "Internal Server Error",
      },
      500,
    );
  }
});

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

// Public API routes (no auth required)
// Mount directly on app, paths are relative
app.route("/auth", authRoutes);
app.route("/attributes", attributeRoutes);
app.route("/collections", collectionRoutes);
app.route("/hero", heroRoutes);
app.route("/search", searchRoutes);
app.route("/header", headerRoutes);
app.route("/navigation", navigationRoutes);
app.route("/footer", footerRoutes);
app.route("/pages", pagesRoutes);
app.route("/discounts", discountRoutes);
app.route("/widgets", widgetRoutes);
app.route("/analytics", analyticsRoutes);
app.route("/meta", metaConversionsRoutes);
app.route("/storefront", storefrontRoutes);
app.route("/checkout", checkoutRoutes);
app.route("/customer-auth", customerAuthRoutes);

// Add health check endpoint (relative path '/health')
app.get("/health", async (c) => {
  try {
    const { getCacheStats, getCacheType } = await import("./utils/kv-cache");
    const kv: KVNamespace | undefined = (c.env as any)?.CACHE;
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
  } catch (error) {
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

// Adding Partytown proxy route (publicly accessible, no authMiddleware)
app.route("/__ptproxy", partytownProxyRoutes);

// --- Protected API routes ---

// Webhook routes — NO auth middleware (signature verification IS the auth)
// Must be registered BEFORE the auth middleware block
app.route("/webhooks/stripe", stripeWebhookRoutes);
app.route("/webhooks/sslcommerz", sslcommerzWebhookRoutes);
app.route("/webhooks/polar", polarWebhookRoutes);
app.route("/webhooks/pathao", pathaoWebhookRoutes);
app.route("/webhooks/steadfast", steadfastWebhookRoutes);

// Apply auth middleware ONLY to paths needing protection
// Paths are relative (prefix already stripped by astro-handler)
app.use("/cache/*", adminAuthMiddleware);
app.use("/orders/*", authMiddleware);

// Register routes (mix of public and protected)
app.route("/products", productRoutes);
app.route("/categories", categoryRoutes);
app.route("/cache", cacheControlRoutes);
app.route("/orders", orderRoutes);

// --- Admin System ---
// The /admin/* routes are strictly protected by adminAuthMiddleware.
// It verifies either a Better Auth session (Astro SSR) or a JWT Bearer token (Decoupled Hono).
app.use("/admin/*", adminAuthMiddleware);

// Register Admin routes
app.route("/admin/categories", adminCategoryRoutes);
app.route("/admin/collections", adminCollectionRoutes);
app.route("/admin/customers", adminCustomerRoutes);
app.route("/admin/pages", adminPageRoutes);
app.route("/admin/widgets", adminWidgetRoutes);
app.route("/admin/discounts", adminDiscountRoutes);
app.route("/admin/media", adminMediaRoutes);
app.route("/admin/inventory", adminInventoryRoutes);
app.route("/admin/navigation", adminNavigationRoutes);
app.route("/admin/search", adminSearchRoutes);
app.route("/admin/shipments", adminShipmentRoutes);
app.route("/admin/analytics", adminAnalyticsRoutes);
app.route("/admin/fraud-checker", adminFraudCheckerRoutes);
app.route("/admin/rbac", adminRbacRoutes);
app.route("/admin/settings", adminSettingsRoutes);
app.route("/admin/orders", adminOrdersRoutes);
app.route("/admin/products", adminProductsRoutes);
app.route("/admin/auth", adminAuthManagementRoutes);
app.route("/admin/ai-context", adminAiContextRoutes);
app.route("/admin/ai-prompts", adminAiPromptsRoutes);
app.route("/admin/openrouter", adminOpenRouterRoutes);
app.route("/admin/attributes", adminAttributesRoutes);
// Mount system utils directly under /admin since they include /abandoned-checkouts and /fcm-token
app.route("/admin", adminSystemUtilsRoutes);
app.route("/admin/settings/delivery-locations", locationRoutes);
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

// Add OpenAPI specification (relative path '/openapi.json')
// OpenAPI server URL should still reflect the entry point
app.get("/openapi.json", (c) => {
  return c.json(openApiSpec);
});

// Export the main app
export default app;
