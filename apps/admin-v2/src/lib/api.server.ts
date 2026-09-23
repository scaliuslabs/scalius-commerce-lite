/**
 * Server half of the admin API transport (SSR loaders and server functions).
 *
 * Sends a request built by the generated SDK client to the API worker:
 * - Production: Cloudflare Service Binding (env.API)
 * - `vite dev`: HTTP to the fixed local API port (see runtime-env.server)
 *
 * The incoming request's cookie/authorization headers are forwarded, and any
 * Set-Cookie the API returns is appended to the TanStack response. Reads are
 * bounded by the admin read timeout, including while the body streams.
 *
 * IMPORTANT: server-only. Browser code reaches the API through `lib/api.ts`.
 */

import { getRequestHeader, getResponseHeaders } from "@tanstack/react-start/server";
import { splitSetCookieHeader } from "better-auth/cookies";
import {
  AdminApiReadTimeoutError,
  createAdminApiReadTimeout,
  wrapResponseWithAdminApiReadTimeout,
} from "./admin-api-timeout";
import { fetchApi, getRuntimeEnv } from "./runtime-env.server";

type HeadersWithGetSetCookie = Headers & { getSetCookie?: () => string[] };

function forwardIncomingAuthHeaders(headers: Headers): void {
  try {
    const cookie = getRequestHeader("cookie");
    if (cookie) headers.set("cookie", cookie);
    const auth = getRequestHeader("authorization");
    if (auth) headers.set("authorization", auth);
  } catch {
    // Outside a request context (e.g. during build) -- nothing to forward.
  }
}

function propagateResponseSetCookies(response: Response): void {
  const headers = response.headers as HeadersWithGetSetCookie;
  const setCookies = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : splitSetCookieHeader(headers.get("set-cookie") ?? "");
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

/** `fetch` implementation the SDK client uses on the server. */
export async function fetchAdminApiFromServer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  forwardIncomingAuthHeaders(headers);
  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await request.text();
  const timeout = createAdminApiReadTimeout(request.method);

  const init: RequestInit = { method: request.method, headers };
  if (body) init.body = body;
  if (timeout.signal) init.signal = timeout.signal;

  try {
    const response = await fetchApi(getRuntimeEnv(), `${url.pathname}${url.search}`, init);
    propagateResponseSetCookies(response);
    return wrapResponseWithAdminApiReadTimeout(response, timeout);
  } catch (error) {
    timeout.cleanup();
    if (timeout.didTimeout()) throw new AdminApiReadTimeoutError();
    throw error;
  }
}

/** POST a non-admin API endpoint from a server function. Path is relative to /api/v1/. */
export async function apiBasePost<T>(path: string, body?: unknown): Promise<T> {
  const { apiClient, apiData } = await import("./api");
  return apiData(apiClient.post({ url: `/api/v1${path}`, body })) as Promise<T>;
}
