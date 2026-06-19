// src/pages/api/purge-cache.ts
import type { APIRoute } from "astro";
import { env as cfEnv } from "cloudflare:workers";
import { normalizeStorefrontHtmlCachePaths } from "@scalius/shared/storefront-cache-path";
import { smartCache } from "@/lib/smart-cache";
import { clearL1ByPrefixes } from "@/lib/edge-cache";
import { getPurgeTokenFromHeaders, PURGE_TOKEN_HEADER } from "@/lib/purge-auth";
import {
  shouldBumpCacheVersionForSelectivePurge,
  shouldWarmCriticalCachesForSelectivePurge,
} from "@/lib/cache-purge-policy";
import {
  buildExactCacheGenerationKey,
  bumpExactCacheGenerations,
  htmlPathCacheKeyFromPath,
  shouldUseExactCacheGeneration,
} from "../../lib/cache-generations";
import { BUILD_ID } from "../../config/build-id";
import { resolveCacheNamespace } from "../../lib/cache-namespace";
import { buildHtmlCacheBaseUrl } from "../../lib/cache-key";

const CACHE_VERSION_KEY_PREFIX = "v_";
export const MAX_EXACT_HTML_WARM_PATHS = 20;
const EXACT_HTML_WARM_CONCURRENCY = 4;

export const prerender = false;

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 * Uses the Cloudflare Workers crypto.subtle.timingSafeEqual() API.
 * Falls back to a constant-time byte comparison if unavailable.
 */
async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  // Cloudflare Workers expose timingSafeEqual on crypto.subtle
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
  };

  if (typeof subtle.timingSafeEqual === "function") {
    if (aBytes.byteLength !== bBytes.byteLength) {
      // Still run the comparison against self to maintain constant time
      subtle.timingSafeEqual(aBytes, aBytes);
      return false;
    }
    return subtle.timingSafeEqual(aBytes, bBytes);
  }

  // Fallback: constant-time comparison via HMAC
  // Sign both strings with the same key; if the signatures match, the inputs match.
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode("timing-safe-compare-key"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign("HMAC", key, aBytes),
    crypto.subtle.sign("HMAC", key, bBytes),
  ]);
  // Compare the fixed-length HMAC digests byte-by-byte
  const viewA = new Uint8Array(sigA);
  const viewB = new Uint8Array(sigB);
  let diff = viewA.byteLength ^ viewB.byteLength;
  for (let i = 0; i < viewA.byteLength; i++) {
    diff |= viewA[i] ^ viewB[i];
  }
  return diff === 0;
}

/**
 * Warm critical caches after purge.
 * This ensures the next visitor gets fast response by pre-populating
 * the L2 edge cache with essential data (layout, homepage).
 *
 * @param baseUrl The base URL of the site (e.g., https://grameenjute.com)
 */
async function warmCriticalCaches(baseUrl: string): Promise<void> {
  // These endpoints are called on EVERY page load, so warming them
  // provides the biggest performance benefit
  const criticalEndpoints = [
    "/", // Homepage - triggers getLayoutData() + getHomepageData()
  ];

  console.log(`[CacheWarm] Starting warm for ${baseUrl} immediately after purge...`);

  const results = await Promise.allSettled(
    criticalEndpoints.map(async (endpoint) => {
      const start = Date.now();
      try {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          headers: {
            // Identify this as a cache warm request in logs
            "X-Cache-Warm": "true",
            // Ensure we get a fresh response that gets cached
            "Cache-Control": "no-cache",
          },
        });

        const duration = Date.now() - start;
        if (response.ok) {
          console.log(
            `[CacheWarm] ${endpoint} warmed successfully in ${duration}ms`,
          );
        } else {
          console.warn(
            `[CacheWarm] ${endpoint} returned ${response.status} in ${duration}ms`,
          );
        }
        return response.ok;
      } catch (error: unknown) {
        const duration = Date.now() - start;
        console.error(
          `[CacheWarm] ${endpoint} failed after ${duration}ms:`,
          error,
        );
        throw error;
      }
    }),
  );

  const successful = results.filter(
    (r) => r.status === "fulfilled" && r.value === true,
  ).length;
  console.log(
    `[CacheWarm] Completed: ${successful}/${criticalEndpoints.length} endpoints warmed`,
  );
}

