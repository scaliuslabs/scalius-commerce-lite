/**
 * The store pages a merchant can link from a menu without a resource (the
 * menu editor's "System" links), and the storefront path each resolves to.
 * Resolved when a menu is read, so changing a path here moves every menu.
 * Each path is a page the storefront serves to every buyer, signed in or
 * not (apps/storefront/src/lib/navigation-system-targets.test.ts walks them
 * against its routes). "Track order" is the order lookup (`/track-order`):
 * a signed-out buyer finds an order there, and nothing private enters the
 * URL; a signed-in buyer's orders are linked from the account.
 */
export const NAVIGATION_SYSTEM_TARGETS = {
  home: "/",
  catalog: "/search",
  search: "/search",
  account: "/account",
  cart: "/cart",
  checkout: "/checkout",
  order_lookup: "/track-order",
} as const;

export type NavigationSystemTarget = keyof typeof NAVIGATION_SYSTEM_TARGETS;

/** The system link keys, in the menu editor's order. */
export const NAVIGATION_SYSTEM_KEYS = Object.keys(NAVIGATION_SYSTEM_TARGETS) as [NavigationSystemTarget, ...NavigationSystemTarget[]];
