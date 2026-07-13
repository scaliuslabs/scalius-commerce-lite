import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getNavigationMenus } from "@scalius/core/modules/navigation";
import { cacheMiddleware } from "../middleware/cache";
import { CACHE_TTLS } from "../utils/cache-ttls";
import { NotFoundError } from "../utils/api-error";

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
  navigation: Array<{
    id: string;
    title: string;
    href?: string;
    subMenu?: unknown[];
  }>;
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
          navigation: z.array(z.object({
            id: z.string(),
            title: z.string(),
            href: z.string().optional(),
            subMenu: z.array(z.unknown()).optional(),
          })),
        }),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getHeaderRoute, async (c) => {
  const db = c.get("db");
  const { headerConfig } = await getNavigationMenus(db, "public");
  if (Object.keys(headerConfig).length === 0) {
    throw new NotFoundError("Header configuration not found");
  }
  const typedHeaderConfig = headerConfig as Partial<HeaderData>;

  // Build response data
  const headerData: HeaderData = {
    topBar: {
      text: typedHeaderConfig.topBar?.text || ""
    },
    logo: {
      src: typedHeaderConfig.logo?.src || "",
      alt: typedHeaderConfig.logo?.alt || "Store Logo"
    },
    favicon: typedHeaderConfig.favicon,
    contact: {
      phone: typedHeaderConfig.contact?.phone || "",
      text: typedHeaderConfig.contact?.text || ""
    },
    social: {
      facebook: typedHeaderConfig.social?.facebook || ""
    },
    navigation: Array.isArray(typedHeaderConfig.navigation)
      ? typedHeaderConfig.navigation
      : [],
  };

  return ok(c, { header: headerData });
});

// Export the header routes
export { app as headerRoutes };
