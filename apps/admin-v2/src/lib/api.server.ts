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

import { getRequestHeader, getResponseHeaders } from "@tanstack/react-start/server";
import { env as cfEnv } from "cloudflare:workers";
import { splitSetCookieHeader } from "better-auth/cookies";
import {
  type AdminApiReadTimeoutHandle,
  AdminApiReadTimeoutError,
  createAdminApiReadTimeout,
  wrapResponseWithAdminApiReadTimeout,
} from "./admin-api-timeout";

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

type HeadersWithGetSetCookie = Headers & { getSetCookie?: () => string[] };

function isLocalApiBase(apiBase?: string): boolean {
  if (!apiBase) return false;
  try {
    const { hostname } = new URL(apiBase);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * Extract cookie and authorization headers for forwarding to the API worker.
 * Uses TanStack Start's request context (no AsyncLocalStorage needed).
 *
 * The session cookie is forwarded so the API worker validates it via Better Auth.
 * Both workers MUST share the same BETTER_AUTH_SECRET for this to work.
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
  return forwarded;
}

function getSetCookieValues(headers: Headers): string[] {
  const headersWithCookies = headers as HeadersWithGetSetCookie;
  if (typeof headersWithCookies.getSetCookie === "function") {
    return headersWithCookies.getSetCookie();
  }
  return splitSetCookieHeader(headers.get("set-cookie") ?? "");
}

function propagateResponseSetCookies(response: Response): void {
  const setCookies = getSetCookieValues(response.headers);
  if (setCookies.length === 0) return;

  try {
    const responseHeaders = getResponseHeaders();
    for (const cookie of setCookies) {
      responseHeaders.append("set-cookie", cookie);
    }
  } catch {
    // Outside a TanStack request context (build/tests) -- no response to mutate.
  }
}

/**
 * Parse API response envelope. The API returns { success, data: T }.
 * Returns T directly. Throws on error.
 */
async function handleResponse<T>(response: Response): Promise<T> {
  propagateResponseSetCookies(response);

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
  options?: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<{ response: Response; timeout: AdminApiReadTimeoutHandle }> {
  const cfEnv = getCfEnv();
  const forwardHeaders = getForwardHeaders();
  const timeout = createAdminApiReadTimeout(method, options?.signal);

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
  if (timeout.signal) {
    fetchOptions.signal = timeout.signal;
  }

  try {
    // Production: service binding. In local dev the binding may still be present
    // from wrangler.jsonc, but the API runs in a separate Miniflare process.
    const configuredApiBase = cfEnv.PUBLIC_API_BASE_URL as string | undefined;
    if (cfEnv.API && !isLocalApiBase(configuredApiBase)) {
      const target = `http://api.internal${fullPath}`;
      const resp = await cfEnv.API.fetch(target, fetchOptions);
      return { response: resp, timeout };
    }

    // Local dev: HTTP to API worker
    const apiBase = configuredApiBase ?? "http://localhost:8787";
    const target = `${apiBase}${fullPath}`;
    const resp = await fetch(target, fetchOptions);
    return { response: resp, timeout };
  } catch (error) {
    timeout.cleanup();
    if (timeout.didTimeout()) {
      throw new AdminApiReadTimeoutError();
    }
    throw error;
  }
}

async function readApiFetch<T>(
  method: string,
  fullPath: string,
  options: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } | undefined,
  readResponse: (response: Response) => Promise<T>,
): Promise<T> {
  const { response, timeout } = await apiFetchRaw(method, fullPath, options);
  try {
    return await readResponse(response);
  } catch (error) {
    if (timeout.didTimeout()) {
      throw new AdminApiReadTimeoutError();
    }
    throw error;
  } finally {
    timeout.cleanup();
  }
}

// ─── Public helpers (admin endpoints) ─────────────────────────────

/** GET request to an admin API endpoint. Path is relative to /api/v1/admin/. */
export async function apiGet<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const fullPath = buildPath(path, params);
  return readApiFetch("GET", fullPath, undefined, handleResponse<T>);
}

/** GET request returning raw text (for text/plain endpoints like ai-prompts). */
export async function apiGetText(
  path: string,
  params?: Record<string, string>,
): Promise<string> {
  const fullPath = buildPath(path, params);
  return readApiFetch("GET", fullPath, undefined, async (response) => {
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    return response.text();
  });
}

/** POST request to an admin API endpoint. */
export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const fullPath = buildPath(path);
  return readApiFetch("POST", fullPath, { body }, handleResponse<T>);
}

/** PUT request to an admin API endpoint. */
export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const fullPath = buildPath(path);
  return readApiFetch("PUT", fullPath, { body }, handleResponse<T>);
}

/** PATCH request to an admin API endpoint. */
export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const fullPath = buildPath(path);
  return readApiFetch("PATCH", fullPath, { body }, handleResponse<T>);
}

/** DELETE request to an admin API endpoint. */
export async function apiDelete<T = void>(path: string, body?: unknown): Promise<T> {
  const fullPath = buildPath(path);
  return readApiFetch(
    "DELETE",
    fullPath,
    body ? { body } : undefined,
    handleResponse<T>,
  );
}

// ─── Public helpers (non-admin endpoints: auth, setup, cache) ─────

/** GET request to a non-admin API endpoint. Path is relative to /api/v1/. */
export async function apiBaseGet<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const fullPath = buildPath(path, params, false);
  return readApiFetch("GET", fullPath, undefined, handleResponse<T>);
}

/** POST request to a non-admin API endpoint. */
export async function apiBasePost<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  const fullPath = buildPath(path, undefined, false);
  return readApiFetch("POST", fullPath, { body }, handleResponse<T>);
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
    signal?: AbortSignal;
    prefixed?: boolean;
  },
): Promise<Response> {
  const fullPath = buildPath(path, options?.params, options?.prefixed ?? true);
  const { response, timeout } = await apiFetchRaw(method, fullPath, {
    body: options?.body,
    headers: options?.headers,
    signal: options?.signal,
  });
  return wrapResponseWithAdminApiReadTimeout(response, timeout);
}
