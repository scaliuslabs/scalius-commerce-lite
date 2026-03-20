import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { categories, pages, siteSettings } from "@scalius/database/schema";
import { sql, isNull } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import { NotFoundError } from "../utils/api-error";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
// Create an OpenAPIHono app for navigation routes
const app = new OpenAPIHono();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: 3600,
    keyPrefix: "api:navigation:",
    varyByQuery: true,
    methods: ["GET"]
  }),
);

// Navigation item interface
interface NavigationItem {
  title: string;
  href: string;
  subMenu?: NavigationItem[];
}

// Helper to recursively map categories to navigation items
function mapCategoriesToNavigation(categoriesData: Array<{ name: string; slug: string }>): NavigationItem[] {
  return categoriesData.map((cat) => ({
    title: cat.name,
    href: `/categories/${cat.slug}`
  }));
}

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
        navigation: z.record(z.string(), z.any()),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getNavigationRoute, async (c) => {
  const db = c.get("db");
  const { type } = c.req.valid("query");

  // Get site settings from database
  const [settings] = await db.select().from(siteSettings).limit(1);

  if (!settings) {
    throw new NotFoundError("Site settings not found");
  }

  // Extract navigation configuration based on type
  let navigationConfig: Record<string, unknown> | null = null;

  if (type === "header" || type === "all") {
    const headerConfig = settings.headerConfig
      ? JSON.parse(settings.headerConfig)
      : null;

    if (headerConfig && headerConfig.navigation) {
      navigationConfig = {
        ...(navigationConfig ?? {}),
        header: headerConfig.navigation
      };
    }
  }

  if (type === "footer" || type === "all") {
    const footerConfig = settings.footerConfig
      ? JSON.parse(settings.footerConfig)
      : null;

    if (footerConfig && footerConfig.menus) {
      navigationConfig = {
        ...(navigationConfig ?? {}),
        footer: footerConfig.menus
      };
    }
  }

  // If no navigation config found, try to create a default one from categories and pages
  if (!navigationConfig || (type === "all" && !navigationConfig.header)) {
    const categoriesData = await db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug
      })
      .from(categories)
      .where(isNull(categories.deletedAt))
      .orderBy(categories.name);

    const pagesData = await db
      .select({
        id: pages.id,
        title: pages.title,
        slug: pages.slug,
        isPublished: pages.isPublished
      })
      .from(pages)
      .where(sql`${pages.deletedAt} IS NULL AND ${pages.isPublished} = true`)
      .orderBy(pages.title);

    const defaultNavigation: NavigationItem[] = [
      {
        title: "Home",
        href: "/"
      },
    ];

    if (categoriesData.length > 0) {
      defaultNavigation.push({
        title: "Categories",
        href: "#",
        subMenu: mapCategoriesToNavigation(categoriesData)
      });
    }

    pagesData.forEach((page) => {
      defaultNavigation.push({
        title: page.title,
        href: `/${page.slug}`
      });
    });

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
          items: z.array(z.any()),
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

  // Get site settings from database
  const [settings] = await db.select().from(siteSettings).limit(1);

  if (!settings) {
    throw new NotFoundError("Site settings not found");
  }

  // Parse header and footer config
  const headerConfig = settings.headerConfig
    ? JSON.parse(settings.headerConfig)
    : null;
  const footerConfig = settings.footerConfig
    ? JSON.parse(settings.footerConfig)
    : null;

  // Try to find the navigation menu with the given ID
  let menu = null;

  // Check header navigation first
  if (headerConfig && headerConfig.navigation) {
    if (id === "header") {
      menu = {
        id: "header",
        name: "Header Navigation",
        items: headerConfig.navigation
      };
    }
  }

  // Check footer menus if not found in header
  if (!menu && footerConfig && footerConfig.menus) {
    if (id === "footer") {
      menu = {
        id: "footer",
        name: "Footer Navigation",
        items: footerConfig.menus
      };
    } else {
      const footerMenu = footerConfig.menus.find(
        (m: { id?: string; title?: string }) => m.id === id || m.title === id,
      );

      if (footerMenu) {
        menu = {
          id: footerMenu.id || id,
          name: footerMenu.title,
          items: footerMenu.links || []
        };
      }
    }
  }

  if (!menu) {
    throw new NotFoundError(`Navigation menu with ID '${id}' not found`);
  }

  return ok(c, { menu });
});

// Export the navigation routes
export { app as navigationRoutes };
