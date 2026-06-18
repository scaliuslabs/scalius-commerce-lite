import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { search } from "@scalius/core/search";
import { cacheMiddleware } from "../middleware/cache";
import { CACHE_TTLS } from "../utils/cache-ttls";
import { rateLimit, getClientIp } from "@scalius/shared/rate-limit";

import { ok } from "../utils/api-response";
import { RateLimitError } from "../utils/api-error";
import { successEnvelope, errorResponses } from "../schemas/responses";
// Create an OpenAPIHono app for search routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.SHORT,
    keyPrefix: "api:search:",
    varyByQuery: true,
    queryDefaults: { q: "", limit: 10, searchPages: "true", searchCategories: "true" },
    methods: ["GET"]
  }),
);

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
      description: "Search results",
      content: { "application/json": { schema: successEnvelope(z.object({
        products: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), price: z.number() }).passthrough()),
        pages: z.array(z.object({ id: z.string(), title: z.string(), slug: z.string() }).passthrough()),
        categories: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() }).passthrough()),
        query: z.string(),
        timestamp: z.string().optional(),
      })) } },
    },
    429: {
      description: "Rate limited",
      content: { "application/json": { schema: errorResponses[500].content["application/json"].schema } },
    },
    500: errorResponses[500],
  }
});

app.openapi(searchRoute, async (c) => {
  // Apply rate limiting via KV
  const kv = (c.env as Record<string, unknown>).CACHE as KVNamespace | undefined;
  if (kv) {
    const ip = getClientIp(c.req.raw);
    const result = await rateLimit({ kv, key: `search:${ip}`, limit: 30, windowMs: 60_000 });
    if (!result.allowed) {
      throw new RateLimitError("Too many requests. Please try again later.");
    }
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
