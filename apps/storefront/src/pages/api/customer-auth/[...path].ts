// Same-origin proxy for customer auth endpoints.
//
// The storefront (store.wrygo.com) and API (api.scalius.com) are on
// different domains. Modern browsers silently drop cross-origin
// Set-Cookie headers, even with SameSite=None + credentials:include.
//
// This proxy ensures all customer auth requests go through the
// storefront's own origin so cookies (cs_tok, cs_auth) are set and
// sent correctly.
//
// Production: routes through BACKEND_API service binding (zero latency).
// Local dev: forwards via HTTP to the API worker.

import type { APIRoute } from "astro";
import { env as cfEnv } from "cloudflare:workers";

export const prerender = false;

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const ALL: APIRoute = async ({ request, params }) => {
  const subpath = params.path || "";
  const apiPath = `/api/v1/customer-auth/${subpath}`;

  if (!ALLOWED_METHODS.has(request.method)) {
    return new Response("Method not allowed", { status: 405 });
  }

  // Resolve Cloudflare env (probe properties, not Object.keys)
  const env = (() => {
    try {
      const e = cfEnv as unknown as Env;
      return (e?.BACKEND_API || e?.PUBLIC_API_BASE_URL || e?.ASSETS) ? e : undefined;
    } catch { return undefined; }
  })();

  // Build the target URL
  let targetUrl: string;
  let fetcher: typeof fetch = fetch;

  if (env?.BACKEND_API) {
    // Production: service binding (zero-latency internal routing)
    targetUrl = `http://api.internal${apiPath}`;
    fetcher = env.BACKEND_API.fetch.bind(env.BACKEND_API);
  } else {
    // Local dev: HTTP to API worker
    const apiBase = (env?.PUBLIC_API_BASE_URL as string) || "http://localhost:8787";
    targetUrl = `${apiBase}${apiPath}`;
  }

  // Forward the request, preserving method, headers, and body
  const headers = new Headers(request.headers);
  // Remove host header so the API worker gets the correct one
  headers.delete("host");

  try {
    const apiResponse = await fetcher(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
      // @ts-ignore — needed for streaming request bodies in non-service-binding path
      ...(env?.BACKEND_API ? {} : { duplex: "half" }),
    });

    // Build the response, passing through status, body, and headers
    const responseHeaders = new Headers();

    // Copy all headers from API response
    for (const [key, value] of apiResponse.headers.entries()) {
      // Skip hop-by-hop headers
      if (key.toLowerCase() === "transfer-encoding") continue;
      responseHeaders.append(key, value);
    }

    return new Response(apiResponse.body, {
      status: apiResponse.status,
      statusText: apiResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err: any) {
    console.error("[customer-auth proxy] Error:", err?.message || err);
    return new Response(JSON.stringify({ error: "Proxy error" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
};
