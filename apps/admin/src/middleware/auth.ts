import { defineMiddleware } from "astro:middleware";
import { createAuth } from "@scalius/core/auth";
import { runWithRequestHeaders } from "@/lib/api-server";
import { isPublicRoute } from "./route-utils";
import { getCfEnv, getEnvWithFallback } from "@/lib/cf-env";

/**
 * Auth middleware — runs first.
 * Detects CF environment, initializes DB/KV/Storage bindings, and extracts
 * the Better Auth session, populating `context.locals` for downstream middleware.
 */
export const authMiddleware = defineMiddleware(async (context, next) => {
  const request = context.request;
  const url = new URL(request.url);
  const pathname = url.pathname;

  const cfEnvResult = getCfEnv();
  const env = cfEnvResult ?? getEnvWithFallback();

  if (cfEnvResult) {
    const [{ getDb }, { initKv }, { initStorage }] = await Promise.all([
      import("@scalius/database/client"),
      import("@scalius/core/utils/kv-cache"),
      import("@scalius/core/integrations/storage"),
    ]);
    getDb(env);
    if (env.CACHE) initKv(env.CACHE);
    if (env.BUCKET) {
      initStorage(env.BUCKET, (env.R2_PUBLIC_URL as string) || "");
    }
  }

  // Run the rest of the middleware chain inside AsyncLocalStorage so that
  // apiGet/apiPost/etc. can access this request's headers without module-level state.
  return runWithRequestHeaders(request.headers, async () => {
    // Non-admin API routes and Better Auth routes bypass session extraction
    if (isPublicRoute(pathname)) {
      const response = await next();
      return response || new Response();
    }

    // Extract Better Auth session
    let session = null;
    let sessionUser = null;

    try {
      const auth = createAuth(env);
      const sessionResult = await auth.api.getSession({
        headers: request.headers,
      });

      if (sessionResult) {
        session = sessionResult.session;
        sessionUser = sessionResult.user;
      }
    } catch (error: unknown) {
      console.error("Error getting session:", error);
    }

    context.locals.session = session;
    context.locals.user = sessionUser;
    context.locals.apiBaseUrl = (env?.PUBLIC_API_BASE_URL as string) || "";

    // Store env reference for downstream middleware
    context.locals._env = env;

    const response = await next();
    return response || new Response();
  });
});
