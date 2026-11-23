// The storefront's core routes, as root paths: the one list app pages
// (`request.routes` on proxied public routes) and theme header skins
// (`StorefrontHeaderData.routes`) link to, so no app hard-codes `/account`.
//
// They are logical root paths. On a market presence page the gateway
// localizes every same-store link, form action and redirect (`/account` →
// `/en-in/account`), and browser code goes through `pagePath()`, so the same
// paths are right under every presence.

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
  /** The buyer's messages with the store (support): signed-in, a guest signs in first. */
  inbox: "/account/inbox",
  /** The buyer's warranties, where a claim starts (signed-in; a guest signs in first). */
  warrantyClaims: "/account/warranties",
});

export type StorefrontCoreRoutes = typeof STOREFRONT_CORE_ROUTES;

/**
 * Search within a category: `/search?q=…&category=<category handle>` answers
 * from that category's listing (`/categories/<handle>?q=…`), so a header's
 * department select works without JavaScript.
 */
export const STOREFRONT_SEARCH_SCOPE_PARAM = "category" as const;

/**
 * The store's own pages a theme's header and footer link to
 * (`StorefrontRoutes`), in this order. One list for both, so a footer never
 * hard-codes a path the header carries.
 */
export const STOREFRONT_THEME_ROUTE_KEYS = ["home", "search", "cart", "account", "orders", "trackOrder", "inbox", "warrantyClaims"] as const;
export type StorefrontThemeRouteKey = (typeof STOREFRONT_THEME_ROUTE_KEYS)[number];

/** The routes a header or footer skin gets (`StorefrontHeaderData.routes`, `StorefrontFooterData.routes`). */
export function storefrontThemeRoutes(): Record<StorefrontThemeRouteKey, string> {
  return Object.fromEntries(STOREFRONT_THEME_ROUTE_KEYS.map((key) => [key, STOREFRONT_CORE_ROUTES[key]])) as Record<StorefrontThemeRouteKey, string>;
}
