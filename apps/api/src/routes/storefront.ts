// src/server/routes/storefront.ts
// Storefront API — thin HTTP layer.
// All query logic lives in src/modules/storefront/storefront.service.ts.

import { Hono } from "hono";
import { settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import { getHomepageData, getLayoutData } from "@scalius/core/modules/storefront/storefront.service";

const app = new Hono<{ Bindings: Env }>();

// ── GET /storefront/homepage ──────────────────────────────────────────────────
// Consolidated homepage data: SEO, hero, widgets, collections + products.
// Reduces 4 + N API calls to 1 batched response.
app.get(
  "/homepage",
  cacheMiddleware({ ttl: 3600000, keyPrefix: "api:storefront:homepage:", varyByQuery: false, methods: ["GET"] }),
  async (c) => {
    try {
      const db = c.get("db");
      const data = await getHomepageData(db);
      return c.json({ success: true, data });
    } catch (error) {
      console.error("Error fetching homepage data:", error);
      return c.json({ success: false, error: "Failed to fetch homepage data", message: error instanceof Error ? error.message : "Unknown error" }, 500);
    }
  },
);

// ── GET /storefront/layout ────────────────────────────────────────────────────
// Consolidated layout data: analytics, header, navigation, footer, currency, theme.
// Reduces 4 API calls to 1 batched response.
app.get(
  "/layout",
  cacheMiddleware({ ttl: 3600000, keyPrefix: "api:storefront:layout:", varyByQuery: false, methods: ["GET"] }),
  async (c) => {
    try {
      const db = c.get("db");
      const data = await getLayoutData(db);
      return c.json({ success: true, data });
    } catch (error) {
      console.error("Error fetching layout data:", error);
      return c.json({ success: false, error: "Failed to fetch layout data", message: error instanceof Error ? error.message : "Unknown error" }, 500);
    }
  },
);

// ── GET /storefront/csp ───────────────────────────────────────────────────────
// Returns the merchant-configured CSP allowed domains.
// Stays inline — it's a single query with no shaping logic.
app.get(
  "/csp",
  cacheMiddleware({ ttl: 3600000, keyPrefix: "api:storefront:csp:", varyByQuery: false, methods: ["GET"] }),
  async (c) => {
    try {
      const db = c.get("db");
      const row = await db
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.key, "csp_allowed_domains"), eq(settings.category, "security")))
        .get();
      return c.json({ success: true, cspAllowedDomains: row?.value || "" });
    } catch (error) {
      console.error("Error fetching CSP settings:", error);
      return c.json({ success: false, error: "Failed to fetch CSP settings" }, 500);
    }
  },
);

export { app as storefrontRoutes };
