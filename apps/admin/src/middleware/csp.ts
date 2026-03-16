import { defineMiddleware } from "astro:middleware";
import { setPageCspHeader } from "@scalius/core/middleware-helper/csp-handler";
import { env as cfEnv } from "cloudflare:workers";

/**
 * CSP middleware — injects Content-Security-Policy headers on non-API responses.
 */
export const cspMiddleware = defineMiddleware(async (context, next) => {
  const response = await next();
  const url = new URL(context.request.url);

  if (!url.pathname.startsWith("/api/")) {
    const cspIsCfEnv = (() => {
      try {
        return !!(cfEnv as any)?.ASSETS || !!(cfEnv as any)?.DB;
      } catch {
        return false;
      }
    })();
    const env = cspIsCfEnv
      ? (cfEnv as unknown as Env)
      : typeof process !== "undefined"
        ? (process.env as unknown as Env)
        : ({} as Env);
    return await setPageCspHeader(response, env);
  }

  return response;
});
