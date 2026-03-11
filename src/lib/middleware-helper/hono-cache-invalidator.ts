// src/lib/middleware-helper/hono-cache-invalidator.ts
import {
  getGroupsForPath,
  invalidateGroups,
  shouldBumpStorefrontVersion,
  getStorefrontPrefixesForGroups,
  ADMIN_PATH_TO_GROUPS,
} from "@/server/utils/cache-invalidation";
import { getCache, setCache } from "@/server/utils/kv-cache";
import type { APIContext } from "astro";
import { env as cfEnv } from 'cloudflare:workers';

const WRITE_METHODS = ["POST", "PUT", "DELETE", "PATCH"];

// Derive the set of admin write paths from the group mapping.
// Paths that should NOT trigger cache invalidation are excluded by simply
// not being present in ADMIN_PATH_TO_GROUPS.
const ADMIN_WRITE_PATHS = Object.keys(ADMIN_PATH_TO_GROUPS);

// Debounce settings
const DEBOUNCE_KEY = "_invalidation_debounce";
const DEBOUNCE_MS = 2000;

/**
 * Triggers the storefront's cache purge endpoint.
 * - With groups: sends POST with selective purge payload.
 * - Without groups: sends GET for a full purge (backwards compatible).
 */
async function triggerStorefrontCachePurge(
  runtimeEnv?: Env,
  groups?: string[],
  prefixes?: string[],
  bumpVersion?: boolean,
): Promise<void> {
  const purgeUrl = runtimeEnv?.PURGE_URL;
  const purgeToken = runtimeEnv?.PURGE_TOKEN;

  if (!purgeUrl || !purgeToken) {
    console.warn(
      "[Storefront Cache] PURGE_URL or PURGE_TOKEN not configured. Skipping storefront cache purge.",
    );
    return;
  }

  try {
    const urlWithToken = new URL(purgeUrl);
    urlWithToken.searchParams.set("token", purgeToken);

    console.log(
      `[Storefront Cache] Triggering purge for: ${urlWithToken.origin}${urlWithToken.pathname}`,
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let response: Response;

    if (groups && groups.length > 0) {
      // Selective purge via POST
      response = await fetch(urlWithToken.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups, prefixes, bumpVersion }),
        signal: controller.signal,
      });
    } else {
      // Full purge via GET (backwards compatible)
      response = await fetch(urlWithToken.toString(), {
        method: "GET",
        signal: controller.signal,
      });
    }

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      console.log("[Storefront Cache] Purge successful:", (data as any).message);
    } else {
      const errorText = await response.text();
      console.error(
        `[Storefront Cache] Purge failed with status ${response.status}: ${errorText}`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error("[Storefront Cache] Purge request timed out.");
    } else {
      console.error(
        "[Storefront Cache] An unexpected error occurred during purge:",
        error,
      );
    }
  }
}

/**
 * Checks if a cache clear is needed and uses `waitUntil` to trigger purges.
 * @param context The full Astro APIContext from the middleware.
 * @param response The Response object from the endpoint.
 */
export async function invalidateHonoCacheIfNeeded(
  context: APIContext,
  response: Response,
): Promise<void> {
  const { request, locals } = context;
  const url = new URL(request.url);

  if (
    WRITE_METHODS.includes(request.method) &&
    response.status >= 200 &&
    response.status < 300
  ) {
    const shouldInvalidate = ADMIN_WRITE_PATHS.some((path) =>
      url.pathname.startsWith(path),
    );

    if (shouldInvalidate) {
      const groups = getGroupsForPath(url.pathname);

      if (groups.length === 0) return;

      const runtimeEnv = cfEnv as unknown as Env;
      const kv = runtimeEnv.CACHE as KVNamespace | undefined;

      // KV-based debounce: skip if the same group set was invalidated within DEBOUNCE_MS
      const debounceKey = `${DEBOUNCE_KEY}:${groups.sort().join(",")}`;
      const lastInvalidation = await getCache<number>(debounceKey, kv);

      if (lastInvalidation && Date.now() - lastInvalidation < DEBOUNCE_MS) {
        console.log(
          `[Cache Invalidator] Debounced invalidation for [${groups.join(", ")}] – skipping.`,
        );
        return;
      }

      // Set debounce marker (KV min TTL is 60s, that's fine)
      await setCache(debounceKey, Date.now(), 60, kv);

      console.log(
        `[Cache Invalidator] Detected admin write to ${url.pathname}. Invalidating groups: [${groups.join(", ")}].`,
      );

      const bumpVersion = shouldBumpStorefrontVersion(groups);
      const prefixes = getStorefrontPrefixesForGroups(groups);

      const runtimeCtx = (locals as any).cfContext;
      const waitUntil = runtimeCtx?.waitUntil?.bind(runtimeCtx);

      if (waitUntil) {
        waitUntil(
          Promise.allSettled([
            invalidateGroups(groups, kv),
            triggerStorefrontCachePurge(runtimeEnv, groups, prefixes, bumpVersion),
          ]),
        );
      } else {
        console.warn(
          "[Cache Invalidator] Could not find 'waitUntil'. Background tasks may not complete reliably.",
        );
        Promise.allSettled([
          invalidateGroups(groups, kv),
          triggerStorefrontCachePurge(runtimeEnv, groups, prefixes, bumpVersion),
        ]);
      }
    }
  }
}
