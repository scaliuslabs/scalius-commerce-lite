// src/server/routes/attributes.ts
// Public facet definitions outside a listing (agents and tools): a
// category's or a search's typed facets with counts, read from the catalogue
// projections (catalog/facets.ts). Listings return the same facets beside
// their products; storefront pages never call these routes.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import {
  categories
} from "@scalius/database/schema";
import { eq, and, isNull } from "drizzle-orm";
import { getPublicCategoryFacets, getPublicSearchFacets } from "@scalius/core/modules/catalog";
import { productFacetSchema } from "../schemas/catalog-facets";
import { NotFoundError } from "../utils/api-error";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { normalizePublicFtsSearchQuery } from "../utils/public-search-query";
import { getPublicCategoryById } from "@scalius/core/modules/categories";
const app = new OpenAPIHono<{ Bindings: Env }>();

const filterResponseSchema = successEnvelope(z.object({ facets: z.array(productFacetSchema).max(20) }));
const publicAttributeCategorySlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

// GET /attributes/category/:categoryId
const categoryAttributesRoute = createRoute({
  method: "get",
  path: "/category/{categoryId}",
  operationId: "storefront.attributes.category_id_alias",
  tags: ["Attributes"],
  summary: "Get the facets of a category by ID",
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
  return ok(c, await getPublicCategoryFacets(db, categoryId));
});

// GET /attributes/category-slug/:categorySlug
const categorySlugAttributesRoute = createRoute({
  method: "get",
  path: "/category-slug/{categorySlug}",
  operationId: "storefront.attributes.list_for_category",
  tags: ["Attributes"],
  summary: "Get the facets of a category by slug",
  description:
    "Brand, option and typed attribute facets over the public products of the category and its published sub-categories, with counts (at most 20 attribute facets and 30 values each). Filter a listing with `?<facet slug>=<value>` (`<slug>.min`/`<slug>.max` for a range).",
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

  return ok(c, await getPublicCategoryFacets(db, category.id));
});

// GET /attributes/search-filters
const searchFiltersRoute = createRoute({
  method: "get",
  path: "/search-filters",
  operationId: "storefront.attributes.list_for_search",
  tags: ["Attributes"],
  summary: "Get the facets of search results",
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
    return ok(c, { facets: [] });
  }

  return ok(c, await getPublicSearchFacets(db, query, categoryId));
});

export { app as attributeRoutes };