async function warmExactHtmlPaths(baseUrl: string, paths: readonly string[]): Promise<void> {
  const uniquePaths = normalizeExactHtmlPaths(paths);
  if (uniquePaths.length === 0) {
    return;
  }

  console.log(`[CacheWarm] Starting exact warm for ${uniquePaths.length} path(s) on ${baseUrl}...`);

  const results: PromiseSettledResult<boolean>[] = [];
  for (let index = 0; index < uniquePaths.length; index += EXACT_HTML_WARM_CONCURRENCY) {
    const chunk = uniquePaths.slice(index, index + EXACT_HTML_WARM_CONCURRENCY);
    const chunkResults = await Promise.allSettled(
      chunk.map(async (path) => {
        const start = Date.now();
        try {
          const response = await fetch(new URL(path, baseUrl), {
            headers: {
              "X-Cache-Warm": "true",
              "Cache-Control": "no-cache",
            },
          });

          const duration = Date.now() - start;
          if (response.ok) {
            console.log(`[CacheWarm] ${path} exact-warmed successfully in ${duration}ms`);
          } else {
            console.warn(`[CacheWarm] ${path} exact warm returned ${response.status} in ${duration}ms`);
          }
          return response.ok;
        } catch (error: unknown) {
          const duration = Date.now() - start;
          console.error(`[CacheWarm] ${path} exact warm failed after ${duration}ms:`, error);
          throw error;
        }
      }),
    );
    results.push(...chunkResults);
  }

  const successful = results.filter(
    (result) => result.status === "fulfilled" && result.value === true,
  ).length;
  console.log(`[CacheWarm] Exact warm completed: ${successful}/${uniquePaths.length} path(s) warmed`);
}

function normalizeExactHtmlPaths(paths: readonly string[]): string[] {
  return normalizeStorefrontHtmlCachePaths(paths, MAX_EXACT_HTML_WARM_PATHS);
}

function buildL2CacheKeyUrl(
  hostname: string,
  key: string,
  version: string,
  generations: ReadonlyMap<string, string> = new Map(),
): string {
  const cacheKey = new URL(`https://${hostname}/_api-cache/${encodeURIComponent(key)}`);
  cacheKey.searchParams.set("v", version);
  cacheKey.searchParams.set("build", BUILD_ID);
  const generation = generations.get(key);
  if (generation) {
    cacheKey.searchParams.set("g", generation);
  }
  return cacheKey.toString();
}

function buildHtmlCacheKeyUrl(
  origin: string,
  path: string,
  version: string,
  generations: ReadonlyMap<string, string> = new Map(),
): string {
  const htmlUrl = buildHtmlCacheBaseUrl(new URL(path, origin));
  htmlUrl.searchParams.set("cache_v", `${version}-${BUILD_ID}`);
  const htmlPathKey = htmlPathCacheKeyFromPath(path);
  const generation = htmlPathKey ? generations.get(htmlPathKey) : null;
  if (generation) {
    htmlUrl.searchParams.set("cache_gen", generation);
  }
  return htmlUrl.toString();
}

async function readCurrentExactGenerations({
  store,
  cacheNamespace,
  logicalKeys,
}: {
  store: KVNamespace;
  cacheNamespace: string;
  logicalKeys: readonly string[];
}): Promise<Map<string, string>> {
  const keys = [...new Set(logicalKeys.filter(shouldUseExactCacheGeneration))];
  const generations = new Map<string, string>();
  await Promise.all(
    keys.map(async (logicalKey) => {
      try {
        const generation = await store.get(buildExactCacheGenerationKey(cacheNamespace, logicalKey));
        generations.set(logicalKey, generation || "0");
      } catch (error: unknown) {
        console.warn(`[SelectivePurge] Failed to read exact generation for ${logicalKey}:`, error);
        generations.set(logicalKey, "0");
      }
    }),
  );
  return generations;
}

async function deleteL2ExactKeys(
  hostname: string,
  keys: readonly string[],
  version: string | null,
  generations: ReadonlyMap<string, string> = new Map(),
): Promise<number> {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (uniqueKeys.length === 0 || !version || typeof caches === "undefined") {
    return 0;
  }

  const cache = (caches as CacheStorage & { default: Cache }).default;
  const results = await Promise.allSettled(
    uniqueKeys.map((key) => cache.delete(buildL2CacheKeyUrl(hostname, key, version, generations))),
  );

  return results.filter((result) => result.status === "fulfilled" && result.value).length;
}

