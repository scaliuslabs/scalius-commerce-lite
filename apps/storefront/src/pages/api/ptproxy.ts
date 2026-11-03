// src/pages/api/ptproxy.ts
// Partytown reverse proxy — fetches third-party scripts on behalf of the
// Partytown web worker so they execute in a same-origin context.

import type { APIRoute } from "astro";

// Exactly the script hosts `resolveUrl` in lib/partytown-config.ts proxies,
// each with the script paths the analytics tags load through Partytown (the
// tag, and the config and plugin files it pulls in). Any other path on an
// allowed host is refused: these hosts serve other files, and the proxy
// answers from the merchant's origin. Never add a shared CDN (for example
// cdn.jsdelivr.net): it would let anyone serve arbitrary JavaScript from the
// merchant's origin.
const ALLOWED_SCRIPT_PATHS: Record<string, readonly RegExp[]> = {
  // Meta Pixel: the loader per locale, then the pixel's config and plugins.
  "connect.facebook.net": [
    /^\/[a-z]{2}_[A-Z]{2}\/fbevents\.js$/,
    /^\/signals\/config\/\d{1,32}$/,
    /^\/signals\/plugins\/[A-Za-z0-9._-]{1,64}\.js$/,
  ],
  // TikTok Pixel: events.js and the files it loads beside it.
  "analytics.tiktok.com": [/^\/i18n\/pixel\/[A-Za-z0-9._/-]{1,128}\.js$/],
  // Google Tag Manager and gtag.js.
  "www.googletagmanager.com": [/^\/gtm\.js$/, /^\/gtag\/js$/, /^\/gtag\/destination$/],
  // Universal Analytics (analytics.js) and its plugins.
  "www.google-analytics.com": [
    /^\/analytics\.js$/,
    /^\/analytics_debug\.js$/,
    /^\/ga\.js$/,
    /^\/plugins\/ua\/[A-Za-z0-9._-]{1,64}\.js$/,
  ],
};

const ALLOWED_PROTOCOLS = new Set(["https:"]);

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

  const allowedPaths = Object.hasOwn(ALLOWED_SCRIPT_PATHS, parsed.hostname)
    ? ALLOWED_SCRIPT_PATHS[parsed.hostname]
    : undefined;
  if (!allowedPaths) {
    return new Response("Host not allowed", { status: 403 });
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return new Response("Protocol not allowed", { status: 403 });
  }

  if (!allowedPaths.some((path) => path.test(parsed.pathname))) {
    return new Response("Path not allowed", { status: 403 });
  }

  try {
    // Never follow a redirect: the allowlist judged this URL, not wherever
    // an upstream (or a hijacked path) points next.
    const upstream = await fetch(parsed.toString(), {
      headers: {
        "User-Agent": request.headers.get("User-Agent") || "",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });

    if (
      upstream.type === "opaqueredirect" ||
      upstream.status < 200 ||
      upstream.status >= 300
    ) {
      return new Response("Upstream did not return a script", { status: 502 });
    }

    const body = await upstream.arrayBuffer();

    // Always a script, whatever the upstream claims: an HTML or other
    // document served from the merchant's origin must never render as one.
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400, s-maxage=86400",
      },
    });
  } catch {
    return new Response("Upstream fetch failed", { status: 502 });
  }
};
