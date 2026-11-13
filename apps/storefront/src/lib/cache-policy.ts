import { readThemePreviewCookie } from "@/lib/theme-preview-cookie";

/**
 * The buyer's own pages: each shows or takes something that belongs to one
 * buyer (a session, receipt proof, order, claim, address, gift-card code, OTP
 * or payment state) or is a step of a buyer's session. This one list decides
 * what is never stored for another buyer (`isUncachedPrivateStorefrontPathname`),
 * never prefetched, and never touched by app code (`storefrontAppPage`). The
 * one exception is `theme-preview`: private for caching and prefetch, but the
 * merchant's own editor canvas, where app code does run. `/compare` is public.
 * A new page of that kind is added here; `private-pages.test.ts` fails until
 * every page under `src/pages` is on this list or declared public.
 */
export const PRIVATE_STOREFRONT_ROOTS = [
  "account",
  "agent",
  "buy",
  "cart",
  "checkout",
  "gift-card-balance",
  "newsletter",
  "order-success",
  "payment-recovery",
  "theme-preview",
  "track-order",
  "warranty-claims",
] as const;

const PRIVATE_STOREFRONT_PATHNAME_RE = new RegExp(`^/(?:${PRIVATE_STOREFRONT_ROOTS.join("|")})(?:/|$)`);

/**
 * Whether a pathname is a buyer's own page. The router decodes percent-escapes
 * before it matches a route, so `/%67ift-card-balance` is the gift-card page:
 * the decoded path is checked as well as the raw one, and a path whose escapes
 * cannot be decoded is treated as private, never as public.
 */
export function isPrivateStorefrontPathname(pathname: string): boolean {
  if (PRIVATE_STOREFRONT_PATHNAME_RE.test(pathname)) return true;
  if (!pathname.includes("%")) return false;
  try {
    return PRIVATE_STOREFRONT_PATHNAME_RE.test(decodeURIComponent(pathname));
  } catch {
    return true;
  }
}

/**
 * Private pages whose HTML is a buyer-agnostic shell: the cart and the
 * checkout's payment step. The cart lines live in the browser (`cart:v3`) and
 * paint from storage; the checkout reads its session from the browser and its
 * quote and payment options from no-store APIs. Everything buyer-specific
 * (sign-in state, saved details, discounts, validation, the order itself)
 * comes from no-store APIs or a POST, and the server render reads no cookie
 * and no query. So the edge caches each shell like any public page, validated
 * by the dependencies of its reads, while the browser still gets `no-store`
 * and speculative prefetch stays off. Receipts, payment recovery, quick buy
 * and accounts are never shells.
 */
const BUYER_SHELL_PATHNAME_RE = /^\/(?:cart|checkout)\/?$/;

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

/**
 * Whether the request carries a theme preview cookie: the one credential a
 * public page renders differently for (the merchant's draft). Only its shape
 * is checked here, so a page rendered with one is always private; the gateway
 * renders it only when the storefront's own signature verifies
 * (`verifyThemePreviewCookie`) and otherwise serves the shared page.
 *
 * Nothing else bypasses the shared cache. A buyer's session (`cs_tok`, its
 * `cs_auth` hint) and an `Authorization` or `X-API-Token` header change no
 * public render: the header's account state paints in the browser, and the
 * public render receives none of them (`toPublicCacheRequest`). So a signed-in
 * buyer reads the same stored page as everyone, and a made-up credential
 * cannot force a render.
 */
export function requestBypassesPublicStorefrontCache(headers: Headers): boolean {
  return readThemePreviewCookie(headers.get("Cookie")) !== "";
}

/** Request headers that carry a credential; none reaches a public render. */
const CREDENTIAL_HEADERS = ["Cookie", "Authorization", "Proxy-Authorization", "X-API-Token"] as const;

/**
 * Builds the request rendered into the public cache: the canonical URL with
 * no cookie and no credential header. The public render cannot depend on a
 * session, a token or a tracking cookie, so the stored page is the same for
 * every visitor and no visitor's credential can shape or bypass it.
 */
export function toPublicCacheRequest(request: Request, canonicalUrl: string): Request {
  const headers = new Headers(request.headers);
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  return new Request(canonicalUrl, {
    method: request.method,
    headers,
    redirect: request.redirect,
  });
}
