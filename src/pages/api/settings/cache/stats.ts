import type { APIRoute } from "astro";
import { safeErrorResponse } from "@/lib/error-utils";

export const GET: APIRoute = async ({ request }) => {
  try {
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

    console.log(`Using API base URL: ${apiBaseUrl}`);

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

    // Now get cache stats with the JWT auth token
    const statsUrl = `${apiBaseUrl}/cache/stats`;
    console.log(`Requesting cache stats from: ${statsUrl}`);

    const response = await fetch(statsUrl, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    if (!response.ok) {
      const responseText = await response.text();
      console.error(
        `Error fetching cache stats: ${response.status} ${response.statusText}`,
      );
      console.error(`Response body: ${responseText}`);
      throw new Error(
        `API responded with status ${response.status}: ${responseText}`,
      );
    }

    const data = await response.json();
    console.log("Cache stats fetched successfully");

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};
