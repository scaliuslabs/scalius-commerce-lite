// Security headers for the cookie-bound download streams
// (`/api/downloads/account|order/…`, Wave B §3.4). A purchased file is served
// as an attachment under `Content-Security-Policy: sandbox`; the page CSP must
// not replace that policy, and the stream never sends a referrer or frames.
import { applyBaselineSecurityHeaders } from "@scalius/shared/http-security";

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
  },
): Response {
  const privateDownload = isDigitalDownloadPathname(new URL(request.url).pathname);
  // A page that carries a token in its URL (the newsletter's confirm and
  // unsubscribe links) asks for no referrer; the baseline never weakens it.
  const pageWantsNoReferrer = response.headers.get("Referrer-Policy")?.trim().toLowerCase() === "no-referrer";
  const secured = applyBaselineSecurityHeaders(request, response, {
    frameProtection: options.framedByPolicy && !privateDownload
      ? "preserve"
      : options.privateRelay || privateDownload ? "deny" : "same-origin",
  });
  if (options.privateRelay || privateDownload || pageWantsNoReferrer) secured.headers.set("Referrer-Policy", "no-referrer");
  return secured;
}

/**
 * The page CSP for every response that states none of its own. A response
 * with its own policy keeps it whole: the download streams' and an inbox
 * attachment's sandbox, an app's SVG file, the continuation pages' strict
 * policy (the card entry: no inline script but the colour scheme's, by
 * hash). The private relay never takes the page policy.
 */
export function withPageCsp(
  pathname: string,
  response: Response,
  options: { privateRelay: boolean; setPageCsp: (response: Response) => Response },
): Response {
  return options.privateRelay || isDigitalDownloadPathname(pathname) || response.headers.has("Content-Security-Policy")
    ? response
    : options.setPageCsp(response);
}
