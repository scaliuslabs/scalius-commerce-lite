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
  MAX_STOREFRONT_BATCH_PARTS,
  STOREFRONT_BATCH_PATH,
  storefrontBatchPart,
  storefrontBatchPath,
  type StorefrontBatchResponse,
} from "@scalius/shared/public-api-cache-routes";
import {
  getRuntime,
  requestRuntime,
  getRuntimeApiToken,
  getRuntimeApiUrl,
  getRuntimeBackendApi,
  getRuntimeCacheGeneration,
  getRuntimeInflightReads,
  type StorefrontRuntime,
} from "./runtime";
import { CACHE_GENERATION_HEADER } from "@scalius/shared/cache-generation";
import { markPageUnproven, recordPagePart } from "../page-dependencies";
import { createClient, createConfig } from "@scalius/api-client/factory";
import type { Client } from "@scalius/api-client/factory";
import {
  INTERNAL_SERVICE_ORIGIN,
  LOCAL_DEVELOPMENT_PLATFORM_CONFIG,
  isInternalServiceUrl,
} from "@scalius/shared/platform-config";

// Resolved per request, never at module init: this module loads once per Worker
// isolate, before any request runtime is seeded. Order:
// 1. SSR: per-request runtime seeded by the middleware from the layout payload
// 2. Browser: window.__API_BASE_URL__ injected by Layout.astro from that runtime
// 3. Local `astro dev` only: the local API port (scripts/dev-ports.mjs)
// Missing configuration fails loudly because storefront does not expose a
// catch-all same-origin /api/v1 proxy.

/**
 * The API origin `astro dev` calls: SCALIUS_DEV_API_PORT through the Vite
 * define in astro.config.mjs, else the default local port (tests).
 */
function localDevelopmentApiOrigin(): string {
  return typeof __SCALIUS_DEV_API_ORIGIN__ === "string" && __SCALIUS_DEV_API_ORIGIN__
    ? __SCALIUS_DEV_API_ORIGIN__
    : LOCAL_DEVELOPMENT_PLATFORM_CONFIG.apiUrl;
}

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

  if (import.meta.env.DEV) return `${localDevelopmentApiOrigin()}/api/v1`;

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
 * Local `astro dev`: plain HTTP to the local API port. There is no
 * public-URL fallback: a production Worker without the binding fails closed.
 */
