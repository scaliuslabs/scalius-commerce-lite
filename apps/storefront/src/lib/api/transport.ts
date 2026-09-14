// src/lib/api/transport.ts

/**
 * The storefront's single API transport.
 *
 * One function — `apiFetch(path | url, init, policy)` — owns every server-side
 * call to the API:
 *
 * - Production SSR uses the BACKEND_API service binding (https://api.internal).
 * - Local `astro dev` uses plain HTTP to the fixed local API port, because each
 *   Worker runs in its own miniflare process and the binding cannot reach the
 *   standalone API worker.
 * - A safe public read may fall back once to the public HTTPS API when the
 *   binding read fails or is slow; sensitive reads and every write fail closed.
 * - `auth: true` attaches the system JWT, acquired from /auth/token with the
 *   request's derived API_TOKEN and cached for that request only.
 * - Identical in-flight reads are coalesced per request (`withEdgeCache`).
 *
 * `resolveBackendTarget()` is the same transport for same-origin proxy routes,
 * which forward a browser request verbatim to a fixed internal API path, and
 * the SDK client factories route generated SDK calls through `apiFetch`.
 */

import {
  getRuntime,
  getRuntimeApiToken,
  getRuntimeApiUrl,
  getRuntimeBackendApi,
  getRuntimeInflightReads,
  type StorefrontRuntime,
} from "./runtime";
import { createClient, createConfig } from "@scalius/api-client/factory";
import type { Client } from "@scalius/api-client/factory";
import {
  INTERNAL_SERVICE_ORIGIN,
  LOCAL_DEVELOPMENT_PLATFORM_CONFIG,
} from "@scalius/shared/platform-config";

// Resolved per request, never at module init: this module loads once per Worker
// isolate, before any request runtime is seeded. Order:
// 1. SSR: per-request runtime seeded by the middleware from /api/v1/platform
// 2. Browser: window.__API_BASE_URL__ injected by Layout.astro from that runtime
// 3. Local `astro dev` only: the fixed local API port
// Missing configuration fails loudly because storefront does not expose a
// catch-all same-origin /api/v1 proxy.

const LOCAL_DEVELOPMENT_API_URL = `${LOCAL_DEVELOPMENT_PLATFORM_CONFIG.apiUrl}/api/v1`;

function getApiBaseUrl(): string {
  if (import.meta.env.SSR) {
    const runtimeUrl = getRuntimeApiUrl();
    if (runtimeUrl) return runtimeUrl;
    // The public API origin is a Platform setting saved in the dashboard.
    // Until it exists, server rendering still works through the service
    // binding; only browser-side calls (which need the public origin) wait.
    if (!import.meta.env.DEV && getRuntimeBackendApi()) {
      return `${INTERNAL_SERVICE_ORIGIN}/api/v1`;
    }
  } else if (typeof window !== "undefined" && window.__API_BASE_URL__) {
    return window.__API_BASE_URL__;
  }

  if (import.meta.env.DEV) return LOCAL_DEVELOPMENT_API_URL;

  throw new Error(
    "PUBLIC_API_URL is not configured. The storefront does not proxy /api/v1; set the API URL in the dashboard under Settings -> System -> Platform.",
  );
}

/**
 * Creates a valid API URL by combining the base URL and a given path.
 * @param path The API endpoint path (e.g., "/products/my-slug").
 * @returns The full URL for the API request.
 */
