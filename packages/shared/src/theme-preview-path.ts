// Which storefront pages the theme editor may open in its preview: every public
// page kind, never a buyer's own page, an endpoint or the editor's own canvas.
// The storefront (`normalizeThemePreviewRoutePath`) and the dashboard
// (`isSafeThemePreviewPath`) both ask this one question.
import { presenceOfPath, stripPresencePath } from "./markets";
import { STOREFRONT_ROUTE_SEGMENTS } from "./storefront-route-segments";

/** Routes with a page at `/<prefix>/<handle>`. */
const PREVIEW_RESOURCE_PREFIXES = new Set(["products", "categories", "collections", "brands", "blog", "pages"]);

/** Top-level routes that are public pages themselves (the cart is a page template the editor previews). */
const PREVIEW_INDEX_PAGES = new Set(["search", "cart", "blog", "categories", "collections", "compare"]);

const HANDLE = /^[A-Za-z0-9_-]+$/;

/** Whether a URL path (no query) is a public storefront page the preview can show. */
export function isThemePreviewablePath(pathname: string): boolean {
  // A market presence's page (`/en-in/products/x`): the page under its subfolder.
  const presence = presenceOfPath(pathname);
  const page = presence ? stripPresencePath(pathname, presence) : pathname;
  if (presence && page === pathname) return false;

  const segments = page.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  if (segments.length === 2 && PREVIEW_RESOURCE_PREFIXES.has(segments[0]!)) return HANDLE.test(segments[1]!);
  if (segments.length !== 1 || !HANDLE.test(segments[0]!)) return false;

  const segment = segments[0]!.toLowerCase();
  // Any other single segment is a CMS page unless a route (private roots included) owns it.
  return PREVIEW_INDEX_PAGES.has(segment) || (!STOREFRONT_ROUTE_SEGMENTS.has(segment) && !segment.startsWith("sitemap"));
}
