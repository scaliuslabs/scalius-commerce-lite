import { Hono } from "hono";
import { db } from "@/db";
import { pages } from "@/db/schema";
import { sql, isNull, eq, and, SQL } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import { z } from "zod";

// Create a Hono app for pages routes
const app = new Hono();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    // Increased TTL to 1 hour (3600s).
    // This allows browser/CDN caching (max-age=300) and reduces Redis/DB load.
    ttl: 3600,
    keyPrefix: "api:pages:",
    varyByQuery: true,
    methods: ["GET"],
  }),
);

// Page data interface
export interface PageData {
  id: string;
  title: string;
  slug: string;
  content: string;
  metaTitle: string | null;
  metaDescription: string | null;
  isPublished: boolean;
  hideHeader: boolean;
  hideFooter: boolean;
  hideTitle: boolean;
  publishedAt: number | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

// Schema for query parameters
const pagesQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(10),
  page: z.coerce.number().min(1).default(1),
  sort: z.enum(["title", "createdAt", "-title", "-createdAt"]).default("title"),
  publishedOnly: z.coerce.boolean().default(true),
});

// Get all pages
app.get("/", async (c) => {
  try {
    // Parse and validate query parameters
    const { limit, page, sort, publishedOnly } = pagesQuerySchema.parse(
      c.req.query(),
    );

    // Build query conditions with explicit typing
    const conditions: SQL<unknown>[] = [isNull(pages.deletedAt)];

    if (publishedOnly) {
      conditions.push(eq(pages.isPublished, true));
    }

    // Determine sort order
    const sortField = sort.startsWith("-") ? sort.substring(1) : sort;
    const sortDirection = sort.startsWith("-") ? "desc" : "asc";

    let orderBy;
    if (sortField === "title") {
      orderBy =
        sortDirection === "asc" ? pages.title : sql`${pages.title} DESC`;
    } else {
      orderBy =
        sortDirection === "asc"
          ? pages.createdAt
          : sql`${pages.createdAt} DESC`;
    }

    // Get total count for pagination
    const totalResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(pages)
      .where(and(...conditions))
      .get();

    const total = totalResult?.count || 0;
    const offset = (page - 1) * limit;
    const totalPages = Math.ceil(total / limit);

    // Fetch pages
    const pagesData = await db
      .select({
        id: pages.id,
        title: pages.title,
        slug: pages.slug,
        content: pages.content,
        metaTitle: pages.metaTitle,
        metaDescription: pages.metaDescription,
        isPublished: pages.isPublished,
        hideHeader: pages.hideHeader,
        hideFooter: pages.hideFooter,
        hideTitle: pages.hideTitle,
        publishedAt: pages.publishedAt,
        sortOrder: pages.sortOrder,
        createdAt: pages.createdAt,
        updatedAt: pages.updatedAt,
        deletedAt: pages.deletedAt,
      })
      .from(pages)
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    return c.json({
      pages: pagesData,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
      success: true,
    });
  } catch (error) {
    console.error("Error fetching pages:", error);

    return c.json(
      {
        error: "Failed to fetch pages",
        message: error instanceof Error ? error.message : "Unknown error",
        success: false,
      },
      500,
    );
  }
});

// Get page by slug
app.get("/slug/:slug", async (c) => {
  try {
    const slug = c.req.param("slug");

    if (!slug) {
      return c.json(
        {
          error: "Slug parameter is required",
          success: false,
        },
        400,
      );
    }

    // Create an array of conditions for better type safety
    const conditions: SQL<unknown>[] = [
      eq(pages.slug, slug),
      eq(pages.isPublished, true),
      isNull(pages.deletedAt),
    ];

    // Fetch the page from the database
    const page = await db
      .select({
        id: pages.id,
        title: pages.title,
        slug: pages.slug,
        content: pages.content,
        metaTitle: pages.metaTitle,
        metaDescription: pages.metaDescription,
        isPublished: pages.isPublished,
        hideHeader: pages.hideHeader,
        hideFooter: pages.hideFooter,
        hideTitle: pages.hideTitle,
        publishedAt: pages.publishedAt,
        sortOrder: pages.sortOrder,
        createdAt: pages.createdAt,
        updatedAt: pages.updatedAt,
        deletedAt: pages.deletedAt,
      })
      .from(pages)
      .where(and(...conditions))
      .get();

    if (!page) {
      return c.json(
        {
          error: "Page not found",
          success: false,
        },
        404,
      );
    }

    return c.json({
      page,
      success: true,
    });
  } catch (error) {
    console.error(
      `Error fetching page with slug ${c.req.param("slug")}:`,
      error,
    );

    return c.json(
      {
        error: "Failed to fetch page",
        message: error instanceof Error ? error.message : "Unknown error",
        success: false,
      },
      500,
    );
  }
});

// Get page by ID
app.get("/:id", async (c) => {
  try {
    const id = c.req.param("id");

    if (!id) {
      return c.json(
        {
          error: "ID parameter is required",
          success: false,
        },
        400,
      );
    }

    // Create an array of conditions for better type safety
    const conditions: SQL<unknown>[] = [
      eq(pages.id, id),
      isNull(pages.deletedAt),
    ];

    // Fetch the page from the database
    const page = await db
      .select({
        id: pages.id,
        title: pages.title,
        slug: pages.slug,
        content: pages.content,
        metaTitle: pages.metaTitle,
        metaDescription: pages.metaDescription,
        isPublished: pages.isPublished,
        hideHeader: pages.hideHeader,
        hideFooter: pages.hideFooter,
        hideTitle: pages.hideTitle,
        publishedAt: pages.publishedAt,
        sortOrder: pages.sortOrder,
        createdAt: pages.createdAt,
        updatedAt: pages.updatedAt,
        deletedAt: pages.deletedAt,
      })
      .from(pages)
      .where(and(...conditions))
      .get();

    if (!page) {
      return c.json(
        {
          error: "Page not found",
          success: false,
        },
        404,
      );
    }

    return c.json({
      page,
      success: true,
    });
  } catch (error) {
    console.error(`Error fetching page with ID ${c.req.param("id")}:`, error);

    return c.json(
      {
        error: "Failed to fetch page",
        message: error instanceof Error ? error.message : "Unknown error",
        success: false,
      },
      500,
    );
  }
});

// Export the pages routes
export { app as pagesRoutes };
