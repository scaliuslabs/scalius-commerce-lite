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
  rel: "stylesheet",
  marker: "data-product-shared-styles",
  mobileMedia: "(max-width: 39.999rem)",
  desktopMedia: "(min-width: 40rem)",
  initialMedia: "print, (min-width: 40rem)",
  onload:
    "this.onload=null;if(matchMedia('(max-width: 39.999rem)').matches){const a=()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{this.media='(max-width: 39.999rem)'}));document.readyState==='complete'?a():window.addEventListener('load',a,{once:true})}",
} as const;

export const PRODUCT_CRITICAL_CSS_MEDIA =
  PRODUCT_STYLESHEET_DEFERRAL.mobileMedia;

export function isBuildScopedGlobalStylesheet(
  href: string | null,
): href is string {
  return href !== null && BUILD_SCOPED_GLOBAL_STYLESHEET_PATTERN.test(href);
}

class DeferredGlobalStylesheetHandler {
  element(element: RewriterElement): void {
    const href = element.getAttribute("href");
    if (!isBuildScopedGlobalStylesheet(href)) return;

    element.setAttribute("rel", PRODUCT_STYLESHEET_DEFERRAL.rel);
    element.setAttribute("media", PRODUCT_STYLESHEET_DEFERRAL.initialMedia);
    element.setAttribute(PRODUCT_STYLESHEET_DEFERRAL.marker, "mobile");
    element.setAttribute("onload", PRODUCT_STYLESHEET_DEFERRAL.onload);
    element.after(
      `<noscript><link rel="stylesheet" href="${href}"></noscript>`,
      { html: true },
    );
  }
}

/**
 * Product pages inline a deterministic phone shell stylesheet. Below the `sm`
 * breakpoint, the complete shared sheet uses a non-matching `print` media
 * branch so browsers fetch it at low priority without holding first paint. The
 * same link matches at `sm` and above, where the complete sheet stays normally
 * render-blocking because more of the catalog is visible at first paint. On a
 * phone it activates two frames after window load, guaranteeing the hero can
 * render before the browser applies the much larger shared sheet. One link
 * avoids a non-matching desktop duplicate promoting the request back to high
 * priority. The immutable build path is cache-safe, and the noscript copy
 * preserves the complete page when JavaScript is disabled.
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
