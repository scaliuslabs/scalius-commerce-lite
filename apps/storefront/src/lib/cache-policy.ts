const PRIVATE_SESSION_COOKIE_NAMES = ["cs_tok", "cs_auth", "stp_theme_preview"];

export const PRIVATE_STOREFRONT_PATHNAME_RE =
  /^\/(?:account|buy|cart|checkout|order-success|payment-recovery|theme-preview|track-order)(?:\/|$)/;

export function isPrivateStorefrontPathname(pathname: string): boolean {
  return PRIVATE_STOREFRONT_PATHNAME_RE.test(pathname);
}

/**
 * Private pages whose HTML is a buyer-agnostic shell: the cart. Its lines live
 * in the browser (`cart:v3`) and paint from storage, and everything
 * buyer-specific (sign-in state, saved details, discounts, validation, the
 * order itself) comes from no-store APIs or a POST. So the edge caches the
 * shell like any public page, under the same build, Worker version and cache
 * generation key, while the browser still gets `no-store` and speculative
 * prefetch stays off. Checkout, payment, receipts and accounts are never
 * shells.
 */
const BUYER_SHELL_PATHNAME_RE = /^\/cart\/?$/;

export function isBuyerShellPathname(pathname: string): boolean {
  return BUYER_SHELL_PATHNAME_RE.test(pathname);
}

/** Private pages that are rendered for every request and never stored. */
export function isUncachedPrivateStorefrontPathname(pathname: string): boolean {
  return isPrivateStorefrontPathname(pathname) && !isBuyerShellPathname(pathname);
}

export const PRIVATE_NO_STORE_CACHE_CONTROL = "private, no-cache, no-store, must-revalidate";

/**
 * Keeps this render out of the shared page cache. A page calls it when its
 * HTML was built from a failed read (a fail-closed fallback), so a transient
 * API error is not served to every buyer until the next generation change.
 */
export function markRenderUncacheable(headers: Headers): void {
  headers.set("Cache-Control", PRIVATE_NO_STORE_CACHE_CONTROL);
}

/** Whether the page itself asked for its response never to be stored. */
export function renderOptedOutOfSharedCache(headers: Headers): boolean {
  return /(?:^|,)\s*no-store\s*(?:,|$)/i.test(headers.get("Cache-Control") ?? "");
}

function hasNamedCookie(cookieHeader: string, cookieNames: readonly string[]): boolean {
  const names = new Set(cookieNames);

  for (const chunk of cookieHeader.split(";")) {
    const [rawName] = chunk.trim().split("=", 1);
    if (rawName && names.has(rawName)) return true;
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
 * The public-cache admission boundary for request metadata.
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
 * Builds the request rendered into the public cache. The public
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
