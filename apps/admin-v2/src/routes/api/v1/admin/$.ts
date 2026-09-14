/**
 * Admin API proxy — catch-all server route.
 *
 * Forwards all /api/v1/admin/* requests from the browser to the API worker.
 * This replicates the original Astro admin's proxy middleware behavior.
 *
 * In production: uses Cloudflare Service Binding (env.API) for zero-latency.
 * In `vite dev`: HTTP to the fixed local API port (the Vite proxy usually
 * answers first, but this route keeps the same behavior).
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

  const { fetchApi, getRuntimeEnv } = await import("../../../../lib/runtime-env.server");
  const env = getRuntimeEnv();
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

  try {
    const response = await fetchApi(env, `${url.pathname}${url.search}`, init);
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
