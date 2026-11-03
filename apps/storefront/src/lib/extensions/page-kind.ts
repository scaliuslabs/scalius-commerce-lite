import { trimTrailingCharacter } from "@scalius/shared/text-scan";
// The kind of page a storefront path renders, as an app component sees it
// (`StorefrontRenderContext.page.kind`). Apps branch on these values, so each
// path gets its own kind: a CMS page is "page", the cart is "cart", and every
// other path that is not a catalog, content or landing page (checkout, the
// receipt, account, blog, feeds, ...) is "other". Components never render on
// a buyer's page (`appComponentsRenderOn`), so "other" is not a promise that
// one draws there.

import { STOREFRONT_ROUTE_SEGMENTS } from "@scalius/shared/storefront-route-segments";
import type { StorefrontRenderContext } from "@scalius/shared/plugins/storefront-protocol";

export type StorefrontPageKind = StorefrontRenderContext["page"]["kind"];

/** A CMS page slug (`pages/[slug].astro` rejects anything else). */
const CMS_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function pageKind(pathname: string): StorefrontPageKind {
  const path = trimTrailingCharacter(pathname, "/") || "/";
  if (path === "/") return "home";
  if (path.startsWith("/pages/")) return "landing";
  if (path.startsWith("/products/")) return "product";
  if (/^\/(?:categories|collections|brands)(?:\/|$)/.test(path)) return "listing";
  if (path === "/search" || path.startsWith("/search/")) return "search";
  if (path === "/cart") return "cart";
  const segment = path.slice(1);
  if (CMS_SLUG.test(segment) && !STOREFRONT_ROUTE_SEGMENTS.has(segment)) return "page";
  return "other";
}
