// Security headers for the cookie-bound download streams
// (`/api/downloads/account|order/…`, Wave B §3.4). A purchased file is served
// as an attachment under `Content-Security-Policy: sandbox`; the page CSP must
// not replace that policy, and the stream never sends a referrer or frames.
import { applyBaselineSecurityHeaders } from "@scalius/shared/http-security";
import { takeOwnCsp } from "./own-csp";

/** The download stream proxies; never HTML. */
export function isDigitalDownloadPathname(pathname: string): boolean {
  return /^\/api\/downloads\/(?:account|order)\//.test(pathname);
}

/** Baseline headers for every response, stricter for the download streams. */
export function applyTransportSecurityHeaders(
  request: Request,
  response: Response,
  options: {
    privateRelay: boolean;
    /**
     * The response states who may frame it in its CSP frame-ancestors (a
     * theme editor preview or its relay, framed by the dashboard), so no
     * X-Frame-Options overrides that for older browsers.
     */
    framedByPolicy?: boolean;
    /** A buyer's own page: nothing frames it. */
    buyerPage?: boolean;
  },
): Response {
  const privateDownload = isDigitalDownloadPathname(new URL(request.url).pathname);
  // A page that carries a token in its URL (the newsletter's confirm and
  // unsubscribe links) asks for no referrer; the baseline never weakens it.
  const pageWantsNoReferrer = response.headers.get("Referrer-Policy")?.trim().toLowerCase() === "no-referrer";
  const secured = applyBaselineSecurityHeaders(request, response, {
    frameProtection: options.framedByPolicy && !privateDownload
      ? "preserve"
      : options.privateRelay || privateDownload || options.buyerPage ? "deny" : "same-origin",
  });
  if (options.privateRelay || privateDownload || pageWantsNoReferrer) secured.headers.set("Referrer-Policy", "no-referrer");
  return secured;
}

/**
 * The page CSP for every response but those that own theirs: the download
 * streams and the private relay (by path), and any response its code marked
 * (`setOwnCsp`: the continuation pages' strict card-entry policy, an inbox or
 * warranty attachment's sandbox, an app proxy answer). An app's SVG file never
 * reaches here: the worker serves it, with its own sandbox policy, before
 * Astro. Any other policy, from an upstream or a framework, is replaced.
 */
export function withPageCsp(
  pathname: string,
  response: Response,
  options: { privateRelay: boolean; setPageCsp: (response: Response) => Response },
): Response {
  const owned = takeOwnCsp(response);
  return owned || options.privateRelay || isDigitalDownloadPathname(pathname) ? response : options.setPageCsp(response);
}
