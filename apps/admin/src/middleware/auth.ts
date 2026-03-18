import { defineMiddleware } from "astro:middleware";
import { createAuth } from "@scalius/core/auth";
import { env as cfEnv } from "cloudflare:workers";
import { setRequestHeaders } from "@/lib/api-fetch";

/**
 * Auth middleware — runs first.
 * Detects CF environment, initializes DB/KV/Storage bindings, and extracts
 * the Better Auth session, populating `context.locals` for downstream middleware.
 * Also stores request headers so SSR loaders can forward auth cookies to the API.
 */
export const authMiddleware = defineMiddleware(async (context, next) => {
  const request = context.request;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Store request headers so apiGet/apiPost can forward auth cookies
  setRequestHeaders(request.headers);

  // Use native CF Worker env in prod/dev, fallback to process.env for scripts
  // NOTE: Do NOT use Object.keys(cfEnv) — it returns [] on CF Workers proxy objects.
  const isCfEnv = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cloudflare env is a Proxy; property detection requires any
      return !!(cfEnv as any)?.ASSETS || !!(cfEnv as any)?.DB || !!(cfEnv as any)?.PUBLIC_API_BASE_URL;
    } catch {
      return false;
    }
  })();
  const env = isCfEnv
    ? (cfEnv as unknown as Env)
    : typeof process !== "undefined"
      ? (process.env as unknown as Env)
      : ({} as Env);

  if (isCfEnv) {
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

  // Non-admin API routes and Better Auth routes bypass session extraction
  if (pathname.startsWith("/api/v1") && !pathname.startsWith("/api/v1/admin")) {
    const response = await next();
    return response || new Response();
  }

  if (pathname.startsWith("/api/auth/")) {
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
