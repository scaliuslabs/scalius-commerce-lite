// src/pages/api/purge-cache.ts
import type { APIRoute } from "astro";
import { smartCache } from "@/lib/smart-cache";
import { clearL1ByPrefixes } from "@/lib/edge-cache";

const CACHE_VERSION_KEY_PREFIX = "v_";

export const prerender = false;

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
      } catch (error) {
        const duration = Date.now() - start;
        console.error(
          `[CacheWarm] ${endpoint} failed after ${duration}ms:`,
          error,
        );
        throw error;
      }
    }),
  );

  const successful = results.filter((r) => r.status === "fulfilled").length;
  console.log(
    `[CacheWarm] Completed: ${successful}/${criticalEndpoints.length} endpoints warmed`,
  );
}

export const GET: APIRoute = async ({ url, locals }) => {
  const providedToken = url.searchParams.get("token");

  const hostname = url.hostname;
  const cacheKey = `${CACHE_VERSION_KEY_PREFIX}${hostname}`;

  const secretToken = (locals.runtime.env.PURGE_TOKEN as string) || import.meta.env.PURGE_TOKEN;
  const kv = locals.runtime.env.CACHE_CONTROL;

  if (!secretToken) {
    console.error("PURGE_TOKEN is not set in environment variables.");
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  if (!providedToken || providedToken !== secretToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const currentVersionStr = await kv.get(cacheKey);
    const currentVersion = currentVersionStr
      ? parseInt(currentVersionStr, 10)
      : 0;
    const newVersion = currentVersion + 1;

    await kv.put(cacheKey, newVersion.toString());

    // Clear the in-memory API cache as well
    // This ensures cached API data (widgets, collections, products, etc.) is also refreshed
    smartCache.clear();

    // Warm critical caches in the background
    // This ensures the next visitor gets fast response
    // Uses waitUntil to avoid blocking the purge response
    const protocol = url.protocol; // 'https:' or 'http:'
    const baseUrl = `${protocol}//${hostname}`;
    locals.runtime.ctx.waitUntil(warmCriticalCaches(baseUrl));

    return new Response(
      JSON.stringify({
        success: true,
        message: `Cache for ${hostname} invalidated. New version is ${newVersion}.`,
        details: {
          htmlCachePurged: true,
          apiCachePurged: true,
          l2CacheInvalidated: true,
          cacheWarmingStarted: true,
          newVersion,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error(
      `Failed to update cache version in KV for ${hostname}:`,
      error,
    );
    return new Response(JSON.stringify({ error: "Failed to purge cache" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const POST: APIRoute = async ({ request, url, locals }) => {
  const secretToken = (locals.runtime.env.PURGE_TOKEN as string) || import.meta.env.PURGE_TOKEN;
  const kv = locals.runtime.env.CACHE_CONTROL;

  if (!secretToken) {
    console.error("PURGE_TOKEN is not set in environment variables.");
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Token can be in URL params or request body
  let providedToken = url.searchParams.get("token");

  let body: { groups?: string[]; prefixes?: string[]; bumpVersion?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!providedToken) {
    // Also check body for token as fallback
    providedToken = (body as any).token;
  }

  if (!providedToken || providedToken !== secretToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { groups = [], prefixes = [], bumpVersion = false } = body;
  const hostname = url.hostname;
  const cacheKey = `${CACHE_VERSION_KEY_PREFIX}${hostname}`;

  try {
    let newVersion: number | null = null;

    // Only bump HTML version if requested (some groups like 'checkout' don't need it)
    if (bumpVersion) {
      const currentVersionStr = await kv.get(cacheKey);
      const currentVersion = currentVersionStr ? parseInt(currentVersionStr, 10) : 0;
      newVersion = currentVersion + 1;
      await kv.put(cacheKey, newVersion.toString());
      console.log(`[SelectivePurge] Bumped HTML version to ${newVersion} for ${hostname}`);
    }

    // Selectively clear L1 cache
    if (prefixes.length > 0) {
      clearL1ByPrefixes(prefixes);
      console.log(`[SelectivePurge] Cleared L1 prefixes: ${prefixes.join(", ")}`);
    } else {
      smartCache.clear();
      console.log("[SelectivePurge] Cleared all L1 cache (no prefixes specified)");
    }

    // Warm critical caches if version was bumped
    if (newVersion !== null) {
      const protocol = url.protocol;
      const baseUrl = `${protocol}//${hostname}`;
      locals.runtime.ctx.waitUntil(warmCriticalCaches(baseUrl));
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Selective cache purge for ${hostname} completed.`,
        details: {
          groups,
          htmlVersionBumped: bumpVersion,
          newVersion,
          prefixesCleared: prefixes.length > 0 ? prefixes.length : "all",
          cacheWarmingStarted: newVersion !== null,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error(`Failed to execute selective purge for ${hostname}:`, error);
    return new Response(
      JSON.stringify({ error: "Failed to execute selective purge" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
