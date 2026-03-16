import { defineMiddleware } from "astro:middleware";
import { invalidateHonoCacheIfNeeded } from "@/lib/middleware-helper/hono-cache-invalidator";

/**
 * Cache invalidation middleware — triggers Hono cache purges after
 * successful admin write operations.
 */
export const cacheInvalidationMiddleware = defineMiddleware(
  async (context, next) => {
    const response = await next();

    await invalidateHonoCacheIfNeeded(context, response);

    return response;
  },
);
