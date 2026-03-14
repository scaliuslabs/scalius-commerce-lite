import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "@scalius/database/client";
import { siteSettings } from "@scalius/database/schema";
import { cacheMiddleware } from "../middleware/cache";
import { NotFoundError } from "../utils/api-error";

import { ok } from "../utils/api-response";
// Create an OpenAPIHono app for footer routes
const app = new OpenAPIHono();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: 3600,
    keyPrefix: "api:footer:",
    varyByQuery: false,
    methods: ["GET"]
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
    links: Array<{ id?: string; title: string; href?: string }>;
  }>;
  social: SocialLink[];
  description: string;
}

// GET /footer — get footer data
const getFooterRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Footer"],
  summary: "Get footer configuration data",
  responses: {
    200: {
      description: "Footer configuration"
    },
    404: {
      description: "Footer configuration not found"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(getFooterRoute, async (c) => {
  // Get footer config from database
  const [settings] = await db.select().from(siteSettings).limit(1);

  if (!settings) {
    throw new NotFoundError("Footer configuration not found");
  }

  // Parse footer config
  const footerConfig = settings.footerConfig
    ? JSON.parse(settings.footerConfig)
    : null;

  if (!footerConfig) {
    return c.json(
      {
        error: "Invalid footer configuration",
        success: false as const
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
    description: footerConfig.description || ""
  };

  return ok(c, footerData);
});

// Export the footer routes
export { app as footerRoutes };
