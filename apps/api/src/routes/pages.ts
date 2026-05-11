import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getPublicPages, getPublicPageById, getPublicPageBySlug } from "@scalius/core/modules/pages/pages.service";
import { cacheMiddleware } from "../middleware/cache";
import { NotFoundError } from "../utils/api-error";

import { ok } from "../utils/api-response";
import { successEnvelope, paginationSchema, errorResponses } from "../schemas/responses";
import { pageSchema } from "../schemas/entities";
import { CACHE_TTLS } from "../utils/cache-ttls";
// Create an OpenAPIHono app for pages routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
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
  featuredImage?: Record<string, unknown> | null;
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
      description: "Page list with pagination",
      content: { "application/json": { schema: successEnvelope(z.object({
        pages: z.array(pageSchema),
        pagination: paginationSchema,
      })) } },
    },
    500: errorResponses[500],
  }
});

app.openapi(listPagesRoute, async (c) => {
  const db = c.get("db");
  const { limit, page, sort } = c.req.valid("query");
  const result = await getPublicPages(db, { page, limit, sort });
  return ok(c, result);
});

// GET /pages/slug/:slug — get page by slug
const getPageBySlugRoute = createRoute({
  method: "get",
  path: "/slug/{slug}",
  tags: ["Pages"],
  summary: "Get page by slug",
  request: {
    params: z.object({
      slug: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Page details",
      content: { "application/json": { schema: successEnvelope(z.object({
        page: pageSchema,
      })) } },
    },
    400: errorResponses[400],
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getPageBySlugRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const page = await getPublicPageBySlug(db, slug);
  if (!page) throw new NotFoundError("Page not found");
  return ok(c, { page });
});

// GET /pages/:id — get page by ID
const getPageByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Pages"],
  summary: "Get page by ID",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Page details",
      content: { "application/json": { schema: successEnvelope(z.object({
        page: pageSchema,
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getPageByIdRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const page = await getPublicPageById(db, id);
  if (!page) throw new NotFoundError("Page not found");
  return ok(c, { page });
});

// Export the pages routes
export { app as pagesRoutes };
