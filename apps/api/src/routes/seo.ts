import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { siteSettings } from "@scalius/database/schema";
import { cacheMiddleware } from "../middleware/cache";

// Create an OpenAPIHono app for SEO routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware
app.use(
  "*",
  cacheMiddleware({
    ttl: 0,
    keyPrefix: "api:seo:",
    methods: ["GET"],
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
      content: { "application/json": { schema: z.object({ siteTitle: z.string().nullable(), homepageTitle: z.string().nullable(), homepageMetaDescription: z.string().nullable(), robotsTxt: z.string().nullable(), success: z.literal(true) }) } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: z.object({ error: z.string(), success: z.literal(false) }) } },
    },
  },
});

app.openapi(getSeoSettingsRoute, async (c) => {
  const db = c.get("db");
  const [settings] = await db
    .select({
      siteTitle: siteSettings.siteTitle,
      homepageTitle: siteSettings.homepageTitle,
      homepageMetaDescription: siteSettings.homepageMetaDescription,
      robotsTxt: siteSettings.robotsTxt,
    })
    .from(siteSettings)
    .limit(1);

  if (!settings) {
    // Return default/empty values if no settings are found
    return c.json({
      siteTitle: "Scalius Commerce",
      homepageTitle: "Welcome to Scalius Commerce",
      homepageMetaDescription: "Your one-stop shop for everything amazing.",
      robotsTxt: "User-agent: *\nAllow: /",
      success: true as const,
    }, 200);
  }

  return c.json({
    ...settings,
    success: true as const,
  }, 200);
});

export { app as seoRoutes };
