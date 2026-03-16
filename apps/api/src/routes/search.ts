import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { search } from "@scalius/core/search";
import { cacheMiddleware } from "../middleware/cache";
import { CACHE_TTLS } from "../utils/cache-ttls";
import { rateLimit } from "@scalius/shared/rate-limit";

import { ok } from "../utils/api-response";
import { RateLimitError } from "../utils/api-error";
// Create an OpenAPIHono app for search routes
const app = new OpenAPIHono();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.SHORT,
    keyPrefix: "api:search:",
    varyByQuery: true,
    methods: ["GET"]
  }),
);

// Set up rate limiting for search API
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
});

// Schema for search query validation
const searchQuerySchema = z.object({
  q: z.string().optional().default("").openapi({ description: "Search query" }),
  categoryId: z.string().optional().openapi({ description: "Category ID filter" }),
  minPrice: z.coerce.number().optional().openapi({ description: "Minimum price filter" }),
  maxPrice: z.coerce.number().optional().openapi({ description: "Maximum price filter" }),
  limit: z.coerce.number().optional().default(10).openapi({ description: "Max results" }),
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
      description: "Search results"
    },
    429: {
      description: "Rate limited"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(searchRoute, async (c) => {
  // Apply rate limiting
  try {
    await limiter.check(c.req.raw);
  } catch (error) {
    throw new RateLimitError("Too many requests. Please try again later.");
  }

  const params = c.req.valid("query");
  const {
    q: query,
    categoryId,
    minPrice,
    maxPrice,
    limit,
    searchPages,
    searchCategories
  } = params;

  // If no query, return empty results
  if (!query.trim()) {
    return ok(c, {
      products: [],
      pages: [],
      categories: [],
      query: ""
    });
  }

  // Set up timeout for search (5 seconds)
  const searchPromise = search(query, {
    categoryId,
    minPrice,
    maxPrice,
    limit,
    searchPages,
    searchCategories
  });

  // Set timeout for the search operation
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Search timed out")), 5000);
  });

  // Race the search and timeout
  const results = await Promise.race([searchPromise, timeoutPromise]);

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
