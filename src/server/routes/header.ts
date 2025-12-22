import { Hono } from "hono";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { cacheMiddleware } from "../middleware/cache";

// Create a Hono app for header routes
const app = new Hono();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    // Increased TTL to 1 hour (3600s).
    // This allows browser/CDN caching (max-age=300) and reduces Redis/DB load.
    ttl: 3600,
    keyPrefix: "api:header:",
    varyByQuery: false,
    methods: ["GET"],
  }),
);

// Header data interface
interface HeaderData {
  topBar: {
    text: string;
  };
  logo: {
    src: string;
    alt: string;
  };
  favicon?: {
    src: string;
    alt: string;
  };
  contact: {
    phone: string;
    text: string;
  };
  social: {
    facebook: string;
  };
  cartTotal?: string;
}

// Get header data
app.get("/", async (c) => {
  try {
    // Get header config from database
    const [settings] = await db.select().from(siteSettings).limit(1);

    if (!settings) {
      return c.json(
        {
          error: "Header configuration not found",
          success: false,
        },
        404,
      );
    }

    // Parse header config
    const headerConfig = settings.headerConfig
      ? JSON.parse(settings.headerConfig)
      : null;

    if (!headerConfig) {
      return c.json(
        {
          error: "Invalid header configuration",
          success: false,
        },
        500,
      );
    }

    // Build response data
    const headerData: HeaderData = {
      topBar: {
        text: headerConfig.topBar?.text || "",
      },
      logo: {
        src: headerConfig.logo?.src || "",
        alt: headerConfig.logo?.alt || "Store Logo",
      },
      favicon: headerConfig.favicon,
      contact: {
        phone: headerConfig.contact?.phone || "",
        text: headerConfig.contact?.text || "",
      },
      social: {
        facebook: headerConfig.social?.facebook || "",
      },
    };

    return c.json({
      header: headerData,
      success: true,
    });
  } catch (error) {
    console.error("Error fetching header data:", error);

    return c.json(
      {
        error: "Failed to fetch header data",
        message: error instanceof Error ? error.message : "Unknown error",
        success: false,
      },
      500,
    );
  }
});

// Export the header routes
export { app as headerRoutes };
