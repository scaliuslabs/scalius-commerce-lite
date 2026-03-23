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

async function proxyToApi(request: Request): Promise<Response> {
  const { env } = await import("cloudflare:workers");
  const url = new URL(request.url);

  // Forward the full path (/api/v1/admin/...) to the API worker
  const headers = new Headers(request.headers);

  const init: RequestInit = {
    method: request.method,
    headers,
  };

  // Forward body for non-GET requests
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // @ts-expect-error -- Cloudflare Workers support duplex streaming
    init.duplex = "half";
  }

  // Production: service binding
  if (env.API) {
    const target = `http://api.internal${url.pathname}${url.search}`;
    return env.API.fetch(target, init);
  }

  // Fallback: HTTP to API worker
  const apiBase =
    (env.PUBLIC_API_BASE_URL as string) ?? "http://localhost:8787";
  const target = `${apiBase}${url.pathname}${url.search}`;
  return fetch(target, init);
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
