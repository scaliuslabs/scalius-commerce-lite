// src/server/index.ts

import { Hono } from "hono";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
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
import { authMiddleware } from "./middleware/auth";
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
import { openApiSpec } from "./openapi";
import { getCorsOriginFunction } from "../lib/cors-helper";

// Create typed Hono app with Cloudflare Workers Env bindings
const app = new Hono<{ Bindings: Env }>();

// Response compression middleware - compress JSON/text responses with gzip
app.use("*", compress());

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

app.use(
  "*",
  cors({
    origin: getCorsOriginFunction(),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowHeaders: ["Content-Type", "Authorization", "X-API-Token", "Accept"],
    exposeHeaders: ["Content-Type", "Cache-Control"],
    credentials: true,
  }),
);

app.use("*", async (c, next) => {
  // Use PUBLIC_API_BASE_URL environment variable, fallback to request origin
  const baseUrl = process.env.PUBLIC_API_BASE_URL || new URL(c.req.url).origin;

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
app.route("/locations", locationRoutes);
app.route("/shipping-methods", shippingMethodRoutes);
app.route("/seo", seoRoutes);
app.route("/checkout-languages", checkoutLanguageRoutes);
app.route("/abandoned-checkouts", abandonedCheckoutsRoutes);
app.route("/meta", metaConversionsRoutes); // Register the new route
app.route("/storefront", storefrontRoutes); // Consolidated homepage/layout endpoints

// Add health check endpoint (relative path '/health')
app.get("/health", async (c) => {
  try {
    // Get cache stats
    const { getCacheStats, isRedisAvailable, getCacheType } = await import(
      "./utils/redis"
    );
    const cacheStats = await getCacheStats();

    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || "1.0.0",
      environment: process.env.NODE_ENV || "development",
      uptime: process.uptime(),
      cache: {
        type: getCacheType(),
        redisAvailable: isRedisAvailable(),
        size: cacheStats.size,
        memory: cacheStats.memory,
        hitRate: cacheStats.hitRate,
        missRate: cacheStats.missRate,
        uptime: cacheStats.uptime,
      },
    });
  } catch (error) {
    console.error("Error getting health stats:", error);
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || "1.0.0",
      environment: process.env.NODE_ENV || "development",
      uptime: process.uptime(),
      cache: {
        type: "unknown",
        redisAvailable: false,
        error: "Failed to get cache stats",
      },
    });
  }
});

// Adding Partytown proxy route (publicly accessible, no authMiddleware)
app.route("/__ptproxy", partytownProxyRoutes);

// --- Protected API routes ---

// Apply auth middleware ONLY to paths needing protection
// Paths are relative (prefix already stripped by astro-handler)
app.use("/cache/*", authMiddleware);
app.use("/orders/*", authMiddleware);

// Register routes (mix of public and protected)
app.route("/products", productRoutes);
app.route("/categories", categoryRoutes); // Categories are now public (category listing and products)
app.route("/cache", cacheControlRoutes);
app.route("/orders", orderRoutes);

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
