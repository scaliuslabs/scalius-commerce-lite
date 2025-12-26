import type { APIRoute } from "astro";
import { indexAllData } from "@/lib/search/index";
import { safeErrorResponse } from "@/lib/error-utils";

// Dedicated endpoint for reindexing
export const POST: APIRoute = async ({ request }) => {
  // Check for secret to authorize reindexing
  const authHeader = request.headers.get("Authorization");
  const expectedAuth = `Bearer ${process.env.SERVICE_PASSWORD_MEILISEARCH || ""}`;

  console.log("Reindex API called");

  // Skip auth check in development to make testing easier
  const isDev = process.env.NODE_ENV === "development";
  if (!isDev && authHeader !== expectedAuth) {
    console.log("Unauthorized reindex attempt");
    return new Response(
      JSON.stringify({
        error: "Unauthorized. Please provide a valid API key.",
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
    console.log("Starting reindex process...");

    // Reindex all data with a timeout
    const reindexPromise = indexAllData();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("Reindex operation timed out after 60 seconds")),
        60000,
      );
    });

    const result = (await Promise.race([reindexPromise, timeoutPromise])) as {
      productsCount: number;
      pagesCount: number;
      categoriesCount: number;
    };
    console.log("Reindex completed successfully:", result);

    return new Response(
      JSON.stringify({
        productsCount: result.productsCount,
        pagesCount: result.pagesCount,
        categoriesCount: result.categoriesCount,
        success: true,
        message: "Successfully reindexed all data",
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};

// Add GET method for easier manual triggering from browser
export const GET: APIRoute = async () => {
  // Only allow in development for debugging purposes
  if (process.env.NODE_ENV !== "development") {
    return new Response(
      JSON.stringify({
        error: "Method not allowed in production",
        success: false,
      }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Allow: "POST",
        },
      },
    );
  }

  // In development, allow GET requests to trigger reindexing for easier testing
  console.log("GET reindex API called (development mode)");

  try {
    console.log("Starting development reindex process...");
    const result = await indexAllData();

    return new Response(
      JSON.stringify({
        productsCount: result.productsCount,
        pagesCount: result.pagesCount,
        categoriesCount: result.categoriesCount,
        success: true,
        message: "Successfully reindexed all data (development mode)",
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};
