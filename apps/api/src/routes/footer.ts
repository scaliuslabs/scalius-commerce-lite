import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { siteSettings } from "@scalius/database/schema";
import { cacheMiddleware } from "../middleware/cache";
import { CACHE_TTLS } from "../utils/cache-ttls";
import { NotFoundError, ValidationError } from "../utils/api-error";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
// Create an OpenAPIHono app for footer routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
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
      description: "Footer configuration",
      content: { "application/json": { schema: successEnvelope(z.object({
        logo: z.object({ src: z.string(), alt: z.string() }),
        tagline: z.string(),
        copyrightText: z.string(),
        menus: z.array(z.object({
          id: z.string(),
          title: z.string(),
          links: z.array(z.object({ id: z.string().optional(), title: z.string(), href: z.string().optional() })),
        })),
        social: z.array(z.object({
          id: z.string().optional(),
          platform: z.string(),
          url: z.string().optional(),
          icon: z.string().optional(),
        })),
        description: z.string(),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getFooterRoute, async (c) => {
  const db = c.get("db");
  // Get footer config from database
  const [settings] = await db.select().from(siteSettings).limit(1);

  if (!settings) {
    throw new NotFoundError("Footer configuration not found");
  }

  // Parse footer config
  const footerConfig: Partial<FooterData> | null = (() => {
    try {
      return settings.footerConfig
        ? (JSON.parse(settings.footerConfig) as Partial<FooterData>)
        : null;
    } catch {
      return null;
    }
  })();

  if (!footerConfig) {
    throw new ValidationError("Invalid footer configuration");
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
