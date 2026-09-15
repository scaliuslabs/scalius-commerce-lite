const PRIVATE_SESSION_COOKIE_NAMES = ["cs_tok", "cs_auth", "stp_theme_preview"];

export const PRIVATE_STOREFRONT_PATHNAME_RE =
  /^\/(?:account|buy|cart|checkout|order-success|payment-recovery|theme-preview)(?:\/|$)/;

export function isPrivateStorefrontPathname(pathname: string): boolean {
  return PRIVATE_STOREFRONT_PATHNAME_RE.test(pathname);
}

function hasNamedCookie(cookieHeader: string, cookieNames: readonly string[]): boolean {
  const names = new Set(cookieNames);

  for (const chunk of cookieHeader.split(";")) {
    const [rawName] = chunk.trim().split("=", 1);
    if (rawName && names.has(rawName)) return true;
  }

  return false;
}

function responseHasSetCookie(headers: Headers): boolean {
  const headersWithCookies = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithCookies.getSetCookie === "function") {
    return headersWithCookies.getSetCookie().length > 0;
  }

  if (headers.has("Set-Cookie") || headers.has("set-cookie")) return true;

  for (const [key] of headers.entries()) {
    if (key.toLowerCase() === "set-cookie") return true;
  }

  return false;
}

export function requestHasPrivateSession(headers: Headers): boolean {
  if (headers.has("Authorization")) return true;

  const cookieHeader = headers.get("Cookie");
  if (!cookieHeader) return false;

  return hasNamedCookie(cookieHeader, PRIVATE_SESSION_COOKIE_NAMES);
}

/**
 * Mirrors the native public-cache admission boundary for request metadata.
 *
 * Only a named private-session cookie bypasses the shared cache. Public pages
 * never read any other cookie during SSR, and the analytics and ad-click
 * cookies that most visitors carry (_fbp, _fbc, _ga, gclid mirrors) must not
 * turn every later page view into an uncached render.
 */
export function requestBypassesPublicStorefrontCache(headers: Headers): boolean {
  return (
    Boolean(headers.get("Authorization")) ||
    Boolean(headers.get("X-API-Token")) ||
    requestHasPrivateSession(headers)
  );
}

/**
 * Builds the request handed to the cache-enabled entrypoint. The public
 * render never depends on tracking cookies, so they are dropped here; that
 * keeps the cached lane byte-identical for every anonymous visitor and stops
 * cookie-carrying requests from polluting or bypassing the shared entry.
 */
export function toPublicCacheRequest(request: Request, canonicalUrl: string): Request {
  const headers = new Headers(request.headers);
  headers.delete("Cookie");
  return new Request(canonicalUrl, {
    method: request.method,
    headers,
    redirect: request.redirect,
  });
}

const CACHEABLE_PUBLIC_CONTENT_TYPES = [
  "text/html",
  "application/xml",
  "text/xml",
  "application/xslt+xml",
  "text/plain",
];

export function isCacheablePublicResponse(response: Response): boolean {
  if (response.status !== 200) return false;
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (
    !CACHEABLE_PUBLIC_CONTENT_TYPES.some((type) =>
      contentType.includes(type),
    )
  ) {
    return false;
  }
  if (responseHasSetCookie(response.headers)) return false;

  const cacheControl = response.headers.get("Cache-Control")?.toLowerCase() ?? "";
  if (cacheControl.includes("private") || cacheControl.includes("no-store")) {
    return false;
  }

  return true;
}
