import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getNavigationMenus, getNavigationMenu, buildDefaultNavigation } from "@scalius/core/modules/navigation";
import { cacheMiddleware } from "../middleware/cache";
import { CACHE_TTLS } from "../utils/cache-ttls";
import { NotFoundError } from "../utils/api-error";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
    keyPrefix: "api:navigation:",
    varyByQuery: true,
    methods: ["GET"]
  }),
);

// GET /navigation — get navigation menu items
const getNavigationRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Navigation"],
  summary: "Get navigation menu items",
  request: {
    query: z.object({
      type: z.enum(["header", "footer", "all"]).optional().default("all").openapi({ description: "Navigation type" })
    })
  },
  responses: {
    200: {
      description: "Navigation data",
      content: { "application/json": { schema: successEnvelope(z.object({
        navigation: z.record(z.string(), z.unknown()),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getNavigationRoute, async (c) => {
  const db = c.get("db");
  const { type } = c.req.valid("query");

  const { headerConfig, footerConfig } = await getNavigationMenus(db);

  let navigationConfig: Record<string, unknown> | null = null;

  if (type === "header" || type === "all") {
    const header = headerConfig as Record<string, unknown> | null;
    if (header && header.navigation) {
      navigationConfig = {
        ...(navigationConfig ?? {}),
        header: header.navigation
      };
    }
  }

  if (type === "footer" || type === "all") {
    const footer = footerConfig as Record<string, unknown> | null;
    if (footer && footer.menus) {
      navigationConfig = {
        ...(navigationConfig ?? {}),
        footer: footer.menus
      };
    }
  }

  // If no navigation config found, build default from categories + pages
  if (!navigationConfig || (type === "all" && !navigationConfig.header)) {
    const defaultNavigation = await buildDefaultNavigation(db);

    if (!navigationConfig) {
      navigationConfig = {};
    }

    if (type === "header" || type === "all") {
      navigationConfig.header = navigationConfig.header || defaultNavigation;
    }
  }

  if (!navigationConfig) {
    throw new NotFoundError("Navigation configuration not found");
  }

  return ok(c, { navigation: navigationConfig });
});

// GET /navigation/:id — get navigation menu items by ID
const getNavigationByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Navigation"],
  summary: "Get navigation menu by ID",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Navigation menu data",
      content: { "application/json": { schema: successEnvelope(z.object({
        menu: z.object({
          id: z.string(),
          name: z.string(),
          items: z.array(z.object({ id: z.string(), label: z.string(), url: z.string().nullable(), sortOrder: z.number() }).passthrough()),
        }),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getNavigationByIdRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const menu = await getNavigationMenu(db, id);
  if (!menu) {
    throw new NotFoundError(`Navigation menu with ID '${id}' not found`);
  }

  return ok(c, { menu });
});

// Export the navigation routes
export { app as navigationRoutes };
