const HTML_BROWSER_CACHE_CONTROL = "no-cache, no-store, must-revalidate";
const SITEMAP_BROWSER_CACHE_CONTROL =
  "public, max-age=3600, stale-while-revalidate=86400";
const FEED_BROWSER_CACHE_CONTROL =
  "public, max-age=3600, stale-while-revalidate=43200";
const XSL_BROWSER_CACHE_CONTROL =
  "public, max-age=86400, stale-while-revalidate=604800";

export function getPublicDiscoveryCacheControl(
  pathname: string,
): string | null {
  if (
    pathname === "/api/product-feed.xml" ||
    pathname === "/api/facebook-feed.xml"
  ) {
    return FEED_BROWSER_CACHE_CONTROL;
  }

  if (pathname === "/sitemap.xsl") {
    return XSL_BROWSER_CACHE_CONTROL;
  }

  if (
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    /^\/sitemap-.*\.xml$/.test(pathname)
  ) {
    return SITEMAP_BROWSER_CACHE_CONTROL;
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
    response.headers.delete("Pragma");
    response.headers.delete("Expires");
    return;
  }

  response.headers.set("Cache-Control", HTML_BROWSER_CACHE_CONTROL);
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
}