export function createApiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${getApiBaseUrl()}${cleanPath}`;
}

// ---------------------------------------------------------------------------
// Proxy-route target resolution
// ---------------------------------------------------------------------------

export interface BackendTarget {
  /** Absolute URL to request. */
  url: string;
  /** Transport bound to the target; honors a stubbed global fetch in tests. */
  fetch: (input: string | Request, init?: RequestInit) => Promise<Response>;
  viaServiceBinding: boolean;
}

/**
 * Resolves where same-origin proxy routes send API requests.
 *
 * Production: the BACKEND_API service binding with the fixed internal origin.
 * Local `astro dev`: plain HTTP to the fixed local API port. There is no
 * public-URL fallback: a production Worker without the binding fails closed.
 */
export function resolveBackendTarget(
  apiPath: string,
  backendApi: Fetcher | undefined = getRuntimeBackendApi(),
): BackendTarget | null {
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  if (import.meta.env.DEV) {
    return {
      url: `${LOCAL_DEVELOPMENT_PLATFORM_CONFIG.apiUrl}${path}`,
      fetch: (input, init) => fetch(input, init),
      viaServiceBinding: false,
    };
  }
  if (!backendApi) return null;
  return {
    url: `${INTERNAL_SERVICE_ORIGIN}${path}`,
    fetch: (input, init) => backendApi.fetch(input, init),
    viaServiceBinding: true,
  };
}

// ---------------------------------------------------------------------------
// Fallback policy
// ---------------------------------------------------------------------------

const SERVICE_BINDING_READ_TIMEOUT_MS = 2_000;

class StorefrontFetchTimeoutError extends Error {
  constructor(label: string, timeout: number) {
    super(`${label} timed out after ${timeout}ms`);
    this.name = "StorefrontFetchTimeoutError";
  }
}

function isSafeReadMethod(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

function hasSensitiveRequestHeaders(headers: Headers): boolean {
  for (const name of headers.keys()) {
    if (/authorization|cookie|token|session|proof|secret|key/i.test(name)) {
      return true;
    }
  }
  return false;
}

function isPublicApiReadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !/^\/api\/v1\/(auth|customer|checkout|orders?|payments?|refunds?|webhooks?|scanner|setup)\b/i.test(
      url.pathname,
    );
  } catch {
    return false;
  }
}

async function runFetchWithHardTimeout(
  fetcher: (signal: AbortSignal) => Promise<Response>,
  timeout: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const fetchPromise = fetcher(controller.signal);
  const timeoutPromise = new Promise<Response>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = new StorefrontFetchTimeoutError(label, timeout);
      reject(timeoutError);
      controller.abort(timeoutError);
    }, timeout);
  });

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    fetchPromise.catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// System JWT (request-local)
// ---------------------------------------------------------------------------

type ApiJwtState = NonNullable<StorefrontRuntime["apiJwt"]>;

function getRequestJwtState(): ApiJwtState {
  return getRuntime()?.apiJwt ?? {
    token: null,
    expiresAt: null,
    refresh: null,
  };
}

function readJwtExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof decoded.exp === "number" && Number.isFinite(decoded.exp)
      ? decoded.exp * 1000
      : null;
  } catch {
    return null;
  }
}

/**
 * Retrieves a valid JWT token, fetching a new one if necessary.
 * Handles token expiration and pending refresh requests; the credential is
 * cached on the current request's runtime and never at module scope.
 * @returns A promise that resolves to the JWT token or null if authentication fails.
 */
async function getJwtToken(): Promise<string | null> {
  const state = getRequestJwtState();
  const isExpiredOrExpiring =
    !state.token ||
    !state.expiresAt ||
    Date.now() > state.expiresAt - 5 * 60 * 1000;

  if (!isExpiredOrExpiring) {
    return state.token;
  }

  if (state.refresh) {
    return state.refresh;
  }

  state.refresh = (async () => {
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
        await response.body?.cancel();
        console.error("Failed to get storefront API credential:", response.status);
        return null;
      }

      const json: { success: boolean; data: { token: string } } = await response.json();
      state.token = json.data.token;
      state.expiresAt = state.token ? readJwtExpiry(state.token) : null;
      return state.token;
    } catch (error: unknown) {
      console.error("Error getting JWT token:", error);
      return null;
    } finally {
      state.refresh = null;
    }
  })();

  return state.refresh;
}

// ---------------------------------------------------------------------------
// apiFetch
// ---------------------------------------------------------------------------

export interface ApiFetchPolicy {
  /** Retries left after a failed attempt. Default 2. */
  retries?: number;
  /** Hard per-attempt timeout in milliseconds. Default 8000. */
  timeout?: number;
  /** Attach the system JWT (and never cache the response). Default true. */
  auth?: boolean;
  /** Log after the final failed attempt. Default true. */
  logTerminalFailure?: boolean;
}

function isAbsoluteUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/**
 * The storefront's API transport: authentication, service binding, bounded
 * fallback, timeouts, and retries.
 *
 * @param target An API path ("/products/my-slug") or an absolute URL.
 * @param options Standard RequestInit options.
 * @param policy Retry/timeout/auth policy for this call.
 */
export async function apiFetch(
  target: string,
  options: RequestInit = {},
  policy: ApiFetchPolicy = {},
): Promise<Response> {
  const {
    retries = 2,
    timeout = 8000,
    auth: requiresAuth = true,
    logTerminalFailure = true,
  } = policy;
  const url = isAbsoluteUrl(target) ? target : createApiUrl(target);

  let usedServiceBinding = false;
  try {
    const headers = new Headers(options.headers || {});
    const method = (options.method ?? "GET").toUpperCase();
    const canFallbackToHttp =
      !requiresAuth &&
      isSafeReadMethod(method) &&
      !hasSensitiveRequestHeaders(headers) &&
      isPublicApiReadUrl(url);
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
    const backendApi =
      import.meta.env.SSR && !import.meta.env.DEV
        ? getRuntimeBackendApi()
        : undefined;

    let response: Response;
    if (import.meta.env.SSR && backendApi && url.startsWith(getApiBaseUrl())) {
      usedServiceBinding = true;
      const serviceBindingTimeout = canFallbackToHttp
        ? Math.min(timeout, SERVICE_BINDING_READ_TIMEOUT_MS)
        : timeout;
      try {
        response = await runFetchWithHardTimeout(
          (signal) => {
            const request = new Request(url, {
              ...options,
              headers,
              signal,
            });
            return backendApi.fetch(request);
          },
          serviceBindingTimeout,
          "Storefront API service binding",
        );
      } catch (error: unknown) {
        if (!canFallbackToHttp) {
          throw error;
        }
        console.warn(
          `Storefront API service binding read failed for ${url}; falling back to HTTPS API.`,
          error,
        );
        response = await runFetchWithHardTimeout(
          (signal) =>
            fetch(url, {
              ...options,
              headers,
              signal,
            }),
          timeout,
          "Storefront API HTTPS fallback",
        );
      }
    } else {
      response = await runFetchWithHardTimeout(
        (signal) =>
          fetch(url, {
            ...options,
            headers,
            signal,
          }),
        timeout,
        "Storefront API fetch",
      );
    }

    const newToken = response.headers.get("X-New-Token");
    if (newToken) {
      const state = getRequestJwtState();
      state.token = newToken;
      state.expiresAt = readJwtExpiry(newToken);
    }

    if (response.status === 401 && requiresAuth && retries > 0) {
      // CRITICAL: Cancel the response body before retrying to prevent
      // stalled HTTP response deadlocks on Cloudflare Workers
      await response.body?.cancel();
      console.warn("Authentication failed, retrying with new token...");
      const state = getRequestJwtState();
      state.token = null;
      state.expiresAt = null;
      return apiFetch(url, options, { ...policy, retries: retries - 1 });
    }

    return response;
  } catch (error: unknown) {
    if (
      retries > 0 &&
      !usedServiceBinding &&
      !(error instanceof StorefrontFetchTimeoutError)
    ) {
      console.warn(`Fetch to ${url} failed. Retrying... (${retries} left)`);
      await new Promise((resolve) => setTimeout(resolve, 300 * (3 - retries)));
      return apiFetch(url, options, { ...policy, retries: retries - 1 });
    }
    if (logTerminalFailure) {
      console.error(`Fetch failed for ${url} after multiple retries.`, error);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Request-local read coalescing
// ---------------------------------------------------------------------------

/**
 * Deduplicate identical backend reads within one SSR request. Persistent public
 * caching belongs to the native Worker entrypoints; in-flight I/O must never be
 * retained at module scope because Workers can serve concurrent requests from
 * the same isolate.
 */
export async function withEdgeCache<T>(
  key: string,
  fetcher: () => Promise<T | null>,
  _options: { ttlSeconds?: number } = {},
): Promise<T | null> {
  const inflight = getRuntimeInflightReads();
  const existing = inflight?.get(key);
  if (existing) return existing as Promise<T | null>;

  const request = fetcher()
    .catch((error: unknown) => {
      console.error(`[StorefrontData] Fetch failed for ${key}:`, error);
      return null;
    })
    .finally(() => {
      inflight?.delete(key);
    });
  inflight?.set(key, request);
  return request;
}

export const CACHE_TTL = {
  // Native domain purges own freshness; the hour is a failure-only backstop.
  AVAILABILITY: 3_600,
  LONG: 86_400,
  MEDIUM: 3_600,
  SHORT: 300,
} as const;

// ---------------------------------------------------------------------------
// SDK Client Instances
// ---------------------------------------------------------------------------
// These use apiFetch, so generated SDK calls get the same service binding,
// fallback policy, and retries. SDK functions accept { client } to route
// through these instead of the default singleton client.

/**
 * Custom fetch that routes SDK requests through apiFetch.
 */
function createStorefrontFetch(requiresAuth: boolean): typeof fetch {
  return async (input, init): Promise<Response> => {
    const request = input instanceof Request && init === undefined
      ? input
      : new Request(input, init);
    return apiFetch(
      request.url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body: request.method !== "GET" && request.method !== "HEAD"
          ? await request.text()
          : undefined,
      },
      { retries: 3, timeout: 8000, auth: requiresAuth },
    );
  };
}

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
  return createClient(
    createConfig({ baseUrl, fetch: createStorefrontFetch(false) }),
  );
}

export function getConfiguredSdkAuthClient(): Client {
  const baseUrl = getSdkBaseUrl();
  return createClient(
    createConfig({ baseUrl, fetch: createStorefrontFetch(true) }),
  );
}
