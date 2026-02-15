// src/lib/middleware-helper/hono-cache-invalidator.ts
import { invalidateEntireCache } from "@/server/utils/cache-invalidation";
import type { APIContext } from "astro";

const WRITE_METHODS = ["POST", "PUT", "DELETE", "PATCH"];

const ASTRO_ADMIN_WRITE_PATHS_FOR_CACHE_CLEAR = [
  "/api/products",
  "/api/categories",
  "/api/collections",
  "/api/pages",
  "/api/widgets",
  "/api/navigation",
  "/api/shipments",
  "/api/analytics",
  "/api/orders",
  "/api/discounts",
  "/api/customers",
  "/api/attributes",
  "/api/settings/header",
  "/api/settings/footer",
  "/api/settings/hero-sliders",
  "/api/settings/delivery-locations",
  "/api/admin/settings/shipping-methods",
  "/api/settings/seo",
  "/api/admin/settings/checkout-languages",
  "/api/settings/meta-conversion",
];

/**
 * Triggers the storefront's cache purge endpoint.
 */
async function triggerStorefrontCachePurge(): Promise<void> {
  const purgeUrl = process.env.PURGE_URL;
  const purgeToken = process.env.PURGE_TOKEN;

  if (!purgeUrl || !purgeToken) {
    console.warn("[Storefront Cache] PURGE_URL or PURGE_TOKEN not found in process.env. Skipping storefront cache purge.");
    return;
  }

  try {
    const urlWithToken = new URL(purgeUrl);
    urlWithToken.searchParams.set("token", purgeToken);

    console.log(`[Storefront Cache] Triggering purge for: ${urlWithToken.origin}${urlWithToken.pathname}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(urlWithToken.toString(), {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      console.log("[Storefront Cache] Purge successful:", data.message);
    } else {
      const errorText = await response.text();
      console.error(`[Storefront Cache] Purge failed with status ${response.status}: ${errorText}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.error("[Storefront Cache] Purge request timed out.");
    } else {
      console.error("[Storefront Cache] An unexpected error occurred during purge:", error);
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
    const shouldInvalidate = ASTRO_ADMIN_WRITE_PATHS_FOR_CACHE_CLEAR.some(
      (path) => url.pathname.startsWith(path),
    );

    if (shouldInvalidate) {
      console.log(
        `[Cache Invalidator] Detected admin write to ${url.pathname}. Triggering full cache invalidation for backend and storefront in background.`,
      );

      // CRITICAL FIX: Access the Cloudflare context and its `waitUntil` method.
      // We use `as any` to bypass the TypeScript error since we cannot modify env.d.ts.
      const runtimeCtx = (locals as any).runtime?.ctx;
      const waitUntil = runtimeCtx?.waitUntil;

      if (waitUntil) {
        // This is the correct way: tell the runtime to wait for our tasks.
        waitUntil(Promise.allSettled([
          invalidateEntireCache(),
          triggerStorefrontCachePurge()
        ]));
      } else {
        // Fallback for local dev or if runtime is not found
        console.warn("[Cache Invalidator] Could not find 'waitUntil' on context. Background tasks may not complete reliably in production.");
        Promise.allSettled([
          invalidateEntireCache(),
          triggerStorefrontCachePurge()
        ]);
      }
    }
  }
}