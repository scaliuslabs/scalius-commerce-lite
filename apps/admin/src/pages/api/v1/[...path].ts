// Proxy all /api/v1/* requests to the standalone API worker.
// - Production: uses Cloudflare Service Binding (zero-latency, no network hop)
// - Local dev: forwards via HTTP to localhost:8787
//
// The API returns standardized responses: { success: true, data: T }.
// This proxy passes responses through unchanged.
import type { APIRoute } from "astro";
import { env as cfEnv } from "cloudflare:workers";

export const prerender = false;

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

  return response;
};
