import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { siteSettings } from "@scalius/database/schema";
import { cacheMiddleware } from "../middleware/cache";

import { ok } from "../utils/api-response";
// Create an OpenAPIHono app for SEO routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware
app.use(
  "*",
  cacheMiddleware({
    ttl: 0,
    keyPrefix: "api:seo:",
    methods: ["GET"]
  }),
);

export interface SeoSettingsData {
  siteTitle: string | null;
  homepageTitle: string | null;
  homepageMetaDescription: string | null;
  robotsTxt: string | null;
}

// GET /seo — get SEO settings
const getSeoSettingsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["SEO"],
  summary: "Get SEO settings",
  responses: {
    200: {
      description: "SEO settings"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(getSeoSettingsRoute, async (c) => {
  const db = c.get("db");
  const [settings] = await db
    .select({
      siteTitle: siteSettings.siteTitle,
      homepageTitle: siteSettings.homepageTitle,
      homepageMetaDescription: siteSettings.homepageMetaDescription,
      robotsTxt: siteSettings.robotsTxt
    })
    .from(siteSettings)
    .limit(1);

  if (!settings) {
    // Return default/empty values if no settings are found
    return ok(c, {
      siteTitle: "Scalius Commerce",
      homepageTitle: "Welcome to Scalius Commerce",
      homepageMetaDescription: "Your one-stop shop for everything amazing.",
      robotsTxt: "User-agent: *\nAllow: /",
    });
  }

  return ok(c, {
    ...settings,
  });
});

export { app as seoRoutes };
