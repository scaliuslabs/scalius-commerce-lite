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
});

export type StorefrontCoreRoutes = typeof STOREFRONT_CORE_ROUTES;

/**
 * Search within a category: `/search?q=…&category=<category handle>` answers
 * from that category's listing (`/categories/<handle>?q=…`), so a header's
 * department select works without JavaScript.
 */
export const STOREFRONT_SEARCH_SCOPE_PARAM = "category" as const;
