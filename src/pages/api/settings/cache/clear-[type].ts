import type { APIRoute } from "astro";

export const POST: APIRoute = async ({ params, request }) => {
  try {
    // Get cache type from URL parameter
    const { type } = params;

    if (!type) {
      return new Response(JSON.stringify({ error: "Cache type is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate cache type
    const validCacheTypes = [
      "products",
      "categories",
      "collections",
      "footer",
      "header",
      "hero",
      "navigation",
      "pages",
      "search",
    ];

    if (!validCacheTypes.includes(type)) {
      return new Response(JSON.stringify({ error: "Invalid cache type" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Use process.env which is now supported in Cloudflare Workers with nodejs_compat
    const apiToken = process.env.API_TOKEN;

    // Get API URL from environment with safer fallback to request origin
    const runtimeOrigin = new URL(request.url).origin;
    let apiBaseUrl: string;

    if (process.env.PUBLIC_API_URL) {
      apiBaseUrl = process.env.PUBLIC_API_URL;
    } else if (process.env.PUBLIC_API_BASE_URL) {
      apiBaseUrl = `${process.env.PUBLIC_API_BASE_URL}/api/v1`;
    } else {
      apiBaseUrl = `${runtimeOrigin}/api/v1`;
    }

    // Extract the origin from the API URL
    const apiOrigin = new URL(apiBaseUrl).origin;
    console.log(`Using API base URL: ${apiBaseUrl}`);
    console.log(`Using API origin: ${apiOrigin}`);

    if (!apiToken) {
      console.error("API_TOKEN is not defined in environment variables");
      return new Response(
        JSON.stringify({
          error: "API configuration error",
          details: "API_TOKEN is missing from environment",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // First get an auth token using the API token
    const tokenUrl = `${apiBaseUrl}/auth/token`;
    console.log(`Requesting auth token from: ${tokenUrl}`);

    const tokenResponse = await fetch(tokenUrl, {
      headers: {
        "X-API-Token": apiToken,
      },
    });

    if (!tokenResponse.ok) {
      const tokenResponseText = await tokenResponse.text();
      console.error(
        `Error getting auth token: ${tokenResponse.status} ${tokenResponse.statusText}`,
      );
      console.error(`Token response body: ${tokenResponseText}`);
      throw new Error(
        `Failed to authenticate with API: ${tokenResponse.status} ${tokenResponse.statusText}`,
      );
    }

    const tokenData = await tokenResponse.json();
    console.log("Auth token obtained successfully");

    if (!tokenData.data?.token) {
      console.error(
        "Auth token response missing token data:",
        JSON.stringify(tokenData),
      );
      throw new Error("Auth response did not contain a valid token");
    }

    const authToken = tokenData.data.token;

    // Now clear specific cache with the JWT auth token
    const clearUrl = `${apiBaseUrl}/cache/clear-${type}`;
    console.log(`Requesting specific cache clear from: ${clearUrl}`);

    const response = await fetch(clearUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
        Origin: apiOrigin,
        Referer: apiOrigin,
        "X-Requested-With": "XMLHttpRequest",
      },
      // Empty body as JSON to ensure proper content type
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const responseText = await response.text();
      console.error(
        `Error clearing ${type} cache: ${response.status} ${response.statusText}`,
      );
      console.error(`Response body: ${responseText}`);
      throw new Error(
        `API responded with status ${response.status}: ${responseText}`,
      );
    }

    const data = await response.json();
    console.log(`${type} cache cleared successfully`);

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in clear specific cache API route:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to clear cache",
        details: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
