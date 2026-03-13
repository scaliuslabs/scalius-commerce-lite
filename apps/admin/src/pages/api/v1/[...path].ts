// Proxy all /api/v1/* requests to the standalone API worker.
// - Production: uses Cloudflare Service Binding (zero-latency, no network hop)
// - Local dev: forwards via HTTP to localhost:8787
import type { APIRoute } from "astro";
import { env as cfEnv } from "cloudflare:workers";

export const prerender = false;

export const ALL: APIRoute = async (ctx) => {
  const env = Object.keys(cfEnv).length > 0
    ? (cfEnv as unknown as Env)
    : undefined;

  const url = new URL(ctx.request.url);
  const pathAndQuery = url.pathname + url.search;

  // Production: route through service binding
  if (env?.API) {
    const target = new URL(pathAndQuery, "http://api.internal").toString();
    return env.API.fetch(target, {
      method: ctx.request.method,
      headers: ctx.request.headers,
      body: ctx.request.body,
    });
  }

  // Local dev: forward to API worker via HTTP
  const apiBase =
    (env?.PUBLIC_API_BASE_URL as string | undefined) ||
    "http://localhost:8787";
  const target = new URL(pathAndQuery, apiBase).toString();

  return fetch(target, {
    method: ctx.request.method,
    headers: ctx.request.headers,
    body: ctx.request.body,
    // @ts-ignore — needed for streaming request bodies
    duplex: "half",
  });
};
