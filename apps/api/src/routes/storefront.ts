// src/server/routes/storefront.ts
// Storefront API — thin HTTP layer.
// All query logic lives in src/modules/storefront/storefront.service.ts.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import { getHomepageData, getLayoutData } from "@scalius/core/modules/storefront/storefront.service";

import { ok } from "../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

// GET /storefront/homepage — consolidated homepage data
const homepageRoute = createRoute({
  method: "get",
  path: "/homepage",
  tags: ["Storefront"],
  summary: "Get consolidated homepage data (SEO, hero, widgets, collections + products)",
  responses: {
    200: {
      description: "Homepage data"
    },
    500: {
      description: "Server error"
    }
  }
});

app.use(
  "/homepage",
  cacheMiddleware({ ttl: 3600000, keyPrefix: "api:storefront:homepage:", varyByQuery: false, methods: ["GET"] }),
);

app.openapi(homepageRoute, async (c) => {
  const db = c.get("db");
  const data = await getHomepageData(db);
  return ok(c, { success: true as const, data });
});

// GET /storefront/layout — consolidated layout data
const layoutRoute = createRoute({
  method: "get",
  path: "/layout",
  tags: ["Storefront"],
  summary: "Get consolidated layout data (analytics, header, navigation, footer, currency, theme)",
  responses: {
    200: {
      description: "Layout data"
    },
    500: {
      description: "Server error"
    }
  }
});

app.use(
  "/layout",
  cacheMiddleware({ ttl: 3600000, keyPrefix: "api:storefront:layout:", varyByQuery: false, methods: ["GET"] }),
);

app.openapi(layoutRoute, async (c) => {
  const db = c.get("db");
  const data = await getLayoutData(db);
  return ok(c, { success: true as const, data });
});

// GET /storefront/csp — returns merchant-configured CSP allowed domains
const cspRoute = createRoute({
  method: "get",
  path: "/csp",
  tags: ["Storefront"],
  summary: "Get CSP allowed domains configuration",
  responses: {
    200: {
      description: "CSP configuration"
    },
    500: {
      description: "Server error"
    }
  }
});

app.use(
  "/csp",
  cacheMiddleware({ ttl: 3600000, keyPrefix: "api:storefront:csp:", varyByQuery: false, methods: ["GET"] }),
);

app.openapi(cspRoute, async (c) => {
  const db = c.get("db");
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.key, "csp_allowed_domains"), eq(settings.category, "security")))
    .get();
  return ok(c, { success: true as const, cspAllowedDomains: row?.value || "" });
});

export { app as storefrontRoutes };
