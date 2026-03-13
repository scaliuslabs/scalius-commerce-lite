// src/pages/api/__ptproxy.ts
// Partytown reverse proxy — fetches third-party scripts on behalf of the
// Partytown web worker so they execute in a same-origin context.

import type { APIRoute } from "astro";

const ALLOWED_HOSTS = new Set([
  "connect.facebook.net",
  "www.facebook.com",
  "www.googletagmanager.com",
  "www.google-analytics.com",
  "www.googleadservices.com",
  "cdn.jsdelivr.net",
  "static.cloudflareinsights.com",
]);

export const GET: APIRoute = async ({ request }) => {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get("url");

  if (!targetUrl) {
    return new Response("Missing ?url parameter", { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return new Response("Host not allowed", { status: 403 });
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": request.headers.get("User-Agent") || "",
      },
      signal: AbortSignal.timeout(10000),
    });

    const body = await upstream.arrayBuffer();
    const contentType =
      upstream.headers.get("Content-Type") || "application/javascript";

    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400, s-maxage=86400",
      },
    });
  } catch {
    return new Response("Upstream fetch failed", { status: 502 });
  }
};
