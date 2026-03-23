/**
 * Server-only API helper for TanStack Start.
 *
 * Calls the API worker directly:
 * - Production: via Cloudflare Service Binding (env.API) -- zero latency
 * - Local dev: via HTTP to localhost:8787
 *
 * Handles the standard API envelope { success: true, data: T },
 * unwrapping to return T directly.
 *
 * Auth cookies are forwarded from the incoming request via
 * TanStack Start's getRequestHeader().
 *
 * IMPORTANT: This file is .server.ts -- it must NEVER be imported
 * from client-side code. Only import inside createServerFn handlers
 * or other .server.ts files.
 */

import { getRequestHeader } from "@tanstack/react-start/server";
import { env as cfEnv } from "cloudflare:workers";

// Admin API prefix -- all admin endpoints live under this path
const API_PATH_PREFIX = "/api/v1/admin";

// Non-admin prefix for auth/setup/cache endpoints
const API_BASE_PREFIX = "/api/v1";

/**
 * Access Cloudflare bindings.
 */
function getCfEnv(): Env {
  return cfEnv;
}

interface ApiEnvelope {
  success: boolean;
  data?: unknown;
  error?: { code?: string; message?: string } | string;
  [key: string]: unknown;
}

/**
 * Extract cookie and authorization headers for forwarding to the API worker.
 * Uses TanStack Start's request context (no AsyncLocalStorage needed).
 *
 * Falls back to API_TOKEN for service-binding auth when cookies are unavailable
 * (e.g. during SSR when getRequestHeader context may not be set).
 */
function getForwardHeaders(): Record<string, string> {
  const forwarded: Record<string, string> = {};
  try {
    const cookie = getRequestHeader("cookie");
    if (cookie) forwarded["cookie"] = cookie;
    const auth = getRequestHeader("authorization");
    if (auth) forwarded["authorization"] = auth;
  } catch {
    // Outside request context (e.g. during build) -- no headers to forward
  }

  // Fallback: if no cookie or auth, send API_TOKEN for service-binding auth
  if (!forwarded["cookie"] && !forwarded["authorization"]) {
    try {
      const env = getCfEnv();
      if (env.API_TOKEN) {
        forwarded["x-api-token"] = env.API_TOKEN as string;
      }
    } catch {
      // env not available
    }
  }

  return forwarded;
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

  // Standard envelope: { success, data: T } -- return data
  if (body.data !== undefined) return body.data as T;

  // Fallback: strip success and return the rest
  const { success: _, ...rest } = body;
  return rest as T;
}

/**
 * Build URL path with query params.
 * @param path - Path after /api/v1/admin/ (or full path if prefixed=false)
 * @param params - Query parameters
 * @param prefixed - If true (default), prepends API_PATH_PREFIX
 */
function buildPath(
  path: string,
  params?: Record<string, string>,
  prefixed = true,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const fullPath = prefixed
    ? `${API_PATH_PREFIX}${normalizedPath}`
    : `${API_BASE_PREFIX}${normalizedPath}`;
  if (!params || Object.keys(params).length === 0) return fullPath;
  const sp = new URLSearchParams(params);
  return `${fullPath}?${sp.toString()}`;
}

/**
 * Execute a fetch against the API worker.
 * Uses service binding in production, HTTP in dev.
 */
async function apiFetchRaw(
  method: string,
  fullPath: string,
  options?: { body?: unknown; headers?: Record<string, string> },
): Promise<Response> {
  const cfEnv = getCfEnv();
  const forwardHeaders = getForwardHeaders();

  const headers: Record<string, string> = {
    ...forwardHeaders,
    ...(options?.headers ?? {}),
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
  };

  const fetchOptions: RequestInit = {
    method,
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  };

  // Production: service binding (env.API exists)
  if (cfEnv.API) {
    const target = `http://api.internal${fullPath}`;
    return cfEnv.API.fetch(target, fetchOptions);
  }

  // Local dev: HTTP to API worker
  const apiBase = cfEnv.PUBLIC_API_BASE_URL as string ?? "http://localhost:8787";
  const target = `${apiBase}${fullPath}`;
  return fetch(target, fetchOptions);
}

// ─── Public helpers (admin endpoints) ─────────────────────────────

/** GET request to an admin API endpoint. Path is relative to /api/v1/admin/. */
export async function apiGet<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const fullPath = buildPath(path, params);
  const response = await apiFetchRaw("GET", fullPath);
  return handleResponse<T>(response);
}

/** GET request returning raw text (for text/plain endpoints like ai-prompts). */
export async function apiGetText(
  path: string,
  params?: Record<string, string>,
): Promise<string> {
  const fullPath = buildPath(path, params);
  const response = await apiFetchRaw("GET", fullPath);
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

/** POST request to an admin API endpoint. */
export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const fullPath = buildPath(path);
  const response = await apiFetchRaw("POST", fullPath, { body });
  return handleResponse<T>(response);
}

/** PUT request to an admin API endpoint. */
export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const fullPath = buildPath(path);
  const response = await apiFetchRaw("PUT", fullPath, { body });
  return handleResponse<T>(response);
}

/** PATCH request to an admin API endpoint. */
export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const fullPath = buildPath(path);
  const response = await apiFetchRaw("PATCH", fullPath, { body });
  return handleResponse<T>(response);
}

/** DELETE request to an admin API endpoint. */
export async function apiDelete<T = void>(path: string, body?: unknown): Promise<T> {
  const fullPath = buildPath(path);
  const response = await apiFetchRaw("DELETE", fullPath, body ? { body } : undefined);
  return handleResponse<T>(response);
}

// ─── Public helpers (non-admin endpoints: auth, setup, cache) ─────

/** GET request to a non-admin API endpoint. Path is relative to /api/v1/. */
export async function apiBaseGet<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const fullPath = buildPath(path, params, false);
  const response = await apiFetchRaw("GET", fullPath);
  return handleResponse<T>(response);
}

/** POST request to a non-admin API endpoint. */
export async function apiBasePost<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  const fullPath = buildPath(path, undefined, false);
  const response = await apiFetchRaw("POST", fullPath, { body });
  return handleResponse<T>(response);
}

/**
 * Raw fetch to API worker (returns Response, does not unwrap envelope).
 * Useful for endpoints that return non-standard responses (e.g. file uploads).
 */
export async function apiRawFetch(
  method: string,
  path: string,
  options?: {
    params?: Record<string, string>;
    body?: unknown;
    headers?: Record<string, string>;
    prefixed?: boolean;
  },
): Promise<Response> {
  const fullPath = buildPath(path, options?.params, options?.prefixed ?? true);
  return apiFetchRaw(method, fullPath, {
    body: options?.body,
    headers: options?.headers,
  });
}
