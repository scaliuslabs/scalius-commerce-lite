import { Hono } from "hono";
import { z } from "zod";
import { db } from "@/db";
import { categories, pages, siteSettings } from "@/db/schema";
import { sql, isNull } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";

// Create a Hono app for navigation routes
const app = new Hono();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    // Increased TTL to 1 hour (3600s).
    // This allows browser/CDN caching (max-age=300) and reduces Redis/DB load.
    ttl: 3600,
    keyPrefix: "api:navigation:",
    varyByQuery: true,
    methods: ["GET"],
  }),
);

// Schema for navigation query parameters
const navigationQuerySchema = z.object({
  type: z.enum(["header", "footer", "all"]).optional().default("all"),
});

// Navigation item interface
// Navigation item interface
interface NavigationItem {
  title: string;
  href: string;
  subMenu?: NavigationItem[];
}

// Helper to recursively map categories to navigation items
function mapCategoriesToNavigation(categoriesData: any[]): NavigationItem[] {
  // This is a simplified mapper. In a real scenario, you'd build a tree from flat data if needed.
  // This currently maps flat categories.
  // If your categories table supports hierarchy (parentId), you should build a tree here.
  // For now, mirroring the previous logic but ready for recursion if data changes.
  return categoriesData.map((cat) => ({
    title: cat.name,
    href: `/categories/${cat.slug}`,
    // Example of how recursion would look if categories had children:
    // subMenu: cat.children && cat.children.length > 0 ? mapCategoriesToNavigation(cat.children) : undefined
  }));
}

// Get navigation menu items
app.get("/", async (c) => {
  try {
    // Parse and validate query parameters
    const params = navigationQuerySchema.parse(c.req.query());
    const { type } = params;

    // Get site settings from database
    const [settings] = await db.select().from(siteSettings).limit(1);

    if (!settings) {
      return c.json(
        {
          error: "Site settings not found",
          success: false,
        },
        404,
      );
    }

    // Extract navigation configuration based on type
    let navigationConfig: any = null;

    if (type === "header" || type === "all") {
      // Parse header config to get navigation items
      const headerConfig = settings.headerConfig
        ? JSON.parse(settings.headerConfig)
        : null;

      if (headerConfig && headerConfig.navigation) {
        navigationConfig = {
          ...navigationConfig,
          header: headerConfig.navigation,
        };
      }
    }

    if (type === "footer" || type === "all") {
      // Parse footer config to get navigation items
      const footerConfig = settings.footerConfig
        ? JSON.parse(settings.footerConfig)
        : null;

      if (footerConfig && footerConfig.menus) {
        navigationConfig = {
          ...navigationConfig,
          footer: footerConfig.menus,
        };
      }
    }

    // If no navigation config found, try to create a default one from categories and pages
    if (!navigationConfig || (type === "all" && !navigationConfig.header)) {
      // Fetch all active categories
      const categoriesData = await db
        .select({
          id: categories.id,
          name: categories.name,
          slug: categories.slug,
        })
        .from(categories)
        .where(isNull(categories.deletedAt))
        .orderBy(categories.name);

      // Fetch all published pages
      const pagesData = await db
        .select({
          id: pages.id,
          title: pages.title,
          slug: pages.slug,
          isPublished: pages.isPublished,
        })
        .from(pages)
        .where(sql`${pages.deletedAt} IS NULL AND ${pages.isPublished} = true`)
        .orderBy(pages.title);

      // Create default navigation items
      const defaultNavigation: NavigationItem[] = [
        {
          title: "Home",
          href: "/",
        },
      ];

      // Add categories
      if (categoriesData.length > 0) {
        defaultNavigation.push({
          title: "Categories",
          href: "#",
          subMenu: mapCategoriesToNavigation(categoriesData),
        });
      }

      // Add pages
      pagesData.forEach((page) => {
        defaultNavigation.push({
          title: page.title,
          href: `/${page.slug}`,
        });
      });

      // Add to navigation config
      if (!navigationConfig) {
        navigationConfig = {};
      }

      if (type === "header" || type === "all") {
        navigationConfig.header = navigationConfig.header || defaultNavigation;
      }
    }

    if (!navigationConfig) {
      return c.json(
        {
          error: "Navigation configuration not found",
          success: false,
        },
        404,
      );
    }

    return c.json({
      navigation: navigationConfig,
      success: true,
    });
  } catch (error) {
    console.error("Error fetching navigation data:", error);

    return c.json(
      {
        error: "Failed to fetch navigation data",
        message: error instanceof Error ? error.message : "Unknown error",
        success: false,
      },
      500,
    );
  }
});

// Get navigation menu items by ID
app.get("/:id", async (c) => {
  try {
    const id = c.req.param("id");

    // Get site settings from database
    const [settings] = await db.select().from(siteSettings).limit(1);

    if (!settings) {
      return c.json(
        {
          error: "Site settings not found",
          success: false,
        },
        404,
      );
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
          items: headerConfig.navigation,
        };
      }
    }

    // Check footer menus if not found in header
    if (!menu && footerConfig && footerConfig.menus) {
      // If id is "footer", return all footer menus
      if (id === "footer") {
        menu = {
          id: "footer",
          name: "Footer Navigation",
          items: footerConfig.menus,
        };
      } else {
        // Try to find a specific footer menu by ID
        const footerMenu = footerConfig.menus.find(
          (m: any) => m.id === id || m.title === id,
        );

        if (footerMenu) {
          menu = {
            id: footerMenu.id || id,
            name: footerMenu.title,
            items: footerMenu.links || [],
          };
        }
      }
    }

    if (!menu) {
      return c.json(
        {
          error: `Navigation menu with ID '${id}' not found`,
          success: false,
        },
        404,
      );
    }

    return c.json({
      menu,
      success: true,
    });
  } catch (error) {
    console.error(`Error fetching navigation menu with ID:`, error);

    return c.json(
      {
        error: "Failed to fetch navigation menu",
        message: error instanceof Error ? error.message : "Unknown error",
        success: false,
      },
      500,
    );
  }
});

// Export the navigation routes
export { app as navigationRoutes };
