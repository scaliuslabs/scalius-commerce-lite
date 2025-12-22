import { Hono } from "hono";
import { siteSettings } from "@/db/schema";
import { cacheMiddleware } from "../middleware/cache";

// Create a Hono app for SEO routes
const app = new Hono<{ Bindings: Env }>();

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

// Get SEO settings
app.get("/", async (c) => {
  try {
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
        siteTitle: "Scalius Commerce", // Default site title
        homepageTitle: "Welcome to Scalius Commerce", // Default homepage title
        homepageMetaDescription: "Your one-stop shop for everything amazing.", // Default meta description
        robotsTxt: "User-agent: *\nAllow: /", // Default robots.txt
        success: true, // Indicate success even with defaults
      });
    }

    return c.json({
      ...settings,
      success: true,
    });
  } catch (error) {
    console.error("Error fetching SEO settings:", error);
    return c.json(
      {
        error: "Failed to fetch SEO settings",
        message: error instanceof Error ? error.message : "Unknown error",
        success: false,
      },
      500,
    );
  }
});

export { app as seoRoutes };
