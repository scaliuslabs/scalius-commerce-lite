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
import { NotFoundError } from "../utils/api-error";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { normalizePublicFtsSearchQuery } from "../utils/public-search-query";
import { getPublicCategoryById } from "@scalius/core/modules/categories";
const app = new OpenAPIHono<{ Bindings: Env }>();

// Cache this endpoint as it changes infrequently
// Cache category-specific attributes
// Cache category-specific attributes by slug
const attributeFilterSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  values: z.array(z.string()).max(100),
});
const filterResponseSchema = successEnvelope(z.object({ filters: z.array(attributeFilterSchema) }));
const publicAttributeCategorySlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

// GET /attributes/filterable
const filterableRoute = createRoute({
  method: "get",
  path: "/filterable",
  operationId: "storefront.attributes.list_filterable",
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
  operationId: "storefront.attributes.category_id_alias",
  tags: ["Attributes"],
  summary: "Get filterable attributes for a category by ID",
  request: {
    params: z.object({
      categoryId: z.string().trim().min(1).max(180),
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
  operationId: "storefront.attributes.list_for_category",
  tags: ["Attributes"],
  summary: "Get filterable attributes for a category by slug",
  request: {
    params: z.object({
      categorySlug: publicAttributeCategorySlugSchema,
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
  operationId: "storefront.attributes.list_for_search",
  tags: ["Attributes"],
  summary: "Get filterable attributes for search results",
  request: {
    query: z.object({
      q: z.string().trim().max(120).optional().openapi({ description: "Search query" }),
      categoryId: z.string().trim().min(1).max(180).optional().openapi({ description: "Optional category filter" })
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
