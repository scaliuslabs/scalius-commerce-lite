// src/pages/api/ptproxy.ts
// Partytown reverse proxy — fetches third-party scripts on behalf of the
// Partytown web worker so they execute in a same-origin context.
//
// It answers JavaScript from the store's own origin, which every page policy
// allows as 'self', so it must never be usable as a <script src>: only a
// fetch (`Sec-Fetch-Dest: empty`, what Partytown's worker sends) is served,
// only for the container, measurement or pixel ids the store's own Partytown
// tags name, and nothing at all for a store that runs no tag in Partytown.

import type { APIRoute } from "astro";
import { partytownTagAllowed } from "@scalius/shared/store-scripts";
import { getLayoutData } from "@/lib/api/storefront";

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
  // A script, document, frame or worker destination is refused before any read.
  if (request.headers.get("Sec-Fetch-Dest") !== "empty") {
    return new Response("Only a fetch may use this proxy", { status: 403, headers: { Vary: "Sec-Fetch-Dest" } });
  }
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

  // The store's own tags decide: none in Partytown, no proxy; another id, refused.
  const scripts = ((await getLayoutData().catch(() => null))?.analytics ?? [])
    .map((script) => ({ type: script.type, config: script.config, usePartytown: script.usePartytown === true }));
  if (!scripts.some((script) => script.usePartytown)) {
    return new Response("Not found", { status: 404 });
  }
  if (!partytownTagAllowed(parsed, scripts)) {
    return new Response("Tag not allowed", { status: 403 });
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
        // Only this store's own Partytown worker reads it: never shared, and
        // never reused for a request of another destination.
        "Cache-Control": "private, max-age=86400",
        Vary: "Sec-Fetch-Dest",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch {
    return new Response("Upstream fetch failed", { status: 502 });
  }
};
