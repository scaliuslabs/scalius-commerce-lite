import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { search } from "@scalius/core/search";
import { cacheMiddleware } from "../middleware/cache";
import { rateLimit } from "@scalius/shared/rate-limit";

// Create an OpenAPIHono app for search routes
const app = new OpenAPIHono();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: 300, // 5 minutes
    keyPrefix: "api:search:",
    varyByQuery: true,
    methods: ["GET"],
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
    .openapi({ description: "Include categories in search results" }),
});

// GET /search — perform a search across products, categories, and pages
const searchRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Search"],
  summary: "Search across products, categories, and pages",
  request: {
    query: searchQuerySchema,
  },
  responses: {
    200: {
      description: "Search results",
      content: {
        "application/json": {
          schema: z.object({
            products: z.array(z.any()),
            pages: z.array(z.any()),
            categories: z.array(z.any()),
            success: z.literal(true),
            query: z.string(),
            timestamp: z.string().optional(),
          }),
        },
      },
    },
    429: {
      description: "Rate limited",
      content: { "application/json": { schema: z.object({ error: z.string(), success: z.literal(false) }) } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: z.object({ error: z.string(), message: z.string(), success: z.literal(false) }) } },
    },
  },
});

app.openapi(searchRoute, async (c) => {
  // Apply rate limiting
  try {
    await limiter.check(c.req.raw);
  } catch (error) {
    return c.json(
      {
        error: "Too many requests. Please try again later.",
        success: false as const,
      },
      429,
    );
  }

  const params = c.req.valid("query");
  const {
    q: query,
    categoryId,
    minPrice,
    maxPrice,
    limit,
    searchPages,
    searchCategories,
  } = params;

  // If no query, return empty results
  if (!query.trim()) {
    return c.json({
      products: [],
      pages: [],
      categories: [],
      success: true as const,
      query: "",
    }, 200);
  }

  // Set up timeout for search (5 seconds)
  const searchPromise = search(query, {
    categoryId,
    minPrice,
    maxPrice,
    limit,
    searchPages,
    searchCategories,
  });

  // Set timeout for the search operation
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Search timed out")), 5000);
  });

  // Race the search and timeout
  const results = await Promise.race([searchPromise, timeoutPromise]);

  // Return results
  return c.json({
    products: results.products || [],
    pages: results.pages || [],
    categories: results.categories || [],
    success: true as const,
    query,
    timestamp: new Date().toISOString(),
  }, 200);
});

// Export the search routes
export { app as searchRoutes };
