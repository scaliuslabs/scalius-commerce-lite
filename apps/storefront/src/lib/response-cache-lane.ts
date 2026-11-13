/**
 * Which cache lane a rendered storefront response takes, decided once in the
 * middleware (and nowhere else): the lane the gateway's page cache reads from
 * `X-Cache-Status`. Only a `MISS` is stored (`servePublicStorefrontRequest`);
 * every other lane is this buyer's alone (`private, no-store`).
 *
 * - `BYPASS_AUTH`: the request carries a theme preview cookie (the draft).
 * - `NO_CACHE`: a private page (an account, a receipt).
 * - `BYPASS_DEGRADED`: a public page drawn from a failed read or an
 *   unreadable theme.
 * - `MISS`: an anonymous public page, a 200 or a 404 page for a handle no one
 *   has (`isPublicNotFoundPage`), and a public discovery file.
 * - `BYPASS`: anything else that set no `Cache-Control` of its own (a 503, a
 *   redirect, an API route); null leaves a response's own policy alone.
 */
import {
  PRIVATE_NO_STORE_CACHE_CONTROL,
  isUncachedPrivateStorefrontPathname,
  renderOptedOutOfSharedCache,
  requestBypassesPublicStorefrontCache,
} from "@/lib/cache-policy";
import {
  applyBrowserCachePolicyForPublicResponse,
  isSuccessfulPublicDiscoveryResponse,
} from "@/lib/public-discovery-cache";
import { getPublicStorefrontCachePolicy, isPublicNotFoundPage } from "@/lib/public-worker-cache";

export type StorefrontCacheLane = "BYPASS_AUTH" | "NO_CACHE" | "BYPASS_DEGRADED" | "MISS" | "BYPASS";

export async function storefrontCacheLane(
  request: Request,
  response: Response,
  /** Whether the page drew the default theme in place of an unreadable one (asked only for a public page). */
  rendersDegradedTheme: () => Promise<boolean>,
): Promise<StorefrontCacheLane | null> {
  const url = new URL(request.url);
  const isGet = request.method === "GET" || request.method === "HEAD";
  if (isGet && requestBypassesPublicStorefrontCache(request.headers)) return "BYPASS_AUTH";
  // The cart and checkout are private but cacheable shells; the rest are not.
  if (isGet && isUncachedPrivateStorefrontPathname(url.pathname)) return "NO_CACHE";
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  const publicResponse =
    (response.status === 200 || isPublicNotFoundPage(response)) &&
    !response.headers.has("Set-Cookie") &&
    (contentType.includes("text/html") ||
      isSuccessfulPublicDiscoveryResponse(response, url.pathname) ||
      (url.pathname === "/.well-known/ucp" && contentType.includes("application/json")));
  if (getPublicStorefrontCachePolicy(request) && publicResponse) {
    // The page rendered from a failed read (markRenderUncacheable) or drew the
    // default theme in place of an unreadable one: this buyer's only.
    return renderOptedOutOfSharedCache(response.headers) || await rendersDegradedTheme() ? "BYPASS_DEGRADED" : "MISS";
  }
  return response.headers.has("Cache-Control") ? null : "BYPASS";
}

export function setPrivateResponse(response: Response, status: string): void {
  response.headers.set("Cache-Control", PRIVATE_NO_STORE_CACHE_CONTROL);
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  response.headers.set("X-Cache-Status", status);
}

/** Sets the lane's headers: `MISS` with the browser's policy for a public page, every other lane private. */
export function applyStorefrontCacheLane(response: Response, lane: StorefrontCacheLane | null, pathname: string): void {
  if (lane === null) return;
  if (lane !== "MISS") return setPrivateResponse(response, lane);
  applyBrowserCachePolicyForPublicResponse(response, pathname);
  response.headers.set("X-Cache-Status", "MISS");
}
