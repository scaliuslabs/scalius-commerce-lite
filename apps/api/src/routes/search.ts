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

type SearchResults = Awaited<ReturnType<typeof search>>;

/**
 * Keep predictive responses useful and bounded across resource groups. Each
 * matching group gets one result first, then products fill the remaining
 * space before secondary resources. Admin search keeps its existing per-group
 * behavior because it calls the core service directly.
 */
function limitPublicSearchResults(
  results: SearchResults,
  limit: number,
): SearchResults {
  const products: SearchResults["products"] = [];
  const categories: SearchResults["categories"] = [];
  const pages: SearchResults["pages"] = [];
  let remaining = limit;

  const addFirst = <T>(source: readonly T[], target: T[]): void => {
    if (remaining === 0 || source.length === 0) return;
    target.push(source[0]!);
    remaining -= 1;
  };
  const fill = <T>(source: readonly T[], target: T[]): void => {
    if (remaining === 0 || source.length < 2) return;
    const additional = source.slice(1, remaining + 1);
    target.push(...additional);
    remaining -= additional.length;
  };

  addFirst(results.products, products);
  addFirst(results.categories, categories);
  addFirst(results.pages, pages);
  fill(results.products, products);
  fill(results.categories, categories);
  fill(results.pages, pages);

  return { products, categories, pages };
}

// Schema for search query validation
const searchQuerySchema = z.object({
  q: z.string().max(120).optional().default("").openapi({ description: "Search query" }),
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
  operationId: "storefront.search.predict",
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
        })),
        pages: z.array(z.object({ id: z.string(), title: z.string(), slug: z.string() })),
        categories: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() })),
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

  const limitedResults = limitPublicSearchResults(results, limit);

  // The full search page uses the dedicated product-list endpoint; this route
  // stays compact for predictive search clients.
  return ok(c, {
    products: limitedResults.products,
    pages: limitedResults.pages,
    categories: limitedResults.categories,
    query,
    timestamp: new Date().toISOString()
  });
});

// Export the search routes
export { app as searchRoutes };
