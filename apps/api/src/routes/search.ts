import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { search } from "@scalius/core/search";
import { getClientIp } from "@scalius/shared/rate-limit";

import { ok } from "../utils/api-response";
import { RateLimitError } from "../utils/api-error";
import { successEnvelope, errorResponses } from "../schemas/responses";
import {
  normalizePublicFtsSearchQuery,
} from "../utils/public-search-query";
// Create an OpenAPIHono app for search routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// Schema for search query validation
const searchQuerySchema = z.object({
  q: z.string().optional().default("").openapi({ description: "Search query" }),
  categoryId: z.string().optional().openapi({ description: "Category ID filter" }),
  minPrice: z.coerce.number().min(0).optional().openapi({ description: "Minimum effective buyer-SKU price" }),
  maxPrice: z.coerce.number().min(0).optional().openapi({ description: "Maximum effective buyer-SKU price" }),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10).openapi({ description: "Max results" }),
  searchPages: z
    .enum(["true", "false"])
    .optional()
    .default("true")
    .transform((val) => val === "true")
    .openapi({ description: "Include pages in search results" }),
  searchCategories: z
    .enum(["true", "false"])
    .optional()
    .default("true")
    .transform((val) => val === "true")
    .openapi({ description: "Include categories in search results" })
}).superRefine((value, ctx) => {
  if (
    value.minPrice !== undefined &&
    value.maxPrice !== undefined &&
    value.minPrice > value.maxPrice
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["maxPrice"],
      message: "Maximum price must be greater than or equal to minimum price",
    });
  }
});

// GET /search — perform a search across products, categories, and pages
const searchRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Search"],
  summary: "Search across products, categories, and pages",
  request: {
    query: searchQuerySchema
  },
  responses: {
    200: {
      description: "Search results",
      content: { "application/json": { schema: successEnvelope(z.object({
        products: z.array(z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          price: z.number(),
          discountedPrice: z.number(),
          priceVaries: z.boolean(),
          availableForSale: z.boolean(),
          hasVariants: z.boolean(),
          imageUrl: z.string().url().nullable(),
          imageMediaId: z.string().nullable(),
          imageAlt: z.string().nullable(),
          categoryId: z.string().nullable(),
          categoryName: z.string().nullable(),
        }).passthrough()),
        pages: z.array(z.object({ id: z.string(), title: z.string(), slug: z.string() }).passthrough()),
        categories: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() }).passthrough()),
        query: z.string(),
        timestamp: z.string().optional(),
      })) } },
    },
    400: errorResponses[400],
    429: errorResponses[429],
    500: errorResponses[500],
  }
});

app.openapi(searchRoute, async (c) => {
  const params = c.req.valid("query");
  const {
    q,
    categoryId,
    minPrice,
    maxPrice,
    limit,
    searchPages,
    searchCategories
  } = params;
  const query = normalizePublicFtsSearchQuery(q);

  // If no query, return empty results
  if (!query) {
    return ok(c, {
      products: [],
      pages: [],
      categories: [],
      query: ""
    });
  }

  // Predictive queries are high-cardinality and short-lived, making remote KV
  // slower than the indexed D1 read on a cold location. Cloudflare's native
  // limiter keeps abuse protection on-machine without adding a network round trip.
  const ip = getClientIp(c.req.raw);
  const rateLimitResult = await c.env.SEARCH_RATE_LIMITER.limit({ key: `search:${ip}` });
  if (!rateLimitResult.success) {
    throw new RateLimitError("Too many requests. Please try again later.");
  }

  // Set up timeout for search (5 seconds)
  const db = c.get("db");
  const searchPromise = search(db, query, {
    categoryId,
    minPrice,
    maxPrice,
    limit,
    searchPages,
    searchCategories
  });

  // Set timeout for the search operation
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Search timed out")), 5000);
  });

  let results: Awaited<typeof searchPromise>;
  try {
    results = await Promise.race([searchPromise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  // Return results
  return ok(c, {
    products: results.products || [],
    pages: results.pages || [],
    categories: results.categories || [],
    query,
    timestamp: new Date().toISOString()
  });
});

// Export the search routes
export { app as searchRoutes };
