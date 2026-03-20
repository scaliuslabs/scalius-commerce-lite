/**
 * SSR-side API fetching for Astro pages.
 *
 * Calls the API worker directly:
 * - Production: via Cloudflare Service Binding (env.API) — zero latency
 * - Local dev: via HTTP to localhost:8787
 *
 * Handles the standard API envelope { success: true, data: T },
 * unwrapping to return T directly.
 *
 * Auth cookies are forwarded via AsyncLocalStorage (request-scoped).
 * The auth middleware calls `setRequestHeaders()` which stores the headers
 * for the duration of that request only — no cross-request leakage.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { env as cfEnv } from "cloudflare:workers";

const API_PATH_PREFIX = "/api/v1/admin";

/**
 * Request-scoped header storage using AsyncLocalStorage.
 * Each request gets its own store — concurrent requests never share state.
 */
const requestHeadersStore = new AsyncLocalStorage<Headers>();

/** Called by middleware to run the request handler with scoped headers. */
export function runWithRequestHeaders<T>(headers: Headers, fn: () => T): T {
  return requestHeadersStore.run(headers, fn);
}

/** Extract cookie and authorization headers for forwarding to the API worker. */
function getForwardHeaders(): HeadersInit {
  const requestHeaders = requestHeadersStore.getStore();
  if (!requestHeaders) return {};
  const forwarded: Record<string, string> = {};
  const cookie = requestHeaders.get("cookie");
  if (cookie) forwarded["cookie"] = cookie;
  const auth = requestHeaders.get("authorization");
  if (auth) forwarded["authorization"] = auth;
  return forwarded;
}

interface ApiEnvelope {
  success: boolean;
  data?: unknown;
  error?: { code?: string; message?: string } | string;
  [key: string]: unknown;
}

/**
 * Resolve the CF env for service binding or fallback URL.
 */
function getEnv(): Record<string, unknown> | undefined {
  try {
    const e = cfEnv as unknown as Record<string, unknown>;
    return e?.API || e?.PUBLIC_API_BASE_URL || e?.ASSETS ? e : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse API response envelope. The API returns { success, data: T }.
 * Returns T directly. Throws on error.
 */
async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `API error: ${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as ApiEnvelope;
      const err = body.error;
      if (typeof err === "string") message = err;
      else if (err && typeof err === "object" && "message" in err)
        message = err.message ?? message;
    } catch {
      // Use default message
    }
    throw new Error(message);
  }

  if (response.status === 204) return undefined as T;

  const body = (await response.json()) as ApiEnvelope;
  if (body.success === false) {
    const err = body.error;
    const msg =
      typeof err === "string"
        ? err
        : err && typeof err === "object" && "message" in err
          ? (err.message ?? "Unknown API error")
          : "Unknown API error";
    throw new Error(msg);
  }

  // API returns { success, data: T } — return data
  // Some endpoints return data at top level (non-standard), handle both
  if (body.data !== undefined) return body.data as T;

  // Fallback: strip success and return the rest
  const { success: _, ...rest } = body;
  return rest as T;
}

/**
 * Build URL path with query params.
 */
function buildPath(path: string, params?: Record<string, string>): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const fullPath = `${API_PATH_PREFIX}${normalizedPath}`;
  if (!params || Object.keys(params).length === 0) return fullPath;
  const sp = new URLSearchParams(params);
  return `${fullPath}?${sp.toString()}`;
}

/**
 * Execute a fetch against the API worker.
 * Uses service binding in production, HTTP in dev.
 */
async function apiFetch(
  method: string,
  path: string,
  options?: { params?: Record<string, string>; body?: unknown },
): Promise<Response> {
  const pathAndQuery = buildPath(path, options?.params);
  const env = getEnv();

  const forwardHeaders = getForwardHeaders();
  const fetchOptions: RequestInit = {
    method,
    headers: {
      ...forwardHeaders,
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  };

  // Production: service binding
  if (env && (env as Record<string, unknown>).API) {
    const target = new URL(pathAndQuery, "http://api.internal").toString();
    return ((env as Record<string, unknown>).API as { fetch: typeof globalThis.fetch }).fetch(target, fetchOptions);
  }

  // Local dev: HTTP to API worker
  const apiBase =
    ((env as Record<string, unknown>)?.PUBLIC_API_BASE_URL as string) ?? "http://localhost:8787";
  const target = new URL(pathAndQuery, apiBase).toString();
  return fetch(target, fetchOptions);
}

/** GET request to the API worker. */
export async function apiGet<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const response = await apiFetch("GET", path, { params });
  return handleResponse<T>(response);
}

/** POST request to the API worker. */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch("POST", path, { body });
  return handleResponse<T>(response);
}

/** PUT request to the API worker. */
export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch("PUT", path, { body });
  return handleResponse<T>(response);
}

/** DELETE request to the API worker. */
export async function apiDelete(path: string): Promise<void> {
  const response = await apiFetch("DELETE", path);
  await handleResponse<void>(response);
}
