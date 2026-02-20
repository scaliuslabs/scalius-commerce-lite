import { Hono } from "hono";
import { z } from "zod";
import { search } from "@/lib/search/index";
import { cacheMiddleware } from "../middleware/cache";
import { rateLimit } from "@/lib/rate-limit";

// Create a Hono app for search routes
const app = new Hono();

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
  q: z.string().optional().default(""),
  categoryId: z.string().optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  limit: z.coerce.number().optional().default(10),
  searchPages: z
    .enum(["true", "false"])
    .optional()
    .default("true")
    .transform((val) => val === "true"),
  searchCategories: z
    .enum(["true", "false"])
    .optional()
    .default("true")
    .transform((val) => val === "true"),
});

// Perform a search across products, categories, and pages
app.get("/", async (c) => {
  try {
    // Apply rate limiting
    try {
      await limiter.check(c.req.raw);
    } catch (error) {
      return c.json(
        {
          error: "Too many requests. Please try again later.",
          success: false,
        },
        429,
      );
    }

    // Parse and validate the query parameters
    const params = searchQuerySchema.parse(c.req.query());
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
        success: true,
        query: "",
      });
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
      success: true,
      query,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Search API error:", error);


    return c.json(
      {
        error: "An error occurred while searching",
        message: String(error),
        success: false,
      },
      500,
    );
  }
});


// Export the search routes
export { app as searchRoutes };
