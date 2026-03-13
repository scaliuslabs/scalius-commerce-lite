import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "@scalius/database/client";
import { pages } from "@scalius/database/schema";
import { sql, isNull, eq, and, SQL } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import { NotFoundError } from "../utils/api-error";

// Create an OpenAPIHono app for pages routes
const app = new OpenAPIHono();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: 3600,
    keyPrefix: "api:pages:",
    varyByQuery: true,
    methods: ["GET"]
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
  limit: z.coerce.number().min(1).max(100).default(10).openapi({ description: "Items per page" }),
  page: z.coerce.number().min(1).default(1).openapi({ description: "Page number" }),
  sort: z.enum(["title", "createdAt", "-title", "-createdAt"]).default("title").openapi({ description: "Sort field (prefix with - for descending)" }),
  publishedOnly: z.coerce.boolean().default(true).openapi({ description: "Only return published pages" })
});

// GET /pages — list all pages
const listPagesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Pages"],
  summary: "List all pages with pagination",
  request: {
    query: pagesQuerySchema
  },
  responses: {
    200: {
      description: "Page list with pagination"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(listPagesRoute, async (c) => {
  const { limit, page, sort, publishedOnly } = c.req.valid("query");

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
      deletedAt: pages.deletedAt
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
      totalPages
    },
    success: true as const
  }, 200);
});

// GET /pages/slug/:slug — get page by slug
const getPageBySlugRoute = createRoute({
  method: "get",
  path: "/slug/{slug}",
  tags: ["Pages"],
  summary: "Get page by slug",
  responses: {
    200: {
      description: "Page details"
    },
    400: {
      description: "Bad request"
    },
    404: {
      description: "Page not found"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(getPageBySlugRoute, async (c) => {
  const { slug } = c.req.valid("param");

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
      deletedAt: pages.deletedAt
    })
    .from(pages)
    .where(and(...conditions))
    .get();

  if (!page) {
    throw new NotFoundError("Page not found");
  }

  return c.json({
    page,
    success: true as const
  }, 200);
});

// GET /pages/:id — get page by ID
const getPageByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Pages"],
  summary: "Get page by ID",
  responses: {
    200: {
      description: "Page details"
    },
    404: {
      description: "Page not found"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(getPageByIdRoute, async (c) => {
  const { id } = c.req.valid("param");

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
      deletedAt: pages.deletedAt
    })
    .from(pages)
    .where(and(...conditions))
    .get();

  if (!page) {
    throw new NotFoundError("Page not found");
  }

  return c.json({
    page,
    success: true as const
  }, 200);
});

// Export the pages routes
export { app as pagesRoutes };
