// src/middleware.ts

import { defineMiddleware, sequence } from "astro:middleware";
import { env as cfEnv } from "cloudflare:workers";
import { apiContext } from "@/lib/api/context";
import { setPageCspHeader } from "@/lib/middleware-helper/csp-handler";
import { setEdgeCacheContext, cacheContextAls } from "@/lib/edge-cache";
import { BUILD_ID } from "@/config/build-id";
import {
  isCacheablePublicResponse,
  requestHasPrivateSession,
} from "@/lib/cache-policy";
import { resolveStorefrontCacheVersion } from "@/lib/cache-version";
import {
  htmlPathCacheKeyFromUrl,
  resolveExactCacheGeneration,
} from "./lib/cache-generations";
import { resolveCacheNamespace } from "./lib/cache-namespace";
import { buildHtmlCacheBaseUrl } from "./lib/cache-key";

// Timeout constants to prevent hanging on slow/unavailable services
const KV_TIMEOUT_MS = 1000;
const CACHE_MATCH_TIMEOUT_MS = 500;

const CACHE_VERSION_KEY_PREFIX = "v_";
const GENERATION_LOOKUP_TIMEOUT_MS = 500;

type CloudflareCacheStorage = CacheStorage & {
  default: Cache;
};

const CACHEABLE_PATHS = [
  /^\/$/,
  /^\/products\/[^/]+$/,
  /^\/categories\/[^/]+$/,
  /^\/collections\/[^/]+$/,
  /^\/search\/?$/,
  /^\/robots\.txt$/,
  /^\/sitemap\.xml$/,
  /^\/sitemap-.*\.xml$/,
  /^\/sitemap\.xsl$/,
  /^\/api\/facebook-feed\.xml$/,
  /^\/(?!api|cart|checkout|buy|order-success|account|health|robots\.txt)[^/.]*$/,
];

// Check if we're running in Cloudflare Workers environment
const isCloudflareEnvironment = () => {
  return typeof caches !== "undefined";
};

async function resolveHtmlCacheGeneration({
  cacheUrl,
  kvBinding,
  cacheNamespace,
}: {
  cacheUrl: URL;
  kvBinding: KVNamespace;
  cacheNamespace: string;
}): Promise<
  | { cacheEnabled: true; generation: string | null }
  | { cacheEnabled: false; reason: string }
