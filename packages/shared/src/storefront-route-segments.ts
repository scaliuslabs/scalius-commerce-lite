/**
 * Every top-level path segment that has a storefront route of its own
 * (`apps/storefront/src/pages`). A CMS page lives at `/<slug>`, and a static
 * route wins over it, so none of these can be a page slug: the page would be
 * shadowed, or rendered as the route's own page. Routes with a dot in the name
 * (`robots.txt`, `sitemap.xml`) are not slugs and need no entry.
 * `page-kind.test.ts` checks this list against the `src/pages` directory.
 */
export const STOREFRONT_ROUTE_SEGMENTS: ReadonlySet<string> = new Set([
  "404", "500", "account", "agent", "api", "apps", "blog", "brands", "buy", "cart", "categories", "checkout", "collections",
  "compare", "gift-card-balance", "health", "localization", "navigation", "newsletter", "order-success",
  "pages", "payment-recovery", "products", "search", "theme-preview", "track-order", "ucp", "warranty-claims",
]);