export function resolveBackendTarget(
  apiPath: string,
  backendApi: Fetcher | undefined = getRuntimeBackendApi(),
): BackendTarget | null {
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  if (import.meta.env.DEV) {
    return {
      url: `${localDevelopmentApiOrigin()}${path}`,
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
  /** Let this read join the render's read batch. Default true. */
  batch?: boolean;
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
  if (import.meta.env.SSR && !requiresAuth && policy.batch !== false) {
    const batched = joinReadBatch(url, options, policy);
    if (batched) return batched;
  }
  // Only batch parts carry a dependency proof; a page that read anything
  // else is never stored under a dependency-validated key.
  if (import.meta.env.SSR && !isReadBatchUrl(url)) markPageUnproven(getRuntime()?.pageDependencies);

  let usedServiceBinding = false;
  try {
    const headers = new Headers(options.headers || {});
    const method = (options.method ?? "GET").toUpperCase();
    const canFallbackToHttp =
      !requiresAuth &&
      isSafeReadMethod(method) &&
      !hasSensitiveRequestHeaders(headers) &&
      isPublicApiReadUrl(url);
    // A cached page and the API reads it is built from share one generation,
    // even while the KV mirror of a newer generation is still propagating.
    const cacheGeneration = getRuntimeCacheGeneration();
    if (cacheGeneration && canFallbackToHttp) {
      headers.set(CACHE_GENERATION_HEADER, cacheGeneration);
    }
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
      // The short deadline only buys an HTTPS retry. A read addressed to the
      // internal origin (the platform API URL is not known yet, as for a
      // render's first batch) has no public URL to retry, so cutting it short
      // would only turn a slow cold read into an error page.
      const canRetryOverHttps = canFallbackToHttp && !isInternalServiceUrl(url);
      const serviceBindingTimeout = canRetryOverHttps
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
        if (!canRetryOverHttps) {
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
// Render read batch
// ---------------------------------------------------------------------------

const BATCHABLE_HEADERS = new Set(["accept", "content-type"]);
const BATCH_TIMEOUT_MS = 8_000;

interface BatchedRead {
  url: string;
  options: RequestInit;
  policy: ApiFetchPolicy;
  part: string;
  resolve(response: Response): void;
  reject(error: unknown): void;
}

export interface PendingReadBatch {
  origin: string;
  reads: BatchedRead[];
}

/**
 * Public cached reads a render starts together (layout, page data, shipping,
 * checkout settings) travel as one `GET /api/v1/storefront/batch` instead of
 * one service binding call each: one hop, one API invocation, and parts served
 * from the API's generation-keyed cache. Reads join the batch until the
 * current task yields (setTimeout 0); a lone read is sent as itself.
 */
function joinReadBatch(
  url: string,
  options: RequestInit,
  policy: ApiFetchPolicy,
): Promise<Response> | null {
  const runtime = getRuntime();
  if (!runtime || options.body != null || options.signal) return null;
  if ((options.method ?? "GET").toUpperCase() !== "GET") return null;
  for (const name of new Headers(options.headers ?? {}).keys()) {
    if (!BATCHABLE_HEADERS.has(name)) return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!url.startsWith(getApiBaseUrl())) return null;
  const part = storefrontBatchPart(parsed);
  if (!part) return null;

  if (runtime.readBatch && runtime.readBatch.origin !== parsed.origin) return null;
  let batch = runtime.readBatch ?? openReadBatch(runtime, parsed.origin);
  if (batch.reads.length >= MAX_STOREFRONT_BATCH_PARTS) {
    // A page whose proof is collected never reads outside a batch: a full
    // batch starts the next one instead.
    if (!runtime.pageDependencies) return null;
    batch = openReadBatch(runtime, parsed.origin);
  }
  const read = batch.reads;
  return new Promise<Response>((resolve, reject) => {
    read.push({ url, options, policy, part, resolve, reject });
  });
}

/** A new pending batch, flushed once the current task yields. */
function openReadBatch(runtime: StorefrontRuntime, origin: string): PendingReadBatch {
  const batch: PendingReadBatch = { origin, reads: [] };
  runtime.readBatch = batch;
  setTimeout(() => {
    requestRuntime.run(runtime, () => void flushReadBatch(runtime, batch));
  }, 0);
  return batch;
}

function isReadBatchUrl(url: string): boolean {
  try {
    return new URL(url).pathname === STOREFRONT_BATCH_PATH;
  } catch {
    return false;
  }
}

function sendAlone(read: BatchedRead): void {
  apiFetch(read.url, read.options, { ...read.policy, batch: false }).then(read.resolve, read.reject);
}

async function flushReadBatch(
  runtime: StorefrontRuntime,
  batch: PendingReadBatch,
): Promise<void> {
  if (runtime.readBatch === batch) runtime.readBatch = null;
  const { reads } = batch;
  const dependencies = runtime.pageDependencies;
  // A lone read is sent as itself, unless the page's proof is collected: only
  // a batch part carries one.
  if (reads.length === 1 && !dependencies) {
    sendAlone(reads[0]!);
    return;
  }
  const parts = [...new Set(reads.map((read) => read.part))];
  let payload: StorefrontBatchResponse | null = null;
  try {
    const response = await apiFetch(
      `${batch.origin}${storefrontBatchPath(parts)}`,
      {},
      { auth: false, batch: false, retries: 1, timeout: BATCH_TIMEOUT_MS },
    );
    if (response.ok) {
      const envelope = (await response.json()) as { data?: StorefrontBatchResponse };
      if (envelope.data?.parts?.length === parts.length) payload = envelope.data;
    } else {
      await response.body?.cancel();
    }
  } catch (error: unknown) {
    markPageUnproven(dependencies);
    for (const read of reads) read.reject(error);
    return;
  }
  if (!payload) {
    markPageUnproven(dependencies);
    // An API without the batch route (mid-deploy): send each read itself.
    for (const read of reads) sendAlone(read);
    return;
  }
  const byPart = new Map(parts.map((part, index) => [part, payload!.parts[index]!]));
  for (const read of reads) {
    const result = byPart.get(read.part)!;
    recordPagePart(dependencies, result.cache);
    read.resolve(new Response(result.body, {
      status: result.status,
      headers: { "Content-Type": result.contentType },
    }));
  }
}

// ---------------------------------------------------------------------------
// Request-local read coalescing
// ---------------------------------------------------------------------------

/**
 * Deduplicate identical backend reads within one SSR request. Persistent public
 * caching is keyed by the store cache generation; in-flight I/O must never be
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

// Accepted by `withEdgeCache` call sites but unused: persistent freshness comes
// from the store's cache generation (@scalius/shared/cache-generation).
export const CACHE_TTL = {
  AVAILABILITY: 0,
  LONG: 0,
  MEDIUM: 0,
  SHORT: 0,
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
