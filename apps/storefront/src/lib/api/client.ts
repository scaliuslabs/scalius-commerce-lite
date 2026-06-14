// src/lib/api/client.ts

/**
 * Core API Client for Scalius Commerce
 * Handles request creation, authentication, and resilient fetching.
 *
 * Exports two SDK client instances:
 * - sdkClient: public endpoints (no JWT auth)
 * - sdkAuthClient: authenticated endpoints (JWT auto-attached)
 *
 * Both route through service bindings in production and handle retries.
 * Legacy fetchWithRetry/createApiUrl are preserved for modules that need
 * custom retry/timeout parameters (orders polling, fire-and-forget tracking).
 */

import { getRuntimeApiUrl, getRuntimeApiToken } from "./runtime-env";
import { createClient, createConfig } from "@scalius/api-client/factory";
import type { Client } from "@scalius/api-client/factory";

// Resolve the API base URL lazily (called per-request, not at module init).
//
// In SSR, this module loads once per Worker isolate BEFORE any request's context is set.
// A module-level constant would always resolve to the build-time fallback (empty without .env).
//
// Resolution order:
// 1. SSR runtime: Cloudflare Worker env from runtime-env.ts (wrangler.jsonc vars)
// 2. Client-side: window.__API_BASE_URL__ injected by Layout.astro
// 3. Build-time: import.meta.env.PUBLIC_API_URL (from .env if present)
// Missing configuration fails loudly because storefront does not expose a
// catch-all same-origin /api/v1 proxy.

function getApiBaseUrl(): string {
  // SSR: try runtime env (set per-request by middleware from locals.runtime.env)
  if (import.meta.env.SSR) {
    const runtimeUrl = getRuntimeApiUrl();
    if (runtimeUrl) return runtimeUrl;
  }

  // Client-side: read from injected window var (set by Layout.astro from runtime env)
  if (typeof window !== "undefined" && window.__API_BASE_URL__) {
    return window.__API_BASE_URL__;
  }

  const buildTimeUrl = import.meta.env.PUBLIC_API_URL;
  if (buildTimeUrl) return String(buildTimeUrl);

  throw new Error(
    "PUBLIC_API_URL is not configured. The storefront does not proxy /api/v1; set PUBLIC_API_URL to the API worker URL.",
  );
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
      const apiToken = getRuntimeApiToken();
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

      const json: { success: boolean; data: { token: string } } = await response.json();
      jwtToken = json.data.token;

      if (jwtToken) {
        const payload = JSON.parse(atob(jwtToken.split(".")[1]));
        tokenExpiry = payload.exp * 1000; // Convert to milliseconds
      }

      return jwtToken;
    } catch (error: unknown) {
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

    // Use Cloudflare Service Bindings if available during SSR for 0ms latency.
    // Skip in local dev — each worker runs in a separate miniflare process,
    // so the BACKEND_API Fetcher proxy can't reach the standalone API worker.
    let backendApi: Fetcher | undefined = undefined;
    if (import.meta.env.SSR && !import.meta.env.DEV) {
      try {
        const { apiContext } = await import("./context");
        backendApi = apiContext.getStore()?.BACKEND_API;
      } catch {
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
  } catch (error: unknown) {
    if (retries > 0) {
      console.warn(`Fetch to ${url} failed. Retrying... (${retries} left)`);
      await new Promise((resolve) => setTimeout(resolve, 300 * (3 - retries)));
      return fetchWithRetry(url, options, retries - 1, timeout, requiresAuth);
    }
    console.error(`Fetch failed for ${url} after multiple retries.`, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// SDK Client Instances
// ---------------------------------------------------------------------------
// These use the storefront's service binding + retry infrastructure.
// SDK functions accept { client } to route through these instead of the
// default singleton client.

/**
 * Custom fetch that routes through service bindings in production
 * and applies retry logic. Used as the transport for SDK clients.
 */
function createStorefrontFetch(requiresAuth: boolean): typeof fetch {
  return async (input, init): Promise<Response> => {
    const request = input instanceof Request && init === undefined
      ? input
      : new Request(input, init);
    const url = request.url;
    // Delegate to fetchWithRetry which handles service bindings, retries, auth
    return fetchWithRetry(
      url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body: request.method !== "GET" && request.method !== "HEAD"
          ? await request.text()
          : undefined,
      },
      3,    // retries
      8000, // timeout
      requiresAuth,
    );
  };
}

/** SDK client for public endpoints (no JWT auth). Used by most storefront calls. */
export const sdkClient: Client = createClient(
  createConfig({
    baseUrl: "", // fetchWithRetry resolves the full URL from the request
    fetch: createStorefrontFetch(false),
  }),
);

/** SDK client for authenticated endpoints (JWT auto-attached). */
export const sdkAuthClient: Client = createClient(
  createConfig({
    baseUrl: "", // fetchWithRetry resolves the full URL from the request
    fetch: createStorefrontFetch(true),
  }),
);

/**
 * Get the SDK base URL (root domain, NOT including /api/v1 prefix).
 * SDK route paths already include /api/v1/, so we need just the origin.
 */
function getSdkBaseUrl(): string {
  const apiUrl = getApiBaseUrl();
  // Strip /api/v1 suffix if present — SDK paths already include it
  return apiUrl.replace(/\/api\/v1\/?$/, "") || apiUrl;
}

/**
 * Reconfigure SDK clients with the current base URL.
 * Must be called before any SDK request since base URL is resolved lazily.
 * Returns the configured client for convenience.
 */
export function getConfiguredSdkClient(): Client {
  const baseUrl = getSdkBaseUrl();
  sdkClient.setConfig({ baseUrl });
  return sdkClient;
}

export function getConfiguredSdkAuthClient(): Client {
  const baseUrl = getSdkBaseUrl();
  sdkAuthClient.setConfig({ baseUrl });
  return sdkAuthClient;
}