function collectExactGenerationKeys(
  exactKeys: readonly string[],
  htmlPaths: readonly string[],
  prefixes: readonly string[] = [],
): string[] {
  return [
    ...exactKeys,
    ...prefixes.map(normalizeExactGenerationPrefix).filter((key): key is string => Boolean(key)),
    ...htmlPaths
      .map((path) => htmlPathCacheKeyFromPath(path))
      .filter((key): key is string => typeof key === "string" && key.length > 0),
  ];
}

function normalizeExactGenerationPrefix(prefix: string): string | null {
  if (!prefix) return null;
  if (prefix.startsWith("page_render_") && prefix.endsWith("_")) {
    return `${prefix}${BUILD_ID}`;
  }
  return shouldUseExactCacheGeneration(prefix) ? prefix : null;
}

async function deleteHtmlPaths(
  origin: string,
  paths: readonly string[],
  version: string | null,
  generations: ReadonlyMap<string, string> = new Map(),
): Promise<number> {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (uniquePaths.length === 0 || !version || typeof caches === "undefined") {
    return 0;
  }

  const cache = (caches as CacheStorage & { default: Cache }).default;
  const results = await Promise.allSettled(
    uniquePaths.map((path) => cache.delete(new Request(buildHtmlCacheKeyUrl(origin, path, version, generations)))),
  );

  return results.filter((result) => result.status === "fulfilled" && result.value).length;
}

