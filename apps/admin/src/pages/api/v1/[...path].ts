// Proxy all /api/v1/* requests to the standalone API worker.
// - Production: uses Cloudflare Service Binding (zero-latency, no network hop)
// - Local dev: forwards via HTTP to localhost:8787
//
// The API returns standardized responses: { success: true, data: T }.
// Admin components expect the old flat format (entity fields at the top level).
// This proxy unwraps standardized responses so admin components don't need changes:
//   { success: true, data: { categories: [...], pagination: {...} } }
//   becomes → { success: true, categories: [...], pagination: {...} }
import type { APIRoute } from "astro";
import { env as cfEnv } from "cloudflare:workers";

export const prerender = false;

/**
 * Pass through the standard API envelope as-is.
 * Admin components consume { success, data } directly.
 */
async function passthroughResponse(response: Response): Promise<Response> {
  // Clone headers so we can strip content-length (body may differ after re-reading)
  const headers = new Headers(response.headers);
  headers.delete("content-length");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const ALL: APIRoute = async (ctx) => {
  // Probe known properties — Object.keys() returns [] on CF Workers proxy objects
  const env = (() => {
    try {
      const e = cfEnv as unknown as Env;
      return (e?.API || e?.PUBLIC_API_BASE_URL || e?.ASSETS) ? e : undefined;
    } catch { return undefined; }
  })();

  const url = new URL(ctx.request.url);
  const pathAndQuery = url.pathname + url.search;

  let response: Response;

  // Production: route through service binding
  if (env?.API) {
    const target = new URL(pathAndQuery, "http://api.internal").toString();
    response = await env.API.fetch(target, {
      method: ctx.request.method,
      headers: ctx.request.headers,
      body: ctx.request.body,
    });
  } else {
    // Local dev: forward to API worker via HTTP
    const apiBase =
      (env?.PUBLIC_API_BASE_URL as string | undefined) ||
      "http://localhost:8787";
    const target = new URL(pathAndQuery, apiBase).toString();

    response = await fetch(target, {
      method: ctx.request.method,
      headers: ctx.request.headers,
      body: ctx.request.body,
      // @ts-ignore — needed for streaming request bodies
      duplex: "half",
    });
  }

  return passthroughResponse(response);
};
