// The kind of page a storefront path renders, as an app component sees it
// (`StorefrontRenderContext.page.kind`). Apps branch on these values, so each
// path gets its own kind: a CMS page is "page", the cart is "cart", and every
// other path that is not a catalog, content or landing page (checkout, the
// receipt, account, blog, feeds, ...) is "other". Components never render on
// a buyer's page (`appComponentsRenderOn`), so "other" is not a promise that
// one draws there.

import type { StorefrontRenderContext } from "@scalius/shared/plugins/storefront-protocol";

export type StorefrontPageKind = StorefrontRenderContext["page"]["kind"];

/**
 * The first path segments that have their own route under `src/pages`. A CMS
 * page lives at `/<slug>` (`pages/[slug].astro`), and a static route wins over
 * it, so any other single segment is a CMS page. Routes with a dot in the name
 * (`robots.txt`, `sitemap.xml`) are not slugs and need no entry.
 * `page-kind.test.ts` checks this list against the `src/pages` directory.
 */
export const STOREFRONT_STATIC_SEGMENTS: ReadonlySet<string> = new Set([
  "404", "500", "account", "agent", "api", "apps", "blog", "brands", "buy", "cart", "categories", "checkout", "collections",
  "compare", "gift-card-balance", "health", "localization", "navigation", "newsletter", "order-success",
  "pages", "payment-recovery", "products", "search", "theme-preview", "track-order", "ucp", "warranty-claims",
]);

/** A CMS page slug (`pages/[slug].astro` rejects anything else). */
const CMS_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function pageKind(pathname: string): StorefrontPageKind {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "home";
  if (path.startsWith("/pages/")) return "landing";
  if (path.startsWith("/products/")) return "product";
  if (/^\/(?:categories|collections|brands)(?:\/|$)/.test(path)) return "listing";
  if (path === "/search" || path.startsWith("/search/")) return "search";
  if (path === "/cart") return "cart";
  const segment = path.slice(1);
  if (CMS_SLUG.test(segment) && !STOREFRONT_STATIC_SEGMENTS.has(segment)) return "page";
  return "other";
}
