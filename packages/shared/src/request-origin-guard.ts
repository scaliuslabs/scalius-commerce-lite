const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function normalizeRequestOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function hasCookieCredentials(request: Request): boolean {
  return Boolean(request.headers.get("Cookie")?.trim());
}

export function shouldRejectCrossOriginCookieRequest(request: Request): boolean {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return false;
  if (!hasCookieCredentials(request)) return false;
  return isCrossOriginSubmission(request);
}

/**
 * Whether a request's `Origin` names another site. No Origin (an old browser,
 * a server) is not cross-origin. `Origin: null` is what a browser sends for a
 * form posted from a page with `Referrer-Policy: no-referrer` (the
 * newsletter confirm and unsubscribe pages keep their token out of referrers):
 * it is same-origin only when the browser also says so in `Sec-Fetch-Site`,
 * a header no page can set; a sandboxed frame or a cross-site post stays refused.
 */
export function isCrossOriginSubmission(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  if (origin.trim() === "null") return request.headers.get("Sec-Fetch-Site")?.trim().toLowerCase() !== "same-origin";
  const requestOrigin = normalizeRequestOrigin(request.url);
  const submittedOrigin = normalizeRequestOrigin(origin);
  if (!requestOrigin || !submittedOrigin) return true;
  return requestOrigin !== submittedOrigin;
}
