const HTML_BROWSER_CACHE_CONTROL = "no-cache, no-store, must-revalidate";
// Discovery responses are stored in the Worker Cache API under versioned and
// exact-generation keys. Browser copies must revalidate so a crawler or
// merchant does not retain an invalidated XML/text response for hours.
const DISCOVERY_BROWSER_CACHE_CONTROL =
  "public, max-age=0, no-cache, must-revalidate";
const PUBLIC_DISCOVERY_CONTENT_TYPES = [
  "application/xml",
  "text/xml",
  "application/xslt+xml",
  "text/plain",
] as const;

export function getPublicDiscoveryCacheControl(
  pathname: string,
): string | null {
  if (
    pathname === "/api/product-feed.xml" ||
    pathname === "/api/facebook-feed.xml"
  ) {
    return DISCOVERY_BROWSER_CACHE_CONTROL;
  }

  if (pathname === "/sitemap.xsl") {
    return DISCOVERY_BROWSER_CACHE_CONTROL;
  }

  if (
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    /^\/sitemap-.*\.xml$/.test(pathname)
  ) {
    return DISCOVERY_BROWSER_CACHE_CONTROL;
  }

  return null;
}

export function applyBrowserCachePolicyForPublicResponse(
  response: Response,
  pathname: string,
): void {
  const discoveryCacheControl = getPublicDiscoveryCacheControl(pathname);
  if (discoveryCacheControl) {
    response.headers.set("Cache-Control", discoveryCacheControl);
    response.headers.delete("Set-Cookie");
    response.headers.delete("set-cookie");
    response.headers.delete("Pragma");
    response.headers.delete("Expires");
    return;
  }

  response.headers.set("Cache-Control", HTML_BROWSER_CACHE_CONTROL);
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
}

export function isSuccessfulPublicDiscoveryResponse(
  response: Response,
  pathname: string,
): boolean {
  if (!getPublicDiscoveryCacheControl(pathname)) return false;
  if (response.status !== 200) return false;

  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  return PUBLIC_DISCOVERY_CONTENT_TYPES.some((type) => contentType.includes(type));
}
