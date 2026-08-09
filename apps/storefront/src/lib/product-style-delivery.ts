const PRODUCT_ROUTE_PATTERN = /^\/products\/[^/]+\/?$/;
const BUILD_SCOPED_GLOBAL_STYLESHEET_PATTERN =
  /^\/_astro\/src-[a-f0-9]+\/global\.[A-Za-z0-9_-]+\.css$/;

interface RewriterElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): RewriterElement;
  after(content: string, options: { html: boolean }): RewriterElement;
}

interface Rewriter {
  on(
    selector: string,
    handlers: { element(element: RewriterElement): void },
  ): Rewriter;
  transform(response: Response): Response;
}

type RewriterConstructor = new () => Rewriter;

export const PRODUCT_STYLESHEET_DEFERRAL = {
  rel: "preload",
  as: "style",
  fetchpriority: "high",
  marker: "data-product-shared-styles",
  mobileMedia: "(max-width: 39.999rem)",
  desktopMedia: "(min-width: 40rem)",
  onload: "this.onload=null;this.rel='stylesheet'",
} as const;

export const PRODUCT_CRITICAL_CSS_MEDIA =
  PRODUCT_STYLESHEET_DEFERRAL.mobileMedia;

export function isBuildScopedGlobalStylesheet(href: string | null): href is string {
  return href !== null && BUILD_SCOPED_GLOBAL_STYLESHEET_PATTERN.test(href);
}

class DeferredGlobalStylesheetHandler {
  element(element: RewriterElement): void {
    const href = element.getAttribute("href");
    if (!isBuildScopedGlobalStylesheet(href)) return;

    element.setAttribute("rel", PRODUCT_STYLESHEET_DEFERRAL.rel);
    element.setAttribute("as", PRODUCT_STYLESHEET_DEFERRAL.as);
    element.setAttribute("media", PRODUCT_STYLESHEET_DEFERRAL.mobileMedia);
    element.setAttribute(
      "fetchpriority",
      PRODUCT_STYLESHEET_DEFERRAL.fetchpriority,
    );
    element.setAttribute(PRODUCT_STYLESHEET_DEFERRAL.marker, "mobile");
    element.setAttribute("onload", PRODUCT_STYLESHEET_DEFERRAL.onload);
    element.after(
      `<link rel="stylesheet" href="${href}" media="${PRODUCT_STYLESHEET_DEFERRAL.desktopMedia}" ${PRODUCT_STYLESHEET_DEFERRAL.marker}="desktop"><noscript><link rel="stylesheet" href="${href}"></noscript>`,
      { html: true },
    );
  }
}

/**
 * Product pages inline a deterministic phone shell stylesheet. Below the `sm`
 * breakpoint, the complete shared sheet can therefore preload without holding
 * first paint, then become a stylesheet as soon as it finishes. At `sm` and
 * above the complete sheet remains render-blocking because more of the catalog
 * is visible at first paint. Keeping the phone preload at
 * normal stylesheet priority avoids a late restyle when a buyer scrolls
 * quickly. The immutable build path makes the request cache-safe, and the
 * noscript copy preserves the full page when JavaScript is disabled.
 */
export function deferProductGlobalStylesheet(
  response: Response,
  pathname: string,
): Response {
  if (
    !response.ok ||
    !PRODUCT_ROUTE_PATTERN.test(pathname) ||
    !response.headers.get("Content-Type")?.toLowerCase().includes("text/html")
  ) {
    return response;
  }

  const Rewriter = (
    globalThis as typeof globalThis & { HTMLRewriter: RewriterConstructor }
  ).HTMLRewriter;
  return new Rewriter()
    .on('link[rel="stylesheet"]', new DeferredGlobalStylesheetHandler())
    .transform(response);
}
