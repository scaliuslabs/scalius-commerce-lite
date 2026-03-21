import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { siteSettings } from "@scalius/database/schema";
import { cacheMiddleware } from "../middleware/cache";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { CACHE_TTLS } from "../utils/cache-ttls";
// Create an OpenAPIHono app for SEO routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware
app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
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
      description: "SEO settings",
      content: { "application/json": { schema: successEnvelope(z.object({
        siteTitle: z.string().nullable(),
        homepageTitle: z.string().nullable(),
        homepageMetaDescription: z.string().nullable(),
        robotsTxt: z.string().nullable(),
      })) } },
    },
    500: errorResponses[500],
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
