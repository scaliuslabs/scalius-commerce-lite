import { defineMiddleware } from "astro:middleware";
import { setPageCspHeader } from "@scalius/core/middleware-helper/csp-handler";
import { getEnvWithFallback } from "@/lib/cf-env";

/**
 * CSP middleware — injects Content-Security-Policy headers on non-API responses.
 */
export const cspMiddleware = defineMiddleware(async (context, next) => {
  const response = await next();
  if (!response) return new Response("Internal Server Error", { status: 500 });

  const url = new URL(context.request.url);

  if (!url.pathname.startsWith("/api/")) {
    try {
      const env = getEnvWithFallback();
      return await setPageCspHeader(response, env);
    } catch (error: unknown) {
      console.error("[CSP] Error setting CSP header:", error);
      return response;
    }
  }

  return response;
});
