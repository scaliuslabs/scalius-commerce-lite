// src/middleware.ts

import { defineMiddleware, sequence } from "astro:middleware";
import { env as cfEnv } from "cloudflare:workers";
import { apiContext } from "@/lib/api/context";
import { setRuntimeEnv } from "@/lib/api/runtime-env";
import { setPageCspHeader } from "@/lib/middleware-helper/csp-handler";
import { setEdgeCacheContext } from "@/lib/edge-cache";
import { BUILD_ID } from "@/config/build-id";

// Timeout constants to prevent hanging on slow/unavailable services
const KV_TIMEOUT_MS = 1000;
const CACHE_MATCH_TIMEOUT_MS = 500;

const CACHE_VERSION_KEY_PREFIX = "v_";

const CACHEABLE_PATHS = [
  /^\/$/,
  /^\/products\/[^/]+$/,
  /^\/categories\/[^/]+$/,
  /^\/search\/?$/,
  /^\/sitemap\.xml$/,
  /^\/sitemap-.*\.xml$/,
  /^\/(?!api|cart|checkout|buy|order-success|account|health|robots\.txt)[^/.]*$/,
];

/**
 * Query params that should NOT affect HTML caching.
 * These are typically marketing / tracking parameters.
 */
const CACHE_KEY_IGNORED_QUERY_PARAMS = [
  "fbclid",
  "gclid",
  "msclkid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
];

// Check if we're running in Cloudflare Workers environment
const isCloudflareEnvironment = () => {
  return typeof caches !== "undefined";
};

function buildCacheKeyUrl(url: URL): URL {
  const cacheUrl = new URL(url.toString());

  // Remove tracking params from the CACHE KEY (not from the real request URL).
  for (const param of CACHE_KEY_IGNORED_QUERY_PARAMS) {
    cacheUrl.searchParams.delete(param);
  }

  // Product variant selection is client-side. It should not explode cache entries.
  if (/^\/products\/[^/]+$/.test(cacheUrl.pathname)) {
    cacheUrl.searchParams.delete("size");
    cacheUrl.searchParams.delete("color");
  }

  return cacheUrl;
}

// Resolve Cloudflare env — in production `cfEnv` is populated by the adapter;
// in local dev (wrangler) it may be empty, so fall back gracefully.
//
// IMPORTANT: Do NOT use Object.keys(cfEnv) to check for population.
// In some Cloudflare Workers runtimes, env is a Proxy where Object.keys()
// returns [] even though property access works. Instead, probe a known
// binding (ASSETS is always present for Astro CF adapter).
function getEnv(): Env | null {
  try {
    if (cfEnv != null && ((cfEnv as any).ASSETS || (cfEnv as any).CDN_DOMAIN_URL || (cfEnv as any).PUBLIC_API_URL)) {
      return cfEnv as unknown as Env;
    }
  } catch {
    // cfEnv not available (e.g. `astro dev` without wrangler)
  }
  return null;
}

