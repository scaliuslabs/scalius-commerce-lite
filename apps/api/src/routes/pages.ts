import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getPublicContentSitemapEntries, getPublicPages, getPublicPageById, getPublicPageBySlug } from "@scalius/core/modules/pages";
import { sitemapQuerySchema } from "../schemas/sitemap";
import { NotFoundError } from "../utils/api-error";
import { publicTranslation } from "../utils/public-market";

import { ok } from "../utils/api-response";
import { successEnvelope, paginationSchema, errorResponses } from "../schemas/responses";
import { publicPageSchema } from "../schemas/entities";
import { publicPageDetailSchema } from "../schemas/custom-fields";
// Create an OpenAPIHono app for pages routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// Page data interface
export interface PageData {
  id: string;
  title: string;
  slug: string;
  content: string;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalPath: string | null;
  noIndex: boolean;
  excludeFromSitemap: boolean;
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
  sort: z.enum(["title", "createdAt", "-title", "-createdAt"]).default("title").openapi({ description: "Sort field (prefix with - for descending)" })
});

// GET /pages — list buyer-resolvable published pages
const listPagesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Pages"],
  summary: "List published pages with pagination",
  operationId: "storefront.pages.list",
  request: {
    query: pagesQuerySchema
  },
  responses: {
    200: {
      description: "Page list with pagination",
      content: { "application/json": { schema: successEnvelope(z.object({
        pages: z.array(publicPageSchema),
        pagination: paginationSchema,
      })) } },
    },
    500: errorResponses[500],
  }
});

app.openapi(listPagesRoute, async (c) => {
  const db = c.get("db");
  const { limit, page, sort } = c.req.valid("query");
  const result = await getPublicPages(db, { page, limit, sort, translation: publicTranslation(c) });
  return ok(c, result);
});

// GET /pages/sitemap — page URLs for XML discovery (registered before the item routes)
const pageSitemapRoute = createRoute({
  method: "get",
  path: "/sitemap",
  operationId: "storefront.pages.sitemap",
  tags: ["Pages"],
  summary: "List page URLs for the XML sitemap",
  description: "Public pages without noIndex or a sitemap exclusion, filtered before the limit, oldest first, with each one's last change and the complete count, so the sitemap index lists every 5,000-URL document.",
  request: { query: sitemapQuerySchema },
  responses: {
    200: {
      description: "Page sitemap entries",
      content: { "application/json": { schema: successEnvelope(z.object({
        entries: z.array(z.object({
          slug: z.string(),
          canonicalPath: z.string().nullable(),
          updatedAt: z.string().nullable(),
          publishedAt: z.string().nullable(),
        })),
        pagination: paginationSchema,
      })) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});

app.openapi(pageSitemapRoute, async (c) => {
  const { presence: _presence, ...params } = c.req.valid("query");
  return ok(c, await getPublicContentSitemapEntries(c.get("db"), "page", params));
});

// GET /pages/slug/:slug — get page by slug
const getPageBySlugRoute = createRoute({
  method: "get",
  path: "/slug/{slug}",
  tags: ["Pages"],
  summary: "Get page by slug",
  operationId: "storefront.pages.get_by_slug",
  request: {
    params: z.object({
      slug: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Page details",
      content: { "application/json": { schema: successEnvelope(z.object({
        page: publicPageDetailSchema,
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
  const page = await getPublicPageBySlug(db, slug, publicTranslation(c));
  if (!page) throw new NotFoundError("Page not found");
  return ok(c, { page });
});

// GET /pages/:id — get page by ID
const getPageByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Pages"],
  summary: "Get page by ID",
  operationId: "storefront.pages.get_by_id",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Page details",
      content: { "application/json": { schema: successEnvelope(z.object({
        page: publicPageDetailSchema,
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getPageByIdRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const page = await getPublicPageById(db, id, publicTranslation(c));
  if (!page) throw new NotFoundError("Page not found");
  return ok(c, { page });
});

// Export the pages routes
export { app as pagesRoutes };
