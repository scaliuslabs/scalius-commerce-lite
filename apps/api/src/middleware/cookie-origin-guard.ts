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

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * True when a browser request comes from a page other than the dashboard.
 * Only the request's own origin and the Platform Dashboard URL may use the
 * dashboard session: the storefront is usually same-site with the dashboard
 * (so SameSite=Lax cookies still flow) and runs merchant-injected scripts, so
 * it must never read or write through a dashboard cookie. Browsers omit
 * `Origin` only on same-origin GET/HEAD and always send it on unsafe methods.
 */
export function isForeignDashboardRequest(
  request: Request,
  dashboardUrl: string | undefined,
): boolean {
  const origin = request.headers.get("Origin");
  if (origin === null) return false;
  const submitted = originOf(origin);
  if (!submitted) return true;
  return submitted !== new URL(request.url).origin && submitted !== originOf(dashboardUrl);
}

/**
 * Dashboard-only surfaces (`/admin/*`, `/cache/*`): every cookie-bearing
 * request, reads included, must come from the dashboard origin. Bearer-token
 * callers (CLI, agents) carry no cookie and rely on route auth alone.
 */
export const dashboardOriginGuardMiddleware: MiddlewareHandler = async (c, next) => {
  if (
    hasCookieCredentials(c.req.header("Cookie")) &&
    isForeignDashboardRequest(c.req.raw, c.env.BETTER_AUTH_URL)
  ) {
    throw new ForbiddenError("Cross-origin dashboard request denied");
  }
  await next();
};