const cachingMiddleware = defineMiddleware(async (context, next) => {
  const { request, url, locals } = context;
  const hostname = url.hostname;

  const isCacheablePath = CACHEABLE_PATHS.some((regex) =>
    regex.test(url.pathname),
  );
  const isGetRequest = request.method === "GET";

  // Only enable caching if we're in Cloudflare environment and have KV binding
  const isCloudflareEnv = isCloudflareEnvironment();
  const env = getEnv();
  const kvBinding = env?.CACHE_CONTROL;

  // Store cache version for reuse (avoid duplicate KV lookups)
  let resolvedCacheVersion: string | null = null;
  let cfCache: Cache | null = null;

  // Initialize edge cache context for ALL requests (not just cacheable paths)
  // This enables L2 caching for API functions on every page
  if (isCloudflareEnv && kvBinding) {
    try {
      cfCache = (caches as any).default as Cache;
      const projectCacheVersionKey = `${CACHE_VERSION_KEY_PREFIX}${hostname}`;

      // Add timeout to KV lookup to prevent hanging (per CF best practices)
      let cacheVersion = await Promise.race([
        kvBinding.get(projectCacheVersionKey),
        new Promise<string | null>((_, reject) =>
          setTimeout(
            () => reject(new Error("KV lookup timeout")),
            KV_TIMEOUT_MS,
          ),
        ),
      ]).catch((err: unknown) => {
        console.warn("KV lookup timed out or failed:", err instanceof Error ? err.message : String(err));
        return null;
      });

      if (!cacheVersion) {
        cacheVersion = "1";
        locals.cfContext.waitUntil(
          kvBinding.put(projectCacheVersionKey, cacheVersion),
        );
      }

      // Store for reuse in HTML caching below
      resolvedCacheVersion = cacheVersion;

      // Set context for API functions (L2 caching)
      setEdgeCacheContext(
        cfCache,
        cacheVersion,
        hostname,
        (promise: Promise<unknown>) => locals.cfContext.waitUntil(promise),
      );
    } catch (error: unknown) {
      console.warn("Failed to initialize edge cache context:", error);
      // Continue without L2 caching - L1 still works
    }
  }

  // HTML page caching (only for cacheable paths)
  if (
    isGetRequest &&
    isCacheablePath &&
    kvBinding &&
    isCloudflareEnv &&
    cfCache
  ) {
    try {
      // Reuse cache version from above (no duplicate KV lookup)
      const cacheVersion = resolvedCacheVersion || "1";

      const cacheUrl = buildCacheKeyUrl(new URL(request.url));
      // IMPORTANT: include BUILD_ID so new deployments never serve stale HTML
      // that references removed JS/CSS bundles from previous builds.
      cacheUrl.searchParams.set("cache_v", `${cacheVersion}-${BUILD_ID}`);
      const cacheKey = new Request(cacheUrl.toString(), request);

      // Add timeout to cache.match to prevent hanging (per CF best practices)
      const cachedResponse = await Promise.race([
        cfCache.match(cacheKey),
        new Promise<Response | undefined>((resolve) =>
          setTimeout(() => resolve(undefined), CACHE_MATCH_TIMEOUT_MS),
        ),
      ]);

      if (cachedResponse) {
        const response = new Response(cachedResponse.body, cachedResponse);
        // Override the stored Cache-Control with browser-safe headers.
        // The stored response has `public, max-age=31536000, immutable` for edge storage
        // but the browser must ALWAYS revalidate to avoid serving stale content.
        response.headers.set(
          "Cache-Control",
          "no-cache, no-store, must-revalidate",
        );
        response.headers.set("Pragma", "no-cache");
        response.headers.set("Expires", "0");
        const cacheStatus = `HIT; v=${cacheVersion}; build=${BUILD_ID}; project=${hostname}`;
        response.headers.set("X-Cache-Status", cacheStatus);
        return await setPageCspHeader(response, env);
      }

      const response = await next();

      if (
        response.status === 200 &&
        response.headers.get("Content-Type")?.includes("text/html")
      ) {
        // Force browsers to ALWAYS revalidate HTML with server.
        // `no-cache` is more aggressive than `max-age=0, must-revalidate`
        // and ensures browser never uses stale HTML after deployments.
        response.headers.set(
          "Cache-Control",
          "no-cache, no-store, must-revalidate",
        );
        response.headers.set("Pragma", "no-cache");
        response.headers.set("Expires", "0");
        response.headers.set(
          "X-Cache-Status",
          `MISS; v=${cacheVersion}; build=${BUILD_ID}; project=${hostname}`,
        );
        await setPageCspHeader(response, env);

        const responseToCache = response.clone();
        // CRITICAL FIX: Override Cache-Control for the internal Cache API storage
        // We want the Edge to hold this "forever" (controlled by KV version invalidation)
        // even though we tell the browser max-age=0.
        responseToCache.headers.set(
          "Cache-Control",
          "public, max-age=31536000, immutable",
        );

        locals.cfContext.waitUntil(cfCache.put(cacheKey, responseToCache));
      } else {
        response.headers.set("X-Cache-Status", "SKIP");
      }

      return response;
    } catch (error: unknown) {
      console.warn("Cache error in production:", error);
      // Fallback to regular response if caching fails
      const response = await next();
      response.headers.set("X-Cache-Status", "ERROR");
      return await setPageCspHeader(response, env);
    }
  }

  // Development or non-cacheable request
  const response = await next();

  // Pages that must NEVER be cached (contain user-specific or payment-sensitive data)
  const isNoCachePage = /^\/(cart|checkout)\/?$/.test(url.pathname);

  if (isNoCachePage) {
    // Force no-store unconditionally — override any existing Cache-Control
    response.headers.set(
      "Cache-Control",
      "private, no-cache, no-store, must-revalidate",
    );
    response.headers.set("Pragma", "no-cache");
    response.headers.set("Expires", "0");
    response.headers.set("X-Cache-Status", "NO_CACHE");
  } else if (isCloudflareEnv) {
    response.headers.set("X-Cache-Status", "BYPASS");
    if (!response.headers.has("Cache-Control")) {
      response.headers.set(
        "Cache-Control",
        "private, no-cache, no-store, must-revalidate",
      );
    }
  } else {
    response.headers.set("X-Cache-Status", "DEV_MODE");
    if (!response.headers.has("Cache-Control")) {
      response.headers.set(
        "Cache-Control",
        "private, no-cache, no-store, must-revalidate",
      );
    }
  }
  return await setPageCspHeader(response, env);
});

const apiContextMiddleware = defineMiddleware((context, next) => {
  const env = getEnv();

  // Read CDN domain with direct cfEnv fallback in case getEnv() returned null
  // but cfEnv property access still works (proxy object edge case).
  let cdnDomain = env?.CDN_DOMAIN_URL as string | undefined;
  if (!cdnDomain) {
    try { cdnDomain = (cfEnv as any)?.CDN_DOMAIN_URL as string | undefined; } catch {}
  }

  // Set module-level env vars for sync access by client.ts + media-url.ts
  setRuntimeEnv({
    PUBLIC_API_URL: env?.PUBLIC_API_URL as string | undefined,
    PUBLIC_API_BASE_URL: env?.PUBLIC_API_BASE_URL as string | undefined,
    CDN_DOMAIN_URL: cdnDomain,
    STOREFRONT_URL: env?.STOREFRONT_URL as string | undefined,
    API_TOKEN: env?.API_TOKEN as string | undefined,
  });

  // Also set on globalThis as a last-resort fallback for media-url.ts
  // (in case the module-level store is somehow stale/empty during SSR rendering)
  if (cdnDomain) {
    (globalThis as any).__SCALIUS_CDN_DOMAIN__ = cdnDomain;
  }
  return apiContext.run({
    BACKEND_API: env?.BACKEND_API as any,
    PUBLIC_API_URL: env?.PUBLIC_API_URL as string | undefined,
    CDN_DOMAIN_URL: env?.CDN_DOMAIN_URL as string | undefined,
  }, next);
});

export const onRequest = sequence(apiContextMiddleware, cachingMiddleware);
