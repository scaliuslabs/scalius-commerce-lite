import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { siteSettings } from "@scalius/database/schema";
import { cacheMiddleware } from "../middleware/cache";
import { CACHE_TTLS } from "../utils/cache-ttls";
import { NotFoundError, ValidationError } from "../utils/api-error";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
// Create an OpenAPIHono app for header routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
    keyPrefix: "api:header:",
    varyByQuery: false,
    methods: ["GET"]
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

// GET /header — get header data
const getHeaderRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Header"],
  summary: "Get header configuration data",
  responses: {
    200: {
      description: "Header configuration",
      content: { "application/json": { schema: successEnvelope(z.object({
        header: z.object({
          topBar: z.object({ text: z.string() }),
          logo: z.object({ src: z.string(), alt: z.string() }),
          favicon: z.object({ src: z.string(), alt: z.string() }).optional(),
          contact: z.object({ phone: z.string(), text: z.string() }),
          social: z.object({ facebook: z.string() }),
          cartTotal: z.string().optional(),
        }),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getHeaderRoute, async (c) => {
  const db = c.get("db");
  // Get header config from database
  const [settings] = await db.select().from(siteSettings).limit(1);

  if (!settings) {
    throw new NotFoundError("Header configuration not found");
  }

  // Parse header config
  const headerConfig: Partial<HeaderData> | null = (() => {
    try {
      return settings.headerConfig
        ? (JSON.parse(settings.headerConfig) as Partial<HeaderData>)
        : null;
    } catch {
      return null;
    }
  })();

  if (!headerConfig) {
    throw new ValidationError("Invalid header configuration");
  }

  // Build response data
  const headerData: HeaderData = {
    topBar: {
      text: headerConfig.topBar?.text || ""
    },
    logo: {
      src: headerConfig.logo?.src || "",
      alt: headerConfig.logo?.alt || "Store Logo"
    },
    favicon: headerConfig.favicon,
    contact: {
      phone: headerConfig.contact?.phone || "",
      text: headerConfig.contact?.text || ""
    },
    social: {
      facebook: headerConfig.social?.facebook || ""
    }
  };

  return ok(c, { header: headerData });
});

// Export the header routes
export { app as headerRoutes };
