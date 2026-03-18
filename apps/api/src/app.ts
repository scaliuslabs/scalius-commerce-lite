// src/server/index.ts

import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import { getDb } from "@scalius/database/client";
import { initKv } from "./utils/kv-cache";
import { initStorage } from "@scalius/core/integrations/storage";
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
import { discountRoutes } from "./routes/discounts";
import { widgetRoutes } from "./routes/widgets";
import { analyticsRoutes } from "./routes/analytics";
import { partytownProxyRoutes } from "./routes/partytown-proxy";
import { checkoutLanguageRoutes } from "./routes/checkout-languages";
import { abandonedCheckoutsRoutes } from "./routes/abandoned-checkouts";
import { locationRoutes } from "./routes/locations";
import { shippingMethodRoutes } from "./routes/shipping-methods";
import { seoRoutes } from "./routes/seo";
import { metaConversionsRoutes } from "./routes/meta-conversions";
import { storefrontRoutes } from "./routes/storefront";
import { checkoutRoutes } from "./routes/checkout";
import { customerAuthRoutes } from "./routes/customer-auth";
import { ApiError } from "./utils/api-error";
import { serveMediaRoute } from "./routes/media-server";
import { getCorsOriginContext } from "@scalius/shared/cors-helper";

// Admin routes
import { adminAuthMiddleware } from "./middleware/admin-auth";
import { adminLocationRoutes } from "./routes/admin/settings/delivery-locations";
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
import { adminDashboardRoutes } from "./routes/admin/dashboard";
import { adminSystemUtilsRoutes } from "./routes/admin/system-utils";

// Create typed OpenAPIHono app with Cloudflare Workers Env bindings
// basePath("/api/v1") — standalone worker receives full URLs (e.g. /api/v1/products)
const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

// NOTE: Do NOT add compress() middleware here. Cloudflare Workers handles
// compression at the edge automatically. Application-level compression
// breaks the cache middleware (compressed body stored as garbled text).

// Per-request initialisation: DB, KV cache, R2 storage
app.use("*", async (c, next) => {
  const db = getDb(c.env);
  c.set("db", db);
  if (c.env.CACHE) initKv(c.env.CACHE);
  if (c.env.BUCKET) {
    initStorage(c.env.BUCKET, (c.env.R2_PUBLIC_URL as string) || "");
  }
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
  } catch (error: unknown) {
    console.error("API Error:", error);

    if (error instanceof ApiError) {
      return c.json(
        {
          success: false,
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        },
        error.status as 400 | 401 | 403 | 404 | 409 | 422 | 500,
      );
    }

    if (error instanceof Error) {
      return c.json(
        {
          success: false,
          error: {
            code: "INTERNAL_ERROR",
            message: error.message,
            ...(process.env.NODE_ENV === "development" && { stack: error.stack }),
          },
        },
        500,
      );
    }

    return c.json(
      {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal Server Error",
        },
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

// ==========================================
// STOREFRONT API ROUTES
// ==========================================
// Public Storefront routes (no auth required)
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
app.route("/checkout-languages", checkoutLanguageRoutes);
app.route("/abandoned-checkouts", abandonedCheckoutsRoutes);
app.route("/locations", locationRoutes);
app.route("/shipping-methods", shippingMethodRoutes);
// SEO settings — used by storefront product/page routes for meta tags
app.route("/seo", seoRoutes);
// Local development media server route
if (process.env.NODE_ENV === "development") {
  app.route("/media", serveMediaRoute);
}// Add health check endpoint (relative path '/health')
app.get("/health", async (c) => {
  try {
    const { getCacheStats, getCacheType } = await import("./utils/kv-cache");
    const kv: KVNamespace | undefined = c.env?.CACHE;
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
app.use("/cache/*", adminAuthMiddleware);
app.use("/orders/*", authMiddleware);

// Register routes (mix of public and protected)
app.route("/products", productRoutes);
app.route("/categories", categoryRoutes);
app.route("/cache", cacheControlRoutes);
app.route("/orders", orderRoutes);

// ==========================================
// ADMIN API ROUTES
// ==========================================
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
app.route("/admin/dashboard", adminDashboardRoutes);
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
  try {
    const spec = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: {
        title: "Scalius Commerce API",
        version: "1.0.0",
        description:
          "E-commerce platform API powering admin dashboard and storefront",
      },
      servers: [{ url: "/", description: "Default" }],
    });
    return c.json(spec);
  } catch (error: unknown) {
    console.error("OpenAPI spec generation error:", error);
    throw error;
  }
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
