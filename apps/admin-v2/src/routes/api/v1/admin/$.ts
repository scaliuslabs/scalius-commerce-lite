/**
 * Admin API proxy — catch-all server route.
 *
 * Forwards all /api/v1/admin/* requests from the browser to the API worker.
 * This replicates the original Astro admin's proxy middleware behavior.
 *
 * In production: uses Cloudflare Service Binding (env.API) for zero-latency.
 * In dev: the Vite proxy handles this, but this route ensures production works.
 *
 * Handles all HTTP methods: GET, POST, PUT, PATCH, DELETE.
 */

import { createFileRoute } from "@tanstack/react-router";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import {
  ADMIN_API_READ_TIMEOUT_CODE,
  AdminApiReadTimeoutError,
  createAdminApiReadTimeout,
  wrapResponseWithAdminApiReadTimeout,
} from "../../../../lib/admin-api-timeout";

function isLocalApiBase(apiBase?: string): boolean {
  if (!apiBase) return false;
  try {
    const { hostname } = new URL(apiBase);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function readTimeoutResponse(error: AdminApiReadTimeoutError): Response {
  return Response.json(
    {
      success: false,
      error: {
        code: ADMIN_API_READ_TIMEOUT_CODE,
        message: error.message,
      },
    },
    { status: error.status },
  );
}

export async function proxyToApi(request: Request): Promise<Response> {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return Response.json(
      { success: false, error: { code: "CROSS_ORIGIN_COOKIE_REQUEST", message: "Cross-origin cookie request denied" } },
      { status: 403 },
    );
  }

  const { env } = await import("cloudflare:workers");
  const url = new URL(request.url);
  const timeout = createAdminApiReadTimeout(request.method, request.signal);

  // Forward the full path (/api/v1/admin/...) to the API worker
  const headers = new Headers(request.headers);

  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (timeout.signal) {
    init.signal = timeout.signal;
  }

  // Forward body for non-GET requests
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // @ts-expect-error -- Cloudflare Workers support duplex streaming
    init.duplex = "half";
  }

  // Production: service binding. In local dev the binding can still exist, but
  // separate Miniflare processes cannot reliably share it.
  const configuredApiBase = env.PUBLIC_API_BASE_URL as string | undefined;
  try {
    if (env.API && !isLocalApiBase(configuredApiBase)) {
      const target = `http://api.internal${url.pathname}${url.search}`;
      const response = await env.API.fetch(target, init);
      return wrapResponseWithAdminApiReadTimeout(response, timeout);
    }

    // Fallback: HTTP to API worker
    const apiBase = configuredApiBase ?? "http://localhost:8787";
    const target = `${apiBase}${url.pathname}${url.search}`;
    const response = await fetch(target, init);
    return wrapResponseWithAdminApiReadTimeout(response, timeout);
  } catch (error) {
    timeout.cleanup();
    if (timeout.didTimeout()) {
      return readTimeoutResponse(new AdminApiReadTimeoutError());
    }
    throw error;
  }
}

export const Route = createFileRoute("/api/v1/admin/$")({
  server: {
    handlers: {
      GET: async ({ request }) => proxyToApi(request),
      POST: async ({ request }) => proxyToApi(request),
      PUT: async ({ request }) => proxyToApi(request),
      PATCH: async ({ request }) => proxyToApi(request),
      DELETE: async ({ request }) => proxyToApi(request),
    },
  },
});
