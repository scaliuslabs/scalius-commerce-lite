import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "@scalius/database/client";
import { siteSettings } from "@scalius/database/schema";
import { cacheMiddleware } from "../middleware/cache";
import { NotFoundError } from "../utils/api-error";

import { ok } from "../utils/api-response";
// Create an OpenAPIHono app for header routes
const app = new OpenAPIHono();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: 3600,
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
      description: "Header configuration"
    },
    404: {
      description: "Header configuration not found"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(getHeaderRoute, async (c) => {
  // Get header config from database
  const [settings] = await db.select().from(siteSettings).limit(1);

  if (!settings) {
    throw new NotFoundError("Header configuration not found");
  }

  // Parse header config
  const headerConfig = settings.headerConfig
    ? JSON.parse(settings.headerConfig)
    : null;

  if (!headerConfig) {
    return c.json(
      {
        error: "Invalid header configuration",
        success: false as const
      },
      500,
    );
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
