import { defineMiddleware } from "astro:middleware";
import { invalidateHonoCacheIfNeeded } from "@/lib/middleware-helper/hono-cache-invalidator";

/**
 * Cache invalidation middleware — triggers Hono cache purges after
 * successful admin write operations.
 */
export const cacheInvalidationMiddleware = defineMiddleware(
  async (context, next) => {
    const response = await next();
    if (!response) return new Response("Internal Server Error", { status: 500 });

    try {
      await invalidateHonoCacheIfNeeded(context, response);
    } catch (error) {
      console.error("[Cache Invalidation] Error:", error);
      // Don't crash the response — cache invalidation is best-effort
    }

    return response;
  },
);
