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
 * For JSON responses with `{ success: true, data: T }`, flatten them back
 * to `{ success: true, ...T }` so admin components can read fields directly.
 */
async function unwrapStandardizedResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") || "";
  const status = response.status;

  // Only unwrap successful JSON responses (200, 201)
  if ((status !== 200 && status !== 201) || !contentType.includes("application/json")) {
    return response;
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    return response;
  }

  try {
    const body = JSON.parse(bodyText) as Record<string, unknown>;

    // Check if it's a standardized response: { success: true, data: T }
    if (
      body &&
      typeof body === "object" &&
      body.success === true &&
      "data" in body &&
      body.data !== null &&
      typeof body.data === "object" &&
      !Array.isArray(body.data)
    ) {
      // Flatten: spread data fields to top level, keep success and other top-level fields
      const { data, ...rest } = body;
      const flattened = { ...rest, ...(data as Record<string, unknown>) };

      const headers = new Headers(response.headers);
      headers.delete("content-length");

      return new Response(JSON.stringify(flattened), {
        status,
        statusText: response.statusText,
        headers,
      });
    }
  } catch {
    // JSON parse failed — return raw text as response
  }

  // Not a standardized response or parse failed — return original body
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(bodyText, {
    status,
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

  return unwrapStandardizedResponse(response);
};
