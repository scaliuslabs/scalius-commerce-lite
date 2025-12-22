import { Hono } from "hono";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { cacheMiddleware } from "../middleware/cache";

// Create a Hono app for footer routes
const app = new Hono();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    // Increased TTL to 1 hour (3600s).
    // This allows browser/CDN caching (max-age=300) and reduces Redis/DB load.
    ttl: 3600,
    keyPrefix: "api:footer:",
    varyByQuery: false,
    methods: ["GET"],
  }),
);

// Footer data interface, strictly matching Admin schema
interface SocialLink {
  id?: string;
  platform: string;
  url?: string;
  icon?: string;
}

interface FooterData {
  logo: {
    src: string;
    alt: string;
  };
  tagline: string;
  copyrightText: string;
  menus: Array<{
    id: string;
    title: string;
    links: Array<any>;
  }>;
  social: SocialLink[];
  description: string;
}

// Get footer data
app.get("/", async (c) => {
  try {
    // Get footer config from database
    const [settings] = await db.select().from(siteSettings).limit(1);

    if (!settings) {
      return c.json(
        {
          error: "Footer configuration not found",
          success: false,
        },
        404,
      );
    }

    // Parse footer config
    const footerConfig = settings.footerConfig
      ? JSON.parse(settings.footerConfig)
      : null;

    if (!footerConfig) {
      return c.json(
        {
          error: "Invalid footer configuration",
          success: false,
        },
        500,
      );
    }

    // Strict array usage for social links
    const socialLinks: SocialLink[] = Array.isArray(footerConfig.social)
      ? footerConfig.social
      : [];

    // Build response data
    const footerData: FooterData = {
      logo: footerConfig.logo || { src: "/logo.svg", alt: "Store Logo" },
      tagline: footerConfig.tagline || "",
      copyrightText:
        footerConfig.copyrightText || settings.siteName || "Your Store",
      menus: footerConfig.menus || [],
      social: socialLinks,
      description: footerConfig.description || "",
    };

    return c.json({
      data: footerData,
      success: true,
    });
  } catch (error) {
    console.error("Error fetching footer data:", error);

    return c.json(
      {
        error: "Failed to fetch footer data",
        message: error instanceof Error ? error.message : "Unknown error",
        success: false,
      },
      500,
    );
  }
});

// Export the footer routes
export { app as footerRoutes };
