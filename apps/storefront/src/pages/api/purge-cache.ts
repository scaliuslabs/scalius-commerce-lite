// src/pages/api/purge-cache.ts
import type { APIRoute } from "astro";
import { env as cfEnv } from "cloudflare:workers";
import { smartCache } from "@/lib/smart-cache";
import { clearL1ByPrefixes } from "@/lib/edge-cache";
import { getPurgeTokenFromHeaders, PURGE_TOKEN_HEADER } from "@/lib/purge-auth";
import {
  shouldBumpCacheVersionForSelectivePurge,
  shouldWarmCriticalCachesForSelectivePurge,
} from "@/lib/cache-purge-policy";

const CACHE_VERSION_KEY_PREFIX = "v_";

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

  let body: { groups?: string[]; prefixes?: string[]; bumpVersion?: boolean };
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { groups = [], prefixes = [], bumpVersion = false } = body;
  const hostname = url.hostname;
  const cacheKey = `${CACHE_VERSION_KEY_PREFIX}${hostname}`;
  const shouldBumpCacheVersion = shouldBumpCacheVersionForSelectivePurge({ prefixes, bumpVersion });
  const shouldWarmCaches = shouldWarmCriticalCachesForSelectivePurge({ prefixes, bumpVersion });

  try {
    let newVersion: number | null = null;

    // The KV version scopes both HTML and L2 API Cache keys. Prefix purges must
    // bump it because Cloudflare Cache API cannot delete by prefix.
    if (shouldBumpCacheVersion) {
      const currentVersionStr = await kv.get(cacheKey);
      const currentVersion = currentVersionStr ? parseInt(currentVersionStr, 10) : 0;
      newVersion = currentVersion + 1;
      await kv.put(cacheKey, newVersion.toString());
      console.log(`[SelectivePurge] Bumped storefront cache version to ${newVersion} for ${hostname}`);
    }

    // Selectively clear L1 cache
    if (prefixes.length > 0) {
      clearL1ByPrefixes(prefixes);
      console.log(`[SelectivePurge] Cleared L1 prefixes: ${prefixes.join(", ")}`);
    } else {
      smartCache.clear();
      console.log("[SelectivePurge] Cleared all L1 cache (no prefixes specified)");
    }

    // Warm critical HTML caches only for groups that affect rendered pages.
    if (newVersion !== null && shouldWarmCaches) {
      locals.cfContext.waitUntil(warmCriticalCaches(url.origin));
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Selective cache purge for ${hostname} completed.`,
        details: {
          groups,
          cacheVersionBumped: shouldBumpCacheVersion,
          htmlVersionBumped: bumpVersion,
          newVersion,
          prefixesCleared: prefixes.length > 0 ? prefixes.length : "all",
          cacheWarmingStarted: newVersion !== null && shouldWarmCaches,
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
