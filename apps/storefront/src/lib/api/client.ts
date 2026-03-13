// src/lib/api/client.ts

/**
 * Core API Client for Scalius Commerce
 * Handles request creation, authentication, and resilient fetching.
 */

// Resolve the API base URL lazily (called per-request, not at module init).
//
// In SSR, this module loads once per Worker isolate BEFORE any request's context is set.
// A module-level constant would always resolve to the build-time fallback (empty without .env).
//
// Resolution order:
// 1. SSR runtime: Cloudflare Worker env from runtime-env.ts (wrangler.jsonc vars)
// 2. Client-side: window.__API_BASE_URL__ injected by Layout.astro
// 3. Build-time: import.meta.env.PUBLIC_API_URL (from .env if present)
// 4. Last resort: /api/v1 (same-origin proxy for local dev)
import { getRuntimeApiUrl, getRuntimeApiToken } from "./runtime-env";

function getApiBaseUrl(): string {
  // SSR: try runtime env (set per-request by middleware from locals.runtime.env)
  if (import.meta.env.SSR) {
    const runtimeUrl = getRuntimeApiUrl();
    if (runtimeUrl) return runtimeUrl;
  }

  // Client-side: read from injected window var
  if (typeof window !== "undefined" && (window as any).__API_BASE_URL__) {
    return (window as any).__API_BASE_URL__;
  }

  // Build-time fallback (from .env if present)
  return import.meta.env.PUBLIC_API_URL || "/api/v1";
}

// --- JWT Token Management ---

let jwtToken: string | null = null;
let tokenExpiry: number | null = null;
let tokenRefreshPromise: Promise<string | null> | null = null;

/**
 * Creates a valid API URL by combining the base URL and a given path.
 * @param path The API endpoint path (e.g., "/products/my-slug").
 * @returns The full URL for the API request.
 */
export function createApiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${getApiBaseUrl()}${cleanPath}`;
}

/**
 * Retrieves a valid JWT token, fetching a new one if necessary.
 * This function handles token expiration and pending refresh requests.
 * @returns A promise that resolves to the JWT token or null if authentication fails.
 */
async function getJwtToken(): Promise<string | null> {
  const isExpiredOrExpiring =
    !jwtToken || !tokenExpiry || Date.now() > tokenExpiry - 5 * 60 * 1000;

  if (!isExpiredOrExpiring) {
    return jwtToken;
  }

  if (tokenRefreshPromise) {
    return tokenRefreshPromise;
  }

  tokenRefreshPromise = (async () => {
    try {
      const apiToken = getRuntimeApiToken() || import.meta.env.API_TOKEN;
      if (!apiToken) {
        console.error(
          "[API Client] API_TOKEN is not configured in environment variables.",
        );
        return null;
      }

      const response = await fetch(createApiUrl("/auth/token"), {
        headers: { "X-API-Token": apiToken },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        // Always consume the body to prevent stalled response warnings
        const errBody = await response.text();
        console.error("Failed to get JWT token:", errBody);
        return null;
      }

      // FIX: Define the expected shape of the JSON response
      const data: { data: { token: string } } = await response.json();
      jwtToken = data.data.token;

      if (jwtToken) {
        const payload = JSON.parse(atob(jwtToken.split(".")[1]));
        tokenExpiry = payload.exp * 1000; // Convert to milliseconds
      }

      return jwtToken;
    } catch (error) {
      console.error("Error getting JWT token:", error);
      return null;
    } finally {
      tokenRefreshPromise = null;
    }
  })();

  return tokenRefreshPromise;
}

/**
 * A resilient fetch wrapper that handles authentication, retries, and timeouts.
 * This is the primary function for making API calls.
 * @param url The full URL to fetch.
 * @param options Standard RequestInit options.
 * @param retries Number of retries on failure.
 * @param timeout Request timeout in milliseconds.
 * @param requiresAuth Whether the request requires a JWT token.
 * @returns A promise that resolves to the Response object.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 2,
  timeout = 8000,
  requiresAuth = true,
): Promise<Response> {
  try {
    const headers = new Headers(options.headers || {});
    if (requiresAuth) {
      const token = await getJwtToken();
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      } else {
        // If auth is required but no token could be obtained, fail early.
        throw new Error("Authentication required but no token available.");
      }
    }

    // If authentication is required, we MUST NOT cache this request at the fetch level
    // to prevent Cloudflare from serving a cached authenticated response to a different user or session.
    if (requiresAuth && !options.cache) {
      options.cache = "no-store";
    }

    // Use Cloudflare Service Bindings if available during SSR for 0ms latency
    // Extracted via dynamic import of node:async_hooks to prevent breaking browser builds
    let backendApi: any = undefined;
    if (import.meta.env.SSR) {
      try {
        const { apiContext } = await import("./context");
        backendApi = apiContext.getStore()?.BACKEND_API;
      } catch (e) {
        // Fallback
      }
    }

    let response: Response;
    if (import.meta.env.SSR && backendApi && url.startsWith(getApiBaseUrl())) {
      const request = new Request(url, {
        ...options,
        headers,
        signal: AbortSignal.timeout(timeout),
      });
      response = await backendApi.fetch(request);
    } else {
      response = await fetch(url, {
        ...options,
        headers,
        signal: AbortSignal.timeout(timeout),
      });
    }

    const newToken = response.headers.get("X-New-Token");
    if (newToken) {
      jwtToken = newToken;
      const payload = JSON.parse(atob(newToken.split(".")[1]));
      tokenExpiry = payload.exp * 1000;
    }

    if (response.status === 401 && requiresAuth && retries > 0) {
      // CRITICAL: Cancel the response body before retrying to prevent
      // stalled HTTP response deadlocks on Cloudflare Workers
      await response.body?.cancel();
      console.warn("Authentication failed, retrying with new token...");
      jwtToken = null;
      tokenExpiry = null;
      return fetchWithRetry(url, options, retries - 1, timeout, requiresAuth);
    }

    return response;
  } catch (error) {
    if (retries > 0) {
      console.warn(`Fetch to ${url} failed. Retrying... (${retries} left)`);
      await new Promise((resolve) => setTimeout(resolve, 300 * (3 - retries)));
      return fetchWithRetry(url, options, retries - 1, timeout, requiresAuth);
    }
    console.error(`Fetch failed for ${url} after multiple retries.`, error);
    throw error;
  }
}
