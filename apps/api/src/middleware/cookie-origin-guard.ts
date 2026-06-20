import type { MiddlewareHandler } from "hono";
import { getCorsOriginContext } from "@scalius/shared/cors-helper";
import { ForbiddenError } from "../utils/api-error";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hasCookieCredentials(cookieHeader: string | undefined): boolean {
  return Boolean(cookieHeader?.trim());
}

/**
 * Reject browser-originated unsafe cookie requests unless the Origin is one of
 * the credentialed API CORS origins. Server-to-server/service-binding calls do
 * not have a browser Origin and continue to rely on normal route auth.
 */
export const cookieOriginGuardMiddleware: MiddlewareHandler = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
    await next();
    return;
  }

  if (!hasCookieCredentials(c.req.header("Cookie"))) {
    await next();
    return;
  }

  const origin = c.req.header("Origin");
  if (!origin) {
    await next();
    return;
  }

  const resolveAllowedOrigin = await getCorsOriginContext(c);
  if (resolveAllowedOrigin(origin)) {
    await next();
    return;
  }

  throw new ForbiddenError("Cross-origin cookie request denied");
};
