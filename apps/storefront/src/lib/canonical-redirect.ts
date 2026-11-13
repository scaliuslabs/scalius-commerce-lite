/**
 * The one way a storefront page or the gateway answers "this URL has a
 * canonical form elsewhere" (a mis-cased handle, a listing query that is not
 * clean, a search scope, an old handle, a buyer's market). A redirect whose
 * target is the request itself (after the platform's own normalisation of
 * percent-escapes) is a loop the browser reports as ERR_TOO_MANY_REDIRECTS,
 * so such a target answers null and the page renders.
 *
 * Two URLs are the same place when their origin matches and their path and
 * query match once escapes of unreserved and non-ASCII characters are decoded
 * and the escapes that must stay (`%2F`, `%3F`, `%25` …) are compared without
 * regard to hex case: `%e0%a6%b2` and `%E0%A6%B2` are one address, and the
 * runtime may hand either to the next hop.
 */
export type CanonicalRedirectStatus = 301 | 302 | 307 | 308;

/** A path or query with its escapes decoded where that keeps its meaning. */
export function canonicalUrlPart(part: string): string {
  let decoded = part;
  try {
    decoded = decodeURI(part);
  } catch {
    // Not UTF-8: compared as written, hex case aside.
  }
  return decoded.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
}

/** Whether `location` (absolute or relative to `requestUrl`) names the request itself. */
export function isSameAddress(requestUrl: URL, location: string): boolean {
  let target: URL;
  try {
    target = new URL(location, requestUrl);
  } catch {
    return false;
  }
  return target.origin === requestUrl.origin
    && canonicalUrlPart(target.pathname) === canonicalUrlPart(requestUrl.pathname)
    && canonicalUrlPart(target.search) === canonicalUrlPart(requestUrl.search);
}

/** A redirect to `location`, or null when it would lead back to the request. */
export function canonicalRedirect(
  requestUrl: URL,
  location: string,
  status: CanonicalRedirectStatus = 302,
  headers?: Record<string, string>,
): Response | null {
  if (isSameAddress(requestUrl, location)) return null;
  return new Response(null, { status, headers: { ...headers, Location: location } });
}

/**
 * Whether every percent-escape in the path decodes to UTF-8. A path that does
 * not (`%FF`, an overlong `%C0%AF`, a lone `%`) names no page: the gateway
 * answers 400 before the renderer, whose router would throw on it.
 */
export function pathDecodes(pathname: string): boolean {
  try {
    decodeURIComponent(pathname);
    return true;
  } catch {
    return false;
  }
}

export function malformedPathResponse(request: Request): Response | null {
  if (pathDecodes(new URL(request.url).pathname)) return null;
  return new Response("Bad Request: the address is not valid UTF-8.", {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}
