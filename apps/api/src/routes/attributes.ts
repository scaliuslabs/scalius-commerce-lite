// src/server/routes/attributes.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import {
  categories
} from "@scalius/database/schema";
import { eq, and, isNull } from "drizzle-orm";
import {
  getPublicFilterableAttributes,
  getPublicAttributesByCategory,
  getPublicAttributesForSearch,
} from "@scalius/core/modules/attributes/attributes.public";
import { cacheMiddleware } from "../middleware/cache";
import { NotFoundError } from "../utils/api-error";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { CACHE_TTLS } from "../utils/cache-ttls";
import { normalizePublicFtsSearchCacheValue, normalizePublicFtsSearchQuery } from "../utils/public-search-query";
import { getPublicCategoryById } from "@scalius/core/modules/categories";
const app = new OpenAPIHono<{ Bindings: Env }>();

// Cache this endpoint as it changes infrequently
app.use(
  "/filterable",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
    keyPrefix: "api:attributes:filterable"
  }),
);

// Cache category-specific attributes
app.use(
  "/category/:categoryId",
  cacheMiddleware({
    ttl: CACHE_TTLS.ATTRIBUTES,
    keyPrefix: "api:attributes:category",
    varyByQuery: false
  }),
);

// Cache category-specific attributes by slug
app.use(
  "/category-slug/:categorySlug",
  cacheMiddleware({
    ttl: CACHE_TTLS.ATTRIBUTES,
    keyPrefix: "api:attributes:category-slug",
    varyByQuery: false
  }),
);

app.use(
  "/search-filters",
  cacheMiddleware({
    ttl: CACHE_TTLS.ATTRIBUTES,
    keyPrefix: "api:attributes:search-filters",
    varyByQuery: true,
    queryNormalizers: { q: normalizePublicFtsSearchCacheValue },
    methods: ["GET"],
  }),
);

const attributeFilterSchema = z.object({ id: z.string(), name: z.string(), slug: z.string(), values: z.array(z.string()) }).passthrough();
const filterResponseSchema = successEnvelope(z.object({ filters: z.array(attributeFilterSchema) }));

// GET /attributes/filterable
const filterableRoute = createRoute({
  method: "get",
  path: "/filterable",
  tags: ["Attributes"],
  summary: "Get all filterable product attributes with values",
  responses: {
    200: {
      description: "Filterable attributes list",
      content: { "application/json": { schema: filterResponseSchema } },
    },
    500: errorResponses[500],
  }
});

app.openapi(filterableRoute, async (c) => {
  const db = c.get("db");
  const result = await getPublicFilterableAttributes(db);
  return ok(c, result);
});

// GET /attributes/category/:categoryId
const categoryAttributesRoute = createRoute({
  method: "get",
  path: "/category/{categoryId}",
  tags: ["Attributes"],
  summary: "Get filterable attributes for a category by ID",
  request: {
    params: z.object({
      categoryId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Category-specific filterable attributes",
      content: { "application/json": { schema: filterResponseSchema } },
    },
    500: errorResponses[500],
  }
});

app.openapi(categoryAttributesRoute, async (c) => {
  const db = c.get("db");
  const { categoryId } = c.req.valid("param");
  if (!await getPublicCategoryById(db, categoryId)) {
    throw new NotFoundError("Category not found");
  }
  const result = await getPublicAttributesByCategory(db, categoryId);
  return ok(c, result);
});

// GET /attributes/category-slug/:categorySlug
const categorySlugAttributesRoute = createRoute({
  method: "get",
  path: "/category-slug/{categorySlug}",
  tags: ["Attributes"],
  summary: "Get filterable attributes for a category by slug",
  request: {
    params: z.object({
      categorySlug: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Category-specific filterable attributes",
      content: { "application/json": { schema: filterResponseSchema } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(categorySlugAttributesRoute, async (c) => {
  const db = c.get("db");
  const { categorySlug } = c.req.valid("param");

  // Resolve slug to ID
  const category = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(
      eq(categories.slug, categorySlug),
      eq(categories.status, "published"),
      isNull(categories.deletedAt),
    ))
    .get();

  if (!category) throw new NotFoundError("Category not found");

  const result = await getPublicAttributesByCategory(db, category.id);
  return ok(c, result);
});

// GET /attributes/search-filters
const searchFiltersRoute = createRoute({
  method: "get",
  path: "/search-filters",
  tags: ["Attributes"],
  summary: "Get filterable attributes for search results",
  request: {
    query: z.object({
      q: z.string().optional().openapi({ description: "Search query" }),
      categoryId: z.string().optional().openapi({ description: "Optional category filter" })
    })
  },
  responses: {
    200: {
      description: "Search-specific filterable attributes",
      content: { "application/json": { schema: filterResponseSchema } },
    },
    500: errorResponses[500],
  }
});

app.openapi(searchFiltersRoute, async (c) => {
  const db = c.get("db");
  const { q, categoryId } = c.req.valid("query");
  const query = normalizePublicFtsSearchQuery(q);

  if (categoryId && !await getPublicCategoryById(db, categoryId)) {
    throw new NotFoundError("Category not found");
  }

  if (!query) {
    return ok(c, { filters: [] });
  }

  return ok(c, await getPublicAttributesForSearch(db, query, categoryId));
});

export { app as attributeRoutes };
