import { defineMiddleware } from "astro:middleware";
import { setPageCspHeader } from "@scalius/core/middleware-helper/csp-handler";
import { env as cfEnv } from "cloudflare:workers";

/**
 * CSP middleware — injects Content-Security-Policy headers on non-API responses.
 */
export const cspMiddleware = defineMiddleware(async (context, next) => {
  const response = await next();
  if (!response) return new Response("Internal Server Error", { status: 500 });

  const url = new URL(context.request.url);

  if (!url.pathname.startsWith("/api/")) {
    try {
      const cspIsCfEnv = (() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cloudflare env is a Proxy; property detection requires any
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
    } catch (error: unknown) {
      console.error("[CSP] Error setting CSP header:", error);
      return response;
    }
  }

  return response;
});
