import type { APIRoute } from "astro";
import { search, indexAllData } from "@/lib/search/index";
import { rateLimit } from "@/lib/rate-limit";
import { safeErrorResponse } from "@/lib/error-utils";

// Rate limiting for search API
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
});

export const GET: APIRoute = async ({ request, url }) => {
  // Apply rate limiting
  try {
    await limiter.check(request);
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: "Too many requests. Please try again later.",
        success: false,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  }

  try {
    // Get query parameters
    const query = url.searchParams.get("q") || "";
    const categoryId = url.searchParams.get("categoryId") || undefined;
    const minPrice = url.searchParams.has("minPrice")
      ? parseFloat(url.searchParams.get("minPrice") || "0")
      : undefined;
    const maxPrice = url.searchParams.has("maxPrice")
      ? parseFloat(url.searchParams.get("maxPrice") || "0")
      : undefined;
    const limit = url.searchParams.has("limit")
      ? parseInt(url.searchParams.get("limit") || "10", 10)
      : 10;
    const searchPages = url.searchParams.get("searchPages") !== "false";
    const searchCategories =
      url.searchParams.get("searchCategories") !== "false";

    // If no query, return empty results
    if (!query.trim()) {
      return new Response(
        JSON.stringify({
          products: [],
          pages: [],
          categories: [],
          success: true,
          query: "",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=60", // Cache empty results for 1 minute
          },
        },
      );
    }

    // Set up timeout for search
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Search timed out")), 5000);
    });

    // Perform search with timeout
    const searchPromise = search(query, {
      categoryId: categoryId as string | undefined,
      minPrice,
      maxPrice,
      limit,
      searchPages,
      searchCategories,
    });

    // Race the search and timeout
    const results = await Promise.race([searchPromise, timeoutPromise]);

    // Return results
    return new Response(
      JSON.stringify({
        ...results,
        success: true,
        query,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300, stale-while-revalidate=600", // Cache for 5 minutes, stale for 10
        },
      },
    );
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};

// For manual reindexing
export const POST: APIRoute = async ({ request }) => {
  // Check for secret to authorize reindexing
  const authHeader = request.headers.get("Authorization");
  const expectedAuth = `Bearer ${process.env.SERVICE_PASSWORD_MEILISEARCH || ""}`;

  if (authHeader !== expectedAuth) {
    return new Response(
      JSON.stringify({
        error: "Unauthorized",
        success: false,
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }

  try {
    // Reindex all data
    const result = await indexAllData();

    return new Response(
      JSON.stringify({
        ...result,
        success: true,
        message: "Successfully reindexed all data",
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};