export const GET: APIRoute = async ({ url }) => {
  // Never accept purge credentials in URLs. Query strings are commonly logged
  // by proxies, analytics, and browser history; callers must use a header.
  if (url.searchParams.has("token")) {
    return new Response(
      JSON.stringify({
        error: `Purge token must be sent with Authorization: Bearer or ${PURGE_TOKEN_HEADER}`,
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  return new Response(
    JSON.stringify({
      error: "Method Not Allowed",
      message: "Use POST to purge storefront cache.",
    }),
    {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Allow: "POST",
      },
    },
  );
};

export const POST: APIRoute = async ({ request, url, locals }) => {
  const env = cfEnv as unknown as Env;
  const secretToken = env.PURGE_TOKEN as string;
  const kv = env.CACHE_CONTROL;

  if (!secretToken) {
    console.error("PURGE_TOKEN is not set in environment variables.");
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Never accept purge credentials in URLs. Query strings are commonly logged
  // by proxies, analytics, and browser history; callers must use a header.
  if (url.searchParams.has("token")) {
    return new Response(
      JSON.stringify({
        error: `Purge token must be sent with Authorization: Bearer or ${PURGE_TOKEN_HEADER}`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const providedToken = getPurgeTokenFromHeaders(request.headers);
  if (!providedToken || !(await timingSafeCompare(providedToken, secretToken))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: {
    groups?: string[];
    prefixes?: string[];
    exactKeys?: string[];
    htmlPaths?: string[];
    bumpVersion?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const {
    groups = [],
    prefixes = [],
    exactKeys = [],
    htmlPaths: requestedHtmlPaths = [],
    bumpVersion = false,
  } = body;
  const htmlPaths = normalizeExactHtmlPaths(requestedHtmlPaths);
  const hostname = url.hostname;
  const cacheNamespace = resolveCacheNamespace(env, hostname);
  const cacheKey = `${CACHE_VERSION_KEY_PREFIX}${cacheNamespace}`;
  const shouldBumpCacheVersion = shouldBumpCacheVersionForSelectivePurge({
    groups,
    prefixes,
    exactKeys,
    htmlPaths,
    bumpVersion,
  });
  const shouldWarmCaches = shouldWarmCriticalCachesForSelectivePurge({
    groups,
    prefixes,
    exactKeys,
    htmlPaths,
    bumpVersion,
  });
  const exactGenerationKeys = collectExactGenerationKeys(exactKeys, htmlPaths, prefixes);

  try {
    let newVersion: number | null = null;
    let currentVersionForExactDeletes: string | null = null;
    let currentExactGenerations = new Map<string, string>();
    let l2ExactKeysDeleted = 0;
    let htmlPathsDeleted = 0;
    let exactGenerationsBumped = 0;
    let exactHtmlWarmScheduled = false;

    // The KV version scopes both HTML and L2 API Cache keys. Unknown prefix
    // purges still bump it because Cloudflare Cache API cannot delete by prefix.
    // Known data-only families use exact generation keys instead, so checkout
    // changes do not cool unrelated HTML caches.
    if (shouldBumpCacheVersion) {
      const currentVersionStr = await kv.get(cacheKey);
      const currentVersion = currentVersionStr ? parseInt(currentVersionStr, 10) : 0;
      newVersion = currentVersion + 1;
      await kv.put(cacheKey, newVersion.toString());
      console.log(`[SelectivePurge] Bumped storefront cache version to ${newVersion} for ${hostname}`);
    } else if (exactGenerationKeys.length > 0 || htmlPaths.length > 0) {
      currentVersionForExactDeletes = await kv.get(cacheKey);
      currentExactGenerations = await readCurrentExactGenerations({
        store: kv,
        cacheNamespace,
        logicalKeys: exactGenerationKeys,
      });

      const bumpedGenerations = await bumpExactCacheGenerations({
        store: kv,
        hostname: cacheNamespace,
        logicalKeys: exactGenerationKeys,
      });
      exactGenerationsBumped = bumpedGenerations.length;

      l2ExactKeysDeleted = await deleteL2ExactKeys(
        hostname,
        exactKeys,
        currentVersionForExactDeletes,
        currentExactGenerations,
      );
      htmlPathsDeleted = await deleteHtmlPaths(
        url.origin,
        htmlPaths,
        currentVersionForExactDeletes,
        currentExactGenerations,
      );
      if (htmlPaths.length > 0) {
        locals.cfContext.waitUntil(warmExactHtmlPaths(url.origin, htmlPaths));
        exactHtmlWarmScheduled = true;
      }
      console.log(`[SelectivePurge] Bumped ${exactGenerationsBumped} exact cache generation(s) for ${hostname}`);
      console.log(`[SelectivePurge] Deleted ${l2ExactKeysDeleted}/${new Set(exactKeys).size} exact L2 keys for ${hostname}`);
      console.log(`[SelectivePurge] Deleted ${htmlPathsDeleted}/${new Set(htmlPaths).size} exact HTML paths for ${hostname}`);
    }

    // Selectively clear L1 cache
    const l1Prefixes = [...new Set([...prefixes, ...exactGenerationKeys].filter(Boolean))];
    if (l1Prefixes.length > 0) {
      clearL1ByPrefixes(l1Prefixes);
      console.log(`[SelectivePurge] Cleared L1 prefixes: ${l1Prefixes.join(", ")}`);
    } else {
      smartCache.clear();
      console.log("[SelectivePurge] Cleared all L1 cache (no prefixes specified)");
    }

    // Warm critical HTML caches only for groups that affect rendered pages.
    if (newVersion !== null && shouldWarmCaches) {
      locals.cfContext.waitUntil(warmCriticalCaches(url.origin));
    }
    if (htmlPaths.length > 0 && !exactHtmlWarmScheduled) {
      locals.cfContext.waitUntil(warmExactHtmlPaths(url.origin, htmlPaths));
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Selective cache purge for ${hostname} completed.`,
        details: {
          groups,
          cacheVersionBumped: shouldBumpCacheVersion,
          htmlVersionBumped: shouldBumpCacheVersion,
          newVersion,
          prefixesCleared: prefixes.length > 0
            ? prefixes.length
            : exactKeys.length > 0 || htmlPaths.length > 0
              ? 0
              : "all",
          exactKeysCleared: exactKeys.length,
          exactGenerationsBumped,
          l2ExactKeysDeleted,
          htmlPathsCleared: htmlPaths.length,
          htmlPathsDeleted,
          cacheWarmingStarted:
            (newVersion !== null && shouldWarmCaches) ||
            (newVersion === null && htmlPaths.length > 0),
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    console.error(`Failed to execute selective purge for ${hostname}:`, error);
    return new Response(
      JSON.stringify({ error: "Failed to execute selective purge" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