> {
  const logicalKey = htmlPathCacheKeyFromUrl(cacheUrl);
  if (!logicalKey) {
    return { cacheEnabled: true, generation: null };
  }

  const generation = await resolveExactCacheGeneration({
    store: kvBinding,
    hostname: cacheNamespace,
    logicalKey,
    timeoutMs: GENERATION_LOOKUP_TIMEOUT_MS,
  });

  if (generation.status === "unavailable") {
    return { cacheEnabled: false, reason: generation.reason };
  }

  return { cacheEnabled: true, generation: generation.generation };
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
    const env = cfEnv as Partial<Env> | null | undefined;
    if (env != null && (env.ASSETS || env.CDN_DOMAIN_URL || env.PUBLIC_API_URL)) {
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
  const hasPrivateSession = requestHasPrivateSession(request.headers);

  // Only enable caching if we're in Cloudflare environment and have KV binding
  const isCloudflareEnv = isCloudflareEnvironment();
  const env = getEnv();
  const kvBinding = env?.CACHE_CONTROL;
  const cacheNamespace = resolveCacheNamespace(env, hostname);

  // Store cache version for reuse (avoid duplicate KV lookups)
  let resolvedCacheVersion: string | null = null;
  let cfCache: Cache | null = null;

  // Initialize edge cache context for ALL requests (not just cacheable paths)
  // This enables L2 caching for API functions on every page
  if (isCloudflareEnv && kvBinding) {
    try {
      cfCache = (caches as CloudflareCacheStorage).default;
      const projectCacheVersionKey = `${CACHE_VERSION_KEY_PREFIX}${cacheNamespace}`;

      const cacheVersionResult = await resolveStorefrontCacheVersion({
        store: kvBinding,
        key: projectCacheVersionKey,
        timeoutMs: KV_TIMEOUT_MS,
        waitUntil: (promise) => locals.cfContext.waitUntil(promise),
      });

      if (cacheVersionResult.status === "unavailable") {
        console.warn("KV lookup timed out or failed:", cacheVersionResult.reason);
        cfCache = null;
      } else {
        resolvedCacheVersion = cacheVersionResult.version;

        // Set context for API functions (L2 caching) — both ALS and fallback
        const waitUntilFn = (promise: Promise<unknown>) => locals.cfContext.waitUntil(promise);
        setEdgeCacheContext(
          cfCache,
          cacheVersionResult.version,
          hostname,
          waitUntilFn,
          kvBinding,
          cacheNamespace,
        );
      }
    } catch (error: unknown) {
      console.warn("Failed to initialize edge cache context:", error);
      cfCache = null;
      // Continue without L2 caching - L1 still works
    }
  }

  // Wrap remainder in cacheContextAls.run() so all downstream withEdgeCache
  // calls read per-request context instead of module-level state.
  const cacheCtx = {
    cache: resolvedCacheVersion ? cfCache : null,
    kvStore: kvBinding ?? null,
    kvVersion: resolvedCacheVersion,
    hostname,
    cacheNamespace,
    waitUntil: isCloudflareEnv ? ((promise: Promise<unknown>) => locals.cfContext.waitUntil(promise)) : null,
  };

  return cacheContextAls.run(cacheCtx, async () => {

  // Public response caching (HTML plus explicit generated XML/text assets)
  if (
    isGetRequest &&
    isCacheablePath &&
    !hasPrivateSession &&
    kvBinding &&
    isCloudflareEnv &&
    cfCache &&
    resolvedCacheVersion
  ) {
    try {
      // Reuse cache version from above (no duplicate KV lookup)
      const cacheVersion = resolvedCacheVersion;

      const cacheUrl = buildHtmlCacheBaseUrl(new URL(request.url));
      const htmlGeneration = await resolveHtmlCacheGeneration({
        cacheUrl,
        kvBinding,
        cacheNamespace,
      });
      if (!htmlGeneration.cacheEnabled) {
        const response = await next();
        response.headers.set("X-Cache-Status", "BYPASS_GENERATION");
        response.headers.set(
          "Cache-Control",
          "no-cache, no-store, must-revalidate",
        );
        response.headers.set("Pragma", "no-cache");
        response.headers.set("Expires", "0");
        console.warn(
          `Bypassing exact HTML cache for ${url.pathname}: ${htmlGeneration.reason}`,
        );
        return await setPageCspHeader(response, env ?? undefined);
      }

      // IMPORTANT: include BUILD_ID so new deployments never serve stale HTML
      // that references removed JS/CSS bundles from previous builds.
      cacheUrl.searchParams.set("cache_v", `${cacheVersion}-${BUILD_ID}`);
      if (htmlGeneration.generation !== null) {
        cacheUrl.searchParams.set("cache_gen", htmlGeneration.generation);
      }
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
        const generationSuffix = htmlGeneration.generation !== null
          ? `; gen=${htmlGeneration.generation}`
          : "";
        const cacheStatus = `HIT; v=${cacheVersion}; build=${BUILD_ID}${generationSuffix}; project=${hostname}`;
        response.headers.set("X-Cache-Status", cacheStatus);
        return await setPageCspHeader(response, env ?? undefined);
      }

      const response = await next();

      if (isCacheablePublicResponse(response)) {
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
          `MISS; v=${cacheVersion}; build=${BUILD_ID}${
            htmlGeneration.generation !== null ? `; gen=${htmlGeneration.generation}` : ""
          }; project=${hostname}`,
        );
        await setPageCspHeader(response, env ?? undefined);

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
      return await setPageCspHeader(response, env ?? undefined);
    }
  }

  // Development or non-cacheable request
  const response = await next();

  // Pages that must NEVER be cached (contain user-specific or payment-sensitive data)
  const isNoCachePage = /^\/(cart|checkout)\/?$/.test(url.pathname);

  if (isNoCachePage || (hasPrivateSession && isGetRequest && isCacheablePath)) {
    // Force no-store unconditionally — override any existing Cache-Control
    response.headers.set(
      "Cache-Control",
      "private, no-cache, no-store, must-revalidate",
    );
    response.headers.set("Pragma", "no-cache");
    response.headers.set("Expires", "0");
    response.headers.set("X-Cache-Status", isNoCachePage ? "NO_CACHE" : "BYPASS_AUTH");
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
  return await setPageCspHeader(response, env ?? undefined);

  }); // end cacheContextAls.run()
});

const apiContextMiddleware = defineMiddleware((_context, next) => {
  const env = getEnv();

  // Read CDN domain with direct cfEnv fallback in case getEnv() returned null
  // but cfEnv property access still works (proxy object edge case).
  let cdnDomain = env?.CDN_DOMAIN_URL as string | undefined;
  if (!cdnDomain) {
    try {
      cdnDomain = (cfEnv as Partial<Env> | null | undefined)?.CDN_DOMAIN_URL;
    } catch {
      // cfEnv proxy access can throw in local dev before Wrangler bindings exist.
    }
  }

  // Set on globalThis as a last-resort fallback for media-url.ts
  // (in case the module-level store is somehow stale/empty during SSR rendering)
  if (cdnDomain) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis assignment for SSR cross-module access
    (globalThis as any).__SCALIUS_CDN_DOMAIN__ = cdnDomain;
  }
  return apiContext.run({
    BACKEND_API: env?.BACKEND_API as Fetcher | undefined,
    PUBLIC_API_URL: env?.PUBLIC_API_URL as string | undefined,
    PUBLIC_API_BASE_URL: env?.PUBLIC_API_BASE_URL as string | undefined,
    CDN_DOMAIN_URL: cdnDomain,
    STOREFRONT_URL: env?.STOREFRONT_URL as string | undefined,
    API_TOKEN: env?.API_TOKEN as string | undefined,
  }, next);
});

export const onRequest = sequence(apiContextMiddleware, cachingMiddleware);
