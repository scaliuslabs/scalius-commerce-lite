import { sequence } from "astro:middleware";
import { authMiddleware } from "./auth";
import { adminDetectionMiddleware } from "./admin-detection";
import { rbacMiddleware } from "./rbac";
import { cspMiddleware } from "./csp";
import { cacheInvalidationMiddleware } from "./cache-invalidation";

/**
 * Composed middleware pipeline.
 * Execution order: auth → admin-detection → rbac → csp → cache-invalidation
 */
export const onRequest = sequence(
  authMiddleware,
  adminDetectionMiddleware,
  rbacMiddleware,
  cspMiddleware,
  cacheInvalidationMiddleware,
);
