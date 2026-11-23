import { STOREFRONT_ROUTE_SEGMENTS } from "./storefront-route-segments";
// The storefront's core routes, as root paths: the one list app pages
// (`request.routes` on proxied public routes) and theme header skins
// (`StorefrontHeaderData.routes`) link to, so no app hard-codes `/account`.
//
// They are logical root paths. On a market presence page the gateway
// localizes every same-store link, form action and redirect (`/account` →
// `/en-in/account`), and browser code goes through `pagePath()`, so the same
// paths are right under every presence.

/**
 * Where a theme's own link on a buyer's private page may lead: browsing only
 * (home, catalogue, product, category, collection, brand, content page at a
 * root slug or under /pages, blog, search). Never an account action, `/buy`, the cart or checkout, or
 * anything that acts on a GET.
 */
export function storefrontBrowsingPath(path: string): boolean {
  if (!/^(?!.*\/\/)\/[^\s"<>\\#?]*(?:[?#][^\s"<>\\]*)?$/.test(path)) return false;
  const segments = path.split(/[?#]/)[0]!.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || /^%2e/i.test(segment))) return false;
  if (segments.length === 0) return true;
  // The account and order lookup pages themselves (never an action under them).
  if (segments.length === 1 && ["account", "track-order"].includes(segments[0]!.toLowerCase()) && !/[?#]/.test(path)) return true;
  const first = segments[0]!.toLowerCase();
  // A merchant's content page sits at a root slug no store route reserves (`/about`).
  if (segments.length === 1 && !STOREFRONT_ROUTE_SEGMENTS.has(first)) return true;
  return ["products", "categories", "collections", "brands", "pages", "blog", "search"].includes(first);
}

/** The search page's query parameter (`/search?q=…`). */
export const STOREFRONT_SEARCH_QUERY = "q";

export const STOREFRONT_CORE_ROUTES = Object.freeze({
  home: "/",
  search: "/search",
  cart: "/cart",
  /** The buyer's account; a guest signs in here. */
  account: "/account",
  /** Where a guest signs in (today the account page itself). */
  signIn: "/account",
  /** The buyer's order history (the account page's Orders section). */
  orders: "/account",
  /** Guest order lookup. */
  trackOrder: "/track-order",
});

export type StorefrontCoreRoutes = typeof STOREFRONT_CORE_ROUTES;

/**
 * Search within a category: `/search?q=…&category=<category handle>` answers
 * from that category's listing (`/categories/<handle>?q=…`), so a header's
 * department select works without JavaScript.
 */
export const STOREFRONT_SEARCH_SCOPE_PARAM = "category" as const;
