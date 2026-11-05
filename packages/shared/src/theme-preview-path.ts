// Which storefront pages the theme editor may open in its preview: every public
// page kind, never a buyer's own page, an endpoint or the editor's own canvas.
// The storefront (`themePreviewTarget`) and the dashboard
// (`isSafeThemePreviewPath`) both ask this one question.
//
// The public page kinds (`apps/storefront/src/pages`): home, a CMS page
// (`/<slug>`), a landing page (`/pages/<slug>`), a product and its reviews
// (`/products/<slug>[/reviews]`), a category, collection or brand
// (`/<kind>/<handle>`), the category and collection indexes, the blog and its
// posts, search, compare, the cart shell and an installed app's pages
// (`/apps/<plugin id>/...`); each also under a market presence (`/en-in/...`).
// There is no brand index. `theme-preview-route.test.ts` checks this against
// the pages directory.
//
// A buyer's own page never draws a draft. The editor previews the checkout,
// the receipt and the account on its sample pages instead
// (`/theme-preview/sample/<page>`, fixed sample orders, never a buyer's): the
// one kind of path under the editor's canvas that opens, at the root only.
import { presenceOfPath, stripPresencePath } from "./markets";
import { PLUGIN_ID_PATTERN } from "./plugins/ids";
import { STOREFRONT_ROUTE_SEGMENTS } from "./storefront-route-segments";

/** Routes with a page at `/<prefix>/<handle>`. */
const PREVIEW_RESOURCE_PREFIXES = new Set(["products", "categories", "collections", "brands", "blog", "pages"]);

/** Top-level routes that are public pages themselves (the cart is a page template the editor previews). */
const PREVIEW_INDEX_PAGES = new Set(["search", "cart", "blog", "categories", "collections", "compare"]);

const HANDLE = /^[A-Za-z0-9_-]+$/;

/** The private pages the theme editor previews with sample data. */
export const THEME_PREVIEW_SAMPLE_PAGES = ["checkout", "receipt", "account"] as const;
export type ThemePreviewSamplePage = (typeof THEME_PREVIEW_SAMPLE_PAGES)[number];

/** A sample page's address. */
export function themePreviewSamplePath(page: ThemePreviewSamplePage): string {
  return `/theme-preview/sample/${page}`;
}

export function isThemePreviewSamplePage(value: unknown): value is ThemePreviewSamplePage {
  return typeof value === "string" && (THEME_PREVIEW_SAMPLE_PAGES as readonly string[]).includes(value);
}

/** Whether a path is one of the editor's sample pages (exactly, at the root). */
export function isThemePreviewSamplePath(pathname: string): boolean {
  const match = /^\/theme-preview\/sample\/([a-z]+)$/.exec(pathname);
  return match !== null && isThemePreviewSamplePage(match[1]);
}

/** Whether a URL path (no query) is a public storefront page the preview can show. */
export function isThemePreviewablePath(pathname: string): boolean {
  if (isThemePreviewSamplePath(pathname)) return true;
  // A market presence's page (`/en-in/products/x`): the page under its subfolder.
  const presence = presenceOfPath(pathname);
  const page = presence ? stripPresencePath(pathname, presence) : pathname;
  if (presence && page === pathname) return false;

  const segments = page.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  const [first, second, ...rest] = segments as [string, ...string[]];
  // An installed app's page: its plugin id, then the app's own path.
  if (first === "apps") return second !== undefined && PLUGIN_ID_PATTERN.test(second) && rest.every((segment) => HANDLE.test(segment));
  if (!segments.every((segment) => HANDLE.test(segment))) return false;
  if (segments.length === 3) return first === "products" && rest[0] === "reviews";
  if (segments.length === 2) return PREVIEW_RESOURCE_PREFIXES.has(first);
  if (segments.length !== 1) return false;

  const segment = first.toLowerCase();
  // Any other single segment is a CMS page unless a route (private roots included) owns it.
  return PREVIEW_INDEX_PAGES.has(segment) || (!STOREFRONT_ROUTE_SEGMENTS.has(segment) && !segment.startsWith("sitemap"));
}
